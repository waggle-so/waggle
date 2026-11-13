import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventBus } from "../src/events";
import { Store } from "../src/store";
import { UsageLogger } from "../src/usage";
import { backfillCorrections, correctionsByWeek, isoWeekLabel, storedReplyCorrection } from "../src/corrections";
import { migrate, MIGRATIONS } from "../src/schema";
import { DEFAULT_ASK_LESS, type AskLess, type KnockAskInput } from "../src/protocol";
import { rmrf, tmpHome } from "./helpers";

// WAG-414: the correction flag of a reply, the coded usage event and corrections per ask by week.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmrf(home);
});

function setup(askLess?: AskLess) {
  const home = tmpHome();
  homes.push(home);
  const db = new Database(":memory:");
  const store = new Store(db, home, new EventBus(), new UsageLogger(db, home));
  if (askLess) store.setAskLess(askLess);
  const task = store.createTask({ name: "work", project: "waggle" });
  store.createSession(task.id, { id: "sess-1", cwd: "/work", branch: null, pid: 4242 });
  return { db, store, task };
}

const base = { intent: "decision" as const, comments: [], captures: [] };
let n = 0;
const key = () => `k${++n}`;

const options = [
  { id: "a", label: "Call it parseRow", title: "parseRow" },
  { id: "b", label: "Call it readRow", title: "readRow" },
];
const withRec: KnockAskInput = { title: "Name it", need: "What name?", why: "Two fit.", recommendation: "a", recommendation_why: "Shorter.", options };
const flagOf = (db: Database, replyId: string) => (db.query(`SELECT correction FROM replies WHERE id = ?`).get(replyId) as { correction: number | null }).correction;
const events = (db: Database) => db.query(`SELECT * FROM usage WHERE event = 'correction'`).all() as Record<string, unknown>[];

describe("correction rules", () => {
  test("the recommended pick is not a correction", () => {
    const { db, store, task } = setup();
    const c = store.createCase(task.id, withRec);
    const r = store.submitReply(c.id, { ...base, idempotency_key: key(), choice: "a" });
    expect(flagOf(db, r.id)).toBe(0);
    expect(events(db)).toHaveLength(0);
  });

  test("a pick that is not the recommendation is a correction", () => {
    const { db, store, task } = setup();
    const c = store.createCase(task.id, withRec);
    const r = store.submitReply(c.id, { ...base, idempotency_key: key(), choice: "b" });
    expect(flagOf(db, r.id)).toBe(1);
  });

  test("a pick with a note on the recommended option is not a correction", () => {
    const { db, store, task } = setup();
    const c = store.createCase(task.id, withRec);
    const r = store.submitReply(c.id, { ...base, idempotency_key: key(), choice: "a", message: "Also rename the file." });
    expect(flagOf(db, r.id)).toBe(0);
  });

  test("a multi-select pick is a correction unless it equals the recommended set", () => {
    const { db, store, task } = setup();
    const ask: KnockAskInput = {
      ...withRec,
      select: "many",
      recommendation: ["a", "b"],
      options: [...options, { id: "c", label: "Call it loadRow", title: "loadRow" }],
    };
    const same = store.submitReply(store.createCase(task.id, ask).id, { ...base, idempotency_key: key(), choices: ["b", "a"] });
    const other = store.submitReply(store.createCase(task.id, ask).id, { ...base, idempotency_key: key(), choices: ["a", "c"] });
    expect(flagOf(db, same.id)).toBe(0);
    expect(flagOf(db, other.id)).toBe(1);
  });

  test("an ask with no recommendation is never a correction because of its pick", () => {
    const { db, store, task } = setup();
    const ask = { title: "Name it", need: "What name?", why: "Two fit.", options } as unknown as KnockAskInput;
    const c = store.createCase(task.id, ask);
    const r = store.submitReply(c.id, { ...base, idempotency_key: key(), choice: "b" });
    expect(flagOf(db, r.id)).toBe(0);
  });

  test("an ask with no recommendation still counts the other rules (comments)", () => {
    const { db, store, task } = setup();
    const ask = { title: "Name it", need: "What name?", why: "Two fit.", options } as unknown as KnockAskInput;
    const c = store.createCase(task.id, ask);
    const r = store.submitReply(c.id, {
      ...base,
      idempotency_key: key(),
      choice: "b",
      comments: [{ id: "cm1", n: 1, text: "Mind the spelling" } as never],
    });
    expect(flagOf(db, r.id)).toBe(1);
  });

  test("the person's own answer to a reply item is a correction", () => {
    const { db, store, task } = setup();
    const ask: KnockAskInput = { title: "Name it", need: "What name should it have?", why: "Free text.", recommendation: "parseRow", recommendation_why: "Short." } as KnockAskInput;
    const c = store.createCase(task.id, ask);
    const r = store.submitReply(c.id, { ...base, idempotency_key: key(), message: "Call it rowReader." });
    expect(flagOf(db, r.id)).toBe(1);
  });

  test("a multi-item ask: one off-recommendation pick makes the reply a correction", () => {
    const { db, store, task } = setup();
    const ask = {
      title: "Two things",
      need: "Answer both",
      why: "Two decisions.",
      items: [
        { id: "x", question: "Name?", options, recommendation: "a" },
        { id: "y", question: "Case?", options, recommendation: "a" },
      ],
    } as unknown as KnockAskInput;
    const ok = store.submitReply(store.createCase(task.id, ask).id, {
      ...base,
      idempotency_key: key(),
      item_answers: [{ item_id: "x", choice: "a" }, { item_id: "y", choice: "a" }],
    });
    const off = store.submitReply(store.createCase(task.id, ask).id, {
      ...base,
      idempotency_key: key(),
      item_answers: [{ item_id: "x", choice: "a" }, { item_id: "y", choice: "b" }],
    });
    expect(flagOf(db, ok.id)).toBe(0);
    expect(flagOf(db, off.id)).toBe(1);
  });

  const review: KnockAskInput = {
    kind: "review",
    title: "Review the layout",
    need: "Approve the layout",
    why: "It ships.",
    recommendation: "approve",
    recommendation_why: "It reads well.",
    options: [
      { id: "approve", label: "Approve: ship it", title: "Approve" },
      { id: "request_changes", label: "Request changes: use my comments", title: "Request changes" },
    ],
  };

  test("approving a review is not a correction", () => {
    const { db, store, task } = setup();
    const r = store.submitReply(store.createCase(task.id, review).id, { ...base, idempotency_key: key(), choice: "approve" });
    expect(flagOf(db, r.id)).toBe(0);
  });

  test("requesting changes on a review is a correction", () => {
    const { db, store, task } = setup();
    const r = store.submitReply(store.createCase(task.id, review).id, { ...base, idempotency_key: key(), choice: "request_changes" });
    expect(flagOf(db, r.id)).toBe(1);
  });

  test("approving a review with comments is a correction", () => {
    const { db, store, task } = setup();
    const r = store.submitReply(store.createCase(task.id, review).id, {
      ...base,
      idempotency_key: key(),
      choice: "approve",
      comments: [{ id: "cm2", n: 1, text: "Tighten this." } as never],
    });
    expect(flagOf(db, r.id)).toBe(1);
  });

  test("Change my mind makes the next deciding reply a correction, even on the recommended option", () => {
    const { db, store, task } = setup({ enabled: true, rules: { naming: true, wording: false, formatting: false, tests: false } });
    const c = store.createCase(task.id, { ...withRec, category: "naming" });
    expect(c.status).toBe("resolved");
    store.changeMind(c.id);
    const r = store.submitReply(c.id, { ...base, idempotency_key: key(), choice: "a" });
    expect(flagOf(db, r.id)).toBe(1);
  });

  test("a case never auto-decided keeps the same pick as no correction", () => {
    const { db, store, task } = setup({ enabled: true, rules: { naming: true, wording: false, formatting: false, tests: false } });
    const c = store.createCase(task.id, withRec);
    expect(c.status).toBe("needs_you");
    store.changeMind(c.id);
    const r = store.submitReply(c.id, { ...base, idempotency_key: key(), choice: "a" });
    expect(flagOf(db, r.id)).toBe(0);
  });
});

describe("replies that are not corrections", () => {
  test("Keep talking and more detail have no flag", () => {
    const { db, store, task } = setup();
    const c = store.createCase(task.id, withRec);
    const detail = store.submitReply(c.id, { ...base, idempotency_key: key(), intent: "more_detail", format: "eli5" });
    const talk = store.submitReply(c.id, { ...base, idempotency_key: key(), intent: "discuss", message: "Not sure yet.", leaning: ["b"] } as never);
    expect(flagOf(db, detail.id)).toBeNull();
    expect(flagOf(db, talk.id)).toBeNull();
    expect(events(db)).toHaveLength(0);
  });

  test("a feedback note with no pick has no flag", () => {
    const { db, store, task } = setup();
    const c = store.createCase(task.id, withRec);
    const r = store.submitReply(c.id, { ...base, idempotency_key: key(), message: "What about readRow?" });
    expect(flagOf(db, r.id)).toBeNull();
  });
});

describe("replace a queued reply", () => {
  test("the flag follows the new pick and the event is logged once", () => {
    const { db, store, task } = setup();
    const c = store.createCase(task.id, withRec);
    const r = store.submitReply(c.id, { ...base, idempotency_key: key(), choice: "a" });
    expect(flagOf(db, r.id)).toBe(0);
    store.replaceReply(r.id, { ...base, choice: "b" });
    expect(flagOf(db, r.id)).toBe(1);
    store.replaceReply(r.id, { ...base, choice: "b", message: "again" });
    expect(flagOf(db, r.id)).toBe(1);
    expect(events(db)).toHaveLength(1);
    store.replaceReply(r.id, { ...base, choice: "a" });
    expect(flagOf(db, r.id)).toBe(0);
  });
});

describe("the usage log", () => {
  test("a correction logs a coded event with the ask hash and no text", () => {
    const { db, store, task } = setup();
    const c = store.createCase(task.id, { ...withRec, title: "SECRET-TITLE" });
    store.submitReply(c.id, { ...base, idempotency_key: key(), choice: "b", message: "SECRET-REPLY" });
    const rows = events(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ask_h).toMatch(/^[0-9a-f]{12}$/);
    const dump = JSON.stringify(db.query(`SELECT * FROM usage`).all());
    expect(dump).not.toContain("SECRET");
    expect(dump).not.toContain(c.id);
  });
});

describe("corrections per ask by week", () => {
  const NOW = new Date("2026-11-13T12:00:00.000Z"); // Friday, ISO week 46

  function seedReply(db: Database, store: Store, project: string, at: string, choice: string, taskId?: string) {
    const task = taskId ? { id: taskId } : store.createTask({ name: `t-${project}`, project });
    const c = store.createCase(task.id, withRec);
    const r = store.submitReply(c.id, { ...base, idempotency_key: key(), choice });
    db.query(`UPDATE replies SET created_at = ? WHERE id = ?`).run(at, r.id);
    return r.id;
  }

  test("iso week labels", () => {
    expect(isoWeekLabel(new Date("2026-11-09T00:00:00Z"))).toBe("2026-W46");
    expect(isoWeekLabel(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
    expect(isoWeekLabel(new Date("2021-01-04T00:00:00Z"))).toBe("2021-W01");
    expect(isoWeekLabel(new Date("2020-12-28T00:00:00Z"))).toBe("2020-W53");
  });

  test("a week with corrections, a week without, an empty week", () => {
    const { db, store } = setup();
    // Week 46: 1 correction in 2 asks. Week 45: 1 ask, none. Week 44: nothing.
    seedReply(db, store, "waggle", "2026-11-10T09:00:00.000Z", "a");
    seedReply(db, store, "waggle", "2026-11-12T09:00:00.000Z", "b");
    seedReply(db, store, "waggle", "2026-11-04T09:00:00.000Z", "a");
    const weeks = correctionsByWeek(db, { weeks: 3, now: NOW });
    expect(weeks).toEqual([
      { week: "2026-W44", starts: "2026-10-26", asks: 0, corrections: 0, per_ask: null },
      { week: "2026-W45", starts: "2026-11-02", asks: 1, corrections: 0, per_ask: 0 },
      { week: "2026-W46", starts: "2026-11-09", asks: 2, corrections: 1, per_ask: 0.5 },
    ]);
  });

  test("one project, and all projects", () => {
    const { db, store } = setup();
    seedReply(db, store, "alpha", "2026-11-10T09:00:00.000Z", "b");
    seedReply(db, store, "beta", "2026-11-10T10:00:00.000Z", "a");
    seedReply(db, store, "beta", "2026-11-10T11:00:00.000Z", "a");
    const all = correctionsByWeek(db, { weeks: 1, now: NOW })[0]!;
    expect(all).toMatchObject({ asks: 3, corrections: 1, per_ask: 0.33 });
    expect(correctionsByWeek(db, { project: "alpha", weeks: 1, now: NOW })[0]).toMatchObject({ asks: 1, corrections: 1, per_ask: 1 });
    expect(correctionsByWeek(db, { project: "beta", weeks: 1, now: NOW })[0]).toMatchObject({ asks: 2, corrections: 0, per_ask: 0 });
    expect(correctionsByWeek(db, { project: "none", weeks: 1, now: NOW })[0]).toMatchObject({ asks: 0, per_ask: null });
  });

  test("replies that did not decide, and failed replies, do not count", () => {
    const { db, store, task } = setup();
    const c = store.createCase(task.id, withRec);
    store.submitReply(c.id, { ...base, idempotency_key: key(), intent: "more_detail", format: "eli5" });
    const failed = store.submitReply(c.id, { ...base, idempotency_key: key(), choice: "b" });
    db.query(`UPDATE replies SET state = 'failed' WHERE id = ?`).run(failed.id);
    expect(correctionsByWeek(db, { weeks: 1 })[0]).toMatchObject({ asks: 0, corrections: 0 });
  });
});

describe("migration 59 backfill", () => {
  function atVersion58() {
    const db = new Database(":memory:");
    for (const m of MIGRATIONS.filter((x) => x.version <= 58)) {
      if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
      db.transaction(() => {
        if (m.up) m.up(db);
        else db.exec(m.sql);
      })();
      if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = ON");
    }
    db.exec("PRAGMA user_version = 58");
    return db;
  }

  test("the backfill sets the flag again from stored data and keeps the usage rows", () => {
    const db = atVersion58();
    const home = tmpHome();
    homes.push(home);
    // The Store runs migrate(), so the database is at 59. The flags are cleared to look like old replies.
    const store = new Store(db, home, new EventBus());
    const task = store.createTask({ name: "work", project: "waggle" });
    const rec = store.createCase(task.id, withRec);
    const pickOff = store.createCase(task.id, withRec);
    const talk = store.createCase(task.id, withRec);
    const ok = store.submitReply(rec.id, { ...base, idempotency_key: key(), choice: "a" });
    const off = store.submitReply(pickOff.id, { ...base, idempotency_key: key(), choice: "b" });
    const more = store.submitReply(talk.id, { ...base, idempotency_key: key(), intent: "more_detail", format: "eli5" });
    db.query(`UPDATE replies SET correction = NULL`).run();
    db.exec(`INSERT INTO usage (event, hour, n) VALUES ('ask_created', '2026-11-01T10:00:00.000Z', 1)`);
    expect(db.query(`PRAGMA user_version`).get()).toMatchObject({ user_version: 59 });
    // The same function the migration runs.
    expect(backfillCorrections(db)).toBe(1);
    expect(flagOf(db, ok.id)).toBe(0);
    expect(flagOf(db, off.id)).toBe(1);
    expect(flagOf(db, more.id)).toBeNull();
    expect(storedReplyCorrection(db, off.id)).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS c FROM usage WHERE event = 'ask_created'`).get()).toMatchObject({ c: 1 });
  });

  test("the migration itself runs on a version 58 database with replies", () => {
    const db = atVersion58();
    db.exec(`INSERT INTO tasks (id, name, project, created_at) VALUES ('t1', 'work', 'waggle', '2026-11-01T00:00:00Z')`);
    // Fill the NOT NULL columns of a case and a reply with plain values.
    const fill = (table: string, values: Record<string, unknown>) => {
      const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: string | null }[]).filter(
        (c) => c.notnull === 1 && c.dflt_value === null,
      );
      const row: Record<string, unknown> = { ...values };
      for (const c of cols) if (!(c.name in row)) row[c.name] = c.name.endsWith("_at") ? "2026-11-01T00:00:00Z" : "x";
      const names = Object.keys(row);
      db.query(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...(Object.values(row) as never[]));
    };
    const options_json = JSON.stringify(options);
    fill("cases", { id: "c1", task_id: "t1", kind: "question", options_json, recommendation: "a", status: "waiting_on_agent" });
    fill("option_sets", { case_id: "c1", seq: 0, options_json, recommendation: "a" });
    fill("replies", { id: "r1", case_id: "c1", idempotency_key: "i1", choice: "b", intent: "decision", state: "delivered" });
    fill("replies", { id: "r2", case_id: "c1", idempotency_key: "i2", choice: "a", intent: "decision", state: "delivered" });
    migrate(db);
    expect(db.query(`PRAGMA user_version`).get()).toMatchObject({ user_version: 59 });
    expect(flagOf(db, "r1")).toBe(1);
    expect(flagOf(db, "r2")).toBe(0);
    db.exec(`INSERT INTO usage (event, hour) VALUES ('correction', 'h')`);
  });
});
