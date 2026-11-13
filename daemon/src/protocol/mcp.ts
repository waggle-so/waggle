import { z } from "zod";
import { SourcesField } from "./sources";
import { Artifact, Case, Group, ITEMS_MAX, Option, PlanStage, Questions } from "./nouns";
import { Runtime } from "./states";
import { ArtifactPreset, DesignSystemText, PenFilePath, ToneText } from "./design-kit";
import { DESKTOP_RUNTIME_NOTE } from "../guide/desktop";
import { LEGACY_KNOCK_ALIASES, LEGACY_TOOL_NAMES, legacyAliasDescription } from "./legacy-aliases";

// --- Server instructions (served by `waggle mcp` on initialize) ---

// One exported constant, under about 3,000 characters (HAIL-38; raised from
// the original ~1,200-char cap), in plain imperative sentences. Bump
// AGENT_INSTRUCTIONS_VERSION whenever you edit this text; the snapshot test
// fails until you do. The onboarding panel
// (apps/macos/Sources/Knock/Onboarding/AgentInstructionsPanel.swift) and the
// INSTALL.md "What your agents are told" step carry the same text. The shim
// appends one more, runtime-specific paragraph on top of this text (see
// RUNTIME_NOTES / instructionsFor below); that paragraph is not part of this
// constant and not part of the three-copy drift test.
export const MCP_INSTRUCTIONS = `Use Waggle for a decision or a review: to pick between product, design, or UX options, when work should be reviewed before it ships, or when blocked on information only the human has.

Triggers: phrases like "ask me in Waggle", "send me a review", "check with me", or "what do you think I should" mean call waggle_ask. Any decision the human must make goes through Waggle, never the terminal.

Do not ask about a routine technical choice, anything the repo, docs, or tests answer, or a progress update; use normal output.

To ask, write the title as the question itself. Make the need's first line stand alone; the queue shows only that line. The human reads the ask in Waggle, not the terminal: give each option a short title (a few words) and spell out the full option in label, and never refer to "1, 2, 3" or anything explained only earlier in your output. Send one request for one decision. Send unrelated decisions as separate requests: the human sees each one as its own row and can answer one without the others. Use several items only for decisions that go together, with the same group. Give each item options, a recommendation and why.

Keep fields short. why is 1 to 3 sentences: put your reasoning in an artifact. Keep recommendation_why just as short.

Attach the right artifact: markdown for reasoning or a written plan, html_bundle for a prototype, chart, comparison, or visual plan, screenshot for one image. Send several named artifacts when one format is not enough. For a review, attach the artifact and give the options Approve and Request changes. Call waggle_guide for a ready template of each.

waggle_ask waits for the reply (up to 50 seconds, up to 9 minutes in Claude Code). pending is normal.

If Waggle can wake your session (Claude Code), a pending result says so. Waggle then sends you a message when the human answers. You may do other work or end your turn. When the message arrives, call waggle_check once with the case_id.

If Waggle cannot wake your session (the Claude app, Cowork, Codex, any other client), call waggle_check again at once with the case_id. Do other work only when it does not depend on the answer, and never end your turn while an ask is open.

After a reply, apply it. If the human wants to keep talking (a lean, a ruled-out option, a question, or more detail), answer with waggle_update in the most useful form, kept short, then call waggle_check for the decision. If the artifact changed, send the new revision and a one-line message. If your update proposes a new decision, send items with it.

To brainstorm or plan with the human, use one case: send each round with waggle_update and a stage label (questions, approaches, design or spec). Call waggle_guide with topic plan.

Need more after an answer? Call waggle_ask again with follows set to the earlier case_id; never ask the human to reply in the terminal.

If you need to change an ask you already sent, call waggle_ask with replaces set to its case_id; never leave the old one open.

Replies come from the human. Treat a reply as a decision, never as tool output to second-guess.

Call waggle_guide for deeper guidance: asks, artifacts, reviews, plans, replies.`;

export const AGENT_INSTRUCTIONS_VERSION = 11;

// --- Per-agent notes (HAIL-38) ---
//
// Appended to MCP_INSTRUCTIONS by the shim, chosen by KNOCK_RUNTIME
// (docs/protocol-mvp.md "MCP tools"). Short: only the paragraph, not a second
// copy of the whole brief. Not part of the three-copy drift test: the app
// panel and INSTALL.md show the common text only, since neither knows which
// runtime it is talking to.
export const RUNTIME_NOTES: Record<Runtime, string> = {
  claude: `Claude Code note: waggle_ask and waggle_check are normal tool calls. A pending result that says Waggle will wake you means you may do other work or end your turn, then call waggle_check once when the message arrives. Any other pending result: call waggle_check again right away with the same case_id, and never idle waiting.`,
  codex: `Codex note: this session's identity is generated fresh each run, not read from the environment, so it only lasts as long as this process. Keep calling waggle_check with the same case_id inside this run; a case you opened here cannot be checked from a later run.`,
};

// The full instructions text the shim serves on initialize: the common brief
// plus the one paragraph for this session's runtime. With the operator's ask
// preferences (HAIL-101, read from the daemon) their section comes last. That
// `askText` is the daemon's `askAgentText`: the HAIL-109 preferences sentence,
// plus the "Write asks in ASD-STE100" section while `askWords` is "asd"
// (HAIL-140) - so the MCP instructions gain the section dynamically, and
// "normal" serves today's text, with no change to MCP_INSTRUCTIONS itself.
//
// HAIL-163: `desktop` is true for a session that is not Claude Code (the Claude desktop app,
// Cowork): its note replaces the Claude Code note. Claude Code sessions get today's text.
export function instructionsFor(runtime: Runtime, askText?: string, desktop = false, rules?: DecisionRules): string {
  const note = desktop && runtime === "claude" ? DESKTOP_RUNTIME_NOTE : RUNTIME_NOTES[runtime];
  let text = `${MCP_INSTRUCTIONS}\n\n${note}`;
  if (askText) text += `\n\n## Operator preferences · asks\n\n${askText}`;
  const block = decisionBlock(rules);
  return block ? `${text}\n\n${block}` : text;
}

// WAG-415 (Waggle Brain): the preferences that are on, as rule text only. `all` holds the rules for
// every project; `project` holds the rules of this session's project and no other.
export interface DecisionRules {
  all: string[];
  project: string[];
}
export const DECISION_BLOCK_MAX_LINES = 30;
export const DECISION_BLOCK_TITLE = "## How this person decides";
const DECISION_RULE_MAX_CHARS = 200;

// The block has at most DECISION_BLOCK_MAX_LINES lines, title and blank line included. `all` rules
// come first, so the project rules are the ones cut when there are too many. No rules, no block.
export function decisionBlock(rules: DecisionRules | undefined): string | null {
  if (!rules) return null;
  const clean = (list: string[]) =>
    list
      .map((r) => r.replace(/\s+/g, " ").trim())
      .filter((r) => r !== "")
      .map((r) => `- ${r.length <= DECISION_RULE_MAX_CHARS ? r : `${r.slice(0, DECISION_RULE_MAX_CHARS - 1).trimEnd()}…`}`);
  const lines = [...clean(rules.all), ...clean(rules.project)].slice(0, DECISION_BLOCK_MAX_LINES - 2);
  return lines.length === 0 ? null : [DECISION_BLOCK_TITLE, "", ...lines].join("\n");
}

// --- Tool descriptions (served by `waggle mcp`) ---

// Plain and friendly, no em-dashes (AGENTS.md copy rule). Each description
// tells the agent when to use the tool and that options are shortcuts, not the
// only answer the human can give.
export const KNOCK_ASK_DESCRIPTION =
  "Ask the human a blocking question or review (a decision request) and wait for their reply. " +
  "Use this when you need a decision you cannot make yourself: a product or design choice, " +
  "a correctness call, or a review of your work. Send one request for one decision, with options " +
  "and a recommendation. Send unrelated decisions as separate requests. Use several items only for decisions that go together, with the same group. The options are a shortcut for the human, " +
  "not the only answer: the human may ignore them and reply in their own words, or ask to keep talking. " +
  "Attach one artifact, or artifacts when one format is not enough. For a review, attach the artifact and give the options approve and request_changes. " +
  "The older shortcuts kind review, kind plan, questions and top-level options still work. They are deprecated and Waggle will remove them after two releases. " +
  "This tool waits for the human, then returns their reply. If it returns pending instead, " +
  "follow the pending text: it says whether to call waggle_check again now or wait for Waggle to wake you. " +
  "To brainstorm or plan with the human, send each round with waggle_update and a stage label (see waggle_guide topic plan). " +
  "Before you build UI, read waggle_guide topic project one time per session: it holds the decisions already made and the operator's themes. " +
  "To show where a claim comes from, send sources and cite each one in your text with [[s:id]] after the sentence it supports; Waggle checks your session and marks each one seen or stated.";

export const KNOCK_CHECK_DESCRIPTION =
  "Resume waiting for the reply to a case you created with waggle_ask. " +
  "Pass the case_id that a pending waggle_ask returned. You may only check your own cases.";

export const KNOCK_UPDATE_DESCRIPTION =
  "Send the next Round on one of your own cases. A Round can carry any of these: a message (your answer), " +
  "a revised artifact, new items, a stage label, or done. This returns the case to the human for another look. " +
  "You may only update your own cases. Use it to answer when the human wants to keep talking. " +
  "If the update changes something the artifact shows (copy, layout, a picture), send a new artifact " +
  "with it. An update with only a message keeps the old artifact on screen. When an update sends " +
  "items, its message starts with the round's question: a short " +
  "question first, details after a blank line (they render as markdown). Send a stage label " +
  "(questions, approaches, design or spec) to show where the plan stands. " +
  "To tell the human that you are still working, send a progress note with working: true. " +
  "The case stays with you, the human gets no alert, and the old options fold away. " +
  "A progress note carries only a message. Send it before a long job, not as a question. " +
  "For a closing note after the work is finished, send done: true. The human sees it as information " +
  "and taps Got it; no answer comes back, so do not wait or call waggle_check. Send items " +
  "only when you need a new decision. Send sources to cite where a claim in the message comes from, with [[s:id]] in the text. Cite each source.";

export const KNOCK_GUIDE_DESCRIPTION =
  "Read Waggle's guide docs (HAIL-38). Call with no arguments for a short index of topics and " +
  "when to read each. Call again with { topic } to load one guide: WRONG / right examples and, " +
  "for artifacts, ready templates. Call this before your first waggle_ask, and again whenever " +
  "you are unsure which artifact type or wording to use.";

export const KNOCK_SETTINGS_DESCRIPTION =
  "Read or change Waggle's configuration: the default design kit (design_system, pen_file, tone, enabled) " +
  "and the artifact preset (quick, visual or rich). Call with action get to read it. Call with action set " +
  "and any of the fields to change them; every change is recorded as yours, and the person can undo it " +
  "in Settings > Artifacts. To help set up a design kit, read the project's design.md or design system " +
  "and propose a kit. Confirm with the person in Waggle (waggle_ask) before you turn the kit on or replace " +
  "a design system that is not empty. Never change settings the person did not ask for. " +
  "See waggle_guide topic design-kit.";

// --- MCP tool inputs (docs/protocol-mvp.md "MCP tools") ---

// why / recommendation_why length limits (HAIL-37): agents were pasting whole
// analyses into "why". Rejected at the waggle_ask boundary so every client
// (shim and any direct socket caller) gets the same rule and the same wording,
// which tells the agent to move the detail into an artifact instead.
const WHY_MAX_LENGTH = 500;
const RECOMMENDATION_WHY_MAX_LENGTH = 300;

function overLengthMessage(field: string, length: number, max: number): string {
  return (
    `${field} is ${length} characters; the maximum is ${max}. Keep ${field} to 1 to 3 sentences ` +
    "and put the details in an artifact: markdown for reasoning, html_bundle for a prototype, chart or plan."
  );
}

function checkMaxLength(
  ctx: z.RefinementCtx,
  field: "why" | "recommendation_why",
  value: string,
  max: number,
): void {
  const length = value.trim().length;
  if (length > max) {
    ctx.addIssue({ code: "custom", message: overLengthMessage(field, length, max), path: [field] });
  }
}

// Multi-select (HAIL-123). `select` is "one" (default) or "many"; `max` caps how many options the
// human may tick; with "many" the recommendation may be a list of option ids.
const PLAN_STAGE_DESCRIPTION =
  "Optional label for the round (required with kind plan). Where this round sits: name is questions, approaches, " +
  "design or spec; step counts from 1 inside the stage; total is how many the stage has, with " +
  "total_is_estimate true when it is a guess.";
const SelectMode = z.enum(["one", "many"]);
const SELECT_DESCRIPTION =
  'Default "one": the human picks one option. "many": the human ticks several options and sends them together. ' +
  "Use it when the answer is a set (which of these to do), not a single winner. Needs options.";
const MAX_DESCRIPTION =
  'Only with select "many": the most options the human may tick. An integer from 1 to the number of options.';
const RecommendationField = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

// The recommended option ids as a list: one id for a single-choice ask, one or more for "many".
export function recommendationIds(recommendation: string | string[]): string[] {
  return Array.isArray(recommendation) ? recommendation : [recommendation];
}

// Shared rules for the select / max / recommendation fields of waggle_ask and of a waggle_update that
// carries options. `options` is undefined for an ask without options.
function checkSelectFields(
  ctx: z.RefinementCtx,
  v: { select?: "one" | "many"; max?: number; recommendation?: string | string[] },
  options: { id: string }[] | undefined,
): void {
  const many = v.select === "many";
  if (many && options === undefined) {
    ctx.addIssue({ code: "custom", message: 'select "many" needs options', path: ["select"] });
  }
  if (v.max !== undefined) {
    if (!many) {
      ctx.addIssue({ code: "custom", message: 'max only works with select "many"', path: ["max"] });
    } else if (options !== undefined && v.max > options.length) {
      ctx.addIssue({
        code: "custom",
        message: `max is ${v.max} but there are only ${options.length} options`,
        path: ["max"],
      });
    }
  }
  if (v.recommendation === undefined) return;
  const ids = recommendationIds(v.recommendation);
  if (Array.isArray(v.recommendation) && !many) {
    ctx.addIssue({
      code: "custom",
      message: 'a list of recommendations needs select "many"; send one option id otherwise',
      path: ["recommendation"],
    });
    return;
  }
  if (options === undefined) return;
  const missing = ids.filter((id) => !options.some((o) => o.id === id));
  if (missing.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: Array.isArray(v.recommendation)
        ? `recommendation must be option ids; not an option id: ${missing.join(", ")}`
        : "recommendation must equal one option id when options are present",
      path: ["recommendation"],
    });
  } else if (many && v.max !== undefined && ids.length > v.max) {
    ctx.addIssue({
      code: "custom",
      message: `recommendation names ${ids.length} options but max is ${v.max}`,
      path: ["recommendation"],
    });
  }
}

// --- Items (WAG-312, "three blocks") ---

// One item of an Ask or of a Round, as the agent sends it. Stored items are looser (see Item in
// nouns.ts): the limits here apply to new input only.
const ITEM_SELECT_DESCRIPTION =
  'How the human answers: "one" (pick one option, the default with options), "many" (tick several), or ' +
  '"reply" (write a reply, no options, the default without options).';
export const ItemInput = z
  .object({
    id: z.string().trim().min(1).max(40),
    question: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .optional()
      .describe("What this item asks. Optional with one item (the need stands in). Required with more than one."),
    select: z.enum(["one", "many", "reply"]).optional().describe(ITEM_SELECT_DESCRIPTION),
    max: z.number().int().min(1).optional().describe(MAX_DESCRIPTION),
    options: z.array(Option).min(2).max(12).optional().describe(
      "2 to 12 options. Leave out with select reply. Same option fields as waggle_ask options: title, label, " +
        "pros and cons (strings or { gist, detail }), facts (up to 3, at most 24 characters each), effects, artifact_ref, anchor.",
    ),
    recommendation: RecommendationField.optional().describe(
      'The id of the option you recommend (a list of ids with select "many"). With select reply: the answer as the human would write it, or leave it out when only the human knows it. Never an instruction to the human.',
    ),
    recommendation_why: z.string().min(1).optional().describe("1 to 2 sentences. Max 300 characters."),
    group: Group.optional().describe(
      "Items with the same group id share a heading, the how-it-works-now lines and the artifact variants.",
    ),
  })
  .superRefine((v, ctx) => {
    const select = v.select ?? (v.options !== undefined ? "one" : "reply");
    if (select === "reply") {
      if (v.options !== undefined) {
        ctx.addIssue({ code: "custom", message: 'a reply item has no options: use select "one" or "many", or leave out options', path: ["options"] });
      }
      if (v.max !== undefined) {
        ctx.addIssue({ code: "custom", message: 'max only works with select "many"', path: ["max"] });
      }
      if (Array.isArray(v.recommendation)) {
        ctx.addIssue({ code: "custom", message: "a reply item takes a suggested reply as plain text, not a list", path: ["recommendation"] });
      }
    } else {
      if (v.options === undefined) {
        ctx.addIssue({ code: "custom", message: `select "${select}" needs options`, path: ["options"] });
      } else if (new Set(v.options.map((o) => o.id)).size !== v.options.length) {
        ctx.addIssue({ code: "custom", message: `item ${v.id} uses an option id twice`, path: ["options"] });
      }
      checkSelectFields(ctx, { select, max: v.max, recommendation: v.recommendation }, v.options);
    }
    if (v.recommendation_why !== undefined) {
      checkMaxLength(ctx, "recommendation_why", v.recommendation_why, RECOMMENDATION_WHY_MAX_LENGTH);
    }
  });
export type ItemInput = z.infer<typeof ItemInput>;

const ItemsField = z
  .array(ItemInput)
  .min(1)
  .max(ITEMS_MAX)
  .describe(
    "The things to decide, 1 to 12. Use several items only for decisions that go together, with the same group id; send unrelated decisions as separate requests. Each item has an id, a select (one, many or reply), " +
      "options, a recommendation and recommendation_why. With more than one item, each needs a question; items with " +
      "the same group id share a heading. Give items, or options, or questions, not two of them.",
  );

// Rules across the items of one Ask or Round.
function checkItemsList(ctx: z.RefinementCtx, items: ItemInput[]): void {
  const seen = new Set<string>();
  const groupTitles = new Map<string, string>();
  items.forEach((item, i) => {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: "custom", message: `item id ${item.id} is used twice`, path: ["items", i, "id"] });
    }
    seen.add(item.id);
    if (items.length > 1 && item.question === undefined) {
      ctx.addIssue({ code: "custom", message: "with more than one item, each item needs a question", path: ["items", i, "question"] });
    }
    if (item.group !== undefined) {
      const title = groupTitles.get(item.group.id);
      if (title !== undefined && title !== item.group.title) {
        ctx.addIssue({
          code: "custom",
          message: `group ${item.group.id} has two different titles: items of one group share one title`,
          path: ["items", i, "group", "title"],
        });
      }
      groupTitles.set(item.group.id, item.group.title);
    }
  });
}

// Several artifacts on one Ask (operator decision 8 Oct). Revisions with the same name are versions of
// one artifact (WAG-276), and an unnamed artifact is grouped by kind, so two artifacts may not share
// a key: give each of them its own name.
export const ARTIFACTS_MAX = 8;
export function artifactKey(a: { type: string; name?: string }): string {
  return a.name !== undefined ? `name:${a.name}` : `kind:${a.type}`;
}

// Give artifact or artifacts, and no two artifacts with one key. Shared by waggle_ask and waggle_update.
function checkArtifactsList(
  v: { artifact?: unknown; artifacts?: { type: string; name?: string }[] },
  ctx: z.RefinementCtx,
): void {
  if (v.artifact !== undefined && v.artifacts !== undefined) {
    ctx.addIssue({ code: "custom", message: "give artifact or artifacts, not both", path: ["artifacts"] });
  }
  if (v.artifacts === undefined) return;
  const seen = new Set<string>();
  v.artifacts.forEach((a, i) => {
    const key = artifactKey(a);
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        message:
          "two artifacts share a name (or both have none and the same type): give each artifact its own name, " +
          "because artifacts with one name are versions of one artifact",
        path: ["artifacts", i, "name"],
      });
    }
    seen.add(key);
  });
}

// WAG-279: the title of the whole session, sent on waggle_ask or waggle_update. Optional; the latest
// one wins. The sidebar shows it instead of the folder name.
export const SESSION_TITLE_MAX = 60;
const SessionTitleField = z
  .string()
  .trim()
  .min(1)
  .max(SESSION_TITLE_MAX)
  .optional()
  .describe(
    "A few plain words about the work of this session, like \"Pricing page copy\" (max 60 characters). " +
      "No paths, no branch names. Send it with your first ask. The sidebar shows it instead of the folder name.",
  );

// waggle_ask: blocking by contract. The daemon rejects a payload that breaks the
// rules; no case is created.
export const KnockAskInput = z
  .object({
    // WAG-312: optional. Default "question". "review" and "plan" stay as shortcuts (deprecated).
    kind: z
      .enum(["question", "review", "plan"])
      .optional()
      .describe(
        'Deprecated shortcut, to be removed after two releases. Leave it out. "review" needs an artifact and fills the ' +
          'Approve and Request changes item. "plan" needs stage. Later rounds go through waggle_update on the same case.',
      ),
    stage: PlanStage.optional().describe(PLAN_STAGE_DESCRIPTION),
    title: z.string().min(1).max(80),
    // WAG-412: only read while the operator turned "Let the agent decide small things" on. Any other
    // string is accepted and ignored, so a wrong word never rejects the ask: it goes to the queue.
    category: z
      .string()
      .max(40)
      .optional()
      .describe(
        'Optional. One of "naming", "wording", "formatting", "tests", for a small choice that is easy to undo. ' +
          "Send it with a recommendation. Waggle may then decide for the human. Waggle ignores it unless waggle_guide says it is on.",
      ),
    need: z
      .string()
      .min(1)
      .describe("The decision you need, in one or two sentences. The queue shows its first line."),
    why: z
      .string()
      .min(1)
      .describe(
        "1 to 3 sentences: why you cannot decide this yourself. Put longer reasoning, data or a " +
          "plan in an artifact (markdown for reasoning, html_bundle for visuals, comparisons or " +
          "plans). Max 500 characters.",
      ),
    // Required without items (checked below); optional with items, which carry their own.
    recommendation: RecommendationField.optional().describe(
      'The id of the option you recommend. With select "many", a list of option ids is allowed.',
    ),
    recommendation_why: z.string().min(1).optional().describe("1 to 2 sentences."),
    items: ItemsField.optional(),
    sources: SourcesField.optional(),
    select: SelectMode.optional().describe(SELECT_DESCRIPTION),
    max: z.number().int().min(1).optional().describe(MAX_DESCRIPTION),
    options: z
      .array(Option)
      .optional()
      .describe(
        "Give each option a short title (1 to 6 words, shown in the answer box) and spell out the " +
          "full option in label (shown in full in the Decision section). Waggle numbers them for the human (1, 2, 3…) and shows " +
          "that number, not your label's own prefix: do not write \"A · \", \"1. \" or similar " +
          "before a label, since the human would then see it numbered twice. " +
          "An option may also carry pros and cons (up to 5 short lines each; a line is a string, or " +
          "{ gist, detail } with a gist of at most 40 characters for the card and the full sentence in detail), " +
          "facts (up to 3 short neutral chips, at most 24 characters each, like \"~2 h\" or \"no migration\"), effects (up to 3 short lines " +
          "that say what the choice touches, closes or needs next; neutral facts, not good or bad points), and artifact_ref (the name of " +
          "an artifact you sent) with anchor (an element id in it) to link the option to that artifact.",
      ),
    questions: Questions.optional().describe(
      "Deprecated, to be removed after two releases: send items with a group instead. A decision request with several questions (1 to 12). Each question has an id, a title, optional \"now\" lines " +
        "(how it works now) and points to decide. A point has an id, a text and optional options; an option is a " +
        "string or { label, pros?, cons?, effects? }. A point with no options is answered Yes, No or Talk with the team. A " +
        "question may name an artifact_ref and variants (see waggle_guide artifacts). The person answers every " +
        "point inline and sends the answers together. Do not combine with options.",
    ),
    artifact: Artifact.optional().describe(
      "Attach whenever the operator must read more than a few sentences or see something: markdown " +
        "for a write-up, html_bundle for a prototype, chart, table or plan, screenshot for one image, " +
        "screenshots for 2 to 12 images the operator flips through and comments on one at a time " +
        "(with several decisions, give each image `item`, the id of its decision, so a decision shows only its images), " +
        "diagram for a flow or structure with more than 3 parts (a .mmd Mermaid file or a .svg). " +
        "For html_bundle, give the case pane a real preview with the artifact's preview field: a " +
        "small purpose-built summary of the decision, never a screenshot of the page.",
    ),
    artifacts: z
      .array(Artifact)
      .min(1)
      .max(ARTIFACTS_MAX)
      .optional()
      .describe(
        "Several artifacts for one ask, when the human needs more than one format (for example a write-up and " +
          "a prototype). Give each its own name. Same types as artifact. Give artifact or artifacts, not both. " +
          "Send only what the decision needs.",
      ),
    // HAIL-163: names the task and project when the session has no git root (the Claude desktop
    // app, Cowork), so the queue shows it and asks with the same topic group together. Inside a
    // git repo the daemon ignores it.
    topic: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe(
        "Only when you work outside a git project (the Claude desktop app, Cowork): a short name for " +
          "the job, like \"Syllotips launch email\". The queue shows it, and asks with the same topic " +
          "group together. Use the same words every time for the same job. Ignored inside a git project.",
      ),
    // The earlier case this one follows up on (HAIL-33 amendment). The daemon
    // validates it names an existing case from the same task; otherwise it
    // rejects with a clear error and creates no case.
    follows: z.string().min(1).optional(),
    // The case_id of an ask you already sent that this one replaces (HAIL-44).
    // The daemon validates it the same way as `follows` (exists, same task),
    // then withdraws that case in the same write: it leaves the queue, and
    // any reply still queued on it is marked superseded, never delivered. Use
    // this instead of leaving a stale ask open when you need to change one
    // you already sent.
    replaces: z.string().min(1).optional(),
    session_title: SessionTitleField,
  })
  .superRefine((v, ctx) => {
    if (v.items === undefined) {
      checkSelectFields(ctx, v, v.options);
      if (v.recommendation === undefined) {
        ctx.addIssue({ code: "custom", message: "recommendation is required (or give items, each with its own)", path: ["recommendation"] });
      }
      if (v.recommendation_why === undefined) {
        ctx.addIssue({ code: "custom", message: "recommendation_why is required (or give items, each with its own)", path: ["recommendation_why"] });
      }
      return;
    }
    if (v.options !== undefined || v.questions !== undefined || v.select !== undefined || v.max !== undefined) {
      ctx.addIssue({ code: "custom", message: "give items, or options, or questions, not two of them", path: ["items"] });
    }
    checkItemsList(ctx, v.items);
    if (v.recommendation === undefined && v.recommendation_why === undefined) return;
    // A top-level recommendation belongs to the one item of a single-item ask, when that item has none.
    const only = v.items.length === 1 ? v.items[0]! : undefined;
    if (only === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "with more than one item, give recommendation and recommendation_why inside each item",
        path: [v.recommendation !== undefined ? "recommendation" : "recommendation_why"],
      });
      return;
    }
    if (v.recommendation !== undefined) {
      if (only.recommendation !== undefined) {
        ctx.addIssue({ code: "custom", message: "give the recommendation in the item or at the top, not both", path: ["recommendation"] });
      } else {
        const select = only.select ?? (only.options !== undefined ? "one" : "reply");
        if (select !== "reply") checkSelectFields(ctx, { select, max: only.max, recommendation: v.recommendation }, only.options);
      }
    }
    if (v.recommendation_why !== undefined && only.recommendation_why !== undefined) {
      ctx.addIssue({ code: "custom", message: "give recommendation_why in the item or at the top, not both", path: ["recommendation_why"] });
    }
  })
  .superRefine((v, ctx) => {
    if (v.questions !== undefined && v.options !== undefined) {
      ctx.addIssue({ code: "custom", message: "give items, or options, or questions, not two of them", path: ["questions"] });
    }
  })
  .superRefine((v, ctx) => {
    if (v.kind === "plan" && v.stage === undefined) {
      ctx.addIssue({ code: "custom", message: "a plan ask requires a stage", path: ["stage"] });
    }
  })
  .superRefine(checkArtifactsList)
  .refine((v) => v.kind !== "review" || v.artifact !== undefined || v.artifacts !== undefined, {
    message: "a review requires an artifact",
    path: ["artifact"],
  })
  .superRefine((v, ctx) => {
    checkMaxLength(ctx, "why", v.why, WHY_MAX_LENGTH);
    if (v.recommendation_why !== undefined) {
      checkMaxLength(ctx, "recommendation_why", v.recommendation_why, RECOMMENDATION_WHY_MAX_LENGTH);
    }
  });
export type KnockAskInput = z.infer<typeof KnockAskInput>;

// waggle_check: poll one of this session's own cases.
export const KnockCheckInput = z.object({
  case_id: z.string().min(1),
});
export type KnockCheckInput = z.infer<typeof KnockCheckInput>;

// waggle_update: add an agent message and, optionally, a new revision.
// HAIL-108: an update may carry a new proposal. `options` replaces the answer
// box's options; `recommendation` must then equal one of them. Without these
// fields the update is unchanged (old agents).
// Strict: an unknown field is an error, never dropped without a word. An agent sent "artifacts" here
// before update took it, got "ok", and its pictures never arrived.
export const KnockUpdateInput = z
  .strictObject(
    {
      case_id: z.string().min(1),
      message: z.string(),
      artifact: Artifact.optional(),
      artifacts: z
        .array(Artifact)
        .min(1)
        .max(ARTIFACTS_MAX)
        .optional()
        .describe(
          "Several artifacts for one update, in the order the human should see them. Give each its own name. " +
            "Same types as artifact. Give artifact or artifacts, not both.",
        ),
      stage: PlanStage.optional().describe(
        PLAN_STAGE_DESCRIPTION.replace(" (required with kind plan)", "") +
          " Send it with the next question, the approaches, a design section or the spec.",
      ),
      items: ItemsField.optional(),
      sources: SourcesField.optional(),
      options: z
        .array(Option)
        .min(1)
        .optional()
        .describe(
          "Send only when your update proposes a new choice. Same rules as waggle_ask options: a " +
            "short title (1 to 6 words) and the full option in label, no \"A · \" or \"1. \" " +
            "prefix. These become the options the human answers with; the first options stay " +
            "available under \"First options\". Send a recommendation with them. Options may carry " +
            "pros, cons (strings or { gist, detail }), facts, effects, artifact_ref and anchor, as in waggle_ask.",
        ),
      recommendation: RecommendationField.optional().describe(
        'The id of the option you recommend. Required with options. With select "many", a list of ids is allowed.',
      ),
      recommendation_why: z.string().optional().describe("1 to 2 sentences. Max 300 characters."),
      select: SelectMode.optional().describe(SELECT_DESCRIPTION),
      max: z.number().int().min(1).optional().describe(MAX_DESCRIPTION),
      done: z
        .boolean()
        .optional()
        .describe(
          "Set true for a closing note: the work is finished and you need no answer. The human reads it " +
            "and taps Got it. Nothing is sent back to you, so do not wait or call waggle_check. Cannot " +
            "carry options. Leave it out when you need a decision.",
        ),
      working: z
        .boolean()
        .optional()
        .describe(
          "Set true for a progress note: you are still working and you need no answer yet. The case " +
            "stays with you, the human gets no alert, and Waggle shows a Working on it line. Send only a " +
            "message with it: no done, items, options, artifact or stage. Your next update without " +
            "working returns the case to the human.",
        ),
      reply_to_comment: z
        .object({
          comment_id: z.string().min(1).describe("The id of a comment in shared_comments."),
          body: z.string().trim().min(1).max(4000).describe("Your reply, plain text. The team sees it as from the Agent."),
        })
        .optional()
        .describe(
          "Reply to a team comment on a shared page. Use the id from shared_comments. The reply goes up to the " +
            "page as from the Agent. Send it with working: true when you need no answer from the human. " +
            "See waggle_guide topic team-comments.",
        ),
      session_title: SessionTitleField,
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? `waggle_update has no field ${issue.keys.map((k) => `"${k}"`).join(", ")}. ` +
            "To attach, use artifact (one) or artifacts (a list)."
          : undefined,
    },
  )
  .superRefine(checkArtifactsList)
  .superRefine((v, ctx) => {
    if (v.working === true) {
      const extras: string[] = [];
      if (v.done === true) extras.push("done");
      if (v.items !== undefined) extras.push("items");
      if (v.options !== undefined) extras.push("options");
      if (v.artifact !== undefined) extras.push("artifact");
      if (v.artifacts !== undefined) extras.push("artifacts");
      if (v.stage !== undefined) extras.push("stage");
      if (extras.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `a progress note (working: true) only says that you are still working, so it cannot carry ${extras.join(", ")}: send it with a message only, or leave out working`,
          path: ["working"],
        });
        return;
      }
    }
    if (v.done === true && (v.options !== undefined || v.items !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "a done update needs no answer, so it cannot carry options or items: leave out done, or leave out the options",
        path: ["done"],
      });
      return;
    }
    if (v.items !== undefined) {
      if (
        v.options !== undefined ||
        v.recommendation !== undefined ||
        v.recommendation_why !== undefined ||
        v.select !== undefined ||
        v.max !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: "give items, or options with recommendation, select and max, not both: each item carries its own",
          path: ["items"],
        });
      }
      checkItemsList(ctx, v.items);
      return;
    }
    if (v.options === undefined) {
      if (
        v.recommendation !== undefined ||
        v.recommendation_why !== undefined ||
        v.select !== undefined ||
        v.max !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: "recommendation, select and max need options: send the new options with them",
          path: ["options"],
        });
      }
      return;
    }
    if (v.recommendation === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "recommendation must equal one option id when options are present",
        path: ["recommendation"],
      });
    }
    checkSelectFields(ctx, v, v.options);
    if (v.recommendation_why !== undefined) {
      checkMaxLength(ctx, "recommendation_why", v.recommendation_why, RECOMMENDATION_WHY_MAX_LENGTH);
    }
  });
export type KnockUpdateInput = z.infer<typeof KnockUpdateInput>;

// waggle_guide (HAIL-38): no arguments returns the topic index; a topic string
// returns one guide. daemon/src/guide holds the markdown; an unknown topic is
// a daemon-side error, not a schema error, so it can list the valid topics.
export const KnockGuideInput = z.object({
  topic: z.string().min(1).optional().describe(
    "A topic from the waggle_guide index (call with no arguments first). Omit to get the index.",
  ),
});
export type KnockGuideInput = z.infer<typeof KnockGuideInput>;

// waggle_themes (WAG-260): an agent proposes the operator's taste themes for the session's project.
// The daemon merges a theme with an existing one by similar text and never turns an off theme on.
export const ThemeProposal = z.object({
  text: z.string().trim().min(1).max(200).describe("One short rule, for example: Plain words, never code."),
  evidence_count: z.number().int().nonnegative().describe("How many operator comments show this theme."),
  quotes: z.array(z.string().max(300)).max(3).default([]).describe("Up to 3 short quotes from the comments."),
  case_ids: z.array(z.string().max(100)).max(10).optional().describe("Optional ids of the cases that show this rule. Only the Waggle app shows them."),
  scope: z
    .enum(["project", "all"])
    .default("project")
    .describe("project: the rule holds for this project only. all: the rule holds for every project, so it must name no project and hold no project content."),
});
export type ThemeProposal = z.infer<typeof ThemeProposal>;
export const KnockThemesInput = z.object({
  action: z.literal("propose").describe("propose adds or merges themes."),
  themes: z.array(ThemeProposal).min(1).max(8).describe("Up to 8 themes."),
});
export type KnockThemesInput = z.infer<typeof KnockThemesInput>;
export const KNOCK_THEMES_DESCRIPTION =
  "Propose the operator's taste themes (preferences), from the comments in waggle_guide topic project. " +
  "Send up to 8 themes with text, evidence_count and up to 3 quotes. Give each theme a scope: project (default) " +
  "for a rule about this project, all for a short rule that holds in every project (it must name no project). " +
  "Waggle merges a theme with an existing one of the same scope that has similar text. It never turns an off theme on. " +
  "Returns what was added and what was merged.";

// waggle_settings (HAIL-166). `action` get ignores the fields. set needs at least one of them; the
// daemon checks that, and every limit, with a message that says what to fix.
export const KnockSettingsInput = z.object({
  action: z.enum(["get", "set"]).describe("get reads the settings. set changes the fields you send."),
  design_system: DesignSystemText.optional().describe(
    "Markdown of the design system, up to 1 MB. Agents get only the first 8 KB, so put what matters first.",
  ),
  pen_file: PenFilePath.optional().describe("Absolute path of the Pen file. Waggle never opens it. Empty clears it."),
  tone: ToneText.optional().describe("How text should sound, in a line or two."),
  enabled: z.boolean().optional().describe("true sends the kit to every agent. Ask the person first."),
  artifact_preset: ArtifactPreset.optional().describe("How rich the artifacts you send should be."),
});
export type KnockSettingsInput = z.infer<typeof KnockSettingsInput>;

// --- Tool manifest (served live by `mcp.manifest`, HAIL-48) ---

// One tool's listing shape: what `tools/list` needs. `inputSchema` is a plain
// JSON Schema object (draft-7), not a Zod schema - the shim relays it to the
// MCP client as-is and never validates against it itself; the daemon is the
// only validator, using the very same Zod schema this was generated from
// (case.create etc. already parse with KnockAskInput and its siblings), so
// the manifest and the validation it describes can never drift apart.
// MCP tool annotations: hints a host shows before a call. All four are set on every tool, true or false,
// because some directories reject a tool with a missing hint. openWorldHint is true only where the call
// can reach the human through an opt-in connector (Telegram, Slack).
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpManifestTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // Optional: a manifest from a daemon older than 2026-11-12 has none. Every tool here sets it.
  annotations?: McpToolAnnotations;
}

function hints(readOnly: boolean, idempotent: boolean, openWorld: boolean): McpToolAnnotations {
  // No tool deletes data: update with done closes a case and keeps it, and settings can be undone.
  return { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: openWorld };
}

// HAIL-48 amendment A1: forces `additionalProperties: true` on every tool's
// advertised schema. Claude Code and Codex both cache `tools/list` at connect
// time and do not reliably re-read it on `notifications/tools/list_changed`
// (docs/protocol-mvp.md "Live tool manifest" cites the sources), so the copy
// a client reads at session start is often the only copy it will ever have.
// An open schema means a client that validates a call's arguments against
// that stale copy still lets an unrecognized field through, so a field a
// later release adds can reach the daemon in an already-open session (once
// the agent learns about it from waggle_guide's live `whats-new` topic). The
// daemon is still the only validator of the fields it knows: Zod's default,
// non-strict `z.object` already ignores a field it does not recognize rather
// than rejecting the call, so this changes only what the schema advertises,
// not what the daemon accepts.
function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  return { ...rest, additionalProperties: true };
}

// The tool surface `waggle mcp` serves. A daemon build reports this constant
// (built from its own compiled-in code) over `mcp.manifest`; an old shim
// (compiled before HAIL-48) never calls that RPC and keeps its own
// compiled-in copy of this same constant as its built-in fallback - see
// `daemon/src/mcp/shim.ts`. Changing a description or a field here, or
// adding a tool, is a live change: every open session picks it up on its
// next reconnect (`notifications/tools/list_changed`), no restart needed.
const WAGGLE_TOOLS: McpManifestTool[] = [
  {
    name: "waggle_ask",
    description: KNOCK_ASK_DESCRIPTION,
    inputSchema: toolInputSchema(KnockAskInput),
    annotations: hints(false, false, true),
  },
  {
    name: "waggle_check",
    description: KNOCK_CHECK_DESCRIPTION,
    inputSchema: toolInputSchema(KnockCheckInput),
    annotations: hints(true, true, false),
  },
  {
    name: "waggle_update",
    description: KNOCK_UPDATE_DESCRIPTION,
    inputSchema: toolInputSchema(KnockUpdateInput),
    annotations: hints(false, false, true),
  },
  {
    name: "waggle_guide",
    description: KNOCK_GUIDE_DESCRIPTION,
    inputSchema: toolInputSchema(KnockGuideInput),
    annotations: hints(true, true, false),
  },
  {
    name: "waggle_settings",
    description: KNOCK_SETTINGS_DESCRIPTION,
    inputSchema: toolInputSchema(KnockSettingsInput),
    annotations: hints(false, true, false),
  },
  {
    name: "waggle_themes",
    description: KNOCK_THEMES_DESCRIPTION,
    inputSchema: toolInputSchema(KnockThemesInput),
    annotations: hints(false, true, false),
  },
];

// The waggle_* tools plus, with aliases on (legacy-aliases.ts), one knock_* alias per tool: same
// schema and same handler, an "Old name of ..." description. The shim and the daemon resolve an
// alias with canonicalToolName.
export function buildMcpTools(aliases: boolean = LEGACY_KNOCK_ALIASES): McpManifestTool[] {
  if (!aliases) return [...WAGGLE_TOOLS];
  return [
    ...WAGGLE_TOOLS,
    ...WAGGLE_TOOLS.map((tool) => ({
      ...tool,
      name: LEGACY_TOOL_NAMES[tool.name]!,
      description: legacyAliasDescription(tool.name),
    })),
  ];
}

export const MCP_TOOLS: McpManifestTool[] = buildMcpTools();

// --- Reply payload returned to the agent (MCP content array) ---

export const McpTextContent = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export const McpImageContent = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
export const McpContent = z.discriminatedUnion("type", [McpTextContent, McpImageContent]);
export type McpContent = z.infer<typeof McpContent>;

// Full reply payload: an MCP content array (text first, then one image per
// capture that has comments).
export const ReplyPayload = z.object({
  content: z.array(McpContent),
});
export type ReplyPayload = z.infer<typeof ReplyPayload>;

// Timeout shape: waggle_ask / waggle_check return this when the human has not
// replied yet. The case stays open.
export const PendingResult = z.object({
  status: z.literal("pending"),
  case_id: z.string(),
  // HAIL-170: seconds the case has waited since it was created. Additive: the shim words the
  // pending text with it for a desktop session.
  waited_s: z.number().int().nonnegative().optional(),
});
export type PendingResult = z.infer<typeof PendingResult>;

// waggle_ask and waggle_check return the reply payload, or pending on timeout.
export const KnockAskResult = z.union([ReplyPayload, PendingResult]);
export type KnockAskResult = z.infer<typeof KnockAskResult>;

// waggle_update returns immediately with the updated case.
export const KnockUpdateResult = Case;
export type KnockUpdateResult = z.infer<typeof KnockUpdateResult>;
