const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Model = require("../Model.js")

const fixture = () =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "running.json"), "utf8"))

const with_ = (base, patch) => Object.assign({}, base, patch)
const withTicket = (snap, number, state) =>
  with_(snap, { tickets: snap.tickets.map((t) => (t.number === number ? with_(t, { state }) : t)) })

const PHASE_START = Date.parse("2026-11-01T13:25:00.000Z")

test("expandHome", () => {
  assert.equal(Model.expandHome("~/Projects/skool", "/home/b"), "/home/b/Projects/skool")
  assert.equal(Model.expandHome("~", "/home/b"), "/home/b")
  assert.equal(Model.expandHome("/srv/x/", "/home/b"), "/srv/x")
})

test("newestRunDir picks the latest start time and ignores other names", () => {
  const names = [
    "spec-29-2026-10-30T18-44-41-644Z",
    "spec-60-2026-11-01T13-02-27-986Z",
    "spec-60-2026-11-01T13-01-28-774Z",
    "status.json",
    "spec-x",
  ]
  assert.equal(Model.newestRunDir(names), "spec-60-2026-11-01T13-02-27-986Z")
  assert.equal(Model.newestRunDir([]), "")
})

test("parseSnapshot accepts schema 1 and rejects others", () => {
  const ok = Model.parseSnapshot(JSON.stringify(fixture()))
  assert.equal(ok.ok, true)
  assert.equal(ok.snapshot.spec.number, 60)

  const v2 = Model.parseSnapshot(JSON.stringify(with_(fixture(), { schemaVersion: 2 })))
  assert.equal(v2.ok, false)
  assert.match(v2.error, /v2 nicht unterstützt/)
  assert.equal(Model.claimsRunning(v2.raw), true)

  assert.equal(Model.parseSnapshot("{nope").ok, false)
  assert.equal(Model.parseSnapshot('{"schemaVersion":1}').ok, false)
})

test("claimsRunning", () => {
  assert.equal(Model.claimsRunning(fixture()), true)
  assert.equal(Model.claimsRunning(with_(fixture(), { result: { kind: "finished" } })), false)
  assert.equal(Model.claimsRunning(null), false)
})

test("iconLevel: normal, warn after the stall threshold, urgent on a failed ticket", () => {
  const snap = fixture()
  assert.equal(Model.iconLevel(snap, PHASE_START + 1000, PHASE_START + 60000, 5), "normal")
  assert.equal(Model.iconLevel(snap, PHASE_START + 1000, PHASE_START + 6 * 60000, 5), "warn")
  // No output yet: the phase start counts as the last sign of life.
  assert.equal(Model.iconLevel(snap, 0, PHASE_START + 4 * 60000, 5), "normal")
  assert.equal(Model.iconLevel(snap, 0, PHASE_START + 6 * 60000, 5), "warn")
  assert.equal(Model.iconLevel(withTicket(snap, 66, "failed"), 0, PHASE_START, 5), "urgent")
})

test("phases without agent output never stall", () => {
  const snap = with_(fixture(), { active: with_(fixture().active, { phase: "checks" }) })
  assert.equal(Model.iconLevel(snap, 0, PHASE_START + 60 * 60000, 5), "normal")
})

test("ticketRows maps states and the active phase", () => {
  const rows = Model.ticketRows(fixture())
  assert.deepEqual(
    rows.map((r) => [r.number, r.kind, r.active]),
    [
      [65, "alreadyDone", false],
      [66, "landed", false],
      [67, "reviewing", true],
      [68, "pending", false],
    ]
  )
  assert.equal(rows[2].label, "Review · Versuch 2/3")
  assert.equal(rows[2].url, "https://github.com/ms007/skool/issues/67")
  assert.equal(rows[0].label, "War schon erledigt")
})

test("diagLine", () => {
  const snap = fixture()
  assert.equal(
    Model.diagLine(snap, PHASE_START + 228000, PHASE_START + 240000),
    "Review · Versuch 2/3 · seit 4 min · letzte Ausgabe vor 12 s"
  )
  assert.equal(Model.diagLine(snap, 0, PHASE_START + 5000), "Review · Versuch 2/3 · seit 5 s · noch keine Ausgabe")
  const checks = with_(snap, { active: with_(snap.active, { phase: "checks" }) })
  assert.equal(Model.diagLine(checks, 0, PHASE_START + 90000), "Checks laufen · seit 1 min")
  assert.equal(Model.diagLine(with_(snap, { active: null }), 0, 0), "")
})

test("formatDuration", () => {
  assert.equal(Model.formatDuration(0), "0 s")
  assert.equal(Model.formatDuration(59999), "59 s")
  assert.equal(Model.formatDuration(4 * 60000), "4 min")
  assert.equal(Model.formatDuration(65 * 60000), "1 h 05 min")
})

test("progressText counts landed and already done tickets", () => {
  assert.equal(Model.progressText(fixture()), "2/4 erledigt")
  assert.equal(Model.progressText(with_(fixture(), { standalone: true })), "")
})

test("notificationsFor: a newly failed ticket", () => {
  const prev = fixture()
  const next = withTicket(prev, 67, "failed")
  const out = Model.notificationsFor(prev, next)
  assert.equal(out.length, 1)
  assert.equal(out[0].title, "Sandcastle: #67 braucht dich")
  assert.equal(out[0].url, "https://github.com/ms007/skool/issues/67")
  // Seen already: no second notification.
  assert.equal(Model.notificationsFor(next, next).length, 0)
})

test("notificationsFor: run results", () => {
  const prev = fixture()
  const finished = with_(prev, {
    active: null,
    result: { kind: "finished", summary: { landed: [66, 67], failed: [], skipped: [], notStarted: [], rebaseNeeded: true } },
  })
  const [done] = Model.notificationsFor(prev, finished)
  assert.equal(done.title, "Sandcastle: Spec #60 fertig")
  assert.match(done.body, /2 gelandet · 0 zurückgegeben · 0 übersprungen/)
  assert.match(done.body, /rebased/)
  assert.equal(done.url, "https://github.com/ms007/skool/issues/60")

  const limit = Model.notificationsFor(prev, with_(prev, { result: { kind: "limit" } }))
  assert.equal(limit[0].title, "Sandcastle: Limit erreicht")

  const error = Model.notificationsFor(prev, with_(prev, { result: { kind: "error", message: "boom" } }))
  assert.equal(error[0].body, "boom")

  assert.equal(Model.notificationsFor(prev, with_(prev, { result: { kind: "aborted" } })).length, 0)
})

test("notificationsFor: a snapshot of another run starts from scratch", () => {
  const old = withTicket(fixture(), 67, "failed")
  const fresh = with_(withTicket(fixture(), 67, "failed"), {
    runner: { pid: 9999, startedAt: "2026-11-02T08:00:00.000Z" },
  })
  assert.equal(Model.notificationsFor(old, fresh).length, 1)
})

test("notificationArgv puts --exec last", () => {
  const argv = Model.notificationArgv("/usr/share/omarchy", {
    title: "T",
    body: "B",
    url: "https://x",
    urgency: "critical",
  })
  assert.equal(argv[0], "/usr/share/omarchy/bin/omarchy-notification-send")
  assert.deepEqual(argv.slice(-3), ["--exec", "xdg-open", "https://x"])
  assert.ok(argv.includes("--app-name"))
})

test("parseWatchLine", () => {
  assert.deepEqual(Model.parseWatchLine("CREATE,ISDIR|/a/logs/spec-1-x"), {
    events: ["CREATE", "ISDIR"],
    path: "/a/logs/spec-1-x",
  })
  assert.equal(Model.parseWatchLine("garbage"), null)
})

test("layoutEntry finds the plugin entry in any section", () => {
  const cfg = { layout: { left: [], right: [{ id: "a" }, { id: "me", projectPath: "/p" }] } }
  assert.equal(Model.layoutEntry(cfg, "me").projectPath, "/p")
  assert.equal(Model.layoutEntry(cfg, "nope"), null)
  assert.equal(Model.layoutEntry(null, "me"), null)
})
