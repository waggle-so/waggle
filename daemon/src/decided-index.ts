import type { Database } from "bun:sqlite";

// The Brain's recall (WAG-416). One FTS5 row for each decided ask: the question (title and need), the option
// labels, the pick and the why. The row carries its project, and a search always filters by it: a decision of
// one project never shows in another. The daemon is the only writer. No model, no network.

export interface DecidedMatch {
  case_id: string;
  question: string;
  pick: string;
  why: string;
  date: string;
}

// How many matches an ask can get back.
export const MAX_MATCHES = 3;

// A match is strong when at least this share of the ask's title words are in the decided ask (its question, need
// and option labels), and at least MIN_SHARED_TERMS words are. Set from the fixture in test/decided-index.test.ts:
// rewordings of a decided ask scored 1.0, and asks that only share a topic word scored 0.33 or less. 0.6 sits in the empty gap.
export const STRONG_COVERAGE = 0.6;
export const MIN_SHARED_TERMS = 2;

// FTS5 is a table kind of SQLite. Created by migration 61 and by a test on a bare database.
export const DECIDED_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS decided_asks USING fts5(
  case_id UNINDEXED, project UNINDEXED, title, need, options, pick, why, decided_at UNINDEXED,
  tokenize = 'porter unicode61'
)`;

interface CaseRowForIndex {
  id: string;
  kind: string;
  title: string;
  need: string;
  project: string;
  withdrawn_at: string | null;
  dismissed_at: string | null;
  auto_at: string | null;
}
interface ReplyRowForIndex {
  choice: string | null;
  choices_json: string | null;
  message: string | null;
  answers_json: string | null;
  item_answers_json: string | null;
  created_at: string;
}
interface OptionLike {
  id: string;
  label: string;
  title?: string;
}

function safeParse<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// The options of a case: every option set (the ask's own and each update's) and every item. Later ones win for an id.
function optionsOfCase(db: Database, caseId: string): OptionLike[] {
  const sets = db
    .query(`SELECT options_json, items_json FROM option_sets WHERE case_id = ? ORDER BY seq`)
    .all(caseId) as { options_json: string | null; items_json: string | null }[];
  const byId = new Map<string, OptionLike>();
  const add = (o: OptionLike | undefined) => {
    if (o && typeof o.id === "string" && typeof o.label === "string") byId.set(o.id, o);
  };
  for (const set of sets) {
    for (const o of safeParse<OptionLike[]>(set.options_json, [])) add(o);
    for (const item of safeParse<{ options?: OptionLike[] }[]>(set.items_json, [])) {
      for (const o of item.options ?? []) add(o);
    }
  }
  return [...byId.values()];
}

// The pick and the why of the newest reply that decided the ask. Null when no reply did.
function decisionOf(reply: ReplyRowForIndex, options: OptionLike[]): { pick: string; why: string } | null {
  const label = (id: string) => options.find((o) => o.id === id)?.label ?? id;
  const picks: string[] = [];
  const notes: string[] = [];
  const itemAnswers = safeParse<{ choice?: string; choices?: string[]; text?: string; note?: string }[]>(reply.item_answers_json, []);
  if (itemAnswers.length > 0) {
    for (const a of itemAnswers) {
      if (a.choice !== undefined) picks.push(label(a.choice));
      for (const id of a.choices ?? []) picks.push(label(id));
      if (a.text) picks.push(a.text);
      if (a.note) notes.push(a.note);
    }
  } else {
    for (const id of safeParse<string[]>(reply.choices_json, [])) picks.push(label(id));
    if (reply.choice !== null) picks.push(label(reply.choice));
    for (const a of safeParse<{ choice?: string; note?: string }[]>(reply.answers_json, [])) {
      if (a.choice) picks.push(a.choice);
      if (a.note) notes.push(a.note);
    }
  }
  if (picks.length === 0) return null;
  const message = (reply.message ?? "").trim();
  if (message !== "") notes.unshift(message);
  return { pick: picks.join("; "), why: notes.join(" ") };
}

// Makes the index row of one case match the case now: written when a human decision exists, removed when none
// does (a withdrawn ask, a review, an ask only a rule decided). Safe to call after any change to a case or its replies.
export function reindexDecidedCase(db: Database, caseId: string): void {
  db.query(`DELETE FROM decided_asks WHERE case_id = ?`).run(caseId);
  const row = db
    .query(
      `SELECT c.id, c.kind, c.title, c.need, t.project, c.withdrawn_at, c.dismissed_at, c.auto_at
       FROM cases c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?`,
    )
    .get(caseId) as CaseRowForIndex | undefined;
  if (!row || row.kind !== "question" || row.withdrawn_at !== null || row.dismissed_at !== null) return;
  const replies = db
    .query(
      `SELECT choice, choices_json, message, answers_json, item_answers_json, created_at FROM replies
       WHERE case_id = ? AND intent = 'decision' AND state != 'superseded'
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(caseId) as ReplyRowForIndex[];
  const options = optionsOfCase(db, caseId);
  // The newest reply that picked something. A later reply that only talks does not undo the decision.
  let reply: ReplyRowForIndex | undefined;
  let decision: { pick: string; why: string } | null = null;
  for (const candidate of replies) {
    decision = decisionOf(candidate, options);
    if (decision) {
      reply = candidate;
      break;
    }
  }
  if (!reply || !decision) return;
  db.query(
    `INSERT INTO decided_asks (case_id, project, title, need, options, pick, why, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.project, row.title, row.need, options.map((o) => o.label).join("\n"), decision.pick, decision.why, reply.created_at);
}

// Fills the index from every case that already has a decision. Migration 61 runs it once.
export function backfillDecidedAsks(db: Database): void {
  const ids = db
    .query(`SELECT DISTINCT case_id FROM replies WHERE intent = 'decision' AND state != 'superseded'`)
    .all() as { case_id: string }[];
  for (const { case_id } of ids) reindexDecidedCase(db, case_id);
}

const STOPWORDS = new Set(
  ("the and for with that this from have has had are was were will would should could can not but you your our their its " +
    "into onto than then them they what when where which who why how use used using should does did done any all one two new " +
    "per via out off too very just more most some such only own same also about after before between over under again " +
    "need want like make made get got let set add").split(" "),
);

// The significant words of a text: lower case, letters and digits, three letters or more, no stop words, a light
// stem (plural and -ing/-ed). The FTS5 tokenizer stems on its own; this stem only keeps the strong-match test steady.
export function significantTerms(text: string, cap = 40): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    let word = raw;
    if (word.length > 5 && word.endsWith("ing")) word = word.slice(0, -3);
    else if (word.length > 4 && word.endsWith("ed")) word = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith("es")) word = word.slice(0, -2);
    else if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    seen.add(word);
    if (seen.size >= cap) break;
  }
  return [...seen];
}

export interface AskTextForSearch {
  title: string;
  need: string;
  optionLabels: string[];
}

// Up to MAX_MATCHES strong matches in one project, best first. Never reads another project. Throws on a database error:
// the caller lets the ask through.
export function searchDecidedAsks(db: Database, project: string, ask: AskTextForSearch): DecidedMatch[] {
  const titleTerms = significantTerms(ask.title);
  if (titleTerms.length < MIN_SHARED_TERMS) return [];
  const queryTerms = significantTerms(`${ask.title} ${ask.need} ${ask.optionLabels.join(" ")}`, 40);
  const match = queryTerms.map((t) => `"${t}"`).join(" OR ");
  const rows = db
    .query(
      `SELECT case_id, title, need, options, pick, why, decided_at FROM decided_asks
       WHERE decided_asks MATCH ? AND project = ? ORDER BY bm25(decided_asks, 0, 0, 5, 2, 2, 1, 1, 0) LIMIT 25`,
    )
    .all(match, project) as { case_id: string; title: string; need: string; options: string; pick: string; why: string; decided_at: string }[];
  const scored = rows.map((row, rank) => {
    const have = new Set(significantTerms(`${row.title} ${row.need} ${row.options}`, 200));
    const shared = titleTerms.filter((t) => have.has(t)).length;
    return { row, shared, score: shared / titleTerms.length, rank };
  });
  return scored
    .filter((s) => s.shared >= MIN_SHARED_TERMS && s.score >= STRONG_COVERAGE)
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .slice(0, MAX_MATCHES)
    .map(({ row }) => ({ case_id: row.case_id, question: row.title, pick: row.pick, why: row.why, date: row.decided_at }));
}
