import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { EventBus } from "../src/events";
import { backfillDecidedAsks, searchDecidedAsks } from "../src/decided-index";
import { migrate, MIGRATIONS } from "../src/schema";
import { Store } from "../src/store";
import { UsageLogger } from "../src/usage";
import type { KnockAskInput } from "../src/protocol";
import { rmrf, tmpHome } from "./helpers";

// WAG-416: the full-text index of decided asks and its search.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmrf(home);
});

function setup(project = "waggle") {
  const home = tmpHome();
  homes.push(home);
  const db = new Database(join(home, "knock.db"));
  const store = new Store(db, home, new EventBus(), new UsageLogger(db, home));
  const task = store.createTask({ name: "work", project });
  return { home, db, store, task };
}

const ask = (title: string, need: string, labels: [string, string]): KnockAskInput => ({
  title,
  need,
  why: "Two paths fit.",
  recommendation: "a",
  recommendation_why: "It is simpler.",
  options: [
    { id: "a", label: labels[0], title: "A" },
    { id: "b", label: labels[1], title: "B" },
  ],
});

let key = 0;
function decide(store: Store, input: KnockAskInput, taskId: string, choice = "a", message?: string) {
  const created = store.createCase(taskId, input);
  store.submitReply(created.id, { idempotency_key: `k-${++key}`, choice, ...(message ? { message } : {}), comments: [], captures: [] });
  return created.id;
}

const rows = (db: Database) => db.query(`SELECT case_id, project, title, need, options, pick, why FROM decided_asks`).all() as Record<string, string>[];

describe("index fill and update", () => {
  test("a decision writes one row with the question, options, pick and why", () => {
    const { db, store, task } = setup();
    const id = decide(store, ask("Which cache backend?", "Pick the cache for sessions.", ["Use Redis", "Use SQLite"]), task.id, "b", "SQLite needs no new service.");
    expect(rows(db)).toEqual([
      {
        case_id: id,
        project: "waggle",
        title: "Which cache backend?",
        need: "Pick the cache for sessions.",
        options: "Use Redis\nUse SQLite",
        pick: "Use SQLite",
        why: "SQLite needs no new service.",
      },
    ]);
  });

  test("an open ask, a review and a discuss reply are not indexed", () => {
    const { db, store, task } = setup();
    store.createCase(task.id, ask("Which cache backend?", "Pick one.", ["Use Redis", "Use SQLite"]));
    expect(rows(db)).toHaveLength(0);
    const open = store.createCase(task.id, ask("Name the flag", "Pick the flag name.", ["--fast", "--quick"]));
    store.submitReply(open.id, { idempotency_key: "k-d", intent: "discuss", choices: undefined, message: "Tell me more", comments: [], captures: [] });
    expect(rows(db)).toHaveLength(0);
  });

  test("changing the answer updates the row, one row for each case", () => {
    const { db, store, task } = setup();
    const created = store.createCase(task.id, ask("Which cache backend?", "Pick one.", ["Use Redis", "Use SQLite"]));
    const reply = store.submitReply(created.id, { idempotency_key: "k-u1", choice: "a", comments: [], captures: [] });
    expect(rows(db).map((r) => r.pick)).toEqual(["Use Redis"]);
    store.replaceReply(reply.id, { choice: "b", message: "Changed my mind.", comments: [], captures: [] });
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ pick: "Use SQLite", why: "Changed my mind." });
  });

  test("a withdrawn ask leaves the index", () => {
    const { db, store, task } = setup();
    const id = decide(store, ask("Which cache backend?", "Pick one.", ["Use Redis", "Use SQLite"]), task.id);
    expect(rows(db)).toHaveLength(1);
    store.createCase(task.id, { ...ask("Which cache backend?", "Pick one, again.", ["Use Redis", "Use SQLite"]), replaces: id });
    expect(rows(db)).toHaveLength(0);
  });
});

describe("the migration fills the index from old decided cases", () => {
  test("migration 61 indexes cases decided before it", () => {
    const home = tmpHome();
    homes.push(home);
    const db = new Database(join(home, "knock.db"));
    // Build the database as version 60 left it: migrations up to 60 only.
    for (const m of MIGRATIONS.filter((x) => x.version <= 60)) {
      if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
      db.transaction(() => {
        if (m.up) m.up(db);
        else db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
      })();
      if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = ON");
    }
    const now = "2026-11-01T10:00:00.000Z";
    db.exec(`INSERT INTO tasks (id, name, project, created_at) VALUES ('t1', 'work', 'waggle', '${now}')`);
    db.exec(
      `INSERT INTO cases (id, task_id, kind, title, need, why, recommendation, recommendation_why, options_json, status, created_at, updated_at)
       VALUES ('c1', 't1', 'question', 'Which cache backend?', 'Pick one.', 'w', 'a', 'r',
               '[{"id":"a","label":"Use Redis"},{"id":"b","label":"Use SQLite"}]', 'waiting_on_agent', '${now}', '${now}')`,
    );
    db.exec(`INSERT INTO option_sets (case_id, seq, options_json, recommendation, recommendation_why, created_at)
             VALUES ('c1', 0, '[{"id":"a","label":"Use Redis"},{"id":"b","label":"Use SQLite"}]', 'a', 'r', '${now}')`);
    db.exec(`INSERT INTO usage (event, hour) VALUES ('ask_created', '${now}')`);
    db.exec(
      `INSERT INTO replies (id, case_id, idempotency_key, choice, message, state, created_at, intent)
       VALUES ('r1', 'c1', 'k1', 'b', 'No new service.', 'delivered', '${now}', 'decision')`,
    );
    migrate(db);
    expect(rows(db)).toEqual([
      { case_id: "c1", project: "waggle", title: "Which cache backend?", need: "Pick one.", options: "Use Redis\nUse SQLite", pick: "Use SQLite", why: "No new service." },
    ]);
    // The usage rows stay and the table takes the new events.
    expect(db.query(`SELECT COUNT(*) AS n FROM usage WHERE event = 'ask_created'`).get()).toEqual({ n: 1 });
    db.exec(`INSERT INTO usage (event, hour, n) VALUES ('ask_held', 'h', 2)`);
    db.exec(`INSERT INTO usage (event, hour) VALUES ('ask_check_failed', 'h')`);
    expect((db.query(`PRAGMA user_version`).get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(61);
    // Running the fill again changes nothing.
    backfillDecidedAsks(db);
    expect(rows(db)).toHaveLength(1);
  });
});

describe("search", () => {
  // The fixture the strong-match threshold was set from: decided asks of one project, and asks that should
  // and should not match them.
  const decided: [string, string, [string, string]][] = [
    ["Which cache backend for sessions?", "Pick the cache for user sessions.", ["Use Redis", "Use SQLite"]],
    ["How should the daemon name its log files?", "Pick the log file name pattern.", ["One file for each day", "One file for each run"]],
    ["Ship the sharing page behind a flag?", "Pick the rollout of the sharing page.", ["Hide it behind a flag", "Ship it to everyone"]],
    ["Which test runner for the relay?", "Pick a test runner.", ["Use Vitest", "Use Bun test"]],
  ];

  function fixture() {
    const ctx = setup();
    const ids = decided.map(([t, n, l]) => decide(ctx.store, ask(t, n, l), ctx.task.id));
    return { ...ctx, ids };
  }
  const q = (title: string, need = "", optionLabels: string[] = []) => ({ title, need, optionLabels });

  test("a near duplicate matches, with the case id, question, pick, why and date", () => {
    const { db, ids } = fixture();
    const hits = searchDecidedAsks(db, "waggle", q("Which cache backend should sessions use?", "We need a cache.", ["Use Redis", "Use Memcached"]));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ case_id: ids[0], question: "Which cache backend for sessions?", pick: "Use Redis", why: "" });
    expect(hits[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("threshold: strong rewordings match, a shared topic word alone does not", () => {
    const { db, ids } = fixture();
    const strong: [string, string][] = [
      ["Name the daemon log files: one for each day?", ids[1]!],
      ["Sharing page rollout: hide behind a flag?", ids[2]!],
      ["Pick a test runner for the relay", ids[3]!],
    ];
    for (const [title, id] of strong) {
      expect(searchDecidedAsks(db, "waggle", q(title)).map((h) => h.case_id)).toContain(id);
    }
    const weak = [
      "Which color for the sharing button?", // shares "sharing" only
      "Which cache size for the relay?", // shares "cache" and "relay" with two different asks, covers under 0.6 of each
      "Rename the settings page",
      "Add a dark mode",
    ];
    for (const title of weak) expect(searchDecidedAsks(db, "waggle", q(title))).toEqual([]);
  });

  test("it returns at most 3, best first", () => {
    const { db, store, task } = setup();
    for (let i = 0; i < 5; i++) decide(store, ask("Which cache backend for sessions?", `Variant ${i}.`, ["Use Redis", "Use SQLite"]), task.id);
    expect(searchDecidedAsks(db, "waggle", q("Which cache backend for sessions?"))).toHaveLength(3);
  });

  test("it never returns a case from another project", () => {
    const { db, store, task } = setup("waggle");
    decide(store, ask("Which cache backend for sessions?", "Pick one.", ["Use Redis", "Use SQLite"]), task.id);
    const other = store.createTask({ name: "other", project: "omea" });
    const otherId = decide(store, ask("Which cache backend for sessions?", "Pick one.", ["Use Redis", "Use SQLite"]), other.id, "b");
    const mine = searchDecidedAsks(db, "waggle", q("Which cache backend for sessions?"));
    expect(mine).toHaveLength(1);
    expect(mine.map((m) => m.case_id)).not.toContain(otherId);
    expect(searchDecidedAsks(db, "omea", q("Which cache backend for sessions?")).map((m) => m.case_id)).toEqual([otherId]);
    expect(searchDecidedAsks(db, "nobody", q("Which cache backend for sessions?"))).toEqual([]);
  });

  test("a query of quotes and operators does not break the search", () => {
    const { db } = fixture();
    expect(searchDecidedAsks(db, "waggle", q('"cache" OR NEAR( AND * backend:', "\"\" ' -- ;"))).toBeArray();
  });
});
