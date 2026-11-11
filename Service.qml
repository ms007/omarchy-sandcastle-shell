import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// One instance per shell (the bar creates a widget per monitor). Watches the
// project's .sandcastle/logs for the newest run, reads its status.json and
// sends the notifications. Everything is event driven: inotifywait for files,
// waitpid for the runner process, and only cheap in-process timers.
Item {
  id: root

  readonly property string pluginId: "ms007.omarchy-sandcastle-shell"

  // Injected by the shell.
  property var shell: null
  property string omarchyPath: Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy"

  readonly property string home: Quickshell.env("HOME")
  readonly property var settings: Model.layoutEntry(shell ? shell.barConfig : null, pluginId) || ({})
  readonly property string projectPath: Model.expandHome(settings.projectPath || "~/Projects/skool", home)
  readonly property int stallWarnMinutes: Math.max(1, Number(settings.stallWarnMinutes) || 5)
  readonly property string sandcastleDir: projectPath + "/.sandcastle"
  readonly property string logsDir: sandcastleDir + "/logs"

  // The newest run directory (absolute), "" when there is none.
  property string runDir: ""
  property var snapshot: null
  // Parsed JSON of a status.json in a format this widget doesn't know.
  property var foreignSnapshot: null
  property string formatError: ""
  property bool crashed: false
  property double lastOutputAt: 0
  property double now: Date.now()

  // The last snapshot notifications were worked out for. The first one after
  // the shell starts is only a baseline, so a restart repeats nothing.
  property var notifiedSnapshot: null
  property bool baselineTaken: false

  readonly property bool active: !crashed && (snapshot
    ? Model.claimsRunning(snapshot)
    : Model.claimsRunning(foreignSnapshot))
  readonly property int runnerPid: {
    var s = snapshot || foreignSnapshot
    return s && s.runner ? Number(s.runner.pid) || 0 : 0
  }
  readonly property string activeLogPath: snapshot && snapshot.active && snapshot.active.logPath
    ? String(snapshot.active.logPath) : ""
  readonly property string level: Model.iconLevel(snapshot, lastOutputAt, now, stallWarnMinutes)

  // "logs": recursive watch on logs/. "parent": logs/ is missing, so watch
  // .sandcastle/ (not recursively, it holds the worktrees) until it appears.
  property string watchMode: ""
  property int watchFailures: 0
  property bool watchStopping: false

  function log(msg) { console.log("sandcastle-shell: " + msg) }

  function rescan() {
    if (listProc.running) { listProc.again = true; return }
    listProc.command = ["ls", "-1", root.logsDir]
    listProc.running = true
  }

  function readStatus() {
    if (root.runDir === "") return
    if (catProc.running) { catProc.again = true; return }
    catProc.command = ["cat", root.runDir + "/status.json"]
    catProc.running = true
  }

  function switchRun(dir) {
    if (dir === root.runDir) return
    root.runDir = dir
    root.snapshot = null
    root.foreignSnapshot = null
    root.formatError = ""
    root.crashed = false
    root.lastOutputAt = 0
    waitProc.observedPid = 0
    readStatus()
  }

  function applyStatus(text) {
    var parsed = Model.parseSnapshot(text)
    if (!parsed.ok) {
      root.formatError = parsed.error
      root.foreignSnapshot = parsed.raw
      root.snapshot = null
      return
    }
    root.formatError = ""
    root.foreignSnapshot = null
    var next = parsed.snapshot
    if (!root.baselineTaken) {
      root.baselineTaken = true
    } else {
      var items = Model.notificationsFor(root.notifiedSnapshot, next)
      for (var i = 0; i < items.length; i++) notify(items[i])
    }
    root.notifiedSnapshot = next
    root.snapshot = next
  }

  // The end of a run (finished, limit, error, crash) also goes to Telegram;
  // the script does nothing without a .env.
  readonly property string telegramScript:
    decodeURIComponent(String(Qt.resolvedUrl("bin/notify-telegram")).replace(/^file:\/\//, ""))

  function notify(n) {
    Quickshell.execDetached(Model.notificationArgv(root.omarchyPath, n))
    if (n.runEnd) Quickshell.execDetached([root.telegramScript, n.title, n.body || "", n.url || ""])
  }

  function markOutput() {
    var t = Date.now()
    if (t - root.lastOutputAt >= 1000) root.lastOutputAt = t
  }

  function handleWatchLine(line) {
    var ev = Model.parseWatchLine(line)
    if (!ev) return
    var has = function(name) { return ev.events.indexOf(name) >= 0 }
    if (root.watchMode === "parent") {
      if (ev.path === root.logsDir && has("CREATE")) restartWatcher()
      return
    }
    var dir = Model.dirName(ev.path)
    var name = Model.baseName(ev.path)
    if (dir === root.logsDir && has("ISDIR") && (has("CREATE") || has("MOVED_TO"))) {
      rescan()
    } else if (dir === root.runDir && name === "status.json" && (has("MOVED_TO") || has("CLOSE_WRITE"))) {
      readStatus()
    } else if (has("MODIFY") && ev.path === root.activeLogPath) {
      markOutput()
    } else if (has("DELETE_SELF") || has("MOVE_SELF")) {
      restartWatcher()
    }
  }

  function startWatcher() {
    if (root.projectPath === "") return
    probeProc.command = ["test", "-d", root.logsDir]
    probeProc.running = true
  }

  function restartWatcher() {
    root.watchMode = ""
    if (watchProc.running) {
      root.watchStopping = true
      watchProc.running = false  // onExited restarts it
    }
    else watchRestart.restart()
  }

  onProjectPathChanged: {
    root.runDir = ""
    root.snapshot = null
    root.foreignSnapshot = null
    root.crashed = false
    restartWatcher()
    rescan()
  }

  // Reads the active log's mtime once, so a shell restart mid-run doesn't
  // show the agent as silent until it writes again.
  onActiveLogPathChanged: {
    if (activeLogPath === "") return
    statProc.command = ["stat", "-c", "%Y", activeLogPath]
    statProc.running = true
  }

  Component.onCompleted: {
    startWatcher()
    rescan()
  }

  Process {
    id: probeProc
    onExited: function(exitCode) {
      root.watchMode = exitCode === 0 ? "logs" : "parent"
      watchProc.command = root.watchMode === "logs"
        ? ["inotifywait", "-m", "-r", "-q", "-e", "create,moved_to,close_write,modify,delete_self,move_self",
           "--format", "%e|%w%f", root.logsDir]
        : ["inotifywait", "-m", "-q", "-e", "create,moved_to,delete_self,move_self",
           "--format", "%e|%w%f", root.sandcastleDir]
      watchProc.running = true
      if (root.watchMode === "logs") root.rescan()
    }
  }

  Process {
    id: watchProc
    stdout: SplitParser { onRead: function(line) { root.handleWatchLine(line) } }
    onStarted: watchFailureReset.restart()
    onExited: function(exitCode) {
      watchFailureReset.stop()
      if (root.watchStopping) root.watchStopping = false
      else root.watchFailures++
      watchRestart.restart()
    }
  }

  // A watcher that stays up for a while has recovered; back off only on a loop.
  Timer { id: watchFailureReset; interval: 30000; onTriggered: root.watchFailures = 0 }
  Timer {
    id: watchRestart
    interval: Math.min(60000, 1000 * Math.pow(2, Math.min(root.watchFailures, 6)))
    onTriggered: root.startWatcher()
  }

  Process {
    id: listProc
    property bool again: false
    stdout: StdioCollector { id: listOut; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        var newest = Model.newestRunDir(listOut.text.split("\n"))
        root.switchRun(newest === "" ? "" : root.logsDir + "/" + newest)
      } else {
        root.switchRun("")
      }
      if (again) { again = false; root.rescan() }
    }
  }

  Process {
    id: catProc
    property bool again: false
    stdout: StdioCollector { id: catOut; waitForEnd: true }
    onExited: function(exitCode) {
      // No status.json yet (an older runner, or the run just started): stay hidden.
      if (exitCode === 0) root.applyStatus(catOut.text)
      if (again) { again = false; root.readStatus() }
      else if (waitProc.pendingCrashCheck) waitProc.finishCrashCheck()
    }
  }

  Process {
    id: statProc
    stdout: StdioCollector { id: statOut; waitForEnd: true }
    onExited: function(exitCode) {
      var seconds = Number(String(statOut.text).trim())
      if (exitCode === 0 && seconds > 0) root.lastOutputAt = Math.max(root.lastOutputAt, seconds * 1000)
    }
  }

  // Returns when the runner process ends. Exit 0 means we watched it die;
  // non-zero means it was gone already when we started looking.
  Process {
    id: waitProc
    property int observedPid: 0
    property bool pendingCrashCheck: false
    property bool sawDeath: false
    // Set while we stop it on purpose to watch another pid.
    property bool replacing: false
    running: false
    onExited: function(exitCode) {
      if (replacing) {
        replacing = false
        start(observedPid)
        return
      }
      sawDeath = exitCode === 0
      pendingCrashCheck = true
      // The runner may have written its result right before it exited.
      if (catProc.running) catProc.again = true
      else root.readStatus()
    }
    function start(pid) {
      if (pid <= 0) return
      command = ["waitpid", String(pid)]
      running = true
    }
    function finishCrashCheck() {
      pendingCrashCheck = false
      var s = root.snapshot || root.foreignSnapshot
      if (!Model.claimsRunning(s)) return
      root.crashed = true
      if (sawDeath && root.snapshot) root.notify(Model.crashNotification(root.snapshot))
      root.log("runner " + observedPid + " is gone without a result")
    }
  }

  onRunnerPidChanged: watchRunner()
  onActiveChanged: watchRunner()
  function watchRunner() {
    if (!root.active || root.runnerPid <= 0 || waitProc.observedPid === root.runnerPid) return
    waitProc.observedPid = root.runnerPid
    if (waitProc.running) {
      waitProc.replacing = true
      waitProc.running = false
    } else {
      waitProc.start(root.runnerPid)
    }
  }

  // Stall check: just a clock tick, no process.
  Timer {
    interval: 30000
    repeat: true
    running: root.active
    onTriggered: root.now = Date.now()
  }

  // Safety net for missed events (suspend, watcher restart): read everything again.
  Timer {
    interval: 60000
    repeat: true
    running: root.active
    onTriggered: { root.rescan(); root.readStatus() }
  }
}
