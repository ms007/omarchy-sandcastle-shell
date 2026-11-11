// Pure logic for the Sandcastle widget. Loaded by QML via `import "Model.js"`
// and by node's test runner via require(), so it must stay free of QML and
// node APIs alike.

var SCHEMA_VERSION = 1

// Same pattern as RUN_DIR in skool's .sandcastle/show-status.ts. The
// timestamp is fixed width, so comparing names compares start times.
var RUN_DIR = /^spec-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/

// Phases in which an agent writes to its log. Only these can stall.
var AGENT_PHASES = { implementing: true, reviewing: true }

var PHASE_LABELS = {
  setup: "Sandbox wird vorbereitet",
  implementing: "Implementiert",
  checks: "Checks laufen",
  reviewing: "Review",
  landing: "Landet"
}

var STATE_LABELS = {
  pending: "Wartet",
  landed: "Erledigt",
  failed: "An dich zurückgegeben",
  skipped: "Übersprungen, Abhängigkeit gescheitert",
  notStarted: "Nicht gestartet, Limit erreicht",
  alreadyDone: "War schon erledigt"
}

// Nerd Font glyphs (JetBrainsMono Nerd Font).
var GLYPHS = {
  plant: "",
  pending: "",         // circle outline
  setup: "",           // cube
  implementing: "",    // code
  checks: "",          // tasks
  reviewing: "",       // eye
  landing: "",         // code-fork
  landed: "",          // check-circle
  failed: "",          // user-plus
  skipped: "",         // ban
  notStarted: "",      // pause-circle
  alreadyDone: ""      // check
}

function expandHome(path, home) {
  var p = String(path || "").trim()
  if (p === "~") return home
  if (p.indexOf("~/") === 0) return home + p.slice(1)
  return p.replace(/\/+$/, "")
}

// The newest run directory among `ls` output lines, or "" when there is none.
function newestRunDir(names) {
  var best = ""
  var bestStamp = ""
  for (var i = 0; i < names.length; i++) {
    var name = String(names[i]).trim()
    var match = RUN_DIR.exec(name)
    if (!match) continue
    if (match[2] > bestStamp) {
      best = name
      bestStamp = match[2]
    }
  }
  return best
}

// { ok: true, snapshot } or { ok: false, error, raw }. `raw` is the parsed
// JSON when the text was JSON at all, so the caller can still tell whether a
// run of an unknown format is going on.
function parseSnapshot(text) {
  var raw
  try {
    raw = JSON.parse(String(text))
  } catch (e) {
    return { ok: false, error: "status.json ist kein gültiges JSON", raw: null }
  }
  if (!raw || typeof raw !== "object") return { ok: false, error: "status.json ist leer", raw: null }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      error: "Statusformat v" + raw.schemaVersion + " nicht unterstützt, Widget aktualisieren",
      raw: raw
    }
  }
  if (!raw.spec || !Array.isArray(raw.tickets) || !raw.runner) {
    return { ok: false, error: "status.json ist unvollständig", raw: raw }
  }
  return { ok: true, snapshot: raw }
}

// Identifies one run, so a snapshot of a new run is never diffed against the
// one before it.
function runKey(snapshot) {
  if (!snapshot || !snapshot.runner) return ""
  return snapshot.runner.pid + "@" + snapshot.runner.startedAt
}

// True while the snapshot says the run goes on. Works on raw JSON of an
// unknown schema as well, as long as it keeps `result` and `runner.pid`.
function claimsRunning(snapshot) {
  return !!snapshot && !snapshot.result && !!snapshot.runner && Number(snapshot.runner.pid) > 0
}

function hasFailed(snapshot) {
  if (!snapshot || !snapshot.tickets) return false
  for (var i = 0; i < snapshot.tickets.length; i++) {
    if (snapshot.tickets[i].state === "failed") return true
  }
  return false
}

function timeMs(iso) {
  var t = Date.parse(iso)
  return isNaN(t) ? 0 : t
}

// When the active agent last showed a sign of life: its last log write, but
// never earlier than the start of the phase.
function lastSignOfLife(snapshot, lastOutputAt) {
  var active = snapshot && snapshot.active
  if (!active) return 0
  return Math.max(lastOutputAt || 0, timeMs(active.phaseStartedAt))
}

function isStalled(snapshot, lastOutputAt, now, stallMinutes) {
  var active = snapshot && snapshot.active
  if (!active || !AGENT_PHASES[active.phase]) return false
  var since = lastSignOfLife(snapshot, lastOutputAt)
  return since > 0 && now - since > stallMinutes * 60000
}

// "normal" | "warn" | "urgent" for the bar icon.
function iconLevel(snapshot, lastOutputAt, now, stallMinutes) {
  if (hasFailed(snapshot)) return "urgent"
  if (isStalled(snapshot, lastOutputAt, now, stallMinutes)) return "warn"
  return "normal"
}

function formatDuration(ms) {
  var s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + " s"
  var m = Math.floor(s / 60)
  if (m < 60) return m + " min"
  var h = Math.floor(m / 60)
  var rest = m % 60
  return h + " h " + (rest < 10 ? "0" : "") + rest + " min"
}

// One row per ticket for the popup: `kind` picks glyph and label.
function ticketRows(snapshot) {
  if (!snapshot || !snapshot.tickets) return []
  var active = snapshot.active
  var rows = []
  for (var i = 0; i < snapshot.tickets.length; i++) {
    var t = snapshot.tickets[i]
    var isActive = t.state === "active" || (active && active.ticket === t.number)
    var kind = isActive ? (active && PHASE_LABELS[active.phase] ? active.phase : "setup") : t.state
    var label = isActive ? PHASE_LABELS[kind] : (STATE_LABELS[kind] || String(kind))
    if (isActive && active && AGENT_PHASES[kind] && active.attempt) {
      label += " · Versuch " + active.attempt + "/" + active.maxAttempts
    }
    rows.push({
      number: t.number,
      title: String(t.title || ""),
      url: String(t.url || ""),
      kind: kind,
      glyph: GLYPHS[kind] || GLYPHS.pending,
      label: label,
      active: !!isActive
    })
  }
  return rows
}

// The live line under the active ticket, e.g.
// "Review · Versuch 2/3 · seit 4 min · letzte Ausgabe vor 12 s".
function diagLine(snapshot, lastOutputAt, now) {
  var active = snapshot && snapshot.active
  if (!active) return ""
  var parts = [PHASE_LABELS[active.phase] || String(active.phase)]
  if (AGENT_PHASES[active.phase] && active.attempt) {
    parts.push("Versuch " + active.attempt + "/" + active.maxAttempts)
  }
  var started = timeMs(active.phaseStartedAt)
  if (started > 0) parts.push("seit " + formatDuration(now - started))
  if (AGENT_PHASES[active.phase]) {
    parts.push(lastOutputAt > 0 && lastOutputAt >= started
      ? "letzte Ausgabe vor " + formatDuration(now - lastOutputAt)
      : "noch keine Ausgabe")
  }
  return parts.join(" · ")
}

function runDuration(snapshot, now) {
  if (!snapshot || !snapshot.runner) return ""
  var started = timeMs(snapshot.runner.startedAt)
  return started > 0 ? formatDuration(now - started) : ""
}

function progressText(snapshot) {
  if (!snapshot || !snapshot.tickets || snapshot.standalone) return ""
  var done = 0
  for (var i = 0; i < snapshot.tickets.length; i++) {
    var s = snapshot.tickets[i].state
    if (s === "landed" || s === "alreadyDone") done++
  }
  return done + "/" + snapshot.tickets.length + " erledigt"
}

function specLabel(snapshot) {
  return snapshot && snapshot.spec ? "#" + snapshot.spec.number + " " + String(snapshot.spec.title || "") : ""
}

function countWord(n, one, many) {
  return n + " " + (n === 1 ? one : many)
}

function summaryBody(summary) {
  if (!summary) return ""
  var parts = [
    countWord((summary.landed || []).length, "gelandet", "gelandet"),
    countWord((summary.failed || []).length, "zurückgegeben", "zurückgegeben"),
    countWord((summary.skipped || []).length, "übersprungen", "übersprungen")
  ]
  var body = parts.join(" · ")
  if (summary.rebaseNeeded) body += "\nIntegrationsbranch muss auf main rebased werden."
  return body
}

// Notifications for what changed between two snapshots. `prev` is the last
// snapshot the service already handled; a snapshot of another run counts as
// a fresh start. Each item: { title, body, url, urgency }.
function notificationsFor(prev, next) {
  if (!next) return []
  var before = prev && runKey(prev) === runKey(next) ? prev : { tickets: [], result: null }
  var out = []
  var spec = next.spec || {}
  var beforeStates = {}
  for (var i = 0; i < before.tickets.length; i++) beforeStates[before.tickets[i].number] = before.tickets[i].state

  for (var j = 0; j < next.tickets.length; j++) {
    var t = next.tickets[j]
    if (t.state === "failed" && beforeStates[t.number] !== "failed") {
      out.push({
        title: "Sandcastle: #" + t.number + " braucht dich",
        body: String(t.title || ""),
        url: String(t.url || spec.url || ""),
        urgency: "critical"
      })
    }
  }

  if (next.result && !before.result) {
    var r = next.result
    if (r.kind === "finished") {
      out.push({
        title: "Sandcastle: Spec #" + spec.number + " fertig",
        body: summaryBody(r.summary),
        url: String(spec.url || ""),
        urgency: "normal",
        runEnd: true
      })
    } else if (r.kind === "limit") {
      out.push({
        title: "Sandcastle: Limit erreicht",
        body: "Spec #" + spec.number + " angehalten. Ein neuer Run macht dort weiter.",
        url: String(spec.url || ""),
        urgency: "critical",
        runEnd: true
      })
    } else if (r.kind === "error") {
      out.push({
        title: "Sandcastle: Run fehlgeschlagen",
        body: String(r.message || "Unbekannter Fehler"),
        url: String(spec.url || ""),
        urgency: "critical",
        runEnd: true
      })
    }
    // "aborted" is a Ctrl+C by the developer: nothing to tell them.
  }
  return out
}

function crashNotification(snapshot) {
  var spec = (snapshot && snapshot.spec) || {}
  return {
    title: "Sandcastle: Run abgebrochen",
    body: "Der Runner für Spec #" + spec.number + " ist ohne Abschluss beendet worden.",
    url: String(spec.url || ""),
    urgency: "critical",
    runEnd: true
  }
}

// Argv for omarchy-notification-send. --exec has to come last.
function notificationArgv(omarchyPath, n) {
  var argv = [omarchyPath + "/bin/omarchy-notification-send",
    "--app-name", "Sandcastle", "-g", GLYPHS.plant, "-u", n.urgency || "normal",
    n.title]
  if (n.body) argv.push(n.body)
  if (n.url) argv.push("--exec", "xdg-open", n.url)
  return argv
}

// Parses one `inotifywait --format '%e|%w%f'` line.
function parseWatchLine(line) {
  var s = String(line)
  var bar = s.indexOf("|")
  if (bar < 0) return null
  return { events: s.slice(0, bar).split(","), path: s.slice(bar + 1) }
}

function baseName(path) {
  var s = String(path)
  return s.slice(s.lastIndexOf("/") + 1)
}

function dirName(path) {
  var s = String(path)
  var i = s.lastIndexOf("/")
  return i <= 0 ? "" : s.slice(0, i)
}

// Finds this plugin's inline entry in the bar layout.
function layoutEntry(barConfig, id) {
  var layout = barConfig && barConfig.layout
  if (!layout) return null
  var sections = ["left", "center", "right"]
  for (var i = 0; i < sections.length; i++) {
    var list = layout[sections[i]] || []
    for (var j = 0; j < list.length; j++) {
      if (list[j] && list[j].id === id) return list[j]
    }
  }
  return null
}

if (typeof module !== "undefined") {
  module.exports = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    GLYPHS: GLYPHS,
    expandHome: expandHome,
    newestRunDir: newestRunDir,
    parseSnapshot: parseSnapshot,
    runKey: runKey,
    claimsRunning: claimsRunning,
    hasFailed: hasFailed,
    lastSignOfLife: lastSignOfLife,
    isStalled: isStalled,
    iconLevel: iconLevel,
    formatDuration: formatDuration,
    ticketRows: ticketRows,
    diagLine: diagLine,
    runDuration: runDuration,
    progressText: progressText,
    specLabel: specLabel,
    notificationsFor: notificationsFor,
    crashNotification: crashNotification,
    notificationArgv: notificationArgv,
    parseWatchLine: parseWatchLine,
    baseName: baseName,
    dirName: dirName,
    layoutEntry: layoutEntry
  }
}
