import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { diffMarkdown } from "./markdown-diff";
import { MAX_MARKDOWN_BYTES } from "./artifacts/stage";
import { dirname, extname, isAbsolute, join } from "node:path";
import {
  ingestReplyAttachments,
  removeDroppedAttachments,
  removeIncomingDirs,
  removeReplyAttachments,
  type ReplyAttachmentRecord,
} from "./artifacts/attachments";
import type { Database } from "bun:sqlite";
import { migrate } from "./schema";
import { ProjectLog } from "./projects";
import type { AskPreferences } from "./guide/asks";
import {
  ArtifactPreset,
  AskDetail,
  AskReach,
  AskFrequency,
  AskTopics,
  AskLearn,
  AskAfterDecide,
  AskLess,
  AskWords,
  DEFAULT_ASK_LESS,
  DEFAULT_ARTIFACT_PRESET,
  DEFAULT_ASK_DETAIL,
  DEFAULT_ASK_LEARN,
  DEFAULT_ASK_AFTER_DECIDE,
  DEFAULT_ASK_REACH,
  DEFAULT_ASK_FREQUENCY,
  DEFAULT_ASK_TOPICS,
  DEFAULT_ASK_WORDS,
} from "./protocol/rpc";
import { checkAskWords, instructionReplyWarning, joinWarnings, noGroupWarning, titleLengthWarning, wordsWarning } from "./guide/ste100";

// HAIL-163: a session serves its own task and every topic task it made (tasks.owner_session_id).
// Bind the task id once; ?1 is read twice.
// WAG-268: a shim that is gone for less than this long (a restart, a compaction) still shows as
// live on its cases. The app then shows no "Closed" for a short reconnect.
export const SESSION_RECONNECT_GRACE_S = 60;
// A repeated waggle_ask takes over an open ask of an earlier session only when that session was seen within this time.
const RESUME_ASK_WINDOW_MS = 30 * 60_000;
const SESSION_OF_TASK = `(task_id = ?1 OR id = (SELECT owner_session_id FROM tasks WHERE id = ?1))`;
import type { EventBus } from "./events";
import {
  ArtifactError,
  ingestBundle,
  ingestDiagram,
  ingestMarkdown,
  ingestScreenshot,
  ingestScreenshots,
  resolveIncoming,
  type StagedBundle,
  type StagedDiagram,
  type StagedMarkdown,
  type StagedScreenshot,
  type StagedScreenshots,
  type StagedScreenshotsItem,
} from "./artifacts/ingest";
import type {
  Artifact,
  ArtifactKind,
  ArtifactPathResult,
  AskTextAnchor,
  AskTextPart,
  Case,
  CaseDetail,
  CaseStatus,
  Capture,
  Comment,
  Event,
  EventType,
  KnockAskInput,
  KnockUpdateInput,
  McpContent,
  Message,
  SharedComment,
  Option,
  PlanRound,
  PlanStage,
  PointAnswer,
  ReplyAttachment,
  ReplyAttachmentInput,
  Question,
  Reply,
  ReplySummary,
  ReplyFormat,
  ReplySource,
  ReplyIntent,
  ReplyStatus,
  Revision,
  Runtime,
  ServiceStatus,
  Session,
  SessionInfo,
  SessionState,
  Task,
} from "./protocol";
import { AskCategory, AUTO_RULE_IDS, type UsageRuleId } from "./protocol/states";
import {
  dropUnknownMarkers,
  mapMarkedText,
  markerWarning,
  uncitedWarning,
  SOURCES_MAX,
  stripSourceMarkers,
  type MarkerReport,
  type Source,
  type SourceInput,
} from "./protocol/sources";
import { checkSources } from "./sessions/sources-check";
import {
  type Item,
  type ItemAnswer,
  itemsOfRound,
  normalizeAsk,
  normalizeReply,
  normalizeUpdate,
  projectLegacy,
  projectLegacyReply,
  replyOutcome as decideOrTalk,
  type ReplyLike,
  type Round,
} from "./protocol/items";
import { POINT_DEFAULT_CHOICES, pointOptionLabel } from "./protocol/nouns";
import { DesignKit, EMPTY_DESIGN_KIT, type DesignKitChange } from "./protocol/design-kit";
import { type DecidedMatch, reindexDecidedCase, searchDecidedAsks } from "./decided-index";
import { noteBucket, replyOutcome, UsageLogger } from "./usage";
import { storedReplyCorrection } from "./corrections";
import type { ToolCallLog } from "./usage/tools";

// The five shapes an ingest() call can return, one per artifact kind
// (HAIL-40 added StagedScreenshots; HAIL-141 added StagedDiagram).
type StagedArtifact = StagedScreenshot | StagedBundle | StagedMarkdown | StagedScreenshots | StagedDiagram;

// The daemon is the only writer of knock.db (AGENTS.md). This class owns every
// read and write. Mutations append to the events table and then publish to the
// EventBus, so events.subscribe connections see every change (KNOCK-02 scope:
// case reads, status, the event log; case creation exists so later stories and
// the restart test share one code path).
export class Store {
  readonly db: Database;
  readonly dataRoot: string;
  private bus?: EventBus;
  private usage?: UsageLogger;
  // WAG-260: the project page (decision log, themes).
  readonly projects: ProjectLog;

  constructor(db: Database, dataRoot: string, bus?: EventBus, usage?: UsageLogger) {
    this.db = db;
    this.dataRoot = dataRoot;
    this.bus = bus;
    this.usage = usage;
    // Wait for a lock instead of failing at once: a daemon that starts while
    // another connection still closes the file (a restart, a test seed) got
    // SQLITE_BUSY on the WAL pragma and crashed before it bound the socket.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    this.projects = new ProjectLog(db);
  }

  // --- reads ---

  listCases(status?: CaseStatus): Case[] {
    const sql = `${caseSelectColumns()}
      ${status ? "WHERE c.status = ?" : ""}
      ORDER BY c.created_at DESC`;
    const rows = (
      status ? this.db.query(sql).all(status) : this.db.query(sql).all()
    ) as CaseRow[];
    return rows.map((row) => this.withAnswerText(rowToCase(row)));
  }

  // HAIL-134: every case of one task (one session), newest first. The Claude Code
  // mod's poll reads it, so it must not scan every case the daemon ever stored.
  listTaskCases(taskId: string): Case[] {
    const rows = this.db
      .query(`${caseSelectColumns()} WHERE c.task_id = ? ORDER BY c.created_at DESC`)
      .all(taskId) as CaseRow[];
    return rows.map((row) => this.withAnswerText(rowToCase(row)));
  }

  // WAG-295: the answer body of a reply nobody has picked up yet, as waggle_check formats it
  // (formatReplyContent without its first "Reply to ..." line). One formatter, so a pasted answer
  // cannot drift from the delivered one. Delivered and detail-request replies get none.
  private withAnswerText(c: Case): Case {
    if (c.latest_reply_id === null || c.latest_reply_intent !== "decision") return c;
    if (c.latest_reply_state !== "queued" && c.latest_reply_state !== "failed") return c;
    const first = this.buildReplyPayload(c.latest_reply_id, false)?.content[0];
    if (first?.type !== "text") return c;
    return { ...c, latest_reply_answer_text: first.text.split("\n").slice(1).join("\n") };
  }

  getCase(id: string): CaseDetail | null {
    const caseRow = this.db
      .query(`${caseSelectColumns()} WHERE c.id = ?`)
      .get(id) as CaseRow | undefined;
    if (!caseRow) return null;

    const task = this.db
      .query(`SELECT id, name, project FROM tasks WHERE id = ?`)
      .get(caseRow.task_id) as TaskRow | undefined;
    const messages = (
      this.db
        .query(`SELECT * FROM messages WHERE case_id = ? ORDER BY created_at`)
        .all(id) as MessageRow[]
    ).map(rowToMessage);
    // WAG-351: a revision belongs to the newest round made at or before it (an artifact-only update stays
    // with the round on screen; an edit by "you" stays with the round it answers).
    const roundTimes = this.db
      .query(`SELECT seq, created_at FROM option_sets WHERE case_id = ? ORDER BY seq`)
      .all(id) as { seq: number; created_at: string }[];
    const roundOfRevision = (createdAt: string): number | undefined => {
      let seq = roundTimes[0]?.seq;
      for (const set of roundTimes) if (set.created_at <= createdAt) seq = set.seq;
      return seq;
    };
    const revisions = (
      this.db
        .query(`SELECT * FROM revisions WHERE case_id = ? ORDER BY n`)
        .all(id) as RevisionRow[]
    ).map((row) => rowToRevision(row, roundOfRevision(row.created_at)));
    const comments = (
      this.db
        .query(`SELECT * FROM comments WHERE case_id = ? ORDER BY n`)
        .all(id) as CommentRow[]
    ).map(rowToComment);
    const replies = (
      this.db
        .query(`SELECT * FROM replies WHERE case_id = ? ORDER BY created_at`)
        .all(id) as ReplyRow[]
    ).map((row) => toReplySummary(rowToReply(this.db, row, false)));

    const planRounds = caseRow.plan_stage_json !== null ? this.planRounds(id) : null;
    return {
      rounds: this.rounds(caseRow),
      case: this.withAnswerText(rowToCase(caseRow)),
      task: task ?? { id: caseRow.task_id, name: "", project: "" },
      messages,
      revisions,
      comments,
      replies,
      ...(planRounds !== null ? { plan_rounds: planRounds } : {}),
    };
  }

  // One capture's image for capture.image (PERF-2), or null for an unknown id.
  captureImage(captureId: string, which: "raw" | "annotated"): string | null {
    const row = this.db
      .query(`SELECT png_base64, annotated_png_base64 FROM captures WHERE id = ?`)
      .get(captureId) as { png_base64: string; annotated_png_base64: string } | undefined;
    if (!row) return null;
    return which === "raw" ? row.png_base64 : row.annotated_png_base64;
  }

  serviceStatus(version: string, execPath: string): ServiceStatus {
    const sessionsLive = (
      this.db
        .query(`SELECT COUNT(*) AS n FROM sessions WHERE state = 'live'`)
        .get() as { n: number }
    ).n;
    const casesOpen = (
      this.db
        .query(
          `SELECT COUNT(*) AS n FROM cases WHERE status IN ('needs_you', 'waiting_on_agent')`,
        )
        .get() as { n: number }
    ).n;
    return {
      version,
      data_root: this.dataRoot,
      sessions_live: sessionsLive,
      cases_open: casesOpen,
      exec_path: execPath,
    };
  }

  eventsAfter(seq: number): Event[] {
    return (
      this.db
        .query(
          `SELECT type, case_id, reply_id, session_id, at
           FROM events WHERE seq > ? ORDER BY seq`,
        )
        .all(seq) as EventRow[]
    ).map(rowToEvent);
  }

  // --- writes ---

  createTask(input: {
    id?: string;
    name: string;
    project: string;
    linear_key?: string | null;
  }): Task {
    const id = input.id ?? newId("t");
    this.db
      .query(
        `INSERT INTO tasks (id, name, project, linear_key, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.project, input.linear_key ?? null, new Date().toISOString());
    return { id, name: input.name, project: input.project };
  }

  // Creates a case and its case.created event atomically. When the ask carries
  // an artifact, the incoming copy is ingested as revision 1 in the same write:
  // a rejected artifact leaves no case behind (AC 3). `runtime` is denormalized
  // from the creating session (KNOCK-20); it defaults to "claude" for callers
  // that seed a case directly (tests, test-ask) without a session.
  //
  // `replaces` (HAIL-44) is validated the same way as `follows` (exists, same
  // task), then, in the same write: the named case is withdrawn (status
  // resolved, withdrawn_at set - it leaves needs_you/waiting_on_agent the same
  // way a dismiss does, but there is no restore) and any reply still queued on
  // it is marked superseded, never delivered. `replaced_answer_note` carries
  // the fixed sentence waggle_ask prepends to its result when that queued reply
  // existed, so the human's answer to the withdrawn ask is never silently
  // lost; null every other time.
  createCase(
    taskId: string,
    rawInput: KnockAskInput,
    runtime: Runtime = "claude",
    request?: { sessionId: string; clientRequestId: string },
    session?: { id: string; cwd: string },
    matchedCaseIds: readonly string[] = [],
  ): Case & { replaced_answer_note: string | null; words_warning: string | null } {
    // WAG-354: a marker that names no cited source is removed from the text before anything is stored.
    const markers: MarkerReport = { count: 0, unknown: [], cited: [] };
    const cited = new Set((rawInput.sources ?? []).map((s) => s.id));
    const input = mapMarkedText(rawInput, (text) => dropUnknownMarkers(text, cited, markers));
    // HAIL-197: a retried case.create with the same client_request_id returns the first case.
    if (request) {
      const prior = this.db
        .query(`SELECT id FROM cases WHERE request_session_id = ? AND client_request_id = ?`)
        .get(request.sessionId, request.clientRequestId) as { id: string } | null;
      const row = prior
        ? (this.db.query(`${caseSelectColumns()} WHERE c.id = ?`).get(prior.id) as CaseRow | undefined)
        : undefined;
      if (row) return { ...rowToCase(row), replaced_answer_note: null, words_warning: null };
    }
    if (input.follows !== undefined) {
      const followedTaskId = this.caseTaskId(input.follows);
      if (followedTaskId === null || followedTaskId !== taskId) {
        throw new FollowsCaseError(
          `follows must name an existing case from the same task: ${input.follows}`,
        );
      }
    }
    let replacedCaseRow: CaseRow | null = null;
    if (input.replaces !== undefined) {
      const replacedTaskId = this.caseTaskId(input.replaces);
      if (replacedTaskId === null || replacedTaskId !== taskId) {
        throw new ReplacesCaseError(
          `replaces must name an existing case from the same task: ${input.replaces}`,
        );
      }
      replacedCaseRow = this.db
        .query(`SELECT * FROM cases WHERE id = ?`)
        .get(input.replaces) as CaseRow;
    }
    const id = newId("c");
    const now = new Date().toISOString();
    const sources = input.sources !== undefined ? this.checkedSources(input.sources, session, now) : null;
    // Three blocks (WAG-313): every ask, old shape or new, becomes items. The old columns are filled
    // from the same items by projectLegacy, so an old app reads what it always read.
    const ask = normalizeAsk(input);
    const legacy = projectLegacy(ask);
    const options = legacy.options;
    const recommendations = legacy.recommendations;
    const recommendation = legacy.recommendation;
    const recommendationWhy = legacy.recommendation_why;
    const selectMode = legacy.select;
    const maxChoices = legacy.max;
    const recommendationsJson = JSON.stringify(recommendations);
    // The questions shortcut keeps the agent's own questions in the old column, as they always were.
    const legacyQuestions = input.questions ?? legacy.questions;
    const itemsJson = JSON.stringify(ask.items);
    const kind = ask.kind;
    // WAG-412: the operator's rule may decide a small ask at once. Null for every ask that goes to the queue.
    const auto = this.autoDecision(input, ask, kind);
    // HAIL-140: warn when the ask breaks an ASD-STE100 limit, only while the
    // operator's writing mode is "asd". Never a rejection: the case is created
    // either way, and `words_warning` rides back to waggle_ask.
    const wordsWarningText = joinWarnings(
      this.getAskWords() === "asd" ? this.askWordsWarning(input.need, input.why, input.questions === undefined ? ask.items : [], recommendationWhy) : null,
      // WAG-249: the title stays short, in any writing mode.
      titleLengthWarning(input.title),
      markerWarning(markers),
      uncitedWarning((rawInput.sources ?? []).map((s) => s.id), markers),
      // WAG-361: the questions shortcut gets no group warning.
      input.questions === undefined ? noGroupWarning(ask.items) : null,
      // WAG-371: a suggested reply that reads as an instruction to the human.
      input.questions === undefined ? instructionReplyWarning(ask.items) : null,
    );
    // Several artifacts (operator decision 8 Oct) are several revisions, in the order the agent gave them.
    const staged: StagedArtifact[] = [];
    try {
      ask.artifacts.forEach((artifact, i) => staged.push(this.ingest(id, artifact, i + 1)));
    } catch (err) {
      this.removeStagedBundles(staged);
      throw err;
    }
    const lastStaged = staged[staged.length - 1] ?? null;
    const events: Event[] = [];
    let replacedAnswerNote: string | null = null;
    try {
      this.db.transaction(() => {
        this.db
          .query(
            `INSERT INTO cases
              (id, task_id, kind, title, need, why, recommendation,
               recommendation_why, options_json, status, runtime, follows_case_id,
               replaces_case_id, created_at, updated_at,
               select_mode, max_choices, recommendations_json,
               request_session_id, client_request_id, questions_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            taskId,
            kind,
            input.title,
            input.need,
            input.why,
            recommendation,
            recommendationWhy,
            JSON.stringify(options),
            auto !== null ? "resolved" : "needs_you",
            runtime,
            input.follows ?? null,
            input.replaces ?? null,
            now,
            now,
            selectMode,
            maxChoices,
            recommendationsJson,
            request?.sessionId ?? null,
            request?.clientRequestId ?? null,
            JSON.stringify(legacyQuestions),
          );
        this.db
          .query(
            `INSERT INTO option_sets (case_id, seq, options_json, recommendation, recommendation_why, created_at,
               select_mode, max_choices, recommendations_json, stage_json, question, revision, own_artifact, items_json, sources_json)
             VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            JSON.stringify(options),
            recommendation,
            recommendationWhy,
            now,
            selectMode,
            maxChoices,
            recommendationsJson,
            ask.stage !== undefined ? JSON.stringify(ask.stage) : null,
            ask.stage !== undefined ? input.need : null,
            staged.length > 0 ? staged.length : null,
            staged.length > 0 ? 1 : 0,
            itemsJson,
            sources !== null ? JSON.stringify(sources) : null,
          );
        // An auto-decided case never raises "case.created": no notification, no phone message, no share.
        // "case.updated" tells the app to refresh its "Decided for you" list.
        if (auto !== null) {
          this.db
            .query(`UPDATE cases SET auto_category = ?, auto_rule = ?, auto_choice = ?, auto_answer = ?, auto_at = ? WHERE id = ?`)
            .run(auto.category, auto.rule, auto.choice, auto.answer, now, id);
        }
        if (matchedCaseIds.length > 0) {
          this.db.query(`UPDATE cases SET matched_case_ids_json = ? WHERE id = ?`).run(JSON.stringify(matchedCaseIds), id);
        }
        events.push(this.appendEvent(auto !== null ? "case.updated" : "case.created", { case_id: id }));
        staged.forEach((artifact, i) => {
          events.push(this.insertRevisionRow(id, artifact, i + 1, ask.artifacts[i]?.name).event);
        });
        if (input.replaces !== undefined && replacedCaseRow !== null) {
          const queuedReply = this.db
            .query(`SELECT * FROM replies WHERE case_id = ? AND state = 'queued' ORDER BY created_at LIMIT 1`)
            .get(input.replaces) as ReplyRow | undefined;
          if (queuedReply) {
            replacedAnswerNote =
              `Note: the human answered the ask you replaced: ` +
              `${describeReplyAnswer(this.db, replacedCaseRow!, queuedReply, this.replyOptionSetSeq(queuedReply.id))}. ` +
              `Take it into account.`;
            // The note below carries the answer to the agent, so the reply counts as delivered (HAIL-130).
            this.db
              .query(`UPDATE replies SET state = 'delivered', delivered_at = ? WHERE id = ?`)
              .run(now, queuedReply.id);
            this.usage?.record({ event: "reply_delivered" });
            events.push(
              this.appendEvent("reply.state_changed", {
                reply_id: queuedReply.id,
                case_id: input.replaces,
              }),
            );
          }
          this.db
            .query(
              `UPDATE cases SET status = 'resolved', withdrawn_at = ?, updated_at = ? WHERE id = ?`,
            )
            .run(now, now, input.replaces);
          reindexDecidedCase(this.db, input.replaces);
          events.push(this.appendEvent("case.updated", { case_id: input.replaces }));
        }
      })();
    } catch (err) {
      this.removeStagedBundles(staged);
      throw err;
    }
    for (const event of events) this.bus?.emit(event);
    const task = this.taskRowById(taskId);
    if (this.usage) {
      this.usage.record({
        event: "ask_created",
        kind,
        ...(lastStaged !== null ? { artifact_kind: lastStaged.kind } : {}),
        project_h: this.usage.projectHash(task?.project ?? ""),
        ask_h: this.usage.askHash(id),
        ...(ask.stage !== undefined ? { stage: ask.stage.name } : {}),
        n: ask.items.length,
        ...(this.categoryInUse(input) !== null ? { category: this.categoryInUse(input)! } : {}),
      });
      if (auto !== null) this.usage.record({ event: "ask_auto_decided", category: auto.category, rule_id: auto.rule });
      staged.forEach((_, i) => this.usage?.record({ event: "revision_added", n: i + 1 }));
    }
    return {
      id,
      task_id: taskId,
      task_name: task?.name ?? "",
      project: task?.project ?? "",
      linear_key: task?.linear_key ?? null,
      kind,
      title: input.title,
      need: input.need,
      questions: legacyQuestions,
      items: ask.items,
      ...(sources !== null ? { sources } : {}),
      why: input.why,
      recommendation,
      recommendation_why: recommendationWhy,
      select: selectMode,
      max: maxChoices,
      recommendations,
      options,
      status: auto !== null ? "resolved" : "needs_you",
      has_artifact: staged.length > 0,
      artifact_kind: lastStaged?.kind ?? null,
      latest_reply_id: null,
      latest_reply_state: null,
      latest_reply_at: null,
      latest_reply_delivered_at: null,
      latest_reply_apply_state: null,
      latest_reply_choice: null,
      latest_reply_choices: [],
      latest_reply_answers: [],
      latest_reply_message: null,
      latest_reply_intent: null,
      latest_reply_source: null,
      first_reply_submitted_at: null,
      update_count: 0,
      latest_update_at: null,
      latest_update_message: null,
      revision_count: staged.length,
      latest_revision_at: staged.length > 0 ? now : null,
      runtime,
      session_state: this.currentSessionState(taskId),
      dismissed_at: null,
      follows_case_id: input.follows ?? null,
      replaces_case_id: input.replaces ?? null,
      withdrawn_at: null,
      done_at: null,
      working_note: null,
      last_check_at: null,
      session_can_nudge: null,
      session_client_name: null,
      session_ended_at: null,
      created_at: now,
      updated_at: now,
      ...(ask.stage !== undefined ? { plan: { stage: ask.stage, rounds: 1, answered: 0, ...(lastStaged !== null ? { artifact_kind: lastStaged.kind } : {}) } } : {}),
      ...(auto !== null ? { auto_decided: { ...auto, at: now } } : {}),
      ...(matchedCaseIds.length > 0 ? { matched_case_ids: [...matchedCaseIds] } : {}),
      replaced_answer_note: replacedAnswerNote,
      words_warning: wordsWarningText,
    };
  }

  // WAG-412: the category an ask names, when the master switch is on and the word is on the fixed list. Else null.
  private categoryInUse(input: { category?: string }): AskCategory | null {
    if (!this.getAskLess().enabled) return null;
    const parsed = AskCategory.safeParse(input.category);
    return parsed.success ? parsed.data : null;
  }

  // WAG-412: the rule decision for a new ask, or null (the ask goes to the queue). It decides only when ALL are true:
  // the master is on, the rule of the category is on, the ask is a question (never a review, never a plan round), it is
  // one item with options and a recommendation that names one of them, it is not a follow-up to a human reply that
  // nobody has picked up yet, and it replaces no case. The answer is the recommended option.
  private autoDecision(
    input: { category?: string; follows?: string; replaces?: string },
    ask: { stage?: unknown; items: Item[] },
    kind: "question" | "review",
  ): { category: AskCategory; rule: UsageRuleId; choice: string; answer: string } | null {
    const category = this.categoryInUse(input);
    if (category === null || !this.getAskLess().rules[category]) return null;
    if (kind !== "question" || ask.stage !== undefined || input.replaces !== undefined) return null;
    if (ask.items.length !== 1) return null;
    const item = ask.items[0]!;
    if (item.select !== "one" || typeof item.recommendation !== "string") return null;
    const picked = item.options.find((o) => o.id === item.recommendation);
    if (!picked) return null;
    if (input.follows !== undefined) {
      const pending = this.db
        .query(`SELECT 1 FROM replies WHERE case_id = ? AND state IN ('queued', 'failed') LIMIT 1`)
        .get(input.follows);
      if (pending !== null) return null;
    }
    return { category, rule: AUTO_RULE_IDS[category], choice: picked.id, answer: picked.title ?? picked.label };
  }

  // WAG-416: the project of a task, the strong past decisions of that project that fit an ask, and whether the
  // Ask less rules would decide the ask at once (a rule-decided ask is never held).
  taskProject(taskId: string): string {
    return this.taskRowById(taskId)?.project ?? "";
  }
  searchDecided(project: string, ask: KnockAskInput): DecidedMatch[] {
    const ask2 = normalizeAsk(ask);
    return searchDecidedAsks(this.db, project, {
      title: ask.title,
      need: ask2.need,
      optionLabels: ask2.items.flatMap((item) => item.options.map((o) => o.label)),
    });
  }
  // The coded usage events of the check (no text): a hold with its match count, and a failed search.
  recordAskCheck(event: "ask_held" | "ask_check_failed", n?: number): void {
    this.usage?.record({ event, ...(n !== undefined ? { n, kind: "question" as const } : {}) });
  }
  askKindOf(ask: KnockAskInput): "question" | "review" {
    return normalizeAsk(ask).kind;
  }
  wouldAutoDecide(ask: KnockAskInput): boolean {
    const normalized = normalizeAsk(ask);
    return this.autoDecision(ask, normalized, normalized.kind) !== null;
  }

  // WAG-412: the cases a rule decided since `since`, newest first, that the person has not changed (a reply makes
  // a case a normal answered one).
  listAutoDecided(since?: string): Case[] {
    const rows = this.db
      .query(`${caseSelectColumns()} WHERE c.auto_at IS NOT NULL AND c.auto_at >= ? ORDER BY c.auto_at DESC`)
      .all(since ?? "") as CaseRow[];
    return rows.map((row) => rowToCase(row)).filter((c) => c.latest_reply_id === null);
  }

  // WAG-412: "Change my mind". A case a rule decided, with no reply yet, becomes an open ask again (needs_you) and leaves
  // the "Decided for you" list. The person then answers it in the normal pane. Any other case is returned unchanged.
  changeMind(caseId: string): Case | null {
    const row = this.db
      .query(`SELECT auto_at FROM cases WHERE id = ?`)
      .get(caseId) as { auto_at: string | null } | undefined;
    if (!row) return null;
    const hasReply = this.db.query(`SELECT 1 FROM replies WHERE case_id = ? LIMIT 1`).get(caseId) !== null;
    if (row.auto_at === null || hasReply) return this.caseById(caseId);
    const now = new Date().toISOString();
    const events: Event[] = [];
    this.db.transaction(() => {
      this.db.query(`UPDATE cases SET status = 'needs_you', auto_at = NULL, mind_changed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, caseId);
      events.push(this.appendEvent("case.updated", { case_id: caseId }));
    })();
    for (const event of events) this.bus?.emit(event);
    return this.caseById(caseId);
  }

  // The ASD-STE100 limits an ask or a round breaks, as a warning text, or null (HAIL-140). One item is
  // checked like the old single ask. With several items each item is checked on its own, so "over 6
  // options" counts the options of one item, never all of them. Question texts are not checked.
  private askWordsWarning(needIn: string | undefined, whyIn: string | undefined, itemsIn: Item[], recommendationWhyIn: string): string | null {
    // Source markers are not words (WAG-354).
    const need = needIn === undefined ? undefined : stripSourceMarkers(needIn);
    const why = whyIn === undefined ? undefined : stripSourceMarkers(whyIn);
    const recommendationWhy = stripSourceMarkers(recommendationWhyIn);
    const items = mapMarkedText({ items: itemsIn }, stripSourceMarkers).items;
    const violations =
      items.length <= 1
        ? checkAskWords({ need, why, options: items[0]?.options ?? [], recommendation_why: recommendationWhy === "" ? undefined : recommendationWhy })
        : [
            ...new Set([
              ...checkAskWords({ need, why }),
              ...items.flatMap((i) => checkAskWords({ options: i.options, recommendation_why: i.recommendation_why })),
            ]),
          ];
    return violations.length > 0 ? wordsWarning(violations) : null;
  }

  // WAG-354: the check for the cited sources. Never throws: a failure gives every source as stated.
  private checkedSources(sources: SourceInput[], session: { id: string; cwd: string } | undefined, askedAt: string): Source[] {
    try {
      return checkSources(sources, {
        sessionId: session?.id ?? "",
        cwd: session?.cwd ?? "",
        transcriptAllowed: this.toolLog ? this.toolLog.transcriptEnabled : true,
        askedAt,
        decisionRepliedAt: (caseId) => {
          const row = this.db
            .query(`SELECT MAX(created_at) AS at FROM replies WHERE case_id = ? AND state NOT IN ('failed', 'superseded')`)
            .get(caseId) as { at: string | null } | null;
          return row?.at ?? null;
        },
      });
    } catch {
      return sources.map((s) => ({ ...s, state: s.kind === "none" ? ("assumption" as const) : ("stated" as const) }));
    }
  }

  // A failed write removes the html bundles it already copied into the data folder.
  private removeStagedBundles(staged: StagedArtifact[]): void {
    for (const artifact of staged) {
      if (artifact.kind === "html_bundle") rmSync(artifact.path, { recursive: true, force: true });
    }
  }

  // The stage of a plan ask's newest round, or null when the case is not a plan ask (HAIL-151).
  private latestPlanStage(caseId: string): PlanStage | null {
    const row = this.db
      .query(
        `SELECT stage_json FROM option_sets WHERE case_id = ? AND stage_json IS NOT NULL ORDER BY seq DESC LIMIT 1`,
      )
      .get(caseId) as { stage_json: string } | undefined;
    return row ? (JSON.parse(row.stage_json) as PlanStage) : null;
  }

  // Every Round of a case, oldest first (spec 2.7): one per option_sets row, each with its items. The
  // answer is the newest decide reply of the round. A reply belongs to the round named by plan_round,
  // else by reply_option_sets.seq, else to the newest round made before the reply (spec 2.8, no backfill).
  // A talk reply (more detail, discuss, comments only) never answers a round; talk_count counts them.
  private rounds(caseRow: CaseRow): Round[] {
    const sets = this.db
      .query(
        `SELECT o.seq, o.items_json, o.sources_json, o.options_json, o.recommendation, o.recommendation_why, o.select_mode, o.max_choices,
           o.recommendations_json, o.created_at, o.stage_json, o.question, o.revision, o.own_artifact,
           (SELECT r.kind FROM revisions r WHERE r.case_id = o.case_id AND r.n = o.revision) AS artifact_kind
         FROM option_sets o WHERE o.case_id = ? ORDER BY o.seq`,
      )
      .all(caseRow.id) as (OptionSetItemsRow & {
      created_at: string;
      stage_json: string | null;
      question: string | null;
      revision: number | null;
      own_artifact: number;
      artifact_kind: ArtifactKind | null;
      sources_json: string | null;
    })[];
    const replies = this.db
      .query(
        `SELECT r.intent, r.choice, r.choices_json, r.answers_json, r.item_answers_json, r.message, r.created_at, r.plan_round,
           (SELECT ros.seq FROM reply_option_sets ros WHERE ros.reply_id = r.id) AS ros_seq
         FROM replies r WHERE r.case_id = ? AND r.state NOT IN ('failed', 'superseded') ORDER BY r.created_at, r.rowid`,
      )
      .all(caseRow.id) as {
      intent: ReplyIntent;
      choice: string | null;
      choices_json: string | null;
      answers_json: string | null;
      item_answers_json: string | null;
      message: string | null;
      created_at: string;
      plan_round: number | null;
      ros_seq: number | null;
    }[];
    const seqs = new Set(sets.map((set) => set.seq));
    const roundOf = (r: { plan_round: number | null; ros_seq: number | null; created_at: string }): number => {
      if (r.plan_round !== null && seqs.has(r.plan_round)) return r.plan_round;
      if (r.ros_seq !== null && seqs.has(r.ros_seq)) return r.ros_seq;
      let seq = sets[0]?.seq ?? 0;
      for (const set of sets) if (set.created_at <= r.created_at) seq = set.seq;
      return seq;
    };
    return sets.map((set): Round => {
      const items = itemsOfRound(set, caseRow);
      let answer: Round["answer"] = null;
      let talk = 0;
      for (const r of replies) {
        if (roundOf(r) !== set.seq) continue;
        const like = replyLikeOf(r);
        if (decideOrTalk({ items }, like) === "talk") {
          talk += 1;
          continue;
        }
        const itemAnswers = r.item_answers_json !== null ? (JSON.parse(r.item_answers_json) as ItemAnswer[]) : normalizeReply(items, like);
        answer = {
          ...(r.choice !== null ? { choice: r.choice } : {}),
          ...(r.choices_json !== null ? { choices: JSON.parse(r.choices_json) as string[] } : {}),
          ...(itemAnswers.length > 0 ? { item_answers: itemAnswers } : {}),
          ...(r.message !== null ? { message: r.message } : {}),
          created_at: r.created_at,
        };
      }
      return {
        seq: set.seq,
        ...(set.stage_json !== null ? { stage: JSON.parse(set.stage_json) as PlanStage } : {}),
        question: set.question ?? (set.seq === 0 ? caseRow.need : ""),
        items,
        created_at: set.created_at,
        revision: set.revision,
        own_artifact: set.own_artifact === 1,
        artifact_kind: set.artifact_kind,
        answer,
        talk_count: talk,
        ...(set.sources_json ? { sources: parseSources(set.sources_json) } : {}),
      };
    });
  }

  // Every round of a plan ask, oldest first, each with the decision that answered it (HAIL-151).
  // A round counts as answered by the newest decision reply stamped with its seq.
  private planRounds(caseId: string): PlanRound[] {
    const sets = this.db
      .query(
        `SELECT o.seq, o.options_json, o.recommendation, o.recommendation_why, o.created_at, o.stage_json, o.question,
           o.revision, o.own_artifact,
           (SELECT r.kind FROM revisions r WHERE r.case_id = o.case_id AND r.n = o.revision) AS artifact_kind
         FROM option_sets o WHERE o.case_id = ? AND o.stage_json IS NOT NULL ORDER BY o.seq`,
      )
      .all(caseId) as {
      seq: number;
      options_json: string;
      recommendation: string;
      recommendation_why: string;
      created_at: string;
      stage_json: string;
      question: string | null;
      revision: number | null;
      own_artifact: number;
      artifact_kind: ArtifactKind | null;
    }[];
    const replies = this.db
      .query(
        `SELECT plan_round, choice, choices_json, message, created_at FROM replies
         WHERE case_id = ? AND plan_round IS NOT NULL AND intent = 'decision'
           AND state NOT IN ('failed', 'superseded')
         ORDER BY created_at, rowid`,
      )
      .all(caseId) as {
      plan_round: number;
      choice: string | null;
      choices_json: string | null;
      message: string | null;
      created_at: string;
    }[];
    return sets.map((set) => {
      const reply = [...replies].reverse().find((r) => r.plan_round === set.seq);
      return {
        seq: set.seq,
        stage: JSON.parse(set.stage_json) as PlanStage,
        question: set.question ?? "",
        options: JSON.parse(set.options_json) as Option[],
        recommendation: set.recommendation,
        recommendation_why: set.recommendation_why,
        created_at: set.created_at,
        revision: set.revision,
        own_artifact: set.own_artifact === 1,
        artifact_kind: set.artifact_kind,
        answer: reply
          ? {
              ...(reply.choice !== null ? { choice: reply.choice } : {}),
              ...(reply.choices_json !== null ? { choices: JSON.parse(reply.choices_json) as string[] } : {}),
              ...(reply.message !== null ? { message: reply.message } : {}),
              created_at: reply.created_at,
            }
          : null,
      };
    });
  }

  // The state of a task's most recently connected session, or null when the
  // task has no session row yet (createCase's own return value needs this
  // without a second cases.get round trip; caseSelectColumns' subquery covers
  // every other read path).
  private currentSessionState(taskId: string): SessionState | null {
    const row = this.db
      .query(`SELECT state FROM sessions WHERE ${SESSION_OF_TASK} ORDER BY connected_at DESC LIMIT 1`)
      .get(taskId) as { state: SessionState } | undefined;
    return row?.state ?? null;
  }

  // The edit revision a reply may carry (HAIL-168): it must be a revision by "you" on this case.
  // Returns its number, or null when the reply carries no edit.
  // The items a reply may answer: the newest round, then the first one (as a choice falls back to the
  // first option set, HAIL-108).
  private replyCandidateItems(caseId: string): Item[][] {
    const newest = itemsAtSeq(this.db, caseId, null);
    const first = itemsAtSeq(this.db, caseId, 0);
    return newest.length === first.length && newest.every((it, i) => it.id === first[i]?.id) ? [newest] : [newest, first];
  }

  // Checks item_answers against the items, one error that names the item (spec 2.5). A Decide reply on
  // several items answers every item.
  private checkItemAnswers(items: Item[], answers: ItemAnswer[], decide: boolean): void {
    const seen = new Set<string>();
    for (const a of answers) {
      const item = items.find((i) => i.id === a.item_id);
      if (!item) throw new ChoiceNotOfferedError("", `item_answers names ${a.item_id}, which is not an item of this request`);
      if (seen.has(a.item_id)) throw new ChoiceNotOfferedError("", `item_answers answers item ${a.item_id} twice`);
      seen.add(a.item_id);
      const ids = item.options.map((o) => o.id);
      if (item.select === "reply") {
        if (a.text === undefined) throw new ChoiceNotOfferedError("", `item ${a.item_id} wants a written reply: send text`);
      } else if (a.text !== undefined) {
        throw new ChoiceNotOfferedError("", `item ${a.item_id} has options: send choice or choices, not text`);
      } else if (item.select === "one") {
        if (a.choice === undefined) throw new ChoiceNotOfferedError("", `item ${a.item_id} takes one choice: send choice`);
        if (!ids.includes(a.choice)) throw new ChoiceNotOfferedError(a.choice, `${a.choice} is not an option of item ${a.item_id}`);
      } else {
        if (a.choices === undefined) throw new ChoiceNotOfferedError("", `item ${a.item_id} takes several choices: send choices`);
        const bad = a.choices.find((c) => !ids.includes(c));
        if (bad !== undefined) throw new ChoiceNotOfferedError(bad, `${bad} is not an option of item ${a.item_id}`);
        if (item.max !== undefined && a.choices.length > item.max) {
          throw new ChoiceNotOfferedError("", `item ${a.item_id} takes at most ${item.max} choices`);
        }
      }
    }
    if (decide && items.length > 1) {
      const missing = items.find((i) => !seen.has(i.id));
      if (missing) throw new ChoiceNotOfferedError("", `item_answers has no answer for item ${missing.id}: a decision answers every item`);
    }
  }

  // WAG-328: a pre-selected recommendation is a suggestion, not a choice. An item answer marked
  // confirmed:false whose choice equals the item's recommendation is no decision: the reply is stored as
  // Keep talking (discuss), without the choice. The marker is never stored. No marker means an older app.
  private settleConfirmation<T extends ReplyContentInput>(caseId: string, input: T): T {
    const answers = input.item_answers;
    if (answers === undefined || !answers.some((a) => a.confirmed !== undefined)) return input;
    const stripped = answers.map(({ confirmed: _confirmed, ...rest }) => rest);
    const unconfirmed =
      (input.intent ?? "decision") === "decision" &&
      answers.some((a) => a.confirmed === false && this.isRecommendedPick(caseId, a));
    if (!unconfirmed) return { ...input, item_answers: stripped };
    const { choice: _choice, choices: _choices, item_answers: _answers, ...rest } = input;
    return { ...rest, intent: "discuss" } as T;
  }

  private isRecommendedPick(caseId: string, answer: ItemAnswer): boolean {
    if (answer.choice === undefined && answer.choices === undefined) return false;
    return this.replyCandidateItems(caseId).some((items) =>
      items.some((item) => {
        if (item.id !== answer.item_id || item.recommendation === undefined) return false;
        const ids = Array.isArray(item.recommendation) ? item.recommendation : [item.recommendation];
        if (item.select === "one") return answer.choice !== undefined && ids.includes(answer.choice);
        // WAG-329: a many answer equal to the whole recommendation set is a pre-pick too.
        if (item.select !== "many" || answer.choices === undefined) return false;
        const picked = new Set(answer.choices);
        return picked.size === ids.length && ids.every((id) => picked.has(id));
      }),
    );
  }

  // A reply with item_answers: checks them, then fills the old fields they project to (choice, choices,
  // answers, message) for each the reply does not give itself, so every old reader keeps working.
  private withItemAnswers<T extends ReplyContentInput>(caseId: string, input: T): T {
    const answers = input.item_answers;
    if (answers === undefined || answers.length === 0) return input;
    let chosen: Item[] | undefined;
    let failure: unknown;
    for (const items of this.replyCandidateItems(caseId)) {
      try {
        this.checkItemAnswers(items, answers, (input.intent ?? "decision") === "decision");
        chosen = items;
        break;
      } catch (err) {
        failure ??= err;
      }
    }
    if (chosen === undefined) throw failure;
    const projected = projectLegacyReply(chosen, answers);
    return {
      ...input,
      ...(input.choice === undefined && projected.choice !== undefined ? { choice: projected.choice } : {}),
      ...(input.choices === undefined && projected.choices !== undefined ? { choices: projected.choices } : {}),
      ...(input.answers === undefined && projected.answers !== undefined ? { answers: projected.answers } : {}),
      ...(input.message === undefined && projected.message !== undefined ? { message: projected.message } : {}),
    };
  }

  // True when this reply decides (spec 1.3). Only a deciding reply answers a plan round (spec 2.8).
  private replyDecides(caseId: string, input: ReplyContentInput): boolean {
    return (
      decideOrTalk(
        { items: itemsAtSeq(this.db, caseId, null) },
        {
          intent: input.intent ?? "decision",
          message: input.message,
          choice: input.choice,
          choices: input.choices,
          answers: input.answers,
          item_answers: input.item_answers,
        },
      ) === "decide"
    );
  }

  // The answers of a reply, as JSON, checked against the case's questions: each answer names a question
  // and a point of the case, and its choice is one of the point's options (or Yes, No, Talk with the team).
  // Null when the reply has no answers. Throws ChoiceNotOfferedError for an answer the case does not offer.
  private checkedAnswers(caseId: string, input: ReplyContentInput): string | null {
    if (input.answers === undefined) return null;
    // Answers projected from item_answers were checked against the items of the round already.
    if (input.item_answers !== undefined && input.item_answers.length > 0) return JSON.stringify(input.answers);
    const row = this.db.query(`SELECT questions_json FROM cases WHERE id = ?`).get(caseId) as { questions_json: string | null } | undefined;
    const questions = JSON.parse(row?.questions_json ?? "[]") as Question[];
    if (input.answers.length > 0 && questions.length === 0) {
      throw new ChoiceNotOfferedError("", "this request has no questions: send choice, not answers");
    }
    const seen = new Set<string>();
    for (const a of input.answers) {
      const point = questions.find((q) => q.id === a.question_id)?.points.find((p) => p.id === a.point_id);
      if (!point) throw new ChoiceNotOfferedError("", `answers names ${a.question_id}/${a.point_id}, which is not a point of this request`);
      const key = `${a.question_id}/${a.point_id}`;
      if (seen.has(key)) throw new ChoiceNotOfferedError("", `answers answers ${key} twice`);
      seen.add(key);
      const offered: readonly string[] = point.options ? point.options.map(pointOptionLabel) : POINT_DEFAULT_CHOICES;
      if (!offered.includes(a.choice)) throw new ChoiceNotOfferedError(a.choice, `${a.choice} is not an option of ${key}`);
    }
    return JSON.stringify(input.answers);
  }

  // A discuss reply (WAG-301) as two JSON columns: [leaning_json, ruled_out_json]. Other replies get
  // [null, null]. A discuss reply needs at least one of leaning, ruled_out, message and comments (a review
  // with comments and no pick keeps talking, WAG-316); only a discuss
  // reply may carry leaning or ruled_out; an id may not be in both lists.
  private discussJson(input: ReplyContentInput): [string | null, string | null] {
    const leaning = input.leaning ?? [];
    const ruledOut = input.ruled_out ?? [];
    if (input.intent !== "discuss") {
      if (leaning.length > 0 || ruledOut.length > 0) {
        throw new ChoiceNotOfferedError("", "leaning and ruled_out belong to a discuss reply: set intent discuss");
      }
      return [null, null];
    }
    if (
      leaning.length === 0 &&
      ruledOut.length === 0 &&
      !input.message?.trim() &&
      input.comments.length === 0 &&
      (input.attachments?.length ?? 0) === 0
    ) {
      throw new ChoiceNotOfferedError("", "a discuss reply needs leaning, ruled_out, a message, comments or files");
    }
    const both = leaning.find((id) => ruledOut.includes(id));
    if (both !== undefined) throw new ChoiceNotOfferedError(both, `${both} cannot be both leaning and ruled out`);
    return [leaning.length > 0 ? JSON.stringify(leaning) : null, ruledOut.length > 0 ? JSON.stringify(ruledOut) : null];
  }

  // The option set a discuss reply's ids are from: the newest set when it has them all, else the first.
  // Null when it names no option. Throws ChoiceNotOfferedError for an id neither set has.
  private discussOptionSet(caseId: string, input: ReplyContentInput): number | null {
    const ids = [...(input.leaning ?? []), ...(input.ruled_out ?? [])];
    if (ids.length === 0) return null;
    // The ids a round offers: the option ids of a single item, or "<item id>/<option id>" with several items
    // (spec 2.5, the wire is ready; the app offers lean on single-item asks only for now).
    const rows = this.db
      .query(
        `SELECT seq, items_json, options_json, recommendation, recommendation_why, select_mode, max_choices, recommendations_json
         FROM option_sets WHERE case_id = ? ORDER BY seq`,
      )
      .all(caseId) as OptionSetItemsRow[];
    const caseRow = this.db.query(`SELECT questions_json FROM cases WHERE id = ?`).get(caseId) as { questions_json: string | null } | undefined;
    const sets = rows.map((row) => ({ seq: row.seq, offered: offeredIds(itemsOfRound(row, caseRow ?? {})) }));
    const hasAll = (set: { offered: string[] }): boolean => ids.every((id) => set.offered.includes(id));
    const newest = sets[sets.length - 1];
    if (newest && hasAll(newest)) return newest.seq;
    if (sets[0] && hasAll(sets[0])) return sets[0].seq;
    const known = sets.flatMap((s) => s.offered);
    const unknown = ids.find((id) => !known.includes(id)) ?? ids[0]!;
    throw new ChoiceNotOfferedError(unknown, `${unknown} is not an option of this ask`);
  }

  private checkedEditRevision(caseId: string, input: ReplyContentInput): number | null {
    if (input.edit === undefined) return null;
    const row = this.db
      .query(`SELECT author FROM revisions WHERE case_id = ? AND n = ?`)
      .get(caseId, input.edit.revision) as { author: string } | undefined;
    if (!row || row.author !== "you") {
      throw new ArtifactError(`revision ${input.edit.revision} is not an edit by the person`);
    }
    return input.edit.revision;
  }

  // revision.add_by_human (HAIL-168): stores the person's edited markdown as the next revision of
  // the case, author "you". The markdown is staged like any markdown revision (content-addressed
  // blob). Returns the revision, with the base revision and the number of passages changed.
  addHumanRevision(caseId: string, baseRevision: number, markdown: string): Revision {
    if (!this.caseExists(caseId)) throw new ArtifactError(`case not found: ${caseId}`);
    const base = this.db
      .query(`SELECT * FROM revisions WHERE case_id = ? AND n = ?`)
      .get(caseId, baseRevision) as RevisionRow | undefined;
    if (!base) throw new ArtifactError(`revision ${baseRevision} not found`);
    if (base.kind !== "markdown") throw new ArtifactError("only a markdown revision can be edited");
    const data = Buffer.from(markdown, "utf8");
    if (data.length > MAX_MARKDOWN_BYTES) throw new ArtifactError("markdown is larger than 1 MB");
    const before = this.readMarkdown(base);
    const { passages } = diffMarkdown(before, markdown, "", "");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const blobsDir = join(this.dataRoot, "blobs");
    const dest = join(blobsDir, `${sha256}.md`);
    mkdirSync(blobsDir, { recursive: true });
    if (!existsSync(dest)) {
      try {
        writeFileSync(dest, data, { flag: "wx" });
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
      }
    }
    const n = this.nextRevisionNumber(caseId);
    const inserted = this.db.transaction(() => {
      const result = this.insertRevisionRow(caseId, { kind: "markdown", sha256, path: dest }, n);
      this.db
        .query(`UPDATE revisions SET author = 'you', base_n = ?, passages_changed = ? WHERE id = ?`)
        .run(baseRevision, passages, result.revision.id);
      return result;
    })();
    this.bus?.emit(inserted.event);
    return { ...inserted.revision, author: "you", base_revision: baseRevision, passages_changed: passages };
  }

  private readMarkdown(row: RevisionRow): string {
    return readFileSync(join(this.dataRoot, "blobs", `${row.sha256}.md`), "utf8");
  }

  // The text the agent gets for a reply with an edit: the new markdown and a unified diff
  // against the revision the person started from.
  private editPayloadLines(reply: Reply): string[] {
    if (reply.edit === undefined) return [];
    const get = (n: number): RevisionRow | undefined =>
      this.db.query(`SELECT * FROM revisions WHERE case_id = ? AND n = ?`).get(reply.case_id, n) as
        | RevisionRow
        | undefined;
    const base = get(reply.edit.base_revision);
    const edited = get(reply.edit.revision);
    if (!base || !edited) return [];
    const newText = this.readMarkdown(edited);
    const diff = diffMarkdown(this.readMarkdown(base), newText, `v${base.n}`, `v${edited.n} (by the person)`);
    const { passages_changed: count } = reply.edit;
    return [
      `The person edited your document: v${edited.n} is their version, made from v${base.n}. ` +
        `${count} ${count === 1 ? "passage" : "passages"} changed. Use their version as the base.`,
      `Diff v${base.n} to v${edited.n}:`,
      "```diff",
      diff.unified,
      "```",
      `The new text (v${edited.n}):`,
      "~~~~markdown",
      newText,
      "~~~~",
    ];
  }

  // Ingests an artifact as the next revision of a case and records it, emitting
  // revision.added. The artifact paths must already be staged by the shim into
  // KNOCK_HOME/incoming/. A rejected artifact throws ArtifactError and writes
  // nothing (KNOCK-03).
  createRevision(caseId: string, artifact: Artifact): Revision {
    if (!this.caseExists(caseId)) {
      throw new ArtifactError(`case not found: ${caseId}`);
    }
    const n = this.nextRevisionNumber(caseId);
    const staged = this.ingest(caseId, artifact, n);

    try {
      const inserted = this.db.transaction(() =>
        this.insertRevisionRow(caseId, staged, n, artifact.name),
      )();
      this.bus?.emit(inserted.event);
      this.usage?.record({ event: "revision_added", n });
      return inserted.revision;
    } catch (err) {
      // The files were staged before the insert; drop a bundle copy so a failed
      // insert never leaves an r<n> dir behind. Blobs are content-addressed, so
      // an orphan blob is harmless and may be reused.
      if (staged.kind === "html_bundle") {
        try {
          rmSync(staged.path, { recursive: true, force: true });
        } catch {
          // Nothing to clean.
        }
      }
      throw err;
    }
  }

  // The absolute staged path of one revision, for artifact.path. Returns null
  // when the case or revision does not exist.
  artifactPath(caseId: string, revision: number): ArtifactPathResult | null {
    const row = this.db
      .query(`SELECT * FROM revisions WHERE case_id = ? AND n = ?`)
      .get(caseId, revision) as RevisionRow | undefined;
    if (!row) return null;
    if (row.kind === "screenshot" || row.kind === "markdown" || row.kind === "diagram") {
      return {
        kind: row.kind,
        root: join(this.dataRoot, "blobs", `${row.sha256}.${row.ext}`),
        entry: "",
      };
    }
    if (row.kind === "screenshots") {
      const items = JSON.parse(row.items_json ?? "[]") as StagedScreenshotsItem[];
      return {
        kind: "screenshots",
        root: "",
        entry: "",
        items: items.map((item) => ({
          path: join(this.dataRoot, "blobs", `${item.sha256}.${item.ext}`),
          ...(item.caption !== undefined ? { caption: item.caption } : {}),
          ...(item.item !== undefined ? { item: item.item } : {}),
        })),
      };
    }
    const root = join(this.dataRoot, "bundles", caseId, `r${revision}`);
    const result: ArtifactPathResult = { kind: "html_bundle", root, entry: join(root, row.entry ?? "") };
    if (row.viewport_width !== null && row.viewport_height !== null) {
      result.viewport = { width: row.viewport_width, height: row.viewport_height };
    }
    if (row.preview !== null) {
      const ext = extname(row.preview).toLowerCase();
      result.preview = { kind: ext === ".html" ? "html" : "image", path: join(root, row.preview) };
    }
    return result;
  }

  // --- sessions (shim only) ---

  findSession(id: string): Session | null {
    const row = this.db
      .query(`SELECT id, cwd, branch, pid, state, runtime, connected_at FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      cwd: row.cwd,
      branch: row.branch,
      pid: row.pid,
      state: row.state,
      runtime: row.runtime,
      connected_at: row.connected_at,
    };
  }

  // `runtime` defaults to "claude" for callers that predate KNOCK-20 (tests
  // seeding a session directly without going through session.hello).
  createSession(
    taskId: string,
    input: {
      id: string;
      cwd: string;
      branch: string | null;
      pid: number;
      runtime?: Runtime;
      can_nudge?: boolean;
      client_name?: string | null;
      no_git?: boolean;
    },
  ): Session {
    const now = new Date().toISOString();
    const runtime = input.runtime ?? "claude";
    this.db
      .query(
        `INSERT INTO sessions (id, task_id, cwd, branch, pid, state, runtime, connected_at, last_seen_at, can_nudge, no_git, client_name)
         VALUES (?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        taskId,
        input.cwd,
        input.branch,
        input.pid,
        runtime,
        now,
        now,
        input.can_nudge ? 1 : 0,
        input.no_git ? 1 : 0,
        input.client_name ?? null,
      );
    if (this.usage) {
      const live = (
        this.db
          .query(`SELECT COUNT(*) AS n FROM sessions WHERE state = 'live'`)
          .get() as { n: number }
      ).n;
      this.usage.record({ event: "session_started", n: live });
    }
    return {
      id: input.id,
      cwd: input.cwd,
      branch: input.branch,
      pid: input.pid,
      state: "live",
      runtime,
      connected_at: now,
    };
  }

  // Marks a session's state and emits session.state_changed when it actually
  // changes (a reconnect to live, a close to disconnected, a dead parent to ended).
  // Ending a session also fails its task's queued replies: only an ended session
  // can fail a queued reply (docs/protocol-mvp.md "Case and reply states").
  setSessionState(id: string, state: SessionState): void {
    const row = this.db
      .query(`SELECT state FROM sessions WHERE id = ?`)
      .get(id) as { state: SessionState } | undefined;
    if (!row || row.state === state) return;
    const now = new Date().toISOString();
    const events: Event[] = [];
    let failedReplyIds: string[] = [];
    this.db.transaction(() => {
      this.db
        .query(`UPDATE sessions SET state = ?, last_seen_at = ? WHERE id = ?`)
        .run(state, now, id);
      events.push(this.appendEvent("session.state_changed", { session_id: id }));
      // HAIL-192: a session that comes back from ended gets its failed replies back in the queue.
      if (state === "live" && row.state === "ended") {
        for (const taskId of [this.sessionTaskId(id), ...this.topicTaskIds(id)]) {
          if (taskId) events.push(...this.requeueFailedRepliesForTaskInTx(taskId));
        }
      }
      if (state === "ended") {
        const taskIds = [this.sessionTaskId(id), ...this.topicTaskIds(id)];
        for (const taskId of taskIds) {
          if (!taskId) continue;
          const failed = this.failQueuedRepliesForTaskInTx(taskId, "session_unreachable");
          events.push(...failed.events);
          failedReplyIds.push(...failed.replyIds);
        }
      }
    })();
    for (const event of events) this.bus?.emit(event);
    for (const replyId of failedReplyIds) {
      this.usage?.record({ event: "reply_failed" });
    }
    // WAG-267: a closed session that never acted on a delivered answer.
    if (state === "ended") this.markRepliesNotApplied({ sessionId: id });
  }

  // Bumps a live session's last_seen_at to now. Called on every session RPC
  // call (case.create, case.wait, case.update, reply.ack) so "last seen"
  // reflects real activity between the state transitions setSessionState
  // already timestamps, without a separate heartbeat RPC (HAIL-46). A no-op
  // for an unknown id.
  touchSessionLastSeen(id: string): void {
    this.db
      .query(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  // HAIL-170: the owning session called waggle_check (case.wait) for this case just now. Returns the
  // seconds the case has waited since it was created, for the pending text. When the owning
  // session cannot be nudged, the app learns of the check through a case.updated event.
  recordCheck(caseId: string): { waited_s: number; can_nudge: boolean | null } {
    const now = new Date();
    this.db.query(`UPDATE cases SET last_check_at = ? WHERE id = ?`).run(now.toISOString(), caseId);
    const row = this.db.query(`SELECT created_at FROM cases WHERE id = ?`).get(caseId) as
      | { created_at: string }
      | undefined;
    const canNudge = this.caseById(caseId)?.session_can_nudge ?? null;
    if (canNudge === false) this.recordEvent("case.updated", { case_id: caseId });
    const created = row ? Date.parse(row.created_at) : now.getTime();
    return { waited_s: Math.max(0, Math.round((now.getTime() - created) / 1000)), can_nudge: canNudge };
  }

  // Every session the daemon knows about, for `waggle doctor`'s "sessions"
  // section and the app's Connection screen (HAIL-46, docs/protocol-mvp.md
  // "Socket RPC" sessions.list). Live sessions first, then disconnected, then
  // ended, each ordered by last_seen_at descending - the same "most recently
  // active first" order within each group.
  listSessions(): SessionInfo[] {
    const rows = this.db
      .query(
        `SELECT s.id, s.task_id, s.cwd, s.branch, s.pid, s.state, s.runtime, s.connected_at, s.last_seen_at, s.can_nudge, s.client_name, s.session_title,
                t.name AS task_name, t.project AS project
         FROM sessions s JOIN tasks t ON t.id = s.task_id
         ORDER BY CASE s.state WHEN 'live' THEN 0 WHEN 'disconnected' THEN 1 ELSE 2 END,
                  s.last_seen_at DESC`,
      )
      .all() as SessionInfoRow[];
    return rows.map(rowToSessionInfo);
  }

  sessionTaskId(id: string): string | null {
    const row = this.db
      .query(`SELECT task_id FROM sessions WHERE id = ?`)
      .get(id) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  // HAIL-163: true when the shim said it found no git root, so asks may name a topic.
  sessionHasNoGit(id: string): boolean {
    const row = this.db.query(`SELECT no_git FROM sessions WHERE id = ?`).get(id) as { no_git: number } | undefined;
    return row?.no_git === 1;
  }

  // HAIL-163: the task for one topic of a session, made on first use. Same topic (any case), same
  // task, so asks about one job group together. The topic is both the task name and the project.
  topicTaskId(sessionId: string, topic: string): string {
    const found = this.db
      .query(`SELECT id FROM tasks WHERE owner_session_id = ? AND name = ? COLLATE NOCASE`)
      .get(sessionId, topic) as { id: string } | undefined;
    if (found) return found.id;
    const id = newId("t");
    this.db
      .query(`INSERT INTO tasks (id, name, project, linear_key, created_at, owner_session_id) VALUES (?, ?, ?, NULL, ?, ?)`)
      .run(id, topic, topic, new Date().toISOString(), sessionId);
    return id;
  }

  private topicTaskIds(sessionId: string): string[] {
    return (
      this.db.query(`SELECT id FROM tasks WHERE owner_session_id = ?`).all(sessionId) as { id: string }[]
    ).map((r) => r.id);
  }

  // HAIL-163: does this session own the task? Its own task, or a topic task it made.
  sessionOwnsTask(sessionId: string, taskId: string): boolean {
    if (this.sessionTaskId(sessionId) === taskId) return true;
    const row = this.db.query(`SELECT owner_session_id FROM tasks WHERE id = ?`).get(taskId) as
      | { owner_session_id: string | null }
      | undefined;
    return row?.owner_session_id === sessionId;
  }

  // HAIL-76: what the shim said in its latest session.hello.
  setSessionCanNudge(id: string, canNudge: boolean): void {
    this.db.query(`UPDATE sessions SET can_nudge = ? WHERE id = ?`).run(canNudge ? 1 : 0, id);
  }

  // WAG-279: the title the agent sent with waggle_ask or waggle_update. Latest wins; an empty one is ignored.
  setSessionTitle(id: string, title: string | undefined): void {
    const t = title?.replace(/\s+/g, " ").trim();
    if (!t) return;
    this.db.query(`UPDATE sessions SET session_title = ? WHERE id = ?`).run(t.slice(0, 60), id);
  }

  // HAIL-173: the MCP client name from the shim's latest session.hello.
  setSessionClientName(id: string, clientName: string): void {
    this.db.query(`UPDATE sessions SET client_name = ? WHERE id = ?`).run(clientName, id);
  }

  // HAIL-76: what session.nudge needs to decide: the case title, the task's most
  // recent session and the case's latest reply. Null when the case does not exist.
  nudgeTarget(caseId: string): NudgeTarget | null {
    const c = this.db
      .query(`SELECT title, task_id FROM cases WHERE id = ?`)
      .get(caseId) as { title: string; task_id: string } | undefined;
    if (!c) return null;
    const session = this.db
      .query(
        `SELECT id, state, can_nudge FROM sessions WHERE ${SESSION_OF_TASK} ORDER BY connected_at DESC LIMIT 1`,
      )
      .get(c.task_id) as { id: string; state: SessionState; can_nudge: number } | undefined;
    const reply = this.db
      .query(
        `SELECT id, state, nudge_count FROM replies WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(caseId) as { id: string; state: ReplyStatus; nudge_count: number } | undefined;
    return {
      title: c.title,
      session: session
        ? { id: session.id, state: session.state, can_nudge: session.can_nudge === 1 }
        : null,
      reply: reply ? { id: reply.id, state: reply.state, nudge_count: reply.nudge_count } : null,
    };
  }

  // Counts one nudge for a reply. The daemon reserves before it pushes; the rate
  // limit (one per case per minute) is the daemon's, not the store's.
  reserveNudge(replyId: string): void {
    this.db.query(`UPDATE replies SET nudge_count = nudge_count + 1 WHERE id = ?`).run(replyId);
  }

  // Gives a reserved nudge back after a failed push.
  releaseNudge(replyId: string): void {
    this.db
      .query(`UPDATE replies SET nudge_count = MAX(nudge_count - 1, 0) WHERE id = ?`)
      .run(replyId);
  }

  // HAIL-178: ends every live or disconnected session whose recorded client pid is gone. A shim
  // that outlives its client keeps heartbeating, so a closed connection is not the only sign of
  // death. Pids 0 and 1 (a shim that started already orphaned) cannot be checked and are left.
  // Returns the ids it ended.
  endDeadSessions(isAlive: (pid: number) => boolean): string[] {
    const rows = this.db
      .query(`SELECT id, pid FROM sessions WHERE state IN ('live', 'disconnected')`)
      .all() as { id: string; pid: number | null }[];
    const ended: string[] = [];
    for (const row of rows) {
      if (row.pid === null || row.pid <= 1 || isAlive(row.pid)) continue;
      this.setSessionState(row.id, "ended");
      ended.push(row.id);
    }
    return ended;
  }

  // HAIL-192: the client pid a session records is the one its shim had at the first hello. A
  // client that restarts under the same session id (resume, or a harness that respawns Claude
  // Code) starts a new shim with a new parent, so a hello from a living parent replaces it.
  setSessionPid(id: string, pid: number): void {
    this.db.query(`UPDATE sessions SET pid = ? WHERE id = ?`).run(pid, id);
  }

  // WAG-268: may this session pick up a case that another, earlier session of the same coding task
  // made? A shim restart or a resumed Claude Code session says hello with a new session id, so the
  // case sits in the old session's task. Yes when the case is still open, every session that owns its
  // task is gone (not live), and the caller works in the same folder, branch and runtime.
  sessionMayResume(sessionId: string, caseId: string, maxIdleMs?: number): boolean {
    const row = this.db
      .query(`SELECT task_id, status, done_at, dismissed_at, withdrawn_at FROM cases WHERE id = ?`)
      .get(caseId) as
      | { task_id: string; status: string; done_at: string | null; dismissed_at: string | null; withdrawn_at: string | null }
      | undefined;
    if (!row || row.status === "resolved" || row.done_at || row.dismissed_at || row.withdrawn_at) return false;
    const me = this.db.query(`SELECT cwd, branch, runtime FROM sessions WHERE id = ?`).get(sessionId) as
      | { cwd: string; branch: string | null; runtime: string }
      | undefined;
    if (!me) return false;
    const owners = this.db
      .query(`SELECT state, cwd, branch, runtime, last_seen_at, connected_at FROM sessions WHERE ${SESSION_OF_TASK}`)
      .all(row.task_id) as {
      state: SessionState;
      cwd: string;
      branch: string | null;
      runtime: string;
      last_seen_at: string | null;
      connected_at: string;
    }[];
    if (owners.length === 0) return false;
    const now = Date.now();
    return owners.every(
      (o) =>
        o.state !== "live" &&
        o.cwd === me.cwd &&
        o.branch === me.branch &&
        o.runtime === me.runtime &&
        (maxIdleMs === undefined || now - Date.parse(o.last_seen_at ?? o.connected_at) <= maxIdleMs),
    );
  }

  // WAG-268: the session took over a case from an earlier session. A reply that failed only because that
  // session ended goes back in the queue, so the next waggle_check delivers it.
  adoptCase(caseId: string): void {
    const events: Event[] = [];
    this.db.transaction(() => {
      const rows = this.db
        .query(`SELECT id FROM replies WHERE case_id = ? AND state = 'failed' AND reason = 'session_unreachable'`)
        .all(caseId) as { id: string }[];
      for (const row of rows) {
        this.db.query(`UPDATE replies SET state = 'queued', reason = NULL WHERE id = ?`).run(row.id);
        events.push(this.appendEvent("reply.state_changed", { reply_id: row.id, case_id: caseId }));
      }
    })();
    for (const event of events) this.bus?.emit(event);
  }

  // WAG-268: an open ask of this session (or of an earlier session it may resume) with the same title and
  // need. A repeated waggle_ask after a restart finds it and reattaches instead of making a second case.
  // Open: not resolved, closed, dismissed or withdrawn, and no reply picked up yet.
  findOpenAsk(sessionId: string, taskId: string, title: string, need: string, mayResume = true): string | null {
    const rows = this.db
      .query(
        `SELECT c.id FROM cases c
         WHERE c.title = ?1 AND c.need = ?2 AND c.status <> 'resolved'
           AND c.done_at IS NULL AND c.dismissed_at IS NULL AND c.withdrawn_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.case_id = c.id AND r.state = 'delivered')
         ORDER BY c.created_at DESC`,
      )
      .all(title, need) as { id: string }[];
    for (const row of rows) {
      if (this.caseTaskId(row.id) === taskId) return row.id;
      if (mayResume && this.sessionMayResume(sessionId, row.id, RESUME_ASK_WINDOW_MS)) return row.id;
    }
    return null;
  }

  // WAG-268: the open cases of the session's own tasks, for the reminder after a compaction.
  openCaseIds(sessionId: string): string[] {
    const taskIds = [this.sessionTaskId(sessionId), ...this.topicTaskIds(sessionId)].filter((t): t is string => !!t);
    const ids: string[] = [];
    for (const taskId of taskIds) {
      const rows = this.db
        .query(
          `SELECT id FROM cases WHERE task_id = ? AND status <> 'resolved' AND done_at IS NULL
             AND dismissed_at IS NULL AND withdrawn_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.case_id = cases.id AND r.state = 'delivered')
           ORDER BY created_at`,
        )
        .all(taskId) as { id: string }[];
      ids.push(...rows.map((r) => r.id));
    }
    return ids;
  }

  // WAG-268: tells the app to read a session's state again (the end of the reconnect grace).
  emitSessionStateChanged(sessionId: string): void {
    this.bus?.emit(this.appendEvent("session.state_changed", { session_id: sessionId }));
  }

  // HAIL-192: a session that is not live but whose client pid is still alive (or cannot be
  // judged: pid 0 or 1) is live again. Called when its shim shows life: a hello, a heartbeat,
  // a case.create / case.wait / case.update. A session whose client pid is gone stays as it is
  // (HAIL-178). Returns true when the session is live after the call.
  reviveSessionIfAlive(id: string, isAlive: (pid: number) => boolean): boolean {
    const row = this.db.query(`SELECT state, pid FROM sessions WHERE id = ?`).get(id) as
      | { state: SessionState; pid: number | null }
      | undefined;
    if (!row) return false;
    if (row.state === "live") return true;
    if (row.pid !== null && row.pid > 1 && !isAlive(row.pid)) return false;
    this.setSessionState(id, "live");
    return true;
  }

  // HAIL-192: the owning session of a case. Same pick as owningSessionState.
  owningSessionId(caseId: string): string | null {
    const row = this.db
      .query(
        `SELECT s.id FROM sessions s JOIN cases c ON c.id = ?
         WHERE s.task_id = c.task_id OR s.id = (SELECT owner_session_id FROM tasks WHERE id = c.task_id)
         ORDER BY s.connected_at DESC LIMIT 1`,
      )
      .get(caseId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  sessionPid(id: string): number | null {
    const row = this.db
      .query(`SELECT pid FROM sessions WHERE id = ?`)
      .get(id) as { pid: number } | undefined;
    return row?.pid ?? null;
  }

  // The task a case belongs to, or null when the case does not exist.
  caseTaskId(caseId: string): string | null {
    const row = this.db
      .query(`SELECT task_id FROM cases WHERE id = ?`)
      .get(caseId) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  // --- messages and case updates ---

  // waggle_update: adds an agent message, ingests a new revision when one is
  // given, and returns the case to needs_you (done: true closes it instead, HAIL-152). Returns null for an unknown case.
  updateCase(
    caseId: string,
    rawInput: KnockUpdateInput,
    session?: { id: string; cwd: string },
  ): (Case & { words_warning: string | null }) | null {
    if (!this.caseExists(caseId)) return null;
    // WAG-354: a marker that names no cited source is removed. A round with new items cites only its own
    // sources; a message-only update may also cite the sources the case already holds.
    const markers: MarkerReport = { count: 0, unknown: [], cited: [] };
    const cited = new Set((rawInput.sources ?? []).map((s) => s.id));
    const latestSources = this.latestSources(caseId);
    const known = new Set(cited);
    if (rawInput.items === undefined && rawInput.options === undefined) for (const s of latestSources) known.add(s.id);
    const input = mapMarkedText(rawInput, (text) => dropUnknownMarkers(text, known, markers));
    // Three blocks (WAG-313): a Round carries any of an answer, a revised artifact, new items, a stage
    // label and done. A stage label is allowed on any case: it starts the track or relabels the round.
    const round = normalizeUpdate(input);
    const previousStage = this.latestPlanStage(caseId);
    const now = new Date().toISOString();
    // HAIL-140: an update that proposes new items is checked like an ask.
    const wordsWarningText = joinWarnings(
      this.getAskWords() === "asd" && round.items !== undefined
        ? this.askWordsWarning(undefined, undefined, round.items, round.items.length === 1 ? (round.items[0]!.recommendation_why ?? "") : "")
        : null,
      // WAG-249: the first line of an items round message is the round's question.
      round.items !== undefined ? titleLengthWarning(input.message) : null,
      markerWarning(markers),
      uncitedWarning((rawInput.sources ?? []).map((s) => s.id), markers),
      noGroupWarning(round.items),
      instructionReplyWarning(round.items),
    );
    const sources = input.sources !== undefined ? this.checkedSources(input.sources, session, now) : null;
    const events: Event[] = [];
    // Several artifacts are several revisions, in the order the agent gave them (as on an ask).
    const artifacts = input.artifacts ?? (input.artifact !== undefined ? [input.artifact] : []);
    const staged: StagedArtifact[] = [];
    const first = artifacts.length > 0 ? this.nextRevisionNumber(caseId) : 0;
    try {
      artifacts.forEach((artifact, i) => staged.push(this.ingest(caseId, artifact, first + i)));
    } catch (err) {
      this.removeStagedBundles(staged);
      throw err;
    }
    try {
      this.db.transaction(() => {
        this.db
          .query(
            `INSERT INTO messages (id, case_id, role, text, created_at, working)
             VALUES (?, ?, 'agent', ?, ?, ?)`,
          )
          .run(newId("m"), caseId, input.message, now, input.working === true ? 1 : 0);
        staged.forEach((artifact, i) => {
          events.push(this.insertRevisionRow(caseId, artifact, first + i, artifacts[i]?.name).event);
        });
        if (round.items !== undefined) {
          const seq =
            (
              this.db
                .query(`SELECT MAX(seq) AS seq FROM option_sets WHERE case_id = ?`)
                .get(caseId) as { seq: number }
            ).seq + 1;
          // An old row 0 keeps its items: once the case holds a later round, row 0 must not depend on
          // the case-level questions any more.
          this.backfillFirstRoundItems(caseId);
          const caseKind = (this.db.query(`SELECT kind FROM cases WHERE id = ?`).get(caseId) as { kind: "question" | "review" }).kind;
          const legacy = projectLegacy({ kind: caseKind, items: round.items, legacy: undefined });
          const optionsJson = JSON.stringify(legacy.options);
          const recommendationsJson = JSON.stringify(legacy.recommendations);
          const stage = round.stage ?? previousStage;
          this.db
            .query(
              `INSERT INTO option_sets (case_id, seq, options_json, recommendation, recommendation_why, created_at,
                 select_mode, max_choices, recommendations_json, stage_json, question, revision, own_artifact, items_json, sources_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT MAX(n) FROM revisions WHERE case_id = ?), ?, ?, ?)`,
            )
            .run(
              caseId,
              seq,
              optionsJson,
              legacy.recommendation,
              legacy.recommendation_why,
              now,
              legacy.select,
              legacy.max,
              recommendationsJson,
              // New items on a case with a stage are a new round: with no stage it stays at the same stage.
              stage !== null && stage !== undefined ? JSON.stringify(stage) : null,
              input.message,
              caseId,
              staged.length > 0 ? 1 : 0,
              JSON.stringify(round.items),
              sources !== null ? JSON.stringify(sources) : null,
            );
          this.db
            .query(
              `UPDATE cases SET options_json = ?, recommendation = ?, recommendation_why = ?,
                 select_mode = ?, max_choices = ?, recommendations_json = ? WHERE id = ?`,
            )
            .run(optionsJson, legacy.recommendation, legacy.recommendation_why, legacy.select, legacy.max, recommendationsJson, caseId);
        } else {
          if (round.stage !== undefined) {
            // A stage alone relabels the current round.
            this.db
              .query(
                `UPDATE option_sets SET stage_json = ? WHERE case_id = ? AND seq = (SELECT MAX(seq) FROM option_sets WHERE case_id = ?)`,
              )
              .run(JSON.stringify(round.stage), caseId, caseId);
          }
          if (sources !== null) {
            // A message-only update adds its sources to the newest round: a new id is added, a known id is replaced.
            const merged = [...latestSources.filter((old) => !sources.some((s) => s.id === old.id)), ...sources].slice(-SOURCES_MAX);
            this.db
              .query(`UPDATE option_sets SET sources_json = ? WHERE case_id = ? AND seq = (SELECT MAX(seq) FROM option_sets WHERE case_id = ?)`)
              .run(JSON.stringify(merged), caseId, caseId);
          }
        }
        if (input.done) {
          // HAIL-152: a closing note. The case waits for the human's Got it, never returns to
          // needs_you. A case the human already dismissed stays resolved.
          this.db
            .query(
              `UPDATE cases SET done_at = ?, updated_at = ?,
                 status = CASE WHEN status = 'resolved' THEN status ELSE 'waiting_on_agent' END WHERE id = ?`,
            )
            .run(now, now, caseId);
        } else if (input.working === true) {
          // WAG-377: a progress note. The case stays with the agent, so no needs_you alert goes out. A
          // case the human already dismissed stays resolved.
          this.db
            .query(
              `UPDATE cases SET done_at = NULL, updated_at = ?,
                 status = CASE WHEN status = 'resolved' THEN status ELSE 'waiting_on_agent' END WHERE id = ?`,
            )
            .run(now, caseId);
        } else {
          this.db
            .query(`UPDATE cases SET status = 'needs_you', done_at = NULL, updated_at = ? WHERE id = ?`)
            .run(now, caseId);
        }
        events.push(this.appendEvent("case.updated", { case_id: caseId }));
      })();
    } catch (err) {
      this.removeStagedBundles(staged);
      throw err;
    }
    for (const event of events) this.bus?.emit(event);
    staged.forEach((_, i) => this.usage?.record({ event: "revision_added", n: first + i }));
    // WAG-366: one row per round the agent sends, with its stage label when it has one.
    if (this.usage) {
      const stage = round.stage ?? previousStage;
      this.usage.record({
        event: "round_added",
        ask_h: this.usage.askHash(caseId),
        ...(stage ? { stage: stage.name } : {}),
        ...(round.items !== undefined ? { n: round.items.length } : {}),
      });
    }
    const updated = this.caseById(caseId);
    return updated ? { ...updated, words_warning: wordsWarningText } : null;
  }

  // The sources of the newest round of a case, or an empty list.
  private latestSources(caseId: string): Source[] {
    const row = this.db
      .query(`SELECT sources_json FROM option_sets WHERE case_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(caseId) as { sources_json: string | null } | null;
    return row?.sources_json ? parseSources(row.sources_json) : [];
  }

  // Stores the items of round 0 when the row is an old one (items_json NULL), read from the case's
  // questions or options. Runs before a later round is written. Nothing else of the row changes.
  private backfillFirstRoundItems(caseId: string): void {
    const row = this.db
      .query(
        `SELECT o.seq, o.items_json, o.options_json, o.recommendation, o.recommendation_why, o.select_mode, o.max_choices,
                o.recommendations_json, c.questions_json
         FROM option_sets o JOIN cases c ON c.id = o.case_id WHERE o.case_id = ? AND o.seq = 0`,
      )
      .get(caseId) as (OptionSetItemsRow & { questions_json: string | null }) | undefined;
    if (!row || row.items_json !== null) return;
    this.db
      .query(`UPDATE option_sets SET items_json = ? WHERE case_id = ? AND seq = 0`)
      .run(JSON.stringify(itemsOfRound(row, row)), caseId);
  }

  // case.dismiss (HAIL-32): sets a case to resolved with a dismissed_at,
  // remembering the status it held so case.restore can put it back exactly
  // there. Idempotent - a case that is already dismissed is returned
  // unchanged, with no further write and no further event. Returns null for
  // an unknown case.
  dismissCase(caseId: string): Case | null {
    const row = this.db
      .query(`SELECT status, dismissed_at FROM cases WHERE id = ?`)
      .get(caseId) as { status: CaseStatus; dismissed_at: string | null } | undefined;
    if (!row) return null;
    if (row.dismissed_at !== null) return this.caseById(caseId);
    const now = new Date().toISOString();
    const events: Event[] = [];
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE cases SET status = 'resolved', dismissed_at = ?, status_before_dismiss = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, row.status, now, caseId);
      events.push(this.appendEvent("case.updated", { case_id: caseId }));
      // HAIL-130: dismissing a replacement also closes the case it replaced, if
      // that one is still open, so it never lingers in "Waiting on agent".
      const replaced = this.db
        .query(
          `SELECT r.id FROM cases c JOIN cases r ON r.id = c.replaces_case_id
           WHERE c.id = ? AND r.status != 'resolved'`,
        )
        .get(caseId) as { id: string } | undefined;
      if (replaced) {
        this.db
          .query(`UPDATE cases SET status = 'resolved', withdrawn_at = ?, updated_at = ? WHERE id = ?`)
          .run(now, now, replaced.id);
        events.push(this.appendEvent("case.updated", { case_id: replaced.id }));
      }
    })();
    for (const event of events) this.bus?.emit(event);
    this.usage?.record({ event: "ask_dismissed", ask_h: this.usage.askHash(caseId) });
    return this.caseById(caseId);
  }

  // case.restore (HAIL-32): the Undo half of case.dismiss. A case that was
  // never dismissed (or already restored) is returned unchanged. Returns null
  // for an unknown case.
  restoreCase(caseId: string): Case | null {
    const row = this.db
      .query(`SELECT dismissed_at, status_before_dismiss FROM cases WHERE id = ?`)
      .get(caseId) as
      | { dismissed_at: string | null; status_before_dismiss: CaseStatus | null }
      | undefined;
    if (!row) return null;
    if (row.dismissed_at === null) return this.caseById(caseId);
    const now = new Date().toISOString();
    const restoredStatus = row.status_before_dismiss ?? "needs_you";
    let event: Event;
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE cases SET status = ?, dismissed_at = NULL, status_before_dismiss = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(restoredStatus, now, caseId);
      event = this.appendEvent("case.updated", { case_id: caseId });
    })();
    this.bus?.emit(event!);
    this.usage?.record({ event: "ask_restored", ask_h: this.usage.askHash(caseId) });
    return this.caseById(caseId);
  }

  // Whether a case is currently dismissed. server.ts's case.wait uses this to
  // settle a live wait with the dismissal message instead of the daemon's own
  // pending timeout (HAIL-32).
  isDismissed(caseId: string): boolean {
    const row = this.db
      .query(`SELECT dismissed_at FROM cases WHERE id = ?`)
      .get(caseId) as { dismissed_at: string | null } | undefined;
    return row?.dismissed_at != null;
  }

  // Whether a case was closed by a done update (HAIL-152). case.wait settles with a closed
  // message and the nudge refuses: no answer will come and nothing waits for a pick-up.
  isDone(caseId: string): boolean {
    const row = this.db.query(`SELECT done_at FROM cases WHERE id = ?`).get(caseId) as
      | { done_at: string | null }
      | undefined;
    return row?.done_at != null;
  }

  // --- purge (HAIL-52) ---

  // cases.resolved_stats: the count and on-disk byte size of every resolved
  // case, for the Data & privacy page's "Answered asks" row. A gross figure
  // from the resolved set's own artifacts (bundle directories walked, blob
  // files stat'd, captures' inline base64 columns measured by length) - it
  // does not discount a blob a surviving case happens to share (blobs are
  // content-addressed; two different revisions producing byte-identical
  // content is rare), so it can slightly overstate what purgeResolvedCases
  // would actually free.
  resolvedCaseStats(): { count: number; bytes: number } {
    const ids = this.resolvedCaseIds();
    return { count: ids.length, bytes: ids.length === 0 ? 0 : this.caseSetBytes(ids) };
  }

  // cases.purge_resolved: deletes every finished case (see resolvedCaseIds;
  // never one that needs the human or is waiting on the agent) along with its messages, replies, comments,
  // captures and revisions, then its staged bundle directories and any blob
  // no surviving case's revision still references. The append-only events
  // log (docs/protocol-mvp.md "Events") is left untouched - purging is about
  // cases and their artifacts, not the log. Idempotent: purging with nothing
  // resolved is a no-op that returns zeros.
  purgeResolvedCases(): { purged_cases: number; freed_bytes: number } {
    const ids = this.resolvedCaseIds();
    if (ids.length === 0) return { purged_cases: 0, freed_bytes: 0 };

    const bundleDirs = ids.flatMap((id) => this.caseBundleDirs(id));
    const candidateBlobPaths = this.caseBlobPaths(ids);
    const placeholders = ids.map(() => "?").join(",");

    let freedBytes = 0;
    for (const dir of bundleDirs) freedBytes += dirSizeSync(dir);
    const captureRows = this.db
      .query(`SELECT png_base64, annotated_png_base64 FROM captures WHERE case_id IN (${placeholders})`)
      .all(...ids) as { png_base64: string; annotated_png_base64: string }[];
    for (const row of captureRows) freedBytes += row.png_base64.length + row.annotated_png_base64.length;

    const replyIds = (
      this.db.query(`SELECT id FROM replies WHERE case_id IN (${placeholders})`).all(...ids) as { id: string }[]
    ).map((r) => r.id);
    this.db.transaction(() => {
      // A shared case that goes away leaves its page live. Remember the relay case first, so the
      // daemon takes the page down (and keeps trying until it has).
      this.db
        .query(
          `INSERT OR IGNORE INTO relay_pending_stops (relay_id, created_at) SELECT relay_id, ? FROM relay_shares
           WHERE case_id IN (${placeholders}) AND relay_id NOT IN (SELECT relay_id FROM relay_shares WHERE case_id NOT IN (${placeholders}))`,
        )
        .run(new Date().toISOString(), ...ids, ...ids);
      // A surviving case can still name a purged one as follows_case_id /
      // replaces_case_id (a follow-up ask on an already-resolved case, or a
      // later ask that replaced one); null those out first so the FK on
      // cases(id) never blocks the DELETE below.
      this.db
        .query(
          `UPDATE cases SET follows_case_id = NULL
           WHERE follows_case_id IN (${placeholders}) AND id NOT IN (${placeholders})`,
        )
        .run(...ids, ...ids);
      this.db
        .query(
          `UPDATE cases SET replaces_case_id = NULL
           WHERE replaces_case_id IN (${placeholders}) AND id NOT IN (${placeholders})`,
        )
        .run(...ids, ...ids);
      this.db.query(`DELETE FROM comments WHERE case_id IN (${placeholders})`).run(...ids);
      this.db.query(`DELETE FROM captures WHERE case_id IN (${placeholders})`).run(...ids);
      this.db
        .query(`DELETE FROM reply_option_sets WHERE reply_id IN (SELECT id FROM replies WHERE case_id IN (${placeholders}))`)
        .run(...ids);
      this.db.query(`DELETE FROM replies WHERE case_id IN (${placeholders})`).run(...ids);
      this.db.query(`DELETE FROM messages WHERE case_id IN (${placeholders})`).run(...ids);
      this.db.query(`DELETE FROM option_sets WHERE case_id IN (${placeholders})`).run(...ids);
      this.db.query(`DELETE FROM revisions WHERE case_id IN (${placeholders})`).run(...ids);
      this.db.query(`DELETE FROM cases WHERE id IN (${placeholders})`).run(...ids);
    })();

    for (const replyId of replyIds) removeReplyAttachments(this.dataRoot, replyId);
    // ingestBundle makes every staged bundle read-only (chmod a-w); restore
    // the write bit, deepest first, before removing it - rmSync alone fails
    // with EACCES on a read-only directory.
    for (const dir of bundleDirs) {
      makeWritable(dir);
      rmSync(dir, { recursive: true, force: true });
    }
    if (candidateBlobPaths.size > 0) {
      const stillReferenced = this.referencedBlobPaths();
      for (const path of candidateBlobPaths) {
        if (stillReferenced.has(path)) continue;
        freedBytes += fileSizeSync(path);
        rmSync(path, { force: true });
      }
    }

    return { purged_cases: ids.length, freed_bytes: freedBytes };
  }

  // HAIL-236: every finished case, the set both the stats and the purge use. Finished means
  // nothing is left for the person or the agent: resolved (dismissed, replaced or closed with
  // Got it), or answered with the latest reply delivered. Never needs_you, a queued or failed
  // reply, or a done case still waiting for Got it.
  private resolvedCaseIds(): string[] {
    return (
      this.db
        .query(
          `SELECT c.id FROM cases c
           WHERE c.status = 'resolved'
              OR (c.status = 'waiting_on_agent' AND c.done_at IS NULL
                  AND (SELECT r.state FROM replies r WHERE r.case_id = c.id
                       ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) = 'delivered'
                  -- Keep an answered ask while its agent is still live or reconnecting: the agent may
                  -- still send waggle_update rounds on it (plan asks).
                  AND NOT EXISTS (SELECT 1 FROM sessions s
                                  WHERE s.task_id = c.task_id AND s.state IN ('live', 'disconnected')))`,
        )
        .all() as { id: string }[]
    ).map((row) => row.id);
  }

  private caseBundleDirs(caseId: string): string[] {
    const rows = this.db
      .query(`SELECT n FROM revisions WHERE case_id = ? AND kind = 'html_bundle'`)
      .all(caseId) as { n: number }[];
    return rows.map((row) => join(this.dataRoot, "bundles", caseId, `r${row.n}`));
  }

  // Every blob path the given cases' revisions reference (screenshot/markdown
  // files, and each item of a screenshots artifact) - candidates for removal,
  // not yet checked against what a surviving case might still share.
  private caseBlobPaths(caseIds: string[]): Set<string> {
    const placeholders = caseIds.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT kind, sha256, ext, items_json FROM revisions WHERE case_id IN (${placeholders})`)
      .all(...caseIds) as RevisionBlobRow[];
    return blobPathsFromRows(rows, this.dataRoot);
  }

  // Every blob path any revision left in the database still references -
  // purgeResolvedCases must never remove a candidate that is also in this
  // set, since blobs/ is content-addressed and shared across cases. Called
  // after the purge's own DELETE, so a purged case's own revisions are
  // already gone from this query.
  private referencedBlobPaths(): Set<string> {
    const rows = this.db
      .query(
        `SELECT kind, sha256, ext, items_json FROM revisions
         WHERE kind IN ('screenshot', 'markdown', 'screenshots')`,
      )
      .all() as RevisionBlobRow[];
    return blobPathsFromRows(rows, this.dataRoot);
  }

  // The gross on-disk byte total for a set of cases (resolvedCaseStats):
  // staged bundle directories (walked), unique blob files (stat'd once each,
  // even if two cases in the set share one), and captures' inline
  // png_base64/annotated_png_base64 columns (their stored length is the disk
  // cost - a capture has no separate blob file).
  private caseSetBytes(caseIds: string[]): number {
    let bytes = 0;
    for (const id of caseIds) {
      for (const dir of this.caseBundleDirs(id)) bytes += dirSizeSync(dir);
    }
    for (const path of this.caseBlobPaths(caseIds)) bytes += fileSizeSync(path);
    const placeholders = caseIds.map(() => "?").join(",");
    const captureRows = this.db
      .query(`SELECT png_base64, annotated_png_base64 FROM captures WHERE case_id IN (${placeholders})`)
      .all(...caseIds) as { png_base64: string; annotated_png_base64: string }[];
    for (const row of captureRows) bytes += row.png_base64.length + row.annotated_png_base64.length;
    return bytes;
  }

  // --- replies ---

  // The storage half of reply.submit: stores a queued reply with its captures
  // and comments and moves the case to waiting_on_agent. KNOCK-04 added it so
  // tests can seed a reply without the RPC. It does no idempotency check and no
  // session check; reply.submit is the idempotent, session-aware entry point.
  createReply(caseId: string, input: CreateReplyInput): Reply {
    return this.insertReply(caseId, input, false);
  }

  // reply.submit: stores the reply, moves the case to waiting_on_agent and
  // returns a queued reply. The same idempotency_key always returns the same
  // reply (never a second one), and a reply submitted while its owning session
  // is already ended is failed with session_unreachable in the same write.
  submitReply(caseId: string, input: CreateReplyInput): Reply {
    const existing = this.findReplyByIdempotencyKey(input.idempotency_key);
    if (existing) {
      // A retry brings its files again: the first send already copied them.
      this.dropStagedAttachments(input.attachments);
      return existing;
    }
    if (!this.caseExists(caseId)) throw new Error(`case not found: ${caseId}`);
    return this.insertReply(caseId, input, true);
  }

  // reply.retry: requeues a failed reply under its original id. A reply that is
  // not failed is returned unchanged. When the owning session is still ended the
  // reply fails again with the same reason; it never becomes delivered here.
  retryReply(replyId: string): Reply | null {
    const row = this.db
      .query(`SELECT * FROM replies WHERE id = ?`)
      .get(replyId) as ReplyRow | undefined;
    if (!row) return null;
    if (row.state !== "failed") return rowToReply(this.db, row);
    // HAIL-192: while the owning session is still ended, a retry cannot work. Return the reply
    // as it is: no state change, no event (a retry used to flip failed, queued, failed each press).
    if (this.owningSessionState(row.case_id) === "ended") return rowToReply(this.db, row);
    const events: Event[] = [];
    this.db.transaction(() => {
      this.db
        .query(`UPDATE replies SET state = 'queued', reason = NULL WHERE id = ?`)
        .run(replyId);
      events.push(
        this.appendEvent("reply.state_changed", { reply_id: replyId, case_id: row.case_id }),
      );
    })();
    for (const event of events) this.bus?.emit(event);
    const reply = this.replyById(replyId)!;
    if (this.usage) {
      this.usage.record({ event: "reply_retried" });
      if (reply.state === "failed") this.usage.record({ event: "reply_failed" });
    }
    return reply;
  }

  // reply.hand_over (WAG-410): the human continued the case in a new session, so a FAILED reply is marked
  // handed_over. The new session has the answer in its prompt. A reply in any other state is returned
  // unchanged. A handed_over reply is never retried and never requeued (HAIL-192 reads failed only).
  handOverReply(replyId: string): Reply | null {
    const row = this.db
      .query(`SELECT * FROM replies WHERE id = ?`)
      .get(replyId) as ReplyRow | undefined;
    if (!row) return null;
    if (row.state !== "failed") return rowToReply(this.db, row);
    const events: Event[] = [];
    this.db.transaction(() => {
      this.db
        .query(`UPDATE replies SET state = 'handed_over', reason = NULL WHERE id = ?`)
        .run(replyId);
      events.push(
        this.appendEvent("reply.state_changed", { reply_id: replyId, case_id: row.case_id }),
      );
    })();
    for (const event of events) this.bus?.emit(event);
    return this.replyById(replyId);
  }

  // The reply with this idempotency key, or null when none exists.
  findReplyByIdempotencyKey(key: string): Reply | null {
    const row = this.db
      .query(`SELECT * FROM replies WHERE idempotency_key = ?`)
      .get(key) as ReplyRow | undefined;
    return row ? rowToReply(this.db, row) : null;
  }

  // Removes the incoming copies of attachments that no reply took (a repeated send, a rejected send).
  private dropStagedAttachments(inputs: ReplyAttachmentInput[] | undefined): void {
    const dirs: string[] = [];
    for (const item of inputs ?? []) {
      if (item.incoming_path === undefined || !isAbsolute(item.incoming_path)) continue;
      dirs.push(dirname(item.incoming_path));
    }
    removeIncomingDirs(dirs, this.dataRoot);
  }

  // The shared insert behind createReply and submitReply. When `checkSession`
  // is true a reply whose owning session is already ended is failed in the same
  // write, so the returned reply shows that failure.
  private insertReply(caseId: string, input: CreateReplyInput, checkSession: boolean): Reply {
    let replyId: string;
    const events: Event[] = [];
    let incomingDirs: string[] = [];
    this.db.transaction(() => {
      const ended = checkSession && this.owningSessionState(caseId) === "ended";
      const inserted = this.insertQueuedReplyInTx(caseId, input, ended ? "session_unreachable" : undefined);
      replyId = inserted.replyId;
      events.push(...inserted.events);
      incomingDirs = inserted.incomingDirs;
    })();
    removeIncomingDirs(incomingDirs, this.dataRoot);
    for (const event of events) this.bus?.emit(event);
    const reply = this.replyById(replyId!)!;
    if (this.usage) {
      this.recordReplySubmitted(caseId, reply.id, input.comments.length);
      if (reply.state === "failed") this.usage.record({ event: "reply_failed" });
    }
    return reply;
  }

  // Records reply_submitted outside the reply transaction. duration_s is the
  // ask's created_at to the reply's created_at; outcome compares the reply's
  // choice with the case's recommendation; n is the comment count.
  private recordReplySubmitted(caseId: string, replyId: string, commentCount: number): void {
    if (!this.usage) return;
    const caseRow = this.db
      .query(`SELECT recommendation, recommendations_json, created_at FROM cases WHERE id = ?`)
      .get(caseId) as
      | { recommendation: string; recommendations_json: string | null; created_at: string }
      | undefined;
    const replyRow = this.db
      .query(`SELECT choice, choices_json, message, created_at, intent, format, source FROM replies WHERE id = ?`)
      .get(replyId) as
      | {
          choice: string | null;
          choices_json: string | null;
          message: string | null;
          created_at: string;
          intent: string | null;
          format: string | null;
          source: string | null;
        }
      | undefined;
    if (!caseRow || !replyRow) return;
    const duration = Math.max(
      0,
      Math.floor((Date.parse(replyRow.created_at) - Date.parse(caseRow.created_at)) / 1000),
    );
    const outcome = replyOutcome({
      choice: replyRow.choice ?? undefined,
      ...(replyRow.choices_json !== null ? { choices: JSON.parse(replyRow.choices_json) as string[] } : {}),
      message: replyRow.message ?? undefined,
      recommendation: caseRow.recommendation,
      ...(caseRow.recommendations_json !== null
        ? { recommendations: JSON.parse(caseRow.recommendations_json) as string[] }
        : {}),
    });
    // HAIL-83: the kind of the ask's latest artifact, so the report can tell
    // an answer to an ask with a preview from one without.
    const artifact = this.db
      .query(`SELECT kind FROM revisions WHERE case_id = ? ORDER BY n DESC LIMIT 1`)
      .get(caseId) as { kind: string } | undefined;
    this.usage.record({
      event: "reply_submitted",
      duration_s: duration,
      outcome,
      n: commentCount,
      ...(artifact ? { artifact_kind: artifact.kind } : {}),
      // WAG-366: what the reply was, where it came from, and how long its note was (a bucket, no text).
      ask_h: this.usage.askHash(caseId),
      intent: replyRow.intent ?? "decision",
      source: replyRow.source ?? "mac",
      note: noteBucket(replyRow.message),
      ...(replyRow.intent === "more_detail" ? { format: replyRow.format ?? "none" } : {}),
    });
  }

  // Inserts one queued reply with its captures and comments, moves the case to
  // waiting_on_agent, and appends the reply.state_changed and case.updated
  // events. Runs inside the caller's transaction.
  // WAG-258: with `failReason` the reply is born failed, so one reply.state_changed event is written, not
  // a queued one and then a failed one.
  private insertQueuedReplyInTx(
    caseId: string,
    rawInput: CreateReplyInput,
    failReason?: string,
  ): { replyId: string; events: Event[]; incomingDirs: string[] } {
    const input = this.withItemAnswers(caseId, this.settleConfirmation(caseId, rawInput));
    const id = newId("reply");
    const now = new Date().toISOString();
    const events: Event[] = [];
    this.db
      .query(
        `INSERT INTO replies (id, case_id, idempotency_key, choice, choices_json, message, intent, format, source, state, reason, created_at, edit_revision, answers_json, leaning_json, ruled_out_json, item_answers_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        caseId,
        input.idempotency_key,
        input.choice ?? null,
        input.choices !== undefined ? JSON.stringify(input.choices) : null,
        input.message ?? null,
        input.intent ?? "decision",
        input.format ?? null,
        input.source ?? "mac",
        failReason !== undefined ? "failed" : "queued",
        failReason ?? null,
        now,
        this.checkedEditRevision(caseId, input),
        this.checkedAnswers(caseId, input),
        ...this.discussJson(input),
        input.item_answers !== undefined && input.item_answers.length > 0 ? JSON.stringify(input.item_answers) : null,
      );
    // HAIL-151: a decision on a plan ask answers its newest round. Spec 2.8: only a reply that decides
    // does. A reply with comments and no pick keeps the round open.
    if (this.replyDecides(caseId, input)) {
      this.db
        .query(
          `UPDATE replies SET plan_round = (SELECT MAX(seq) FROM option_sets WHERE case_id = ? AND stage_json IS NOT NULL)
           WHERE id = ?`,
        )
        .run(caseId, id);
    }
    this.storeReplyOptionSet(id, this.resolveOptionSet(caseId, input));
    this.insertCapturesAndComments(caseId, id, input);
    this.storeCorrection(id);
    // The files are copied last: a rejected reply above leaves nothing in attachments/.
    let incomingDirs: string[] = [];
    if (input.attachments !== undefined && input.attachments.length > 0) {
      const ingested = ingestReplyAttachments({ inputs: input.attachments, existing: [], dataRoot: this.dataRoot, replyId: id });
      incomingDirs = ingested.incomingDirs;
      this.db.query(`UPDATE replies SET attachments_json = ? WHERE id = ?`).run(JSON.stringify(ingested.records), id);
    }
    this.db
      .query(`UPDATE cases SET status = 'waiting_on_agent', updated_at = ? WHERE id = ?`)
      .run(now, caseId);
    reindexDecidedCase(this.db, caseId);
    events.push(this.appendEvent("reply.state_changed", { reply_id: id, case_id: caseId }));
    events.push(this.appendEvent("case.updated", { case_id: caseId }));
    return { replyId: id, events, incomingDirs };
  }

  // The captures/comments half of inserting a reply's answer, shared by a
  // fresh insert (insertQueuedReplyInTx) and a replace (replaceReply). Runs
  // inside the caller's transaction.
  // WAG-358: a capture or comment whose id is already stored belongs to an earlier reply. It is not
  // stored again, so it is not sent again in this reply's text, and the insert cannot hit the key.
  private insertCapturesAndComments(caseId: string, replyId: string, input: ReplyContentInput): void {
    const stored = (table: "captures" | "comments", id: string): boolean =>
      this.db.query(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== null;
    for (const capture of input.captures) {
      if (stored("captures", capture.id)) continue;
      this.db
        .query(
          `INSERT INTO captures
            (id, case_id, revision, reply_id, png_base64, annotated_png_base64, taken_at, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          capture.id,
          caseId,
          capture.revision,
          replyId,
          capture.png_base64,
          capture.annotated_png_base64,
          capture.taken_at,
          capture.note ?? null,
        );
    }
    for (const comment of input.comments) {
      if (stored("comments", comment.id)) continue;
      this.db
        .query(
          `INSERT INTO comments (id, case_id, capture_id, reply_id, n, rect_json, anchor_json, text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          comment.id,
          caseId,
          comment.capture_id ?? null,
          replyId,
          comment.n,
          comment.rect !== undefined ? JSON.stringify(comment.rect) : null,
          comment.anchor !== undefined ? JSON.stringify(comment.anchor) : null,
          comment.text,
        );
    }
  }

  // WAG-414: sets replies.correction from the stored reply (src/corrections.ts) and, for a correction, logs the
  // coded `correction` event. Runs inside the reply's transaction, after the comments are stored. The event
  // carries the ask hash only. A replaced reply that stays a correction logs no second event.
  private storeCorrection(replyId: string): void {
    const flag = storedReplyCorrection(this.db, replyId);
    const before = this.db.query(`SELECT correction, case_id FROM replies WHERE id = ?`).get(replyId) as { correction: number | null; case_id: string };
    this.db.query(`UPDATE replies SET correction = ? WHERE id = ?`).run(flag, replyId);
    if (flag === 1 && before.correction !== 1 && this.usage) {
      this.usage.record({ event: "correction", ask_h: this.usage.askHash(before.case_id) });
    }
  }

  private storeReplyOptionSet(replyId: string, seq: number | null): void {
    this.db.query(`DELETE FROM reply_option_sets WHERE reply_id = ?`).run(replyId);
    if (seq !== null) {
      this.db.query(`INSERT INTO reply_option_sets (reply_id, seq) VALUES (?, ?)`).run(replyId, seq);
    }
  }

  private replyOptionSetSeq(replyId: string): number | null {
    const row = this.db
      .query(`SELECT seq FROM reply_option_sets WHERE reply_id = ?`)
      .get(replyId) as { seq: number } | undefined;
    return row?.seq ?? null;
  }

  // The option set a reply's choice is from (HAIL-108), validated: the newest set
  // wins, an id only the first set has falls back to the first set, and
  // options_set "first" asks for the first set outright. Null for a reply
  // without a choice, and for a case that never had options (any text goes).
  // Throws ChoiceNotOfferedError for an id neither set has.
  private resolveOptionSet(caseId: string, input: ReplyContentInput): number | null {
    if (input.intent === "more_detail") return null;
    if (input.intent === "discuss") return this.discussOptionSet(caseId, input);
    if (input.choice === undefined && input.choices === undefined) return null;
    const sets = this.db
      .query(
        `SELECT seq, options_json, select_mode, max_choices FROM option_sets WHERE case_id = ? ORDER BY seq`,
      )
      .all(caseId) as OptionSetRow[];
    if (sets.every((set) => (JSON.parse(set.options_json) as Option[]).length === 0)) return null;
    const first = sets[0];
    const newest = sets[sets.length - 1];
    if (input.choices !== undefined) return resolveChoicesSet(input, first, newest);
    const has = (set: { options_json: string }): boolean =>
      (JSON.parse(set.options_json) as Option[]).some((o) => o.id === input.choice);
    if (input.options_set === "first") {
      if (first && has(first)) return first.seq;
    } else {
      if (newest && has(newest)) return newest.seq;
      if (first && has(first)) return first.seq;
    }
    throw new ChoiceNotOfferedError(input.choice!);
  }

  // reply.replace (HAIL-34): changes a queued reply's choice/message/comments/
  // captures in place - same id, `created_at` untouched, `replaced_at` set to
  // now. The prior captures/comments are dropped first: the RPC sends the
  // full replacement set, not a delta. Throws ReplyNotQueuedError once the
  // reply is no longer queued (delivered or failed); returns null for an
  // unknown reply.
  replaceReply(replyId: string, rawInput: ReplyContentInput): Reply | null {
    const row = this.db
      .query(`SELECT * FROM replies WHERE id = ?`)
      .get(replyId) as ReplyRow | undefined;
    if (!row) return null;
    if (row.state !== "queued") throw new ReplyNotQueuedError(row.state);
    const input = this.withItemAnswers(row.case_id, this.settleConfirmation(row.case_id, { ...rawInput, intent: row.intent }));
    const now = new Date().toISOString();
    // WAG-301: "Change answer" on a queued discuss reply that now carries a choice makes it a decision.
    const intent: ReplyIntent =
      row.intent === "discuss" &&
      (input.choice !== undefined || input.choices !== undefined || input.answers !== undefined || (input.item_answers?.length ?? 0) > 0)
        ? "decision"
        : row.intent;
    let event: Event;
    let incomingDirs: string[] = [];
    const heldBefore = row.attachments_json ? (JSON.parse(row.attachments_json) as ReplyAttachmentRecord[]) : [];
    let heldAfter = heldBefore;
    this.db.transaction(() => {
      if (intent !== row.intent) {
        this.db.query(`UPDATE replies SET intent = ? WHERE id = ?`).run(intent, replyId);
        if (this.replyDecides(row.case_id, { ...input, intent })) {
          this.db
            .query(
              `UPDATE replies SET plan_round = (SELECT MAX(seq) FROM option_sets WHERE case_id = ? AND stage_json IS NOT NULL)
               WHERE id = ?`,
            )
            .run(row.case_id, replyId);
        }
      }
      this.db.query(`DELETE FROM comments WHERE reply_id = ?`).run(replyId);
      this.db.query(`DELETE FROM captures WHERE reply_id = ?`).run(replyId);
      this.db
        .query(
          `UPDATE replies SET choice = ?, choices_json = ?, message = ?, source = ?, replaced_at = ?, edit_revision = ?, answers_json = ?, leaning_json = ?, ruled_out_json = ?, item_answers_json = ? WHERE id = ?`,
        )
        .run(
          input.choice ?? null,
          input.choices !== undefined ? JSON.stringify(input.choices) : null,
          input.message ?? null,
          input.source ?? "mac",
          now,
          this.checkedEditRevision(row.case_id, input),
          this.checkedAnswers(row.case_id, input),
          ...this.discussJson({ ...input, intent }),
          input.item_answers !== undefined && input.item_answers.length > 0 ? JSON.stringify(input.item_answers) : null,
          replyId,
        );
      this.storeReplyOptionSet(replyId, this.resolveOptionSet(row.case_id, { ...input, intent }));
      this.insertCapturesAndComments(row.case_id, replyId, input);
      this.storeCorrection(replyId);
      if (input.attachments !== undefined) {
        const ingested = ingestReplyAttachments({
          inputs: input.attachments,
          existing: heldBefore,
          dataRoot: this.dataRoot,
          replyId,
        });
        incomingDirs = ingested.incomingDirs;
        heldAfter = ingested.records;
        this.db
          .query(`UPDATE replies SET attachments_json = ? WHERE id = ?`)
          .run(ingested.records.length > 0 ? JSON.stringify(ingested.records) : null, replyId);
      }
      reindexDecidedCase(this.db, row.case_id);
      event = this.appendEvent("reply.state_changed", { reply_id: replyId, case_id: row.case_id });
    })();
    removeIncomingDirs(incomingDirs, this.dataRoot);
    removeDroppedAttachments(heldBefore, heldAfter);
    this.bus?.emit(event!);
    return this.replyById(replyId);
  }

  // Marks one queued reply failed with a reason and appends its
  // reply.state_changed event. Runs inside the caller's transaction.
  private failQueuedReplyInTx(replyId: string, caseId: string, reason: string): Event {
    this.db
      .query(`UPDATE replies SET state = 'failed', reason = ? WHERE id = ?`)
      .run(reason, replyId);
    return this.appendEvent("reply.state_changed", { reply_id: replyId, case_id: caseId });
  }

  // Fails every queued reply of a task (a task owns one session). Runs inside
  // the caller's transaction and returns the appended events plus the failed
  // reply ids (so the caller can record usage outside the transaction).
  private failQueuedRepliesForTaskInTx(
    taskId: string,
    reason: string,
  ): { events: Event[]; replyIds: string[] } {
    const rows = this.db
      .query(
        `SELECT r.id, r.case_id FROM replies r
         JOIN cases c ON c.id = r.case_id
         WHERE c.task_id = ? AND r.state = 'queued'`,
      )
      .all(taskId) as { id: string; case_id: string }[];
    const events: Event[] = [];
    const replyIds: string[] = [];
    for (const row of rows) {
      events.push(this.failQueuedReplyInTx(row.id, row.case_id, reason));
      replyIds.push(row.id);
    }
    return { events, replyIds };
  }

  // Puts every failed session_unreachable reply of a task back in the queue (HAIL-192).
  private requeueFailedRepliesForTaskInTx(taskId: string): Event[] {
    const rows = this.db
      .query(
        `SELECT r.id, r.case_id FROM replies r
         JOIN cases c ON c.id = r.case_id
         WHERE c.task_id = ? AND r.state = 'failed' AND r.reason = 'session_unreachable'`,
      )
      .all(taskId) as { id: string; case_id: string }[];
    const events: Event[] = [];
    for (const row of rows) {
      this.db.query(`UPDATE replies SET state = 'queued', reason = NULL WHERE id = ?`).run(row.id);
      events.push(this.appendEvent("reply.state_changed", { reply_id: row.id, case_id: row.case_id }));
    }
    return events;
  }

  // The state of the session that owns a case, or null when the case has no
  // session row yet (a case seeded directly, without a shim).
  private owningSessionState(caseId: string): SessionState | null {
    const row = this.db
      .query(
        `SELECT s.state FROM sessions s JOIN cases c ON c.id = ?
         WHERE s.task_id = c.task_id OR s.id = (SELECT owner_session_id FROM tasks WHERE id = c.task_id)
         ORDER BY s.connected_at DESC LIMIT 1`,
      )
      .get(caseId) as { state: SessionState } | undefined;
    return row?.state ?? null;
  }

  // One reply mapped to the protocol noun, or null for an unknown id.
  getReply(replyId: string): Reply | null {
    return this.replyById(replyId);
  }

  private replyById(replyId: string): Reply | null {
    const row = this.db
      .query(`SELECT * FROM replies WHERE id = ?`)
      .get(replyId) as ReplyRow | undefined;
    return row ? rowToReply(this.db, row) : null;
  }

  // The number of queued replies across all cases. The daemon's idle exit uses
  // this so it never exits while a reply is waiting to be delivered.
  countQueuedReplies(): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM replies WHERE state = 'queued'`)
      .get() as { n: number };
    return row.n;
  }

  // The oldest queued reply of a case, or null when none is waiting.
  findQueuedReply(caseId: string): Reply | null {
    const row = this.db
      .query(
        `SELECT * FROM replies WHERE case_id = ? AND state = 'queued'
         ORDER BY created_at LIMIT 1`,
      )
      .get(caseId) as ReplyRow | undefined;
    return row ? rowToReply(this.db, row) : null;
  }

  // HAIL-192: the reply waggle_check hands to the agent that owns the case. A queued reply
  // first; else one that failed with session_unreachable, because the agent asking is alive
  // and the failure was only the daemon's view of the session.
  findDeliverableReply(caseId: string): Reply | null {
    const queued = this.findQueuedReply(caseId);
    if (queued) return queued;
    const row = this.db
      .query(
        `SELECT * FROM replies WHERE case_id = ? AND state = 'failed' AND reason = 'session_unreachable'
         ORDER BY created_at LIMIT 1`,
      )
      .get(caseId) as ReplyRow | undefined;
    return row ? rowToReply(this.db, row) : null;
  }

  // The case a reply belongs to, or null when the reply does not exist.
  replyCaseId(replyId: string): string | null {
    const row = this.db
      .query(`SELECT case_id FROM replies WHERE id = ?`)
      .get(replyId) as { case_id: string } | undefined;
    return row?.case_id ?? null;
  }

  // Builds the MCP reply payload for one reply: a text block first, then one
  // image block per capture that has comments (docs/protocol-mvp.md "Reply
  // payload"). Returns null for an unknown reply.
  buildReplyPayload(replyId: string, withImages = true): { reply_id: string; content: McpContent[] } | null {
    const row = this.db
      .query(`SELECT * FROM replies WHERE id = ?`)
      .get(replyId) as ReplyRow | undefined;
    if (!row) return null;
    const reply = rowToReply(this.db, row, withImages);
    const caseRow = this.db
      .query(`SELECT * FROM cases WHERE id = ?`)
      .get(reply.case_id) as CaseRow | undefined;
    if (!caseRow) return null;
    const content = formatReplyContent(
      caseRow,
      reply,
      optionsForReply(this.db, caseRow, this.replyOptionSetSeq(row.id)),
      this.editPayloadLines(reply),
      itemsAtSeq(this.db, caseRow.id, this.replyOptionSetSeq(row.id)),
      this.getAskAfterDecide(),
    );
    // HAIL-151: on a plan ask the next round goes through waggle_update on the same case.
    const stage = reply.intent === "decision" ? this.latestPlanStage(caseRow.id) : null;
    if (stage !== null) content.push({ type: "text", text: planReplyHint(caseRow.id, stage) });
    return { reply_id: reply.id, content };
  }

  // WAG-267: the same session showed visible work, so its delivered replies count as applied. One
  // UPDATE per matching reply; a reply that was marked "not applied yet" moves to applied (the
  // agent acted late). Returns the ids it changed. `caseId` narrows it to one case (a waggle_update).
  markRepliesApplied(sessionId: string, caseId?: string): string[] {
    const taskIds = [this.sessionTaskId(sessionId), ...this.topicTaskIds(sessionId)].filter(
      (t): t is string => t !== null,
    );
    if (taskIds.length === 0) return [];
    const marks = taskIds.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT r.id, r.case_id FROM replies r JOIN cases c ON c.id = r.case_id
         WHERE r.state = 'delivered' AND r.applied_at IS NULL AND c.task_id IN (${marks})
           ${caseId !== undefined ? "AND r.case_id = ?" : ""}`,
      )
      .all(...taskIds, ...(caseId !== undefined ? [caseId] : [])) as { id: string; case_id: string }[];
    return this.setApplyInTx(rows, "applied");
  }

  // WAG-267: a finished turn counts as visible work only when it began after the reply was delivered.
  // The turn that fetched the answer ends after the delivery too, and that one is not new work.
  markRepliesAppliedByTurn(sessionId: string, turnStartedAt: string): string[] {
    const taskIds = [this.sessionTaskId(sessionId), ...this.topicTaskIds(sessionId)].filter(
      (t): t is string => t !== null,
    );
    if (taskIds.length === 0) return [];
    const marks = taskIds.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT r.id, r.case_id FROM replies r JOIN cases c ON c.id = r.case_id
         WHERE r.state = 'delivered' AND r.applied_at IS NULL AND r.delivered_at <= ?
           AND c.task_id IN (${marks})`,
      )
      .all(turnStartedAt, ...taskIds) as { id: string; case_id: string }[];
    return this.setApplyInTx(rows, "applied");
  }

  // WAG-267: delivered replies with no visible work move to "not applied yet" when the session ends
  // (sessionId given) or when `maxAgeMs` passed since the delivery. Returns the ids it changed.
  markRepliesNotApplied(opts: { sessionId?: string; olderThanMs?: number }): string[] {
    const where: string[] = [`r.state = 'delivered'`, `r.applied_at IS NULL`, `r.not_applied_at IS NULL`];
    const args: string[] = [];
    if (opts.sessionId !== undefined) {
      const taskIds = [this.sessionTaskId(opts.sessionId), ...this.topicTaskIds(opts.sessionId)].filter(
        (t): t is string => t !== null,
      );
      if (taskIds.length === 0) return [];
      where.push(`c.task_id IN (${taskIds.map(() => "?").join(",")})`);
      args.push(...taskIds);
    }
    if (opts.olderThanMs !== undefined) {
      where.push(`r.delivered_at <= ?`);
      args.push(new Date(Date.now() - opts.olderThanMs).toISOString());
    }
    const rows = this.db
      .query(`SELECT r.id, r.case_id FROM replies r JOIN cases c ON c.id = r.case_id WHERE ${where.join(" AND ")}`)
      .all(...args) as { id: string; case_id: string }[];
    return this.setApplyInTx(rows, "not_applied");
  }

  private setApplyInTx(rows: { id: string; case_id: string }[], to: "applied" | "not_applied"): string[] {
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    const events: Event[] = [];
    this.db.transaction(() => {
      for (const row of rows) {
        this.db
          .query(
            to === "applied"
              ? `UPDATE replies SET applied_at = ?, not_applied_at = NULL WHERE id = ?`
              : `UPDATE replies SET not_applied_at = ? WHERE id = ?`,
          )
          .run(now, row.id);
        events.push(this.appendEvent("reply.state_changed", { reply_id: row.id, case_id: row.case_id }));
      }
    })();
    for (const event of events) this.bus?.emit(event);
    return rows.map((r) => r.id);
  }

  // Marks a queued reply delivered and emits reply.state_changed. Idempotent: a
  // reply that is already delivered (or failed) is returned unchanged.
  markReplyDelivered(replyId: string): Reply | null {
    const row = this.db
      .query(`SELECT * FROM replies WHERE id = ?`)
      .get(replyId) as ReplyRow | undefined;
    if (!row) return null;
    const unreachable = row.state === "failed" && row.reason === "session_unreachable";
    if (row.state !== "queued" && !unreachable) return rowToReply(this.db, row);
    let event: Event;
    this.db.transaction(() => {
      this.db
        .query(`UPDATE replies SET state = 'delivered', reason = NULL, delivered_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), replyId);
      event = this.appendEvent("reply.state_changed", {
        reply_id: replyId,
        case_id: row.case_id,
      });
    })();
    this.bus?.emit(event!);
    this.usage?.record({ event: "reply_delivered" });
    const updated = this.db
      .query(`SELECT * FROM replies WHERE id = ?`)
      .get(replyId) as ReplyRow;
    return rowToReply(this.db, updated);
  }

  private caseExists(caseId: string): boolean {
    return this.db.query(`SELECT 1 FROM cases WHERE id = ?`).get(caseId) != null;
  }

  // One case row mapped to the protocol noun, or null for an unknown id.
  caseById(caseId: string): Case | null {
    const row = this.db
      .query(`${caseSelectColumns()} WHERE c.id = ?`)
      .get(caseId) as CaseRow | undefined;
    return row ? this.withAnswerText(rowToCase(row)) : null;
  }

  // The denormalized task fields of a task, for a case returned by createCase.
  private taskRowById(taskId: string): { name: string; project: string; linear_key: string | null } | undefined {
    return this.db
      .query(`SELECT name, project, linear_key FROM tasks WHERE id = ?`)
      .get(taskId) as { name: string; project: string; linear_key: string | null } | undefined;
  }

  private nextRevisionNumber(caseId: string): number {
    const row = this.db
      .query(`SELECT COALESCE(MAX(n), 0) AS m FROM revisions WHERE case_id = ?`)
      .get(caseId) as { m: number };
    return row.m + 1;
  }

  // Inserts one revision row and appends its revision.added event. Runs inside
  // the caller's transaction; returns the row plus the appended event.
  private insertRevisionRow(
    caseId: string,
    staged: StagedArtifact,
    n: number,
    name?: string,
  ): { revision: Revision; event: Event } {
    const id = newId("r");
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO revisions
          (id, case_id, n, created_at, kind, sha256, ext, entry, items_json,
           viewport_width, viewport_height, preview, artifact_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        caseId,
        n,
        now,
        staged.kind,
        staged.kind === "screenshot" || staged.kind === "markdown" || staged.kind === "diagram"
          ? staged.sha256
          : null,
        staged.kind === "screenshot" || staged.kind === "diagram"
          ? staged.ext
          : staged.kind === "markdown"
            ? "md"
            : null,
        staged.kind === "html_bundle" ? staged.entry : null,
        staged.kind === "screenshots" ? JSON.stringify(staged.items) : null,
        staged.kind === "html_bundle" ? staged.viewport?.width ?? null : null,
        staged.kind === "html_bundle" ? staged.viewport?.height ?? null : null,
        staged.kind === "html_bundle" ? staged.preview ?? null : null,
        name ?? null,
      );
    const event = this.appendEvent("revision.added", { case_id: caseId });
    return {
      revision: { id, case_id: caseId, n, created_at: now, author: "agent", kind: staged.kind, ...(name ? { name } : {}) },
      event,
    };
  }

  private ingest(
    caseId: string,
    artifact: Artifact,
    n: number,
  ): StagedArtifact {
    const resolved = resolveIncoming(artifact, this.dataRoot);
    if (resolved.type === "screenshot") {
      return ingestScreenshot({
        incomingPath: resolved.path,
        blobsDir: join(this.dataRoot, "blobs"),
      });
    }
    if (resolved.type === "markdown") {
      return ingestMarkdown({
        incomingPath: resolved.path,
        blobsDir: join(this.dataRoot, "blobs"),
      });
    }
    if (resolved.type === "diagram") {
      return ingestDiagram({
        incomingPath: resolved.path,
        blobsDir: join(this.dataRoot, "blobs"),
      });
    }
    if (resolved.type === "screenshots") {
      return ingestScreenshots({
        items: resolved.items,
        blobsDir: join(this.dataRoot, "blobs"),
      });
    }
    return ingestBundle({
      incomingDir: resolved.dir,
      entry: resolved.entry,
      bundlesDir: join(this.dataRoot, "bundles"),
      caseId,
      revision: n,
      viewport: resolved.viewport,
      preview: resolved.preview,
    });
  }

  // Appends one event and publishes it to every subscriber. Used by stories
  // that change state (case updates, replies, sessions) and by tests.
  recordEvent(type: EventType, fields: EventFields = {}): Event {
    const event = this.appendEvent(type, fields);
    this.bus?.emit(event);
    return event;
  }

  // Operator settings (HAIL-100, HAIL-101). One row per key in `settings`; unset,
  // or a stored value that is no longer valid, reads as the default.
  private readSetting<T>(key: string, schema: { safeParse(v: unknown): { success: boolean; data?: T } }, fallback: T): T {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | null;
    if (!row) return fallback;
    let raw: unknown = row.value;
    try {
      raw = JSON.parse(row.value);
    } catch {
      // Plain strings (the artifact preset) are stored as they are.
    }
    const parsed = schema.safeParse(raw);
    return parsed.success ? (parsed.data as T) : fallback;
  }

  private writeSetting(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // HAIL-166: the default design kit. The current kit and one previous kit are two settings rows
  // (JSON). A stored value that no longer validates reads as the empty kit.
  getDesignKit(): DesignKit {
    return this.readSetting("designKit", DesignKit, EMPTY_DESIGN_KIT);
  }

  canUndoDesignKit(): boolean {
    return this.db.query("SELECT 1 FROM settings WHERE key = 'designKitPrev'").get() !== null;
  }

  // Applies a change. A change that alters no field stores nothing, so the previous kit stays.
  setDesignKit(change: DesignKitChange, updatedBy: string): DesignKit {
    const current = this.getDesignKit();
    const next: DesignKit = { ...current, ...change, updated_at: current.updated_at, updated_by: current.updated_by };
    const changed = (["design_system", "pen_file", "tone", "enabled"] as const).some((k) => next[k] !== current[k]);
    if (!changed) return current;
    next.updated_at = new Date().toISOString();
    next.updated_by = updatedBy;
    this.db.transaction(() => {
      this.writeSetting("designKitPrev", JSON.stringify(current));
      this.writeSetting("designKit", JSON.stringify(next));
    })();
    return next;
  }

  // Restores the previous kit, as a change by the person, and drops the previous version.
  undoDesignKit(): DesignKit | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = 'designKitPrev'").get() as
      | { value: string }
      | null;
    if (!row) return null;
    const parsed = DesignKit.safeParse(JSON.parse(row.value));
    const restored: DesignKit = {
      ...(parsed.success ? parsed.data : EMPTY_DESIGN_KIT),
      updated_at: new Date().toISOString(),
      updated_by: "you",
    };
    this.db.transaction(() => {
      this.writeSetting("designKit", JSON.stringify(restored));
      this.db.query("DELETE FROM settings WHERE key = 'designKitPrev'").run();
    })();
    return restored;
  }

  getArtifactPreset(): ArtifactPreset {
    return this.readSetting("artifactPreset", ArtifactPreset, DEFAULT_ARTIFACT_PRESET);
  }

  setArtifactPreset(value: ArtifactPreset): ArtifactPreset {
    this.writeSetting("artifactPreset", value);
    return value;
  }

  getAskTopics(): AskTopics {
    return this.readSetting("askTopics", AskTopics, DEFAULT_ASK_TOPICS);
  }

  setAskTopics(value: AskTopics): AskTopics {
    // Keep the picked list free of duplicates, in the order given.
    const clean: AskTopics = { scope: value.scope, picked: [...new Set(value.picked)] };
    this.writeSetting("askTopics", JSON.stringify(clean));
    return clean;
  }

  getAskFrequency(): AskFrequency {
    return this.readSetting("askFrequency", AskFrequency, DEFAULT_ASK_FREQUENCY);
  }

  setAskFrequency(value: AskFrequency): AskFrequency {
    this.writeSetting("askFrequency", JSON.stringify(value));
    return value;
  }

  getAskDetail(): AskDetail {
    return this.readSetting("askDetail", AskDetail, DEFAULT_ASK_DETAIL);
  }

  setAskDetail(value: AskDetail): AskDetail {
    this.writeSetting("askDetail", JSON.stringify(value));
    return value;
  }

  getAskReach(): AskReach {
    return this.readSetting("askReach", AskReach, DEFAULT_ASK_REACH);
  }

  setAskReach(value: AskReach): AskReach {
    this.writeSetting("askReach", JSON.stringify(value));
    return value;
  }

  getAskWords(): AskWords {
    return this.readSetting("askWords", AskWords, DEFAULT_ASK_WORDS);
  }

  setAskWords(value: AskWords): AskWords {
    this.writeSetting("askWords", JSON.stringify(value));
    return value;
  }

  getAskLearn(): AskLearn {
    return this.readSetting("askLearn", AskLearn, DEFAULT_ASK_LEARN);
  }

  setAskLearn(value: AskLearn): AskLearn {
    this.writeSetting("askLearn", JSON.stringify(value));
    return value;
  }

  // WAG-385: what the agent does after a decision. Kept out of the ask preferences and askText: it
  // reaches the agent in the reply, not at the start of the session.
  getAskAfterDecide(): AskAfterDecide {
    return this.readSetting("askAfterDecide", AskAfterDecide, DEFAULT_ASK_AFTER_DECIDE);
  }

  setAskAfterDecide(value: AskAfterDecide): AskAfterDecide {
    this.writeSetting("askAfterDecide", JSON.stringify(value));
    return value;
  }

  // WAG-412: "Let the agent decide small things". Off by default. The rules stay off while the master is off.
  getAskLess(): AskLess {
    const stored = this.readSetting("askLess", AskLess, DEFAULT_ASK_LESS);
    return stored.enabled ? stored : DEFAULT_ASK_LESS;
  }

  setAskLess(value: AskLess): AskLess {
    const next = value.enabled ? value : DEFAULT_ASK_LESS;
    this.writeSetting("askLess", JSON.stringify(next));
    return next;
  }

  // --- chat connectors (HAIL-144) ---

  // The saved state of one chat connector: on/off and display facts, never a secret. Null until the
  // operator connects it.
  getConnectorSetting<T>(id: string, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): T | null {
    return this.readSetting<T | null>(`connector.${id}`, schema as never, null);
  }

  setConnectorSetting(id: string, value: unknown | null): void {
    if (value === null) this.db.query("DELETE FROM settings WHERE key = ?").run(`connector.${id}`);
    else this.writeSetting(`connector.${id}`, JSON.stringify(value));
  }

  // --- sharing a case through the relay (WAG-387) ---

  getRelayShare(caseId: string): RelayShare | null {
    const row = this.db.query(`SELECT * FROM relay_shares WHERE case_id = ?`).get(caseId) as RelayShareRow | null;
    return row ? rowToRelayShare(row) : null;
  }

  listRelayShares(): RelayShare[] {
    return (this.db.query(`SELECT * FROM relay_shares ORDER BY created_at`).all() as RelayShareRow[]).map(rowToRelayShare);
  }

  saveRelayShare(share: Pick<RelayShare, "case_id" | "relay_id" | "url" | "mode" | "emails"> & Partial<Pick<RelayShare, "root_case_id" | "ask_sig">>): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO relay_shares (case_id, relay_id, url, mode, emails_json, since, since_id, created_at, root_case_id, ask_sig)
         VALUES (?, ?, ?, ?, ?, 0, '', ?, ?, ?)`,
      )
      .run(share.case_id, share.relay_id, share.url, share.mode, JSON.stringify(share.emails), new Date().toISOString(), share.root_case_id ?? null, share.ask_sig ?? null);
  }

  // What was last sent to the relay for a case, so a change is noticed (the ask) and a retry is not a repeat (the outcome).
  setRelayAskSig(caseId: string, sig: string | null): void {
    this.db.query(`UPDATE relay_shares SET ask_sig = ? WHERE case_id = ?`).run(sig, caseId);
  }

  setRelayOutcomeSig(caseId: string, sig: string | null): void {
    this.db.query(`UPDATE relay_shares SET outcome_sig = ? WHERE case_id = ?`).run(sig, caseId);
  }

  setRelayCommentsClosed(caseId: string, closed: boolean): void {
    this.db.query(`UPDATE relay_shares SET comments_closed = ? WHERE case_id = ?`).run(closed ? 1 : 0, caseId);
  }

  // Every case that uses the same link (the first case and its follow-ups).
  relayShareCases(relayId: string): string[] {
    return (this.db.query(`SELECT case_id FROM relay_shares WHERE relay_id = ?`).all(relayId) as { case_id: string }[]).map((r) => r.case_id);
  }

  wasRelayShared(caseId: string): boolean {
    return this.db.query(`SELECT 1 FROM relay_stopped WHERE case_id = ?`).get(caseId) !== null;
  }

  // The case a follow-up ask follows, or null.
  followsCase(caseId: string): string | null {
    const row = this.db.query(`SELECT follows_case_id FROM cases WHERE id = ?`).get(caseId) as { follows_case_id: string | null } | null;
    return row?.follows_case_id ?? null;
  }

  // Removes the share and its uploaded-round marks. The team's comments stay (WAG-391): they are
  // what the owner and the agent already read. Each keeps its revision, which relay_rounds gave it.
  deleteRelayShare(caseId: string): void {
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE relay_comments SET revision = (SELECT rr.revision FROM relay_rounds rr WHERE rr.case_id = relay_comments.case_id AND rr.relay_seq = relay_comments.round_seq)
           WHERE case_id = ? AND revision IS NULL`,
        )
        .run(caseId);
      this.db.query(`DELETE FROM relay_rounds WHERE case_id = ?`).run(caseId);
      this.db.query(`DELETE FROM relay_skipped_rounds WHERE case_id = ?`).run(caseId);
      this.db.query(`DELETE FROM relay_shares WHERE case_id = ?`).run(caseId);
      this.db.query(`INSERT OR REPLACE INTO relay_stopped (case_id, stopped_at) VALUES (?, ?)`).run(caseId, new Date().toISOString());
    })();
  }

  updateRelayShare(caseId: string, mode: "link" | "emails", emails: string[]): void {
    this.db.query(`UPDATE relay_shares SET mode = ?, emails_json = ? WHERE case_id = ?`).run(mode, JSON.stringify(emails), caseId);
  }

  getRelayShareByRelayId(relayId: string): RelayShare | null {
    const row = this.db.query(`SELECT * FROM relay_shares WHERE relay_id = ?`).get(relayId) as RelayShareRow | null;
    return row ? rowToRelayShare(row) : null;
  }

  setRelayCursor(caseId: string, since: number, sinceId: string): void {
    this.db.query(`UPDATE relay_shares SET since = ?, since_id = ? WHERE case_id = ?`).run(since, sinceId, caseId);
  }

  // A round the relay can never take. It is not tried again.
  skipRelayRound(caseId: string, revision: number, reason: string): void {
    this.db
      .query(`INSERT OR REPLACE INTO relay_skipped_rounds (case_id, revision, reason) VALUES (?, ?, ?)`)
      .run(caseId, revision, reason);
  }

  relaySkipped(caseId: string): { revision: number; reason: string }[] {
    return this.db.query(`SELECT revision, reason FROM relay_skipped_rounds WHERE case_id = ? ORDER BY revision`).all(caseId) as {
      revision: number;
      reason: string;
    }[];
  }

  // Relay case ids whose local case is gone but whose page may still be live.
  listPendingRelayStops(): string[] {
    return (this.db.query(`SELECT relay_id FROM relay_pending_stops ORDER BY created_at`).all() as { relay_id: string }[]).map((r) => r.relay_id);
  }

  addPendingRelayStop(relayId: string): void {
    this.db.query(`INSERT OR IGNORE INTO relay_pending_stops (relay_id, created_at) VALUES (?, ?)`).run(relayId, new Date().toISOString());
  }

  removePendingRelayStop(relayId: string): void {
    this.db.query(`DELETE FROM relay_pending_stops WHERE relay_id = ?`).run(relayId);
  }

  // The artifact name the agent gave a revision, or null.
  revisionArtifactName(caseId: string, revision: number): string | null {
    const row = this.db.query(`SELECT artifact_name FROM revisions WHERE case_id = ? AND n = ?`).get(caseId, revision) as
      | { artifact_name: string | null }
      | null;
    return row?.artifact_name ?? null;
  }

  // Revision numbers already uploaded, with the relay's round number for each.
  relayRounds(caseId: string): Map<number, number> {
    const rows = this.db.query(`SELECT revision, relay_seq FROM relay_rounds WHERE case_id = ?`).all(caseId) as {
      revision: number;
      relay_seq: number;
    }[];
    return new Map(rows.map((r) => [r.revision, r.relay_seq]));
  }

  markRelayRound(caseId: string, revision: number, relaySeq: number): void {
    this.db
      .query(`INSERT OR REPLACE INTO relay_rounds (case_id, revision, relay_seq) VALUES (?, ?, ?)`)
      .run(caseId, revision, relaySeq);
  }

  revisionNumbers(caseId: string): number[] {
    return (this.db.query(`SELECT n FROM revisions WHERE case_id = ? ORDER BY n`).all(caseId) as { n: number }[]).map((r) => r.n);
  }

  // Stores comments the relay sent. A comment that is already stored (same relay id) is skipped.
  // A page can hold the rounds of several cases (a follow-up uses the same link): a comment goes to the case
  // that uploaded its round. A round no case here uploaded goes to the first case of the link (`isRoot`).
  // Returns how many were new, and how many of those came from the team (a member or a guest).
  addRelayComments(caseId: string, comments: RelayCommentInput[], isRoot = true): { added: number; team: number } {
    let added = 0;
    let team = 0;
    const insert = this.db.query(
      `INSERT OR IGNORE INTO relay_comments (id, case_id, round_seq, author_name, author_kind, author_email, body, quote, prefix, suffix, box_json, created_ms, revision,
                                              parent_id, resolved_ms, resolved_by, agent_seen, owner_seen, notified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT rr.revision FROM relay_rounds rr WHERE rr.case_id = ? AND rr.relay_seq = ?), ?, ?, ?, ?, ?, ?)`,
    );
    const relayId = (this.db.query(`SELECT relay_id FROM relay_shares WHERE case_id = ?`).get(caseId) as { relay_id: string } | null)?.relay_id ?? null;
    this.db.transaction(() => {
      for (const c of comments) {
        const mine = this.db.query(`SELECT 1 FROM relay_rounds WHERE case_id = ? AND relay_seq = ?`).get(caseId, c.round_seq) !== null;
        if (!mine) {
          // Another case on this link has the round, or this one is not the first case of the link.
          const other =
            relayId !== null &&
            this.db
              .query(`SELECT 1 FROM relay_rounds rr JOIN relay_shares s ON s.case_id = rr.case_id WHERE s.relay_id = ? AND rr.relay_seq = ? AND rr.case_id != ?`)
              .get(relayId, c.round_seq, caseId) !== null;
          if (other || !isRoot) continue;
        }
        const fromTeam = c.author_kind === "member" || c.author_kind === "guest";
        const r = insert.run(
          c.id,
          caseId,
          c.round_seq,
          c.author_name,
          c.author_kind,
          c.author_email,
          c.body,
          c.quote,
          c.prefix,
          c.suffix,
          c.box ? JSON.stringify(c.box) : null,
          c.created_ms,
          caseId,
          c.round_seq,
          c.parent_id ?? null,
          c.resolved_ms ?? null,
          c.resolved_by ?? null,
          c.author_kind === "agent" ? 1 : 0,
          fromTeam ? 0 : 1,
          fromTeam ? 0 : 1,
        );
        added += r.changes;
        if (fromTeam) team += r.changes;
      }
    })();
    return { added, team };
  }

  // The state of the resolved threads, as the relay lists them. A thread the relay no longer lists as resolved is
  // open again. Returns true when something changed.
  applyRelayResolutions(caseId: string, resolved: { id: string; resolved_ms: number; resolved_by: string | null }[]): boolean {
    let changed = false;
    this.db.transaction(() => {
      const ids = new Set(resolved.map((r) => r.id));
      const now = this.db.query(`SELECT id, resolved_ms FROM relay_comments WHERE case_id = ?`).all(caseId) as { id: string; resolved_ms: number | null }[];
      for (const row of now) {
        const r = resolved.find((x) => x.id === row.id);
        if (r && row.resolved_ms !== r.resolved_ms) {
          this.db.query(`UPDATE relay_comments SET resolved_ms = ?, resolved_by = ? WHERE id = ?`).run(r.resolved_ms, r.resolved_by, row.id);
          changed = true;
        } else if (!r && !ids.has(row.id) && row.resolved_ms !== null) {
          this.db.query(`UPDATE relay_comments SET resolved_ms = NULL, resolved_by = NULL WHERE id = ?`).run(row.id);
          changed = true;
        }
      }
    })();
    return changed;
  }

  setRelayResolved(commentId: string, resolvedMs: number | null, by: string | null): void {
    this.db.query(`UPDATE relay_comments SET resolved_ms = ?, resolved_by = ? WHERE id = ?`).run(resolvedMs, by, commentId);
  }

  relayCommentCase(commentId: string): { case_id: string; parent_id: string | null } | null {
    return this.db.query(`SELECT case_id, parent_id FROM relay_comments WHERE id = ?`).get(commentId) as { case_id: string; parent_id: string | null } | null;
  }

  // The agent was given every comment up to now (a result went to the agent).
  markRelayCommentsGiven(caseId: string): void {
    this.db.query(`UPDATE relay_comments SET agent_seen = 1 WHERE case_id = ? AND agent_seen = 0`).run(caseId);
  }

  // True when a team comment waits for the agent.
  hasNewTeamComments(caseId: string): boolean {
    return (
      this.db.query(`SELECT 1 FROM relay_comments WHERE case_id = ? AND agent_seen = 0 AND author_kind IN ('member', 'guest') LIMIT 1`).get(caseId) !== null
    );
  }

  // WAG-401: when the owner last decided the case, in ms (the newest reply with outcome "decide"; replaced_at when the
  // answer was changed). Null when the case is not decided.
  decidedAtMs(caseId: string): number | null {
    const detail = this.getCase(caseId);
    // A case with an open ask again (needs_you), or whose last reply only talked, is not decided.
    if (!detail || detail.case.status === "needs_you") return null;
    const last = detail.replies[detail.replies.length - 1];
    if (!last || last.outcome !== "decide") return null;
    return Date.parse(last.replaced_at ?? last.created_at) || null;
  }

  // WAG-401: team comments that came after the last decide answer. `new` counts those the agent was not given yet.
  lateTeamComments(caseId: string): { count: number; new: number } {
    const at = this.decidedAtMs(caseId);
    if (at === null) return { count: 0, new: 0 };
    const row = this.db
      .query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(agent_seen = 0), 0) AS fresh FROM relay_comments
         WHERE case_id = ? AND author_kind IN ('member', 'guest') AND created_ms > ?`,
      )
      .get(caseId, at) as { count: number; fresh: number };
    return { count: row.count, new: row.fresh };
  }

  // The late team comments were sent to the agent: they are not new any more.
  markLateCommentsGiven(caseId: string): void {
    const at = this.decidedAtMs(caseId);
    if (at === null) return;
    this.db.query(`UPDATE relay_comments SET agent_seen = 1 WHERE case_id = ? AND agent_seen = 0 AND created_ms > ?`).run(caseId, at);
  }

  // True when a team comment waits for the agent and came before the decision (or the case is open). A late comment
  // does not count: it never wakes the agent by itself (WAG-401).
  hasNewEarlyTeamComments(caseId: string): boolean {
    const at = this.decidedAtMs(caseId);
    return (
      this.db
        .query(`SELECT 1 FROM relay_comments WHERE case_id = ? AND agent_seen = 0 AND author_kind IN ('member', 'guest') AND (? IS NULL OR created_ms <= ?) LIMIT 1`)
        .get(caseId, at, at) !== null
    );
  }

  // The owner opened the case: its team comments are read.
  markRelayCommentsRead(caseId: string): void {
    this.db.query(`UPDATE relay_comments SET owner_seen = 1 WHERE case_id = ? AND owner_seen = 0`).run(caseId);
  }

  unreadRelayComments(): { case_id: string; count: number }[] {
    return this.db
      .query(`SELECT case_id, COUNT(*) AS count FROM relay_comments WHERE owner_seen = 0 GROUP BY case_id ORDER BY case_id`)
      .all() as { case_id: string; count: number }[];
  }

  // Team comments the app has not told the person about, oldest first. They are marked told. Only the newest
  // `limit` are returned; the older ones are marked without a notice.
  takeRelayNotifications(limit = 5): { case_id: string; case_title: string; comment_id: string; author_name: string; body: string }[] {
    const rows = this.db
      .query(
        `SELECT c.id AS comment_id, c.case_id, c.author_name, c.body, k.title AS case_title FROM relay_comments c JOIN cases k ON k.id = c.case_id
         WHERE c.notified = 0 ORDER BY c.created_ms, c.id`,
      )
      .all() as { comment_id: string; case_id: string; author_name: string; body: string; case_title: string }[];
    if (rows.length > 0) this.db.query(`UPDATE relay_comments SET notified = 1 WHERE notified = 0`).run();
    return rows.slice(-limit);
  }

  relayComments(caseId: string): (SharedComment & { agent_seen: boolean })[] {
    const rows = this.db
      .query(
        `SELECT c.id, c.case_id, c.round_seq, c.author_name, c.author_kind, c.author_email, c.body, c.quote, c.prefix, c.suffix, c.box_json, c.created_ms,
                c.parent_id, c.resolved_ms, c.resolved_by, c.agent_seen, c.owner_seen,
                COALESCE(c.revision, (SELECT rr.revision FROM relay_rounds rr WHERE rr.case_id = c.case_id AND rr.relay_seq = c.round_seq)) AS revision
         FROM relay_comments c WHERE c.case_id = ? ORDER BY c.created_ms, c.id`,
      )
      .all(caseId) as (RelayCommentRow & { revision: number | null })[];
    return rows.map((r) => ({
      id: r.id,
      revision: r.revision,
      author_name: r.author_name,
      // The relay's old "email" kind is a member now (WAG-392).
      author_kind: r.author_kind === "owner" || r.author_kind === "member" || r.author_kind === "agent" ? r.author_kind : r.author_kind === "email" ? "member" : "guest",
      author_email: r.author_email,
      body: r.body,
      quote: r.quote,
      prefix: r.prefix,
      suffix: r.suffix,
      box: r.box_json ? (JSON.parse(r.box_json) as SharedComment["box"]) : null,
      created_at: new Date(r.created_ms).toISOString(),
      parent_id: r.parent_id,
      resolved_at: r.resolved_ms !== null ? new Date(r.resolved_ms).toISOString() : null,
      resolved_by: r.resolved_by,
      unread: r.owner_seen === 0,
      agent_seen: r.agent_seen === 1,
    }));
  }

  // The chat message sent for a case, or null.
  findConnectorMessage(connector: string, caseId: string): ConnectorMessage | null {
    const row = this.db
      .query(`SELECT * FROM connector_messages WHERE connector = ? AND case_id = ?`)
      .get(connector, caseId) as ConnectorMessageRow | null;
    return row ? rowToConnectorMessage(row) : null;
  }

  // The case a chat message belongs to (a reply to it), or null.
  findConnectorMessageByKey(connector: string, msgKey: string): ConnectorMessage | null {
    const row = this.db
      .query(`SELECT * FROM connector_messages WHERE connector = ? AND msg_key = ?`)
      .get(connector, msgKey) as ConnectorMessageRow | null;
    return row ? rowToConnectorMessage(row) : null;
  }

  saveConnectorMessage(connector: string, caseId: string, msgKey: string, ref: unknown): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO connector_messages (connector, case_id, msg_key, ref_json, outcome, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(connector, caseId, msgKey, JSON.stringify(ref), new Date().toISOString());
  }

  setConnectorOutcome(connector: string, caseId: string, outcome: string): void {
    this.db
      .query(`UPDATE connector_messages SET outcome = ? WHERE connector = ? AND case_id = ?`)
      .run(outcome, connector, caseId);
  }

  // Asks that wait for the human now. The daemon stays up while a chat connector is on and this is
  // above zero, so a phone reply has somewhere to go.
  countNeedsYouCases(): number {
    return (
      this.db
        .query(`SELECT COUNT(*) AS n FROM cases WHERE status = 'needs_you' AND dismissed_at IS NULL`)
        .get() as { n: number }
    ).n;
  }

  getAskPreferences(): AskPreferences {
    return {
      topics: this.getAskTopics(),
      frequency: this.getAskFrequency(),
      detail: this.getAskDetail(),
      reach: this.getAskReach(),
      words: this.getAskWords(),
      learn: this.getAskLearn(),
    };
  }

  // Records a usage event through the single write path (the UsageLogger). A
  // no-op when the store has no logger. The RPC usage.record and the server's
  // ask_pending_timeout path both record through here.
  recordUsage(input: unknown): void {
    this.usage?.recordFromApp(input);
  }

  // The tool-call log (HAIL-195); undefined when the store has no usage logger.
  get toolLog(): ToolCallLog | undefined {
    return this.usage?.tools;
  }

  private appendEvent(type: EventType, fields: EventFields): Event {
    const at = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO events (type, case_id, reply_id, session_id, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        type,
        fields.case_id ?? null,
        fields.reply_id ?? null,
        fields.session_id ?? null,
        at,
      );
    const event: Event = { type, at };
    if (fields.case_id !== undefined) event.case_id = fields.case_id;
    if (fields.reply_id !== undefined) event.reply_id = fields.reply_id;
    if (fields.session_id !== undefined) event.session_id = fields.session_id;
    return event;
  }
}

// reply.replace on a reply that is no longer queued (HAIL-34): the answer is
// editable only up to the moment the agent picks it up. `state` is the
// reply's actual state, so the RPC layer can say exactly why.
export class ReplyNotQueuedError extends Error {
  constructor(public readonly state: ReplyStatus) {
    super(`reply is ${state}, not queued`);
  }
}

// waggle_ask's follows (HAIL-33 amendment) named a case that does not exist, or
// one that belongs to another task. No case is created.
export class FollowsCaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowsCaseError";
  }
}

// A reply's choice is not an id of the case's newest option set, nor of the
// first one (HAIL-108). No reply is stored.
export class ChoiceNotOfferedError extends Error {
  constructor(choice: string, message?: string) {
    super(message ?? `choice "${choice}" is not one of the options offered on this case`);
    this.name = "ChoiceNotOfferedError";
  }
}

// waggle_ask's replaces (HAIL-44) named a case that does not exist, or one
// that belongs to another task. No case is created and the named case is
// never withdrawn.
export class ReplacesCaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplacesCaseError";
  }
}

interface OptionSetRow {
  seq: number;
  options_json: string;
  select_mode: "one" | "many";
  max_choices: number | null;
}

// The option set a multi-select reply (HAIL-123) is from, validated: `choices` and `choice` are
// not mixed, every id is in one set that is select "many" (the newest, else the first, or the
// first outright for options_set "first"), none repeats, there are at most `max`, and an empty
// list comes with a message ("none of these").
function resolveChoicesSet(
  input: ReplyContentInput,
  first: OptionSetRow | undefined,
  newest: OptionSetRow | undefined,
): number {
  const choices = input.choices ?? [];
  if (input.choice !== undefined) {
    throw new ChoiceNotOfferedError("", "send choice or choices, not both");
  }
  if (new Set(choices).size !== choices.length) {
    throw new ChoiceNotOfferedError("", "choices names the same option twice");
  }
  if (choices.length === 0 && (input.message ?? "").trim() === "") {
    throw new ChoiceNotOfferedError("", "choices is empty: add a message to say none of these fit");
  }
  const candidates = (input.options_set === "first" ? [first] : [newest, first]).filter(
    (set): set is OptionSetRow => set !== undefined,
  );
  const set = candidates.find((c) => {
    const ids = (JSON.parse(c.options_json) as Option[]).map((o) => o.id);
    return choices.every((id) => ids.includes(id));
  });
  if (!set) {
    const known = new Set(candidates.flatMap((c) => (JSON.parse(c.options_json) as Option[]).map((o) => o.id)));
    throw new ChoiceNotOfferedError(choices.find((id) => !known.has(id)) ?? choices[0] ?? "");
  }
  if (set.select_mode !== "many") {
    throw new ChoiceNotOfferedError("", 'this ask takes one choice: send choice, not choices');
  }
  if (set.max_choices !== null && choices.length > set.max_choices) {
    throw new ChoiceNotOfferedError("", `choices has ${choices.length} options but max is ${set.max_choices}`);
  }
  return set.seq;
}

export interface EventFields {
  case_id?: string;
  reply_id?: string;
  session_id?: string;
}

// A reply without its idempotency key: reply.replace edits a reply that already has one.
export type ReplyContentInput = Omit<CreateReplyInput, "idempotency_key"> & { idempotency_key?: string };

export interface CreateReplyInput {
  idempotency_key: string;
  choice?: string;
  // Option ids for a select "many" ask (HAIL-123).
  choices?: string[];
  // Which option set `choice` is from (HAIL-108). Omitted means the newest.
  options_set?: "first" | "latest";
  message?: string;
  comments: Comment[];
  captures: Capture[];
  // "decision" (default) or "more_detail" (HAIL-33). reply.replace never
  // changes it: intent is fixed at the reply's first submission.
  intent?: ReplyIntent;
  // A discuss reply (WAG-301): the option ids the human leans to and rules out.
  leaning?: string[];
  ruled_out?: string[];
  // The format a more_detail reply asks for (HAIL-139). Like intent, it is
  // fixed at first submission; reply.replace never changes it.
  format?: ReplyFormat;
  // Where the reply came from (HAIL-144). Omitted means "mac". reply.replace sets it too: a change
  // made in the app is a Mac answer.
  source?: ReplySource;
  // The revision by "you" this reply carries as the person's edit (HAIL-168). reply.replace sets it
  // too; omitted drops the edit.
  edit?: { revision: number };
  // WAG-313: the answers by item id. Checked against the items of the round, then projected onto choice,
  // choices, answers and message for any of those the reply does not give itself.
  item_answers?: ItemAnswer[];
  // The answers to the points of a multi-question request. Checked against the case's questions.
  answers?: PointAnswer[];
  // WAG-345: files the person attached. New files name their copy in incoming/; on reply.replace a file the
  // reply holds names its stored path. Omitted on reply.replace keeps the files.
  attachments?: ReplyAttachmentInput[];
}

export interface ConnectorMessage {
  connector: string;
  case_id: string;
  msg_key: string;
  ref: unknown;
  outcome: string | null;
  created_at: string;
}

interface ConnectorMessageRow {
  connector: string;
  case_id: string;
  msg_key: string;
  ref_json: string;
  outcome: string | null;
  created_at: string;
}

function rowToConnectorMessage(row: ConnectorMessageRow): ConnectorMessage {
  return {
    connector: row.connector,
    case_id: row.case_id,
    msg_key: row.msg_key,
    ref: JSON.parse(row.ref_json) as unknown,
    outcome: row.outcome,
    created_at: row.created_at,
  };
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

// --- row mappers (DB row -> protocol noun) ---

// The sources of a round (WAG-354). A stored value that does not parse reads as no sources.
function parseSources(json: string): Source[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Source[]) : [];
  } catch {
    return [];
  }
}

// The columns of an option_sets row that items come from (protocol/items.ts RoundRow).
interface OptionSetItemsRow {
  seq: number;
  items_json: string | null;
  options_json: string;
  recommendation: string;
  recommendation_why: string | null;
  select_mode: "one" | "many" | null;
  max_choices: number | null;
  recommendations_json: string | null;
}

interface CaseRow {
  id: string;
  task_id: string;
  task_name: string;
  project: string;
  linear_key: string | null;
  kind: "question" | "review";
  title: string;
  need: string;
  questions_json?: string | null;
  why: string;
  recommendation: string;
  recommendation_why: string;
  select_mode: "one" | "many";
  max_choices: number | null;
  recommendations_json: string | null;
  options_json: string;
  first_options_json: string;
  first_recommendation: string;
  options_updated_at: string | null;
  options_seq: number;
  options_question: string | null;
  latest_items_json?: string | null;
  latest_sources_json?: string | null;
  plan_stage_json: string | null;
  plan_rounds: number;
  plan_artifact_kind: ArtifactKind | null;
  plan_answered: number;
  latest_reply_option_set_seq: number | null;
  status: CaseStatus;
  has_artifact: number;
  artifact_kind: ArtifactKind | null;
  latest_reply_id: string | null;
  latest_reply_state: ReplyStatus | null;
  latest_reply_at: string | null;
  latest_reply_delivered_at: string | null;
  latest_reply_applied_at: string | null;
  latest_reply_not_applied_at: string | null;
  latest_reply_choice: string | null;
  latest_reply_choices_json: string | null;
  latest_reply_answers_json?: string | null;
  latest_reply_message: string | null;
  latest_reply_intent: ReplyIntent | null;
  latest_reply_format: ReplyFormat | null;
  latest_reply_source: ReplySource | null;
  first_reply_submitted_at: string | null;
  update_count: number;
  latest_update_at: string | null;
  latest_update_message: string | null;
  revision_count: number;
  latest_revision_at: string | null;
  working_note: string | null;
  runtime: Runtime;
  session_state: SessionState | null;
  dismissed_at: string | null;
  status_before_dismiss: CaseStatus | null;
  follows_case_id: string | null;
  replaces_case_id: string | null;
  withdrawn_at: string | null;
  done_at: string | null;
  last_check_at: string | null;
  session_can_nudge: number | null;
  session_client_name: string | null;
  session_ended_at: string | null;
  auto_category?: string | null;
  auto_rule?: string | null;
  auto_choice?: string | null;
  auto_answer?: string | null;
  auto_at?: string | null;
  matched_case_ids_json?: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  name: string;
  project: string;
}

export interface NudgeTarget {
  title: string;
  session: { id: string; state: SessionState; can_nudge: boolean } | null;
  reply: { id: string; state: ReplyStatus; nudge_count: number } | null;
}

interface SessionRow {
  id: string;
  cwd: string;
  branch: string | null;
  pid: number;
  state: SessionState;
  runtime: Runtime;
  connected_at: string;
}

interface SessionInfoRow {
  id: string;
  task_id: string;
  cwd: string;
  branch: string | null;
  pid: number;
  state: SessionState;
  runtime: Runtime;
  connected_at: string;
  last_seen_at: string;
  can_nudge: number;
  client_name: string | null;
  session_title: string | null;
  task_name: string;
  project: string;
}

interface MessageRow {
  id: string;
  case_id: string;
  role: "agent" | "human";
  text: string;
  created_at: string;
  working: number;
}

export interface RelayShare {
  case_id: string;
  relay_id: string;
  url: string;
  mode: "link" | "emails";
  emails: string[];
  // The newest comment time (ms) the daemon has fetched. The next fetch asks for newer ones.
  since: number;
  // The id of the newest comment at that time. Together they make the cursor, so two comments in one
  // millisecond are never skipped.
  since_id: string;
  created_at: string;
  // A follow-up case that uses the link of an earlier case names that case (WAG-394). Null for the first case.
  root_case_id: string | null;
  // What the daemon last sent to the relay: the ask (a signature), and the outcome of the last answer.
  ask_sig: string | null;
  outcome_sig: string | null;
  // The owner closed the comments of the page.
  comments_closed: boolean;
}

interface RelayShareRow {
  case_id: string;
  relay_id: string;
  url: string;
  mode: "link" | "emails";
  emails_json: string;
  since: number;
  since_id: string;
  created_at: string;
  root_case_id: string | null;
  ask_sig: string | null;
  outcome_sig: string | null;
  comments_closed: number;
}

export interface RelayCommentInput {
  id: string;
  round_seq: number;
  author_name: string;
  author_kind: string;
  author_email: string | null;
  body: string;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  box: NonNullable<SharedComment["box"]> | null;
  created_ms: number;
  parent_id?: string | null;
  resolved_ms?: number | null;
  resolved_by?: string | null;
}

interface RelayCommentRow {
  id: string;
  case_id: string;
  round_seq: number;
  author_name: string;
  author_kind: string;
  author_email: string | null;
  body: string;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  box_json: string | null;
  created_ms: number;
  parent_id: string | null;
  resolved_ms: number | null;
  resolved_by: string | null;
  agent_seen: number;
  owner_seen: number;
}

function rowToRelayShare(row: RelayShareRow): RelayShare {
  return {
    case_id: row.case_id,
    relay_id: row.relay_id,
    url: row.url,
    mode: row.mode,
    emails: JSON.parse(row.emails_json) as string[],
    since: row.since,
    since_id: row.since_id,
    created_at: row.created_at,
    root_case_id: row.root_case_id,
    ask_sig: row.ask_sig,
    outcome_sig: row.outcome_sig,
    comments_closed: row.comments_closed === 1,
  };
}

interface RevisionRow {
  id: string;
  case_id: string;
  n: number;
  created_at: string;
  kind: ArtifactKind;
  sha256: string | null;
  ext: string | null;
  entry: string | null;
  items_json: string | null;
  viewport_width: number | null;
  viewport_height: number | null;
  preview: string | null;
  author: "agent" | "you";
  artifact_name: string | null;
  base_n: number | null;
  passages_changed: number | null;
}

interface CaptureRow {
  id: string;
  case_id: string;
  revision: number;
  reply_id: string | null;
  png_base64: string;
  annotated_png_base64: string;
  taken_at: string;
  note: string | null;
}

// The columns purgeResolvedCases/resolvedCaseStats need to name a revision's
// blob path(s) - a subset of RevisionRow's columns, read for kinds other than
// html_bundle (which lives in bundles/, not blobs/).
interface RevisionBlobRow {
  kind: "screenshot" | "html_bundle" | "markdown" | "screenshots";
  sha256: string | null;
  ext: string | null;
  items_json: string | null;
}

// blobs/<sha256>.<ext> for a screenshot or markdown revision (markdown's
// stored ext is implicitly "md" - ingestMarkdown never writes an ext column),
// or one blobs/<sha256>.<ext> per item of a screenshots revision.
function blobPathsFromRows(rows: RevisionBlobRow[], dataRoot: string): Set<string> {
  const paths = new Set<string>();
  for (const row of rows) {
    if ((row.kind === "screenshot" || row.kind === "markdown") && row.sha256) {
      const ext = row.kind === "markdown" ? "md" : row.ext;
      paths.add(join(dataRoot, "blobs", `${row.sha256}.${ext}`));
    } else if (row.kind === "screenshots" && row.items_json) {
      const items = JSON.parse(row.items_json) as StagedScreenshotsItem[];
      for (const item of items) paths.add(join(dataRoot, "blobs", `${item.sha256}.${item.ext}`));
    }
  }
  return paths;
}

// The recursive byte total of a directory tree (a staged bundle). Best
// effort: a directory that no longer exists (already removed, or never
// staged) contributes 0 rather than throwing.
function dirSizeSync(dir: string): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let bytes = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    bytes += entry.isDirectory() ? dirSizeSync(path) : fileSizeSync(path);
  }
  return bytes;
}

// A file's byte size, or 0 when it cannot be stat'd (already removed, or
// never staged).
function fileSizeSync(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Restores every write bit (chmod a+w) through a tree ingestBundle made
// read-only, deepest first, so purgeResolvedCases can then rmSync it. A
// missing path (already removed) is a no-op.
function makeWritable(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  }
  try {
    chmodSync(path, st.mode | 0o222);
  } catch {
    // Nothing to fix.
  }
}

interface CommentRow {
  id: string;
  case_id: string;
  capture_id: string | null;
  reply_id: string | null;
  n: number;
  rect_json: string | null;
  anchor_json: string | null;
  text: string;
}

// WAG-267: how long after a delivery the daemon waits for visible work before it says "not applied yet".
export const APPLY_WAIT_MS = 15 * 60_000;

interface ReplyRow {
  id: string;
  case_id: string;
  idempotency_key: string;
  choice: string | null;
  choices_json: string | null;
  answers_json?: string | null;
  item_answers_json?: string | null;
  message: string | null;
  intent: ReplyIntent;
  leaning_json?: string | null;
  ruled_out_json?: string | null;
  format: ReplyFormat | null;
  source: ReplySource;
  state: ReplyStatus;
  reason: string | null;
  created_at: string;
  replaced_at: string | null;
  delivered_at: string | null;
  applied_at: string | null;
  not_applied_at: string | null;
  edit_revision: number | null;
  attachments_json?: string | null;
}

interface EventRow {
  type: EventType;
  case_id: string | null;
  reply_id: string | null;
  session_id: string | null;
  at: string;
}

// How much of the latest agent update a Case carries (HAIL-67): enough for a
// one-line queue row without shipping the whole message with every list.
const UPDATE_MESSAGE_PREVIEW_CHARS = 140;

// The SELECT shared by listCases, getCase and caseById: the case row plus its
// denormalized task fields, the kind of the latest staged revision, and the
// case's most recent reply (id, state, created_at) - so a queue row survives
// an app relaunch without a per-row cases.get (KNOCK-13 fold, Amendment 1).
// `lr` is the case's latest reply and `ls` the latest session of its task: each is found once per
// row and joined, so every latest_reply_* and session_* column reads the same row.
function caseSelectColumns(): string {
  return `SELECT c.*,
        EXISTS (SELECT 1 FROM revisions r WHERE r.case_id = c.id) AS has_artifact,
        (SELECT r.kind FROM revisions r WHERE r.case_id = c.id ORDER BY r.n DESC LIMIT 1) AS artifact_kind,
        lr.id AS latest_reply_id,
        lr.state AS latest_reply_state,
        lr.created_at AS latest_reply_at,
        lr.delivered_at AS latest_reply_delivered_at,
        lr.applied_at AS latest_reply_applied_at,
        lr.not_applied_at AS latest_reply_not_applied_at,
        lr.choice AS latest_reply_choice,
        lr.choices_json AS latest_reply_choices_json,
        lr.answers_json AS latest_reply_answers_json,
        lr.message AS latest_reply_message,
        lr.intent AS latest_reply_intent,
        lr.format AS latest_reply_format,
        lr.source AS latest_reply_source,
        (SELECT ros.seq FROM reply_option_sets ros WHERE ros.reply_id = lr.id) AS latest_reply_option_set_seq,
        COALESCE((SELECT o.options_json FROM option_sets o WHERE o.case_id = c.id AND o.seq = 0), c.options_json) AS first_options_json,
        COALESCE((SELECT o.recommendation FROM option_sets o WHERE o.case_id = c.id AND o.seq = 0), c.recommendation) AS first_recommendation,
        (SELECT MAX(o.created_at) FROM option_sets o WHERE o.case_id = c.id AND o.seq > 0) AS options_updated_at,
        COALESCE((SELECT MAX(o.seq) FROM option_sets o WHERE o.case_id = c.id), 0) AS options_seq,
        (SELECT o.question FROM option_sets o WHERE o.case_id = c.id ORDER BY o.seq DESC LIMIT 1) AS options_question,
        (SELECT o.items_json FROM option_sets o WHERE o.case_id = c.id ORDER BY o.seq DESC LIMIT 1) AS latest_items_json,
        (SELECT o.sources_json FROM option_sets o WHERE o.case_id = c.id ORDER BY o.seq DESC LIMIT 1) AS latest_sources_json,
        (SELECT o.stage_json FROM option_sets o WHERE o.case_id = c.id AND o.stage_json IS NOT NULL ORDER BY o.seq DESC LIMIT 1) AS plan_stage_json,
        (SELECT COUNT(*) FROM option_sets o WHERE o.case_id = c.id AND o.stage_json IS NOT NULL) AS plan_rounds,
        (SELECT rv.kind FROM option_sets o JOIN revisions rv ON rv.case_id = o.case_id AND rv.n = o.revision
           WHERE o.case_id = c.id AND o.own_artifact = 1
             AND o.seq = (SELECT MAX(o2.seq) FROM option_sets o2 WHERE o2.case_id = c.id AND o2.stage_json IS NOT NULL)) AS plan_artifact_kind,
        (SELECT COUNT(DISTINCT r.plan_round) FROM replies r WHERE r.case_id = c.id AND r.plan_round IS NOT NULL
           AND r.intent = 'decision' AND r.state NOT IN ('failed', 'superseded')) AS plan_answered,
        (SELECT MIN(r.created_at) FROM replies r WHERE r.case_id = c.id) AS first_reply_submitted_at,
        (SELECT COUNT(*) FROM messages m WHERE m.case_id = c.id AND m.role = 'agent' AND m.working = 0
           AND m.created_at > (SELECT MIN(r.created_at) FROM replies r WHERE r.case_id = c.id)) AS update_count,
        (SELECT MAX(m.created_at) FROM messages m WHERE m.case_id = c.id AND m.role = 'agent' AND m.working = 0
           AND (c.done_at IS NOT NULL OR m.created_at > (SELECT MIN(r.created_at) FROM replies r WHERE r.case_id = c.id))) AS latest_update_at,
        (SELECT substr(m.text, 1, ${UPDATE_MESSAGE_PREVIEW_CHARS}) FROM messages m WHERE m.case_id = c.id AND m.role = 'agent' AND m.working = 0
           AND (c.done_at IS NOT NULL OR m.created_at > (SELECT MIN(r.created_at) FROM replies r WHERE r.case_id = c.id))
           ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS latest_update_message,
        (SELECT COUNT(*) FROM revisions r WHERE r.case_id = c.id AND r.author = 'agent') AS revision_count,
        (SELECT MAX(r.created_at) FROM revisions r WHERE r.case_id = c.id AND r.author = 'agent') AS latest_revision_at,
        CASE WHEN ls.state = 'disconnected' AND ls.last_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${SESSION_RECONNECT_GRACE_S} seconds') THEN 'live' ELSE ls.state END AS session_state,
        ls.can_nudge AS session_can_nudge,
        ls.client_name AS session_client_name,
        CASE WHEN ls.state = 'ended'
             THEN (SELECT MAX(e.at) FROM events e WHERE e.type = 'session.state_changed' AND e.session_id = ls.id) END AS session_ended_at,
        (SELECT m.text FROM messages m WHERE m.case_id = c.id AND m.role = 'agent' AND m.working = 1
           AND c.status <> 'resolved'
           AND m.rowid = (SELECT m2.rowid FROM messages m2 WHERE m2.case_id = c.id AND m2.role = 'agent'
                            ORDER BY m2.created_at DESC, m2.rowid DESC LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.case_id = c.id AND r.created_at >= m.created_at)) AS working_note,
        t.name AS task_name,
        t.project AS project,
        t.linear_key AS linear_key
      FROM cases c
      JOIN tasks t ON t.id = c.task_id
      LEFT JOIN replies lr ON lr.rowid =
        (SELECT r.rowid FROM replies r WHERE r.case_id = c.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1)
      LEFT JOIN sessions ls ON ls.rowid =
        (SELECT s.rowid FROM sessions s WHERE s.task_id = c.task_id OR s.id = t.owner_session_id ORDER BY s.connected_at DESC LIMIT 1)`;
}

// WAG-416: the field is there only when the ask matched past decisions, so a case with none serves the same bytes as before.
function matchedIdsField(json: string | null | undefined): { matched_case_ids?: string[] } {
  const ids = JSON.parse(json ?? "[]") as string[];
  return ids.length > 0 ? { matched_case_ids: ids } : {};
}

function rowToCase(row: CaseRow): Case {
  return {
    id: row.id,
    task_id: row.task_id,
    task_name: row.task_name,
    project: row.project,
    linear_key: row.linear_key,
    kind: row.kind,
    title: row.title,
    need: row.need,
    questions: JSON.parse(row.questions_json ?? "[]") as Case["questions"],
    // The items of the newest round: its own items_json, else the old columns read as items (spec 3.3).
    items: itemsOfRound(
      {
        seq: row.options_seq,
        items_json: row.latest_items_json ?? null,
        options_json: row.options_json,
        recommendation: row.recommendation,
        recommendation_why: row.recommendation_why,
        select_mode: row.select_mode,
        max_choices: row.max_choices,
        recommendations_json: row.recommendations_json,
      },
      row,
    ),
    ...(row.latest_sources_json ? { sources: parseSources(row.latest_sources_json) } : {}),
    why: row.why,
    recommendation: row.recommendation,
    recommendation_why: row.recommendation_why,
    select: row.select_mode,
    max: row.max_choices,
    recommendations:
      row.recommendations_json !== null ? (JSON.parse(row.recommendations_json) as string[]) : [row.recommendation],
    options: JSON.parse(row.options_json) as Case["options"],
    first_options: JSON.parse(row.first_options_json) as Case["options"],
    first_recommendation: row.first_recommendation,
    options_updated_at: row.options_updated_at,
    options_seq: row.options_seq,
    round_question: row.options_seq > 0 ? row.options_question : null,
    // Set 0 is the first set; NULL (no choice, or an older reply) reads as the newest.
    latest_reply_from_first_options:
      row.options_updated_at !== null && row.latest_reply_option_set_seq === 0,
    status: row.status,
    has_artifact: row.has_artifact === 1,
    artifact_kind: row.artifact_kind,
    latest_reply_id: row.latest_reply_id,
    latest_reply_state: row.latest_reply_state,
    latest_reply_at: row.latest_reply_at,
    latest_reply_delivered_at: row.latest_reply_delivered_at,
    latest_reply_apply_state:
      row.latest_reply_state !== "delivered"
        ? null
        : row.latest_reply_applied_at !== null
          ? "applied"
          : row.latest_reply_not_applied_at !== null
            ? "not_applied"
            : "pending",
    latest_reply_choice: row.latest_reply_choice,
    latest_reply_choices:
      row.latest_reply_choices_json !== null ? (JSON.parse(row.latest_reply_choices_json) as string[]) : [],
    latest_reply_answers: row.latest_reply_answers_json ? (JSON.parse(row.latest_reply_answers_json) as PointAnswer[]) : [],
    latest_reply_message: row.latest_reply_message,
    latest_reply_intent: row.latest_reply_intent,
    latest_reply_format: row.latest_reply_format,
    latest_reply_source: row.latest_reply_source,
    first_reply_submitted_at: row.first_reply_submitted_at,
    update_count: row.update_count,
    latest_update_at: row.latest_update_at,
    latest_update_message: row.latest_update_message,
    revision_count: row.revision_count,
    latest_revision_at: row.latest_revision_at,
    runtime: row.runtime,
    session_state: row.session_state,
    dismissed_at: row.dismissed_at,
    follows_case_id: row.follows_case_id,
    replaces_case_id: row.replaces_case_id,
    withdrawn_at: row.withdrawn_at,
    done_at: row.done_at,
    working_note: row.working_note ?? null,
    last_check_at: row.last_check_at,
    session_can_nudge: row.session_can_nudge === null ? null : row.session_can_nudge === 1,
    session_client_name: row.session_client_name ?? null,
    session_ended_at: row.session_ended_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...matchedIdsField(row.matched_case_ids_json),
    ...(row.auto_at != null && AskCategory.safeParse(row.auto_category).success
      ? {
          auto_decided: {
            category: row.auto_category as AskCategory,
            rule: row.auto_rule ?? "",
            choice: row.auto_choice ?? "",
            answer: row.auto_answer ?? "",
            at: row.auto_at,
          },
        }
      : {}),
    ...(row.plan_stage_json !== null
      ? {
          plan: {
            stage: JSON.parse(row.plan_stage_json) as PlanStage,
            rounds: row.plan_rounds,
            answered: row.plan_answered,
            ...(row.plan_artifact_kind !== null ? { artifact_kind: row.plan_artifact_kind } : {}),
          },
        }
      : {}),
  };
}

function rowToSessionInfo(row: SessionInfoRow): SessionInfo {
  return {
    id: row.id,
    task_id: row.task_id,
    runtime: row.runtime,
    task_name: row.task_name,
    project: row.project,
    branch: row.branch,
    cwd: row.cwd,
    pid: row.pid,
    can_nudge: row.can_nudge === 1,
    client_name: row.client_name ?? null,
    session_title: row.session_title ?? null,
    state: row.state,
    connected_at: row.connected_at,
    last_seen_at: row.last_seen_at,
  };
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    case_id: row.case_id,
    role: row.role,
    text: row.text,
    created_at: row.created_at,
    // Only a progress note carries the flag, so every other message keeps its old shape.
    ...(row.working === 1 ? { working: true } : {}),
  };
}

function rowToRevision(row: RevisionRow, round?: number): Revision {
  return {
    id: row.id,
    case_id: row.case_id,
    n: row.n,
    created_at: row.created_at,
    author: row.author,
    kind: row.kind,
    ...(round !== undefined ? { round } : {}),
    ...(row.artifact_name ? { name: row.artifact_name } : {}),
    ...(row.base_n !== null ? { base_revision: row.base_n } : {}),
    ...(row.passages_changed !== null ? { passages_changed: row.passages_changed } : {}),
  };
}

function rowToCapture(row: CaptureRow): Capture {
  return {
    id: row.id,
    revision: row.revision,
    png_base64: row.png_base64,
    annotated_png_base64: row.annotated_png_base64,
    taken_at: row.taken_at,
    ...(row.note !== null ? { note: row.note } : {}),
  };
}

function rowToComment(row: CommentRow): Comment {
  return {
    id: row.id,
    ...(row.capture_id !== null ? { capture_id: row.capture_id } : {}),
    n: row.n,
    ...(row.rect_json !== null ? { rect: JSON.parse(row.rect_json) as Comment["rect"] } : {}),
    ...(row.anchor_json !== null ? { anchor: JSON.parse(row.anchor_json) as Comment["anchor"] } : {}),
    text: row.text,
  };
}

// The wire form of a reply: captures keep their metadata, lose their images (PERF-2).
export function toReplySummary(reply: Reply): ReplySummary {
  return {
    ...reply,
    captures: reply.captures.map((c) => ({
      id: c.id,
      revision: c.revision,
      taken_at: c.taken_at,
      ...(c.note !== undefined ? { note: c.note } : {}),
      has_image: true as const,
    })),
  };
}

function replyEditOf(db: Database, row: ReplyRow): Reply["edit"] | undefined {
  if (row.edit_revision === null) return undefined;
  const rev = db
    .query(`SELECT base_n, passages_changed FROM revisions WHERE case_id = ? AND n = ?`)
    .get(row.case_id, row.edit_revision) as { base_n: number | null; passages_changed: number | null } | undefined;
  if (!rev || rev.base_n === null) return undefined;
  return { revision: row.edit_revision, base_revision: rev.base_n, passages_changed: rev.passages_changed ?? 0 };
}

// The option ids a round offers a discuss reply to lean on: a single item's own ids, or "<item id>/<option id>".
function offeredIds(items: Item[]): string[] {
  return items.length === 1 ? items[0]!.options.map((o) => o.id) : items.flatMap((i) => i.options.map((o) => `${i.id}/${o.id}`));
}

// The parts of a reply row that replyOutcome and normalizeReply read.
function replyLikeOf(r: {
  intent: ReplyIntent;
  choice: string | null;
  choices_json: string | null;
  answers_json?: string | null;
  item_answers_json?: string | null;
  message: string | null;
}): ReplyLike & { answers?: PointAnswer[]; item_answers?: ItemAnswer[] } {
  return {
    intent: r.intent,
    ...(r.message !== null ? { message: r.message } : {}),
    ...(r.choice !== null ? { choice: r.choice } : {}),
    ...(r.choices_json !== null ? { choices: JSON.parse(r.choices_json) as string[] } : {}),
    ...(r.answers_json ? { answers: JSON.parse(r.answers_json) as PointAnswer[] } : {}),
    ...(r.item_answers_json ? { item_answers: JSON.parse(r.item_answers_json) as ItemAnswer[] } : {}),
  };
}

// The items of one round of a case: the round `seq`, or the newest round when seq is null.
function itemsAtSeq(db: Database, caseId: string, seq: number | null): Item[] {
  const set = db
    .query(
      `SELECT seq, items_json, options_json, recommendation, recommendation_why, select_mode, max_choices, recommendations_json
       FROM option_sets WHERE case_id = ? ${seq !== null ? "AND seq = ?" : ""} ORDER BY seq DESC LIMIT 1`,
    )
    .get(...(seq !== null ? [caseId, seq] : [caseId])) as OptionSetItemsRow | undefined;
  if (!set) return [];
  const row = db.query(`SELECT questions_json FROM cases WHERE id = ?`).get(caseId) as { questions_json: string | null } | undefined;
  return itemsOfRound(set, row ?? {});
}

function rowToReply(db: Database, row: ReplyRow, withImages = true): Reply {
  const edit = replyEditOf(db, row);
  const seqRow = db.query(`SELECT seq FROM reply_option_sets WHERE reply_id = ?`).get(row.id) as { seq: number } | undefined;
  const items = itemsAtSeq(db, row.case_id, seqRow?.seq ?? null);
  const like = replyLikeOf(row);
  // Item answers come back only when the reply was sent with them; an old reply has its old fields.
  const itemAnswers = row.item_answers_json ? (JSON.parse(row.item_answers_json) as ItemAnswer[]) : [];
  // `withImages` false reads the capture rows without their base64 columns, so a
  // slim read never pulls megabytes out of SQLite just to drop them.
  const captures = db
    .query(
      withImages
        ? `SELECT * FROM captures WHERE reply_id = ? ORDER BY revision`
        : `SELECT id, case_id, revision, reply_id, '' AS png_base64, '' AS annotated_png_base64, taken_at, note
           FROM captures WHERE reply_id = ? ORDER BY revision`,
    )
    .all(row.id)
    .map((c) => rowToCapture(c as CaptureRow));
  const comments = db
    .query(`SELECT * FROM comments WHERE reply_id = ? ORDER BY n`)
    .all(row.id)
    .map((c) => rowToComment(c as CommentRow));
  return {
    id: row.id,
    case_id: row.case_id,
    idempotency_key: row.idempotency_key,
    ...(row.choice !== null ? { choice: row.choice } : {}),
    ...(row.choices_json !== null ? { choices: JSON.parse(row.choices_json) as string[] } : {}),
    ...(row.answers_json != null ? { answers: JSON.parse(row.answers_json) as PointAnswer[] } : {}),
    ...(itemAnswers.length > 0 ? { item_answers: itemAnswers } : {}),
    outcome: decideOrTalk({ items }, like),
    ...(row.message !== null ? { message: row.message } : {}),
    comments,
    captures,
    intent: row.intent,
    ...(row.leaning_json != null ? { leaning: JSON.parse(row.leaning_json) as string[] } : {}),
    ...(row.ruled_out_json != null ? { ruled_out: JSON.parse(row.ruled_out_json) as string[] } : {}),
    ...(row.format !== null ? { format: row.format } : {}),
    source: row.source,
    state: row.state,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    created_at: row.created_at,
    ...(row.replaced_at !== null ? { replaced_at: row.replaced_at } : {}),
    ...(row.delivered_at !== null ? { delivered_at: row.delivered_at } : {}),
    ...(row.state === "delivered"
      ? { apply_state: row.applied_at !== null ? "applied" : row.not_applied_at !== null ? "not_applied" : "pending" }
      : {}),
    ...(row.state === "delivered" && row.applied_at !== null ? { applied_at: row.applied_at } : {}),
    ...(edit !== undefined ? { edit } : {}),
    ...(row.attachments_json ? { attachments: JSON.parse(row.attachments_json) as ReplyAttachment[] } : {}),
  };
}

function rowToEvent(row: EventRow): Event {
  const event: Event = { type: row.type, at: row.at };
  if (row.case_id !== null) event.case_id = row.case_id;
  if (row.reply_id !== null) event.reply_id = row.reply_id;
  if (row.session_id !== null) event.session_id = row.session_id;
  return event;
}

// The MCP content array for a reply (docs/protocol-mvp.md "Reply payload"):
// one text block first, then one image block per capture that has comments.
// A short description of one reply's answer for the "already answered" note
// (HAIL-44, docs/protocol-mvp.md "replaces"): "a (Compact)" for a choice, the
// free-text message when there is one, or both together - the same choice/
// message rendering formatReplyContent uses for a normal reply payload, just
// condensed to one line instead of two.
function describeReplyAnswer(
  db: Database,
  caseRow: CaseRow,
  reply: ReplyRow,
  seq: number | null,
): string {
  const parts: string[] = [];
  if (reply.choices_json !== null) {
    const options = optionsForReply(db, caseRow, seq);
    const ids = JSON.parse(reply.choices_json) as string[];
    if (ids.length > 0) {
      parts.push(
        ids
          .map((id) => {
            const option = options.find((o) => o.id === id);
            return option ? `${id} (${option.label})` : id;
          })
          .join(", "),
      );
    }
  }
  if (reply.choice !== null) {
    const options = optionsForReply(db, caseRow, seq);
    const option = options.find((o) => o.id === reply.choice);
    parts.push(option ? `${reply.choice} (${option.label})` : reply.choice);
  }
  if (reply.message !== null && reply.message !== "") {
    parts.push(reply.message);
  }
  return parts.length > 0 ? parts.join("; ") : "(no message)";
}

// The options a reply's choice came from (HAIL-108): the stored set when the
// reply recorded one, else the case's newest set.
function optionsForReply(db: Database, caseRow: CaseRow, seq: number | null): Option[] {
  if (seq !== null) {
    const set = db
      .query(`SELECT options_json FROM option_sets WHERE case_id = ? AND seq = ?`)
      .get(caseRow.id, seq) as { options_json: string } | undefined;
    if (set) return JSON.parse(set.options_json) as Option[];
  }
  return JSON.parse(caseRow.options_json) as Option[];
}

// The one line a more_detail reply adds per chosen format (HAIL-139): what the
// agent must send back. The daemon is the only place that builds the reply
// payload, so these live here, not in the app.
export const DETAIL_FORMAT_LINES: Record<ReplyFormat, string> = {
  eli5: "Explain it again like I'm five: short sentences, everyday words, one concrete analogy, no jargon. " +
    "Then say in one line what the choice means for me. Send it with waggle_update as markdown.",
  diagram: "Explain it as a diagram: one Mermaid or SVG diagram of the flow or the parts, with short labels. " +
    "Send it with waggle_update as a diagram artifact (see waggle_guide artifacts); if diagram is not " +
    "available, as an html_bundle with an inline SVG.",
  page: "Explain it as a short interactive page: one self-contained html_bundle, offline, no external links " +
    "or fonts from the network. Send it with waggle_update.",
};

// The line a plan ask's reply ends with (HAIL-151): what to do next, so the agent keeps the one case.
export function planReplyHint(caseId: string, stage: PlanStage): string {
  const next =
    stage.name === "spec"
      ? "If the human approved the spec, go on to writing the implementation plan. If they asked for changes, " +
        "revise the spec and send it again with waggle_update (stage spec)."
      : "Send the next round with waggle_update on this case: a new stage, the new options and a " +
        "recommendation, and a new markdown artifact when the page changes. Then call waggle_check.";
  return `This is a Waggle plan ask (case ${caseId}, stage ${stage.name}). Do not ask in the terminal. ${next}`;
}

// WAG-285: a reply with a message and no choice, no choices and no answers, on an ask that offers options or
// points, is feedback on the page: the human wants changes before deciding. The case stays open.
export const FEEDBACK_REPLY_LINE =
  "The human wants changes to the page before deciding. They chose nothing. Revise the artifact or the text, " +
  "then send a new round with waggle_update on this case.";

export function isFeedbackReply(caseRow: CaseRow, reply: Reply, items?: Item[]): boolean {
  if (reply.intent !== "decision" || !reply.message) return false;
  // With the items of the round (spec 1.3): the one rule replyOutcome holds.
  if (items !== undefined) return decideOrTalk({ items }, reply) === "talk";
  if (reply.choice !== undefined || reply.choices !== undefined) return false;
  if (reply.answers !== undefined && reply.answers.length > 0) return false;
  if (reply.item_answers !== undefined && reply.item_answers.length > 0) return false;
  const questions = JSON.parse(caseRow.questions_json ?? "[]") as unknown[];
  const options = JSON.parse(caseRow.options_json ?? "[]") as unknown[];
  return questions.length > 0 || options.length > 0;
}

// WAG-353: a decision with one chosen option and text reads as "approve with changes". The text is changes
// the agent must apply. A "request changes" pick keeps its own meaning, so it is left out.
export const CHOICE_WITH_CHANGES_LINE =
  "The human chose this option WITH CHANGES. Apply the changes in the message below before you continue. " +
  "Do not ask for the same approval again.";

export function isChoiceWithChanges(reply: Reply): boolean {
  return (
    reply.intent === "decision" &&
    reply.choice !== undefined &&
    reply.choice !== "request_changes" &&
    reply.message !== undefined &&
    reply.message.trim() !== ""
  );
}

// WAG-301: what a discuss reply tells the agent last. The ask stays open.
export const DISCUSS_REPLY_LINE =
  "Answer the message, or revise the ask, with waggle_update on this case. You may drop the ruled-out " +
  "options or send new ones. The ask stays open. Then call waggle_check to wait for the decision.";

// WAG-301: the opening lines of a discuss reply: the human has not decided, then what they lean to and
// rule out, by option title. The message is added by the shared code after these lines.
function discussLines(reply: Reply, options: Option[], items?: Item[]): string[] {
  const titles = (ids: string[]): string =>
    ids
      .map((id) => {
        const option = options.find((o) => o.id === id);
        if (option) return option.title ?? option.label;
        // "<item id>/<option id>" on a request of several items.
        const slash = id.indexOf("/");
        const item = slash > 0 ? items?.find((i) => i.id === id.slice(0, slash)) : undefined;
        const picked = item?.options.find((o) => o.id === id.slice(slash + 1));
        return item && picked ? `${item.question ?? item.id}: ${picked.title ?? picked.label}` : id;
      })
      .join(", ");
  const lines = ["The human has not decided. They want to talk it over first."];
  if (reply.leaning && reply.leaning.length > 0) lines.push(`Leaning: ${titles(reply.leaning)}`);
  if (reply.ruled_out && reply.ruled_out.length > 0) lines.push(`Ruled out: ${titles(reply.ruled_out)}`);
  return lines;
}

// The "Answers:" block of a reply sent with item_answers to a request of several items (spec 2.5):
// "Item 2 (Which areas?): x, z · note: ...". A single-item reply keeps the old Choice lines.
function itemAnswerLines(items: Item[], answers: ItemAnswer[]): string[] {
  const lines = ["Answers:"];
  for (const a of answers) {
    const index = items.findIndex((i) => i.id === a.item_id);
    const item = items[index];
    const name = (id: string): string => {
      const option = item?.options.find((o) => o.id === id);
      return option ? `${id} (${option.title ?? option.label})` : id;
    };
    const picked = a.text !== undefined ? a.text : a.choices !== undefined ? a.choices.map(name).join(", ") || "none" : name(a.choice ?? "");
    const note = a.note && a.note.trim() !== "" ? ` · note: ${a.note.trim().replace(/\s+/g, " ")}` : "";
    const where = index < 0 ? a.item_id : `Item ${index + 1}${item?.question ? ` (${item.question})` : ""}`;
    lines.push(`${where}: ${picked}${note}`);
  }
  return lines;
}

// WAG-385: the one line a decision reply ends with, by the "After you decide" setting. "none" adds nothing.
export const AFTER_DECIDE_LINES: Record<AskAfterDecide, string | null> = {
  none: null,
  record:
    "Now write the decision record: call waggle_guide with topic decision-record for the template, write it " +
    "in the repo, then send it with waggle_update on this case (done: true, artifact named Decision record).",
  record_tasks:
    "Now write the decision record: call waggle_guide with topic decision-record for the template, write it " +
    "in the repo, then send it with waggle_update on this case (done: true, artifact named Decision record). " +
    "Then plan the tasks from the record: each task has acceptance criteria and names the record line it comes from.",
};

function formatReplyContent(
  caseRow: CaseRow,
  reply: Reply,
  options: Option[],
  editLines: string[] = [],
  items?: Item[],
  afterDecide: AskAfterDecide = "none",
): McpContent[] {
  if (reply.intent === "more_detail") {
    const lines: string[] = [];
    if (reply.format !== undefined) {
      // The chosen format sits between the fixed phrase and the human's own
      // question (HAIL-139): the phrase, then the format line, then the
      // question, then the same instruction as before.
      lines.push("The human wants more detail before deciding:");
      lines.push(DETAIL_FORMAT_LINES[reply.format]);
      if (reply.message) lines.push(reply.message);
    } else {
      // No format: exactly the pre-HAIL-139 payload, message inline.
      lines.push(`The human wants more detail before deciding:${reply.message ? ` ${reply.message}` : ""}`);
    }
    lines.push(
      "Reply by calling waggle_update on this case with an explanation and the most useful artifact " +
        "(markdown for reasoning, html_bundle for a prototype or a chart), then call waggle_check to " +
        "wait for the decision.",
    );
    return [{ type: "text", text: lines.join("\n") }];
  }
  const lines: string[] = [];
  lines.push(`Reply to "${caseRow.title}" (case ${reply.case_id})`);
  if (reply.intent === "discuss") lines.push(...discussLines(reply, options, items));
  if (isFeedbackReply(caseRow, reply, items)) lines.push(FEEDBACK_REPLY_LINE);
  const sent = reply.item_answers !== undefined && reply.item_answers.length > 0 ? reply.item_answers : undefined;
  const multi = sent !== undefined && items !== undefined && items.length > 1;
  if (reply.choices !== undefined && !multi) {
    // Multi-select (HAIL-123): the ids on one line, then one line per choice with its title.
    lines.push(`Choices: ${reply.choices.length > 0 ? reply.choices.join(", ") : "none"}`);
    for (const id of reply.choices) {
      const option = options.find((o) => o.id === id);
      lines.push(`- ${id}: ${option ? (option.title ?? option.label) : id}`);
    }
  }
  if (reply.choice !== undefined && !multi) {
    const option = options.find((o) => o.id === reply.choice);
    lines.push(`Choice: ${reply.choice}${option ? ` (${option.label})` : ""}`);
  }
  if (multi) lines.push(...itemAnswerLines(items!, sent!));
  else {
    lines.push(...answerLines(caseRow, reply));
    // A note on a single item has no old field: it follows the choice.
    for (const a of sent ?? []) if (a.note && a.note.trim() !== "") lines.push(`Note: ${a.note.trim().replace(/\s+/g, " ")}`);
  }
  // WAG-353: one chosen option plus text is "approve with changes". "Request changes" is not.
  if (isChoiceWithChanges(reply) && !multi) lines.push(CHOICE_WITH_CHANGES_LINE);
  if (reply.message) {
    lines.push(`Message: ${reply.message}`);
  }
  const images: McpContent[] = [];
  let captureNumber = 0;
  for (const capture of reply.captures) {
    const comments = reply.comments.filter((c) => c.anchor === undefined && c.capture_id === capture.id);
    if (comments.length === 0) continue;
    captureNumber += 1;
    // A screenshots artifact's capture carries its screen number and caption
    // in `note` (HAIL-40, set by the app's ReplyPayloadBuilder - each image is
    // its own capture); fall back to the plain revision/capture label every
    // other artifact kind has always used.
    lines.push(
      capture.note
        ? `Comments on ${capture.note}:`
        : `Comments on revision ${capture.revision}, capture ${captureNumber}:`,
    );
    for (const comment of comments) {
      const { x, y, w, h } = comment.rect!;
      lines.push(
        `[${comment.n}] (region x=${fmtRect(x)} y=${fmtRect(y)} w=${fmtRect(w)} h=${fmtRect(h)}) ${comment.text}`,
      );
    }
    images.push({ type: "image", data: capture.annotated_png_base64, mimeType: imageMimeType(capture.annotated_png_base64) });
  }
  // Text comments (HAIL-150): one block per revision, no image.
  const textRevisions = [
    ...new Set(reply.comments.flatMap((c) => (c.anchor?.kind === "text" ? [c.anchor.revision] : []))),
  ].sort((a, b) => a - b);
  for (const revision of textRevisions) {
    lines.push(`Comments on the explanation (v${revision}):`);
    for (const comment of reply.comments) {
      if (comment.anchor?.kind !== "text" || comment.anchor.revision !== revision) continue;
      lines.push(`[${comment.n}] "${trimQuote(comment.anchor.quote)}" - ${comment.text}`);
    }
  }
  // WAG-357: comments on the text of the request itself.
  const askComments = reply.comments.filter((c) => c.anchor?.kind === "ask_text");
  if (askComments.length > 0) {
    lines.push("Comments on the request:");
    for (const comment of askComments) {
      lines.push(`[${comment.n}] ${askCommentLine(comment.anchor as AskTextAnchor, options, items)}: ${comment.text}`);
    }
  }
  lines.push(...attachmentLines(reply.attachments));
  lines.push(...editLines);
  if (reply.intent === "discuss") lines.push(DISCUSS_REPLY_LINE);
  // A decision only: Keep talking (discuss) and a reply that chose nothing get no new line.
  const afterLine = reply.intent === "decision" && !isFeedbackReply(caseRow, reply, items) ? AFTER_DECIDE_LINES[afterDecide] : null;
  if (afterLine !== null) lines.push(afterLine);
  return [{ type: "text", text: lines.join("\n") }, ...images];
}

// WAG-345: "Attached: 2 files", then one "- name: path" line per file. An older shim prints this text as it is,
// so the agent still sees the paths.
export function attachmentLines(attachments: ReplyAttachment[] | undefined): string[] {
  if (attachments === undefined || attachments.length === 0) return [];
  const lines = [`Attached: ${attachments.length} ${attachments.length === 1 ? "file" : "files"}`];
  for (const a of attachments) lines.push(`- ${a.name}: ${a.path}`);
  return lines;
}

// One plain line per answered point: "Q3 · point 1: Card under the avatar · note: …". Numbers are the
// question's and the point's place in the request, counted from 1.
export function answerLines(caseRow: { questions_json?: string | null }, reply: { answers?: PointAnswer[] }): string[] {
  if (!reply.answers || reply.answers.length === 0) return [];
  const questions = JSON.parse(caseRow.questions_json ?? "[]") as Question[];
  const lines = ["Answers:"];
  for (const a of reply.answers) {
    const qi = questions.findIndex((q) => q.id === a.question_id);
    const pi = qi < 0 ? -1 : questions[qi]!.points.findIndex((p) => p.id === a.point_id);
    const where = qi < 0 || pi < 0 ? `${a.question_id} · ${a.point_id}` : `Q${qi + 1} · point ${pi + 1}`;
    const note = a.note && a.note.trim() !== "" ? ` · note: ${a.note.trim().replace(/\s+/g, " ")}` : "";
    lines.push(`${where}: ${a.choice}${note}`);
  }
  return lines;
}

// WAG-357: "On the title, "quoted words"". The part is in plain words. A pro, a con and a question name their
// option or item.
const ASK_PART_WORDS: Record<AskTextPart, string> = {
  title: "the title",
  need: "what I need",
  why: "the why",
  question: "the question",
  recommendation: "the recommendation",
  pro: "a pro",
  con: "a con",
  effect: "an effect",
  source: "a source",
};
export function askCommentLine(anchor: AskTextAnchor, options: Option[], items?: Item[]): string {
  let where = `On ${ASK_PART_WORDS[anchor.part]}`;
  const allOptions = [...options, ...(items ?? []).flatMap((i) => i.options)];
  if (anchor.part === "question" || anchor.part === "pro" || anchor.part === "con" || anchor.part === "effect") {
    const item = anchor.item_id !== undefined ? items?.find((i) => i.id === anchor.item_id) : undefined;
    const option = anchor.option_id !== undefined ? (item?.options ?? allOptions).find((o) => o.id === anchor.option_id) : undefined;
    const name = anchor.part === "question" ? (item?.question ?? undefined) : option ? (option.title ?? option.label) : undefined;
    if (name !== undefined && name.trim() !== "") where += ` of "${trimQuote(name)}"`;
  }
  return `${where}, "${trimQuote(anchor.quote)}"`;
}

// A long quote keeps its start and end and loses the middle (HAIL-150).
export const QUOTE_KEEP = 60;
export function trimQuote(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  if (flat.length <= QUOTE_KEEP * 2 + 3) return flat;
  return `${flat.slice(0, QUOTE_KEEP).trimEnd()}...${flat.slice(-QUOTE_KEEP).trimStart()}`;
}

// The app sends capture images as JPEG since captures got smaller on the wire;
// a reply stored before that, or from an older app, still holds PNG. The base64
// prefix tells them apart without decoding: JPEG bytes FF D8 FF encode as "/9j/".
export function imageMimeType(base64: string): "image/jpeg" | "image/png" {
  return base64.startsWith("/9j/") ? "image/jpeg" : "image/png";
}

function fmtRect(v: number): string {
  return String(Number(v.toFixed(2)));
}
