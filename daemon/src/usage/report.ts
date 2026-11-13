import type { Database } from "bun:sqlite";
import { truncateToHour } from "./index";

// `waggle report` formatting (KNOCK-19). Pure: it reads the usage table and
// returns plain text. Nothing here leaves the Mac; the report contains no
// titles, text, paths or project names by construction (the table stores
// none).

const HEADER =
  "Nothing here leaves your Mac unless you paste it. Contains no titles, text, paths or project names.";

export function formatReport(db: Database, days: number): string {
  const cutoff = truncateToHour(new Date(Date.now() - days * 86_400_000));
  const lines: string[] = [];
  lines.push(HEADER);
  lines.push("");
  lines.push(`Last ${days} ${days === 1 ? "day" : "days"}`);
  lines.push("");

  // Asks per day.
  const asksPerDay = (
    db
      .query(
        `SELECT substr(hour, 1, 10) AS day, COUNT(*) AS n
         FROM usage WHERE event = 'ask_created' AND hour >= ?
         GROUP BY day ORDER BY day`,
      )
      .all(cutoff) as { day: string; n: number }[]
  ).map((r) => `${r.day}: ${r.n}`);

  // question vs review, screenshot vs html bundle.
  const kindCounts = usageCounts(db, cutoff, "ask_created", "kind");
  const artifactCounts = usageCounts(db, cutoff, "ask_created", "artifact_kind");
  const totalAsks = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'ask_created' AND hour >= ?`, cutoff);

  lines.push("Asks per day");
  if (asksPerDay.length === 0) lines.push("  no asks");
  for (const day of asksPerDay) lines.push(`  ${day}`);
  lines.push("");
  lines.push(`  total: ${totalAsks}`);
  lines.push(`  question: ${kindCounts.get("question") ?? 0}`);
  lines.push(`  review: ${kindCounts.get("review") ?? 0}`);
  lines.push(`  screenshot: ${artifactCounts.get("screenshot") ?? 0}`);
  lines.push(`  html bundle: ${artifactCounts.get("html_bundle") ?? 0}`);
  lines.push(`  markdown: ${artifactCounts.get("markdown") ?? 0}`);
  lines.push(`  screenshots: ${artifactCounts.get("screenshots") ?? 0}`);
  lines.push(`  diagram: ${artifactCounts.get("diagram") ?? 0}`);
  lines.push("");

  // Median and p90 time to reply, by hour of day (UTC).
  const durations = db
    .query(
      `SELECT substr(hour, 12, 2) AS hod, duration_s
       FROM usage WHERE event = 'reply_submitted' AND hour >= ? AND duration_s IS NOT NULL
       ORDER BY hod, duration_s`,
    )
    .all(cutoff) as { hod: string; duration_s: number }[];
  lines.push("Time to reply by hour of day (UTC)");
  const byHour = new Map<string, number[]>();
  for (const row of durations) {
    const bucket = byHour.get(row.hod) ?? [];
    bucket.push(row.duration_s);
    byHour.set(row.hod, bucket);
  }
  if (byHour.size === 0) lines.push("  no replies");
  for (const [hod, values] of [...byHour.entries()].sort()) {
    lines.push(`  hour ${Number(hod)}: median ${median(values)}s, p90 ${p90(values)}s`);
  }
  lines.push("");

  // Recommendation taken rate.
  const outcomeCounts = usageCounts(db, cutoff, "reply_submitted", "outcome");
  const repliesTotal = [...outcomeCounts.values()].reduce((a, b) => a + b, 0);
  const taken = outcomeCounts.get("took_recommendation") ?? 0;
  lines.push(
    `Recommendation taken: ${percent(taken, repliesTotal)} (${taken} of ${repliesTotal})`,
  );

  // Comments per review.
  const totalComments = count(
    db,
    `SELECT COALESCE(SUM(n), 0) AS n FROM usage WHERE event = 'reply_submitted' AND hour >= ?`,
    cutoff,
  );
  const reviews = kindCounts.get("review") ?? 0;
  lines.push(`Comments per review: ${ratio(totalComments, reviews)}`);

  // Revisions per ask.
  const revisions = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'revision_added' AND hour >= ?`, cutoff);
  lines.push(`Revisions per ask: ${ratio(revisions, totalAsks)}`);

  // Notification open share.
  const opens = usageCounts(db, cutoff, "case_opened", "source");
  const opensTotal = [...opens.values()].reduce((a, b) => a + b, 0);
  const byNotification = opens.get("notification") ?? 0;
  lines.push(
    `Notification open share: ${percent(byNotification, opensTotal)} (${byNotification} of ${opensTotal})`,
  );

  // Delivery failures and retries.
  const failures = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'reply_failed' AND hour >= ?`, cutoff);
  const retries = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'reply_retried' AND hour >= ?`, cutoff);
  lines.push(`Delivery failures: ${failures}`);
  lines.push(`Delivery retries: ${retries}`);

  // Peak live sessions.
  const peak = (
    db
      .query(`SELECT COALESCE(MAX(n), 0) AS m FROM usage WHERE event = 'session_started' AND hour >= ?`)
      .get(cutoff) as { m: number }
  ).m;
  lines.push(`Peak live sessions: ${peak}`);

  // Distinct project count (hashed tag only; names are never stored).
  const projects = count(
    db,
    `SELECT COUNT(DISTINCT project_h) AS n FROM usage WHERE hour >= ? AND project_h IS NOT NULL`,
    cutoff,
  );
  lines.push(`Distinct projects: ${projects}`);

  lines.push("");
  appendClickSection(db, lines, cutoff, days);
  lines.push("");
  appendAppUseSection(db, lines, cutoff);
  lines.push("");
  appendReplySection(db, lines, cutoff);
  lines.push("");
  appendPerAskSection(db, lines, cutoff);
  lines.push("");
  appendFeatureSection(db, lines, cutoff);

  return lines.join("\n") + "\n";
}

const CLICK_EVENTS: [string, string][] = [
  ["artifact_opened_full", "opened the preview full size"],
  ["review_opened", "opened the review"],
  ["preview_interacted", "clicked or scrolled in the preview"],
  ["option_picked", "picked an option"],
  ["recommendation_accepted", "accepted the recommendation"],
  ["reply_typed", "started typing a reply"],
  ["ask_more_detail_opened", "asked for more detail"],
  ["quick_reply_picked", "used a quick reply chip"],
  ["change_answer_started", "started to change an answer"],
  ["go_back_clicked", "clicked go back"],
  ["sessions_panel_opened", "opened the sessions panel"],
  ["session_detail_opened", "opened a session"],
  ["screenshot_zoom_changed", "changed the screenshot zoom"],
  ["compare_toggled", "turned Compare on or off"],
  ["correction", "answered with a correction"],
  ["screenshot_set_view_opened", "opened a screenshot set view"],
  ["comment_added", "added a comment"],
  ["comment_mode_started", "started comment mode"],
  ["nudge_clicked", "clicked nudge"],
  ["copy_prompt_clicked", "copied the prompt"],
];

const AFTER_ORDER = ["0-2", "3-10", "11-60", "60+"];

// "What you click" (HAIL-83): counts per app event, then the derived lines.
// The log holds no per-ask ids, so every percentage is a ratio of two counts,
// not a per-ask join. Each app event is recorded at most once per ask for the
// three "opened" events, so those ratios stay at or under 100%.
function appendClickSection(db: Database, lines: string[], cutoff: string, days: number): void {
  lines.push(`What you click (last ${days} ${days === 1 ? "day" : "days"})`);
  const events = new Map(
    (
      db
        .query(`SELECT event, COUNT(*) AS n FROM usage WHERE hour >= ? GROUP BY event`)
        .all(cutoff) as { event: string; n: number }[]
    ).map((r) => [r.event, r.n]),
  );
  for (const [event, label] of CLICK_EVENTS) lines.push(`  ${label}: ${events.get(event) ?? 0}`);

  const withPreview = count(
    db,
    `SELECT COUNT(*) AS n FROM usage WHERE event = 'ask_created' AND artifact_kind IS NOT NULL AND hour >= ?`,
    cutoff,
  );
  const full = events.get("artifact_opened_full") ?? 0;
  const review = events.get("review_opened") ?? 0;
  const afterRows = db
    .query(
      `SELECT after_s FROM usage WHERE event = 'artifact_opened_full' AND after_s IS NOT NULL AND hour >= ?`,
    )
    .all(cutoff) as { after_s: string }[];
  const afters = afterRows.map((r) => AFTER_ORDER.indexOf(r.after_s)).filter((i) => i >= 0);
  const medianAfter =
    afters.length === 0 ? "" : ` (median after ${AFTER_ORDER[lowerMedian(afters)]} s)`;
  lines.push(
    `  Asks with a preview: opened full size ${percent(Math.min(full, withPreview), withPreview)}${medianAfter}`,
  );
  lines.push(`  Asks with a preview: opened review ${percent(Math.min(review, withPreview), withPreview)}`);

  // Answers to asks with a preview, and how many of them had no open at all.
  // Upper bound of "opened": each open counts once, capped at the answers.
  const answeredWithPreview = count(
    db,
    `SELECT COUNT(*) AS n FROM usage WHERE event = 'reply_submitted' AND artifact_kind IS NOT NULL AND hour >= ?`,
    cutoff,
  );
  const opened = Math.min(answeredWithPreview, full + review);
  lines.push(
    `  Answered without opening the preview: ${percent(answeredWithPreview - opened, answeredWithPreview)}`,
  );

  const accepted = events.get("recommendation_accepted") ?? 0;
  const byShortcut = count(
    db,
    `SELECT COUNT(*) AS n FROM usage WHERE event = 'recommendation_accepted' AND source = 'shortcut' AND hour >= ?`,
    cutoff,
  );
  lines.push(`  Recommendation accepted by shortcut: ${percent(byShortcut, accepted)}`);
}

// App use (WAG-366): launches, and the days and hours the app was in front. app_active is recorded at
// most once per hour, so its rows are active hours.
function appendAppUseSection(db: Database, lines: string[], cutoff: string): void {
  lines.push("App use");
  const launches = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'app_launched' AND hour >= ?`, cutoff);
  const hours = count(db, `SELECT COUNT(DISTINCT hour) AS n FROM usage WHERE event = 'app_active' AND hour >= ?`, cutoff);
  const activeDays = count(
    db,
    `SELECT COUNT(DISTINCT substr(hour, 1, 10)) AS n FROM usage WHERE event = 'app_active' AND hour >= ?`,
    cutoff,
  );
  const answerDays = count(
    db,
    `SELECT COUNT(DISTINCT substr(hour, 1, 10)) AS n FROM usage WHERE event = 'reply_submitted' AND hour >= ?`,
    cutoff,
  );
  lines.push(`  launches: ${launches}`);
  lines.push(`  days with the app in front: ${activeDays}`);
  lines.push(`  hours with the app in front: ${hours}`);
  lines.push(`  days with an answer: ${answerDays}`);
}

const NOTE_ORDER = ["none", "1-20", "21-100", "101-400", "400+"];

// Replies (WAG-366): what kind they were, where they came from, how the note box was used, and how
// people ask for more detail. Counts only: the log holds no text.
function appendReplySection(db: Database, lines: string[], cutoff: string): void {
  lines.push("Replies");
  const replies = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'reply_submitted' AND hour >= ?`, cutoff);
  const intents = usageCounts(db, cutoff, "reply_submitted", "intent");
  lines.push(
    `  decided: ${intents.get("decision") ?? 0}, kept talking: ${intents.get("discuss") ?? 0}, ` +
      `asked for more detail: ${intents.get("more_detail") ?? 0}`,
  );
  const sources = usageCounts(db, cutoff, "reply_submitted", "source");
  lines.push(
    `  from the Mac: ${sources.get("mac") ?? 0}, Telegram: ${sources.get("telegram") ?? 0}, Slack: ${sources.get("slack") ?? 0}`,
  );

  const notes = usageCounts(db, cutoff, "reply_submitted", "note");
  const measured = [...notes.values()].reduce((a, b) => a + b, 0);
  const withNote = measured - (notes.get("none") ?? 0);
  lines.push(`  Note box used: ${percent(withNote, measured)} (${withNote} of ${measured})`);
  lines.push(`  Note length in characters: ${NOTE_ORDER.slice(1).map((b) => `${b}: ${notes.get(b) ?? 0}`).join(", ")}`);
  const noteAlone = count(
    db,
    `SELECT COUNT(*) AS n FROM usage WHERE event = 'reply_submitted' AND outcome = 'message_only'
       AND note IS NOT NULL AND note != 'none' AND intent = 'decision' AND hour >= ?`,
    cutoff,
  );
  lines.push(`  Note with no option picked: ${noteAlone}`);
  const comments = count(
    db,
    `SELECT COUNT(*) AS n FROM usage WHERE event = 'reply_submitted' AND n > 0 AND hour >= ?`,
    cutoff,
  );
  lines.push(`  Replies with comments: ${percent(comments, replies)}`);

  const opened = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'ask_more_detail_opened' AND hour >= ?`, cutoff);
  const sent = intents.get("more_detail") ?? 0;
  lines.push(`  Ask for more detail: opened ${opened}, sent ${sent} (${percent(sent, replies)} of replies)`);
  const picked = usageCounts(db, cutoff, "detail_format_picked", "format");
  const sentFormats = usageCounts(db, cutoff, "reply_submitted", "format");
  const formatLine = (m: Map<string, number>) =>
    `like I'm five ${m.get("eli5") ?? 0}, diagram ${m.get("diagram") ?? 0}, interactive page ${m.get("page") ?? 0}, no format ${m.get("none") ?? 0}`;
  lines.push(`  Detail format picked: ${formatLine(picked)}`);
  lines.push(`  Detail format sent: ${formatLine(sentFormats)}`);
  const quick = usageCounts(db, cutoff, "detail_format_picked", "variant");
  lines.push(
    `  Quick ask picked: trade-offs ${quick.get("tradeoffs") ?? 0}, prototype ${quick.get("prototype") ?? 0}, ` +
      `numbers ${quick.get("numbers") ?? 0}, example ${quick.get("example") ?? 0}, ` +
      `screenshots ${quick.get("screenshots") ?? 0}, something else ${quick.get("something_else") ?? 0}`,
  );
  const allPicks = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'detail_format_picked' AND hour >= ?`, cutoff);
  const rowPicks = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'detail_format_picked' AND n = 1 AND hour >= ?`, cutoff);
  lines.push(`  Sent from a pill of the row: ${rowPicks} of ${allPicks}`);
  // WAG-367: each pill of the "Ask for" row by name. A row pick has n = 1.
  const pill = (where: string) =>
    count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'detail_format_picked' AND n = 1 AND ${where} AND hour >= ?`, cutoff);
  const dots = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'ask_more_detail_opened' AND source = 'button' AND hour >= ?`, cutoff);
  // WAG-411 pass 2: the quick reply chips above the input, by word.
  const chips = usageCounts(db, cutoff, "quick_reply_picked", "variant");
  lines.push(
    `  Quick reply chips: let's discuss ${chips.get("lets_discuss") ?? 0}, look at my comments ${chips.get("my_comments") ?? 0}, ` +
      `show me more ${chips.get("show_more") ?? 0}`,
  );
  lines.push(
    `  Row pills clicked: trade-offs ${pill("variant = 'tradeoffs'")}, prototype ${pill("variant = 'prototype'")}, ` +
      `screenshots ${pill("variant = 'screenshots'")}, numbers ${pill("variant = 'numbers'")}, ` +
      `example ${pill("variant = 'example'")}, diagram ${pill("format = 'diagram'")}, three dots ${dots}`,
  );

  const dismissed = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'ask_dismissed' AND hour >= ?`, cutoff);
  const restored = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'ask_restored' AND hour >= ?`, cutoff);
  lines.push(`  Asks dismissed: ${dismissed}, dismiss undone: ${restored}`);
  const stages = usageCounts(db, cutoff, "round_added", "stage");
  const rounds = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = 'round_added' AND hour >= ?`, cutoff);
  lines.push(
    `  Rounds from agents: ${rounds} (questions ${stages.get("questions") ?? 0}, approaches ${stages.get("approaches") ?? 0}, ` +
      `design ${stages.get("design") ?? 0}, spec ${stages.get("spec") ?? 0})`,
  );
}

// Per ask (WAG-366): the rows of one ask share ask_h, a salted hash, so these are real per-ask shares
// and not ratios of two counts. Only asks created in the window with a hash count (rows written before
// this version have none).
function appendPerAskSection(db: Database, lines: string[], cutoff: string): void {
  lines.push("Per ask");
  const asks = count(
    db,
    `SELECT COUNT(DISTINCT ask_h) AS n FROM usage WHERE event = 'ask_created' AND ask_h IS NOT NULL AND hour >= ?`,
    cutoff,
  );
  if (asks === 0) {
    lines.push("  no asks measured yet");
    return;
  }
  const withEvent = (events: string[], extra = ""): number =>
    count(
      db,
      `SELECT COUNT(DISTINCT ask_h) AS n FROM usage
       WHERE event IN (${events.map((e) => `'${e}'`).join(", ")}) ${extra}
         AND ask_h IN (SELECT ask_h FROM usage WHERE event = 'ask_created' AND ask_h IS NOT NULL AND hour >= ?)`,
      cutoff,
    );
  const line = (label: string, n: number, whole = asks) => lines.push(`  ${label}: ${percent(n, whole)} (${n} of ${whole})`);
  lines.push(`  asks: ${asks}`);
  line("opened in the app", withEvent(["case_opened"]));
  line("answered", withEvent(["reply_submitted"]));
  line("dismissed", withEvent(["ask_dismissed"]));
  line("typed in the note box", withEvent(["reply_typed"]));
  line("opened Ask for more detail", withEvent(["ask_more_detail_opened"]));
  line("sent a detail request", withEvent(["reply_submitted"], "AND intent = 'more_detail'"));
  line("kept talking", withEvent(["reply_submitted"], "AND intent = 'discuss'"));
  line("changed an answer", withEvent(["change_answer_started"]));
  line("commented on an artifact", withEvent(["comment_added"]));
  // WAG-413: what the comments were made on, and how many asks used Compare.
  for (const kind of ["screenshot", "screenshots", "html_bundle"]) {
    line(`  commented on ${kind === "html_bundle" ? "a prototype" : kind === "screenshot" ? "a screenshot" : "a screenshot set"}`, withEvent(["comment_added"], `AND artifact_kind = '${kind}'`));
  }
  line("turned Compare on", withEvent(["compare_toggled"], "AND variant = 'on'"));

  const withPreview = count(
    db,
    `SELECT COUNT(DISTINCT ask_h) AS n FROM usage
     WHERE event = 'ask_created' AND ask_h IS NOT NULL AND artifact_kind IS NOT NULL AND hour >= ?`,
    cutoff,
  );
  const previewAsks = `SELECT ask_h FROM usage WHERE event = 'ask_created' AND ask_h IS NOT NULL AND artifact_kind IS NOT NULL AND hour >= ?`;
  const openedPreview = count(
    db,
    `SELECT COUNT(DISTINCT ask_h) AS n FROM usage
     WHERE event IN ('artifact_opened_full', 'review_opened') AND ask_h IN (${previewAsks})`,
    cutoff,
  );
  const answeredBlind = count(
    db,
    `SELECT COUNT(DISTINCT ask_h) AS n FROM usage
     WHERE event = 'reply_submitted' AND ask_h IN (${previewAsks})
       AND ask_h NOT IN (SELECT ask_h FROM usage WHERE event IN ('artifact_opened_full', 'review_opened') AND ask_h IS NOT NULL)`,
    cutoff,
  );
  line("asks with a preview that had it opened", openedPreview, withPreview);
  line("asks with a preview answered without opening it", answeredBlind, withPreview);
}

const FEATURE_EVENTS: [string, string, string?][] = [
  ["onboarding_started", "Onboarding: started"],
  ["onboarding_agent_connected", "Onboarding: connected an agent", "variant"],
  ["onboarding_continued", "Onboarding: continued to the first job"],
  ["first_job_started", "Onboarding: started a first job"],
  ["first_job_finished", "Onboarding: first job sent"],
  ["onboarding_prompt_copied", "Onboarding: copied the prompt"],
  ["tour_started", "Tour: started"],
  ["tour_finished", "Tour: finished"],
  ["tour_skipped", "Tour: skipped"],
  ["getting_started_line_opened", "Getting started: opened a line", "variant"],
  ["getting_started_hidden", "Getting started: hidden"],
  ["settings_page_opened", "Settings: opened a page", "variant"],
  ["usage_exported", "Settings: exported usage"],
  ["new_idea_opened", "New idea: opened"],
  ["new_idea_started", "New idea: started", "variant"],
  ["launch_target_chosen", "New idea: changed where it starts", "variant"],
  ["project_page_opened", "Project page: opened"],
  ["update_prompt_shown", "Update: prompt shown"],
  ["update_install_clicked", "Update: install"],
  ["update_later_clicked", "Update: later"],
  ["update_skipped", "Update: skipped"],
  ["update_restart_clicked", "Update: restart now"],
  ["whats_new_opened", "Update: opened what's new"],
  ["split_fold_toggled", "Layout: folded or opened a side", "variant"],
  ["sources_list_opened", "Sources: opened the list"],
  ["source_opened", "Sources: opened one"],
  ["artifact_variant_selected", "Artifact: picked a variant"],
];

// The screens added after HAIL-83 (WAG-366): one count per event, split by its one mode when it has one.
function appendFeatureSection(db: Database, lines: string[], cutoff: string): void {
  lines.push("Other screens");
  for (const [event, label, split] of FEATURE_EVENTS) {
    const n = count(db, `SELECT COUNT(*) AS n FROM usage WHERE event = '${event}' AND hour >= ?`, cutoff);
    let detail = "";
    if (split && n > 0) {
      const parts = [...usageCounts(db, cutoff, event, split).entries()].sort((a, b) => b[1] - a[1]);
      detail = ` (${parts.map(([k, v]) => `${k} ${v}`).join(", ")})`;
    }
    lines.push(`  ${label}: ${n}${detail}`);
  }
}

// The lower of the two middle values for an even count, so a bucket index
// stays a real bucket.
function lowerMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// Counts of one enum column's values for one event type in the window.
function usageCounts(
  db: Database,
  cutoff: string,
  event: string,
  column: string,
): Map<string, number> {
  const rows = db
    .query(
      `SELECT ${column} AS value, COUNT(*) AS n
       FROM usage WHERE event = ? AND hour >= ? AND ${column} IS NOT NULL
       GROUP BY ${column}`,
    )
    .all(event, cutoff) as { value: string; n: number }[];
  return new Map(rows.map((r) => [r.value, r.n]));
}

function count(db: Database, sql: string, ...params: string[]): number {
  return (db.query(sql).get(...params) as { n: number }).n;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function p90(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(0.9 * sorted.length) - 1);
  return sorted[index];
}

function percent(part: number, whole: number): string {
  if (whole === 0) return "-";
  return `${Math.round((part / whole) * 100)}%`;
}

function ratio(part: number, whole: number): string {
  if (whole === 0) return "-";
  return (part / whole).toFixed(1);
}
