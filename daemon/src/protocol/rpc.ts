import { z } from "zod";
import {
  EventType,
  ReplyFormat,
  ReplyIntent,
  ReplySource,
  Runtime,
  UsageAfter,
  UsageAgent,
  UsageArtifactKind,
  UsageFold,
  UsageDetailPick,
  UsageQuickReply,
  UsageCompare,
  UsageFormat,
  UsageLaunchTarget,
  UsageSettingsPage,
  UsageStartedLine,
} from "./states";
import {
  ArtifactPathResult,
  Case,
  Capture,
  Comment,
  ItemAnswers,
  PointAnswers,
  ReplyAttachmentInput,
  SessionChanges,
} from "./nouns";
import { ToolErrorCode } from "./error-codes";
import { ArtifactPreset, DesignKit, DesignKitChange, UpdatedBy } from "./design-kit";
import { KnockAskInput, KnockGuideInput, KnockSettingsInput, KnockThemesInput, KnockUpdateInput, McpContent } from "./mcp";

// One event notification (docs/protocol-mvp.md "Events").
export const Event = z.object({
  type: EventType,
  case_id: z.string().optional(),
  reply_id: z.string().optional(),
  session_id: z.string().optional(),
  at: z.string(),
});
export type Event = z.infer<typeof Event>;

// --- App and CLI methods (docs/protocol-mvp.md "Socket RPC") ---

export const CasesListParams = z.object({
  status: z.enum(["needs_you", "waiting_on_agent", "resolved"]).optional(),
});
export type CasesListParams = z.infer<typeof CasesListParams>;
// A `cases.list` row is a Case that leaves out `first_options` while it equals `options` (PERF-4).
// A missing value means "same as options".
export const CaseListRow = Case.extend({ first_options: Case.shape.first_options.optional() });
export type CaseListRow = z.infer<typeof CaseListRow>;

// cases.auto_decided (WAG-412): the cases a rule decided since `since` (an ISO time, default: all), newest first.
// A case leaves the list when the person changes their mind: its new reply makes it a normal answered case.
export const CasesAutoDecidedParams = z.object({ since: z.string().optional() });
export type CasesAutoDecidedParams = z.infer<typeof CasesAutoDecidedParams>;

export function toCaseListRow(c: z.infer<typeof Case>): CaseListRow {
  if (JSON.stringify(c.first_options) !== JSON.stringify(c.options)) return c;
  const { first_options: _same, ...row } = c;
  return row;
}

export const CasesGetParams = z.object({ id: z.string() });
export type CasesGetParams = z.infer<typeof CasesGetParams>;

// capture.image (PERF-2): one capture's image, fetched when the app shows it.
// `cases.get` and the reply echoes carry no image data.
export const CaptureImageParams = z.object({
  capture_id: z.string().min(1),
  which: z.enum(["raw", "annotated"]),
});
export type CaptureImageParams = z.infer<typeof CaptureImageParams>;
export const CaptureImageResult = z.object({
  capture_id: z.string(),
  which: z.enum(["raw", "annotated"]),
  png_base64: z.string(),
});
export type CaptureImageResult = z.infer<typeof CaptureImageResult>;

export const ArtifactPathParams = z.object({
  case_id: z.string(),
  revision: z.number().int().positive(),
});
export type ArtifactPathParams = z.infer<typeof ArtifactPathParams>;
export const ArtifactPathResultSchema = ArtifactPathResult;

// revision.add_by_human (HAIL-168): the person edited a markdown revision in place and pressed Done.
// The daemon stores their markdown as the next revision of the case, author "you". Generic on
// purpose: a case id, the revision the person started from, and the markdown.
export const RevisionAddByHumanParams = z.object({
  case_id: z.string().min(1),
  base_revision: z.number().int().positive(),
  markdown: z.string(),
});
export type RevisionAddByHumanParams = z.infer<typeof RevisionAddByHumanParams>;

export const ReplySubmitParams = z.object({
  case_id: z.string(),
  idempotency_key: z.string(),
  choice: z.string().optional(),
  // Option ids for a select "many" ask (HAIL-123). Validated against the option set; length <=
  // its max. An empty list needs a message.
  choices: z.array(z.string()).optional(),
  // The answers to the points of a multi-question request. Checked against the case's questions.
  answers: PointAnswers.optional(),
  // WAG-312: the answers by item id. `choice` and `choices` mean item 0 of a single-item ask; legacy
  // `answers` keys "<question>/<point>" map to item ids. Checked in the store.
  item_answers: ItemAnswers.optional(),
  // Which option set `choice` is from (HAIL-108): "first" is the ask's own set;
  // omitted or "latest" is the newest. Only matters when both sets use the same id.
  options_set: z.enum(["first", "latest"]).optional(),
  message: z.string().optional(),
  comments: z.array(Comment),
  captures: z.array(Capture),
  // "decision" (default) or "more_detail" (HAIL-33). Older clients that omit
  // it are unaffected.
  intent: ReplyIntent.default("decision"),
  // A discuss reply (WAG-301): option ids the human leans to and rules out. Checked in the store: only
  // a discuss reply carries them, ids must be offered, and at least one of leaning, ruled_out and
  // message is not empty.
  leaning: z.array(z.string()).optional(),
  ruled_out: z.array(z.string()).optional(),
  // The format a more_detail reply asks for (HAIL-139): "eli5" | "diagram" |
  // "page". Optional; a detail request without one behaves as before.
  format: ReplyFormat.optional(),
  // Where the reply comes from (HAIL-144). Omitted means "mac". Chat connectors submit in-process.
  source: ReplySource.default("mac"),
  // The revision by "you" this reply carries as the person's edit (HAIL-168), made earlier with
  // revision.add_by_human.
  edit: z.object({ revision: z.number().int().positive() }).optional(),
  // WAG-345: files staged in KNOCK_HOME/incoming/. At most 10, 25 MB each. Additive: an older app omits it.
  attachments: z.array(ReplyAttachmentInput).optional(),
});
export type ReplySubmitParams = z.infer<typeof ReplySubmitParams>;

export const ReplyRetryParams = z.object({ reply_id: z.string() });
export type ReplyRetryParams = z.infer<typeof ReplyRetryParams>;
// WAG-410: marks a failed reply handed_over after "Continue in a new session".
export const ReplyHandOverParams = z.object({ reply_id: z.string() });
export type ReplyHandOverParams = z.infer<typeof ReplyHandOverParams>;

// reply.replace (HAIL-34): changes a queued reply's choice/message/comments/
// captures in place - the answer is editable up to the moment the agent
// picks it up. Allowed only while the reply is still `queued`; rejected with
// a clear error once it is `delivered` or `failed`. Always returns the same
// reply id (never a second reply), with `replaced_at` set to now and
// `created_at` untouched (docs/protocol-mvp.md "Case and reply states").
export const ReplyReplaceParams = z.object({
  reply_id: z.string().min(1),
  choice: z.string().optional(),
  choices: z.array(z.string()).optional(),
  answers: PointAnswers.optional(),
  item_answers: ItemAnswers.optional(),
  options_set: z.enum(["first", "latest"]).optional(),
  message: z.string().optional(),
  // As in reply.submit, for a queued discuss reply (WAG-301).
  leaning: z.array(z.string()).optional(),
  ruled_out: z.array(z.string()).optional(),
  comments: z.array(Comment),
  captures: z.array(Capture),
  // As in reply.submit. Omitted drops the edit from the reply (HAIL-168 Remove).
  edit: z.object({ revision: z.number().int().positive() }).optional(),
  // As in reply.submit. A file the reply holds is named by its stored `path`. Omitted keeps the files the
  // reply holds; an empty list drops them all.
  attachments: z.array(ReplyAttachmentInput).optional(),
});
export type ReplyReplaceParams = z.infer<typeof ReplyReplaceParams>;

// case.dismiss (HAIL-32): sets the case to resolved with a dismissed_at,
// idempotently. A live case.wait for this case settles with a dismissal
// message instead of hanging or erroring (docs/protocol-mvp.md "Case and
// reply states").
export const CaseDismissParams = z.object({ case_id: z.string().min(1) });
export type CaseDismissParams = z.infer<typeof CaseDismissParams>;
// case.change_mind (WAG-412): "Change my mind" on a case a rule decided. The case becomes a normal open ask again
// (needs_you), so the person picks another option in the usual pane and the pick goes to the agent as a normal reply.
export const CaseChangeMindParams = z.object({ case_id: z.string().min(1) });
export type CaseChangeMindParams = z.infer<typeof CaseChangeMindParams>;

// case.restore (HAIL-32): the Undo half of case.dismiss. Clears dismissed_at
// and puts the case back in the status it held right before the dismiss.
export const CaseRestoreParams = z.object({ case_id: z.string().min(1) });
export type CaseRestoreParams = z.infer<typeof CaseRestoreParams>;

// events.subscribe streams Event notifications back to the caller.
export const EventsSubscribeParams = z.object({});
export type EventsSubscribeParams = z.infer<typeof EventsSubscribeParams>;

export const ServiceStatusParams = z.object({});
export type ServiceStatusParams = z.infer<typeof ServiceStatusParams>;

// service.restart (KNOCK-21): the app asks the daemon to exit cleanly after it
// flushes writes, so the next on-demand start runs the newer binary. The daemon
// replies immediately and then drains in-flight reply deliveries (at most 10 s)
// before it stops.
export const ServiceRestartParams = z.object({});
export type ServiceRestartParams = z.infer<typeof ServiceRestartParams>;
export const ServiceRestartResult = z.object({ ok: z.literal(true) });
export type ServiceRestartResult = z.infer<typeof ServiceRestartResult>;

// usage.record (KNOCK-19, HAIL-83): the app reports the events it owns. Every
// event is a strict object of closed enums, so a title, path, id or any free
// string is rejected. The daemon then validates the record again with the
// closed-enum write schema it uses for every usage event (daemon/src/usage).
const CaseOpenedSource = z.enum([
  "notification",
  "menu_bar",
  "queue",
  "sessions_panel",
  "auto_advance",
  "keyboard",
]);
// WAG-366: the app may name the ask an event is about. The daemon stores only a salted hash of it
// (`ask_h`), never the id, so the report can count per ask.
const AskRef = { case_id: z.string().min(1).max(100).optional() };
const PreviewFields = { artifact_kind: UsageArtifactKind, after_s: UsageAfter, ...AskRef };
const bare = (event: string) => z.strictObject({ event: z.literal(event) });
const onAsk = (event: string) => z.strictObject({ event: z.literal(event), ...AskRef });
const withVariant = <T extends z.ZodTypeAny>(event: string, variant: T) =>
  z.strictObject({ event: z.literal(event), variant });
export const UsageRecordParams = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("case_opened"), source: CaseOpenedSource, ...AskRef }),
  onAsk("comment_mode_started"),
  z.strictObject({ event: z.literal("artifact_opened_full"), ...PreviewFields }),
  z.strictObject({ event: z.literal("review_opened"), ...PreviewFields }),
  z.strictObject({ event: z.literal("preview_interacted"), artifact_kind: UsageArtifactKind, ...AskRef }),
  z.strictObject({ event: z.literal("option_picked"), source: z.enum(["click", "number_key"]), ...AskRef }),
  z.strictObject({
    event: z.literal("recommendation_accepted"),
    source: z.enum(["button", "shortcut"]),
    ...AskRef,
  }),
  onAsk("reply_typed"),
  // WAG-367: `source` "button" when the three dots pill of the "Ask for" row opened the panel.
  z.strictObject({
    event: z.literal("ask_more_detail_opened"),
    source: z.literal("button").optional(),
    ...AskRef,
  }),
  onAsk("change_answer_started"),
  onAsk("go_back_clicked"),
  bare("sessions_panel_opened"),
  bare("session_detail_opened"),
  z.strictObject({
    event: z.literal("screenshot_zoom_changed"),
    variant: z.enum(["fit", "100", "zoom"]),
    ...AskRef,
  }),
  onAsk("screenshot_set_view_opened"),
  // WAG-413: `artifact_kind` says what the comment was made on (a screenshot, a set of screenshots or a prototype).
  z.strictObject({
    event: z.literal("comment_added"),
    variant: z.enum(["point", "region"]),
    artifact_kind: UsageArtifactKind.optional(),
    ...AskRef,
  }),
  onAsk("nudge_clicked"),
  bare("copy_prompt_clicked"),
  // WAG-366: app use, and the screens added after HAIL-83.
  bare("app_launched"),
  bare("app_active"),
  bare("onboarding_started"),
  withVariant("onboarding_agent_connected", UsageAgent),
  bare("onboarding_continued"),
  bare("first_job_started"),
  bare("first_job_finished"),
  bare("onboarding_prompt_copied"),
  bare("tour_started"),
  bare("tour_finished"),
  bare("tour_skipped"),
  withVariant("getting_started_line_opened", UsageStartedLine),
  bare("getting_started_hidden"),
  withVariant("settings_page_opened", UsageSettingsPage),
  bare("usage_exported"),
  bare("new_idea_opened"),
  z.strictObject({
    event: z.literal("new_idea_started"),
    variant: UsageLaunchTarget,
    n: z.number().int().nonnegative().max(1000).optional(),
  }),
  withVariant("launch_target_chosen", UsageLaunchTarget),
  bare("project_page_opened"),
  bare("update_prompt_shown"),
  bare("update_install_clicked"),
  bare("update_later_clicked"),
  bare("update_skipped"),
  bare("update_restart_clicked"),
  bare("whats_new_opened"),
  withVariant("split_fold_toggled", UsageFold),
  onAsk("sources_list_opened"),
  onAsk("source_opened"),
  onAsk("artifact_variant_selected"),
  // A detail request was sent from the panel: a format row (`format`), or a quick ask or the typed
  // one (`format` "none" and `variant`).
  z.strictObject({
    event: z.literal("detail_format_picked"),
    format: UsageFormat,
    variant: UsageDetailPick.optional(),
    // WAG-367: 1 when a pill of the "Ask for" row sent it, absent for a row of the panel.
    n: z.literal(1).optional(),
    ...AskRef,
  }),
  // WAG-411 pass 2: a quick reply chip above the input sent its reply. The word is a code, never the text.
  z.strictObject({ event: z.literal("quick_reply_picked"), variant: UsageQuickReply, ...AskRef }),
  // WAG-413: the Compare switch was turned on or off. The word is a code, never text.
  z.strictObject({ event: z.literal("compare_toggled"), variant: UsageCompare, ...AskRef }),
]);
export type UsageRecordParams = z.infer<typeof UsageRecordParams>;
export const UsageRecordResult = z.object({ ok: z.literal(true) });
export type UsageRecordResult = z.infer<typeof UsageRecordResult>;

// --- Tool-call log (HAIL-195) ---
//
// usage.tool_call: the shim reports one finished MCP tool call. Content-free by construction: a
// strict object of sizes, times, ids and closed words. No ask text, reply text, artifact content or
// path can fit in it. The daemon turns the two sizes into the token estimate.
// usage.context: the Claude Code mod reports the usage numbers of the agent's latest assistant
// message for the tool call about to run (numbers only). usage.summary reads the token view (no dollars, HAIL-199),
// usage.export writes the export file, usage.control reads and changes the switches.
const ToolName = z.string().regex(/^[a-z][a-z_]{0,39}$/);
const Count = z.number().int().nonnegative().max(2_000_000_000);
export const UsageToolResultKind = z.enum([
  "answered",
  "pending",
  "ok",
  "error_connection",
  "error_invalid",
  "error_artifact",
  "error_other",
]);
export type UsageToolResultKind = z.infer<typeof UsageToolResultKind>;
export const UsageToolCallParams = z.strictObject({
  tool: ToolName,
  duration_ms: Count,
  wait_ms: Count,
  result: UsageToolResultKind,
  session_id: z.string().min(1).max(100).optional(),
  client_name: z.string().regex(/^[A-Za-z0-9._ -]{1,60}$/).optional(),
  case_id: z.string().min(1).max(100).optional(),
  artifact_kind: UsageArtifactKind.optional(),
  // WAG-409: the stable code of the error, set only when result is an error_* word. Never the text.
  error_code: ToolErrorCode.optional(),
  request_bytes: Count,
  response_bytes: Count,
  images: Count,
});
export type UsageToolCallParams = z.infer<typeof UsageToolCallParams>;
export const UsageContextParams = z.strictObject({
  session_id: z.string().min(1).max(100),
  tool: ToolName,
  input: Count,
  cache_read: Count,
  cache_creation: Count,
  output: Count,
});
export type UsageContextParams = z.infer<typeof UsageContextParams>;

export const UsageSummaryParams = z.strictObject({ days: z.number().int().min(1).max(3650).optional() });
export type UsageSummaryParams = z.infer<typeof UsageSummaryParams>;
export const UsageToolRow = z.object({
  tool: z.string(),
  calls: z.number(),
  tokens_written: z.number(),
  tokens_received: z.number(),
  context_tokens: z.number(),
  waited_s: z.number(),
});
export const UsageSessionRow = z.object({
  session_id: z.string(),
  client_name: z.string().nullable(),
  calls: z.number(),
  tokens: z.number(),
});
export const UsageErrorRow = z.object({ result: z.string(), error_code: z.string(), calls: z.number() });
export const UsageSummaryResult = z.object({
  days: z.number(),
  record: z.boolean(),
  transcript: z.boolean(),
  export_text: z.boolean(),
  retention_days: z.number(),
  calls: z.number(),
  tokens_written: z.number(),
  tokens_received: z.number(),
  context_tokens: z.number(),
  context_measured_calls: z.number(),
  tools: z.array(UsageToolRow),
  // The share of the tokens spent in waggle_check, a call that waits for the person.
  wait_calls: z.number(),
  wait_share: z.number().nullable(),
  waited_s: z.number(),
  top_sessions: z.array(UsageSessionRow),
  // WAG-409: the failed calls grouped by code. Absent from an older daemon.
  errors: z.array(UsageErrorRow).optional(),
  tokens_per_image: z.number(),
  bytes_per_token: z.number(),
});
export type UsageSummaryResult = z.infer<typeof UsageSummaryResult>;

export const UsageExportParams = z.strictObject({ path: z.string().min(1).max(4096) });
export type UsageExportParams = z.infer<typeof UsageExportParams>;
export const UsageExportResult = z.object({
  json_path: z.string(),
  csv_path: z.string(),
  tool_calls: z.number(),
  usage_events: z.number(),
  // WAG-366: the replies whose text the file holds. 0 unless the person turned the text switch on.
  notes: z.number(),
});
export type UsageExportResult = z.infer<typeof UsageExportResult>;

// `record` is the one switch "Record usage on this Mac"; `transcript` is "Measure token use from
// my agent's session log"; `delete: true` deletes every usage row (tool calls and hourly events).
// `export_text` (WAG-366) is "Include my notes and comments in the export", off until the person turns it on.
export const UsageControlParams = z.strictObject({
  record: z.boolean().optional(),
  transcript: z.boolean().optional(),
  export_text: z.boolean().optional(),
  delete: z.literal(true).optional(),
});
export type UsageControlParams = z.infer<typeof UsageControlParams>;
export const UsageControlResult = z.object({
  record: z.boolean(),
  transcript: z.boolean(),
  export_text: z.boolean(),
  retention_days: z.number(),
  tool_calls: z.number(),
  usage_events: z.number(),
  deleted: z.number(),
});
export type UsageControlResult = z.infer<typeof UsageControlResult>;

// mcp.manifest (HAIL-48): the tool surface `waggle mcp` serves, read live from
// the running daemon build. The shim fetches this on every fresh connection
// (startup, and any reconnect after the daemon restarts for an update) and
// serves `tools/list` from it, falling back to its own compiled-in copy of
// `MCP_TOOLS` when an older daemon has no such method (KNOCK-21-style
// compatibility). `daemon_version` is the same version `service.status`
// reports; the shim compares it across a reconnect to decide whether to send
// `notifications/tools/list_changed`, never on the first connect.
export const McpManifestParams = z.object({});
export type McpManifestParams = z.infer<typeof McpManifestParams>;
export const McpManifestToolResult = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type McpManifestToolResult = z.infer<typeof McpManifestToolResult>;
export const McpManifestResult = z.object({
  daemon_version: z.string(),
  tools: z.array(McpManifestToolResult),
});
export type McpManifestResult = z.infer<typeof McpManifestResult>;

// guide.get (HAIL-48): waggle_guide's content, read live from the running
// daemon build instead of compiled into the shim, so an already-open session
// sees an updated guide without a restart. Same input as waggle_guide
// (KnockGuideInput): omit `topic` for the index, name one for its full text.
// An unknown topic is a normal RPC failure (-32603, docs/protocol-mvp.md
// "Errors that say what to tell the user" - this one is for the agent to fix
// by calling again, not for the human), carrying the same message
// `getGuide` has always thrown, naming every valid topic.
//
// HAIL-163: `flavour: "desktop"` (the shim sets it for a session that is not Claude Code) adds the
// desktop section: keep calling waggle_check, send artifacts as content, pass a topic. Absent for
// Claude Code, which gets today's text.
export const GuideGetParams = KnockGuideInput.extend({
  flavour: z.enum(["desktop"]).optional(),
  // WAG-260: the asking session. The `project` topic reads that session's project.
  session_id: z.string().optional(),
});
export type GuideGetParams = z.infer<typeof GuideGetParams>;
export const GuideGetResult = z.object({ text: z.string() });
export type GuideGetResult = z.infer<typeof GuideGetResult>;

// cases.resolved_stats (HAIL-52): the count and on-disk byte size of every
// resolved case (dismissed via case.dismiss, or withdrawn via a later ask's
// `replaces` - the only two ways a case reaches `resolved`), for the Data &
// privacy page's "Answered asks" row. Read-only; cases.purge_resolved is the
// write half.
export const CasesResolvedStatsParams = z.object({});
export type CasesResolvedStatsParams = z.infer<typeof CasesResolvedStatsParams>;
export const CasesResolvedStatsResult = z.object({
  count: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type CasesResolvedStatsResult = z.infer<typeof CasesResolvedStatsResult>;

// cases.purge_resolved (HAIL-52): deletes every resolved case - its messages,
// replies, comments, captures and revisions, then its staged bundle
// directories and any blob no surviving case's revision still references
// (blobs are content-addressed and can be shared across cases). Never a case
// that needs the human or is waiting on the agent - only `status: "resolved"`
// ever qualifies. Idempotent: purging with nothing resolved returns zeros.
export const CasesPurgeResolvedParams = z.object({});
export type CasesPurgeResolvedParams = z.infer<typeof CasesPurgeResolvedParams>;
export const CasesPurgeResolvedResult = z.object({
  purged_cases: z.number().int().nonnegative(),
  freed_bytes: z.number().int().nonnegative(),
});
export type CasesPurgeResolvedResult = z.infer<typeof CasesPurgeResolvedResult>;

// sessions.list (HAIL-46): a read-only, app/CLI-facing view of every session
// the daemon knows about, for `waggle doctor`'s "sessions" section and the
// app's Connection screen. Not a session method: the calling connection
// need not have said session.hello itself.
// HAIL-76: the app asks the daemon to nudge the session that owns a case whose
// reply is still queued. The daemon pushes `session.nudge` to the shim.
export const SessionNudgeParams = z.object({ case_id: z.string().min(1) });
export type SessionNudgeParams = z.infer<typeof SessionNudgeParams>;
export const SessionNudgeReason = z.enum([
  "session_closed",
  "not_supported",
  "already_picked_up",
  "rate_limited",
  "post_failed",
]);
export type SessionNudgeReason = z.infer<typeof SessionNudgeReason>;
export const SessionNudgeResult = z.union([
  z.object({ sent: z.literal(true) }),
  z.object({ sent: z.literal(false), reason: SessionNudgeReason }),
]);
export type SessionNudgeResult = z.infer<typeof SessionNudgeResult>;

// HAIL-169: the app sends one prompt, typed by the person in the "Start from a document"
// sheet, into a live Claude Code session. Only the mod can carry the text (the messaging-socket
// nudge posts a fixed line), so a session without an attached mod answers `not_supported`.
export const SessionSendPromptParams = z
  .object({
    session_id: z.string().min(1),
    text: z.string().min(1).max(20_000),
  })
  .strict();
export type SessionSendPromptParams = z.infer<typeof SessionSendPromptParams>;
export const SessionSendPromptReason = z.enum(["session_closed", "not_supported", "post_failed"]);
export type SessionSendPromptReason = z.infer<typeof SessionSendPromptReason>;
export const SessionSendPromptResult = z.union([
  z.object({ sent: z.literal(true) }),
  z.object({ sent: z.literal(false), reason: SessionSendPromptReason }),
]);
export type SessionSendPromptResult = z.infer<typeof SessionSendPromptResult>;

export const SessionsListParams = z.object({});
export type SessionsListParams = z.infer<typeof SessionsListParams>;

// --- Session methods (shim only) ---

// session.hello: the shim identifies itself on start with CLAUDE_CODE_SESSION_ID
// when present (else it generates a UUID), plus cwd, git branch and its parent
// pid. `runtime` is optional so an older shim binary that predates KNOCK-20
// still works; the daemon defaults a missing value to "claude". client_version
// is optional too (KNOCK-21): an old shim that omits it is served with the
// current protocol. Protocol changes from here on are additive.
export const SessionHelloParams = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  branch: z.string().nullable().optional(),
  // The git root the shim resolved from cwd (HAIL-26). Optional so an older
  // shim that omits it is still served; the daemon then falls back to the
  // basename of cwd as a string.
  git_root: z.string().nullable().optional(),
  parent_pid: z.number().int().nonnegative(),
  runtime: Runtime.optional(),
  client_version: z.string().optional(),
  // HAIL-76: whether the shim can wake its session with a nudge (it holds the
  // Claude Code inbox socket and token, and the parent is 2.1.224 or later).
  // Optional and additive; an older shim omits it, which reads as false.
  can_nudge: z.boolean().optional(),
  // HAIL-173: the MCP client that started the shim (clientInfo.name from `initialize`, or
  // "claude-code" when the shim only sees CLAUDE_CODE_* variables). Optional and additive; the daemon
  // keeps the last value it was given.
  client_name: z.string().min(1).max(200).optional(),
  // HAIL-222: the git footprint of cwd, computed by the shim (the daemon never reads the project
  // folder). Null means not a repository. Omitted by an older shim: the daemon keeps the last value.
  changes: SessionChanges.nullable().optional(),
});
export type SessionHelloParams = z.infer<typeof SessionHelloParams>;
export const SessionHelloResult = z.object({
  session_id: z.string(),
  task_id: z.string(),
});
export type SessionHelloResult = z.infer<typeof SessionHelloResult>;

// case.create mirrors waggle_ask and returns the created case. When the ask
// carries `replaces` and the case it replaced still had a queued reply
// (HAIL-44), `replaced_answer_note` carries the fixed sentence waggle_ask
// prepends to its result so the agent never loses that answer: "The human
// had already answered the ask you replaced: <choice/message>." Null every
// other time, including for cases.list/cases.get - only case.create ever
// sets this. `words_warning` (HAIL-140) carries the one line waggle_ask
// prepends when the ask breaks an ASD-STE100 limit in "asd" mode; null when
// the ask is clean or the mode is "normal".
//
// HAIL-197: `client_request_id` makes the call idempotent. The shim makes one per waggle_ask call and
// reuses it on every retry; the daemon returns the first case for the same session and id. Optional,
// so an older shim that sends none creates a case each time, as before. It lives here, not on
// KnockAskInput, so the agent never sees it in the tool schema.
export const CaseCreateParams = z.intersection(
  KnockAskInput,
  z.object({
    client_request_id: z.string().min(8).max(100).optional(),
    // WAG-416: the shim says it can show a hold (below). Without it the daemon never holds an ask, so an older
    // shim keeps working against this daemon. Not part of the agent's tool schema.
    accepts_hold: z.boolean().optional(),
  }),
);
export type CaseCreateParams = z.infer<typeof CaseCreateParams>;
export const CaseCreateResult = Case.extend({
  replaced_answer_note: z.string().nullable(),
  words_warning: z.string().nullable(),
});
export type CaseCreateResult = z.infer<typeof CaseCreateResult>;

// WAG-416: the other answer of case.create. A decision ask that fits past decisions of its project is held once:
// no case is created. `matches` holds up to 3 strong matches, best first. The same ask sent again (same session and
// title, within 15 minutes) creates the case, and the case stores these ids as `matched_case_ids`.
export const DecidedMatch = z.object({
  case_id: z.string(),
  question: z.string(),
  pick: z.string(),
  why: z.string(),
  date: z.string(),
});
export type DecidedMatch = z.infer<typeof DecidedMatch>;
export const CaseHoldResult = z.object({
  held: z.literal(true),
  matches: z.array(DecidedMatch).min(1).max(3),
});
export type CaseHoldResult = z.infer<typeof CaseHoldResult>;

// case.wait: same wait and return shape as waggle_ask / waggle_check. The reply
// payload carries its reply_id so the shim can acknowledge it afterwards.
export const CaseWaitParams = z.object({
  case_id: z.string().min(1),
  wait_ms: z.number().int().positive(),
});
export type CaseWaitParams = z.infer<typeof CaseWaitParams>;
// What the agent sees of a team comment (WAG-387): who, what they said, and where. Never a reply.
// WAG-394: `id` is what the agent names in waggle_update reply_to_comment. `new` is true only for a comment
// the agent has not been given yet. `reply_to` is the id of the first comment of the thread (null for a first
// comment). `resolved` is true when its thread was resolved.
export const AgentSharedComment = z.object({
  id: z.string(),
  author_name: z.string(),
  author_kind: z.enum(["owner", "member", "guest", "agent"]),
  author_email: z.string().nullable(),
  body: z.string(),
  quote: z.string().nullable(),
  area: z.string().nullable(),
  revision: z.number().int().nullable(),
  created_at: z.string(),
  reply_to: z.string().nullable(),
  resolved: z.boolean(),
  new: z.literal(true).optional(),
});
export type AgentSharedComment = z.infer<typeof AgentSharedComment>;
export const CaseWaitReply = z.object({
  reply_id: z.string(),
  content: z.array(McpContent),
  // Only on a shared case that has comments (WAG-387).
  shared_comments: z.array(AgentSharedComment).optional(),
});
export type CaseWaitReply = z.infer<typeof CaseWaitReply>;

// case.update mirrors waggle_update and returns the updated case. `words_warning`
// (HAIL-140) carries the one line waggle_update appends when the new proposal
// breaks an ASD-STE100 limit in "asd" mode; null otherwise.
export const CaseUpdateParams = KnockUpdateInput;
export type CaseUpdateParams = z.infer<typeof CaseUpdateParams>;
export const CaseUpdateResult = Case.extend({
  words_warning: z.string().nullable(),
  // WAG-394: one plain line when reply_to_comment could not be posted. Absent or null otherwise.
  comment_reply: z.string().nullable().optional(),
});
export type CaseUpdateResult = z.infer<typeof CaseUpdateResult>;

// reply.ack: the shim confirms it received a reply payload. Only then does the
// daemon mark the reply delivered (AC 8).
export const ReplyAckParams = z.object({
  reply_id: z.string().min(1),
});
export type ReplyAckParams = z.infer<typeof ReplyAckParams>;

// settings.get / settings.set (HAIL-100, HAIL-101): operator settings the daemon
// persists (the app never writes knock.db). Keys:
// - `artifactPreset` (HAIL-100): how agents build the artifacts they send. Unset
//   reads as "visual". Its instructions are appended to the waggle_guide
//   "artifacts" topic on every read.
// - `askTopics`, `askFrequency`, `askDetail` (HAIL-101), `askReach` (HAIL-109): what agents bring the
//   operator, how often, and how rich each ask is. The daemon turns them into one
//   text (`askText`, read-only) that `waggle mcp` serves on initialize and
//   waggle_guide serves in its index.
export { ArtifactPreset } from "./design-kit";
export const DEFAULT_ARTIFACT_PRESET: ArtifactPreset = "visual";

export const AskTopic = z.enum([
  "marketing",
  "design",
  "operations",
  "pricing",
  "code",
  "writing",
  "data",
  "personal",
  "reviews",
  "private_info",
]);
export type AskTopic = z.infer<typeof AskTopic>;
// scope "any": every topic, `picked` is kept but not used. scope "pick": only `picked`.
export const AskTopics = z
  .object({ scope: z.enum(["any", "pick"]), picked: z.array(AskTopic).max(AskTopic.options.length) })
  .strict();
export type AskTopics = z.infer<typeof AskTopics>;
export const DEFAULT_ASK_TOPICS: AskTopics = {
  scope: "any",
  picked: ["design", "code", "writing", "reviews", "private_info"],
};
export const AskFrequency = z.enum(["blocked", "choice", "chat"]);
export type AskFrequency = z.infer<typeof AskFrequency>;
export const DEFAULT_ASK_FREQUENCY: AskFrequency = "choice";
export const AskDetail = z.enum(["brief", "rich"]);
export type AskDetail = z.infer<typeof AskDetail>;
export const DEFAULT_ASK_DETAIL: AskDetail = "brief";
// askReach (HAIL-109): how much of what agents ask comes to Waggle. "visual" only
// asks with something to look at; "written" also write-ups and drafts; "everything"
// every ask (today's behaviour). "off" (HAIL-193): no ask comes to Waggle; agents ask in the terminal
// and waggle_ask creates no case.
export const AskReach = z.enum(["off", "visual", "written", "everything"]);
export type AskReach = z.infer<typeof AskReach>;
export const DEFAULT_ASK_REACH: AskReach = "everything";
// askWords (HAIL-140): how agents write their asks. "asd" (default) asks for
// ASD-STE100 Simplified Technical English and warns when an ask breaks its
// limits; "normal" is today's guidance, no warning.
export const AskWords = z.enum(["asd", "normal"]);
export type AskWords = z.infer<typeof AskWords>;
export const DEFAULT_ASK_WORDS: AskWords = "asd";
// askLearn (WAG-384): how the person likes to learn. It shapes the answer to a "how it works"
// request. "short" (default): up to 3 short lines; "diagram": a diagram first; "steps": numbered
// steps; "try": a small page to click through.
export const AskLearn = z.enum(["short", "diagram", "steps", "try"]);
export type AskLearn = z.infer<typeof AskLearn>;
export const DEFAULT_ASK_LEARN: AskLearn = "short";
// askAfterDecide (WAG-385): what the agent does once the human has decided. "none": nothing new.
// "record": write a decision record. "record_tasks" (default): write the record, then plan tasks from it.
export const AskAfterDecide = z.enum(["none", "record", "record_tasks"]);
export type AskAfterDecide = z.infer<typeof AskAfterDecide>;
export const DEFAULT_ASK_AFTER_DECIDE: AskAfterDecide = "record_tasks";

// catchQuestions (WAG-265): "on" (default) lets the Claude Code Stop hook block a stop once when the
// last message asks the human something in the terminal. The daemon keeps it as the marker file
// `catch-questions-off` in the data root, which the hook reads with no daemon running.
export const CatchQuestions = z.enum(["on", "off"]);
export type CatchQuestions = z.infer<typeof CatchQuestions>;
// askLess (WAG-412): "Let the agent decide small things". `enabled` is the master switch; `rules` has one
// switch per category. All off by default. The daemon keeps every rule off while the master is off.
export const AskLess = z
  .object({
    enabled: z.boolean(),
    rules: z.object({ naming: z.boolean(), wording: z.boolean(), formatting: z.boolean(), tests: z.boolean() }).strict(),
  })
  .strict();
export type AskLess = z.infer<typeof AskLess>;
export const DEFAULT_ASK_LESS: AskLess = {
  enabled: false,
  rules: { naming: false, wording: false, formatting: false, tests: false },
};
export const SettingsKey = z.enum(["artifactPreset", "askTopics", "askFrequency", "askDetail", "askReach", "askWords", "askLearn", "askAfterDecide", "catchQuestions", "askLess"]);
export type SettingsKey = z.infer<typeof SettingsKey>;
// settings.get also reads `askText`, the generated agent text. It is derived, so
// settings.set rejects it.
export const SettingsGetKey = z.enum([...SettingsKey.options, "askText"]);
export type SettingsGetKey = z.infer<typeof SettingsGetKey>;
export const SettingsGetParams = z.object({ key: SettingsGetKey }).strict();
export type SettingsGetParams = z.infer<typeof SettingsGetParams>;
export const SettingsSetParams = z.discriminatedUnion("key", [
  z.object({ key: z.literal("artifactPreset"), value: ArtifactPreset }).strict(),
  z.object({ key: z.literal("askTopics"), value: AskTopics }).strict(),
  z.object({ key: z.literal("askFrequency"), value: AskFrequency }).strict(),
  z.object({ key: z.literal("askDetail"), value: AskDetail }).strict(),
  z.object({ key: z.literal("askReach"), value: AskReach }).strict(),
  z.object({ key: z.literal("askWords"), value: AskWords }).strict(),
  z.object({ key: z.literal("askLearn"), value: AskLearn }).strict(),
  z.object({ key: z.literal("askAfterDecide"), value: AskAfterDecide }).strict(),
  z.object({ key: z.literal("catchQuestions"), value: CatchQuestions }).strict(),
  z.object({ key: z.literal("askLess"), value: AskLess }).strict(),
]);
export type SettingsSetParams = z.infer<typeof SettingsSetParams>;
export const SettingsResult = z.discriminatedUnion("key", [
  z.object({ key: z.literal("artifactPreset"), value: ArtifactPreset }),
  z.object({ key: z.literal("askTopics"), value: AskTopics }),
  z.object({ key: z.literal("askFrequency"), value: AskFrequency }),
  z.object({ key: z.literal("askDetail"), value: AskDetail }),
  z.object({ key: z.literal("askReach"), value: AskReach }),
  z.object({ key: z.literal("askWords"), value: AskWords }),
  z.object({ key: z.literal("askLearn"), value: AskLearn }),
  z.object({ key: z.literal("askAfterDecide"), value: AskAfterDecide }),
  z.object({ key: z.literal("catchQuestions"), value: CatchQuestions }),
  z.object({ key: z.literal("askLess"), value: AskLess }),
  z.object({ key: z.literal("askText"), value: z.string() }),
]);
export type SettingsResult = z.infer<typeof SettingsResult>;

// --- Chat connectors (HAIL-144) ---
//
// Off by default. The daemon calls a chat service only after the operator connects it here.
// States: "off" (no token), "token_checked" (the bot is real, no chat yet), "waiting_for_start"
// (the operator must send `/start <code>` to the bot), "connected" (a chat is saved).
// The bot token goes to the macOS Keychain and never comes back over the socket.
export const ConnectorState = z.enum(["off", "token_checked", "waiting_for_start", "connected"]);
export type ConnectorState = z.infer<typeof ConnectorState>;
export const TelegramStatus = z.object({
  state: ConnectorState,
  bot_name: z.string().nullable(),
  bot_username: z.string().nullable(),
  // The chat's name as Telegram gave it on /start, once connected.
  chat_label: z.string().nullable(),
  // The one-time code to send while waiting_for_start.
  code: z.string().nullable(),
  // The last problem, in plain words, or null.
  error: z.string().nullable(),
});
export type TelegramStatus = z.infer<typeof TelegramStatus>;

export const ConnectorsStatusParams = z.object({}).strict();
export type ConnectorsStatusParams = z.infer<typeof ConnectorsStatusParams>;
// Slack (HAIL-145) uses the same states: `token_checked` = both tokens are good, `waiting_for_start` = the
// operator must DM the bot the one-time `code`.
export const SlackStatus = z.object({
  state: ConnectorState,
  workspace: z.string().nullable(),
  bot_name: z.string().nullable(),
  // The linked person's name in Slack, once connected.
  user_label: z.string().nullable(),
  // For the deep links in Settings (HAIL-148): the Slack app id (known once the bot token is looked
  // up or both tokens are checked), the workspace id and the bot's user id.
  app_id: z.string().nullable(),
  team_id: z.string().nullable(),
  bot_user_id: z.string().nullable(),
  code: z.string().nullable(),
  // The Slack app manifest (JSON) the operator copies to make the app.
  manifest: z.string(),
  error: z.string().nullable(),
});
export type SlackStatus = z.infer<typeof SlackStatus>;

export const ConnectorsStatusResult = z.object({ telegram: TelegramStatus, slack: SlackStatus });
export type ConnectorsStatusResult = z.infer<typeof ConnectorsStatusResult>;

// --- Sharing a case (WAG-387) ---
//
// Off until the operator turns "Sharing" on in Settings. The daemon then calls one host, the relay,
// and only for a case the operator shared. The owner key goes to the secret store and never comes back.
export const SharingMode = z.enum(["link", "emails"]);
export type SharingMode = z.infer<typeof SharingMode>;
// Where a comment points: a quote with its context, or an area box. Both are optional.
export const SharedCommentBox = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  vw: z.number(),
  near: z.string(),
});
export type SharedCommentBox = z.infer<typeof SharedCommentBox>;
export const SharedComment = z.object({
  id: z.string(),
  // The revision of the case this comment is about, or null when the daemon cannot match it.
  revision: z.number().int().nullable(),
  author_name: z.string(),
  // "owner", "member", "guest" or "agent" (WAG-394). The relay's old "email" kind is "member" (WAG-392).
  author_kind: z.enum(["owner", "member", "guest", "agent"]),
  // Set for an owner and a member, null for a guest.
  author_email: z.string().nullable(),
  body: z.string(),
  quote: z.string().nullable(),
  prefix: z.string().nullable(),
  suffix: z.string().nullable(),
  box: SharedCommentBox.nullable(),
  created_at: z.string(),
  // WAG-394: the first comment of the thread this one answers, or null. One level only.
  parent_id: z.string().nullable(),
  // Set on the first comment of a thread that was resolved.
  resolved_at: z.string().nullable(),
  resolved_by: z.string().nullable(),
  // True for a team comment the owner has not seen yet (cleared by sharing.mark_seen).
  unread: z.boolean(),
});
export type SharedComment = z.infer<typeof SharedComment>;
// Waggle account (WAG-392). Sign-in is a device flow against the relay; the device token lives in the Keychain.
export const AccountState = z.object({
  signed_in: z.boolean(),
  email: z.string().nullable(),
  connect: z.object({ user_code: z.string(), verify_url: z.string(), expires_at: z.number() }).nullable(),
  error: z.string().nullable(),
});
export type AccountState = z.infer<typeof AccountState>;
export const AccountShare = z.object({
  relay_id: z.string(),
  title: z.string(),
  url: z.string(),
  mode: SharingMode,
  created_at: z.number(),
  comment_count: z.number().int(),
  device_label: z.string(),
  // The case on this Mac that is shared as this page, or null.
  local_case_id: z.string().nullable(),
});
export type AccountShare = z.infer<typeof AccountShare>;
export const AccountShares = z.object({ shares: z.array(AccountShare), error: z.string().nullable() });
export type AccountShares = z.infer<typeof AccountShares>;
export const AccountEmptyParams = z.object({}).strict();
export const AccountStopShareParams = z.object({ relay_id: z.string().min(1) }).strict();
export type AccountStopShareParams = z.infer<typeof AccountStopShareParams>;
export const SharingUpdateParams = z
  .object({ case_id: z.string().min(1), mode: SharingMode, emails: z.array(z.string().max(200)).max(50).optional() })
  .strict();
export type SharingUpdateParams = z.infer<typeof SharingUpdateParams>;
export const SharingOpenPageParams = z.object({ case_id: z.string().min(1) }).strict();
export type SharingOpenPageParams = z.infer<typeof SharingOpenPageParams>;
export const SharingOpenPageResult = z.object({ url: z.string() });

export const CaseShare = z.object({
  url: z.string(),
  mode: SharingMode,
  emails: z.array(z.string()),
  // False when this Mac no longer has the owner key: the link cannot be stopped from here (WAG-391).
  stoppable: z.boolean(),
});
export type CaseShare = z.infer<typeof CaseShare>;
// How the invite mails of the last share or audience change went (WAG-392). All zero when none were sent.
export const InviteCounts = z.object({ sent: z.number().int(), failed: z.number().int(), limited: z.number().int() });
export type InviteCounts = z.infer<typeof InviteCounts>;
export const SharingState = z.object({
  // False while the Sharing feature is hidden (SHARING_AVAILABLE): the app hides every sharing control.
  available: z.boolean(),
  enabled: z.boolean(),
  // How many cases are shared now, so Settings can say why the switch cannot go off.
  shared_count: z.number().int(),
  // Null for a case that was never shared (and when no case_id is given).
  share: CaseShare.nullable(),
  // The team's comments. They stay after Stop sharing (WAG-391).
  comments: z.array(SharedComment),
  // The last problem with the relay for this case, in one plain line, or null.
  error: z.string().nullable(),
  // Rounds the relay can never take (too big, too many files), each with a plain reason (WAG-391).
  skipped: z.array(z.object({ revision: z.number().int(), reason: z.string() })),
  invites: InviteCounts,
  account: AccountState,
  // WAG-394: the owner closed the comments of this page.
  comments_closed: z.boolean(),
  // WAG-394: this case was shared before and its link was stopped. Sharing again makes a new link.
  shared_before: z.boolean(),
  // WAG-401: team comments that came after the last decide answer. `new` counts those the agent was not given yet.
  late_comments: z.object({ count: z.number().int(), new: z.number().int() }),
});
export type SharingState = z.infer<typeof SharingState>;
// WAG-394: reply to a thread, resolve it, close the comments, mark them seen, and the notification feed.
export const SharingReplyParams = z.object({ case_id: z.string().min(1), parent_id: z.string().min(1), body: z.string().trim().min(1).max(4000) }).strict();
export type SharingReplyParams = z.infer<typeof SharingReplyParams>;
// WAG-397: a comment from the owner on the page, with no parent.
export const SharingCommentParams = z.object({ case_id: z.string().min(1), body: z.string().trim().min(1).max(4000) }).strict();
export type SharingCommentParams = z.infer<typeof SharingCommentParams>;
export const SharingResolveParams = z.object({ case_id: z.string().min(1), comment_id: z.string().min(1), resolved: z.boolean() }).strict();
export type SharingResolveParams = z.infer<typeof SharingResolveParams>;
export const SharingCloseCommentsParams = z.object({ case_id: z.string().min(1), closed: z.boolean() }).strict();
export type SharingCloseCommentsParams = z.infer<typeof SharingCloseCommentsParams>;
// WAG-401: the page shows the case as open while the owner changes the answer, and as decided again on cancel.
export const SharingReopenParams = z.object({ case_id: z.string().min(1), reopened: z.boolean() }).strict();
export type SharingReopenParams = z.infer<typeof SharingReopenParams>;
// WAG-401: the app sent the late comments to the agent's session.
export const SharingMarkLateGivenParams = z.object({ case_id: z.string().min(1) }).strict();
export type SharingMarkLateGivenParams = z.infer<typeof SharingMarkLateGivenParams>;
export const SharingMarkSeenParams = z.object({ case_id: z.string().min(1) }).strict();
export type SharingMarkSeenParams = z.infer<typeof SharingMarkSeenParams>;
export const SharingEmptyParams = z.object({}).strict();
export const SharingUnread = z.object({ cases: z.array(z.object({ case_id: z.string(), count: z.number().int() })) });
export type SharingUnread = z.infer<typeof SharingUnread>;
// New team comments the app has not told the person about. Taking them marks them told.
export const SharingNotifications = z.object({
  items: z.array(z.object({ case_id: z.string(), case_title: z.string(), comment_id: z.string(), author_name: z.string(), body: z.string() })),
});
export type SharingNotifications = z.infer<typeof SharingNotifications>;
export const SharingGetParams = z.object({ case_id: z.string().min(1).optional() }).strict();
export type SharingGetParams = z.infer<typeof SharingGetParams>;
export const SharingSetEnabledParams = z.object({ enabled: z.boolean() }).strict();
export type SharingSetEnabledParams = z.infer<typeof SharingSetEnabledParams>;
export const SharingStartParams = z
  .object({ case_id: z.string().min(1), mode: SharingMode, emails: z.array(z.string().max(200)).max(50).optional() })
  .strict();
export type SharingStartParams = z.infer<typeof SharingStartParams>;
export const SharingStopParams = z.object({ case_id: z.string().min(1) }).strict();
export type SharingStopParams = z.infer<typeof SharingStopParams>;
// Uploads rounds that are not up yet and fetches the team's new comments. The app sends it when it
// opens a shared case.
export const SharingRefreshParams = z.object({ case_id: z.string().min(1) }).strict();
export type SharingRefreshParams = z.infer<typeof SharingRefreshParams>;

// Asks Telegram (getMe) whether the token is a real bot, saves it to the Keychain, returns the bot.
export const TelegramCheckTokenParams = z.object({ token: z.string().min(1).max(200) }).strict();
export type TelegramCheckTokenParams = z.infer<typeof TelegramCheckTokenParams>;
// Makes a one-time code and starts watching for `/start <code>` (getUpdates).
export const TelegramStartPairingParams = z.object({}).strict();
export type TelegramStartPairingParams = z.infer<typeof TelegramStartPairingParams>;
export const TelegramSendTestParams = z.object({}).strict();
export type TelegramSendTestParams = z.infer<typeof TelegramSendTestParams>;
export const TelegramDisconnectParams = z.object({}).strict();
export type TelegramDisconnectParams = z.infer<typeof TelegramDisconnectParams>;

// Slack (HAIL-145). Checks both tokens (auth.test, a Socket Mode connection) and keeps them in the Keychain.
export const SlackCheckTokensParams = z
  .object({ app_token: z.string().min(1).max(400), bot_token: z.string().min(1).max(400) })
  .strict();
export type SlackCheckTokensParams = z.infer<typeof SlackCheckTokensParams>;
// Reads the app id from the bot token alone (auth.test, bots.info). Saves nothing (HAIL-148).
export const SlackLookUpAppParams = z.object({ bot_token: z.string().min(1).max(400) }).strict();
export type SlackLookUpAppParams = z.infer<typeof SlackLookUpAppParams>;
export const SlackStartPairingParams = z.object({}).strict();
export const SlackSendTestParams = z.object({}).strict();
export const SlackDisconnectParams = z.object({}).strict();

// design_kit.get / design_kit.set / design_kit.undo (HAIL-166): the default design kit, one for the whole
// machine. The daemon is its only writer. `updated_by` on set is "you" when absent (the app); an agent
// passes "<runtime>:<session id>". A set that changes nothing stores no new version. One previous kit is
// kept; undo restores it and clears it. The kit goes to agents (guide "artifacts" topic and index) only while
// `enabled` is true, the text is not empty, and the project has no .knock/design-kit.md.
export const DesignKitGetParams = z.object({}).strict();
export const DesignKitSetParams = DesignKitChange.extend({ updated_by: UpdatedBy.optional() })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "updated_by"), {
    message: "Send at least one of design_system, pen_file, tone, enabled.",
  });
export type DesignKitSetParams = z.infer<typeof DesignKitSetParams>;
export const DesignKitUndoParams = z.object({}).strict();
export const DesignKitResult = z.object({ kit: DesignKit, can_undo: z.boolean() });
export type DesignKitResult = z.infer<typeof DesignKitResult>;

// waggle_settings (HAIL-166): what the MCP tool of that name sends. One call validates every field
// before it writes any, so a bad artifact_preset leaves the kit as it was.
export const KnockSettingsParams = KnockSettingsInput.extend({ updated_by: UpdatedBy.optional() });
export type KnockSettingsParams = z.infer<typeof KnockSettingsParams>;
export const KnockSettingsResult = DesignKitResult.extend({ artifact_preset: ArtifactPreset });
export type KnockSettingsResult = z.infer<typeof KnockSettingsResult>;

// --- Project page (WAG-260) ---
export const ProjectDecision = z.object({
  case_id: z.string(),
  question: z.string(),
  decided_at: z.string(),
  pick: z.string(),
  why: z.string(),
  option_count: z.number().int().nonnegative(),
  artifact_kind: z.string().nullable(),
});
export const ProjectTheme = z.object({
  id: z.string(),
  text: z.string(),
  evidence_count: z.number().int().nonnegative(),
  quotes: z.array(z.string()),
  enabled: z.boolean(),
  proposed_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const ProjectDecisionsParams = z.object({
  project: z.string(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
});
export const ProjectDecisionsResult = z.object({ items: z.array(ProjectDecision), total: z.number().int() });
export const ProjectGetParams = z.object({ project: z.string() });
export const ProjectThemeToggleParams = z.object({ id: z.string(), enabled: z.boolean() });
export const ProjectRepoRecordsParams = z.object({ project: z.string(), enabled: z.boolean() });
export const ProjectRepoRecordsResult = z.object({ project: z.string(), repo_records: z.boolean() });
// waggle_themes: what the shim sends. The daemon finds the project from the session.
export const KnockThemesParams = KnockThemesInput.extend({ session_id: z.string() });
export type KnockThemesParams = z.infer<typeof KnockThemesParams>;

// --- Claude Code mod methods (HAIL-134) ---
//
// The mod in plugins/claude-code/knock runs `waggle mod ...`, which calls these
// over the socket. None needs a prior session.hello: the mod and the shim of one
// Claude Code session share the session id (CLAUDE_CODE_SESSION_ID, `$.session.id()`).

// mod.report: one live event of the session. `tool` is a tool name and only valid
// with tool.call. No prompt text ever crosses. nudge.failed tells the daemon the
// mod could not submit a nudge it was handed, so the window is given back.
export const ModEvent = z.enum([
  "turn.start",
  "turn.complete",
  "prompt.submit",
  "tool.call",
  "nudge.failed",
  // HAIL-137: the Codex SessionEnd hook. The daemon forgets the session's live state.
  "session.end",
]);
export type ModEvent = z.infer<typeof ModEvent>;
export const ModReportParams = z
  .object({
    session_id: z.string().min(1),
    event: ModEvent,
    tool: z.string().min(1).max(200).optional(),
    case_id: z.string().min(1).optional(),
    // How many tool calls this report stands for (the mod folds a burst into one).
    count: z.number().int().positive().max(1000).optional(),
    // HAIL-137: who reports. "codex-hooks" is the Codex plugin's hooks: they report on events
    // only (no poll), so their state stays fresh longer and they never make a session nudgeable.
    source: z.enum(["claude-mod", "codex-hooks"]).optional(),
    // The folder of the reporting session. Used only to match a Codex hook session to the
    // shim session when the two do not share an id.
    cwd: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type ModReportParams = z.infer<typeof ModReportParams>;
export const ModReportResult = z.object({ ok: z.literal(true) });
export type ModReportResult = z.infer<typeof ModReportResult>;

// mod.stop_check (HAIL-137): the Codex Stop hook asks whether the session still has an ask open
// (waiting on the human, or answered and not yet picked up). When it has, `block` is true and
// `reason` is the one line the hook returns to Codex to continue the turn. The daemon counts the
// continues per case and stops blocking after MOD_STOP_MAX_CONTINUES, so it never loops forever.
export const ModStopCheckParams = z
  .object({
    session_id: z.string().min(1),
    cwd: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type ModStopCheckParams = z.infer<typeof ModStopCheckParams>;
export const ModStopCheckResult = z.object({
  block: z.boolean(),
  case_id: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ModStopCheckResult = z.infer<typeof ModStopCheckResult>;

// mod.open_ask (WAG-265): the Claude Code Stop hook asks whether the session has an ask open
// (waiting on the human, or answered and not yet picked up). No side effect: unlike
// mod.stop_check it counts nothing.
export const ModOpenAskParams = ModStopCheckParams;
export type ModOpenAskParams = ModStopCheckParams;
// case_ids (WAG-268): the open cases of the session, for the reminder after a compaction.
export const ModOpenAskResult = z.object({ open: z.boolean(), case_ids: z.array(z.string()).optional() });
export type ModOpenAskResult = z.infer<typeof ModOpenAskResult>;

// mod.poll: the mod's heartbeat and its one read. It marks the session's mod as
// attached, then answers at once, or (with wait_ms) holds until the status changes
// or a nudge is queued, at most wait_ms. The answer carries what the band draws
// and at most one nudge to submit.
export const ModPollParams = z
  .object({
    session_id: z.string().min(1),
    wait_ms: z.number().int().min(0).max(25_000).optional(),
    // The `sig` of the last answer the mod drew. A poll whose status already differs
    // answers at once instead of waiting.
    seen: z.string().max(400).optional(),
    // The mod's version, for support.
    mod_version: z.string().max(40).optional(),
  })
  .strict();
export type ModPollParams = z.infer<typeof ModPollParams>;
export const ModOpenAsk = z.object({
  case_id: z.string(),
  title: z.string(),
  created_at: z.string(),
  // When the case last started waiting on the human: the case's `updated_at`, which
  // creation and every waggle_update that returns it to needs_you set. Older mods ignore it.
  waiting_since: z.string(),
});
export type ModOpenAsk = z.infer<typeof ModOpenAsk>;
export const ModAnswer = z.object({
  case_id: z.string(),
  title: z.string(),
  // The option's own text (its title, else its label), or null for a note-only answer.
  choice: z.string().nullable(),
  note: z.string().nullable(),
  answered_at: z.string(),
});
export type ModAnswer = z.infer<typeof ModAnswer>;
export const ModNudge = z.object({
  case_id: z.string(),
  // The one line to submit (the same text the messaging-socket nudge posts).
  text: z.string(),
});
export type ModNudge = z.infer<typeof ModNudge>;
export const ModPollResult = z.object({
  now: z.string(),
  // A short fingerprint of open_ask, open_count and answer. Equal sigs mean the band
  // has nothing new to draw.
  sig: z.string(),
  // The session's oldest ask that waits for the human, and how many wait.
  open_ask: ModOpenAsk.nullable(),
  open_count: z.number().int().nonnegative(),
  // Asks waiting on the human in every other session: the band's "+N in other sessions".
  other_open_count: z.number().int().nonnegative(),
  // The newest answer to an ask of this session, or null.
  answer: ModAnswer.nullable(),
  nudge: ModNudge.nullable(),
});
export type ModPollResult = z.infer<typeof ModPollResult>;

// case.open: the band's button. Asks the app to open the case (event
// case.open_requested). The CLI then brings the app forward with `open -b`.
// No case_id: bring Waggle forward on its queue (the band's "queue" button).
export const CaseOpenParams = z.object({ case_id: z.string().min(1).optional() });
export type CaseOpenParams = z.infer<typeof CaseOpenParams>;
export const CaseOpenResult = z.object({ ok: z.literal(true) });
export type CaseOpenResult = z.infer<typeof CaseOpenResult>;
