import type { Database } from "bun:sqlite";
import { backfillDecidedAsks, DECIDED_TABLE_SQL } from "./decided-index";

// Versioned migrations (docs/protocol-mvp.md, KNOCK-02 acceptance: "Migrations
// are versioned"). The applied version lives in PRAGMA user_version. Never edit
// an applied migration; add a new one.
//
// Migration 1 creates the full MVP schema. `options` and `rect` live as JSON
// text inside their rows because the schema lists no `options`/`rect` table.
export const MIGRATIONS: {
  version: number;
  sql: string;
  up?: (db: Database) => void;
  recreatesReferencedTable?: boolean;
}[] = [
  {
    version: 1,
    sql: `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  cwd TEXT NOT NULL,
  branch TEXT,
  pid INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'disconnected', 'ended')),
  connected_at TEXT NOT NULL
);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('question', 'review')),
  title TEXT NOT NULL,
  need TEXT NOT NULL,
  why TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  recommendation_why TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('needs_you', 'waiting_on_agent', 'resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  n INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, n)
);

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  revision INTEGER NOT NULL,
  reply_id TEXT REFERENCES replies(id),
  png_base64 TEXT NOT NULL,
  annotated_png_base64 TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  capture_id TEXT NOT NULL REFERENCES captures(id),
  n INTEGER NOT NULL,
  rect_json TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE replies (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  choice TEXT,
  message TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'failed')),
  created_at TEXT NOT NULL
);

-- A message in a case conversation: the agent's ask and updates, and the
-- human's replies. KNOCK-02 stores it so cases.get can return the protocol's
-- CaseDetail.messages; KNOCK-04 and KNOCK-05 write it.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  role TEXT NOT NULL CHECK (role IN ('agent', 'human')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The append-only event log. seq is AUTOINCREMENT so it is monotonic and never
-- reused. The daemon is the only writer.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  case_id TEXT,
  reply_id TEXT,
  session_id TEXT,
  at TEXT NOT NULL
);

CREATE INDEX idx_cases_task ON cases(task_id);
CREATE INDEX idx_cases_status ON cases(status);
CREATE INDEX idx_revisions_case ON revisions(case_id);
CREATE INDEX idx_captures_case ON captures(case_id);
CREATE INDEX idx_comments_case ON comments(case_id);
CREATE INDEX idx_comments_capture ON comments(capture_id);
CREATE INDEX idx_replies_case ON replies(case_id);
CREATE INDEX idx_messages_case ON messages(case_id);
CREATE INDEX idx_sessions_task ON sessions(task_id);
`,
  },
  {
    version: 2,
    sql: `
-- Artifact staging (KNOCK-03). Each revision records what it staged:
-- kind + sha256 + ext for a screenshot (blobs/<sha256>.<ext>), and entry for
-- an html_bundle (root is bundles/<case_id>/r<n>/ and needs no column).
ALTER TABLE revisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'screenshot'
  CHECK (kind IN ('screenshot', 'html_bundle'));
ALTER TABLE revisions ADD COLUMN sha256 TEXT;
ALTER TABLE revisions ADD COLUMN ext TEXT;
ALTER TABLE revisions ADD COLUMN entry TEXT;
`,
  },
  {
    version: 3,
    sql: `
-- Reply failure reason (KNOCK-05). Set when a queued reply fails because its
-- owning session ended; only 'session_unreachable' for now.
ALTER TABLE replies ADD COLUMN reason TEXT;
`,
  },
  {
    version: 4,
    sql: `
-- Case denormalization (KNOCK-16). cases.list and cases.get now carry the
-- task's name, project and (when the branch was a Linear key) that key, plus
-- the kind of the latest staged artifact. The app no longer needs one
-- cases.get and artifact.path per queue row. The key is null for a task
-- named from a plain branch or the cwd folder.
ALTER TABLE tasks ADD COLUMN linear_key TEXT;
`,
  },
  {
    version: 5,
    sql: `
-- Private usage log (KNOCK-19). Content-free: every row holds only a closed
-- event enum, the UTC hour it happened, optional numeric/enum fields, and a
-- hashed project tag. No titles, text, paths or project names are ever
-- stored here.
CREATE TABLE usage (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered',
    'reply_failed', 'reply_retried', 'ask_pending_timeout', 'session_started',
    'case_opened', 'comment_mode_started'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN ('notification', 'menu_bar', 'queue')),
  project_h TEXT
);
CREATE INDEX idx_usage_hour ON usage(hour);
`,
  },
  {
    version: 6,
    sql: `
-- Codex as a second connector (KNOCK-20). The shim resolves KNOCK_RUNTIME to
-- 'claude' or 'codex' and sends it in session.hello; unknown or missing
-- values (older registrations) default to 'claude', so both columns default
-- to it too. cases.runtime is denormalized from the creating session so a
-- queue row needs no extra call, the same way task_name/project/linear_key
-- already are.
ALTER TABLE sessions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude'
  CHECK (runtime IN ('claude', 'codex'));
ALTER TABLE cases ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude'
  CHECK (runtime IN ('claude', 'codex'));
`,
  },
  {
    version: 7,
    sql: `
-- Dismiss (HAIL-32). case.dismiss sets dismissed_at and moves the case to
-- resolved; case.restore clears dismissed_at and puts the case back in the
-- status it held right before the dismiss, which status_before_dismiss
-- remembers (a dismiss from waiting_on_agent must restore to
-- waiting_on_agent, not always needs_you).
ALTER TABLE cases ADD COLUMN dismissed_at TEXT;
ALTER TABLE cases ADD COLUMN status_before_dismiss TEXT
  CHECK (status_before_dismiss IN ('needs_you', 'waiting_on_agent', 'resolved'));
`,
  },
  {
    version: 8,
    sql: `
-- reply.replace (HAIL-34): a queued reply's answer can be changed before the
-- agent picks it up. replaced_at is set on every replace and stays NULL for a
-- reply that has never been changed; created_at is never touched by a
-- replace, so it keeps meaning "first submitted at" for the "took" duration.
ALTER TABLE replies ADD COLUMN replaced_at TEXT;
`,
  },
  {
    version: 9,
    sql: `
-- Markdown artifact (HAIL-33): a third staged artifact kind, alongside
-- screenshot and html_bundle, staged the same way as a screenshot
-- (blobs/<sha256>.md). SQLite CHECK constraints cannot be altered in place,
-- so both tables that fix the two-value enum are recreated with the widened
-- constraint; their data and indexes are preserved.
CREATE TABLE revisions_new (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  n INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'screenshot'
    CHECK (kind IN ('screenshot', 'html_bundle', 'markdown')),
  sha256 TEXT,
  ext TEXT,
  entry TEXT,
  UNIQUE (case_id, n)
);
INSERT INTO revisions_new (id, case_id, n, created_at, kind, sha256, ext, entry)
  SELECT id, case_id, n, created_at, kind, sha256, ext, entry FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_new RENAME TO revisions;
CREATE INDEX idx_revisions_case ON revisions(case_id);

CREATE TABLE usage_new (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered',
    'reply_failed', 'reply_retried', 'ask_pending_timeout', 'session_started',
    'case_opened', 'comment_mode_started'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle', 'markdown')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN ('notification', 'menu_bar', 'queue')),
  project_h TEXT
);
INSERT INTO usage_new (event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h)
  SELECT event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h FROM usage;
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage(hour);
`,
  },
  {
    version: 10,
    sql: `
-- reply.submit intent (HAIL-33): "decision" (default, existing behaviour) or
-- "more_detail" (the human wants an explanation before deciding).
ALTER TABLE replies ADD COLUMN intent TEXT NOT NULL DEFAULT 'decision'
  CHECK (intent IN ('decision', 'more_detail'));
`,
  },
  {
    version: 11,
    sql: `
-- Linked follow-up asks (HAIL-33 amendment). waggle_ask's optional "follows"
-- names the earlier case this one follows up on; the daemon validates it
-- before the case is created (exists, same task). Nullable: most cases follow
-- nothing.
ALTER TABLE cases ADD COLUMN follows_case_id TEXT REFERENCES cases(id);
`,
  },
  {
    version: 12,
    sql: `
-- Screenshots artifact (HAIL-40): a fourth staged artifact kind, 2 to 12
-- images the operator flips through and comments on one at a time. A revision
-- of this kind stores no single sha256/ext/entry; items_json holds its
-- ordered list instead, the same JSON-column convention options_json and
-- rect_json already use for other ordered/structured data. As with the
-- markdown widening (migration 9), SQLite cannot alter a CHECK constraint in
-- place, so revisions and usage are recreated with the widened constraint;
-- their data and indexes are preserved.
CREATE TABLE revisions_new (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  n INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'screenshot'
    CHECK (kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots')),
  sha256 TEXT,
  ext TEXT,
  entry TEXT,
  items_json TEXT,
  UNIQUE (case_id, n)
);
INSERT INTO revisions_new (id, case_id, n, created_at, kind, sha256, ext, entry, items_json)
  SELECT id, case_id, n, created_at, kind, sha256, ext, entry, NULL FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_new RENAME TO revisions;
CREATE INDEX idx_revisions_case ON revisions(case_id);

CREATE TABLE usage_new (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered',
    'reply_failed', 'reply_retried', 'ask_pending_timeout', 'session_started',
    'case_opened', 'comment_mode_started'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN ('notification', 'menu_bar', 'queue')),
  project_h TEXT
);
INSERT INTO usage_new (event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h)
  SELECT event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h FROM usage;
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage(hour);
`,
  },
  {
    version: 13,
    // Replace an ask (HAIL-44). waggle_ask's optional "replaces" withdraws the
    // named case in the same write: replaces_case_id records the link
    // (nullable, most cases replace nothing), withdrawn_at marks the
    // withdrawal the same way dismissed_at marks a dismiss, and a queued
    // reply on the withdrawn case is marked "superseded" (never delivered) -
    // a fourth replies.state value, so (as with the markdown/screenshots
    // widenings, migrations 9 and 12) the table is recreated with the widened
    // CHECK constraint; its data and indexes are preserved. Unlike those two,
    // `captures.reply_id REFERENCES replies(id)`, and SQLite refuses to drop
    // a table another table's foreign key still points at while
    // `foreign_keys` is on (confirmed empirically: the same DROP+RENAME
    // migrations 9/12 use fails with "FOREIGN KEY constraint failed" here) -
    // recreatesReferencedTable tells migrate() to toggle the pragma off for
    // this migration only, since it cannot be toggled inside a transaction.
    recreatesReferencedTable: true,
    sql: `
ALTER TABLE cases ADD COLUMN replaces_case_id TEXT REFERENCES cases(id);
ALTER TABLE cases ADD COLUMN withdrawn_at TEXT;

CREATE TABLE replies_new (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  choice TEXT,
  message TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'failed', 'superseded')),
  created_at TEXT NOT NULL,
  reason TEXT,
  replaced_at TEXT,
  intent TEXT NOT NULL DEFAULT 'decision' CHECK (intent IN ('decision', 'more_detail'))
);
INSERT INTO replies_new
  (id, case_id, idempotency_key, choice, message, state, created_at, reason, replaced_at, intent)
  SELECT id, case_id, idempotency_key, choice, message, state, created_at, reason, replaced_at, intent
  FROM replies;
DROP TABLE replies;
ALTER TABLE replies_new RENAME TO replies;
CREATE INDEX idx_replies_case ON replies(case_id);
`,
  },
  {
    version: 14,
    sql: `
-- Live session visibility (HAIL-46). sessions.list and \`waggle doctor\` need
-- to show when a session was last active, not just when it first connected.
-- Backfilled from connected_at for existing rows; the daemon bumps it on
-- every session state transition and on every session RPC call from an
-- already-live session (session.hello, case.create, case.wait, case.update,
-- reply.ack).
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
UPDATE sessions SET last_seen_at = connected_at WHERE last_seen_at IS NULL;
`,
  },
  {
    version: 15,
    sql: `
-- html_bundle preview and viewport (HAIL-49). An html_bundle revision may
-- declare the size Waggle renders it at (viewport_width/height, e.g. a phone
-- at 390x844) and/or a preview file inside the bundle purpose-built for the
-- case pane's card (preview, a path relative to the bundle root - the same
-- shape as the existing entry column). Both NULL for every other kind and for
-- an html_bundle that declares neither; the app falls back to rendering entry
-- at the card's own live size (sizing amended HAIL-49 A1). Plain nullable
-- columns, not a widened CHECK constraint: no existing enum changes shape.
ALTER TABLE revisions ADD COLUMN viewport_width INTEGER;
ALTER TABLE revisions ADD COLUMN viewport_height INTEGER;
ALTER TABLE revisions ADD COLUMN preview TEXT;
`,
  },
  {
    version: 16,
    sql: `
-- Pickup time (HAIL-64). replies.delivered_at is when the reply was marked
-- delivered (the agent picked it up). The app moves an answered ask out of
-- "Waiting on agent" 10 minutes after this, so the time must survive a
-- relaunch. Backfilled from the reply.state_changed event log where one
-- exists, else from created_at; NULL for a reply that is not delivered.
ALTER TABLE replies ADD COLUMN delivered_at TEXT;
UPDATE replies SET delivered_at = COALESCE(
  (SELECT MAX(e.at) FROM events e WHERE e.type = 'reply.state_changed' AND e.reply_id = replies.id),
  created_at
) WHERE state = 'delivered';
`,
  },
  {
    version: 17,
    sql: `
-- The nudge (HAIL-76). sessions.can_nudge is what the shim said in session.hello:
-- it can post into the agent's session inbox socket. replies.nudge_count is how
-- many nudges the daemon sent for that reply; the app may send at most 3.
ALTER TABLE sessions ADD COLUMN can_nudge INTEGER NOT NULL DEFAULT 0;
ALTER TABLE replies ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 18,
    sql: `
-- What people click (HAIL-83). The usage table learns sixteen app events, six
-- more source values, an after_s bucket (seconds since the ask was opened, in
-- four buckets) and a variant (zoom level or comment shape). Closed enums only.
-- SQLite cannot alter a CHECK constraint in place, so the table is recreated
-- (as in migrations 9 and 12); its data and index are preserved.
CREATE TABLE usage_new (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered',
    'reply_failed', 'reply_retried', 'ask_pending_timeout', 'session_started',
    'case_opened', 'comment_mode_started',
    'artifact_opened_full', 'review_opened', 'preview_interacted',
    'option_picked', 'recommendation_accepted', 'reply_typed',
    'ask_more_detail_opened', 'change_answer_started', 'go_back_clicked',
    'sessions_panel_opened', 'session_detail_opened', 'screenshot_zoom_changed',
    'screenshot_set_view_opened', 'comment_added', 'nudge_clicked',
    'copy_prompt_clicked'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN (
    'notification', 'menu_bar', 'queue', 'sessions_panel', 'auto_advance',
    'keyboard', 'click', 'number_key', 'button', 'shortcut'
  )),
  project_h TEXT,
  after_s TEXT CHECK (after_s IN ('0-2', '3-10', '11-60', '60+')),
  variant TEXT CHECK (variant IN ('fit', '100', 'zoom', 'point', 'region'))
);
INSERT INTO usage_new (event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h)
  SELECT event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h FROM usage;
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage(hour);
`,
  },
  {
    version: 19,
    sql: `
-- Operator settings the daemon owns (HAIL-100). One row per key. The only key
-- today is artifactPreset ('quick' | 'visual' | 'rich'); the daemon validates
-- the value on write, and an unset key reads as its default.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    version: 20,
    sql: `
-- Option sets per case (HAIL-108). Set 0 is the ask's own options; each waggle_update
-- that sends options adds the next set. cases.options_json / recommendation always
-- hold the newest set. reply_option_sets records the set a reply's choice came
-- from (no row for a reply without a choice, and for replies from before this
-- migration, which read as the newest set).
CREATE TABLE IF NOT EXISTS option_sets (
  case_id TEXT NOT NULL REFERENCES cases(id),
  seq INTEGER NOT NULL,
  options_json TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  recommendation_why TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, seq)
);
INSERT OR IGNORE INTO option_sets (case_id, seq, options_json, recommendation, recommendation_why, created_at)
  SELECT id, 0, options_json, recommendation, recommendation_why, created_at FROM cases;
CREATE TABLE IF NOT EXISTS reply_option_sets (
  reply_id TEXT PRIMARY KEY REFERENCES replies(id),
  seq INTEGER NOT NULL
);
`,
  },
  {
    version: 21,
    // Multi-select (HAIL-123). select_mode is 'one' or 'many'; max_choices caps the ticks (NULL: no
    // limit); recommendations_json is the recommended id list (NULL: just [recommendation]). cases
    // mirrors the newest option set, as for options_json. replies.choices_json holds a 'many'
    // reply. ALTER TABLE has no IF NOT EXISTS, so each column is added only when it is missing.
    sql: "",
    up: (db) => {
      const add = (table: string, column: string, ddl: string): void => {
        const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      };
      for (const table of ["cases", "option_sets"]) {
        add(table, "select_mode", "TEXT NOT NULL DEFAULT 'one'");
        add(table, "max_choices", "INTEGER");
        add(table, "recommendations_json", "TEXT");
      }
      add("replies", "choices_json", "TEXT");
    },
  },
  {
    version: 22,
    // The format a "more detail" reply asks for (HAIL-139): 'eli5' | 'diagram' | 'page'.
    // Null for a decision reply, or a detail request from before this field existed.
    // ALTER TABLE has no IF NOT EXISTS, so the column is added only when it is missing.
    sql: "",
    up: (db) => {
      const cols = db.query(`PRAGMA table_info(replies)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "format")) {
        db.exec(`ALTER TABLE replies ADD COLUMN format TEXT CHECK (format IN ('eli5', 'diagram', 'page'))`);
      }
    },
  },
  {
    version: 23,
    sql: `
-- Diagram artifact (HAIL-141): a fifth staged artifact kind, one .mmd or .svg
-- file the app renders offline with zoom, pan and comments. As with the
-- markdown and screenshots widenings (migrations 9 and 12), SQLite cannot
-- alter a CHECK constraint in place, so revisions and usage are recreated with
-- the widened constraint; their data and indexes are preserved.
CREATE TABLE revisions_new (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  n INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'screenshot'
    CHECK (kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots', 'diagram')),
  sha256 TEXT,
  ext TEXT,
  entry TEXT,
  items_json TEXT,
  viewport_width INTEGER,
  viewport_height INTEGER,
  preview TEXT,
  UNIQUE (case_id, n)
);
INSERT INTO revisions_new (id, case_id, n, created_at, kind, sha256, ext, entry, items_json, viewport_width, viewport_height, preview)
  SELECT id, case_id, n, created_at, kind, sha256, ext, entry, items_json, viewport_width, viewport_height, preview FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_new RENAME TO revisions;
CREATE INDEX idx_revisions_case ON revisions(case_id);

CREATE TABLE usage_new (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered',
    'reply_failed', 'reply_retried', 'ask_pending_timeout', 'session_started',
    'case_opened', 'comment_mode_started',
    'artifact_opened_full', 'review_opened', 'preview_interacted',
    'option_picked', 'recommendation_accepted', 'reply_typed',
    'ask_more_detail_opened', 'change_answer_started', 'go_back_clicked',
    'sessions_panel_opened', 'session_detail_opened', 'screenshot_zoom_changed',
    'screenshot_set_view_opened', 'comment_added', 'nudge_clicked',
    'copy_prompt_clicked'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots', 'diagram')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN (
    'notification', 'menu_bar', 'queue', 'sessions_panel', 'auto_advance',
    'keyboard', 'click', 'number_key', 'button', 'shortcut'
  )),
  project_h TEXT,
  after_s TEXT CHECK (after_s IN ('0-2', '3-10', '11-60', '60+')),
  variant TEXT CHECK (variant IN ('fit', '100', 'zoom', 'point', 'region'))
);
INSERT INTO usage_new (event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant)
  SELECT event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant FROM usage;
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage(hour);
`,
  },
  {
    version: 24,
    // Chat connectors (HAIL-144). replies.source records where a reply came from: 'mac', 'telegram'
    // or 'slack'. connector_messages remembers the chat message sent for a case, so a later reply
    // can edit it and a Telegram reply to it finds its case. No secret is stored here.
    // ALTER TABLE has no IF NOT EXISTS, so the column is added only when it is missing.
    sql: "",
    up: (db) => {
      const cols = db.query(`PRAGMA table_info(replies)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "source")) {
        db.exec(
          `ALTER TABLE replies ADD COLUMN source TEXT NOT NULL DEFAULT 'mac' CHECK (source IN ('mac', 'telegram', 'slack'))`,
        );
      }
      db.exec(`
CREATE TABLE IF NOT EXISTS connector_messages (
  connector TEXT NOT NULL,
  case_id TEXT NOT NULL REFERENCES cases(id),
  msg_key TEXT NOT NULL,
  ref_json TEXT NOT NULL,
  outcome TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector, case_id),
  UNIQUE (connector, msg_key)
);
`);
    },
  },
  {
    version: 25,
    // Legacy rows may point at a deleted capture, so foreign keys are off while the table is copied.
    recreatesReferencedTable: true,
    // Text comments (HAIL-150). A comment may anchor to a range of a markdown revision instead of
    // a capture, so capture_id and rect_json become nullable, anchor_json is added, and reply_id
    // lets the reply find comments that have no capture. Nothing else references comments, so the
    // table is recreated; existing rows keep their data and take reply_id from their capture.
    sql: `
CREATE TABLE comments_new (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  capture_id TEXT REFERENCES captures(id),
  reply_id TEXT REFERENCES replies(id),
  n INTEGER NOT NULL,
  rect_json TEXT,
  anchor_json TEXT,
  text TEXT NOT NULL
);
INSERT INTO comments_new (id, case_id, capture_id, reply_id, n, rect_json, anchor_json, text)
  SELECT c.id, c.case_id, c.capture_id, cap.reply_id, c.n, c.rect_json, NULL, c.text
  FROM comments c LEFT JOIN captures cap ON cap.id = c.capture_id;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
CREATE INDEX idx_comments_case ON comments(case_id);
CREATE INDEX idx_comments_capture ON comments(capture_id);
CREATE INDEX idx_comments_reply ON comments(reply_id);
`,
  },
  {
    version: 26,
    // A closing update (HAIL-152). done_at is set by a waggle_update with done: true: the agent has
    // finished and no answer will come. ALTER TABLE has no IF NOT EXISTS, so the column is added only
    // when it is missing.
    sql: "",
    up: (db) => {
      const cols = db.query(`PRAGMA table_info(cases)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "done_at")) db.exec(`ALTER TABLE cases ADD COLUMN done_at TEXT`);
    },
  },
  {
    version: 27,
    // Plan asks (HAIL-151). A plan round is an option set with a stage: option_sets.stage_json holds
    // the round's stage (NULL for a plain ask) and option_sets.question the agent message that opened
    // it. replies.plan_round is the option set seq a decision reply answered (NULL for a plain ask).
    // cases.kind stays 'question': a plan ask is a question with rounds. ALTER TABLE has no IF NOT
    // EXISTS, so each column is added only when it is missing.
    sql: "",
    up: (db) => {
      const has = (table: string, col: string): boolean =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
      if (!has("option_sets", "stage_json")) db.exec(`ALTER TABLE option_sets ADD COLUMN stage_json TEXT`);
      if (!has("option_sets", "question")) db.exec(`ALTER TABLE option_sets ADD COLUMN question TEXT`);
      if (!has("replies", "plan_round")) db.exec(`ALTER TABLE replies ADD COLUMN plan_round INTEGER`);
    },
  },
  {
    version: 28,
    // Round artifacts (HAIL-156). option_sets.revision is the revision a plan round shows: the one the
    // round sent, else the newest one that existed when the round began (NULL when there was none).
    // option_sets.own_artifact is 1 when the round itself sent an artifact.
    sql: "",
    up: (db) => {
      const has = (col: string): boolean =>
        (db.query(`PRAGMA table_info(option_sets)`).all() as { name: string }[]).some((c) => c.name === col);
      if (!has("revision")) db.exec(`ALTER TABLE option_sets ADD COLUMN revision INTEGER`);
      if (!has("own_artifact")) db.exec(`ALTER TABLE option_sets ADD COLUMN own_artifact INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 29,
    // Topic outside git (HAIL-163). sessions.no_git is 1 when the shim reported no git root, so the
    // session may name its asks with a topic. tasks.owner_session_id marks a task that session made
    // for a topic: the session owns it next to its own task. NULL on every other task.
    sql: "",
    up: (db) => {
      const has = (table: string, col: string): boolean =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
      if (!has("sessions", "no_git")) db.exec(`ALTER TABLE sessions ADD COLUMN no_git INTEGER NOT NULL DEFAULT 0`);
      if (!has("tasks", "owner_session_id")) db.exec(`ALTER TABLE tasks ADD COLUMN owner_session_id TEXT`);
    },
  },
  {
    version: 30,
    // Edit docs in place (HAIL-168). revisions.author is 'agent' or 'you' (a revision the person
    // saved from an in-place edit); base_n is the revision they started from and passages_changed
    // the size of the edit, both NULL for an agent revision. replies.edit_revision is the revision
    // by 'you' a reply carries (NULL: no edit).
    sql: "",
    up: (db) => {
      const has = (table: string, col: string): boolean =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
      if (!has("revisions", "author")) db.exec(`ALTER TABLE revisions ADD COLUMN author TEXT NOT NULL DEFAULT 'agent'`);
      if (!has("revisions", "base_n")) db.exec(`ALTER TABLE revisions ADD COLUMN base_n INTEGER`);
      if (!has("revisions", "passages_changed")) db.exec(`ALTER TABLE revisions ADD COLUMN passages_changed INTEGER`);
      if (!has("replies", "edit_revision")) db.exec(`ALTER TABLE replies ADD COLUMN edit_revision INTEGER`);
    },
  },
  {
    version: 31,
    // When the owning session last called waggle_check (case.wait) for the case (HAIL-170). The app
    // shows "Claude is not checking" for a case whose session cannot be nudged. NULL until the
    // first check. ALTER TABLE has no IF NOT EXISTS, so the column is added only when it is missing.
    sql: "",
    up: (db) => {
      const cols = db.query(`PRAGMA table_info(cases)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "last_check_at")) db.exec(`ALTER TABLE cases ADD COLUMN last_check_at TEXT`);
    },
  },
  {
    version: 32,
    // Which MCP client started the session (HAIL-173): the clientInfo.name from MCP initialize, as the
    // shim sends it in session.hello. NULL for a session from an older shim. The app shows "Claude app"
    // or "Cowork" instead of "Claude Code" for a desktop client.
    sql: "",
    up: (db) => {
      const cols = db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "client_name")) db.exec(`ALTER TABLE sessions ADD COLUMN client_name TEXT`);
    },
  },
  {
    version: 33,
    // Tool-call log (HAIL-195). One row per MCP tool call, content-free: sizes, times, ids and closed
    // words only, never the text of an ask, a reply or an artifact, and never a path. The tokens_*
    // columns are the estimate (bytes / 4, plus a fixed amount per image); the ctx_* columns are the
    // usage numbers of the agent's latest assistant message, NULL when they were not measured.
    sql: `
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  wait_ms INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL,
  session_id TEXT,
  client_name TEXT,
  case_id TEXT,
  artifact_kind TEXT,
  request_bytes INTEGER NOT NULL,
  response_bytes INTEGER NOT NULL,
  images INTEGER NOT NULL DEFAULT 0,
  tokens_written INTEGER NOT NULL,
  tokens_received INTEGER NOT NULL,
  ctx_input INTEGER,
  ctx_cache_read INTEGER,
  ctx_cache_creation INTEGER,
  ctx_output INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_at ON tool_calls(at);
`,
  },
  {
    version: 34,
    // Idempotent case.create (HAIL-197). The shim sends one random client_request_id per waggle_ask
    // call and reuses it on a retry. With the creating session it is unique, so a retry returns the
    // first case. Both columns are NULL for an ask from an older shim, and NULLs never collide.
    sql: "",
    up: (db) => {
      const cols = db.query(`PRAGMA table_info(cases)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "client_request_id")) db.exec(`ALTER TABLE cases ADD COLUMN client_request_id TEXT`);
      if (!cols.some((c) => c.name === "request_session_id")) db.exec(`ALTER TABLE cases ADD COLUMN request_session_id TEXT`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_client_request ON cases(request_session_id, client_request_id) WHERE client_request_id IS NOT NULL`,
      );
    },
  },
  {
    version: 35,
    // A decision request can carry questions with points; a reply carries the answers to them (WAG-257).
    sql: "",
    up: (db) => {
      const has = (table: string, col: string): boolean =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
      if (!has("cases", "questions_json")) db.exec("ALTER TABLE cases ADD COLUMN questions_json TEXT NOT NULL DEFAULT '[]'");
      if (!has("replies", "answers_json")) db.exec("ALTER TABLE replies ADD COLUMN answers_json TEXT");
    },
  },
  {
    version: 36,
    // Project page (WAG-260). project_themes holds the operator's taste themes per project (the
    // project is the tasks.project tag). project_prefs holds one row per project: the "also write
    // to docs/decisions/" switch (off by default) and when an agent last proposed themes.
    sql: `
CREATE TABLE IF NOT EXISTS project_themes (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  quotes_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  proposed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_themes_project ON project_themes(project);
CREATE TABLE IF NOT EXISTS project_prefs (
  project TEXT PRIMARY KEY,
  repo_records INTEGER NOT NULL DEFAULT 0,
  last_proposed_at TEXT
);
`,
  },
  {
    version: 37,
    // A revision can carry the artifact's name (WAG-276). Revisions that share a name are versions
    // of one artifact; the app shows one tab per name (or per kind when there is no name).
    sql: "",
    up: (db) => {
      const has = (db.query("PRAGMA table_info(revisions)").all() as { name: string }[]).some(
        (c) => c.name === "artifact_name",
      );
      if (!has) db.exec("ALTER TABLE revisions ADD COLUMN artifact_name TEXT");
    },
  },
  {
    version: 38,
    // Reply applied check (WAG-267). A delivered reply gets one later step. applied_at is when the
    // same session showed visible work after the delivery (a waggle_update, a new waggle_ask or a
    // finished turn). not_applied_at is when the daemon gave up waiting (the session closed, or
    // 15 minutes passed). Both stay NULL until then, and the state column does not change, so an
    // older client that reads state still sees "delivered".
    sql: "",
    up: (db) => {
      const cols = db.query(`PRAGMA table_info(replies)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "applied_at")) db.exec(`ALTER TABLE replies ADD COLUMN applied_at TEXT`);
      if (!cols.some((c) => c.name === "not_applied_at")) db.exec(`ALTER TABLE replies ADD COLUMN not_applied_at TEXT`);
    },
  },
  {
    version: 39,
    // Session title (WAG-279). The title an agent sends with waggle_ask or waggle_update, kept on the
    // session, latest wins. NULL until the agent sends one.
    sql: "",
    up: (db) => {
      const cols = db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "session_title")) db.exec(`ALTER TABLE sessions ADD COLUMN session_title TEXT`);
    },
  },
  {
    version: 40,
    // Discuss reply (WAG-301). A reply can now have intent "discuss": the human leans to some options,
    // rules some out, or asks a question, and has not decided. leaning_json and ruled_out_json hold
    // the option ids (JSON arrays, NULL for every other reply). SQLite cannot alter a CHECK, so the
    // table is rebuilt with the widened intent CHECK, as in migration 13: every row, column and index
    // is kept, and captures, comments and reply_option_sets still point at it by name.
    recreatesReferencedTable: true,
    sql: `
CREATE TABLE replies_new (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  choice TEXT,
  message TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'failed', 'superseded')),
  created_at TEXT NOT NULL,
  reason TEXT,
  replaced_at TEXT,
  intent TEXT NOT NULL DEFAULT 'decision' CHECK (intent IN ('decision', 'more_detail', 'discuss')),
  delivered_at TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  choices_json TEXT,
  format TEXT CHECK (format IN ('eli5', 'diagram', 'page')),
  source TEXT NOT NULL DEFAULT 'mac' CHECK (source IN ('mac', 'telegram', 'slack')),
  plan_round INTEGER,
  edit_revision INTEGER,
  answers_json TEXT,
  applied_at TEXT,
  not_applied_at TEXT,
  leaning_json TEXT,
  ruled_out_json TEXT
);
INSERT INTO replies_new
  (id, case_id, idempotency_key, choice, message, state, created_at, reason, replaced_at, intent,
   delivered_at, nudge_count, choices_json, format, source, plan_round, edit_revision, answers_json,
   applied_at, not_applied_at)
  SELECT id, case_id, idempotency_key, choice, message, state, created_at, reason, replaced_at, intent,
   delivered_at, nudge_count, choices_json, format, source, plan_round, edit_revision, answers_json,
   applied_at, not_applied_at
  FROM replies;
DROP TABLE replies;
ALTER TABLE replies_new RENAME TO replies;
CREATE INDEX idx_replies_case ON replies(case_id);
`,
  },
  {
    version: 41,
    // Three blocks (WAG-313, spec WAG-310 section 3). Additive: option_sets gets items_json, the canonical
    // items of a round written after this migration. It is NULL for every row that exists today; reads
    // normalise those rows from the old columns (itemsOfRound). Nothing is rewritten. An older daemon
    // never selects the column, so a rollback is safe.
    // replies.item_answers_json keeps the answers by item id exactly as the human sent them (a note on
    // a single item, a text answer, several picks inside a multi-item reply), which the old reply
    // columns cannot hold. NULL for every reply that exists today and for every reply sent the old way.
    sql: "",
    up: (db) => {
      const has = (table: string, column: string): boolean =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
      if (!has("option_sets", "items_json")) db.exec(`ALTER TABLE option_sets ADD COLUMN items_json TEXT`);
      if (!has("replies", "item_answers_json")) db.exec(`ALTER TABLE replies ADD COLUMN item_answers_json TEXT`);
    },
  },
  {
    version: 42,
    // WAG-345: the files a person attached to a reply, as JSON [{name, path, size, type}]. Additive.
    // NULL for every reply that exists today and for every reply sent without files. An older daemon
    // never selects the column, so a rollback is safe.
    sql: "",
    up: (db) => {
      const has = (table: string, column: string): boolean =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
      if (!has("replies", "attachments_json")) db.exec(`ALTER TABLE replies ADD COLUMN attachments_json TEXT`);
    },
  },
  {
    version: 43,
    // WAG-354: the sources a round cites, as JSON [{id, kind, label, ..., state, seen_at}]. Additive.
    // NULL for every round that exists today and for every round that cites none. An older daemon
    // never selects the column, so a rollback is safe.
    sql: "",
    up: (db) => {
      const has = (table: string, column: string): boolean =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
      if (!has("option_sets", "sources_json")) db.exec(`ALTER TABLE option_sets ADD COLUMN sources_json TEXT`);
    },
  },
  {
    version: 44,
    sql: `
-- More of what people do (WAG-366). The usage table learns the events of the screens added after
-- HAIL-83, app use, and the dismiss, restore and round outcomes. Five new columns: ask_h (a salted
-- hash of the ask, so the report can count per ask; the id itself is never stored), intent, format,
-- stage and note (the length of a reply's note as a bucket, never its text). SQLite cannot alter a
-- CHECK constraint in place, so usage is recreated; its rows and index are preserved.
CREATE TABLE usage_new (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered', 'reply_failed',
    'reply_retried', 'ask_pending_timeout', 'session_started', 'case_opened',
    'comment_mode_started', 'artifact_opened_full', 'review_opened', 'preview_interacted',
    'option_picked', 'recommendation_accepted', 'reply_typed', 'ask_more_detail_opened',
    'change_answer_started', 'go_back_clicked', 'sessions_panel_opened',
    'session_detail_opened', 'screenshot_zoom_changed', 'screenshot_set_view_opened',
    'comment_added', 'nudge_clicked', 'copy_prompt_clicked', 'ask_dismissed', 'ask_restored',
    'round_added', 'app_launched', 'app_active', 'onboarding_started',
    'onboarding_agent_connected', 'onboarding_continued', 'first_job_started',
    'first_job_finished', 'onboarding_prompt_copied', 'tour_started', 'tour_finished',
    'tour_skipped', 'getting_started_line_opened', 'getting_started_hidden',
    'settings_page_opened', 'usage_exported', 'new_idea_opened', 'new_idea_started',
    'launch_target_chosen', 'project_page_opened', 'update_prompt_shown',
    'update_install_clicked', 'update_later_clicked', 'update_skipped',
    'update_restart_clicked', 'whats_new_opened', 'split_fold_toggled', 'sources_list_opened',
    'source_opened', 'artifact_variant_selected', 'detail_format_picked'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots', 'diagram')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN (
    'notification', 'menu_bar', 'queue', 'sessions_panel', 'auto_advance',
    'keyboard', 'click', 'number_key', 'button', 'shortcut', 'mac', 'telegram', 'slack'
  )),
  project_h TEXT,
  after_s TEXT CHECK (after_s IN ('0-2', '3-10', '11-60', '60+')),
  variant TEXT CHECK (variant IN (
    'fit', '100', 'zoom', 'point', 'region', 'agents', 'notifications', 'previews',
    'artifacts', 'asks', 'phone', 'updates', 'data', 'help', 'claudeTerminal', 'codexTerminal',
    'claudeApp', 'codexApp', 'claudeSuperset', 'codexSuperset', 'conductor', 'claudeT3',
    'codexT3', 'session', 'queue', 'ask', 'both', 'connect', 'job', 'decision', 'talk',
    'design_kit', 'claude', 'codex', 'tradeoffs', 'prototype', 'numbers', 'example', 'something_else'
  )),
  ask_h TEXT,
  intent TEXT CHECK (intent IN ('decision', 'more_detail', 'discuss')),
  format TEXT CHECK (format IN ('eli5', 'diagram', 'page', 'none')),
  stage TEXT CHECK (stage IN ('questions', 'approaches', 'design', 'spec')),
  note TEXT CHECK (note IN ('none', '1-20', '21-100', '101-400', '400+'))
);
INSERT INTO usage_new (event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant)
  SELECT event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant FROM usage;
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage(hour);
CREATE INDEX idx_usage_ask ON usage(ask_h);
`,
  },
  {
    version: 45,
    sql: `
-- The "screenshots" pill of the "Ask for" row (WAG-367): one more word for usage.variant. SQLite cannot
-- alter a CHECK constraint in place, so usage is recreated; its rows and indexes are preserved.
CREATE TABLE usage_new (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered', 'reply_failed',
    'reply_retried', 'ask_pending_timeout', 'session_started', 'case_opened',
    'comment_mode_started', 'artifact_opened_full', 'review_opened', 'preview_interacted',
    'option_picked', 'recommendation_accepted', 'reply_typed', 'ask_more_detail_opened',
    'change_answer_started', 'go_back_clicked', 'sessions_panel_opened',
    'session_detail_opened', 'screenshot_zoom_changed', 'screenshot_set_view_opened',
    'comment_added', 'nudge_clicked', 'copy_prompt_clicked', 'ask_dismissed', 'ask_restored',
    'round_added', 'app_launched', 'app_active', 'onboarding_started',
    'onboarding_agent_connected', 'onboarding_continued', 'first_job_started',
    'first_job_finished', 'onboarding_prompt_copied', 'tour_started', 'tour_finished',
    'tour_skipped', 'getting_started_line_opened', 'getting_started_hidden',
    'settings_page_opened', 'usage_exported', 'new_idea_opened', 'new_idea_started',
    'launch_target_chosen', 'project_page_opened', 'update_prompt_shown',
    'update_install_clicked', 'update_later_clicked', 'update_skipped',
    'update_restart_clicked', 'whats_new_opened', 'split_fold_toggled', 'sources_list_opened',
    'source_opened', 'artifact_variant_selected', 'detail_format_picked'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots', 'diagram')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN (
    'notification', 'menu_bar', 'queue', 'sessions_panel', 'auto_advance',
    'keyboard', 'click', 'number_key', 'button', 'shortcut', 'mac', 'telegram', 'slack'
  )),
  project_h TEXT,
  after_s TEXT CHECK (after_s IN ('0-2', '3-10', '11-60', '60+')),
  variant TEXT CHECK (variant IN (
    'fit', '100', 'zoom', 'point', 'region', 'agents', 'notifications', 'previews',
    'artifacts', 'asks', 'phone', 'updates', 'data', 'help', 'claudeTerminal', 'codexTerminal',
    'claudeApp', 'codexApp', 'claudeSuperset', 'codexSuperset', 'conductor', 'claudeT3',
    'codexT3', 'session', 'queue', 'ask', 'both', 'connect', 'job', 'decision', 'talk',
    'design_kit', 'claude', 'codex', 'tradeoffs', 'prototype', 'numbers', 'example', 'something_else', 'screenshots'
  )),
  ask_h TEXT,
  intent TEXT CHECK (intent IN ('decision', 'more_detail', 'discuss')),
  format TEXT CHECK (format IN ('eli5', 'diagram', 'page', 'none')),
  stage TEXT CHECK (stage IN ('questions', 'approaches', 'design', 'spec')),
  note TEXT CHECK (note IN ('none', '1-20', '21-100', '101-400', '400+'))
);
INSERT INTO usage_new (event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant, ask_h, intent, format, stage, note)
  SELECT event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant, ask_h, intent, format, stage, note FROM usage;
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage(hour);
CREATE INDEX idx_usage_ask ON usage(ask_h);
`,
  },
  {
    version: 46,
    // A progress note (WAG-377). messages.working is 1 for an agent message sent with waggle_update
    // working: true. ALTER TABLE has no IF NOT EXISTS, so the column is added only when it is missing.
    sql: "",
    up: (db) => {
      const cols = db.query(`PRAGMA table_info(messages)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "working")) db.exec(`ALTER TABLE messages ADD COLUMN working INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 47,
    sql: `
-- The "how it works" pill of the "Ask for" row (WAG-384): one more word for usage.variant. SQLite cannot
-- alter a CHECK constraint in place, so usage is recreated; its rows and indexes are preserved.
CREATE TABLE usage_new (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered', 'reply_failed',
    'reply_retried', 'ask_pending_timeout', 'session_started', 'case_opened',
    'comment_mode_started', 'artifact_opened_full', 'review_opened', 'preview_interacted',
    'option_picked', 'recommendation_accepted', 'reply_typed', 'ask_more_detail_opened',
    'change_answer_started', 'go_back_clicked', 'sessions_panel_opened',
    'session_detail_opened', 'screenshot_zoom_changed', 'screenshot_set_view_opened',
    'comment_added', 'nudge_clicked', 'copy_prompt_clicked', 'ask_dismissed', 'ask_restored',
    'round_added', 'app_launched', 'app_active', 'onboarding_started',
    'onboarding_agent_connected', 'onboarding_continued', 'first_job_started',
    'first_job_finished', 'onboarding_prompt_copied', 'tour_started', 'tour_finished',
    'tour_skipped', 'getting_started_line_opened', 'getting_started_hidden',
    'settings_page_opened', 'usage_exported', 'new_idea_opened', 'new_idea_started',
    'launch_target_chosen', 'project_page_opened', 'update_prompt_shown',
    'update_install_clicked', 'update_later_clicked', 'update_skipped',
    'update_restart_clicked', 'whats_new_opened', 'split_fold_toggled', 'sources_list_opened',
    'source_opened', 'artifact_variant_selected', 'detail_format_picked'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots', 'diagram')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN (
    'notification', 'menu_bar', 'queue', 'sessions_panel', 'auto_advance',
    'keyboard', 'click', 'number_key', 'button', 'shortcut', 'mac', 'telegram', 'slack'
  )),
  project_h TEXT,
  after_s TEXT CHECK (after_s IN ('0-2', '3-10', '11-60', '60+')),
  variant TEXT CHECK (variant IN (
    'fit', '100', 'zoom', 'point', 'region', 'agents', 'notifications', 'previews',
    'artifacts', 'asks', 'phone', 'updates', 'data', 'help', 'claudeTerminal', 'codexTerminal',
    'claudeApp', 'codexApp', 'claudeSuperset', 'codexSuperset', 'conductor', 'claudeT3',
    'codexT3', 'session', 'queue', 'ask', 'both', 'connect', 'job', 'decision', 'talk',
    'design_kit', 'claude', 'codex', 'tradeoffs', 'prototype', 'numbers', 'example', 'something_else', 'screenshots', 'how_it_works'
  )),
  ask_h TEXT,
  intent TEXT CHECK (intent IN ('decision', 'more_detail', 'discuss')),
  format TEXT CHECK (format IN ('eli5', 'diagram', 'page', 'none')),
  stage TEXT CHECK (stage IN ('questions', 'approaches', 'design', 'spec')),
  note TEXT CHECK (note IN ('none', '1-20', '21-100', '101-400', '400+'))
);
INSERT INTO usage_new (event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant, ask_h, intent, format, stage, note)
  SELECT event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant, ask_h, intent, format, stage, note FROM usage;
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage(hour);
CREATE INDEX idx_usage_ask ON usage(ask_h);
`,
  },
  {
    version: 48,
    sql: `
-- Sharing a case through the relay (WAG-387). relay_shares holds the relay case id and URL, never the
-- owner key (that lives in the secret store). relay_rounds remembers which revisions were uploaded.
-- relay_comments holds the team's comments, keyed by the relay's comment id so a fetch is idempotent.
CREATE TABLE IF NOT EXISTS relay_shares (
  case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  relay_id TEXT NOT NULL,
  url TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('link', 'emails')),
  emails_json TEXT NOT NULL DEFAULT '[]',
  since INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_rounds (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  relay_seq INTEGER NOT NULL,
  PRIMARY KEY (case_id, revision)
);
CREATE TABLE IF NOT EXISTS relay_comments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  round_seq INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  body TEXT NOT NULL,
  quote TEXT,
  prefix TEXT,
  suffix TEXT,
  box_json TEXT,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_comments_case ON relay_comments(case_id, created_ms);
`,
  },
  {
    version: 49,
    // Sharing safety (WAG-391). since_id completes the comment cursor (created_ms, id). relay_comments.revision
    // keeps the revision a comment is about after Stop sharing drops relay_rounds, so the comments stay
    // useful. relay_skipped_rounds records a round the relay can never take (too big, too many files), so
    // later rounds still go up. relay_pending_stops holds a share whose case was deleted before the relay
    // page was removed; the background tick retries it until the page is gone.
    sql: "",
    up: (db) => {
      const has = (table: string, col: string): boolean =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
      if (!has("relay_shares", "since_id")) db.exec(`ALTER TABLE relay_shares ADD COLUMN since_id TEXT NOT NULL DEFAULT ''`);
      if (!has("relay_comments", "revision")) db.exec(`ALTER TABLE relay_comments ADD COLUMN revision INTEGER`);
      db.exec(`
CREATE TABLE IF NOT EXISTS relay_skipped_rounds (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (case_id, revision)
);
CREATE TABLE IF NOT EXISTS relay_pending_stops (
  relay_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);`);
    },
  },
  {
    version: 50,
    // Accounts (WAG-392). relay_comments.author_email keeps the email the relay gives for an owner or a member.
    sql: "",
    up: (db) => {
      const has = (table: string, col: string): boolean =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
      if (!has("relay_comments", "author_email")) db.exec(`ALTER TABLE relay_comments ADD COLUMN author_email TEXT`);
    },
  },
  {
    version: 51,
    // The comment loop (WAG-394). Threads (parent_id), resolve, and three marks on a comment: the agent has been
    // given it (agent_seen), the owner has seen it (owner_seen), the app told the owner about it (notified). Old
    // rows count as seen on all three. relay_shares keeps what was sent to the relay last (ask_sig, outcome_sig),
    // the mirror of closed comments, and the root share of a follow-up case that uses the same link.
    // relay_stopped remembers a case that was shared and stopped.
    sql: "",
    up: (db) => {
      const has = (table: string, col: string): boolean =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
      const add = (table: string, col: string, def: string): void => {
        if (!has(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      };
      add("relay_comments", "parent_id", "TEXT");
      add("relay_comments", "resolved_ms", "INTEGER");
      add("relay_comments", "resolved_by", "TEXT");
      add("relay_comments", "agent_seen", "INTEGER NOT NULL DEFAULT 1");
      add("relay_comments", "owner_seen", "INTEGER NOT NULL DEFAULT 1");
      add("relay_comments", "notified", "INTEGER NOT NULL DEFAULT 1");
      add("relay_shares", "root_case_id", "TEXT");
      add("relay_shares", "ask_sig", "TEXT");
      add("relay_shares", "outcome_sig", "TEXT");
      add("relay_shares", "comments_closed", "INTEGER NOT NULL DEFAULT 0");
      db.exec(`
CREATE TABLE IF NOT EXISTS relay_stopped (
  case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  stopped_at TEXT NOT NULL
);`);
    },
  },
  {
    version: 52,
    // An old share must not publish a past decision after the upgrade (WAG-394 review R6). Each share that has no
    // outcome_sig takes the signature of its last reply (the same id and replaced_at that sendOutcome builds),
    // so only an answer made after the upgrade reaches the page.
    sql: "",
    up: (db) => {
      db.exec(`
UPDATE relay_shares SET outcome_sig = (
  SELECT r.id || ':' || COALESCE(r.replaced_at, '') FROM replies r
  WHERE r.case_id = relay_shares.case_id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1
) WHERE outcome_sig IS NULL;`);
    },
  },
  {
    version: 53,
    // Tool-call log (WAG-409): the stable code of the error that failed a call. A code, never the text.
    // NULL for a call that did not fail and for a row written before this version.
    sql: "",
    up: (db) => {
      const cols = db.query(`PRAGMA table_info(tool_calls)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "error_code")) db.exec(`ALTER TABLE tool_calls ADD COLUMN error_code TEXT`);
    },
  },
  {
    version: 54,
    // Handed over reply (WAG-410 pass 2). A failed reply becomes "handed_over" when the human continues the
    // case in a new session: the answer goes to the new session in its prompt, so the case shows no failure.
    // SQLite cannot alter a CHECK, so the table is rebuilt as in migration 40: every column, row and index is kept.
    recreatesReferencedTable: true,
    sql: `
CREATE TABLE replies_new (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  choice TEXT,
  message TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'failed', 'superseded', 'handed_over')),
  created_at TEXT NOT NULL,
  reason TEXT,
  replaced_at TEXT,
  intent TEXT NOT NULL DEFAULT 'decision' CHECK (intent IN ('decision', 'more_detail', 'discuss')),
  delivered_at TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  choices_json TEXT,
  format TEXT CHECK (format IN ('eli5', 'diagram', 'page')),
  source TEXT NOT NULL DEFAULT 'mac' CHECK (source IN ('mac', 'telegram', 'slack')),
  plan_round INTEGER,
  edit_revision INTEGER,
  answers_json TEXT,
  applied_at TEXT,
  not_applied_at TEXT,
  leaning_json TEXT,
  ruled_out_json TEXT,
  item_answers_json TEXT,
  attachments_json TEXT
);
INSERT INTO replies_new
  (id, case_id, idempotency_key, choice, message, state, created_at, reason, replaced_at, intent,
   delivered_at, nudge_count, choices_json, format, source, plan_round, edit_revision, answers_json,
   applied_at, not_applied_at, leaning_json, ruled_out_json, item_answers_json, attachments_json)
  SELECT id, case_id, idempotency_key, choice, message, state, created_at, reason, replaced_at, intent,
   delivered_at, nudge_count, choices_json, format, source, plan_round, edit_revision, answers_json,
   applied_at, not_applied_at, leaning_json, ruled_out_json, item_answers_json, attachments_json
  FROM replies;
DROP TABLE replies;
ALTER TABLE replies_new RENAME TO replies;
CREATE INDEX idx_replies_case ON replies(case_id);
`,
  },
  {
    version: 55,
    sql: `
-- The quick reply chips (WAG-411 pass 2): one more event, quick_reply_picked, and three words for usage.variant. SQLite cannot
-- alter a CHECK constraint in place, so usage is recreated; its rows and indexes are preserved.
CREATE TABLE usage_new (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered', 'reply_failed',
    'reply_retried', 'ask_pending_timeout', 'session_started', 'case_opened',
    'comment_mode_started', 'artifact_opened_full', 'review_opened', 'preview_interacted',
    'option_picked', 'recommendation_accepted', 'reply_typed', 'ask_more_detail_opened',
    'change_answer_started', 'go_back_clicked', 'sessions_panel_opened',
    'session_detail_opened', 'screenshot_zoom_changed', 'screenshot_set_view_opened',
    'comment_added', 'nudge_clicked', 'copy_prompt_clicked', 'ask_dismissed', 'ask_restored',
    'round_added', 'app_launched', 'app_active', 'onboarding_started',
    'onboarding_agent_connected', 'onboarding_continued', 'first_job_started',
    'first_job_finished', 'onboarding_prompt_copied', 'tour_started', 'tour_finished',
    'tour_skipped', 'getting_started_line_opened', 'getting_started_hidden',
    'settings_page_opened', 'usage_exported', 'new_idea_opened', 'new_idea_started',
    'launch_target_chosen', 'project_page_opened', 'update_prompt_shown',
    'update_install_clicked', 'update_later_clicked', 'update_skipped',
    'update_restart_clicked', 'whats_new_opened', 'split_fold_toggled', 'sources_list_opened',
    'source_opened', 'artifact_variant_selected', 'detail_format_picked', 'quick_reply_picked'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots', 'diagram')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN (
    'notification', 'menu_bar', 'queue', 'sessions_panel', 'auto_advance',
    'keyboard', 'click', 'number_key', 'button', 'shortcut', 'mac', 'telegram', 'slack'
  )),
  project_h TEXT,
  after_s TEXT CHECK (after_s IN ('0-2', '3-10', '11-60', '60+')),
  variant TEXT CHECK (variant IN (
    'fit', '100', 'zoom', 'point', 'region', 'agents', 'notifications', 'previews',
    'artifacts', 'asks', 'phone', 'updates', 'data', 'help', 'claudeTerminal', 'codexTerminal',
    'claudeApp', 'codexApp', 'claudeSuperset', 'codexSuperset', 'conductor', 'claudeT3',
    'codexT3', 'session', 'queue', 'ask', 'both', 'connect', 'job', 'decision', 'talk',
    'design_kit', 'claude', 'codex', 'tradeoffs', 'prototype', 'numbers', 'example', 'something_else', 'screenshots', 'how_it_works',
    'lets_discuss', 'my_comments', 'show_more'
  )),
  ask_h TEXT,
  intent TEXT CHECK (intent IN ('decision', 'more_detail', 'discuss')),
  format TEXT CHECK (format IN ('eli5', 'diagram', 'page', 'none')),
  stage TEXT CHECK (stage IN ('questions', 'approaches', 'design', 'spec')),
  note TEXT CHECK (note IN ('none', '1-20', '21-100', '101-400', '400+'))
);
INSERT INTO usage_new (event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant, ask_h, intent, format, stage, note)
  SELECT event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant, ask_h, intent, format, stage, note FROM usage;
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage(hour);
CREATE INDEX idx_usage_ask ON usage(ask_h);
`,
  },
  {
    version: 56,
    // Ask less (WAG-412). Five columns on cases hold how a rule decided it (all NULL for a case a person decided).
    // Usage gets one more event, ask_auto_decided, and two coded columns: category and rule_id. SQLite cannot alter a
    // CHECK constraint in place, so usage is recreated; its rows and indexes are preserved. Safe to run again.
    sql: "",
    up: (db) => {
      const cols = (db.query(`PRAGMA table_info(cases)`).all() as { name: string }[]).map((c) => c.name);
      for (const name of ["auto_category", "auto_rule", "auto_choice", "auto_answer", "auto_at"]) {
        if (!cols.includes(name)) db.exec(`ALTER TABLE cases ADD COLUMN ${name} TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cases_auto_at ON cases(auto_at) WHERE auto_at IS NOT NULL`);
      const old = (db.query(`PRAGMA table_info(usage)`).all() as { name: string }[]).map((c) => c.name);
      const keep = ["event", "hour", "n", "duration_s", "kind", "artifact_kind", "outcome", "source", "project_h", "after_s", "variant", "ask_h", "intent", "format", "stage", "note", ...["category", "rule_id"].filter((c) => old.includes(c))].join(", ");
      const copyUsage = `INSERT INTO usage_new (${keep}) SELECT ${keep} FROM usage;`;
      db.exec(`
CREATE TABLE usage_new (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered', 'reply_failed',
    'reply_retried', 'ask_pending_timeout', 'session_started', 'case_opened',
    'comment_mode_started', 'artifact_opened_full', 'review_opened', 'preview_interacted',
    'option_picked', 'recommendation_accepted', 'reply_typed', 'ask_more_detail_opened',
    'change_answer_started', 'go_back_clicked', 'sessions_panel_opened',
    'session_detail_opened', 'screenshot_zoom_changed', 'screenshot_set_view_opened',
    'comment_added', 'nudge_clicked', 'copy_prompt_clicked', 'ask_dismissed', 'ask_restored',
    'round_added', 'app_launched', 'app_active', 'onboarding_started',
    'onboarding_agent_connected', 'onboarding_continued', 'first_job_started',
    'first_job_finished', 'onboarding_prompt_copied', 'tour_started', 'tour_finished',
    'tour_skipped', 'getting_started_line_opened', 'getting_started_hidden',
    'settings_page_opened', 'usage_exported', 'new_idea_opened', 'new_idea_started',
    'launch_target_chosen', 'project_page_opened', 'update_prompt_shown',
    'update_install_clicked', 'update_later_clicked', 'update_skipped',
    'update_restart_clicked', 'whats_new_opened', 'split_fold_toggled', 'sources_list_opened',
    'source_opened', 'artifact_variant_selected', 'detail_format_picked', 'quick_reply_picked',
    'ask_auto_decided'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots', 'diagram')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN (
    'notification', 'menu_bar', 'queue', 'sessions_panel', 'auto_advance',
    'keyboard', 'click', 'number_key', 'button', 'shortcut', 'mac', 'telegram', 'slack'
  )),
  project_h TEXT,
  after_s TEXT CHECK (after_s IN ('0-2', '3-10', '11-60', '60+')),
  variant TEXT CHECK (variant IN (
    'fit', '100', 'zoom', 'point', 'region', 'agents', 'notifications', 'previews',
    'artifacts', 'asks', 'phone', 'updates', 'data', 'help', 'claudeTerminal', 'codexTerminal',
    'claudeApp', 'codexApp', 'claudeSuperset', 'codexSuperset', 'conductor', 'claudeT3',
    'codexT3', 'session', 'queue', 'ask', 'both', 'connect', 'job', 'decision', 'talk',
    'design_kit', 'claude', 'codex', 'tradeoffs', 'prototype', 'numbers', 'example', 'something_else', 'screenshots', 'how_it_works',
    'lets_discuss', 'my_comments', 'show_more'
  )),
  ask_h TEXT,
  intent TEXT CHECK (intent IN ('decision', 'more_detail', 'discuss')),
  format TEXT CHECK (format IN ('eli5', 'diagram', 'page', 'none')),
  stage TEXT CHECK (stage IN ('questions', 'approaches', 'design', 'spec')),
  note TEXT CHECK (note IN ('none', '1-20', '21-100', '101-400', '400+')),
  category TEXT CHECK (category IN ('naming', 'wording', 'formatting', 'tests')),
  rule_id TEXT CHECK (rule_id IN ('ask_less_naming', 'ask_less_wording', 'ask_less_formatting', 'ask_less_tests'))
);
${copyUsage}
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage(hour);
CREATE INDEX idx_usage_ask ON usage(ask_h);
`);
    },
  },
  {
    version: 57,
    sql: `
-- Compare (WAG-413): one more event, compare_toggled, and two words for usage.variant (on, off). SQLite cannot
-- alter a CHECK constraint in place, so usage is recreated; its rows and indexes are preserved.
CREATE TABLE usage_new (
  event TEXT NOT NULL CHECK (event IN (
    'ask_created', 'reply_submitted', 'revision_added', 'reply_delivered', 'reply_failed',
    'reply_retried', 'ask_pending_timeout', 'session_started', 'case_opened',
    'comment_mode_started', 'artifact_opened_full', 'review_opened', 'preview_interacted',
    'option_picked', 'recommendation_accepted', 'reply_typed', 'ask_more_detail_opened',
    'change_answer_started', 'go_back_clicked', 'sessions_panel_opened',
    'session_detail_opened', 'screenshot_zoom_changed', 'screenshot_set_view_opened',
    'comment_added', 'nudge_clicked', 'copy_prompt_clicked', 'ask_dismissed', 'ask_restored',
    'round_added', 'app_launched', 'app_active', 'onboarding_started',
    'onboarding_agent_connected', 'onboarding_continued', 'first_job_started',
    'first_job_finished', 'onboarding_prompt_copied', 'tour_started', 'tour_finished',
    'tour_skipped', 'getting_started_line_opened', 'getting_started_hidden',
    'settings_page_opened', 'usage_exported', 'new_idea_opened', 'new_idea_started',
    'launch_target_chosen', 'project_page_opened', 'update_prompt_shown',
    'update_install_clicked', 'update_later_clicked', 'update_skipped',
    'update_restart_clicked', 'whats_new_opened', 'split_fold_toggled', 'sources_list_opened',
    'source_opened', 'artifact_variant_selected', 'detail_format_picked', 'quick_reply_picked',
    'ask_auto_decided', 'compare_toggled'
  )),
  hour TEXT NOT NULL,
  n INTEGER,
  duration_s INTEGER,
  kind TEXT CHECK (kind IN ('question', 'review')),
  artifact_kind TEXT CHECK (artifact_kind IN ('screenshot', 'html_bundle', 'markdown', 'screenshots', 'diagram')),
  outcome TEXT CHECK (outcome IN ('took_recommendation', 'other_option', 'message_only')),
  source TEXT CHECK (source IN (
    'notification', 'menu_bar', 'queue', 'sessions_panel', 'auto_advance',
    'keyboard', 'click', 'number_key', 'button', 'shortcut', 'mac', 'telegram', 'slack'
  )),
  project_h TEXT,
  after_s TEXT CHECK (after_s IN ('0-2', '3-10', '11-60', '60+')),
  variant TEXT CHECK (variant IN (
    'fit', '100', 'zoom', 'point', 'region', 'agents', 'notifications', 'previews',
    'artifacts', 'asks', 'phone', 'updates', 'data', 'help', 'claudeTerminal', 'codexTerminal',
    'claudeApp', 'codexApp', 'claudeSuperset', 'codexSuperset', 'conductor', 'claudeT3',
    'codexT3', 'session', 'queue', 'ask', 'both', 'connect', 'job', 'decision', 'talk',
    'design_kit', 'claude', 'codex', 'tradeoffs', 'prototype', 'numbers', 'example', 'something_else', 'screenshots', 'how_it_works',
    'lets_discuss', 'my_comments', 'show_more', 'on', 'off'
  )),
  ask_h TEXT,
  intent TEXT CHECK (intent IN ('decision', 'more_detail', 'discuss')),
  format TEXT CHECK (format IN ('eli5', 'diagram', 'page', 'none')),
  stage TEXT CHECK (stage IN ('questions', 'approaches', 'design', 'spec')),
  note TEXT CHECK (note IN ('none', '1-20', '21-100', '101-400', '400+')),
  category TEXT CHECK (category IN ('naming', 'wording', 'formatting', 'tests')),
  rule_id TEXT CHECK (rule_id IN ('ask_less_naming', 'ask_less_wording', 'ask_less_formatting', 'ask_less_tests'))
);
INSERT INTO usage_new (event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant, ask_h, intent, format, stage, note, category, rule_id)
  SELECT event, hour, n, duration_s, kind, artifact_kind, outcome, source, project_h, after_s, variant, ask_h, intent, format, stage, note, category, rule_id FROM usage;
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_hour ON usage(hour);
CREATE INDEX idx_usage_ask ON usage(ask_h);
`,
  },
  {
    version: 58,
    // The case list reads "when did this session end" from the event log, once per row whose session
    // ended. The log is append-only and had no index beyond seq, so each of those rows scanned the
    // whole log: cases.list took ~830 ms at 1,000 cases and 30,000 events, ~33 ms with this index.
    // Additive. An older daemon ignores the index, so a rollback is safe.
    sql: `CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, type, at);`,
  },
  {
    version: 61,
    // The Brain's recall (WAG-416). Three changes:
    // 1. decided_asks: a full-text index of the decided asks, filled here from the old cases.
    // 2. cases.matched_case_ids_json: the past decisions that fit an ask, stored on the case that was created after them.
    // 3. usage takes two events, ask_held and ask_check_failed. SQLite cannot alter a CHECK in place, so usage is
    //    rebuilt from its own stored definition (every column and index stays, whatever other migrations added).
    sql: ``,
    up: (db) => {
      db.exec(DECIDED_TABLE_SQL);
      const has = (table: string, column: string) =>
        (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
      if (!has("cases", "matched_case_ids_json")) db.exec(`ALTER TABLE cases ADD COLUMN matched_case_ids_json TEXT`);
      const usage = db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage'`).get() as { sql: string } | null;
      if (usage && !usage.sql.includes("'ask_held'")) {
        const rebuilt = usage.sql
          .replace(/CREATE TABLE\s+"?usage"?/, "CREATE TABLE usage_new")
          .replace("'compare_toggled'", "'compare_toggled', 'ask_held', 'ask_check_failed'");
        if (!rebuilt.includes("'ask_held'") || !rebuilt.includes("usage_new")) throw new Error("migration 61: cannot rebuild usage");
        const indexes = db
          .query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage' AND sql IS NOT NULL`)
          .all() as { sql: string }[];
        const columns = (db.query(`PRAGMA table_info(usage)`).all() as { name: string }[]).map((c) => c.name).join(", ");
        db.exec(rebuilt);
        db.exec(`INSERT INTO usage_new (${columns}) SELECT ${columns} FROM usage`);
        db.exec(`DROP TABLE usage`);
        db.exec(`ALTER TABLE usage_new RENAME TO usage`);
        for (const index of indexes) db.exec(index.sql);
      }
      backfillDecidedAsks(db);
    },
  },
];

export function migrate(db: Database): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  let version = Number(row.user_version ?? 0);

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    // `PRAGMA foreign_keys` is a no-op inside a transaction, so a migration
    // that drops a table another table's FK references (migration 13) must
    // toggle it outside the transaction wrapper every other migration uses.
    if (migration.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      if (migration.up) migration.up(db);
      else db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    })();
    if (migration.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = ON");
    version = migration.version;
  }
}
