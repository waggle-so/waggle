import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../src/events";
import { migrate, MIGRATIONS } from "../src/schema";
import { Store } from "../src/store";
import { Case, KnockAskInput, type Artifact } from "../src/protocol";
import golden from "./fixtures/items-golden.json" with { type: "json" };
import { rmrf, stageIncoming, tmpHome } from "./helpers";

// WAG-313 (T2): migration 41 adds option_sets.items_json and replies.item_answers_json. It starts from
// the real schema at version 40, with rows in every table it touches, and checks that every row and
// every old column survives. Read-time normalisation then gives the items of old rows. The dual write
// is checked at the end: a shortcut and its canonical twin store the same items and the same old columns.

const T0 = "2026-09-01T10:00:00.000Z";
const T1 = "2026-09-01T10:05:00.000Z";
const T2 = "2026-09-01T10:10:00.000Z";
const T3 = "2026-09-01T10:15:00.000Z";

function migrateTo(db: Database, max: number): void {
  for (const m of MIGRATIONS.filter((x) => x.version <= max)) {
    if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      if (m.up) m.up(db);
      else db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    })();
    if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = ON");
  }
}

function insert(db: Database, table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  db.query(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...(Object.values(row) as never[]));
}

const opt = (id: string, label: string, title?: string) => ({ id, label, ...(title ? { title } : {}) });
const AB = [opt("a", "Compact", "Compact"), opt("b", "Detailed")];
const XY = [opt("x", "Wizard"), opt("y", "Checklist")];

function caseRow(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    task_id: "t1",
    kind: "question",
    title: `Title ${id}`,
    need: `Need ${id}`,
    why: "Why.",
    recommendation: "",
    recommendation_why: "",
    options_json: "[]",
    status: "needs_you",
    created_at: T0,
    updated_at: T0,
    ...extra,
  };
}

function optionSet(caseId: string, seq: number, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    case_id: caseId,
    seq,
    options_json: "[]",
    recommendation: "",
    recommendation_why: "",
    created_at: T0,
    own_artifact: 0,
    ...extra,
  };
}

// Seeds a version 40 database: one case for each shape an old row can have.
function seed(db: Database): void {
  insert(db, "tasks", { id: "t1", name: "WAG-313", project: "waggle", created_at: T0 });
  insert(db, "sessions", { id: "s1", task_id: "t1", cwd: "/tmp/x", pid: 1, state: "live", connected_at: T0, session_title: "Title" });

  // 1. A question with select many.
  insert(db, "cases", caseRow("c_many", {
    options_json: JSON.stringify([opt("a", "Cart"), opt("b", "Search"), opt("c", "Profile")]),
    recommendation: "a", recommendation_why: "Most used.", select_mode: "many", max_choices: 2, recommendations_json: '["a","c"]',
  }));
  insert(db, "option_sets", optionSet("c_many", 0, {
    options_json: JSON.stringify([opt("a", "Cart"), opt("b", "Search"), opt("c", "Profile")]),
    recommendation: "a", recommendation_why: "Most used.", select_mode: "many", max_choices: 2, recommendations_json: '["a","c"]',
  }));
  insert(db, "replies", { id: "r_many", case_id: "c_many", idempotency_key: "k_many", choices_json: '["a","c"]', state: "delivered", created_at: T1, delivered_at: T2, source: "telegram" });
  insert(db, "reply_option_sets", { reply_id: "r_many", seq: 0 });

  // 2. A review with an artifact and no options.
  insert(db, "cases", caseRow("c_review", { kind: "review", recommendation: "Looks fine to me", recommendation_why: "Short page." }));
  insert(db, "option_sets", optionSet("c_review", 0, { recommendation: "Looks fine to me", recommendation_why: "Short page.", revision: 1, own_artifact: 1 }));
  insert(db, "revisions", { id: "rev1", case_id: "c_review", n: 1, created_at: T0, kind: "markdown", sha256: "abc", ext: "md", author: "agent", artifact_name: "Pricing" });
  insert(db, "replies", { id: "r_review", case_id: "c_review", idempotency_key: "k_review", message: "Fix the title.", state: "queued", created_at: T1 });
  insert(db, "captures", { id: "cap1", case_id: "c_review", revision: 1, reply_id: "r_review", png_base64: "AAAA", annotated_png_base64: "BBBB", taken_at: T1, note: "Screen 1" });
  insert(db, "comments", { id: "com1", case_id: "c_review", capture_id: "cap1", reply_id: "r_review", n: 1, rect_json: '{"x":1,"y":2,"w":3,"h":4}', text: "Too long." });

  // 3. A plan with 3 rounds. The comments-only reply on round 1 carries the old plan_round stamp.
  const planCase = { recommendation: "y", recommendation_why: "Clearer.", options_json: JSON.stringify(XY) };
  insert(db, "cases", caseRow("c_plan", planCase));
  insert(db, "option_sets", optionSet("c_plan", 0, {
    options_json: JSON.stringify(AB), recommendation: "a", recommendation_why: "Fits.",
    stage_json: '{"name":"questions","step":1,"total":5}', question: "Who is the first user?",
  }));
  insert(db, "option_sets", optionSet("c_plan", 1, {
    options_json: JSON.stringify(XY), recommendation: "x", recommendation_why: "Shortest.", created_at: T1,
    stage_json: '{"name":"approaches"}', question: "Which approach?",
  }));
  insert(db, "option_sets", optionSet("c_plan", 2, {
    options_json: JSON.stringify(XY), recommendation: "y", recommendation_why: "Clearer.", created_at: T2,
    stage_json: '{"name":"design"}', question: "Which layout?",
  }));
  insert(db, "replies", { id: "r_plan0", case_id: "c_plan", idempotency_key: "k_plan0", choice: "a", state: "delivered", created_at: T0, plan_round: 0 });
  insert(db, "reply_option_sets", { reply_id: "r_plan0", seq: 0 });
  insert(db, "replies", { id: "r_plan1c", case_id: "c_plan", idempotency_key: "k_plan1c", message: "Not sure yet.", state: "delivered", created_at: "2026-09-01T10:06:00.000Z", plan_round: 1 });
  insert(db, "replies", { id: "r_plan1", case_id: "c_plan", idempotency_key: "k_plan1", choice: "x", state: "delivered", created_at: "2026-09-01T10:07:00.000Z", plan_round: 1 });
  insert(db, "reply_option_sets", { reply_id: "r_plan1", seq: 1 });

  // 4. A questions request with an answers reply.
  const questions = [
    { id: "q1", title: "Card", points: [{ id: "p1", text: "Where does it sit?", options: ["Under the avatar", { label: "Beside the name", pros: ["Clear"] }] }, { id: "p2", text: "Keep the border?" }] },
    { id: "q2", title: "Header", now: ["A plain bar."], points: [{ id: "p1", text: "Sticky?" }] },
  ];
  insert(db, "cases", caseRow("c_questions", { questions_json: JSON.stringify(questions) }));
  insert(db, "option_sets", optionSet("c_questions", 0, {}));
  insert(db, "replies", {
    id: "r_questions", case_id: "c_questions", idempotency_key: "k_questions", state: "queued", created_at: T1,
    answers_json: JSON.stringify([{ question_id: "q1", point_id: "p1", choice: "Under the avatar", note: "Small." }, { question_id: "q2", point_id: "p1", choice: "Yes" }]),
  });

  // 5. A reply-only ask.
  insert(db, "cases", caseRow("c_reply", { recommendation: "Call it Hive.", recommendation_why: "Short." }));
  insert(db, "option_sets", optionSet("c_reply", 0, { recommendation: "Call it Hive.", recommendation_why: "Short." }));
  insert(db, "replies", { id: "r_reply", case_id: "c_reply", idempotency_key: "k_reply", message: "Hive is fine.", state: "delivered", created_at: T1, intent: "decision" });

  // 6. A waggle_update round with new options. The case columns hold the newest set.
  insert(db, "cases", caseRow("c_update", { options_json: JSON.stringify(XY), recommendation: "y", recommendation_why: "Clearer.", updated_at: T1 }));
  insert(db, "option_sets", optionSet("c_update", 0, { options_json: JSON.stringify(AB), recommendation: "a", recommendation_why: "Fits." }));
  insert(db, "option_sets", optionSet("c_update", 1, { options_json: JSON.stringify(XY), recommendation: "y", recommendation_why: "Clearer.", created_at: T1, question: "New take." }));
  insert(db, "messages", { id: "m1", case_id: "c_update", role: "agent", text: "New take.", created_at: T1 });
  insert(db, "replies", { id: "r_update", case_id: "c_update", idempotency_key: "k_update", choice: "y", state: "queued", created_at: T2 });
  insert(db, "reply_option_sets", { reply_id: "r_update", seq: 1 });
  insert(db, "replies", { id: "r_discuss", case_id: "c_update", idempotency_key: "k_discuss", intent: "discuss", message: "Thinking.", leaning_json: '["x"]', state: "superseded", created_at: T1 });

  // 7. A done case.
  insert(db, "cases", caseRow("c_done", { status: "waiting_on_agent", done_at: T1 }));
  insert(db, "option_sets", optionSet("c_done", 0, {}));
  insert(db, "messages", { id: "m2", case_id: "c_done", role: "agent", text: "All done.", created_at: T1 });
  insert(db, "events", { type: "case.created", case_id: "c_done", at: T0 });
}

// Every table, with its column names, before the migration.
function snapshot(db: Database, columns?: Map<string, string[]>): { rows: Map<string, string>; columns: Map<string, string[]> } {
  const tables = (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
  const cols = columns ?? new Map(tables.map((t) => [t, (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)]));
  const rows = new Map<string, string>();
  for (const t of tables) {
    const list = cols.get(t);
    if (!list) continue;
    rows.set(t, JSON.stringify(db.query(`SELECT ${list.join(", ")} FROM ${t} ORDER BY rowid`).all()));
  }
  return { rows, columns: cols };
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const versionOf = (db: Database): number => Number((db.query("PRAGMA user_version").get() as { user_version: number }).user_version);

describe("migration 41: items_json and item_answers_json", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmrf(d);
  });

  function migrated(): { db: Database; before: ReturnType<typeof snapshot>; counts: Map<string, number> } {
    const db = new Database(":memory:");
    migrateTo(db, 40);
    expect(versionOf(db)).toBe(40);
    seed(db);
    const before = snapshot(db);
    const counts = new Map([...before.columns.keys()].map((t) => [t, count(db, t)]));
    migrate(db);
    return { db, before, counts };
  }

  test("migration 41 is additive (WAG-345 added 42, WAG-354 added 43, WAG-366 added 44, WAG-367 added 45, WAG-377 added 46 after it)", () => {
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.version).toBe(58);
    const { db } = migrated();
    expect(versionOf(db)).toBe(58);
    const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("option_sets")).toContain("items_json");
    expect(cols("replies")).toContain("item_answers_json");
  });

  test("every row of every table survives, and every old column is byte equal", () => {
    const { db, before, counts } = migrated();
    for (const [table, n] of counts) expect(count(db, table)).toBe(n);
    expect(counts.get("cases")).toBe(7);
    expect(counts.get("replies")).toBe(9);
    const after = snapshot(db, before.columns);
    for (const [table, rows] of before.rows) expect(after.rows.get(table)).toBe(rows);
  });

  test("the new columns are NULL in every existing row", () => {
    const { db } = migrated();
    expect(db.query(`SELECT COUNT(*) AS n FROM option_sets WHERE items_json IS NOT NULL`).get()).toEqual({ n: 0 });
    expect(db.query(`SELECT COUNT(*) AS n FROM replies WHERE item_answers_json IS NOT NULL`).get()).toEqual({ n: 0 });
  });

  test("the case select of main still runs on the migrated database", () => {
    const { db } = migrated();
    const sql = readFileSync(join(import.meta.dir, "fixtures", "case-select-main.sql"), "utf8");
    const rows = db.query(`${sql.trim()} ORDER BY c.id`).all() as { id: string; options_seq: number; plan_rounds: number; plan_answered: number }[];
    expect(rows.map((r) => r.id)).toEqual(["c_done", "c_many", "c_plan", "c_questions", "c_reply", "c_review", "c_update"]);
    expect(rows.find((r) => r.id === "c_plan")).toMatchObject({ options_seq: 2, plan_rounds: 3 });
  });

  test("a second migrate changes nothing", () => {
    const { db, before } = migrated();
    const once = snapshot(db, before.columns);
    migrate(db);
    expect(versionOf(db)).toBe(58);
    const twice = snapshot(db, before.columns);
    for (const [table, rows] of once.rows) expect(twice.rows.get(table)).toBe(rows);
  });

  test("getCase gives the items of every old shape, read from the old columns", () => {
    const { db } = migrated();
    const store = new Store(db, "/tmp/knock-test-41", new EventBus());
    const items = (id: string) => store.getCase(id)!.case.items;

    expect(items("c_many")).toEqual([
      { id: "main", select: "many", max: 2, options: [opt("a", "Cart"), opt("b", "Search"), opt("c", "Profile")], recommendation: ["a", "c"], recommendation_why: "Most used." },
    ]);
    // A review with no options: one reply item, the recommendation is the suggested reply.
    expect(items("c_review")).toEqual([{ id: "main", select: "reply", options: [], recommendation: "Looks fine to me", recommendation_why: "Short page." }]);
    expect(items("c_plan")).toEqual([{ id: "main", select: "one", options: XY, recommendation: "y", recommendation_why: "Clearer." }]);
    expect(items("c_questions").map((i) => i.id)).toEqual(["q1/p1", "q1/p2", "q2/p1"]);
    expect(items("c_questions")[0]).toMatchObject({ question: "Where does it sit?", select: "one", group: { id: "q1", title: "Card" } });
    expect(items("c_questions")[0]!.options.map((o) => o.label)).toEqual(["Under the avatar", "Beside the name"]);
    expect(items("c_questions")[1]!.options.map((o) => o.label)).toEqual(["Yes", "No", "Talk with the team"]);
    expect(items("c_questions")[2]!.group).toMatchObject({ id: "q2", now: ["A plain bar."] });
    expect(items("c_reply")).toEqual([{ id: "main", select: "reply", options: [], recommendation: "Call it Hive.", recommendation_why: "Short." }]);
    expect(items("c_update")).toEqual([{ id: "main", select: "one", options: XY, recommendation: "y", recommendation_why: "Clearer." }]);
    expect(items("c_done")).toEqual([{ id: "main", select: "reply", options: [] }]);

    // The old fields of a case are what they were.
    const c = store.getCase("c_many")!.case;
    expect(c).toMatchObject({ select: "many", max: 2, recommendations: ["a", "c"], kind: "question" });
    for (const id of ["c_many", "c_review", "c_plan", "c_questions", "c_reply", "c_update", "c_done"]) {
      expect(Case.safeParse(store.getCase(id)!.case).success).toBe(true);
    }
  });

  test("getCase lists the rounds of the old plan; a comments-only reply stamped by the old code does not answer", () => {
    const { db } = migrated();
    const store = new Store(db, "/tmp/knock-test-41", new EventBus());
    const detail = store.getCase("c_plan")!;
    expect(detail.rounds!.map((r) => [r.seq, r.stage?.name, r.question])).toEqual([
      [0, "questions", "Who is the first user?"],
      [1, "approaches", "Which approach?"],
      [2, "design", "Which layout?"],
    ]);
    expect(detail.rounds![0]!.items[0]).toMatchObject({ id: "main", options: AB, recommendation: "a" });
    expect(detail.rounds![1]!.items[0]).toMatchObject({ options: XY, recommendation: "x" });
    expect(detail.rounds!.map((r) => r.answer?.choice ?? null)).toEqual(["a", "x", null]);
    expect(detail.rounds!.map((r) => r.talk_count)).toEqual([0, 1, 0]);
    // plan_rounds stays for an old app, with the answer rule it always had.
    expect(detail.plan_rounds!.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(detail.plan_rounds![1]!.answer?.choice).toBe("x");
    // A case without a stage still lists its rounds.
    const update = store.getCase("c_update")!;
    expect(update.rounds!.map((r) => r.seq)).toEqual([0, 1]);
    expect(update.rounds![0]!.items[0]).toMatchObject({ options: AB, recommendation: "a" });
    expect(update.rounds![1]!.answer?.choice).toBe("y");
    expect(update.plan_rounds).toBeUndefined();
    const questions = store.getCase("c_questions")!;
    expect(questions.rounds![0]!.items).toHaveLength(3);
  });

  test("a reply reads its outcome; the old reply fields stay", () => {
    const { db } = migrated();
    const store = new Store(db, "/tmp/knock-test-41", new EventBus());
    const outcomes = (id: string) => store.getCase(id)!.replies.map((r) => [r.id, r.outcome, r.item_answers]);
    expect(outcomes("c_many")).toEqual([["r_many", "decide", undefined]]);
    // A decision with a message and no pick on a review that has no options: the reply item takes the text.
    expect(outcomes("c_review")).toEqual([["r_review", "decide", undefined]]);
    expect(outcomes("c_plan").map((r) => r[1])).toEqual(["decide", "talk", "decide"]);
    expect(store.getCase("c_many")!.replies[0]).toMatchObject({ choices: ["a", "c"], source: "telegram" });
    expect(store.getCase("c_update")!.replies.find((r) => r.id === "r_discuss")).toMatchObject({ outcome: "talk", leaning: ["x"] });
  });

  test("a later round on an old ask keeps the items of its first round", () => {
    const { db } = migrated();
    const store = new Store(db, "/tmp/knock-test-41", new EventBus());
    store.updateCase("c_questions", {
      case_id: "c_questions",
      message: "One more.",
      items: [{ id: "extra", select: "reply" }],
    } as never);
    const detail = store.getCase("c_questions")!;
    expect(detail.rounds!.map((r) => r.items.length)).toEqual([3, 1]);
    expect(detail.rounds![0]!.items.map((i) => i.id)).toEqual(["q1/p1", "q1/p2", "q2/p1"]);
    expect(detail.case.items.map((i) => i.id)).toEqual(["extra"]);
  });

  // Spec 3.4 step 8: every shortcut and its canonical twin store the same items and the same old columns.
  describe("dual write: a shortcut and its canonical twin", () => {
    type Json = Record<string, any>;
    function fresh(): { store: Store; taskId: string; home: string; cwd: string } {
      const home = tmpHome();
      dirs.push(home);
      const cwd = join(home, "work");
      mkdirSync(join(cwd, "proto"), { recursive: true });
      writeFileSync(join(cwd, "proto", "index.html"), "<h1>proto</h1>");
      const store = new Store(new Database(":memory:"), home, new EventBus());
      return { store, taskId: store.createTask({ name: "WAG-313", project: "waggle" }).id, home, cwd };
    }
    // The golden inputs send markdown as content and bundles as a folder; the store takes staged paths.
    function staged(input: Json, home: string, cwd: string): Json {
      let n = 0;
      const one = (a: Json): Artifact => {
        if (a.type === "markdown" && a.content !== undefined) {
          const path = join(cwd, `doc${++n}.md`);
          writeFileSync(path, a.content);
          return { ...stageIncoming(home, cwd, { type: "markdown", path }), ...(a.name ? { name: a.name } : {}) } as Artifact;
        }
        return { ...stageIncoming(home, cwd, a as Artifact), ...(a.name ? { name: a.name } : {}) } as Artifact;
      };
      const out = { ...input };
      if (out.artifact) out.artifact = one(out.artifact);
      if (out.artifacts) out.artifacts = out.artifacts.map(one);
      return out;
    }
    const compare = (c: Case) => ({
      items: c.items, kind: c.kind, options: c.options, select: c.select, max: c.max, recommendation: c.recommendation,
      recommendations: c.recommendations, recommendation_why: c.recommendation_why, questions: c.questions,
      plan: c.plan, has_artifact: c.has_artifact, artifact_kind: c.artifact_kind,
    });

    for (const [i, twin] of (golden.twins as { shortcut: string; canonical: Json }[]).entries()) {
      test(`${twin.shortcut} twin ${i}`, () => {
        const { store, taskId, home, cwd } = fresh();
        const shortcut = (golden.asks as Json[]).find((a) => a.name === twin.shortcut)!.input;
        const a = store.createCase(taskId, KnockAskInput.parse(staged(shortcut, home, cwd)));
        const b = store.createCase(taskId, KnockAskInput.parse(staged(twin.canonical, home, cwd)));
        expect(compare(b)).toEqual(compare(a));
        // And the same after a read back from the database.
        expect(compare(store.getCase(b.id)!.case)).toEqual(compare(store.getCase(a.id)!.case));
        expect(compare(store.getCase(a.id)!.case)).toEqual(compare(a));
      });
    }

    for (const ask of golden.asks as Json[]) {
      test(`${ask.name}: the case stores the golden items and the golden old columns`, () => {
        const { store, taskId, home, cwd } = fresh();
        const created = store.createCase(taskId, KnockAskInput.parse(staged(ask.input, home, cwd)));
        const read = store.getCase(created.id)!.case;
        for (const c of [created, read]) {
          expect(c.items).toEqual(ask.expect.items);
          expect(c.kind).toBe(ask.expect.legacy.kind);
          expect(c.options).toEqual(ask.expect.legacy.options);
          expect(c.select).toBe(ask.expect.legacy.select);
          expect(c.max).toBe(ask.expect.legacy.max);
          expect(c.recommendation).toBe(ask.expect.legacy.recommendation);
          expect(c.recommendation_why).toBe(ask.expect.legacy.recommendation_why);
          expect(c.recommendations).toEqual(ask.expect.legacy.recommendations);
          const questions = ask.expect.legacy.questions === "$input.questions" ? ask.input.questions : ask.expect.legacy.questions;
          expect(c.questions).toEqual(questions);
        }
        expect(Case.safeParse(read).success).toBe(true);
      });
    }
  });
});
