import { exportVersions } from "./usage/versions";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATCH_QUESTIONS_OFF_FILE, catchQuestionsEnabled, writeHookAskPrefs } from "./hooks/claude-hooks";
import type { ZodType } from "zod";
import { currentExecPath } from "./config";
import { LineSplitter } from "./line-splitter";
import type { EventBus } from "./events";
import { autoNudgeDelayMs, commentNudgeText, nudgeIntervalMs, nudgeText } from "./mcp/nudge";
import type { ConnectorManager } from "./connectors/manager";
import { RelayError, type RelaySharing } from "./connectors/relay";
import { SlackError, type SlackConnector } from "./connectors/slack";
import { TelegramError, type TelegramConnector } from "./connectors/telegram";
import type { Store } from "./store";
import {
  ArtifactPathParams,
  CaseChangeMindParams,
  CaseDismissParams,
  CaseOpenParams,
  CaseRestoreParams,
  CasesGetParams,
  CasesAutoDecidedParams,
  CasesListParams,
  toCaseListRow,
  CasesPurgeResolvedParams,
  CasesResolvedStatsParams,
  CaseWaitParams,
  CaseWaitReply,
  ConnectorsStatusParams,
  SlackCheckTokensParams,
  SlackLookUpAppParams,
  SlackDisconnectParams,
  SharingGetParams,
  SharingRefreshParams,
  SharingReplyParams,
  SharingCommentParams,
  SharingResolveParams,
  SharingCloseCommentsParams,
  SharingReopenParams,
  SharingMarkLateGivenParams,
  SharingMarkSeenParams,
  SharingEmptyParams,
  SharingUpdateParams,
  SharingOpenPageParams,
  AccountEmptyParams,
  AccountStopShareParams,
  SharingSetEnabledParams,
  SharingStartParams,
  SharingStopParams,
  SlackSendTestParams,
  SlackStartPairingParams,
  EventsSubscribeParams,
  GuideGetParams,
  SettingsGetParams,
  SettingsSetParams,
  DesignKitGetParams,
  DesignKitSetParams,
  DesignKitUndoParams,
  KnockSettingsParams,
  KnockThemesParams,
  ProjectDecisionsParams,
  ProjectGetParams,
  ProjectRepoRecordsParams,
  ProjectThemeToggleParams,
  PreferenceListParams,
  PreferenceRulesParams,
  KnockAskInput,
  CaseCreateParams,
  KnockUpdateInput,
  McpManifestParams,
  McpManifestTool,
  UsageContextParams,
  UsageControlParams,
  UsageExportParams,
  UsageSummaryParams,
  UsageToolCallParams,
  MCP_TOOLS,
  ModPollParams,
  ModPollResult,
  ModReportParams,
  ModStopCheckParams,
  ModOpenAskParams,
  type ModOpenAskResult,
  type ModStopCheckResult,
  PendingResult,
  CaptureImageParams,
  ReplyAckParams,
  ReplyReplaceParams,
  ReplyRetryParams,
  ReplyHandOverParams,
  ReplyStatus,
  ReplySubmitParams,
  RevisionAddByHumanParams,
  Runtime,
  type SessionChanges,
  ServiceRestartParams,
  ServiceStatusParams,
  SessionHelloParams,
  SessionNudgeParams,
  SessionNudgeResult,
  SessionSendPromptParams,
  SessionSendPromptResult,
  SessionsListParams,
  TelegramCheckTokenParams,
  TelegramDisconnectParams,
  TelegramSendTestParams,
  TelegramStartPairingParams,
  UsageRecordParams,
  CodedError,
  ERROR_CODE_DATA_KEY,
} from "./protocol";
import { linearKey, pidAlive, projectName, taskName } from "./sessions";
import { clamp, plain, sessionContext } from "./sessions/context";
import { ModRegistry } from "./sessions/live";
import { modStatus } from "./sessions/mod-status";
import { ArtifactError } from "./artifacts/ingest";
import { getGuide, guideIndex } from "./guide";
import { projectGuide } from "./guide/project";
import { GUIDE_COMMENT_COUNT, GUIDE_DECISION_COUNT } from "./projects";
import { askAgentText } from "./guide/asks";
import { ChoiceNotOfferedError, FollowsCaseError, ReplacesCaseError, ReplyNotQueuedError, SESSION_RECONNECT_GRACE_S, toReplySummary } from "./store";
import { isOlder } from "./version";

// JSON-RPC 2.0 over a unix socket, one object per line
// (docs/protocol-mvp.md "Socket RPC"). events.subscribe keeps the connection
// open and streams Event notifications; session methods are shim-only.

export interface RpcServer {
  stop(): void;
  socketPath: string;
  // The number of sockets currently open. The daemon uses it for idle exit.
  openConnections(): number;
}

interface Conn {
  lines: LineSplitter;
  unsubscribe: (() => void) | null;
  sessionId: string | null;
  queue: Promise<void>;
  waiters: Set<() => void>;
  // WAG-268: the open case.wait calls by case id, so a cancel notification can end one.
  caseWaiters: Map<string, Set<() => void>>;
  closed: boolean;
  // Bytes Bun's socket.write did not accept yet. Bun does not buffer: a write
  // larger than the kernel send buffer is partial and the rest must be sent
  // from the drain handler, or large responses (cases.get and reply.submit
  // with captures) arrive truncated and the client waits forever.
  outbox: Uint8Array[];
}

// A shim's answer to a request the daemon pushed (HAIL-76).
interface RpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

// How long the daemon waits for the shim to post a nudge and answer.
const PUSH_TIMEOUT_MS = 10_000;

interface HandleContext {
  socket: Bun.Socket<Conn>;
  conn: Conn;
}

interface Handler {
  params: ZodType;
  handle: (params: unknown, ctx: HandleContext) => unknown | Promise<unknown>;
}

// Method-specific errors. The protocol fixes -32602 (invalid params) and -32001
// (case not found); the rest are Waggle-specific routing errors.
const ERR_CASE_NOT_FOUND = -32001;
const ERR_NOT_YOUR_CASE = -32002;
const ERR_SESSION_NOT_KNOWN = -32003;
const ERR_ARTIFACT = -32004;
// A client whose client_version is newer than the running daemon (HAIL-27).
const ERR_DAEMON_OLDER = -32005;
// reply.replace on a reply that is no longer queued (HAIL-34).
const ERR_REPLY_NOT_QUEUED = -32006;
// waggle_ask's follows named a case that does not exist, or one from another
// task (HAIL-33 amendment).
const ERR_FOLLOWS_CASE_INVALID = -32007;
// waggle_ask's replaces named a case that does not exist, or one from another
// task (HAIL-44).
const ERR_REPLACES_CASE_INVALID = -32008;
// reply.submit / reply.replace with a choice that is in no offered option set (HAIL-108).
const ERR_CHOICE_NOT_OFFERED = -32009;
// A chat connector step failed (HAIL-144). The message is plain words for the operator.
const ERR_CONNECTOR = -32010;

// How long service.restart waits for a reply that case.wait has returned but
// the shim has not yet acked, before it stops anyway (KNOCK-21).
const RESTART_DRAIN_MS = 10_000;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

export function startRpcServer(opts: {
  socketPath: string;
  store: Store;
  bus: EventBus;
  version: string;
  // The realpath of the running daemon's own binary, reported by service.status
  // so the app can replace a daemon that is not its own (HAIL-27).
  execPath?: string;
  // Called once service.restart has drained in-flight deliveries (or given up
  // after RESTART_DRAIN_MS). The daemon wires this to its clean shutdown.
  onRestart?: () => void;
  // The tool surface `mcp.manifest` reports (HAIL-48). Defaults to the real
  // compiled-in MCP_TOOLS; a test overrides this to stand in for a daemon
  // build whose manifest differs, without needing a second compiled binary.
  mcpManifestTools?: McpManifestTool[];
  // False stands in for a daemon build from before HAIL-48, which has no
  // mcp.manifest method at all (a real one never turns it off - this exists
  // only so a compatibility test can verify the new shim's fallback to its
  // own compiled-in manifest without building an old binary).
  mcpManifestEnabled?: boolean;
  // What the Claude Code mod reports (HAIL-134). A test passes its own, with a clock it controls.
  mods?: ModRegistry;
  // The chat connectors (HAIL-144). The daemon passes its own; a test may pass none, and then the
  // connectors.* methods answer "not available".
  connectors?: ConnectorManager;
  // Sharing a case through the relay (WAG-387). A test may pass none, and then sharing.* answers "not available".
  relay?: RelaySharing;
}): RpcServer {
  const { socketPath, store, bus, version } = opts;
  const execPath = opts.execPath ?? currentExecPath();
  const onRestart = opts.onRestart ?? (() => {});
  const mcpManifestTools = opts.mcpManifestTools ?? MCP_TOOLS;
  const mcpManifestEnabled = opts.mcpManifestEnabled ?? true;
  const mods = opts.mods ?? new ModRegistry();

  // WAG-273: the Stop hook reads the Requests choices from a file in the data root (no daemon needed).
  // Written at start, so an operator who chose before this release is followed, and on every change.
  // A failed write must never fail the settings call.
  const syncHookPrefs = () => {
    try {
      writeHookAskPrefs(store.dataRoot, {
        reach: store.getAskReach(),
        topics: store.getAskTopics(),
        frequency: store.getAskFrequency(),
      });
    } catch {}
  };
  syncHookPrefs();

  // A reply that case.wait has returned but the shim has not acked yet. The
  // daemon must not exit while one is in flight (docs/protocol-mvp.md "delivered
  // is set only ... the shim acknowledged it"), so service.restart drains this
  // set before stopping.
  const inFlightDeliveries = new Set<string>();

  function markDeliveryStarted(replyId: string): void {
    inFlightDeliveries.add(replyId);
  }

  function markDeliveryAcked(replyId: string): void {
    inFlightDeliveries.delete(replyId);
  }

  // Replies ok immediately, then drains in-flight deliveries (at most
  // RESTART_DRAIN_MS) before asking the daemon to stop.
  function scheduleRestart(): void {
    void (async () => {
      const deadline = Date.now() + RESTART_DRAIN_MS;
      while (inFlightDeliveries.size > 0 && Date.now() < deadline) {
        await sleep(50);
      }
      onRestart();
    })();
  }

  function designKitResult() {
    return { kit: store.getDesignKit(), can_undo: store.canUndoDesignKit() };
  }

  function telegram(): TelegramConnector {
    const t = opts.connectors?.get("telegram");
    if (!t) throw new RpcError(ERR_CONNECTOR, "Chat connectors are not available in this daemon.");
    return t as TelegramConnector;
  }

  function slack(): SlackConnector {
    const s = opts.connectors?.get("slack");
    if (!s) throw new RpcError(ERR_CONNECTOR, "Chat connectors are not available in this daemon.");
    return s as SlackConnector;
  }

  function relay(): RelaySharing {
    if (!opts.relay) throw new RpcError(ERR_CONNECTOR, "Sharing is not available in this daemon.");
    return opts.relay;
  }

  // Runs one connector step. A TelegramError, SlackError or RelayError carries plain words for the operator.
  async function connectorStep<T>(step: () => T | Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (err) {
      if (err instanceof TelegramError || err instanceof SlackError || err instanceof RelayError) throw new RpcError(ERR_CONNECTOR, err.message);
      throw err;
    }
  }

  const appHandlers = new Map<string, Handler>([
    [
      "cases.list",
      {
        params: CasesListParams,
        handle: (p) =>
          store
            .listCases((p as { status?: "needs_you" | "waiting_on_agent" | "resolved" }).status)
            .map(toCaseListRow),
      },
    ],
    [
      "cases.auto_decided",
      {
        params: CasesAutoDecidedParams,
        handle: (p) => store.listAutoDecided((p as CasesAutoDecidedParams).since).map(toCaseListRow),
      },
    ],
    [
      "cases.get",
      {
        params: CasesGetParams,
        handle: (p) => {
          const detail = store.getCase((p as { id: string }).id);
          if (!detail) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
          return detail;
        },
      },
    ],
    [
      "service.status",
      { params: ServiceStatusParams, handle: () => store.serviceStatus(version, execPath) },
    ],
    [
      "service.restart",
      {
        params: ServiceRestartParams,
        handle: () => {
          scheduleRestart();
          return { ok: true };
        },
      },
    ],
    [
      "usage.record",
      {
        params: UsageRecordParams,
        handle: (p) => {
          // The params were already validated as {event, source?}. Record them
          // through the store's single write path (the same strict schema).
          store.recordUsage(p);
          return { ok: true };
        },
      },
    ],
    [
      "usage.context",
      {
        params: UsageContextParams,
        handle: (p) => {
          store.toolLog?.noteContext(p as UsageContextParams);
          return { ok: true };
        },
      },
    ],
    [
      "usage.summary",
      {
        params: UsageSummaryParams,
        handle: (p) => {
          const log = store.toolLog;
          if (!log) throw new RpcError(-32602, "Usage is not available in this daemon.");
          return log.summary((p as UsageSummaryParams).days ?? 7);
        },
      },
    ],
    [
      "usage.export",
      {
        params: UsageExportParams,
        handle: (p) => {
          const log = store.toolLog;
          if (!log) throw new RpcError(-32602, "Usage is not available in this daemon.");
          return log.export((p as UsageExportParams).path, exportVersions(version));
        },
      },
    ],
    [
      "usage.control",
      {
        params: UsageControlParams,
        handle: (p) => {
          const log = store.toolLog;
          if (!log) throw new RpcError(-32602, "Usage is not available in this daemon.");
          return log.control(p as UsageControlParams);
        },
      },
    ],
    [
      "artifact.path",
      {
        params: ArtifactPathParams,
        handle: (p) => {
          const { case_id, revision } = p as { case_id: string; revision: number };
          if (!store.getCase(case_id)) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
          const result = store.artifactPath(case_id, revision);
          if (!result) throw new RpcError(ERR_CASE_NOT_FOUND, "revision not found");
          return result;
        },
      },
    ],
    [
      "capture.image",
      {
        params: CaptureImageParams,
        handle: (p) => {
          const { capture_id, which } = p as CaptureImageParams;
          const png_base64 = store.captureImage(capture_id, which);
          if (png_base64 === null) throw new RpcError(ERR_CASE_NOT_FOUND, "capture not found");
          return { capture_id, which, png_base64 };
        },
      },
    ],
    [
      "revision.add_by_human",
      {
        params: RevisionAddByHumanParams,
        handle: (p) => {
          const { case_id, base_revision, markdown } = p as RevisionAddByHumanParams;
          if (!store.getCase(case_id)) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
          return store.addHumanRevision(case_id, base_revision, markdown);
        },
      },
    ],
    [
      "reply.submit",
      {
        params: ReplySubmitParams,
        handle: (p) => {
          const { case_id, ...input } = p as ReplySubmitParams;
          if (!store.getCase(case_id)) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
          return toReplySummary(store.submitReply(case_id, input));
        },
      },
    ],
    [
      "reply.retry",
      {
        params: ReplyRetryParams,
        handle: (p) => {
          const { reply_id } = p as ReplyRetryParams;
          // HAIL-192: retry first brings the owning session back when its client is alive.
          const retryCase = store.replyCaseId(reply_id);
          const owner = retryCase ? store.owningSessionId(retryCase) : null;
          if (owner) store.reviveSessionIfAlive(owner, pidAlive);
          const reply = store.retryReply(reply_id);
          if (!reply) throw new RpcError(ERR_CASE_NOT_FOUND, "reply not found");
          return toReplySummary(reply);
        },
      },
    ],
    [
      "reply.hand_over",
      {
        params: ReplyHandOverParams,
        handle: (p) => {
          const { reply_id } = p as ReplyHandOverParams;
          const reply = store.handOverReply(reply_id);
          if (!reply) throw new RpcError(ERR_CASE_NOT_FOUND, "reply not found");
          return toReplySummary(reply);
        },
      },
    ],
    [
      "reply.replace",
      {
        params: ReplyReplaceParams,
        handle: (p) => {
          const { reply_id, ...input } = p as ReplyReplaceParams;
          const reply = store.replaceReply(reply_id, input);
          if (!reply) throw new RpcError(ERR_CASE_NOT_FOUND, "reply not found");
          return toReplySummary(reply);
        },
      },
    ],
    [
      "sessions.list",
      {
        params: SessionsListParams,
        // HAIL-72: add each live Claude session's context. A failure in one
        // session's context never fails the list.
        // HAIL-134: a session whose mod is attached reports its exact state, and
        // it can be nudged through the mod even when the messaging socket is not there.
        handle: async () =>
          Promise.all(
            store.listSessions().map(async (s) => ({
              ...s,
              can_nudge: s.can_nudge || (s.state === "live" && mods.attached(s.id)),
              context: await sessionContext(s, { live: mods.live(s.id), changes: sessionChanges.get(s.id) ?? null }),
            })),
          ),
      },
    ],
    [
      "mod.report",
      {
        params: ModReportParams,
        handle: (p) => {
          const { session_id, event, tool, case_id, count, source, cwd } = p as ModReportParams;
          if (event === "nudge.failed") {
            // The mod took a nudge and could not submit it: give the window back.
            if (case_id && mods.failNudge(case_id)) releaseNudgeWindow(case_id);
            return { ok: true };
          }
          const hooks = source === "codex-hooks";
          const id = hooks ? resolveHookSession(session_id, cwd) : session_id;
          mods.report(id, event, event === "tool.call" ? tool : undefined, count, hooks);
          // WAG-267: a turn that began after a delivery and finished is visible work on that reply.
          if (event === "turn.start") turnStarts.set(id, new Date().toISOString());
          else if (event === "turn.complete") {
            const startedAt = turnStarts.get(id);
            turnStarts.delete(id);
            if (startedAt !== undefined) store.markRepliesAppliedByTurn(id, startedAt);
          }
          return { ok: true };
        },
      },
    ],
    [
      "mod.stop_check",
      {
        params: ModStopCheckParams,
        handle: (p) => {
          const { session_id, cwd } = p as ModStopCheckParams;
          return stopCheck(resolveHookSession(session_id, cwd));
        },
      },
    ],
    [
      "mod.open_ask",
      {
        params: ModOpenAskParams,
        handle: (p) => {
          const { session_id, cwd } = p as ModOpenAskParams;
          const hookSession = resolveHookSession(session_id, cwd);
          return {
            open: openAskFor(hookSession) !== undefined,
            case_ids: store.openCaseIds(hookSession),
          } satisfies ModOpenAskResult;
        },
      },
    ],
    [
      "mod.poll",
      {
        params: ModPollParams,
        handle: (p, ctx) => modPoll(p as ModPollParams, ctx),
      },
    ],
    [
      "case.open",
      {
        params: CaseOpenParams,
        handle: (p) => {
          const { case_id } = p as CaseOpenParams;
          if (case_id === undefined) {
            store.recordEvent("case.open_requested", {});
            return { ok: true };
          }
          if (!store.getCase(case_id)) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
          store.recordEvent("case.open_requested", { case_id });
          return { ok: true };
        },
      },
    ],
    [
      "session.nudge",
      {
        params: SessionNudgeParams,
        handle: async (p) => {
          const { case_id } = p as SessionNudgeParams;
          return await nudge(case_id);
        },
      },
    ],
    [
      "session.send_prompt",
      {
        params: SessionSendPromptParams,
        handle: async (p) => sendPrompt(p as SessionSendPromptParams),
      },
    ],
    [
      "cases.resolved_stats",
      { params: CasesResolvedStatsParams, handle: () => store.resolvedCaseStats() },
    ],
    [
      "cases.purge_resolved",
      {
        params: CasesPurgeResolvedParams,
        handle: async () => {
          const out = store.purgeResolvedCases();
          // A purged case that was shared leaves a note in the store. Take its page down now; a failure
          // keeps the note and the background tick tries again (WAG-391).
          await opts.relay?.flushPendingStops().catch(() => {});
          return out;
        },
      },
    ],
    ...(mcpManifestEnabled
      ? ([
          [
            "mcp.manifest",
            {
              params: McpManifestParams,
              handle: () => ({ daemon_version: version, tools: mcpManifestTools }),
            },
          ],
        ] as [string, Handler][])
      : []),
    [
      "guide.get",
      {
        params: GuideGetParams,
        handle: (p) => {
          const { topic, flavour, session_id } = p as { topic?: string; flavour?: "desktop"; session_id?: string };
          if (topic === "project") {
            const project = session_id ? store.projects.sessionProject(session_id) : null;
            if (project === null) return { text: getGuide(topic) };
            const prefs = store.projects.prefs(project);
            const stale = store.projects.themesStale(project);
            return {
              text: projectGuide({
                project,
                decisions: store.projects.decisions(project, GUIDE_DECISION_COUNT, 0).items,
                themes: store.projects.themes(project),
                repoRecords: prefs.repo_records,
                stale,
                comments: stale ? store.projects.recentComments(project, GUIDE_COMMENT_COUNT) : [],
              }),
            };
          }
          return {
            text: topic
              ? getGuide(topic, store.getArtifactPreset(), store.getAskWords(), flavour, store.getAskLess())
              : guideIndex(store.getAskPreferences(), flavour, store.getAskLess()),
          };
        },
      },
    ],
    [
      "settings.get",
      {
        params: SettingsGetParams,
        handle: (p) => {
          switch ((p as SettingsGetParams).key) {
            case "artifactPreset":
              return { key: "artifactPreset", value: store.getArtifactPreset() };
            case "askTopics":
              return { key: "askTopics", value: store.getAskTopics() };
            case "askFrequency":
              return { key: "askFrequency", value: store.getAskFrequency() };
            case "askDetail":
              return { key: "askDetail", value: store.getAskDetail() };
            case "askReach":
              return { key: "askReach", value: store.getAskReach() };
            case "askWords":
              return { key: "askWords", value: store.getAskWords() };
            case "askLearn":
              return { key: "askLearn", value: store.getAskLearn() };
            case "askAfterDecide":
              return { key: "askAfterDecide", value: store.getAskAfterDecide() };
            case "askLess":
              return { key: "askLess", value: store.getAskLess() };
            case "catchQuestions":
              return { key: "catchQuestions", value: catchQuestionsEnabled(store.dataRoot) ? "on" : "off" };
            case "askText":
              return { key: "askText", value: askAgentText(store.getAskPreferences()) };
          }
        },
      },
    ],
    [
      "connectors.status",
      { params: ConnectorsStatusParams, handle: () => ({ telegram: telegram().status(), slack: slack().status() }) },
    ],
    [
      "connectors.telegram.check_token",
      {
        params: TelegramCheckTokenParams,
        handle: (p) => connectorStep(() => telegram().checkToken((p as { token: string }).token.trim())),
      },
    ],
    [
      "connectors.telegram.start_pairing",
      { params: TelegramStartPairingParams, handle: () => connectorStep(() => telegram().startPairing()) },
    ],
    [
      "connectors.telegram.send_test",
      {
        params: TelegramSendTestParams,
        handle: () => connectorStep(async () => (await telegram().sendTest(), { ok: true })),
      },
    ],
    [
      "connectors.telegram.disconnect",
      {
        params: TelegramDisconnectParams,
        handle: () =>
          connectorStep(async () => {
            const t = telegram();
            await t.disconnect();
            return t.status();
          }),
      },
    ],
    [
      "connectors.slack.check_tokens",
      {
        params: SlackCheckTokensParams,
        handle: (p) => {
          const { app_token, bot_token } = p as { app_token: string; bot_token: string };
          return connectorStep(() => slack().checkTokens(app_token.trim(), bot_token.trim()));
        },
      },
    ],
    [
      "connectors.slack.look_up_app",
      {
        params: SlackLookUpAppParams,
        handle: (p) => connectorStep(() => slack().lookUpApp((p as { bot_token: string }).bot_token)),
      },
    ],
    [
      "connectors.slack.start_pairing",
      { params: SlackStartPairingParams, handle: () => connectorStep(() => slack().startPairing()) },
    ],
    [
      "connectors.slack.send_test",
      {
        params: SlackSendTestParams,
        handle: () => connectorStep(async () => (await slack().sendTest(), { ok: true })),
      },
    ],
    [
      "sharing.get",
      { params: SharingGetParams, handle: (p) => relay().state((p as { case_id?: string }).case_id) },
    ],
    [
      "sharing.set_enabled",
      {
        params: SharingSetEnabledParams,
        handle: (p) => connectorStep(() => relay().setEnabled((p as { enabled: boolean }).enabled)),
      },
    ],
    [
      "sharing.start",
      {
        params: SharingStartParams,
        handle: (p) => {
          const { case_id, mode, emails } = p as { case_id: string; mode: "link" | "emails"; emails?: string[] };
          return connectorStep(() => relay().share(case_id, mode, emails ?? []));
        },
      },
    ],
    [
      "sharing.stop",
      {
        params: SharingStopParams,
        handle: (p) => connectorStep(() => relay().stopSharing((p as { case_id: string }).case_id)),
      },
    ],
    ["sharing.update", { params: SharingUpdateParams, handle: (p) => {
      const { case_id, mode, emails } = p as { case_id: string; mode: "link" | "emails"; emails?: string[] };
      return connectorStep(() => relay().update(case_id, mode, emails ?? []));
    } }],
    ["sharing.open_page", { params: SharingOpenPageParams, handle: (p) => connectorStep(() => relay().openPage((p as { case_id: string }).case_id)) }],
    ["account.get", { params: AccountEmptyParams, handle: () => relay().accountState() }],
    ["account.connect_start", { params: AccountEmptyParams, handle: () => connectorStep(() => relay().connectStart()) }],
    ["account.connect_cancel", { params: AccountEmptyParams, handle: () => relay().connectCancel() }],
    ["account.sign_out", { params: AccountEmptyParams, handle: () => connectorStep(() => relay().signOut()) }],
    ["account.shares", { params: AccountEmptyParams, handle: () => connectorStep(() => relay().accountShares()) }],
    ["account.stop_share", { params: AccountStopShareParams, handle: (p) => connectorStep(() => relay().accountStopShare((p as { relay_id: string }).relay_id)) }],
    [
      "sharing.reply",
      {
        params: SharingReplyParams,
        handle: (p) => {
          const { case_id, parent_id, body } = p as SharingReplyParams;
          return connectorStep(() => relay().replyAsOwner(case_id, parent_id, body));
        },
      },
    ],
    [
      "sharing.comment",
      {
        params: SharingCommentParams,
        handle: (p) => {
          const { case_id, body } = p as SharingCommentParams;
          return connectorStep(() => relay().commentAsOwner(case_id, body));
        },
      },
    ],
    [
      "sharing.resolve",
      {
        params: SharingResolveParams,
        handle: (p) => {
          const { case_id, comment_id, resolved } = p as SharingResolveParams;
          return connectorStep(() => relay().resolveComment(case_id, comment_id, resolved));
        },
      },
    ],
    [
      "sharing.close_comments",
      {
        params: SharingCloseCommentsParams,
        handle: (p) => {
          const { case_id, closed } = p as SharingCloseCommentsParams;
          return connectorStep(() => relay().closeComments(case_id, closed));
        },
      },
    ],
    [
      "sharing.reopen",
      {
        params: SharingReopenParams,
        handle: (p) => {
          const { case_id, reopened } = p as SharingReopenParams;
          return connectorStep(() => relay().reopen(case_id, reopened));
        },
      },
    ],
    ["sharing.mark_late_given", { params: SharingMarkLateGivenParams, handle: (p) => relay().markLateGiven((p as SharingMarkLateGivenParams).case_id) }],
    ["sharing.mark_seen", { params: SharingMarkSeenParams, handle: (p) => relay().markSeen((p as SharingMarkSeenParams).case_id) }],
    ["sharing.unread", { params: SharingEmptyParams, handle: () => relay().unread() }],
    ["sharing.take_notifications", { params: SharingEmptyParams, handle: () => relay().takeNotifications() }],
    [
      "sharing.refresh",
      {
        params: SharingRefreshParams,
        handle: (p) => connectorStep(() => relay().refresh((p as { case_id: string }).case_id)),
      },
    ],
    [
      "connectors.slack.disconnect",
      {
        params: SlackDisconnectParams,
        handle: () =>
          connectorStep(async () => {
            const s = slack();
            await s.disconnect();
            return s.status();
          }),
      },
    ],
    [
      "settings.set",
      {
        params: SettingsSetParams,
        handle: (p) => {
          const params = p as SettingsSetParams;
          switch (params.key) {
            case "artifactPreset":
              return { key: params.key, value: store.setArtifactPreset(params.value) };
            case "askTopics":
              {
                const value = store.setAskTopics(params.value);
                syncHookPrefs();
                return { key: params.key, value };
              }
            case "askFrequency":
              {
                const value = store.setAskFrequency(params.value);
                syncHookPrefs();
                return { key: params.key, value };
              }
            case "askDetail":
              return { key: params.key, value: store.setAskDetail(params.value) };
            case "askReach":
              {
                const value = store.setAskReach(params.value);
                syncHookPrefs();
                return { key: params.key, value };
              }
            case "askWords":
              return { key: params.key, value: store.setAskWords(params.value) };
            case "askLearn":
              return { key: params.key, value: store.setAskLearn(params.value) };
            case "askAfterDecide":
              return { key: params.key, value: store.setAskAfterDecide(params.value) };
            case "askLess":
              return { key: params.key, value: store.setAskLess(params.value) };
            case "catchQuestions": {
              const off = join(store.dataRoot, CATCH_QUESTIONS_OFF_FILE);
              if (params.value === "off") {
                mkdirSync(store.dataRoot, { recursive: true, mode: 0o700 });
                writeFileSync(off, "", { mode: 0o600 });
              } else {
                rmSync(off, { force: true });
              }
              return { key: params.key, value: params.value };
            }
          }
        },
      },
    ],
    [
      "project.decisions",
      {
        params: ProjectDecisionsParams,
        handle: (p) => {
          const { project, limit, offset } = p as ProjectDecisionsParams;
          return store.projects.decisions(project, limit, offset);
        },
      },
    ],
    [
      "project.get",
      {
        params: ProjectGetParams,
        handle: (p) => {
          const { project } = p as ProjectGetParams;
          return {
            project,
            ...store.projects.stats(project),
            repo_records: store.projects.prefs(project).repo_records,
            themes: store.projects.themes(project),
          };
        },
      },
    ],
    [
      "project.theme_toggle",
      {
        params: ProjectThemeToggleParams,
        handle: (p) => {
          const { id, enabled } = p as ProjectThemeToggleParams;
          const theme = store.projects.setThemeEnabled(id, enabled);
          if (!theme) throw new RpcError(-32602, "theme not found");
          return theme;
        },
      },
    ],
    [
      "preference.list",
      {
        params: PreferenceListParams,
        handle: (p) => {
          const { scope, project } = p as PreferenceListParams;
          if (scope === "all") return { items: store.projects.allThemes() };
          if (project === undefined) throw new RpcError(-32602, "scope project needs a project");
          return { items: store.projects.themes(project) };
        },
      },
    ],
    [
      "preference.rules",
      {
        params: PreferenceRulesParams,
        handle: (p) => {
          const { session_id } = p as PreferenceRulesParams;
          return store.projects.ruleTexts(store.projects.sessionProject(session_id));
        },
      },
    ],
    [
      "project.set_repo_records",
      {
        params: ProjectRepoRecordsParams,
        handle: (p) => {
          const { project, enabled } = p as ProjectRepoRecordsParams;
          return { project, repo_records: store.projects.setRepoRecords(project, enabled) };
        },
      },
    ],
    [
      "knock_themes",
      {
        params: KnockThemesParams,
        handle: (p) => {
          const { session_id, themes } = p as KnockThemesParams;
          const project = store.projects.sessionProject(session_id);
          if (project === null) throw new RpcError(-32602, "Unknown session. Call waggle_ask first.");
          return store.projects.propose(project, session_id, themes);
        },
      },
    ],
    [
      "design_kit.get",
      {
        params: DesignKitGetParams,
        handle: () => designKitResult(),
      },
    ],
    [
      "design_kit.set",
      {
        params: DesignKitSetParams,
        handle: (p) => {
          const { updated_by, ...change } = p as DesignKitSetParams;
          store.setDesignKit(change, updated_by ?? "you");
          return designKitResult();
        },
      },
    ],
    [
      "design_kit.undo",
      {
        params: DesignKitUndoParams,
        handle: () => {
          if (!store.undoDesignKit()) throw new RpcError(-32602, "There is no earlier design kit to restore.");
          return designKitResult();
        },
      },
    ],
    [
      "knock_settings",
      {
        params: KnockSettingsParams,
        handle: (p) => {
          const { action, artifact_preset, updated_by, ...change } = p as KnockSettingsParams;
          if (action === "set") {
            if (Object.values({ ...change, artifact_preset }).every((v) => v === undefined)) {
              throw new RpcError(
                -32602,
                "Send at least one of design_system, pen_file, tone, enabled, artifact_preset with action set.",
              );
            }
            const by = updated_by ?? "agent";
            store.setDesignKit(change, by);
            if (artifact_preset) store.setArtifactPreset(artifact_preset);
          }
          return { ...designKitResult(), artifact_preset: store.getArtifactPreset() };
        },
      },
    ],
    [
      "case.dismiss",
      {
        params: CaseDismissParams,
        handle: (p) => {
          const { case_id } = p as CaseDismissParams;
          const result = store.dismissCase(case_id);
          if (!result) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
          return result;
        },
      },
    ],
    [
      "case.change_mind",
      {
        params: CaseChangeMindParams,
        handle: (p) => {
          const result = store.changeMind((p as CaseChangeMindParams).case_id);
          if (!result) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
          return result;
        },
      },
    ],
    [
      "case.restore",
      {
        params: CaseRestoreParams,
        handle: (p) => {
          const { case_id } = p as CaseRestoreParams;
          const result = store.restoreCase(case_id);
          if (!result) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
          return result;
        },
      },
    ],
  ]);

  // HAIL-76: the shim connection of each live session, so the daemon can push a
  // request to it, and the pushes still waiting for the shim's answer.
  const sessionConns = new Map<string, Bun.Socket<Conn>>();
  // HAIL-222: each live session's git footprint, as its shim reported it in session.hello.
  const sessionChanges = new Map<string, SessionChanges | null>();
  const pendingPushes = new Map<string, (line: RpcResponse) => void>();
  let nextPushId = 1;

  const pushToSession = (
    sessionId: string,
    method: string,
    params: unknown,
  ): Promise<RpcResponse | null> => {
    const socket = sessionConns.get(sessionId);
    if (!socket || socket.data.closed) return Promise.resolve(null);
    const id = `push-${nextPushId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPushes.delete(id);
        resolve(null);
      }, PUSH_TIMEOUT_MS);
      pendingPushes.set(id, (response) => {
        clearTimeout(timer);
        pendingPushes.delete(id);
        resolve(response);
      });
      write(socket, { jsonrpc: "2.0", id, method, params });
    });
  };

  // session.nudge (HAIL-76). The reply content never leaves the daemon: the shim
  // only gets the case id and the ask title.
  const lastNudgeAt = new Map<string, number>();

  // Gives a case's nudge window back after a nudge failed to reach the session.
  const releaseNudgeWindow = (caseId: string): void => {
    const reply = store.nudgeTarget(caseId)?.reply;
    if (reply) store.releaseNudge(reply.id);
    lastNudgeAt.delete(caseId);
  };

  const nudge = async (caseId: string): Promise<SessionNudgeResult> => {
    const target = store.nudgeTarget(caseId);
    if (!target) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
    const { session, reply } = target;
    if (!session || session.state !== "live") return { sent: false, reason: "session_closed" };
    if (!reply || reply.state !== "queued" || store.isDone(caseId)) return { sent: false, reason: "already_picked_up" };
    // HAIL-134: a session that runs the mod is nudged through the mod first. The
    // messaging socket (HAIL-76) stays the way for a session without the mod.
    const viaMod = mods.attached(session.id);
    const viaSocket = session.can_nudge && sessionConns.has(session.id);
    if (!viaMod && !session.can_nudge) return { sent: false, reason: "not_supported" };
    if (!viaMod && !viaSocket) return { sent: false, reason: "session_closed" };
    const now = Date.now();
    const last = lastNudgeAt.get(caseId);
    if (last !== undefined && now - last < nudgeIntervalMs()) return { sent: false, reason: "rate_limited" };
    // Reserve before the push, so two quick clicks send one nudge.
    lastNudgeAt.set(caseId, now);
    store.reserveNudge(reply.id);
    let delivered = false;
    if (viaMod) {
      delivered = await mods.queueNudge(session.id, {
        case_id: caseId,
        text: nudgeText(target.title, caseId),
      });
    }
    if (!delivered && viaSocket) {
      const response = await pushToSession(session.id, "session.nudge", {
        case_id: caseId,
        title: target.title,
      });
      const answer = response?.result as { ok?: unknown; reason?: unknown } | undefined;
      if (response && !response.error && answer?.ok === true) delivered = true;
      else if (answer?.reason === "rate_limited") {
        // The shim holds its own window (a daemon restart lost ours): keep it.
        store.releaseNudge(reply.id);
        return { sent: false, reason: "rate_limited" };
      }
    }
    if (!delivered) {
      // A failed post does not use up the window.
      store.releaseNudge(reply.id);
      lastNudgeAt.delete(caseId);
      return { sent: false, reason: "post_failed" };
    }
    store.recordEvent("session.nudged", {
      case_id: caseId,
      reply_id: reply.id,
      session_id: session.id,
    });
    return { sent: true };
  };

  // HAIL-181: Waggle wakes a session it can nudge. When a reply is queued for a case that no
  // case.wait holds, and the session has can_nudge, the daemon nudges after a short grace
  // period. The agent may have ended its turn: the nudge starts a new one. The same rules as a
  // click apply (one per case per minute, only while the reply is still queued).
  // WAG-267: when each session's current turn began (from the mod's turn.start report).
  const turnStarts = new Map<string, string>();
  const autoNudgeTimers = new Set<ReturnType<typeof setTimeout>>();
  // WAG-258: is the session in the middle of a turn? The mod says so exactly. A session without a mod
  // is busy while it made a session RPC (or came back) in the last minute.
  const sessionWorking = (sessionId: string): boolean => {
    const live = mods.live(sessionId);
    if (live) return live.phase === "working";
    const at = sessionActivity.get(sessionId);
    return at !== undefined && Date.now() - at < workingQuietMs();
  };
  // WAG-368: cases with an automatic nudge on its way, and when each last had news (a reply event).
  // One chain per case covers every queued reply of it.
  const autoNudgeNews = new Map<string, number>();
  const unsubscribeAutoNudge = bus.subscribe((event) => {
    if (event.type !== "reply.state_changed") return;
    const delay = autoNudgeDelayMs();
    if (delay === null) return;
    const caseId = event.case_id;
    if (!store.findQueuedReply(caseId)) return;
    const startedAt = Date.now();
    const running = autoNudgeNews.has(caseId);
    autoNudgeNews.set(caseId, startedAt);
    if (running) return;
    const arm = (after: number): void => {
      const timer = setTimeout(() => {
        autoNudgeTimers.delete(timer);
        const done = (): void => void autoNudgeNews.delete(caseId);
        // The reply is gone (waggle_check delivered it) or a wait holds the case: nothing to wake.
        if (heldWaits.has(caseId) || !store.findQueuedReply(caseId)) return done();
        const target = store.nudgeTarget(caseId);
        if (!target?.session?.can_nudge) return done();
        const holding = Date.now() - startedAt < NUDGE_HOLD_MAX_MS;
        // The nudge would queue behind the running turn and start a second one. Hold it, then look again.
        if (sessionWorking(target.session.id) && holding) return arm(delay);
        nudge(caseId)
          .then((result) => {
            // WAG-368: the window is taken by a nudge from before this news (an earlier reply of the same
            // talk). That nudge did not tell the agent about this reply: send one when the window ends.
            // A nudge sent after the news (a click on Nudge) already covers it.
            const last = lastNudgeAt.get(caseId);
            const news = autoNudgeNews.get(caseId) ?? startedAt;
            if (!result.sent && result.reason === "rate_limited" && holding && last !== undefined && last < news) {
              return arm(Math.max(last + nudgeIntervalMs() - Date.now(), 0) + delay);
            }
            done();
          })
          .catch(done);
      }, after);
      autoNudgeTimers.add(timer);
    };
    arm(delay);
  });

  // WAG-394: a new team comment on a shared case wakes the session the same way a reply does, with a message
  // that says it is a comment and not an answer. One per case per minute, and only while a comment is still new.
  const lastCommentNudgeAt = new Map<string, number>();
  const commentNudge = async (caseId: string): Promise<SessionNudgeResult> => {
    const target = store.nudgeTarget(caseId);
    const session = target?.session;
    if (!target || !session || session.state !== "live") return { sent: false, reason: "session_closed" };
    const viaMod = mods.attached(session.id);
    const viaSocket = session.can_nudge && sessionConns.has(session.id);
    if (!viaMod && !session.can_nudge) return { sent: false, reason: "not_supported" };
    if (!viaMod && !viaSocket) return { sent: false, reason: "session_closed" };
    const now = Date.now();
    const last = lastCommentNudgeAt.get(caseId);
    if (last !== undefined && now - last < nudgeIntervalMs()) return { sent: false, reason: "rate_limited" };
    lastCommentNudgeAt.set(caseId, now);
    let delivered = false;
    if (viaMod) delivered = await mods.queueNudge(session.id, { case_id: `comment-${crypto.randomUUID()}`, text: commentNudgeText(target.title, caseId) });
    if (!delivered && viaSocket) {
      const response = await pushToSession(session.id, "session.nudge", { case_id: caseId, title: target.title, kind: "comment" });
      const answer = response?.result as { ok?: unknown; reason?: unknown } | undefined;
      if (response && !response.error && answer?.ok === true) delivered = true;
      else if (answer?.reason === "rate_limited") return { sent: false, reason: "rate_limited" };
    }
    if (!delivered) {
      lastCommentNudgeAt.delete(caseId);
      return { sent: false, reason: "post_failed" };
    }
    store.recordEvent("session.nudged", { case_id: caseId, session_id: session.id });
    return { sent: true };
  };
  const commentWake = new Set<string>();
  const unsubscribeCommentNudge = bus.subscribe((event) => {
    if (event.type !== "comment.added" || !event.case_id) return;
    const delay = autoNudgeDelayMs();
    if (delay === null) return;
    const caseId = event.case_id;
    if (commentWake.has(caseId)) return;
    commentWake.add(caseId);
    const startedAt = Date.now();
    const arm = (after: number): void => {
      const timer = setTimeout(() => {
        autoNudgeTimers.delete(timer);
        const done = (): void => void commentWake.delete(caseId);
        // A wait that is open takes the comment itself. A comment the agent already has needs no wake.
        // WAG-401: a comment that came after the decision never wakes the agent. The owner sends it from the Mac app.
        if (heldWaits.has(caseId) || opts.relay?.hasNewEarlyComments(caseId) !== true) return done();
        const session = store.nudgeTarget(caseId)?.session;
        if (!session || (!session.can_nudge && !mods.attached(session.id))) return done();
        if (sessionWorking(session.id) && Date.now() - startedAt < NUDGE_HOLD_MAX_MS) return arm(delay);
        commentNudge(caseId)
          .then((result) => {
            if (!result.sent && result.reason === "rate_limited" && Date.now() - startedAt < NUDGE_HOLD_MAX_MS) {
              const last = lastCommentNudgeAt.get(caseId) ?? Date.now();
              return arm(Math.max(last + nudgeIntervalMs() - Date.now(), 0) + delay);
            }
            done();
          })
          .catch(done);
      }, after);
      autoNudgeTimers.add(timer);
    };
    arm(delay);
  });

  // session.send_prompt (HAIL-169): one prompt the person chose to send, through the mod.
  // The mod submits it as if typed (a busy session takes it when its turn ends). The id is
  // unique, so the mod's one-per-case window never swallows a second prompt. The text is
  // never logged or stored.
  const sendPrompt = async (p: SessionSendPromptParams): Promise<SessionSendPromptResult> => {
    const session = store.listSessions().find((s) => s.id === p.session_id);
    if (!session || session.state !== "live") return { sent: false, reason: "session_closed" };
    if (!mods.attached(session.id)) return { sent: false, reason: "not_supported" };
    const delivered = await mods.queueNudge(session.id, { case_id: `prompt-${crypto.randomUUID()}`, text: p.text });
    if (!delivered) return { sent: false, reason: "post_failed" };
    return { sent: true };
  };

  // mod.poll (HAIL-134): the mod's heartbeat and read. Holds up to wait_ms for a
  // change worth drawing or a nudge; answers at once when one is already there.
  const modPoll = async (p: ModPollParams, ctx: HandleContext): Promise<ModPollResult> => {
    const { session_id, wait_ms, seen, mod_version } = p;
    mods.beginPoll(session_id, mod_version);
    try {
      const read = (): ModPollResult => {
        const status = currentStatus(session_id);
        return {
          now: new Date().toISOString(),
          sig: status.sig,
          open_ask: status.open_ask,
          open_count: status.open_count,
          other_open_count: status.other_open_count,
          answer: status.answer,
          nudge: mods.takeNudge(session_id),
        };
      };
      const ready = () => mods.peekNudge(session_id) !== null || (seen !== undefined && currentStatus(session_id).sig !== seen);
      if (!wait_ms || ready()) return read();
      await new Promise<void>((resolve) => {
        let settled = false;
        const cleanups: (() => void)[] = [];
        const done = () => {
          if (settled) return;
          settled = true;
          for (const c of cleanups) c();
          resolve();
        };
        const timer = setTimeout(done, wait_ms);
        cleanups.push(() => clearTimeout(timer));
        cleanups.push(mods.onWake(session_id, done));
        cleanups.push(bus.subscribe((event) => {
          if (event.type === "case.created" || event.type === "case.updated" || event.type === "reply.state_changed") done();
        }));
        ctx.conn.waiters.add(done);
      });
      return read();
    } finally {
      mods.endPoll(session_id);
    }
  };
  // HAIL-137: the Waggle session of a Codex hook session. The shim uses CODEX_THREAD_ID as its
  // session id when Codex gives it one, and then the ids match. Otherwise the hook's folder
  // picks the one live Codex session in it; with none or two, the hook id stands alone and
  // nothing is blocked or merged by guess.
  const resolveHookSession = (hookId: string, cwd?: string): string => {
    const linked = mods.linked(hookId);
    if (linked !== hookId || store.findSession(hookId)) return linked;
    if (cwd) {
      const matches = store
        .listSessions()
        .filter((s) => s.runtime === "codex" && s.state === "live" && s.cwd === cwd && !mods.isLinkTarget(s.id));
      if (matches.length === 1) {
        mods.link(hookId, matches[0].id);
        return matches[0].id;
      }
    }
    return hookId;
  };

  // The oldest case of the session that still waits on the human, or whose answer is not picked up.
  const openAskFor = (sessionId: string) => {
    const taskId = store.sessionTaskId(sessionId);
    const cases = (taskId ? store.listTaskCases(taskId) : []).filter((c) => !c.dismissed_at && !c.withdrawn_at);
    return cases
      .filter(
        (c) =>
          c.status === "needs_you" ||
          (c.status !== "resolved" && c.done_at === null && c.latest_reply_at !== null && c.latest_reply_state === "queued"),
      )
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  };

  // HAIL-137: the Codex Stop hook. A session with an ask open (waiting on the human, or
  // answered and not yet picked up) must not end its turn: it should call waggle_check.
  const stopCheck = (sessionId: string): ModStopCheckResult => {
    const open = openAskFor(sessionId);
    if (!open || !mods.noteStopContinue(open.id)) return { block: false, case_id: null, reason: null };
    const title = clamp(plain(open.title), 90);
    return {
      block: true,
      case_id: open.id,
      reason: `A Waggle ask is still open (${title}). Call waggle_check with case_id ${open.id} and wait for the answer before ending your turn.`,
    };
  };

  const currentStatus = (sessionId: string) => {
    const taskId = store.sessionTaskId(sessionId);
    return modStatus(taskId, taskId ? store.listTaskCases(taskId) : [], store.listCases("needs_you"));
  };

  const sessionHandlers = new Map<string, Handler>([
    [
      "session.hello",
      {
        params: SessionHelloParams,
        handle: (p, ctx) => {
          const { session_id, cwd, branch, git_root, parent_pid, runtime, client_version, can_nudge, client_name, changes } =
            p as SessionHelloParams;
          // A client newer than this daemon would send shapes this daemon
          // cannot serve, so refuse with a clear message instead of a bare
          // "Internal error" (HAIL-27). The shim always sends its own version;
          // an older shim omits it and is still served (KNOCK-21).
          if (client_version !== undefined && isOlder(version, client_version)) {
            throw new RpcError(
              ERR_DAEMON_OLDER,
              `Waggle's background service is older than this client (daemon ${version}, client ${client_version}). Quit and reopen Waggle, or run \`waggle doctor\`.`,
            );
          }
          // Bind this connection to the session on both the first hello and a
          // reconnect, so a session that reconnects after a daemon restart can
          // still use case.create / case.wait / case.update / reply.ack.
          ctx.conn.sessionId = session_id;
          sessionConns.set(session_id, ctx.socket);
          // HAIL-222: the shim reads the project folder, never the daemon. Keep its latest footprint.
          if (changes !== undefined) sessionChanges.set(session_id, changes);
          const existing = store.findSession(session_id);
          // A hello that brings a session back (or starts it) is the start of work, not a keepalive.
          if (!existing || existing.state !== "live") sessionActivity.set(session_id, Date.now());
          if (existing) {
            // HAIL-178: a hello (a keepalive too) from a shim whose client is gone must not
            // bring the session back or stamp it seen. HAIL-192: the client the hello names is
            // the one that counts. A client that restarted under the same session id says hello
            // from a new, living parent, and that replaces the pid recorded at the first hello.
            const recorded = store.sessionPid(session_id);
            const client = parent_pid > 1 ? parent_pid : recorded;
            if (client !== null && client > 1 && !pidAlive(client)) {
              store.setSessionState(session_id, "ended");
              return { session_id, task_id: store.sessionTaskId(session_id) ?? "" };
            }
            if (parent_pid > 1 && parent_pid !== recorded) store.setSessionPid(session_id, parent_pid);
            store.setSessionCanNudge(session_id, can_nudge === true);
            if (client_name !== undefined) store.setSessionClientName(session_id, client_name);
            store.setSessionState(session_id, "live");
            // A hello on an already-live session is the shim's keepalive
            // (HAIL-63): setSessionState is a no-op then, so stamp last seen.
            store.touchSessionLastSeen(session_id);
            const taskId = store.sessionTaskId(session_id);
            if (!taskId) throw new RpcError(-32000, "session has no task");
            return { session_id, task_id: taskId };
          }
          const task = store.createTask({
            name: taskName(branch ?? null, cwd),
            project: projectName(git_root ?? null, cwd),
            linear_key: linearKey(branch ?? null),
          });
          store.createSession(task.id, {
            id: session_id,
            cwd,
            branch: branch ?? null,
            pid: parent_pid,
            runtime: runtime ?? "claude",
            can_nudge: can_nudge === true,
            client_name: client_name ?? null,
            // Only an explicit null means no git root; an older shim omits git_root (HAIL-163).
            no_git: git_root === null,
          });
          return { session_id, task_id: task.id };
        },
      },
    ],
    [
      "case.create",
      {
        params: CaseCreateParams,
        handle: (p, ctx) => {
          const session = requireSession(store, ctx.conn);
          const { client_request_id, ...input } = p as CaseCreateParams;
          store.setSessionTitle(session.sessionId, input.session_title);
          // WAG-268: the same ask again (same title and need) while the first is still open is the agent
          // retrying after a restart or a compaction. It gets the open case back, never a second one.
          if (input.follows === undefined && input.replaces === undefined) {
            const target = taskForAsk(store, session, input);
            const open = store.findOpenAsk(session.sessionId, target, input.title, input.need, !input.topic?.trim());
            if (open) {
              assertOwnCase(store, open, session.sessionId);
              const found = store.caseById(open);
              if (found) return { ...found, replaced_answer_note: null, words_warning: null };
            }
          }
          const created = store.createCase(
            taskForAsk(store, session, input),
            input,
            session.runtime,
            client_request_id ? { sessionId: session.sessionId, clientRequestId: client_request_id } : undefined,
            { id: session.sessionId, cwd: store.findSession(session.sessionId)?.cwd ?? "" },
          );
          // WAG-267: a new ask is visible work after the answers this session got.
          store.markRepliesApplied(session.sessionId);
          return created;
        },
      },
    ],
    [
      "case.wait",
      {
        params: CaseWaitParams,
        handle: (p, ctx) => {
          const { case_id, wait_ms } = p as CaseWaitParams;
          const session = requireSession(store, ctx.conn);
          assertOwnCase(store, case_id, session.sessionId);
          // WAG-394: a team comment the agent has not seen ends the wait at once, with a pending result that
          // carries the comments. The agent reads them and checks again.
          const news = () => opts.relay?.hasNewComments(case_id) === true;
          return waitForReply(store, bus, ctx, case_id, wait_ms, markDeliveryStarted, news).then((result) => {
            // WAG-387: the team's comments on a shared case ride along. They are not a reply.
            const shared = opts.relay?.commentsForAgent(case_id) ?? [];
            if (!result || shared.length === 0) return result;
            // The result goes to the agent now: the new comments are not new any more.
            opts.relay?.markGivenToAgent(case_id);
            return { ...result, shared_comments: shared };
          });
        },
      },
    ],
    [
      "case.update",
      {
        params: KnockUpdateInput,
        handle: (p, ctx) => {
          const input = p as KnockUpdateInput;
          const session = requireSession(store, ctx.conn);
          assertOwnCase(store, input.case_id, session.sessionId);
          store.setSessionTitle(session.sessionId, input.session_title);
          const updated = store.updateCase(input.case_id, input, { id: session.sessionId, cwd: store.findSession(session.sessionId)?.cwd ?? "" });
          if (!updated) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
          // WAG-267: a waggle_update on the case is visible work after its answer.
          store.markRepliesApplied(session.sessionId, input.case_id);
          // WAG-394: a reply to a team comment goes up to the shared page as from the Agent. The update itself
          // stays; a failed reply is told in one plain line.
          if (input.reply_to_comment === undefined) return updated;
          const { comment_id, body } = input.reply_to_comment;
          return (opts.relay ? opts.relay.replyToComment(input.case_id, comment_id, body, "agent") : Promise.reject(new RelayError("Sharing is not available in this daemon.")))
            .then(() => ({ ...updated, comment_reply: null }))
            .catch((err: unknown) => ({ ...updated, comment_reply: `Your reply to the comment was not posted. ${err instanceof RelayError ? err.message : "Try again."}` }));
        },
      },
    ],
    [
      "usage.tool_call",
      {
        params: UsageToolCallParams,
        // The shim reports a finished call. No session is needed: the row carries its own ids.
        handle: (p) => {
          store.toolLog?.record(p);
          return { ok: true };
        },
      },
    ],
    [
      "reply.ack",
      {
        params: ReplyAckParams,
        handle: (p, ctx) => {
          const { reply_id } = p as ReplyAckParams;
          const session = requireSession(store, ctx.conn);
          const caseId = store.replyCaseId(reply_id);
          if (caseId === null) throw new RpcError(ERR_CASE_NOT_FOUND, "reply not found");
          assertOwnCase(store, caseId, session.sessionId);
          const delivered = store.markReplyDelivered(reply_id);
          markDeliveryAcked(reply_id);
          return delivered ? toReplySummary(delivered) : delivered;
        },
      },
    ],
  ]);

  const settlePush = (line: string): boolean => {
    if (!line.includes('"push-')) return false;
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return false;
    }
    if (typeof message !== "object" || message === null || typeof message.id !== "string") {
      return false;
    }
    const settle = pendingPushes.get(message.id);
    if (!settle) return false;
    settle(message);
    return true;
  };

  // WAG-268: the shim sends this notification when the agent cancels a waiting waggle_ask or
  // waggle_check. It must not queue behind the wait it cancels, so it is handled here.
  const cancelWait = (conn: Conn, line: string): boolean => {
    if (!line.includes('"case.cancel_wait"')) return false;
    let message: { method?: unknown; params?: { case_id?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return false;
    }
    if (message.method !== "case.cancel_wait") return false;
    const caseId = message.params?.case_id;
    if (typeof caseId === "string") for (const cancel of [...(conn.caseWaiters.get(caseId) ?? [])]) cancel();
    return true;
  };

  let connections = 0;

  const server = Bun.listen<Conn>({
    unix: socketPath,
    socket: {
      open(socket) {
        connections += 1;
        socket.data = {
          lines: new LineSplitter(),
          unsubscribe: null,
          sessionId: null,
          queue: Promise.resolve(),
          waiters: new Set(),
          caseWaiters: new Map(),
          closed: false,
          outbox: [],
        };
      },
      data(socket, data) {
        const conn = socket.data;
        for (const line of conn.lines.push(data)) {
          if (line.trim().length > 0) {
            // A shim's answer to a daemon push settles at once. It must not wait
            // in the queue behind a long case.wait on the same connection.
            if (settlePush(line)) continue;
            if (cancelWait(conn, line)) continue;
            const run = () => handleLine(socket, line, conn, appHandlers, sessionHandlers, bus, store);
            // WAG-343: a case.wait holds its answer for minutes. It starts in order, after the calls
            // before it, but later calls (case.update) do not queue behind it.
            if (line.includes('"case.wait"')) void conn.queue.then(run);
            else conn.queue = conn.queue.then(run);
          }
        }
      },
      close(socket) {
        connections -= 1;
        const conn = socket.data;
        if (!conn) return;
        conn.closed = true;
        for (const cancel of conn.waiters) cancel();
        conn.waiters.clear();
        if (conn.unsubscribe) {
          conn.unsubscribe();
          conn.unsubscribe = null;
        }
        if (conn.sessionId) {
          if (sessionConns.get(conn.sessionId) === socket) {
            sessionConns.delete(conn.sessionId);
            sessionChanges.delete(conn.sessionId);
          }
          markDisconnected(store, conn.sessionId);
        }
      },
      drain(socket) {
        flushOutbox(socket);
      },
      error() {
        // A client that disconnects abruptly reports here; nothing to do.
      },
    },
  });

  // The socket must be 0600 (docs/protocol-mvp.md "Components").
  chmodSync(socketPath, 0o600);
  server.ref();

  return {
    socketPath,
    stop() {
      unsubscribeAutoNudge();
      unsubscribeCommentNudge();
      for (const t of autoNudgeTimers) clearTimeout(t);
      autoNudgeTimers.clear();
      server.stop(true);
    },
    openConnections() {
      return connections;
    },
  };
}

async function handleLine(
  socket: Bun.Socket<Conn>,
  line: string,
  conn: Conn,
  appHandlers: Map<string, Handler>,
  sessionHandlers: Map<string, Handler>,
  bus: EventBus,
  store: Store,
): Promise<void> {
  let req: unknown;
  try {
    req = JSON.parse(line);
  } catch {
    if (!conn.closed) write(socket, errorResponse(null, -32700, "Parse error"));
    return;
  }

  if (
    typeof req !== "object" ||
    req === null ||
    Array.isArray(req) ||
    typeof (req as { method?: unknown }).method !== "string"
  ) {
    if (!conn.closed) {
      write(socket, errorResponse((req as { id?: unknown })?.id, -32600, "Invalid request"));
    }
    return;
  }

  const request = req as { id?: unknown; method: string; params?: unknown };
  const { id, method } = request;
  const params = request.params ?? {};

  if (method === "events.subscribe") {
    const parsed = EventsSubscribeParams.safeParse(params);
    if (!parsed.success) {
      if (id !== undefined) {
        write(socket, errorResponse(id, -32602, "Invalid params", formatIssues(parsed.error)));
      }
      return;
    }
    if (id !== undefined) write(socket, successResponse(id, {}));
    if (!conn.unsubscribe) {
      conn.unsubscribe = bus.subscribe((event) => {
        if (!conn.closed) write(socket, eventNotification(event));
      });
    }
    return;
  }

  const entry = appHandlers.get(method) ?? sessionHandlers.get(method);
  if (!entry) {
    if (id !== undefined && !conn.closed) {
      write(socket, errorResponse(id, -32601, "Method not found"));
    }
    return;
  }

  const parsed = entry.params.safeParse(params);
  if (!parsed.success) {
    if (id !== undefined && !conn.closed) {
      write(socket, errorResponse(id, -32602, "Invalid params", formatIssues(parsed.error)));
    }
    return;
  }

  const ctx: HandleContext = { socket, conn };
  try {
    const result = await entry.handle(parsed.data, ctx);
    if (id !== undefined && !conn.closed) {
      write(socket, successResponse(id, result));
    }
  } catch (err) {
    if (id === undefined || conn.closed) return;
    if (err instanceof RpcError) {
      write(socket, errorResponse(id, err.code, err.message, err.data));
    } else if (err instanceof ArtifactError) {
      write(socket, errorResponse(id, ERR_ARTIFACT, err.message, { [ERROR_CODE_DATA_KEY]: err.errorCode }));
    } else if (err instanceof ReplyNotQueuedError) {
      write(socket, errorResponse(id, ERR_REPLY_NOT_QUEUED, replyNotQueuedMessage(err.state)));
    } else if (err instanceof ChoiceNotOfferedError) {
      write(socket, errorResponse(id, ERR_CHOICE_NOT_OFFERED, err.message));
    } else if (err instanceof FollowsCaseError) {
      write(socket, errorResponse(id, ERR_FOLLOWS_CASE_INVALID, err.message));
    } else if (err instanceof ReplacesCaseError) {
      write(socket, errorResponse(id, ERR_REPLACES_CASE_INVALID, err.message));
    } else {
      // An unexpected error: surface the real cause in error.data.message so
      // the CLI and the shim never print a bare "Internal error" (HAIL-27). WAG-409: a coded error
      // also carries its code.
      const errorCode = err instanceof CodedError ? { [ERROR_CODE_DATA_KEY]: err.errorCode } : {};
      write(
        socket,
        errorResponse(id, -32603, "Internal error", { message: (err as Error).message, ...errorCode }),
      );
    }
  }
}

// The connection must have said session.hello first. Returns its session id,
// task id, and runtime for denormalizing onto a case it creates (KNOCK-20).
// The daemon never needs the session's cwd: artifacts arrive staged by the
// shim, and naming uses the hello's branch and git_root (HAIL-26).
function requireSession(store: Store, conn: Conn): {
  sessionId: string;
  taskId: string;
  runtime: Runtime;
} {
  if (!conn.sessionId) throw new RpcError(ERR_SESSION_NOT_KNOWN, "session not known");
  const session = store.findSession(conn.sessionId);
  if (!session) throw new RpcError(ERR_SESSION_NOT_KNOWN, "session not known");
  const taskId = store.sessionTaskId(conn.sessionId);
  if (!taskId) throw new RpcError(-32000, "session has no task");
  // Every session RPC (case.create, case.wait, case.update, reply.ack) is a
  // sign of life beyond the connect/disconnect/end transitions
  // setSessionState already timestamps (HAIL-46 "last seen").
  store.touchSessionLastSeen(conn.sessionId);
  sessionActivity.set(conn.sessionId, Date.now());
  // HAIL-192: a call from a shim whose client is alive brings a session back from ended or
  // disconnected, and its failed replies with it. A session whose client is gone stays ended.
  store.reviveSessionIfAlive(conn.sessionId, pidAlive);
  return { sessionId: conn.sessionId, taskId, runtime: session.runtime };
}

// A case is yours when its task is your session's own task or a topic task your session made (HAIL-163).
function assertOwnCase(store: Store, caseId: string, sessionId: string): void {
  const caseTaskId = store.caseTaskId(caseId);
  if (caseTaskId === null) throw new RpcError(ERR_CASE_NOT_FOUND, "case not found");
  if (store.sessionOwnsTask(sessionId, caseTaskId)) return;
  // WAG-268: a restarted shim or a resumed session picks up the open case an earlier session made.
  if (store.sessionMayResume(sessionId, caseId)) {
    store.adoptCase(caseId);
    return;
  }
  throw new RpcError(ERR_NOT_YOUR_CASE, "not your case");
}

// HAIL-163: the task a new ask belongs to. A session with no git root may name the ask with a topic:
// same topic, same task. Inside git the topic is ignored and nothing changes. An ask that follows or
// replaces a case in one of the session's topic tasks stays in that task, topic or not.
function taskForAsk(store: Store, session: { sessionId: string; taskId: string }, input: KnockAskInput): string {
  const topic = input.topic?.trim();
  if (topic && store.sessionHasNoGit(session.sessionId)) return store.topicTaskId(session.sessionId, topic);
  for (const caseId of [input.follows, input.replaces]) {
    if (caseId === undefined) continue;
    const taskId = store.caseTaskId(caseId);
    if (taskId !== null && taskId !== session.taskId && store.sessionOwnsTask(session.sessionId, taskId)) {
      return taskId;
    }
  }
  return session.taskId;
}

// Cases with a case.wait open right now (HAIL-181): the daemon does not nudge for these, the
// waiting call takes the reply.
const heldWaits = new Map<string, number>();

// WAG-258: when each session last showed real activity: a session RPC (not the shim's keepalive hello) or a
// hello that brought the session back. The automatic nudge holds while a session without a mod looks busy.
const sessionActivity = new Map<string, number>();
// How long a session counts as mid-turn after its last activity (KNOCK_WORKING_QUIET_MS overrides it).
export const WORKING_QUIET_MS = 60_000;
// The longest the automatic nudge holds for a busy session before it gives up.
const NUDGE_HOLD_MAX_MS = 10 * 60_000;

function workingQuietMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.KNOCK_WORKING_QUIET_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : WORKING_QUIET_MS;
}

// Waits up to wait_ms for a queued reply of this case. Returns the reply payload
// (with its reply_id for the ack) or the pending shape on timeout. When a reply
// is returned, markDelivery(reply_id) is called so service.restart knows a
// delivery is in flight until reply.ack arrives (KNOCK-21).
function waitForReply(
  store: Store,
  bus: EventBus,
  ctx: HandleContext,
  caseId: string,
  waitMs: number,
  markDelivery: (replyId: string) => void,
  news: () => boolean = () => false,
): Promise<CaseWaitReply | PendingResult | undefined> {
  // HAIL-170: the owning session is checking this case now.
  store.recordCheck(caseId);
  const immediate = store.findDeliverableReply(caseId);
  if (immediate) {
    const payload = store.buildReplyPayload(immediate.id);
    if (payload) markDelivery(payload.reply_id);
    return Promise.resolve(payload ?? undefined);
  }
  // A case.wait on a case dismissed before this call ever started (a
  // waggle_check after the human dismissed it while the agent was away):
  // answer the same dismissal message immediately, not the pending timeout
  // (HAIL-32).
  if (store.isDismissed(caseId)) {
    return Promise.resolve(dismissalPayload());
  }
  // HAIL-152: a case the agent closed with a done update has no answer to wait for.
  if (store.isDone(caseId)) return Promise.resolve(donePayload());
  // WAG-394: a team comment is waiting for the agent. Answer now, as a pending result with the comments.
  if (news()) return Promise.resolve({ status: "pending", case_id: caseId, waited_s: store.recordCheck(caseId).waited_s });
  return new Promise<CaseWaitReply | PendingResult | undefined>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let unsubscribe: () => void;
    heldWaits.set(caseId, (heldWaits.get(caseId) ?? 0) + 1);
    const settle = (value: CaseWaitReply | PendingResult | undefined) => {
      if (settled) return;
      settled = true;
      const held = (heldWaits.get(caseId) ?? 1) - 1;
      if (held > 0) heldWaits.set(caseId, held);
      else heldWaits.delete(caseId);
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    unsubscribe = bus.subscribe((event) => {
      if (event.type === "reply.state_changed" && event.case_id === caseId) {
        const reply = store.findDeliverableReply(caseId);
        if (reply) {
          const payload = store.buildReplyPayload(reply.id);
          if (payload) markDelivery(payload.reply_id);
          settle(payload ?? undefined);
        }
      } else if (
        event.type === "case.updated" &&
        event.case_id === caseId &&
        store.isDismissed(caseId)
      ) {
        // case.dismiss emits case.updated (HAIL-32): a live case.wait settles
        // right here with the dismissal message, as a normal reply, so the
        // agent's waggle_ask/waggle_check never hangs to the timeout or errors.
        settle(dismissalPayload());
      } else if (event.type === "case.updated" && event.case_id === caseId && store.isDone(caseId)) {
        settle(donePayload());
      } else if (event.type === "comment.added" && event.case_id === caseId && news()) {
        settle({ status: "pending", case_id: caseId, waited_s: store.recordCheck(caseId).waited_s });
      }
    });
    timer = setTimeout(() => {
      store.recordUsage({ event: "ask_pending_timeout" });
      const { waited_s } = store.recordCheck(caseId);
      // The agent is told it may end its turn: it no longer counts as busy (WAG-258).
      if (ctx.conn.sessionId) sessionActivity.delete(ctx.conn.sessionId);
      settle({ status: "pending", case_id: caseId, waited_s });
    }, waitMs);
    const cancel = () => settle(undefined);
    ctx.conn.waiters.add(cancel);
    const forCase = ctx.conn.caseWaiters.get(caseId) ?? new Set<() => void>();
    forCase.add(cancel);
    ctx.conn.caseWaiters.set(caseId, forCase);
  });
}

// The dismissal answer to waggle_ask/waggle_check (docs/protocol-mvp.md "Case
// and reply states"): shaped exactly like a real case.wait reply so the shim
// (daemon/src/mcp/shim.ts waitForReply) hands it to the agent unchanged, and
// best-effort-acks a reply_id that names no real row (harmless: reply.ack on
// an unknown id just answers "reply not found", which the shim already
// swallows).
function dismissalPayload(): CaseWaitReply {
  return {
    reply_id: `dismiss_${randomUUID()}`,
    content: [{ type: "text", text: "The human dismissed this ask without answering." }],
  };
}

// HAIL-152: the answer to a waggle_check on a case closed by a done update.
function donePayload(): CaseWaitReply {
  return {
    reply_id: `done_${randomUUID()}`,
    content: [{ type: "text", text: "This case is closed as done. No answer will come." }],
  };
}

// A closed shim connection means disconnected; a dead parent means ended.
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function markDisconnected(store: Store, sessionId: string): void {
  store.setSessionState(sessionId, "disconnected");
  // WAG-268: cases show a disconnected session as live for SESSION_RECONNECT_GRACE_S. When that time
  // ends with no new hello, tell the app to read the state again.
  clearTimeout(graceTimers.get(sessionId));
  const timer = setTimeout(() => {
    graceTimers.delete(sessionId);
    try {
      store.emitSessionStateChanged(sessionId);
    } catch {
      // The daemon is stopping.
    }
  }, SESSION_RECONNECT_GRACE_S * 1000 + 200);
  timer.unref();
  graceTimers.set(sessionId, timer);
  const pid = store.sessionPid(sessionId);
  if (pid !== null && !pidAlive(pid)) {
    store.setSessionState(sessionId, "ended");
  }
}

// reply.replace on a reply that is no longer queued: why, for each terminal
// state (HAIL-34's delivered/failed, plus HAIL-44's superseded - the case it
// answered was withdrawn before an agent ever picked it up).
function replyNotQueuedMessage(state: ReplyStatus): string {
  switch (state) {
    case "delivered":
      return "Can't change this answer: the agent already picked it up.";
    case "superseded":
      return "Can't change this answer: the ask it answered was replaced.";
    case "queued":
    case "failed":
    default:
      return "Can't change this answer: the reply already failed.";
  }
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): unknown {
  return {
    [ERROR_CODE_DATA_KEY]: "invalid_params",
    issues: error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

function write(socket: Bun.Socket<Conn>, value: unknown): void {
  const conn = socket.data;
  const bytes = new TextEncoder().encode(JSON.stringify(value) + "\n");
  if (!conn) {
    try { socket.write(bytes); } catch { /* closed */ }
    return;
  }
  if (conn.closed) return;
  conn.outbox.push(bytes);
  flushOutbox(socket);
}

// Writes queued bytes until the socket stops accepting them; the drain
// handler calls this again when the socket is writable.
function flushOutbox(socket: Bun.Socket<Conn>): void {
  const conn = socket.data;
  if (!conn) return;
  while (conn.outbox.length > 0 && !conn.closed) {
    const chunk = conn.outbox[0];
    let written: number;
    try {
      written = socket.write(chunk);
    } catch {
      conn.outbox = [];
      return;
    }
    if (written < 0) {
      conn.outbox = [];
      return;
    }
    if (written < chunk.length) {
      conn.outbox[0] = chunk.subarray(written);
      return;
    }
    conn.outbox.shift();
  }
}

function successResponse(id: unknown, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: unknown, code: number, message: string, data?: unknown): object {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function eventNotification(event: unknown): object {
  return { jsonrpc: "2.0", method: "event", params: event };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
