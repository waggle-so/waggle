import type { Database } from "bun:sqlite";
import { type Item, type ItemAnswer, itemsOfRound, normalizeReply, replyOutcome } from "./protocol/items";

// WAG-414: the correction flag of a reply (Brain spec, Design 2). A reply is a correction when the person
// did not simply accept what the agent proposed. One pure rule set: the store calls it for a live reply and
// the migration calls it for the backfill, so both give the same answer.
//
// A correction is a deciding reply (Decide, never Keep talking) where at least one is true:
//   pick        a pick is not the recommended option (an item with no recommendation never counts here),
//   own         the person wrote their own answer (the text of a reply item),
//   changes     the person requested changes on a review, or left comments,
//   changed_mind  the person used "Change my mind" on an auto-decided ask.
export type CorrectionReason = "pick" | "own" | "changes" | "changed_mind";

export interface CorrectionInput {
  // The items of the round the reply answers.
  items: readonly Item[];
  // The stored kind of the ask.
  kind: "question" | "review";
  intent: "decision" | "more_detail" | "discuss";
  // True when the reply decides (replyOutcome says "decide"). A feedback reply only talks.
  decides: boolean;
  choice?: string;
  choices?: readonly string[];
  answers?: readonly unknown[];
  item_answers?: readonly ItemAnswer[];
  message?: string;
  // How many comments the reply carries.
  commentCount: number;
  // True when the case went through "Change my mind".
  mindChanged: boolean;
}

function recommended(item: Item): string[] {
  const r = item.recommendation;
  if (r === undefined) return [];
  return Array.isArray(r) ? [...r] : [r];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

// The first reason that makes the reply a correction, or null.
export function correctionReason(input: CorrectionInput): CorrectionReason | null {
  if (input.intent !== "decision" || !input.decides) return null;
  if (input.mindChanged) return "changed_mind";
  if (input.kind === "review" && (input.choice === "request_changes" || input.item_answers?.some((a) => a.choice === "request_changes"))) {
    return "changes";
  }
  if (input.commentCount > 0) return "changes";
  const answers = normalizeReply(input.items, {
    intent: "decision",
    message: input.message,
    choice: input.choice,
    choices: input.choices,
    answers: input.answers as never,
    item_answers: input.item_answers,
  });
  for (const answer of answers) {
    if (answer.text !== undefined) return "own";
    const item = input.items.find((i) => i.id === answer.item_id);
    if (item === undefined) continue;
    const rec = recommended(item);
    if (rec.length === 0) continue; // no recommendation: the pick cannot be a correction
    if (answer.choices !== undefined && !sameSet(answer.choices, rec)) return "pick";
    if (answer.choice !== undefined && !rec.includes(answer.choice)) return "pick";
  }
  return null;
}

interface StoredReplyRow {
  id: string;
  case_id: string;
  intent: "decision" | "more_detail" | "discuss";
  choice: string | null;
  choices_json: string | null;
  message: string | null;
  answers_json: string | null;
  item_answers_json: string | null;
  kind: "question" | "review";
  questions_json: string | null;
  mind_changed_at: string | null;
  ros_seq: number | null;
}

const STORED_REPLY_SQL = `SELECT r.id, r.case_id, r.intent, r.choice, r.choices_json, r.message, r.answers_json, r.item_answers_json,
       c.kind, c.questions_json, c.mind_changed_at,
       (SELECT ros.seq FROM reply_option_sets ros WHERE ros.reply_id = r.id) AS ros_seq
     FROM replies r JOIN cases c ON c.id = r.case_id`;

// The flag of a stored reply: 1 for a correction, 0 for a reply that decided and was not one, null for a reply
// that did not decide (Keep talking, more detail, a feedback note). It reads only the stored row, so the live
// write and the migration backfill give the same answer. A reply with no stored round gives null.
function flagOfRow(db: Database, row: StoredReplyRow, mindChanged: boolean): 0 | 1 | null {
  if (row.intent !== "decision") return null;
  const set = db
    .query(
      `SELECT seq, items_json, options_json, recommendation, recommendation_why, select_mode, max_choices, recommendations_json
       FROM option_sets WHERE case_id = ? ${row.ros_seq !== null ? "AND seq = ?" : ""} ORDER BY seq DESC LIMIT 1`,
    )
    .get(...(row.ros_seq !== null ? [row.case_id, row.ros_seq] : [row.case_id])) as Parameters<typeof itemsOfRound>[0] | null;
  if (!set) return null;
  const items = itemsOfRound(set, { questions_json: row.questions_json });
  const reply = {
    choice: row.choice ?? undefined,
    choices: row.choices_json !== null ? (JSON.parse(row.choices_json) as string[]) : undefined,
    message: row.message ?? undefined,
    answers: row.answers_json !== null ? (JSON.parse(row.answers_json) as never[]) : undefined,
    item_answers: row.item_answers_json !== null ? (JSON.parse(row.item_answers_json) as ItemAnswer[]) : undefined,
  };
  const decides = replyOutcome({ items }, { intent: "decision", ...reply }) === "decide";
  if (!decides) return null;
  const commentCount = (db.query(`SELECT COUNT(*) AS n FROM comments WHERE reply_id = ?`).get(row.id) as { n: number }).n;
  const reason = correctionReason({ items, kind: row.kind, intent: "decision", decides, ...reply, commentCount, mindChanged });
  return reason === null ? 0 : 1;
}

// The flag for one stored reply. Never throws: an unreadable row gives null.
export function storedReplyCorrection(db: Database, replyId: string): 0 | 1 | null {
  try {
    const row = db.query(`${STORED_REPLY_SQL} WHERE r.id = ?`).get(replyId) as StoredReplyRow | null;
    return row ? flagOfRow(db, row, row.mind_changed_at !== null) : null;
  } catch {
    return null;
  }
}

// Migration 59: sets replies.correction for the replies already stored, from the data they kept. A reply that
// used "Change my mind" cannot be found: the case lost its auto mark when the person changed their mind, so it
// counts as it would without that rule. Runs inside the migration's transaction. Returns the replies marked 1.
export function backfillCorrections(db: Database): number {
  const rows = db.query(`${STORED_REPLY_SQL} WHERE r.intent = 'decision' AND r.state NOT IN ('failed', 'superseded')`).all() as StoredReplyRow[];
  let marked = 0;
  for (const row of rows) {
    try {
      const flag = flagOfRow(db, row, false);
      if (flag === null) continue;
      db.query(`UPDATE replies SET correction = ? WHERE id = ?`).run(flag, row.id);
      marked += flag;
    } catch {
      // A row with unreadable JSON keeps null: the backfill never blocks a migration.
    }
  }
  return marked;
}

export interface CorrectionWeek {
  // ISO 8601 week, e.g. "2026-W46". Weeks run Monday to Sunday, in UTC.
  week: string;
  // The Monday of the week, as YYYY-MM-DD.
  starts: string;
  // Asks with at least one deciding reply in the week.
  asks: number;
  // Deciding replies in the week that are corrections.
  corrections: number;
  // corrections / asks, or null when the week has no asks.
  per_ask: number | null;
}

const DAY_MS = 86_400_000;

// The Monday (UTC midnight) of the ISO week that holds `date`.
function mondayOf(date: Date): Date {
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - day * DAY_MS);
}

// "2026-W46" for the week that starts on `monday`. The ISO year is the year of the week's Thursday.
export function isoWeekLabel(monday: Date): string {
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// WAG-414: corrections per ask, by ISO week, oldest first. The last `weeks` weeks up to the week of `now` are all
// listed, a week with no asks too (asks 0, per_ask null). `project` limits it to one project (the tasks.project
// tag); without it every project counts. A failed or superseded reply does not count, and nor does a reply that
// did not decide. The week of a reply is the week it was created.
export function correctionsByWeek(db: Database, opts: { project?: string; weeks: number; now?: Date }): CorrectionWeek[] {
  const first = new Date(mondayOf(opts.now ?? new Date()).getTime() - (opts.weeks - 1) * 7 * DAY_MS);
  const rows = db
    .query(
      `SELECT r.case_id, r.correction, r.created_at
       FROM replies r JOIN cases c ON c.id = r.case_id JOIN tasks t ON t.id = c.task_id
       WHERE r.intent = 'decision' AND r.correction IS NOT NULL AND r.state NOT IN ('failed', 'superseded')
         AND r.created_at >= ?1 ${opts.project !== undefined ? "AND t.project = ?2" : ""}`,
    )
    .all(...(opts.project !== undefined ? [first.toISOString(), opts.project] : [first.toISOString()])) as {
    case_id: string;
    correction: number;
    created_at: string;
  }[];
  const weeks = new Map<string, { asks: Set<string>; corrections: number }>();
  for (const row of rows) {
    const label = isoWeekLabel(mondayOf(new Date(row.created_at)));
    const entry = weeks.get(label) ?? { asks: new Set<string>(), corrections: 0 };
    entry.asks.add(row.case_id);
    entry.corrections += row.correction;
    weeks.set(label, entry);
  }
  const out: CorrectionWeek[] = [];
  for (let i = 0; i < opts.weeks; i++) {
    const monday = new Date(first.getTime() + i * 7 * DAY_MS);
    const label = isoWeekLabel(monday);
    const entry = weeks.get(label);
    const asks = entry?.asks.size ?? 0;
    const corrections = entry?.corrections ?? 0;
    out.push({
      week: label,
      starts: monday.toISOString().slice(0, 10),
      asks,
      corrections,
      per_ask: asks === 0 ? null : Math.round((corrections / asks) * 100) / 100,
    });
  }
  return out;
}
