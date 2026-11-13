import { z } from "zod";
import { Source } from "./sources";
import {
  ArtifactKind,
  CaseStatus,
  ReplyApplyState,
  ReplyFormat,
  ReplyIntent,
  ReplyOutcome,
  ReplySource,
  ReplyStatus,
  Runtime,
  SessionState,
  AskCategory,
} from "./states";

// One choice the human can pick in reply to a case (docs/protocol-mvp.md
// "MCP tools", waggle_ask options).
const PointText = z.string().trim().min(1).max(160);
// Option card "Gist and facts" (docs/decisions/2026-11-10-option-card-gist-and-facts.md): a pro or con
// is a plain line, or { gist, detail }: a short version for the card and the full sentence one click
// away. Stored and served exactly as the agent sent it, so an old ask (strings only) is unchanged.
export const OPTION_GIST_MAX = 40;
export const OPTION_FACTS_MAX = 3;
export const OPTION_FACT_MAX = 24;
export const OptionPointObject = z.object({
  gist: z
    .string()
    .trim()
    .min(1, "a gist needs text")
    .max(OPTION_GIST_MAX, `a gist is at most ${OPTION_GIST_MAX} characters; put the full sentence in detail`),
  detail: PointText,
}).describe("gist: the short version on the card (at most 40 characters). detail: the full sentence (at most 160).");
export const OptionPoint = z.union([PointText, OptionPointObject], {
  error: "a pro or con is a string, or { gist, detail } with both set",
});
export type OptionPoint = z.infer<typeof OptionPoint>;
const OptionPoints = z.array(OptionPoint).max(5);
const OptionEffects = z.array(PointText).max(3);
// Short neutral facts, shown as chips under the option title ("~2 h", "no migration", "src/store.ts").
const OptionFacts = z
  .array(
    z
      .string()
      .trim()
      .min(1, "a fact needs text")
      .max(OPTION_FACT_MAX, `a fact is at most ${OPTION_FACT_MAX} characters, like "~2 h" or "no migration"`),
  )
  .max(OPTION_FACTS_MAX, `an option has at most ${OPTION_FACTS_MAX} facts`)
  .describe('Up to 3 short neutral facts shown as chips, at most 24 characters each: "~2 h", "no migration", "src/store.ts".');
export const Option = z.object({
  id: z.string(),
  // The full option text, shown in the ask's Decision section.
  label: z.string(),
  // A short title (1 to 6 words) for the answer box row. Optional: an older
  // agent sends only `label`, and the app derives a title from it.
  title: z.string().min(1).max(80).optional(),
  // WAG-276: reasons for and against this option, shown under it (same meaning as the pros and cons
  // of a point option, WAG-257). At most 5 each.
  pros: OptionPoints.optional(),
  cons: OptionPoints.optional(),
  // WAG-360: what picking this option causes (touches, closes, needs next). Neutral lines, not
  // judgements. At most 3, each 1 to 160 characters. Additive: an ask without it is unchanged.
  effects: OptionEffects.optional(),
  // Option card "Gist and facts": 0 to 3 short neutral facts, each at most 24 characters. Additive.
  facts: OptionFacts.optional(),
  // WAG-276: the `name` of an artifact on this case. Selecting the option switches to that tab.
  artifact_ref: z.string().trim().min(1).max(80).optional(),
  // WAG-276: an anchor inside that artifact (an element id or a data-waggle-anchor value). The app
  // posts it into the sandboxed page, then scrolls to and highlights the element.
  anchor: z.string().trim().min(1).max(120).optional(),
});
export type Option = z.infer<typeof Option>;

// HAIL-163: an artifact may carry its content instead of a path, for a client with no project folder
// (the Claude desktop app, Cowork). The shim writes the content into KNOCK_HOME/incoming/ and sends
// the daemon the staged path, so the daemon only ever sees paths. Same size limits as a path.
const INLINE_PNG_DESCRIPTION =
  "The image itself, base64 encoded (PNG or JPEG, no data: prefix), instead of a path. For clients " +
  "with no project folder. Same 20 MB limit as a file, but keep it small: the text goes through the chat.";

// One image of a screenshots artifact (HAIL-40): a path staged the same way
// as a single screenshot, plus an optional caption shown beside its thumbnail.
export const ScreenshotsItem = z
  .object({
    path: z.string().optional().describe("A path to a .png or .jpg file. Give this or data_base64."),
    data_base64: z.string().optional().describe(INLINE_PNG_DESCRIPTION),
    caption: z.string().optional(),
    item: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional()
      .describe(
        "The id of the decision item this image belongs to, in a request with several decisions. " +
          "Waggle shows only that decision's images while it is on screen. Skip it for an image every decision shares.",
      ),
  })
  .refine((v) => (v.path === undefined) !== (v.data_base64 === undefined), {
    message: "give exactly one of path or data_base64",
  });
export type ScreenshotsItem = z.infer<typeof ScreenshotsItem>;

// The size Waggle renders an html_bundle at when the agent declares one
// (HAIL-49): a phone is 390x844. Only meaningful without a `preview` - see
// `Artifact`'s html_bundle variant.
export const Viewport = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Viewport = z.infer<typeof Viewport>;

// An artifact the agent submits with a case. The shim resolves the path against
// the agent's cwd, copies it into KNOCK_HOME/incoming/<uuid>/ and sends the
// daemon that incoming path (HAIL-26). A screenshot is one image path; an
// html_bundle is a directory plus its relative entry file; a markdown artifact
// (HAIL-33) is one text file path, staged the same way as a screenshot; a
// screenshots artifact (HAIL-40) is 2 to 12 images, each staged the same way
// as a single screenshot, that the operator flips through and comments on one
// at a time.
//
// An html_bundle may also carry (HAIL-49), so the case pane's preview card has
// something better than a desktop-width screenshot to show:
// - `viewport`: the size Waggle renders the bundle at when there is no
//   `preview` - e.g. a phone at 390x844. Waggle falls back to rendering `entry`
//   at the card's own live size (amendment A1) when neither is given.
// - `preview`: a file inside the bundle, purpose-built for the card - a small
//   summary of the decision, never a screenshot of the page. `preview.html` (or
//   any name ending `.html`) renders at the card's own live size (amendment
//   A1: its measured width, 280 pt tall - not the earlier fixed 1200x630);
//   `preview.png`/`.jpg` shows scaled to the card's width. Same path rules as
//   `entry`: relative, no "..", no symlink, must resolve inside `dir`. Takes
//   priority over `viewport`.
//
// HAIL-163: markdown, screenshot, screenshots and html_bundle may carry their content instead of a
// path (`content`, `data_base64`, `html`). Paths work as before. Give one form, never both.
const exactlyOne = (message: string) => ({ message });
// WAG-276: a short name for an artifact (for example "Flow diagram"). Revisions that share a name
// are versions of one artifact; the app shows the newest in one tab. No name groups by kind.
const ArtifactName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .optional()
  .describe(
    'A short name for this artifact, e.g. "Flow diagram". Keep the same name for a new version. ' +
      'Never put a version number in the name (not "Flow diagram v2"). Revisions with the same name are versions ' +
      "of one artifact. A new name adds a tab. An option can point to it with artifact_ref.",
  );
export const Artifact = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("screenshot"),
      name: ArtifactName,
      path: z.string().optional().describe("A path to a .png or .jpg file. Give this or data_base64."),
      data_base64: z.string().optional().describe(INLINE_PNG_DESCRIPTION),
    })
    .refine((v) => (v.path === undefined) !== (v.data_base64 === undefined), exactlyOne("give exactly one of path or data_base64")),
  z
    .object({
    type: z.literal("html_bundle"),
    name: ArtifactName,
    dir: z.string().optional().describe("The bundle folder, relative to the project. Give dir and entry, or html."),
    entry: z.string().optional().describe("The HTML file inside dir. Give dir and entry, or html."),
    html: z
      .string()
      .optional()
      .describe(
        "One self-contained HTML page as a string (inline CSS and JS, no files, no network), instead of " +
          "dir and entry. For clients with no project folder. Same 50 MB limit as a bundle. " +
          "Take viewport but not preview.",
      ),
    viewport: Viewport.optional().describe(
      "Only used when there is no preview: the size Waggle renders the bundle at, e.g. " +
        "{ width: 390, height: 844 } for a phone. Defaults to rendering entry at the card's own size.",
    ),
    preview: z
      .string()
      .optional()
      .describe(
        "A file inside dir, purpose-built for the case pane's card: a small summary of the " +
          "decision (the question, the options side by side, the key number or visual) - never a " +
          "screenshot of the page. preview.html renders responsively to fill the card (500 to " +
          "1100 px wide, 280 px tall); preview.png/.jpg shows scaled to the card's width. Takes " +
          "priority over viewport. See waggle_guide's artifacts topic for a template.",
      ),
    })
    .superRefine((v, ctx) => {
      const hasPath = v.dir !== undefined || v.entry !== undefined;
      if (v.html !== undefined) {
        if (hasPath) ctx.addIssue({ code: "custom", message: "give html, or dir and entry, not both" });
        if (v.preview !== undefined) {
          ctx.addIssue({ code: "custom", message: "preview needs dir and entry: leave it out with html", path: ["preview"] });
        }
      } else if (v.dir === undefined || v.entry === undefined) {
        ctx.addIssue({ code: "custom", message: "give dir and entry, or html" });
      }
    }),
  z
    .object({
      type: z.literal("markdown"),
      name: ArtifactName,
      path: z.string().optional().describe("A path to a .md file. Give this or content."),
      content: z
        .string()
        .optional()
        .describe("The markdown text itself, instead of a path. For clients with no project folder. At most 1 MB."),
    })
    .refine((v) => (v.path === undefined) !== (v.content === undefined), exactlyOne("give exactly one of path or content")),
  z.object({ type: z.literal("screenshots"), name: ArtifactName, items: z.array(ScreenshotsItem).min(2).max(12) }),
  // A diagram (HAIL-141): one .mmd (Mermaid source) or .svg file, at most
  // 512 KB, rendered offline in the review viewer with zoom, pan and comments.
  z.object({ type: z.literal("diagram"), name: ArtifactName, path: z.string() }),
]);
export type Artifact = z.infer<typeof Artifact>;

// The stages of a plan ask (HAIL-151), in the order the brainstorming flow walks them.
export const PlanStageName = z.enum(["questions", "approaches", "design", "spec"]);
export type PlanStageName = z.infer<typeof PlanStageName>;

// Where one round of a plan ask sits. `step` counts from 1 inside the stage (question 3, design
// section 2); `total` is how many the stage has, and `total_is_estimate` marks it as a guess.
export const PlanStage = z.object({
  name: PlanStageName,
  step: z.number().int().min(1).optional(),
  total: z.number().int().min(1).optional(),
  total_is_estimate: z.boolean().optional(),
});
export type PlanStage = z.infer<typeof PlanStage>;

// What a Case carries when it is a plan ask: the newest round's stage, how many rounds there are
// and how many of them the human answered. Absent on every other case.
export const PlanInfo = z.object({
  stage: PlanStage,
  rounds: z.number().int().positive(),
  answered: z.number().int().nonnegative(),
  // The kind of artifact the newest round itself sent (HAIL-156), for the queue row. Absent when
  // the round sent none.
  artifact_kind: ArtifactKind.optional(),
});
export type PlanInfo = z.infer<typeof PlanInfo>;

// One round of a plan ask, for the "N answered" fold and the current round (CaseDetail.plan_rounds).
// `question` is the agent message that opened the round (the ask's need for round 1).
export const PlanRound = z.object({
  seq: z.number().int().nonnegative(),
  stage: PlanStage,
  question: z.string(),
  options: z.array(Option),
  recommendation: z.string(),
  recommendation_why: z.string(),
  created_at: z.string(),
  // The revision this round shows (HAIL-156): the one the round sent, else the newest one before it.
  // null when the plan had no artifact yet. `own_artifact` is true when the round itself sent one.
  revision: z.number().int().positive().nullable(),
  own_artifact: z.boolean(),
  artifact_kind: ArtifactKind.nullable(),
  // The human's decision for this round, or null while it is open.
  answer: z
    .object({
      choice: z.string().optional(),
      choices: z.array(z.string()).optional(),
      message: z.string().optional(),
      created_at: z.string(),
    })
    .nullable(),
});
export type PlanRound = z.infer<typeof PlanRound>;

// A rectangle in 0..1 coordinates of a capture. A value off the 0..1 range by 1e-6 or less is a float
// error (WAG-349: h = 1.0000000000000002), so it is clamped before the range check. A clearly wrong value still fails.
const RECT_EPSILON = 1e-6;
const rectCoordinate = z.preprocess(
  (v) => (typeof v === "number" && ((v < 0 && v >= -RECT_EPSILON) || (v > 1 && v <= 1 + RECT_EPSILON)) ? Math.min(1, Math.max(0, v)) : v),
  z.number().min(0).max(1),
);
export const Rect = z.object({
  x: rectCoordinate,
  y: rectCoordinate,
  w: rectCoordinate,
  h: rectCoordinate,
});
export type Rect = z.infer<typeof Rect>;

// A text anchor (HAIL-150): a range of a markdown revision's SOURCE. `start`/`end` are
// character offsets (UTF-16 code units, end exclusive) into that revision's markdown;
// `quote` is the exact source text between them.
export const TextAnchor = z.object({
  kind: z.literal("text"),
  revision: z.number().int().positive(),
  quote: z.string().min(1),
  start: z.number().int().min(0),
  end: z.number().int().positive(),
}).refine((a) => a.end > a.start, { message: "end must be greater than start" });
export type TextAnchor = z.infer<typeof TextAnchor>;

// WAG-357: an anchor in the text of the request itself (the title, the need, the why, an item's question,
// the recommendation, a pro or a con, a source). `quote` is the plain text shown, with markdown marks and
// [[s:id]] source markers removed. `start`/`end` are UTF-16 offsets into that plain text (end exclusive).
// The round is the newest round of the case when the reply is sent.
export const ASK_TEXT_PARTS = ["title", "need", "why", "question", "recommendation", "pro", "con", "effect", "source"] as const;
export const AskTextPart = z.enum(ASK_TEXT_PARTS);
export type AskTextPart = z.infer<typeof AskTextPart>;
export const AskTextAnchor = z.object({
  kind: z.literal("ask_text"),
  part: AskTextPart,
  item_id: z.string().min(1).optional(),
  option_id: z.string().min(1).optional(),
  source_id: z.string().min(1).optional(),
  quote: z.string().min(1),
  start: z.number().int().min(0),
  end: z.number().int().positive(),
}).refine((a) => a.end > a.start, { message: "end must be greater than start" });
export type AskTextAnchor = z.infer<typeof AskTextAnchor>;

// Either anchor kind. An old comment has the "text" kind and decodes as before.
export const CommentAnchor = z.union([TextAnchor, AskTextAnchor]);
export type CommentAnchor = z.infer<typeof CommentAnchor>;

// A comment anchored to a capture ("capture_id" + "rect") or, since HAIL-150, to a text range
// of a markdown revision ("anchor"). "n" counts from 1 in order, across both kinds.
export const Comment = z
  .object({
    id: z.string(),
    capture_id: z.string().optional(),
    n: z.number().int().positive(),
    rect: Rect.optional(),
    anchor: CommentAnchor.optional(),
    text: z.string(),
  })
  .refine(
    (c) => (c.anchor !== undefined ? c.capture_id === undefined && c.rect === undefined : c.capture_id !== undefined && c.rect !== undefined),
    { message: "a comment has either capture_id and rect, or a text anchor" },
  );
export type Comment = z.infer<typeof Comment>;

// A frozen image of one revision, taken in Comment mode.
export const Capture = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  png_base64: z.string(),
  annotated_png_base64: z.string(),
  taken_at: z.string(),
  note: z.string().optional(),
});
export type Capture = z.infer<typeof Capture>;

// What the app gets back for a capture (PERF-2): the metadata only. The two
// images are 1 to 5 MB of base64 each, so `cases.get` and the reply echoes
// leave them out and the app fetches one with `capture.image` when it shows it.
export const CaptureSummary = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  taken_at: z.string(),
  note: z.string().optional(),
  has_image: z.literal(true),
});
export type CaptureSummary = z.infer<typeof CaptureSummary>;

// A project is a tag: the git root folder name of a task's cwd.
export const Project = z.string();
export type Project = z.infer<typeof Project>;

// One agent run (in the MVP, one Claude Code session). Named from a Linear key
// in the branch, else the branch, else the cwd folder.
export const Task = z.object({
  id: z.string(),
  name: z.string(),
  project: Project,
});
export type Task = z.infer<typeof Task>;

// One immutable copy of a case's artifact. "n" starts at 1.
export const Revision = z.object({
  id: z.string(),
  case_id: z.string(),
  n: z.number().int().positive(),
  created_at: z.string(),
  // Who made it (HAIL-168): "agent" for every revision the agent sent, "you" for one the person
  // saved from an in-place edit.
  author: z.enum(["agent", "you"]),
  // WAG-276: the artifact's name, when the agent gave one.
  name: z.string().optional(),
  // WAG-276: what kind of artifact this revision holds.
  kind: ArtifactKind.optional(),
  // WAG-351: the seq of the round (option set) this revision belongs to: the newest round made at or
  // before the revision. An app that gets no field shows every artifact.
  round: z.number().int().nonnegative().optional(),
  // Only on a revision by "you": the revision the person started from, and how many passages
  // (groups of changed lines) the edit changed against it.
  base_revision: z.number().int().positive().optional(),
  passages_changed: z.number().int().nonnegative().optional(),
});
export type Revision = z.infer<typeof Revision>;

// The in-place edit a reply carries (HAIL-168). `revision` is the revision by "you" the edit made.
export const ReplyEdit = z.object({
  revision: z.number().int().positive(),
  base_revision: z.number().int().positive(),
  passages_changed: z.number().int().nonnegative(),
});
export type ReplyEdit = z.infer<typeof ReplyEdit>;

// An agent or human message in a case conversation.
export const Message = z.object({
  id: z.string(),
  case_id: z.string(),
  role: z.enum(["agent", "human"]),
  text: z.string(),
  created_at: z.string(),
  // true on a progress note (waggle_update with working: true). Absent on every other message.
  working: z.literal(true).optional(),
});
export type Message = z.infer<typeof Message>;

// A live shim session. The daemon marks it "live" while connected.
export const Session = z.object({
  id: z.string(),
  cwd: z.string(),
  branch: z.string().nullable(),
  pid: z.number().int().nonnegative(),
  state: SessionState,
  runtime: Runtime,
  connected_at: z.string(),
});
export type Session = z.infer<typeof Session>;

// One blocking question or review from a task (UI: "ask"). `task_name`,
// `project`, `linear_key`, `artifact_kind` and `latest_reply_*` are
// denormalized from the task, the latest revision and the latest reply, so
// `cases.list` alone can render a queue row (docs/protocol-mvp.md "Socket
// RPC") without a per-row `cases.get`. `runtime` is denormalized from the
// creating session (KNOCK-20): the connector the case's ask came from.
// A decision request can carry several questions, each with decision points the person answers inline
// and sends together. All of it is optional: a request with no `questions` works as before.
export const POINT_DEFAULT_CHOICES = ["Yes", "No", "Talk with the team"] as const;
export const QUESTIONS_MAX = 12;

export const PointOptionObject = z.object({
  label: z.string().trim().min(1).max(120),
  pros: OptionPoints.optional(),
  cons: OptionPoints.optional(),
  effects: OptionEffects.optional(),
  facts: OptionFacts.optional(),
});
export const PointOption = z.union([z.string().trim().min(1).max(120), PointOptionObject]);
export type PointOption = z.infer<typeof PointOption>;
// The label of an option, whether it is a string or an object.
export const pointOptionLabel = (o: PointOption): string => (typeof o === "string" ? o : o.label);

export const QuestionPoint = z.object({
  id: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(300),
  // The answers the person picks from. Leave out for Yes / No / Talk with the team. An option is a
  // string, or { label, pros?, cons? } to show the good and the bad of that answer.
  options: z.array(PointOption).min(2).max(8).optional(),
});
export type QuestionPoint = z.infer<typeof QuestionPoint>;

export const QuestionVariant = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(40),
});
export type QuestionVariant = z.infer<typeof QuestionVariant>;

export const Question = z.object({
  id: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(160),
  // How it works now: short lines, folded under the artifact.
  now: z.array(z.string().trim().min(1).max(300)).max(12).optional(),
  points: z.array(QuestionPoint).min(1).max(12),
  // Reserved. Every question shows the ask's own artifact today; Waggle ignores this field until an ask can carry more artifacts.
  artifact_ref: z.string().trim().min(1).max(80).optional(),
  // Variants of the artifact. Waggle opens an html_bundle at `#<question id>` and switches a variant by
  // setting `location.hash = "<question id>?variant=<variant id>"`. The first variant is the default.
  variants: z.array(QuestionVariant).min(2).max(8).optional(),
  // The label above the variant chips, for example "Where does the score sit".
  variant_label: z.string().trim().min(1).max(60).optional(),
});
export type Question = z.infer<typeof Question>;

export const Questions = z
  .array(Question)
  .min(1)
  .max(QUESTIONS_MAX)
  .superRefine((qs, ctx) => {
    const seen = new Set<string>();
    qs.forEach((q, i) => {
      if (seen.has(q.id)) ctx.addIssue({ code: "custom", message: `question id ${q.id} is used twice`, path: [i, "id"] });
      seen.add(q.id);
      const points = new Set<string>();
      q.points.forEach((p, j) => {
        if (points.has(p.id)) ctx.addIssue({ code: "custom", message: `point id ${p.id} is used twice in question ${q.id}`, path: [i, "points", j, "id"] });
        points.add(p.id);
        if (p.options && new Set(p.options.map(pointOptionLabel)).size !== p.options.length) {
          ctx.addIssue({ code: "custom", message: `point ${p.id} lists the same option twice`, path: [i, "points", j, "options"] });
        }
      });
      if (q.variants && new Set(q.variants.map((v) => v.id)).size !== q.variants.length) {
        ctx.addIssue({ code: "custom", message: `question ${q.id} lists the same variant id twice`, path: [i, "variants"] });
      }
    });
  });

// One answered point: the choice is the option text (or Yes, No, Talk with the team), the note is optional.
export const PointAnswer = z.object({
  question_id: z.string().min(1),
  point_id: z.string().min(1),
  choice: z.string().trim().min(1).max(200),
  note: z.string().trim().max(1000).optional(),
});
export type PointAnswer = z.infer<typeof PointAnswer>;
export const PointAnswers = z.array(PointAnswer).max(QUESTIONS_MAX * 12);

// --- Items (WAG-312, "three blocks") ---
//
// An Item is one decision inside an Ask. A request with one item shows as a single decision; with
// more it shows a step bar. Old shapes (options, questions, review, reply-only) normalise to items
// in protocol/items.ts. These are the stored and read shapes, so the limits on input (12 items, 40
// char ids, 2 to 12 options) are not enforced here: stored requests can break them (spec risk R4).
export const ITEMS_MAX = 12;
export const ItemSelect = z.enum(["one", "many", "reply"]);
export type ItemSelect = z.infer<typeof ItemSelect>;

// Items with the same group id share a heading, the "how it works now" lines and the artifact
// variants. It replaces the Question wrapper.
export const Group = z.object({
  id: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(160),
  now: z.array(z.string().trim().min(1).max(300)).max(12).optional(),
  variants: z.array(QuestionVariant).min(2).max(8).optional(),
  variant_label: z.string().trim().min(1).max(60).optional(),
});
export type Group = z.infer<typeof Group>;

export const Item = z.object({
  id: z.string().min(1),
  // What this item asks. Absent on a single item: the ask's need stands in.
  question: z.string().min(1).optional(),
  select: ItemSelect,
  // Only with select "many".
  max: z.number().int().min(1).optional(),
  // Empty with select "reply".
  options: z.array(Option),
  // One option id; a list with "many"; the suggested reply text with "reply".
  recommendation: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  recommendation_why: z.string().optional(),
  group: Group.optional(),
});
export type Item = z.infer<typeof Item>;

// One answered item of a reply (reply.submit item_answers). Give exactly one of choice (an option
// id), choices (option ids, with a "many" item) or text (a "reply" item). The note is optional.
export const ItemAnswer = z
  .object({
    item_id: z.string().min(1),
    choice: z.string().min(1).max(200).optional(),
    choices: z.array(z.string().min(1).max(200)).optional(),
    text: z.string().min(1).max(4000).optional(),
    note: z.string().trim().max(1000).optional(),
    // WAG-328: true when the person picked this choice themselves; false when it is only a pre-selected
    // recommendation. The daemon stores a false choice that equals the recommendation as Keep talking, and
    // never stores this field. Absent from an older app: the reply keeps today's rules.
    confirmed: z.boolean().optional(),
  })
  .refine((a) => [a.choice, a.choices, a.text].filter((v) => v !== undefined).length === 1, {
    message: "an item answer gives exactly one of choice, choices or text",
  });
export type ItemAnswer = z.infer<typeof ItemAnswer>;
export const ItemAnswers = z.array(ItemAnswer).max(QUESTIONS_MAX * 12);

// One Round of a case: an option_sets row that carries items (CaseDetail.rounds). It generalises PlanRound.
export const Round = z.object({
  seq: z.number().int().nonnegative(),
  stage: PlanStage.optional(),
  // The agent message that opened the round (the ask's need for round 0).
  question: z.string(),
  items: z.array(Item),
  created_at: z.string(),
  revision: z.number().int().positive().nullable(),
  own_artifact: z.boolean(),
  artifact_kind: ArtifactKind.nullable(),
  // The human's decision for this round, or null while it is open.
  answer: z
    .object({
      choice: z.string().optional(),
      choices: z.array(z.string()).optional(),
      item_answers: ItemAnswers.optional(),
      message: z.string().optional(),
      created_at: z.string(),
    })
    .nullable(),
  // How many Keep talking replies the round got.
  talk_count: z.number().int().nonnegative(),
  // WAG-354: the sources this round cites. Absent when it cites none.
  sources: z.array(Source).optional(),
});
export type Round = z.infer<typeof Round>;

// WAG-412: how a rule decided a case. `choice` is the option id the rule picked (the recommendation),
// `answer` its short title for the list. Absent from a case a person decided.
export const AutoDecided = z.object({
  category: AskCategory,
  rule: z.string(),
  choice: z.string(),
  answer: z.string(),
  at: z.string(),
});
export type AutoDecided = z.infer<typeof AutoDecided>;

export const Case = z.object({
  id: z.string(),
  task_id: z.string(),
  task_name: z.string(),
  project: Project,
  linear_key: z.string().nullable(),
  kind: z.enum(["question", "review"]),
  title: z.string(),
  need: z.string(),
  why: z.string(),
  recommendation: z.string(),
  recommendation_why: z.string(),
  // Multi-select (HAIL-123), of the newest option set. `recommendations` is the full recommended
  // list (`recommendation` is its first id). `max` is null when there is no limit.
  select: z.enum(["one", "many"]),
  max: z.number().int().nullable(),
  recommendations: z.array(z.string()),
  // The newest option set (HAIL-108): the ask's own, or the one the latest
  // waggle_update with options sent. `recommendation` belongs to the same set.
  options: z.array(Option),
  // The ask's own option set and recommendation. Equal to `options` and
  // `recommendation` until an update sends options. The app shows them folded
  // under "First options" once an update came.
  first_options: z.array(Option),
  first_recommendation: z.string(),
  // When the newest option set arrived with a waggle_update, or null while the
  // ask's own set is the newest.
  options_updated_at: z.string().nullable(),
  // HAIL-174: the newest option set's seq (0 = the ask's own) and, when seq > 0, the agent message
  // that brought it: the app reads the round's question from its first paragraph.
  options_seq: z.number().int().nonnegative().default(0),
  round_question: z.string().nullable().default(null),
  // True when the latest reply's choice is an id of the first set rather than
  // the newest one, so the app names the right option title.
  latest_reply_from_first_options: z.boolean(),
  status: CaseStatus,
  has_artifact: z.boolean(),
  artifact_kind: ArtifactKind.nullable(),
  // The case's most recent reply, or null when it has none yet.
  // `latest_reply_state` is `queued`/`delivered`/`failed` per
  // docs/protocol-mvp.md "Case and reply states"; a failed reply's Retry
  // needs `latest_reply_id` to survive an app relaunch, since the app never
  // fabricates a status it did not see over `cases.list`/`cases.get` or an
  // event.
  latest_reply_id: z.string().nullable(),
  latest_reply_state: ReplyStatus.nullable(),
  latest_reply_at: z.string().nullable(),
  // When the latest reply was marked delivered (the agent picked it up), or
  // null while it is queued, failed or absent (HAIL-64). The app moves an
  // answered ask to its "Answered" group 10 minutes after this.
  latest_reply_delivered_at: z.string().nullable(),
  // WAG-267: the apply step of a delivered latest reply; null for any other state. Optional on the
  // wire so an older daemon's list still parses.
  latest_reply_apply_state: ReplyApplyState.nullable().optional(),
  // The chosen option id and free-text message of the case's most recent
  // reply, denormalized the same way latest_reply_id/state/at are (HAIL-34):
  // the queue row's "you -> <label>" line needs these without a per-row
  // cases.get. Both null when the case has no reply yet, or when that reply
  // carries no choice/message.
  latest_reply_choice: z.string().nullable(),
  // The ids ticked in the latest reply to a select "many" ask (HAIL-123); empty otherwise.
  latest_reply_choices: z.array(z.string()),
  // The answers of the latest reply to a multi-question request; empty otherwise. Additive.
  latest_reply_answers: z.array(PointAnswer).default([]),
  // WAG-295: the answer body waggle_check hands the agent for the latest decision reply (the lines
  // after its "Reply to ..." header), so the app can copy a standalone answer without a second
  // formatter. Filled while that reply is queued or failed; null otherwise. Additive.
  latest_reply_answer_text: z.string().nullable().optional(),
  latest_reply_message: z.string().nullable(),
  // The intent of the case's most recent reply (HAIL-33), denormalized the
  // same way latest_reply_choice/message are: null only when the case has no
  // reply yet. Lets the queue and the pane show "Asked for more detail ..."
  // after a relaunch, without a per-row cases.get.
  latest_reply_intent: ReplyIntent.nullable(),
  // The format the latest reply asked for (HAIL-139), denormalized the same
  // way latest_reply_intent is: null when the case has no reply yet, or that
  // reply carried no format.
  latest_reply_format: ReplyFormat.nullable(),
  // Where the latest reply came from (HAIL-144), denormalized like latest_reply_intent: the queue
  // row shows "Answered from Telegram". Null when the case has no reply yet.
  latest_reply_source: ReplySource.nullable(),
  // The earliest reply's created_at across every round of this case
  // (HAIL-34): "took" = this minus created_at. Never moved by reply.replace
  // (same row, created_at untouched) or by a later round's own reply - it is
  // always the very first answer this case ever received. Null until the
  // case has a first reply.
  first_reply_submitted_at: z.string().nullable(),
  // Updates the agent sent after the human's first reply (HAIL-67, waggle_update):
  // the count of agent messages created after `first_reply_submitted_at`, the
  // newest one's time and its first 140 characters, and the number of
  // revisions. A message sent before any reply is not an update. The queue
  // row's "Updated" line and the ask pane's "Updated" block read these
  // without a per-row cases.get; the app shows them only while the case is
  // needs_you and `latest_update_at` is later than `latest_reply_at`.
  // The questions of a multi-question decision request (up to 12). Empty for every other case.
  questions: z.array(Question).default([]),
  update_count: z.number().int().nonnegative(),
  latest_update_at: z.string().nullable(),
  latest_update_message: z.string().nullable(),
  revision_count: z.number().int().nonnegative(),
  // When the newest revision was made (HAIL-68), so the app can tell a revision an
  // update added (after the reply) from one that existed before the reply.
  latest_revision_at: z.string().nullable(),
  runtime: Runtime,
  // The state of the case's owning session (HAIL-32), denormalized the same
  // way `runtime` is: null only for a case seeded directly without a session
  // row (tests, `waggle test-ask` before its own session.hello runs). The app
  // uses this to decide whether dismissing a `needs_you` case needs a
  // confirmation (a live agent may be blocked in `waggle_ask`/`waggle_check`).
  session_state: SessionState.nullable(),
  // Set by case.dismiss, cleared by case.restore (HAIL-32). Null for a case
  // that was never dismissed.
  dismissed_at: z.string().nullable(),
  // The earlier case this one follows up on (HAIL-33 amendment), or null. Set
  // only at creation (waggle_ask's `follows`); the daemon validates it names
  // an existing case from the same task before the case is created.
  follows_case_id: z.string().nullable(),
  // The earlier case this one replaces (HAIL-44), or null. Set only at
  // creation (waggle_ask's `replaces`), validated the same way `follows` is
  // (exists, same task). Creating a case with `replaces` withdraws the named
  // case in the same write (see `withdrawn_at`).
  replaces_case_id: z.string().nullable(),
  // Set when this case was withdrawn because a later waggle_ask replaced it
  // (HAIL-44): the case left needs_you/waiting_on_agent for resolved, the
  // same way case.dismiss's `dismissed_at` does, but for a different reason -
  // there is no restore for a withdrawn case. Null for a case that was never
  // replaced.
  withdrawn_at: z.string().nullable(),
  // Set when the agent closed the case with a waggle_update with `done: true` (HAIL-152): it has
  // finished and no answer will come. The case stays waiting_on_agent until the human taps Got it
  // (case.dismiss). Null otherwise. Old apps ignore the field.
  done_at: z.string().nullable(),
  // The text of the progress note the case shows (WAG-377): the agent's newest message was sent with
  // waggle_update `working: true` and the human has not replied since. Null once a real round, a
  // reply or a dismissal follows. Additive: old apps ignore it.
  working_note: z.string().nullable().optional(),
  // When the owning session last called waggle_check for this case (HAIL-170), or null before the
  // first check. Additive: old apps ignore it.
  last_check_at: z.string().nullable(),
  // The owning session's can_nudge (HAIL-170), or null when the case has no session row. The app
  // shows "Claude is not checking" only when this is false. Additive.
  session_can_nudge: z.boolean().nullable(),
  // The MCP client name of the owning session (HAIL-173), or null when unknown (an older shim, or no
  // session row). The app names the client from it: "Claude app", "Cowork" or "Claude Code". Additive.
  session_client_name: z.string().nullable(),
  // When the owning session ended (WAG-258): the time of its newest state change, set only while the session
  // is `ended`, else null. The app compares it with the reply time to say which came first. Additive.
  session_ended_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  // A plan ask (HAIL-151) is a "question" on the wire (`kind` keeps its two values, so an older
  // app shows it as a question) and carries this extra field. Absent on every other case.
  plan: PlanInfo.optional(),
  // WAG-312: the items of the newest Round, normalised from the old columns when the round has no
  // items of its own. Additive: absent from an older daemon.
  items: z.array(Item).optional(),
  // WAG-354: the sources the newest Round cites, each with its check result. Absent when it cites none.
  sources: z.array(Source).optional(),
  // WAG-412: set when the operator's "Ask less" rule decided this case. Absent otherwise. Additive.
  auto_decided: AutoDecided.optional(),
});
export type Case = z.infer<typeof Case>;

// One session as shown to a human (docs/protocol-mvp.md "Socket RPC",
// `sessions.list`, HAIL-46): the daemon's live-session projection for
// `waggle doctor` and the app's Connection screen, so a tester can see which
// agent sessions Waggle currently sees. `task_name`/`project` are the owning
// task's, the same denormalization `Case` already carries. `last_seen_at` is
// bumped on every state transition and on every session RPC call from an
// already-live session; for a row that predates this field, migration 13
// backfills it from `connected_at`.
// HAIL-134: what the Claude Code mod reports about its session, exactly. Held in
// memory by the daemon and fresh only while the mod keeps polling (docs/protocol-mvp.md
// "Claude Code mod"). No prompt text, only the tool's name.
export const LiveState = z.object({
  // "working": a turn is running. "idle": the last turn completed.
  phase: z.enum(["working", "idle"]),
  // When the current phase began (ISO).
  since: z.string(),
  // The last tool the mod saw, by name, and when. Null before any tool call.
  last_tool: z.string().nullable(),
  last_tool_at: z.string().nullable(),
  // Tool calls in the current turn.
  tool_count: z.number().int().nonnegative(),
  // The newest event the mod reported, and when.
  last_event: z.enum(["turn.start", "turn.complete", "prompt.submit", "tool.call"]),
  last_event_at: z.string(),
});
export type LiveState = z.infer<typeof LiveState>;

// HAIL-222: the git footprint of a session folder. The shim computes it inside the agent's process and
// sends it in session.hello. The daemon never runs git on a session cwd.
export const SessionChanges = z.object({
  files: z.number().int(),
  added: z.number().int(),
  removed: z.number().int(),
  clean: z.boolean(),
  last_commit: z.string().nullable(),
});
export type SessionChanges = z.infer<typeof SessionChanges>;

// What a live Claude Code session is working on (HAIL-72), read by the daemon
// from the session's transcript and from git. Every field can be missing.
// Agent text is already plain (markers stripped) and one line.
export const SessionContext = z.object({
  // Claude's own session title (the transcript's `ai-title` record).
  title: z.string().nullable(),
  // The first real user prompt, cleaned, up to 110 chars.
  goal: z.string().nullable(),
  // The first sentence of the agent's last message.
  said: z.string().nullable(),
  // The last action in plain words ("Ran fleet board"), and when it happened.
  last_action: z.string().nullable(),
  last_action_at: z.string().nullable(),
  // The last 3 actions in plain words, oldest first.
  recent: z.array(z.string()),
  // The last TodoWrite / task list.
  plan: z
    .object({ done: z.number().int(), total: z.number().int(), current: z.string().nullable() })
    .nullable(),
  // HAIL-124: the transcript is still being written (last write or last action
  // in the last 2 minutes). Absent from an older daemon.
  growing: z.boolean().optional(),
  // HAIL-134: exact state from the Claude Code mod, present only while it is
  // fresh. When present, `growing` follows it instead of the transcript.
  live: LiveState.nullable().optional(),
  // Git footprint of the session folder, as the shim reported it. `null` when it is not a repository.
  changes: SessionChanges.nullable(),
});
export type SessionContext = z.infer<typeof SessionContext>;



export const SessionInfo = z.object({
  id: z.string(),
  // The owning task (HAIL-59): matches `Case.task_id`, so the app can tell
  // which asks belong to which session.
  task_id: z.string(),
  runtime: Runtime,
  task_name: z.string(),
  project: Project,
  branch: z.string().nullable(),
  // The folder the session runs in (HAIL-59), for "Copy folder path".
  cwd: z.string(),
  // The shim's parent pid (the agent process), HAIL-76: the app walks up from it
  // to the terminal app for "Show the terminal".
  pid: z.number().int().nonnegative(),
  // HAIL-76: the shim can wake its session with a nudge. False for an older shim.
  can_nudge: z.boolean(),
  // HAIL-173: the MCP client name the shim reported (clientInfo.name), or null for an older shim.
  client_name: z.string().nullable(),
  state: SessionState,
  connected_at: z.string(),
  last_seen_at: z.string(),
  // HAIL-72: `null` or absent for Codex, or when no transcript is found.
  context: SessionContext.nullable().optional(),
  // WAG-279: the title the agent sent with waggle_ask or waggle_update (latest wins). Absent from an
  // older daemon. The app picks the shown title: this, else context.title, else context.goal.
  session_title: z.string().nullable().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

// The human's answer to a case. It carries an idempotency key so a retry never
// creates a second reply.
// WAG-345: a file the person attached to a reply. `path` is absolute, inside the daemon's data folder,
// and read-only. The agent reads the file there.
export const ReplyAttachment = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  type: z.string(),
});
export type ReplyAttachment = z.infer<typeof ReplyAttachment>;

// What the app sends for one attachment (reply.submit, reply.replace). A new file gives the path of
// its copy in KNOCK_HOME/incoming/. A file the queued reply already holds gives its stored `path`.
export const ReplyAttachmentInput = z.object({
  name: z.string(),
  incoming_path: z.string().optional(),
  path: z.string().optional(),
  type: z.string().optional(),
});
export type ReplyAttachmentInput = z.infer<typeof ReplyAttachmentInput>;

export const Reply = z.object({
  id: z.string(),
  case_id: z.string(),
  idempotency_key: z.string(),
  choice: z.string().optional(),
  // The option ids ticked in a reply to a select "many" ask (HAIL-123). Absent for a single
  // choice. May be empty when a message goes with it ("none of these").
  choices: z.array(z.string()).optional(),
  // The answers to the points of a multi-question request. Absent for every other reply.
  answers: PointAnswers.optional(),
  message: z.string().optional(),
  comments: z.array(Comment),
  captures: z.array(Capture),
  // "decision" (default) or "more_detail" (HAIL-33): what the reply is
  // answering. A more_detail reply carries no choice.
  intent: ReplyIntent,
  // A discuss reply (WAG-301): the option ids the human leans to and the ones they ruled out. Absent
  // for every other reply.
  leaning: z.array(z.string()).optional(),
  ruled_out: z.array(z.string()).optional(),
  // The format a more_detail reply asks for (HAIL-139): "eli5" | "diagram" |
  // "page". Absent for a decision reply, or a detail request with no format.
  format: ReplyFormat.optional(),
  // Where the reply came from (HAIL-144). Always set by the daemon; "mac" for a reply from the app.
  source: ReplySource,
  state: ReplyStatus,
  reason: z.string().optional(),
  created_at: z.string(),
  // Set by reply.replace (HAIL-34), on every replace while the reply is
  // still queued. `created_at` is never touched by a replace, so it keeps
  // meaning "first submitted at" for the "took" duration; this is when the
  // answer was last changed, shown as "changed HH:MM" beside it. Undefined
  // for a reply that has never been changed.
  replaced_at: z.string().optional(),
  // When the agent picked the reply up (HAIL-68); absent until then.
  delivered_at: z.string().optional(),
  // WAG-267: set only on a delivered reply. Absent for any other state, and from an older daemon.
  apply_state: ReplyApplyState.optional(),
  // When the session showed visible work after the delivery (apply_state "applied").
  applied_at: z.string().optional(),
  // The person's in-place edit of the document, when the reply carries one (HAIL-168).
  edit: ReplyEdit.optional(),
  // WAG-312: the item answers of a Decide reply (reply.submit item_answers). Absent for older replies.
  item_answers: ItemAnswers.optional(),
  // WAG-312: decide, or talk (keep talking). Set by the daemon on read from replyOutcome; not stored.
  outcome: ReplyOutcome.optional(),
  // WAG-345: the files the person attached. Absent when there are none, and from an older daemon.
  attachments: z.array(ReplyAttachment).optional(),
});
export type Reply = z.infer<typeof Reply>;

// A reply as the app sees it on the wire: same fields, captures without images.
export const ReplySummary = Reply.extend({ captures: z.array(CaptureSummary) });
export type ReplySummary = z.infer<typeof ReplySummary>;

// Full case view: the case, its task, messages, revisions, comments and replies.
export const CaseDetail = z.object({
  case: Case,
  task: Task,
  messages: z.array(Message),
  revisions: z.array(Revision),
  comments: z.array(Comment),
  replies: z.array(ReplySummary),
  // Every round of a plan ask, oldest first (HAIL-151). Absent on every other case.
  plan_rounds: z.array(PlanRound).optional(),
  // WAG-312: every Round that carries items, oldest first. Additive.
  rounds: z.array(Round).optional(),
});
export type CaseDetail = z.infer<typeof CaseDetail>;

// Result of the artifact.path RPC: absolute staged path of one revision. For a
// `screenshots` kind (HAIL-40), `root`/`entry` are empty and `items` carries
// the ordered, absolute blob paths and captions instead - there is no single
// path to return. For an `html_bundle`, `viewport`/`preview` (HAIL-49) carry
// the revision's own declared render size and card preview, when it has one -
// see `Artifact`'s html_bundle variant for what each means. `preview.path` is
// the absolute staged path of the preview file inside `root`; `preview.kind`
// is `html` for a `.html` file (Waggle renders it, like `entry`) or `image`
// for a `.png`/`.jpg` file (shown as is).
export const ArtifactPathResult = z.object({
  kind: ArtifactKind,
  root: z.string(),
  entry: z.string(),
  items: z.array(z.object({ path: z.string(), caption: z.string().optional(), item: z.string().optional() })).optional(),
  viewport: Viewport.optional(),
  preview: z.object({ kind: z.enum(["html", "image"]), path: z.string() }).optional(),
});
export type ArtifactPathResult = z.infer<typeof ArtifactPathResult>;

// Result of the service.status RPC. `exec_path` is the realpath of the running
// daemon's own binary, so the app can compare it with its bundled binary and
// replace a daemon that is not its own (HAIL-27).
export const ServiceStatus = z.object({
  version: z.string(),
  data_root: z.string(),
  sessions_live: z.number().int().nonnegative(),
  cases_open: z.number().int().nonnegative(),
  exec_path: z.string(),
});
export type ServiceStatus = z.infer<typeof ServiceStatus>;
