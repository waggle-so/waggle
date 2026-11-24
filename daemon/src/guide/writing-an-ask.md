# Writing an ask

Every waggle_ask needs a title, a need, a short why, and items. Each item holds one decision, its
options and a recommendation with its own short why. Add artifacts when the human needs to see
something. One ask with one item is the usual case.

## Title: write it as the question itself

The queue shows the title. A human should know what you are asking before they open the case.

WRONG
    title: "Checkout page"
right
    title: "Checkout layout: compact or detailed?"

## session_title: name the work once

On your first ask, send session_title: a few plain words about the work, 60 characters or less.
Do not use a path or a branch name. The sidebar shows it instead of the folder name. Send a new one
only when the work changes.

## need: the first line stands alone

The queue preview shows only the need's first sentence. Put the decision there, not context.
Need and round messages render bold, italics, inline code, lists and pipe tables. Bold the key words; keep the first line the question.

WRONG
    need: "I've been working on the checkout flow for a while and I think there might be two
    reasonable layouts we could use, compact or detailed, and I want to know which one to build."
right
    need: "Pick the checkout layout: compact or detailed."

## why: 1 to 3 sentences, not your reasoning

why explains why you cannot decide this yourself. It is not the place for your analysis.

WRONG
    why: "I looked at three competitor sites and measured conversion funnels and read the design
    system docs and considered five options and think compact converts better because..."
right
    why: "Both layouts are defensible and this is a product call. See the comparison artifact for
    the tradeoffs."

Put the long version in an artifact (see the artifacts guide) and point to it from why.

## items: one item for each decision

An item is one decision. Give it an `id`, a `question`, `options` and a `recommendation`. With one
item, the `question` is optional: the need stands in. With more than one item, each item needs a
`question`. Send 1 to 12 items. Use several items only when the decisions go together.

right
    items: [{ id: "layout", options: [
               { id: "a", title: "Compact", label: "Compact: one screen, fewer fields" },
               { id: "b", title: "Detailed", label: "Detailed: full billing and shipping on one page" } ],
             recommendation: "a",
             recommendation_why: "Compact matches the rest of the app's checkout pattern." }]

## options: spell every one out

Give each option a short `title` (1 to 6 words) and spell out the full option in `label`. Waggle
shows the title in the answer box and every label in full in the Decision section. The human must
read a label cold, with no shorthand.

WRONG
    options: [{ id: "a", label: "Option 1" }, { id: "b", label: "Option 2" }]
right
    options: [{ id: "a", title: "Compact", label: "Compact: one screen, fewer fields" },
               { id: "b", title: "Detailed", label: "Detailed: full billing and shipping on one page" }]

An option may carry `pros` and `cons`: 1 to 3 short lines each (5 at most, 160 characters each).
Write real reasons that differ for each option.

An option may also carry `effects`: up to 3 short lines (160 characters each) that say what the
choice causes. Write effects, not judgements: what the choice touches, what it closes, what it
needs next. Waggle shows them as "If you pick this" below the good and bad points. A neutral
effect goes in `effects`. A good or bad point stays in `pros` or `cons`.

    options: [{ id: "a", title: "Compact", label: "Compact: one screen, fewer fields",
                pros: ["Fastest for the buyer"], cons: ["Hides billing details"],
                effects: ["Touches the checkout form only", "Closes the two-step flow", "Needs a new address check"] }]

An option may also carry `facts`: up to 3 short neutral facts (24 characters each) that Waggle shows
as chips under the title: a time, a scope, a file. A long pro or con may be `{ gist, detail }`
instead of a string: the gist (40 characters at most) shows on the card, and the detail is the full
sentence the human opens with one click. A plain string still works and shows in full.

    options: [{ id: "a", title: "One store file", label: "One store file: keep the cache in src/store.ts",
                facts: ["~2 h", "no migration", "src/store.ts"],
                pros: [{ gist: "One file to change", detail: "Only src/store.ts changes, so the review stays small" }],
                cons: ["The cache stays in memory"] }]

To link an option to a named artifact, add
`artifact_ref` and `anchor`. Call waggle_guide({ topic: "artifacts" }) for the rules.

Waggle numbers the options (1, 2, 3...). Do not put your own letter or number in front of a label.

WRONG
    options: [{ id: "a", label: "A · Compact: one screen, fewer fields" }]
right
    options: [{ id: "a", label: "Compact: one screen, fewer fields" }]

## recommendation: always give one, and say why

Even when you are unsure, pick the option you would ship and say why in `recommendation_why`
(1 to 2 sentences). The human may still choose something else.

WRONG
    recommendation: "either"
right
    recommendation: "a"
    recommendation_why: "Compact matches the rest of the app's checkout pattern."

The exception is a `reply` item. Its recommendation is a suggested reply. Write it as the human, and
answer the question. Do not tell the human what to do. Leave it out when only the human knows the
answer: an observation, a fact, or a preference you cannot guess. Waggle warns you when a suggested
reply starts like an instruction ("Describe...", "Tell me...", "Please...").

WRONG
    question: "What did the app show after you saved the check?"
    recommendation: "Describe the button and the next screen."
right
    question: "What did the app show after you saved the check?"
    (no recommendation)

## select: one, many or reply

An item has a `select`. The default with options is `one`: the human picks one. Use `many` when the
human can say yes to more than one option. Add `max` to cap the picks, and give `recommendation` as a
list of option ids. Use `reply` when the human must write the answer. A `reply` item has no options,
and its recommendation is a suggested reply in plain text.

WRONG
    Ask "which fixes should I make?" with select "one" and the option "all three".
right
    items: [{ id: "fixes", select: "many", max: 2, recommendation: ["a", "c"],
              options: [{ id: "a", ... }, { id: "b", ... }, { id: "c", ... }] }]

## Several items: decisions that go together

Send one request for one decision. Send unrelated decisions as separate requests, one waggle_ask each.
The human sees each request as its own row and can answer one without the others. Use several items in
one request only for decisions that go together, with the same `group`. Waggle warns you when the
items of one request share no group.

wrong (three unrelated decisions in one request)
    one waggle_ask with items: "Which date format?", "Rename the CLI?", "Ship on Friday?"

right (two waggle_ask calls, each with its own decision)
    waggle_ask { title: "Which date format?", ... }
    waggle_ask { title: "Ship on Friday?", ... }

For decisions that go together, send ONE waggle_ask with several items. Give each a `question`.
Items with the same `group` (`{ id, title, now?, variants?, variant_label? }`) share a heading, short
"how it works now" lines and the artifact variants. Waggle shows each item as its own step; a group
does not put items on one page. The reply
has one answer for each item. Apply every answer. An item the human did not answer has no line.

right
    items: [
      { id: "layout", question: "Which layout?", group: { id: "card", title: "The profile card" },
        options: [{ id: "cards", title: "Cards", label: "Cards: easy to scan" },
                  { id: "table", title: "Table", label: "Table: dense" }],
        recommendation: "cards", recommendation_why: "It fits a phone." },
      { id: "avatar", question: "Show the avatar?", group: { id: "card", title: "The profile card" },
        options: [{ id: "yes", title: "Yes", label: "Yes, above the name" },
                  { id: "no", title: "No", label: "No, hide it" }],
        recommendation: "yes", recommendation_why: "People know faces." }
    ]

## artifacts: one, or several

Send `artifact` for one artifact. Send `artifacts` (a list, up to 8) when the human needs more than
one format, for example a write-up and a prototype. Give each artifact its own `name`. Send only
what the human needs. Do not send both `artifact` and `artifacts`.

## A review: an artifact and a decision

A review is an ask with an artifact and one item with the options `approve` (Approve) and
`request_changes` (Request changes). Give your recommendation. Call waggle_guide({ topic: "reviews" }).

## A plan: rounds with a stage label

Brainstorming or planning is one case. Send each round with waggle_update and a `stage` label.
Call waggle_guide({ topic: "plan" }).

## replaces: change an ask you already sent

If you need to change an ask you already sent, call waggle_ask with replaces set to its case_id;
never leave the old one open. The old ask is withdrawn: it leaves the queue, and the daemon tells
you if the human had already answered it before you replaced it, so that answer is never lost.

WRONG
    Send a clearer version of the same question as a brand new, unrelated waggle_ask, and leave
    the first one sitting in the queue forever.
right
    waggle_ask({ ..., title: "Speed up the fleet: which fixes should I make?",
                 replaces: "c_01J..." })

## A held ask: past decisions fit

Before it makes a case, Waggle looks in this project for decisions the human already made on the same question. If some fit, the
first waggle_ask creates no case. It returns `status: "held"` with up to 3 matches (case_id, question, pick, why, date).
The human was not asked. Do one of three things:

1. Drop the ask and follow the past decision.
2. Send a better ask with waggle_ask. Name the old decision and say what is new.
3. Send the same ask again with the same title. Waggle then creates the case and keeps the matched case ids.

A review, an ask with `replaces` or `follows` is never held.

## sources: show where a claim comes from

Cite what you read. Send `sources` (up to 24) with the ask or the update. Put `[[s:id]]` after the
sentence it supports. Use `[[s:id,id2]]` for two sources. Use at most 8 markers in one ask.
Cite each source in the text with `[[s:id]]` after the sentence it supports. A source with no citation
shows only at the end of the why text.

Waggle checks your session for the matching call and marks each source `seen` or `stated`. It
marks kind `none` as an assumption. Waggle removes a marker with an unknown id and tells you.

Each source has an `id` (1 to 24 characters: a to z, 0 to 9, - and _), a `kind`, a `label` (the
pill words, 60 characters or less, one line), and optional `note`, `excerpt` and `ref`. Waggle cuts
an excerpt at 600 characters.

| kind | use it for | `ref` that Waggle matches |
|---|---|---|
| file | code or a config file you read | path |
| document | a doc, spec or brief you read | path |
| image | a screenshot or picture you looked at | path |
| search | a grep, rg or glob you ran | command |
| history | git log, blame or a shell history check | command |
| test | a test or build you ran | command |
| database | a query you ran | command |
| api | a call to a service | command or url |
| tool | any other tool you called | tool |
| design | a design tool you read | tool |
| web | a page or a search on the web | url |
| agent | a helper you started | tool, or the label |
| you_said | something the human told you | the excerpt |
| decision | an earlier Waggle answer | case_id |
| rule | a rule file you read | path |
| none | a guess or an assumption | none |

WRONG
    Cite a file you did not open. Waggle shows it as stated, not seen.
right
    Cite what you read. Use kind `none` for a guess.

Example ask that cites 3 sources:

    waggle_ask({
      title: "Tab row: one tab for each artifact?",
      need: "Show one tab for each artifact name of the request.",
      why: "The tab row reads the revisions now. [[s:tabs,db]] The app tests pass. [[s:tests]]",
      items: [{ id: "tabs", options: [
        { id: "per_name", title: "One per name", label: "One tab for each artifact name" },
        { id: "per_round", title: "One per round", label: "One tab for each round" } ],
        recommendation: "per_name", recommendation_why: "It matches how the human names artifacts." }],
      sources: [
        { id: "tabs", kind: "file", label: "ArtifactTabs.swift:34",
          note: "One tab for each artifact name.",
          ref: { path: "apps/macos/Sources/Knock/AskDoc/ArtifactTabs.swift", line: "34" } },
        { id: "db", kind: "database", label: "knock.db · 9 rows",
          excerpt: "select name, count(*) from revisions group by name", ref: { command: "sqlite3" } },
        { id: "tests", kind: "test", label: "swift test · 2268 pass", ref: { command: "swift test" } } ] })

## Deprecated shortcuts

These inputs still work. Waggle will remove them after two releases. Do not use them in new asks.

- `kind: "review"`: use an artifact and the Approve and Request changes item.
- `kind` plan: use a stage label on a round.
- `questions` (with `points`, `now`, `variants`): use items with a `group`.
- Top-level `options`, `recommendation`, `select` and `max`: use one item.
- `more_detail` as a request name: the reply is Keep talking. See the after-the-reply guide.
