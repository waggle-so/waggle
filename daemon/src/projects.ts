import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

// WAG-260: the project page. A project is the tasks.project tag. This module reads the decision log
// from cases and replies, and keeps the operator's taste themes. The daemon is the only writer.

export const MAX_THEMES_PER_PROPOSAL = 8;
export const MAX_QUOTES = 3;
const MAX_THEME_TEXT = 200;
const MAX_QUOTE_TEXT = 160;
// More than this many new comments since the last proposal makes the themes stale.
export const STALE_COMMENT_COUNT = 20;
export const GUIDE_COMMENT_COUNT = 50;
export const GUIDE_DECISION_COUNT = 10;

export interface DecisionRecord {
  case_id: string;
  question: string;
  decided_at: string;
  pick: string;
  why: string;
  option_count: number;
  artifact_kind: string | null;
}

export interface ProjectStats {
  decisions: number;
  comments: number;
  last_decision_at: string | null;
}

export interface Theme {
  id: string;
  text: string;
  evidence_count: number;
  quotes: string[];
  enabled: boolean;
  proposed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThemeInput {
  text: string;
  evidence_count: number;
  quotes: string[];
}

export interface ProposeResult {
  added: Theme[];
  merged: Theme[];
}

interface OptionRow {
  id: string;
  label: string;
  title?: string;
}

interface ThemeRow {
  id: string;
  text: string;
  evidence_count: number;
  quotes_json: string;
  enabled: number;
  proposed_by: string | null;
  created_at: string;
  updated_at: string;
}

function toTheme(row: ThemeRow): Theme {
  return {
    id: row.id,
    text: row.text,
    evidence_count: row.evidence_count,
    quotes: JSON.parse(row.quotes_json) as string[],
    enabled: row.enabled === 1,
    proposed_by: row.proposed_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Case-insensitive exact or prefix match, either way round.
export function sameTheme(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === "" || y === "") return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// The comments of a project: pins on a reply and the free-text note of a decision reply. The time
// of a pin is its reply's time (else its capture's, else its case's).
const COMMENTS_SQL = `
    SELECT c.text AS text,
           COALESCE((SELECT created_at FROM replies WHERE id = c.reply_id),
                    (SELECT taken_at FROM captures WHERE id = c.capture_id),
                    cs.created_at) AS at
    FROM comments c JOIN cases cs ON cs.id = c.case_id JOIN tasks t ON t.id = cs.task_id
    WHERE t.project = ?1 AND TRIM(c.text) <> ''
    UNION ALL
    SELECT r.message AS text, r.created_at AS at
    FROM replies r JOIN cases cs ON cs.id = r.case_id JOIN tasks t ON t.id = cs.task_id
    WHERE t.project = ?1 AND r.intent = 'decision' AND r.state NOT IN ('failed', 'superseded')
      AND r.message IS NOT NULL AND TRIM(r.message) <> ''`;

// The newest decision reply of each case: one record per decided ask. A dismissed or withdrawn
// case, a "more detail" request and a failed or superseded reply are not decisions.
const DECISIONS_FROM = `
  FROM cases c
  JOIN tasks t ON t.id = c.task_id
  JOIN replies r ON r.id = (
    SELECT id FROM replies
    WHERE case_id = c.id AND intent = 'decision' AND state NOT IN ('failed', 'superseded')
      AND (choice IS NOT NULL OR choices_json IS NOT NULL)
    ORDER BY created_at DESC, rowid DESC LIMIT 1)
  WHERE t.project = ?1 AND c.withdrawn_at IS NULL AND c.dismissed_at IS NULL`;

export class ProjectLog {
  constructor(private readonly db: Database) {}

  decisions(project: string, limit = 50, offset = 0): { items: DecisionRecord[]; total: number } {
    const total = (
      this.db.query(`SELECT COUNT(*) AS n ${DECISIONS_FROM}`).get(project) as { n: number }
    ).n;
    const rows = this.db
      .query(
        `SELECT c.id AS case_id, c.title, c.options_json, c.recommendation_why, c.created_at AS case_at,
                r.id AS reply_id, r.choice, r.choices_json, r.message, r.created_at AS decided_at,
                (SELECT seq FROM reply_option_sets WHERE reply_id = r.id) AS seq,
                (SELECT kind FROM revisions WHERE case_id = c.id ORDER BY n DESC LIMIT 1) AS artifact_kind
         ${DECISIONS_FROM}
         ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?2 OFFSET ?3`,
      )
      .all(project, limit, offset) as {
      case_id: string;
      title: string;
      options_json: string;
      recommendation_why: string;
      reply_id: string;
      choice: string | null;
      choices_json: string | null;
      message: string | null;
      decided_at: string;
      seq: number | null;
      artifact_kind: string | null;
    }[];
    const items = rows.map((row) => {
      const set = this.optionSet(row.case_id, row.seq, row.options_json, row.recommendation_why);
      const ids = row.choices_json !== null ? (JSON.parse(row.choices_json) as string[]) : row.choice ? [row.choice] : [];
      const names = ids.map((id) => {
        const o = set.options.find((x) => x.id === id);
        return o ? (o.title ?? o.label) : id;
      });
      const note = row.message?.trim() ?? "";
      return {
        case_id: row.case_id,
        question: row.title,
        decided_at: row.decided_at,
        pick: names.join(", "),
        why: note !== "" ? note : set.why,
        option_count: set.options.length,
        artifact_kind: row.artifact_kind,
      };
    });
    return { items, total };
  }

  // The options the reply chose from: its set, else the newest (cases.options_json).
  private optionSet(
    caseId: string,
    seq: number | null,
    newestJson: string,
    newestWhy: string,
  ): { options: OptionRow[]; why: string } {
    if (seq !== null) {
      const row = this.db
        .query(`SELECT options_json, recommendation_why FROM option_sets WHERE case_id = ? AND seq = ?`)
        .get(caseId, seq) as { options_json: string; recommendation_why: string } | null;
      if (row) return { options: JSON.parse(row.options_json) as OptionRow[], why: row.recommendation_why };
    }
    return { options: JSON.parse(newestJson) as OptionRow[], why: newestWhy };
  }

  stats(project: string): ProjectStats {
    const d = this.db
      .query(`SELECT COUNT(*) AS n, MAX(r.created_at) AS last ${DECISIONS_FROM}`)
      .get(project) as { n: number; last: string | null };
    const comments = (this.db.query(`SELECT COUNT(*) AS n FROM (${COMMENTS_SQL})`).get(project) as { n: number }).n;
    return { decisions: d.n, comments, last_decision_at: d.last };
  }

  recentComments(project: string, limit: number): string[] {
    const rows = this.db
      .query(`SELECT text FROM (${COMMENTS_SQL}) ORDER BY at DESC LIMIT ?2`)
      .all(project, limit) as { text: string }[];
    return rows.map((r) => r.text.trim());
  }

  // True with no proposal yet, or with more than STALE_COMMENT_COUNT comments after the last one.
  themesStale(project: string): boolean {
    const last = this.prefs(project).last_proposed_at;
    if (last === null) return true;
    const n = (
      this.db.query(`SELECT COUNT(*) AS n FROM (${COMMENTS_SQL}) WHERE at > ?2`).get(project, last) as { n: number }
    ).n;
    return n > STALE_COMMENT_COUNT;
  }

  themes(project: string): Theme[] {
    const rows = this.db
      .query(`SELECT * FROM project_themes WHERE project = ? ORDER BY created_at, rowid`)
      .all(project) as ThemeRow[];
    return rows.map(toTheme);
  }

  // Adds new themes and merges the ones whose text matches an existing theme. A merge raises the
  // evidence count, adds new quotes (3 at most) and never changes on/off.
  propose(project: string, sessionId: string | null, inputs: ThemeInput[], now = new Date().toISOString()): ProposeResult {
    const added: Theme[] = [];
    const merged: Theme[] = [];
    this.db.transaction(() => {
      for (const input of inputs.slice(0, MAX_THEMES_PER_PROPOSAL)) {
        const text = clip(input.text, MAX_THEME_TEXT);
        if (text === "") continue;
        const quotes = input.quotes.map((q) => clip(q, MAX_QUOTE_TEXT)).filter((q) => q !== "");
        const existing = this.themes(project).find((t) => sameTheme(t.text, text));
        if (existing) {
          const all = [...existing.quotes];
          for (const q of quotes) if (!all.includes(q)) all.push(q);
          this.db
            .query(`UPDATE project_themes SET evidence_count = ?, quotes_json = ?, updated_at = ? WHERE id = ?`)
            .run(Math.max(existing.evidence_count, input.evidence_count), JSON.stringify(all.slice(0, MAX_QUOTES)), now, existing.id);
          merged.push(this.theme(existing.id)!);
        } else {
          const id = `th_${randomUUID().slice(0, 8)}`;
          this.db
            .query(
              `INSERT INTO project_themes (id, project, text, evidence_count, quotes_json, enabled, proposed_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            )
            .run(id, project, text, input.evidence_count, JSON.stringify(quotes.slice(0, MAX_QUOTES)), sessionId, now, now);
          added.push(this.theme(id)!);
        }
      }
      this.db
        .query(
          `INSERT INTO project_prefs (project, last_proposed_at) VALUES (?, ?)
           ON CONFLICT(project) DO UPDATE SET last_proposed_at = excluded.last_proposed_at`,
        )
        .run(project, now);
    })();
    return { added, merged };
  }

  theme(id: string): Theme | null {
    const row = this.db.query(`SELECT * FROM project_themes WHERE id = ?`).get(id) as ThemeRow | null;
    return row ? toTheme(row) : null;
  }

  setThemeEnabled(id: string, enabled: boolean): Theme | null {
    this.db
      .query(`UPDATE project_themes SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return this.theme(id);
  }

  prefs(project: string): { repo_records: boolean; last_proposed_at: string | null } {
    const row = this.db
      .query(`SELECT repo_records, last_proposed_at FROM project_prefs WHERE project = ?`)
      .get(project) as { repo_records: number; last_proposed_at: string | null } | null;
    return { repo_records: row?.repo_records === 1, last_proposed_at: row?.last_proposed_at ?? null };
  }

  setRepoRecords(project: string, on: boolean): boolean {
    this.db
      .query(
        `INSERT INTO project_prefs (project, repo_records) VALUES (?, ?)
         ON CONFLICT(project) DO UPDATE SET repo_records = excluded.repo_records`,
      )
      .run(project, on ? 1 : 0);
    return on;
  }

  // The project of a session, or null for an unknown session.
  sessionProject(sessionId: string): string | null {
    const row = this.db
      .query(`SELECT t.project AS project FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?`)
      .get(sessionId) as { project: string } | null;
    return row?.project ?? null;
  }
}
