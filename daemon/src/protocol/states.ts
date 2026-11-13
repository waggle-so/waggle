import { z } from "zod";

// Case state per docs/protocol-mvp.md "Case and reply states".
export const CaseStatus = z.enum(["needs_you", "waiting_on_agent", "resolved"]);
export type CaseStatus = z.infer<typeof CaseStatus>;

// Reply state per docs/protocol-mvp.md "Case and reply states". "superseded"
// (HAIL-44) marks a queued reply on a case that a newer waggle_ask replaced:
// the human's answer arrived, but the case it answered was withdrawn before
// an agent ever picked it up, so the reply is never delivered.
// "handed_over" (WAG-410) marks a failed reply whose case the human continued in a new session:
// the answer went to the new session in its prompt. It is never requeued and never retried.
export const ReplyStatus = z.enum(["queued", "delivered", "failed", "superseded", "handed_over"]);
export type ReplyStatus = z.infer<typeof ReplyStatus>;

// What happened after a delivered reply (WAG-267). "pending": the agent got the answer and nothing
// shows yet. "applied": the same session showed visible work after the delivery. "not_applied": the
// session closed, or 15 minutes passed, with no visible work. A separate field beside `state`, so
// an older client that only reads `state` is not affected.
export const ReplyApplyState = z.enum(["pending", "applied", "not_applied"]);
export type ReplyApplyState = z.infer<typeof ReplyApplyState>;

// A session is "live" while its shim connection is open, "disconnected" when
// the connection closed but the parent pid is still alive, and "ended" once the
// parent process is gone (docs/protocol-mvp.md "Socket RPC").
export const SessionState = z.enum(["live", "disconnected", "ended"]);
export type SessionState = z.infer<typeof SessionState>;

// The connector a session and its cases came through (KNOCK-20). The shim
// reads KNOCK_RUNTIME and defaults unknown or missing values to "claude" for
// older registrations, so this stays a closed two-value enum.
export const Runtime = z.enum(["claude", "codex"]);
export type Runtime = z.infer<typeof Runtime>;

// Events streamed over events.subscribe (docs/protocol-mvp.md "Events").
export const EventType = z.enum([
  "case.created",
  "case.updated",
  "revision.added",
  "reply.state_changed",
  "session.state_changed",
  // HAIL-76: the daemon posted a nudge for a queued reply. Carries case_id.
  "session.nudged",
  // HAIL-134: a Claude Code mod asked the app to open a case (the band's button).
  // Carries case_id.
  "case.open_requested",
  // WAG-394: new comments from the team reached a shared case. Carries case_id.
  "comment.added",
]);
export type EventType = z.infer<typeof EventType>;

// The kind of a staged artifact (screenshot, html bundle, markdown (HAIL-33),
// screenshots (HAIL-40): 2 to 12 images the operator flips through, or a
// diagram (HAIL-141): one .mmd or .svg file rendered offline).
export const ArtifactKind = z.enum(["screenshot", "html_bundle", "markdown", "screenshots", "diagram"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

// A reply's intent (HAIL-33): a decision reply carries a choice/message as
// before; a more_detail reply asks the agent for an explanation before the
// human decides. Default "decision" so an older client that sends neither is
// unaffected.
// A discuss reply (WAG-301): the human has not decided. They lean to some options, rule some out,
// or ask a question, and the ask stays open.
export const ReplyIntent = z.enum(["decision", "more_detail", "discuss"]);
export type ReplyIntent = z.infer<typeof ReplyIntent>;

// WAG-312: what a reply is, in the three blocks model. "decide": the human decided and the agent goes
// ahead. "talk": Keep talking, the case stays open (discuss, more_detail, or comments with no pick). The
// wire intent keeps its three values; the daemon computes the outcome on read and never stores it.
export const ReplyOutcome = z.enum(["decide", "talk"]);
export type ReplyOutcome = z.infer<typeof ReplyOutcome>;

// The format a "more detail" reply asks for (HAIL-139): how the human wants the
// explanation back. "eli5" is a plain-words explainer, "diagram" a Mermaid or
// SVG flow, "page" a self-contained interactive html_bundle. Optional: a detail
// request with no format behaves exactly as before.
export const ReplyFormat = z.enum(["eli5", "diagram", "page"]);
export type ReplyFormat = z.infer<typeof ReplyFormat>;

// Where a reply came from (HAIL-144): the Mac app, or a chat connector. Extensible: Slack
// (HAIL-145) adds "slack". A reply that omits it is from the Mac.
export const ReplySource = z.enum(["mac", "telegram", "slack"]);
export type ReplySource = z.infer<typeof ReplySource>;

// --- Usage log enums (KNOCK-19) ---
//
// The private usage log stores content-free events. Every enum below is a
// closed set; the Zod write path rejects any other string.

// One recorded usage event. daemon events plus the two the app reports via
// usage.record.
export const UsageEventType = z.enum([
  "ask_created",
  "reply_submitted",
  "revision_added",
  "reply_delivered",
  "reply_failed",
  "reply_retried",
  "ask_pending_timeout",
  "session_started",
  "case_opened",
  "comment_mode_started",
  // HAIL-83: what people click. Reported by the app over usage.record.
  "artifact_opened_full",
  "review_opened",
  "preview_interacted",
  "option_picked",
  "recommendation_accepted",
  "reply_typed",
  "ask_more_detail_opened",
  "change_answer_started",
  "go_back_clicked",
  "sessions_panel_opened",
  "session_detail_opened",
  "screenshot_zoom_changed",
  "screenshot_set_view_opened",
  "comment_added",
  "nudge_clicked",
  "copy_prompt_clicked",
  // WAG-366: the outcomes the daemon owns.
  "ask_dismissed",
  "ask_restored",
  "round_added",
  // WAG-366: app use and the screens added after HAIL-83. Reported by the app over usage.record.
  "app_launched",
  "app_active",
  "onboarding_started",
  "onboarding_agent_connected",
  "onboarding_continued",
  "first_job_started",
  "first_job_finished",
  "onboarding_prompt_copied",
  "tour_started",
  "tour_finished",
  "tour_skipped",
  "getting_started_line_opened",
  "getting_started_hidden",
  "settings_page_opened",
  "usage_exported",
  "new_idea_opened",
  "new_idea_started",
  "launch_target_chosen",
  "project_page_opened",
  "update_prompt_shown",
  "update_install_clicked",
  "update_later_clicked",
  "update_skipped",
  "update_restart_clicked",
  "whats_new_opened",
  "split_fold_toggled",
  "sources_list_opened",
  "source_opened",
  "artifact_variant_selected",
  "detail_format_picked",
  "quick_reply_picked",
  // WAG-412: the daemon answered a small ask by the operator's rule. Carries category and rule_id only.
  "ask_auto_decided",
  // WAG-413: the Compare switch of the screenshot header.
  "compare_toggled",
  // WAG-416: a past decision held an ask (n = how many matched), and the check for past decisions failed so the
  // ask went through. Codes only: no text.
  "ask_held",
  "ask_check_failed",
]);
export type UsageEventType = z.infer<typeof UsageEventType>;

// WAG-412: the fixed list of ask categories (the "Ask less" rules), and the id of the rule for each. Both are
// coded values: the usage log holds the slug and the rule id, never the ask text or the answer.
export const AskCategory = z.enum(["naming", "wording", "formatting", "tests"]);
export type AskCategory = z.infer<typeof AskCategory>;
export const UsageRuleId = z.enum(["ask_less_naming", "ask_less_wording", "ask_less_formatting", "ask_less_tests"]);
export type UsageRuleId = z.infer<typeof UsageRuleId>;
export const AUTO_RULE_IDS: Record<AskCategory, UsageRuleId> = {
  naming: "ask_less_naming",
  wording: "ask_less_wording",
  formatting: "ask_less_formatting",
  tests: "ask_less_tests",
};

// The case kind of an ask_created event.
export const UsageKind = z.enum(["question", "review"]);
export type UsageKind = z.infer<typeof UsageKind>;

// The staged artifact kind of an ask_created event.
export const UsageArtifactKind = z.enum(["screenshot", "html_bundle", "markdown", "screenshots", "diagram"]);
export type UsageArtifactKind = z.infer<typeof UsageArtifactKind>;

// What the human did with a reply, compared with the case's recommendation.
export const UsageOutcome = z.enum(["took_recommendation", "other_option", "message_only"]);
export type UsageOutcome = z.infer<typeof UsageOutcome>;

// How the human opened a case, picked an option or accepted the recommendation
// (the app reports these). HAIL-83 widened it; each event takes only its own
// subset (see the usage.record params).
export const UsageSource = z.enum([
  "notification",
  "menu_bar",
  "queue",
  "sessions_panel",
  "auto_advance",
  "keyboard",
  "click",
  "number_key",
  "button",
  "shortcut",
  // WAG-366: where a reply came from, on the daemon's reply_submitted record.
  "mac",
  "telegram",
  "slack",
]);
export type UsageSource = z.infer<typeof UsageSource>;

// Seconds between opening an ask and the action, in four buckets (HAIL-83).
// The app never sends a raw number.
export const UsageAfter = z.enum(["0-2", "3-10", "11-60", "60+"]);
export type UsageAfter = z.infer<typeof UsageAfter>;

// The one extra mode of a click: the screenshot zoom level or the comment
// shape (HAIL-83).
// WAG-366 widened it: the settings page, the launch target, the fold, the getting-started line and the
// agent. Each event takes only its own subset (see the usage.record params).
export const UsageSettingsPage = z.enum([
  "agents",
  "notifications",
  "previews",
  "artifacts",
  "asks",
  "phone",
  "updates",
  "data",
  "help",
]);
export const UsageLaunchTarget = z.enum([
  "claudeTerminal",
  "codexTerminal",
  "claudeApp",
  "codexApp",
  "claudeSuperset",
  "codexSuperset",
  "conductor",
  "claudeT3",
  "codexT3",
  "session",
]);
export const UsageFold = z.enum(["queue", "ask", "both"]);
export const UsageStartedLine = z.enum(["connect", "job", "decision", "talk", "notifications", "design_kit"]);
export const UsageAgent = z.enum(["claude", "codex"]);
// The quick asks of "Ask for more detail", by what they ask for, and the typed one ("Something else").
export const UsageDetailPick = z.enum(["tradeoffs", "prototype", "numbers", "example", "something_else", "screenshots", "how_it_works"]);
// The quick reply chips above the input (WAG-411 pass 2), by code only, never their text.
export const UsageQuickReply = z.enum(["lets_discuss", "my_comments", "show_more"]);
// The Compare switch (WAG-413): on or off, by code only.
export const UsageCompare = z.enum(["on", "off"]);
export const UsageVariant = z.enum([
  "fit",
  "100",
  "zoom",
  "point",
  "region",
  ...UsageSettingsPage.options,
  ...UsageLaunchTarget.options,
  ...UsageFold.options,
  ...UsageStartedLine.options,
  ...UsageAgent.options,
  ...UsageDetailPick.options,
  ...UsageQuickReply.options,
  ...UsageCompare.options,
]);
export type UsageVariant = z.infer<typeof UsageVariant>;

// WAG-366: what a reply was (the reply's intent) and the format a detail request asked for.
export const UsageIntent = z.enum(["decision", "more_detail", "discuss"]);
export const UsageFormat = z.enum(["eli5", "diagram", "page", "none"]);
// The stage label of an ask or a round.
export const UsageStage = z.enum(["questions", "approaches", "design", "spec"]);
// How long the note of a reply was, in characters, as a bucket. The text is never stored here.
export const UsageNote = z.enum(["none", "1-20", "21-100", "101-400", "400+"]);
export type UsageNote = z.infer<typeof UsageNote>;
