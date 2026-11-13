# Waggle MVP protocol

Status: the contract between the daemon, the MCP shim and the app. Every change builds against this file.
If a change needs a different contract, update this file in the same pull request and say so in its
description. Do not change it silently.

## Names and the Knock to Waggle transition (HAIL-171, HAIL-176)

The product is Waggle. These ids keep the old name on purpose, so an update stays in place and keeps its
notification permission: the bundle id `dev.limone.knock` (and `.dev`), the data folder
`~/Library/Application Support/Knock`, `knock.db`, `knock.sock`, every `KNOCK_*` env var and the RPC method
names (including the RPC `knock_settings`).

What changed for people and agents:

- MCP tools: `waggle_ask`, `waggle_check`, `waggle_update`, `waggle_guide`, `waggle_settings`. Same schemas,
  same behaviour. The MCP server name is `waggle`.
- CLI: the binary is `waggle`. The app bundle holds `Contents/Resources/waggle` and a `knock` link to it.
- Plugins: Claude Code `waggle@waggle` (marketplace `waggle`), Codex `waggle@waggle`. User MCP entries are
  named `waggle`.
- User copy: the thing an agent sends is a "request"; agents "ask".

Transition: while `LEGACY_KNOCK_ALIASES` is true (`daemon/src/protocol/legacy-aliases.ts`; the Swift twin is
`apps/macos/Sources/Knock/Support/LegacyNames.swift`), `waggle mcp` also lists `knock_ask`, `knock_check`,
`knock_update`, `knock_guide` and `knock_settings`, each with the description "Old name of waggle_<tool>. Use
waggle_<tool>." and the same schema and handler. `waggle install ... --refresh` moves an installed
`knock@knock` plugin (Claude Code and Codex) to `waggle@waggle`, and moves a `knock` MCP entry to `waggle`. The app
moves the Claude desktop app entry `mcpServers.knock` to `mcpServers.waggle` on first launch. A later release sets
the switch to false and removes the code that reads it.

## Components

```text
Claude Code session ──stdio MCP──► waggle mcp (shim, one per session) ──┐
                                                                      │ unix socket, JSON-RPC 2.0
waggle CLI ────────────────────────────────────────────────────────────┤ (newline-delimited)
Waggle.app (SwiftUI) ───────────────────────────────────────────────────┤
                                                                      ▼
                                                   waggle daemon (Bun, sole SQLite writer)
```

- Socket: `~/Library/Application Support/Knock/knock.sock`, mode `0600`.
- Data root: `~/Library/Application Support/Knock/` holds `knock.db`, `blobs/`, `bundles/`, `logs/`.
  Override with `KNOCK_HOME` (tests always set it).
- One binary, subcommands: `waggle daemon`, `waggle mcp`, `waggle install [claude|codex]`, `waggle doctor`,
  `waggle test-ask`, `waggle uninstall [--purge]`, `waggle mod ...` (HAIL-134, used by the Claude Code
  plugin). `waggle install` with no argument installs every connector found on PATH.
- No LaunchAgent and no login item: the service starts on demand (see `docs/SERVICE.md`). `waggle mcp`
  and the app start `waggle daemon` detached when the socket is unreachable, then retry the connection
  for up to 3 s. The daemon exits by itself after `KNOCK_IDLE_EXIT_MIN` minutes (default 30; 0 = never)
  with no connected shim, no app client and no queued reply. Queued replies and cases persist in the
  DB across the exit. A chat connector that is on also keeps the daemon alive while an ask waits for
  the human (`needs_you`), so a phone reply has somewhere to go (HAIL-144).
- Network: none, except opt-in chat connectors (HAIL-144, see "Chat connectors") and opt-in sharing of a
  case (WAG-387, see "Sharing a case"). With every connector off and Sharing off the daemon makes no network call.

## Nouns

| Noun | Meaning |
|---|---|
| task | One agent run. In the MVP, one Claude Code session. Named from a Linear key in the branch (`ome-412-x` → `OME-412`), else the branch, else the cwd folder. |
| project | The git root folder name from the hello's `git_root`, else the cwd folder name as a string. A tag only. |
| case (UI: "ask") | One blocking `question` or `review` from a task. |
| revision | One immutable copy of a case's artifact. Starts at 1. A new revision never moves old comments. |
| capture | A frozen image of one revision, taken in Comment mode. Comments anchor to a capture. |
| reply | The human's answer to a case. Has an idempotency key. |

## MCP tools (served by `waggle mcp`)

The shim reads `KNOCK_RUNTIME` (`claude` | `codex`; unknown or missing = `claude`, so a registration
made before Codex support still works) to know which connector started it, and identifies its
session on start: `CLAUDE_CODE_SESSION_ID` if present for Claude Code, else a UUID it generates
(Codex documents no session id for an MCP server subprocess; HAIL-137: for Codex it uses `CODEX_THREAD_ID` when present, else a UUID),
plus `cwd`, git branch, git root (`git -C <cwd> rev-parse --show-toplevel`) and `pid` of its
parent. It sends `session.hello` (with `runtime`, `git_root`) to the daemon and keeps the
connection open. The daemon marks the session `live` while the connection is open.

On initialize the shim also serves `instructions` in the MCP server options: the `MCP_INSTRUCTIONS`
constant in `daemon/src/protocol/mcp.ts` (v2, HAIL-38: raised from the original ~1,200-char cap to
about 3,000), plus one short paragraph from `RUNTIME_NOTES[runtime]` (`instructionsFor(runtime)`)
where Claude Code and Codex differ - session identity is the clearest one (see above). The common
text covers: trigger phrases that mean `waggle_ask` ("ask me in Waggle", "send me a review", "check
with me", "what do you think I should…") and that any decision the human must make goes through
Waggle, never a question left in the terminal; when not to send a request; how to write a title, a need whose
first line stands alone, and options spelled out in full (the human reads the ask in Waggle, not the
terminal, so never say "pick 1, 2, or 3" and expect them to know what those mean); the waiting
contract ("pending is normal. Call waggle_check again at once with the case_id. Do other work only
when it does not depend on the answer, and never end your turn while an ask is open."); keeping
`why`/`recommendation_why` short with the detail in an artifact; which artifact type to attach when;
`waggle_update` after an artifact change; detail requests; and `follows`. `waggle doctor` prints
`ok    agent instructions v<N>` so a tester can see which text a build carries. The onboarding panel
(`AgentInstructionsPanel.swift`) and `INSTALL.md` carry the same common text (a test keeps the three
copies identical); neither shows a runtime note, since neither knows which runtime it is talking to.
This text is read once at `initialize` and is not re-served; it stays the fixed common brief above,
plus the one runtime paragraph. It is not the place for anything that changes release to release -
that lives in the tool descriptions and `waggle_guide` below, both served live.

### Live tool manifest (`mcp.manifest`, HAIL-48)

The shim is a thin relay: the daemon is the only place that knows the current tool names,
descriptions and input schemas, and the only validator of a call's input. `mcp.manifest` (no params)
returns `{ daemon_version, tools: [{ name, description, inputSchema, annotations }] }` - `daemon_version` is the
same string `service.status` reports; `tools` is built once, at daemon startup, from the same Zod
schemas (`KnockAskInput` and its siblings) that already validate `case.create` and friends
(`daemon/src/protocol/mcp.ts` `MCP_TOOLS`), so the manifest and the validation it describes can never
drift apart. `inputSchema` is a plain JSON Schema object (draft-7); the shim relays it to the MCP
client as-is in `tools/list` and never validates a call against it - a bad field comes back as the
daemon's own `-32602 Invalid params`, with the same per-field message text `case.create` etc. have
always returned (`daemon/src/mcp/client.ts` `DaemonRpcError` folds `error.data.issues` into that
text).

`annotations` (additive, 2026-11-12) holds the four MCP tool hints, each an explicit boolean:
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. The shim relays them in `tools/list`.
`waggle_check` and `waggle_guide` are read-only and idempotent. `waggle_settings` and `waggle_themes` write
and are idempotent. `waggle_ask` and `waggle_update` write, are not idempotent, and are open-world, because an
opt-in connector (Telegram, Slack) can send them to the human. No tool is destructive. A knock_* alias has the
hints of its waggle_* tool. A manifest from an older daemon has no `annotations`; the shim then lists the tools
without them.

Reconnects (HAIL-63): the shim does not wait for a tool call to reconnect. When its connection
closes, it retries a plain connect in the background (2 s for 30 s, then 15 s; never starting a
daemon) and re-sends `session.hello` with the same session id. `session.hello` from an already-known
session sets it `live` and updates `last_seen_at`; the shim also sends it every 60 s while idle as a
keepalive.

The shim fetches `mcp.manifest` once per fresh connection: on startup, and again on every reconnect
after the daemon restarts (an update: the app starts a new daemon, the shim's next call finds the
socket dead, and the existing on-demand-start-and-retry path (KNOCK-18) reconnects it). `tools/list`
itself waits for whichever fetch is already in flight before answering, so the very first listing of
a session reflects the live daemon whenever it is reachable, not a stale placeholder. When the fetched
`daemon_version` differs from the one the shim already had (a real reconnect after an update, never
the first-ever connect), the shim sends `notifications/tools/list_changed`
(`capabilities.tools.listChanged: true`, declared on the low-level MCP `Server` the shim now runs on)
so an already-open Claude Code or Codex session re-reads `tools/list` and picks up new tools, new
fields and new descriptions without a restart, when the client acts on the notification.

**Tested live (2026-09-28, Claude Code 2.1.284, stdio, `claude -p` with a throwaway probe
server):** after `notifications/tools/list_changed`, a tool *added* mid-session was listed and
called in the same run, but a *changed* input schema of an existing tool was not: the model kept
the schema from session start and learned the new field only from the server's error. So new
fields on existing tools do not reach an open Claude Code session through the tool list; the open
schemas and the "Waggle was updated" notice below are what carry them.

**Amendment A1: neither client reliably does, today.** Earlier research (2026-09-28): Claude Code
caches `tools/list` at connect time and does not re-read it on
`notifications/tools/list_changed`, reported by multiple GitHub issues showing the notification
reaching the client over the wire and still being ignored
([anthropics/claude-code#79826](https://github.com/anthropics/claude-code/issues/79826),
[#88172](https://github.com/anthropics/claude-code/issues/88172),
[#97369](https://github.com/anthropics/claude-code/issues/97369),
[#78208](https://github.com/anthropics/claude-code/issues/78208); a new conversation or `--resume`
does not force a re-read either). Codex CLI's handler for the notification
(`codex-rs/rmcp-client/src/logging_client_handler.rs` on `openai/codex` `main`) only logs the
event and does not invalidate its cache or re-issue `tools/list`; open issues confirm the same gap
in practice ([openai/codex#10105](https://github.com/openai/codex/issues/10105),
[#33266](https://github.com/openai/codex/issues/33266),
[#37417](https://github.com/openai/codex/issues/37417),
[#35583](https://github.com/openai/codex/issues/35583),
[#43642](https://github.com/openai/codex/issues/43642)). Sending the notification is still the
protocol-correct thing to do - it costs nothing and will start working the moment either client
fixes its handler - but Waggle cannot depend on it to get an update in front of an open session, so
two more mechanisms carry that weight instead:

- **Open input schemas.** `toolInputSchema` (`daemon/src/protocol/mcp.ts`) sets
  `additionalProperties: true` on every tool's advertised JSON Schema, whatever Zod's own
  `z.toJSONSchema` would otherwise produce for it. A client that validates a call's arguments
  against the copy of the schema it cached at session start - even a copy from before a field
  existed - still lets that field through, because the schema never claimed to be closed. The
  daemon is still the only validator of the fields it recognizes: Zod's default, non-strict
  `z.object` already ignores a field it does not recognize instead of rejecting the call, so this
  changes only what the schema advertises, never what the daemon accepts or its error text for a
  bad value it does recognize (HAIL-38 error texts are unchanged).
- **A one-line notice on the next tool result.** When the shim's `refreshManifest` notices the
  daemon's version changed, it queues one line onto whichever tool result comes back next - any
  tool, a success or an error result - instead of only the silent `tools/list_changed`
  notification: `Waggle was updated to <version>. Call waggle_guide with topic "whats-new" for what
  changed.` This fires once per version change per shim: the flag is consumed the moment the line
  is attached (`withVersionNotice`, `daemon/src/mcp/shim.ts`). The call that discovers the
  reconnect (KNOCK-18) already fetched the new manifest by the time it returns, so that same call's
  own result usually carries the notice - there is rarely an earlier result left to attach it to
  instead.

`waggle_guide`'s content moved the same way: `guide.get` (`{ topic? }` → `{ text }`) is `getGuide`/
`guideIndex` (`daemon/src/guide`) called on the daemon, not compiled into the shim, so an
already-open session's `waggle_guide` call always reads the current guide text. An unknown topic
answers the same message it always has (naming every valid topic), now as a normal RPC failure
(`-32603`, `error.data.message`) instead of a local throw.

**Compatibility, both directions.** An old shim (built before HAIL-48: static `registerTool` calls,
`waggle_guide` served from its own compiled-in guide text) never calls `mcp.manifest` or `guide.get`
and keeps working unchanged against a new daemon - the daemon still serves every session RPC an old
shim uses. A new shim against an old daemon that has no `mcp.manifest` gets `-32601 Method not found`
on the fetch, swallows it, and keeps serving its own compiled-in copy of `MCP_TOOLS` as the listing
(same constant either side, just from whichever binary is running); `waggle_guide` on that pairing
forwards to a `guide.get` the old daemon also lacks, so the call fails with a normal tool error
instead of the guide text - not a crash, but not a graceful fallback either, since guide content, unlike
the tool listing, has no shim-local copy to fall back to.

### `waggle_ask` (blocking by contract)

Input:

```json
{
  "kind": "question | review | plan, optional, default question (a shortcut, see Items and shortcuts)",
  "stage": { "name": "questions | approaches | design | spec", "step": 3, "total": 5, "total_is_estimate": true },
  "title": "string, 1..80 chars",
  "need": "string, what the agent needs from the human",
  "why": "string, why the agent cannot decide",
  "items": "Item[], 1 to 12, optional (WAG-312): the decisions of this ask. See Items and shortcuts",
  "recommendation": "string: an option id, or free text when there are no options. Required without items",
  "recommendation_why": "string. Required without items",
  "select": "\"one\" | \"many\", optional, default \"one\" (HAIL-123)",
  "max": "integer >= 1, optional, only with select many",
  "options": [{ "id": "a", "label": "Compact: one screen, fewer fields", "title": "Compact",
                "pros": ["Fast to fill in"], "cons": ["Hides billing details"], "facts": ["~2 h"],
                "artifact_ref": "Flow diagram", "anchor": "step-2" }],
  "artifact": { "type": "screenshot", "path": "./shots/a.png", "name": "Home screen" }
             | { "type": "html_bundle", "dir": "./proto", "entry": "index.html",
                 "viewport": { "width": 390, "height": 844 }, "preview": "preview.html" }
             | { "type": "markdown", "path": "./notes/explain.md" }
             | { "type": "diagram", "path": "./notes/flow.mmd" }
             | { "type": "screenshots", "items": [{ "path": "./shots/1.png", "caption": "Home", "item": "it_1" }, ...] },
  "artifacts": "Artifact[], 1 to 8, optional: several named artifacts instead of artifact (WAG-312)",
  "topic": "string, 1..80 chars, optional, only outside git (HAIL-163)",
  "session_title": "string, 1..60 chars after trim, optional (WAG-279)",
  "follows": "c_01J...",
  "replaces": "c_01J..."
}
```

#### Items and shortcuts (three blocks, WAG-310)

An ask is one request with `title`, `need`, `why`, a list of **items**, one or more artifacts and an optional
`stage`. An item is one decision. The human answers each item by picking one option (`select: "one"`),
picking several (`"many"`) or writing a reply (`"reply"`). One item shows as a single decision. More than
one shows a step bar. `kind` is optional and defaults to `question`. Every older input stays valid; the
shortcut table below says what each becomes. The daemon turns every input into items on write
(`daemon/src/protocol/items.ts`, `normalizeAsk`).

```json
{
  "title": "Checkout layout: compact or detailed?",
  "need": "Pick the checkout layout.",
  "why": "Both layouts work. This is a product call.",
  "stage": { "name": "approaches", "step": 1, "total": 3 },
  "items": [
    { "id": "layout", "select": "one",
      "options": [ { "id": "a", "title": "Compact", "label": "Compact: one screen, fewer fields" },
                   { "id": "b", "title": "Detailed", "label": "Detailed: billing and shipping on one page" } ],
      "recommendation": "a", "recommendation_why": "It matches the rest of the app." }
  ],
  "artifact": { "type": "html_bundle", "dir": "./proto", "entry": "index.html" }
}
```

`Item`: `id` (1 to 40 characters, unique in the ask), `question` (1 to 300 characters; optional for one item,
where the `need` stands in; required when there is more than one), `select` (`one` | `many` | `reply`;
default `one` with options, else `reply`), `max` (only with `many`, at most the number of options),
`options` (the `Option` shape above; 2 to 12 with `one` and `many`, none with `reply`), `recommendation`
(an option id; a list of ids with `many`; the suggested reply as plain text with `reply`, written as the human; left out when only the human knows the answer, and the daemon warns when it starts like an instruction),
`recommendation_why` (at most 300 characters) and `group` (`{ id, title, now?, variants?, variant_label? }`:
items with one group id share a heading, the "how it works now" lines and the artifact variants).

Input rules (all in `KnockAskInput`, all give a message that names the fix):
- `items` excludes `options`, `questions`, top-level `select` and top-level `max`: "give items, or options,
  or questions, not two of them".
- Top-level `recommendation` and `recommendation_why` stay required when there is no `items`. With `items`
  each item carries its own, and a top-level one is allowed only with a single item that does not set it.
- `stage` is allowed on any ask. `kind: "plan"` still requires one. `kind: "review"` still requires an artifact.
- `artifact` and `artifacts` exclude each other. `artifacts[]` takes the same types as `artifact`, at most 8.
  Each needs its own `name` (artifacts with one name are versions of one artifact, see Artifact name above).
  The shim stages every entry; each becomes one revision, in order. The single `artifact` stays as the
  shortcut for a list of one.
- The 12 limits apply to new input only. A stored request can have more (12 questions of 12 points).

Shortcuts that stay (nothing is removed in this release; the guide marks `kind: "plan"`, `questions` and
`more_detail` as deprecated and removal is a separate later task, operator decision 8 Oct):

| Old input | Becomes |
|---|---|
| `options` + `recommendation` + `recommendation_why` (+ `select`, `max`) | `items[0]` with id `main` |
| no options, no questions | `items[0]` with `select: "reply"`; the recommendation text is the suggested reply |
| `questions[].points[]` | one item per point, id `<question id>/<point id>`, `question` = the point text, `group` = the question; string options become options `o1`, `o2`, ...; a point with no options gets Yes, No, Talk with the team |
| `kind: "review"`, no `options`, no `items` | the review item, below |
| `kind: "plan"` + `stage` | `stage` on round 0; stored `cases.kind` is `question` |

Review shortcut. A `kind: "review"` ask with no `options` and no `items` gets one item, id `decision`, with the
options `approve` ("Approve: ship it as it is") and `request_changes` ("Request changes: use my comments").
The agent's `recommendation` marks an option when it equals `approve` or `request_changes` (case ignored; a
space or a dash for the underscore). Any other text is free text: it starts `recommendation_why` and no option is
marked (operator decision Q2). A review that gives its own `options` or `items` keeps them. A review needs
an artifact. Comments travel with the reply. A reply with comments or a message and no pick is Keep talking
(see "Decide and Keep talking"), so the agent only ever gets a review as a decision.

Dual write. For each ask and each round the daemon writes the items and also the old columns, so
an app that has not updated still reads the request:

| Items | `options_json`, `select_mode`, `recommendations_json` | `questions_json` | `cases.kind` |
|---|---|---|---|
| 1 item, `one` or `many` | the item's options and recommendation | `[]` | `question`, or `review` for the review shortcut |
| 1 item, `reply` | `[]`; `recommendation` is the suggested reply | `[]` | as above |
| more than 1 item | `[]` | one question per group, one point per item; a `many` item shows as a single-pick point, a `reply` item as Yes, No, Talk with the team | `question` |

The daemon never sends `kind: "plan"`; `Case.kind` stays `question | review` and `Case.plan` stays. Stored
requests are not rewritten: migration 41 adds only `option_sets.items_json` (nullable). `itemsOfRound` reads the
items of a stored round from `items_json`, else from `questions_json` (round 0), else from the options, else as one
`reply` item. `AGENT_INSTRUCTIONS_VERSION` is 11 and every tool schema keeps `additionalProperties: true`, so a
session that holds an older schema can still send `items`.

Compatibility gate (WAG-317). `daemon/test/compat-old-agents.test.ts` replays old `waggle_ask`, `knock_ask` and
`waggle_update` payloads of every shape (question with options, select many, reply only, review, plan stages,
`questions[]`, update with options, update with a stage, done, `more_detail` and `discuss` replies, one artifact)
and checks the stored case, the check text and the reply flow against what the 0.2.21 daemon returned
(`daemon/test/fixtures/compat/golden-0.2.21.json`). The one intended difference is the review shortcut: a review
with no options now stores the two review options, the check text names the option label (`Choice: approve
(Approve: ship it as it is)`), and a message with no pick is Keep talking. The Swift `LegacyDecodeTests` decodes
the JSON of each shape both ways, with a copy of the 0.2.21 models in the test target (an old app with a new daemon).

Inline artifact content (HAIL-163): for a client with no project folder (the Claude desktop app,
Cowork), `markdown`, `screenshot`, `screenshots` and `html_bundle` may carry the content instead of
a path. Paths work as before; give one form, never both.

```json
"artifact": { "type": "markdown", "content": "# Plan\n..." }
           | { "type": "html_bundle", "html": "<!doctype html>...", "viewport": { "width": 390, "height": 844 } }
           | { "type": "screenshot", "data_base64": "iVBORw0..." }
           | { "type": "screenshots", "items": [{ "data_base64": "...", "caption": "Home" }, { "path": "./shots/2.png" }] }
```

`waggle_update` takes the same forms. See "Artifacts" for the limits and "Topic outside git" below.

Option fields (WAG-276, additive: an agent that sends only `id` and `label` is unaffected). `Option` is
`{ id, label, title?, pros?, cons?, effects?, facts?, artifact_ref?, anchor? }`, used by `waggle_ask` and `waggle_update`
options (top level and inside `items`), `Case.options`, `Case.first_options`, `PlanRound.options` and `Item.options`. The daemon stores the option set as
JSON, so the new fields come back unchanged from `cases.get` and `cases.list`.
- `pros`, `cons`: at most 5 entries each. Same meaning as the pros and cons of a point option (WAG-257).
  Plan rounds should send them with every option. An entry is either a string (trimmed, 1 to 160
  characters) or, for the option card "Gist and facts" (docs/decisions/2026-11-10-option-card-gist-and-facts.md),
  an object `{ "gist": string, "detail": string }`: `gist` trimmed, 1 to 40 characters, the short version on
  the card; `detail` trimmed, 1 to 160 characters, the full sentence the app shows one click away. Both
  keys are required in the object. Strings and objects may mix in one list. The daemon stores and serves
  each entry exactly as sent (no normalisation): the app must decode an entry as `string | { gist, detail }`,
  and treat a string as a point with no gist (shown in full). Both texts may carry source markers.
  Example on the wire: `"pros": ["Fast to fill in", { "gist": "One file", "detail": "Changes only src/store.ts, no migration" }]`.
- `facts`: `string[]`, at most 3 items, each trimmed, 1 to 24 characters. Short neutral facts the app shows
  as chips under the option title, for example `"~2 h"`, `"no migration"`, `"src/store.ts"`. A point option
  of a `questions` step takes `facts` too. Additive: an ask without it is stored and sent as before.
  A fourth fact, an empty fact, a fact over 24 characters or a gist over 40 is refused with a field
  message (for example `options.0.facts: an option has at most 3 facts`).
- `effects` (WAG-360): `string[]`, at most 3 items, each trimmed, 1 to 160 characters. What picking the
  option causes: what it touches, what it closes, what it needs next. Neutral lines, not judgements (a
  good or bad point stays in `pros` or `cons`). The app shows them as "If you pick this" below Good and
  Watch out. A fourth, empty or over-long line is refused like a sixth pro. A line may carry a source
  marker. A point option of a `questions` step takes `effects` too. Additive: an ask without it is stored
  and sent as before, and an older app ignores it.
- `artifact_ref`: string, trimmed, 1 to 80 characters. The `name` of an artifact on this case. Selecting
  the option in the app switches to that artifact's tab. Match is trimmed and case-insensitive.
- `anchor`: string, trimmed, 1 to 120 characters. A place inside that artifact: an element `id` or a
  `data-waggle-anchor` value. See "Live artifact messages". For a `screenshots` artifact (WAG-352) it is the
  image: a number from 1, or a caption (case and spaces ignored). The daemon does not check `anchor` against
  the artifact type, so the wire is unchanged. With several decisions the app follows the decision on screen:
  the chosen or recommended option's `artifact_ref` and `anchor`, else the artifact all the options name,
  else the image of that decision in a `screenshots` set.

Artifact name (WAG-276, additive). Every `artifact` variant takes an optional `name` (trimmed, 1 to 40
characters, for example "Flow diagram"). The shim passes it through staging unchanged. The daemon stores
it with the revision (migration 37, nullable `revisions.artifact_name`) and `Revision` returns it as
optional `name`. `Revision` also returns optional `kind` (`screenshot`, `html_bundle`, `markdown`,
`screenshots` or `diagram`). Grouping rules for the decision page:
- Revisions that share a `name` are versions of one artifact. The app shows the newest in one tab.
- Revisions with no name group by their kind.
- A different name or a different kind is a separate artifact. An update that sends an artifact with a
  new name adds a tab to the decision page.
- A markdown artifact shows as text in its tab.

Revision round (WAG-351, additive). `Revision` returns optional `round`: the `seq` of the newest round
(option set) made at or before the revision's `created_at`, so an artifact-only update stays with the
round on screen and an edit by `"you"` stays with the round it answers. The daemon derives it from stored
data on every `cases.get`, so old rows have it with no migration. The decision page of a plan with more
than one round shows, for the round R on screen: the artifacts whose newest agent revision at or before R
has `round` R, plus each older artifact that an option of R names with `artifact_ref`; if that is empty,
the artifact the round shows. Each tab shows its newest revision at or before R. An app that gets no
`round` shows every artifact, as before.

The html_bundle `preview` field is optional and the decision page no longer uses it. It is still
stored per revision and returned by `artifact.path`. In the app (checked in `apps/macos/Sources`) it
feeds the case pane's `ArtifactPreviewCard` and the image fallback for an older html_bundle revision
(`OlderRevisionDisplay`).

#### Live artifact messages (WAG-276)

When the person selects an option that has an `anchor`, the app shows the option's artifact (`artifact_ref`)
and posts one message into the sandboxed page:

```js
window.postMessage({ type: "waggle:anchor", anchor: "<anchor>" }, "*")
```

A page may listen for it with `window.addEventListener("message", ...)` and react itself. The app also
scrolls to the element whose `id` or `data-waggle-anchor` equals the anchor, and adds a highlight. There is
no network and no bridge back to the app. The bundle sandbox rules stay unchanged ("Artifacts").

Field guidance (HAIL-37): the tool schema the shim publishes for `tools/list` carries a
`description` per field, so the agent sees this guidance without reading this doc:
- `need`: "The decision you need, in one or two sentences. The queue shows its first line."
- `why`: "1 to 3 sentences: why you cannot decide this yourself. Put longer reasoning, data or a
  plan in an artifact (markdown for reasoning, html_bundle for visuals, comparisons or plans). Max
  500 characters."
- `recommendation_why`: "1 to 2 sentences."
- `artifact`: "Attach whenever the operator must read more than a few sentences or see something:
  markdown for a write-up, html_bundle for a prototype, chart, table or plan, screenshot for one
  image, screenshots for 2 to 12 images the operator flips through and comments on one at a time,
  diagram for a flow or structure with more than 3 parts (a .mmd Mermaid file or a .svg)."

Agent text (`need`, `why`, `recommendation_why`, and the `message` of `waggle_update`) renders as
safe markdown in the app (operator decision 29 Sep, HAIL-70): paragraphs, bullet and numbered lists,
bold, italics, inline code and pipe tables (a header row, a `---` row, then body rows cut or padded to the header's cells;
docs/decisions/2026-11-11-tables-in-agent-text.md). No links (they show as plain text), no images, no HTML. The app never
opens or loads anything from this text. The queue row and notifications show one plain line with the
markers stripped.

Rules (the daemon validates; a failure returns an MCP error that tells the agent what to fix, and no
case is created):
- `need`, `why`, `recommendation`, `recommendation_why` are required and non-empty.
- `why` is at most 500 characters after trimming; `recommendation_why` is at most 300 characters
  after trimming (HAIL-37). Enforced by the shared `KnockAskInput` schema, so a direct socket caller
  gets the same rule as the shim. Longer than the limit is rejected with:
  `"<field> is N characters; the maximum is <limit>. Keep <field> to 1 to 3 sentences and put the
  details in an artifact: markdown for reasoning, html_bundle for a prototype, chart or plan."`
  (`N` is the real trimmed length.) `waggle_update`'s `message` has no such limit.
- `options` is optional. When present, `recommendation` must equal one option `id`.
- Multi-select (HAIL-123): `select` is `"one"` (default) or `"many"`. With `"many"` the human ticks
  several options and sends them together; it needs `options`. `max` (integer >= 1, at most the
  number of options) caps the ticks and is allowed only with `"many"`. With `"many"`,
  `recommendation` may be a list of option ids (at least one, each an option `id`, at most `max`);
  a single id still works. A list with `"one"` is rejected. `Case.recommendation` is the first
  recommended id; `Case.select`, `Case.max` (null for no limit) and `Case.recommendations` carry
  the rest. Without `select` an ask behaves as before.
- Each option is `{ id, label, title? }` (HAIL-85). `label` is the full option text; the app shows it
  in full in the ask's Decision section. `title` is an optional short title (1 to 6 words, at most
  80 characters) that the answer box row, the queue row's "you → <choice>" line and the send button
  show. Old agents send only `label`: the app then derives the title from the text before the first
  ":" when that is 1 to 6 words, else the first sentence clamped to one line. `cases.get` and `Case`
  return `title` as stored. The reply `choice` is still the option `id`.
- `review` requires `artifact`. `question` may omit it.
- The shim resolves the artifact path against the session cwd, validates it and copies it into
  `KNOCK_HOME/incoming/<uuid>/`, then sends the daemon that incoming path (see Artifacts). The daemon
  never reads the agent's project folder (HAIL-26).
- `follows` (HAIL-33 amendment) is optional: the `case_id` of an earlier ask this one is a follow-up
  to. The daemon validates it names an existing case that belongs to the same task as the calling
  session; otherwise it rejects the ask (RPC `-32007`) and creates no case. Stored as the case's
  `follows_case_id`, nullable, set only at creation. The MVP keeps one question and one answer per
  ask - no chat thread inside an ask - so a follow-up is a new, linked ask, not a reply to the old one.
- `replaces` (HAIL-44) is optional: the `case_id` of an earlier ask this one replaces, because the
  agent needs to change an ask it already sent (a clearer title, a corrected option). Validated the
  same way as `follows` (exists, belongs to the same task); otherwise the daemon rejects the ask
  (RPC `-32008`) and creates no case, and the named case is never withdrawn. Stored as the case's
  `replaces_case_id`, nullable, set only at creation. See "Replacing an ask" below.

Behaviour: create the case, then wait for a reply for at most the session's wait (HAIL-181). `KNOCK_ASK_WAIT_MS` overrides it.
The default is 540000 (9 minutes) for a Claude Code session and 50000 for every other client (the
Claude app caps a call at 60 s, Codex's `tool_timeout_sec` is 60, an unknown client is not trusted).
Claude Code's `MCP_TOOL_TIMEOUT` is about 28 hours when unset and progress notifications do not
extend it, so the shim sends none. When `MCP_TOOL_TIMEOUT` is set, the wait is 30 s under it, never
below 50 s.
- Reply arrived → return the reply payload and mark it delivered.
- Timeout → return text `{"status":"pending","case_id":"..."}` with the instruction
  "Call waggle_check with this case_id to get the human's reply." The case stays open.
  - HAIL-170: the pending result also has `waited_s` (seconds since the case was created). For a
    desktop session (HAIL-163 flavour: no `CLAUDE_CODE_*` variable, `can_nudge` false) the shim words
    the text "Call waggle_check again now. Do not end your turn. Stop only if the result says the case
    is closed. The case has waited <n>."
  - HAIL-181: the pending text is chosen per session. A session with `can_nudge` true gets "Waggle will
    wake you with a message when the human answers. You may do other work or end your turn. When the
    message arrives, call waggle_check once with case_id <id>." Any other session that is not a desktop
    session keeps the line above.
  - Every `case.wait` (so every waggle_ask and waggle_check) sets `Case.last_check_at` to now, at the
    start and again at the pending timeout. When the owning session has `can_nudge` false, it also
    emits `case.updated`, so the app can leave "Claude is not checking".
- `Case.last_check_at` (additive, nullable): when the owning session last called waggle_check for the
  case. `Case.session_can_nudge` (additive, nullable): the owning session's `can_nudge`. The app shows
  "Claude is not checking" only when it is false (and the runtime is Claude), 2 minutes after the
  answer with no check since.

#### MCP client name (HAIL-173)

`session.hello.client_name` (optional, additive) is the `clientInfo.name` the MCP client sent in
`initialize`. The shim learns it after its first hello, so it says hello again at once; every later
hello (the keepalive too) carries it. When the shim has no client name but sees a `CLAUDE_CODE_*`
variable, it sends `claude-code`. The daemon stores it in `sessions.client_name` (migration 32) and
keeps the last value it gets. It shows on the wire as `SessionInfo.client_name` and
`Case.session_client_name`, both nullable (null for an older shim).

The app names the client from it. A Claude session whose name is not `claude-code*` and whose
`can_nudge` is false is a desktop client: the app shows "Cowork" when the name contains "cowork"
(any case) and "Claude app" for every other name. A null name keeps "Claude Code". Claude Code and
Codex keep their names.

For a desktop client the shim leaves the ASD-STE100 limit warnings (`words_warning`) out of the
`waggle_ask` and `waggle_update` results, because the agent repeats them to the person. Claude Code and
Codex sessions keep them. The daemon still returns `words_warning` on the RPC.

The desktop guide and instructions tell the agent to say once, after an ask: "When you answer in
Waggle, paste the line Waggle gives you here so I can continue."

For a desktop client the queue row and the ask column show the same fallback after the 2-minute rule
(HAIL-170): "Claude is not checking" with "Copy reply". It copies `I answered your Waggle question:
<choice>. Continue.` and confirms "Copied. Paste it in your Claude chat or Cowork task." The "Copy prompt" and
terminal wording stays for Claude Code and Codex.

#### Questions (multi-question decision request, WAG-257)

`waggle_ask` may carry `questions[]` (1 to 12; not with `options`). Each question is
`{ id, title, now?: string[], points: [{ id, text, options?: (string | { label, pros?: Point[], cons?: Point[], effects?: string[], facts?: string[] })[] }], artifact_ref?, variants?: [{ id, label }], variant_label? }`.
A point option is a string, or an object with `label` and up to 5 `pros` and 5 `cons` (a `Point` is a string
or `{ gist, detail }`, see "Option fields"). Old string options stay
valid. The answer's `choice` is always the option label. Ids are unique in the request (point ids in their
question). A point with no `options` takes `Yes`, `No` or `Talk with the team`. `artifact_ref` is reserved: every
question shows the ask's own artifact today, and the app ignores the field. The daemon stores the list in
`cases.questions_json` and returns it as `Case.questions` (default `[]`).

An html_bundle shown for a question opens at `#<question id>`. A variant switch sets only the frame's
`location.hash` to `<question id>?variant=<variant id>`. The bundle reads the hash; Waggle never calls into it.

`reply.submit` and `reply.replace` take `answers: [{ question_id, point_id, choice, note? }]`. The daemon rejects
an answer whose question or point is not in the case, a repeat of one point, or a `choice` that is not one of
the point's option labels (or Yes, No, Talk with the team). It stores them in `replies.answers_json` (migration 35)
and returns them as `Reply.answers`. The MCP reply text lists them under `Answers:`, one plain line per point:
`Q3 · point 1: Card under the avatar · note: ...` (Q and point numbers count from 1 in request order),
before the free `Message:` line. Old apps ignore `questions` and `answers`. Since WAG-312 `questions` is a
shortcut for items with groups (see "Items and shortcuts"); the stored column and the `answers` reply do not change.

#### Replacing an ask (HAIL-44)

An agent that sends a clearer or corrected ask before the human replies to the first one must not
leave the first one open forever: `replaces` withdraws it in the same write that creates the new
case.

- The named case moves to `resolved` with `withdrawn_at` set to now - the same way `case.dismiss`
  moves a case to `resolved` with `dismissed_at` set, but for a different reason, and with no
  `case.restore` equivalent: a withdrawn ask cannot be brought back. It leaves both `needs_you` and
  `waiting_on_agent` immediately.
- Any reply still `queued` on the withdrawn case (the human answered it, but no agent ever called
  `waggle_check`/`waggle_ask` to pick that answer up - see "Case and reply states") is marked
  `superseded`. A `superseded` reply is never delivered; `reply.replace` on one is rejected the same
  way it rejects a `delivered` or `failed` one (RPC `-32006`).
- When that queued reply existed, its answer must not be silently lost: `case.create`'s result
  carries a `replaced_answer_note`, and `waggle_ask`'s own result (docs/protocol-mvp.md "MCP tools")
  prepends it as a first text block, before the reply (or `pending`) for the new ask:
  ```text
  Note: the human answered the ask you replaced: a (Compact). Take it into account.
  ```
  `null` when the withdrawn case had no queued reply.
- In `askWords: "asd"`, `case.create`'s result also carries `words_warning`, the one line
  `waggle_ask` prepends when the ask breaks an ASD-STE100 limit (HAIL-140): "Waggle: this ask breaks
  ASD-STE100 limits (<short list>)." `null` when the ask is clean, or in `normal` mode. The ask is
  never rejected. `case.update` carries the same field for a new-options proposal.

### Plan asks (HAIL-151)

A plan ask is ONE case that walks the brainstorming stages: questions, approaches, design sections,
spec. The queue shows one row for the whole plan. Operator decision, 3 Oct.

- `waggle_ask` takes `kind: "plan"` with a required `stage`:
  `{ name: "questions" | "approaches" | "design" | "spec", step?, total?, total_is_estimate? }`
  (`step` and `total` are integers of at least 1). Since WAG-312 `stage` is allowed on any ask or round (operator
  decision Q6): a stage label on round 0 is what `kind: "plan"` means, and `kind: "plan"` stays as a deprecated
  shortcut that requires one. A case with at least one stage label shows the stage track. The rest of
  the ask is as usual (`need`, `why`, `options`, `recommendation`, `recommendation_why`, an optional
  artifact of any type).
- Each later round is `waggle_update` on the same case with a new `stage`, new `options`, a
  `recommendation`, and optionally an artifact of any type (see "Round artifacts"). `message` is the round's question (the app shows its first sentence as the headline and the rest as safe markdown; display only, no wire change). `stage`
  no longer needs options (WAG-312): a `stage` alone relabels the current round, and a `stage` on a case that has none
  starts the track. `options` (or `items`) need a `recommendation`. `options` on a plan case without `stage` is a new round at
  the same stage. A round that carries options or items returns the case to `needs_you`. There is never a new case per question.
- Each round is one option set (`option_sets.stage_json`, `option_sets.question`, migration 27).
  A decision reply on a plan case is stamped with the round it answers (`replies.plan_round`).
  A `more_detail` reply does not answer a round. Since WAG-313 a reply that is Keep talking (a message or comments
  with no pick, a `discuss` reply) does not answer a round either, on any case; before, a comments-only reply on
  a plan stamped the round. The round's answer is read from `plan_round`, else from `reply_option_sets.seq`, else
  from the newest round before the reply time. Nothing is backfilled.
- **Wire compatibility.** `Case.kind` stays `"question"` for a plan ask, so an app that does not know
  plans shows it as a question with options. A plan case adds `Case.plan`
  `{ stage, rounds, answered }` (the newest round's stage, how many rounds, how many answered) and
  `CaseDetail.plan_rounds` (`[{ seq, stage, question, options, recommendation, recommendation_why,
  created_at, answer: { choice?, choices?, message?, created_at } | null }]`, oldest first). Both are
  absent on every other case. An app that cannot read a stage name shows a plain question. `CaseDetail.rounds`
  (see "Case fields") generalises `plan_rounds`; `plan_rounds` stays for old apps and lists the rounds that have a stage.
  Usage records a plan ask as `question`.
- The agent gets each round's answer like any reply. The reply payload of a plan decision ends with
  one extra text block: send the next round with `waggle_update` on this case, then `waggle_check`.
  The agent cannot read earlier rounds back through a tool: it keeps the answers it got.
- The app sorts a plan row by the latest round (`updated_at`), not by arrival.
- **Round artifacts (HAIL-156).** Any round (`waggle_ask kind plan` and every `waggle_update` with a
  `stage`) takes any artifact type: markdown, screenshot, screenshots, html_bundle, diagram. It is
  staged and stored like any artifact: one revision per artifact, numbered per case. (Before this
  story the docs and guide spoke of a markdown artifact only; the code never limited the type.)
  Each round records the revision it shows: `option_sets.revision` (the revision the round sent, else
  the newest one that existed when the round began; NULL while the plan has none) and
  `option_sets.own_artifact` (1 when the round itself sent one), migration 28. `PlanRound` adds
  `revision` (int or null), `own_artifact` (bool) and `artifact_kind` (the kind of that revision, or
  null). `Case.plan` adds an optional `artifact_kind`: the kind the newest round itself sent, absent
  when it sent none. A round with no artifact keeps showing the latest one.
  - **Stage.** The app shows the newest revision with its full viewer for its kind. A new round
    whose artifact has another kind than the one on screen starts the stage over (no stills, pins or
    gallery state carry across kinds).
  - **"Still showing vN" (HAIL-146).** On a plan case the line shows only when the newest round sent
    no artifact AND its stage name differs from the stage of the round that sent the artifact on
    screen (approaches after the questions). More rounds of the same stage show no line.
  - **History.** Each row in "N answered" has "See vN" for the round's `revision`. It opens that
    revision read-only on the stage (HAIL-142), with its pins. A new round closes it.
  - **Comments** travel with the reply of the round they were made in, as for any ask; a decision
    reply is stamped with that round (`replies.plan_round`) and the comments are cleared for the
    next round.
  - **Queue and phone.** The queue row of a plan shows the artifact chip when the newest round sent
    its own artifact. The phone message adds "Open Waggle on your Mac to see the <word>" in the same
    case (never for a round that only carries an earlier artifact).
- Chat connectors: each round goes to the phone as a new message once the message of the earlier
  round is closed out. The title reads `Brainstorm · question 3 of ~5 · <title>` and the text is the
  round's question. The phone offers the round's options and "Ask for more detail"; the stage track,
  the folded answers and the artifact are Mac only.
- `waggle_guide` topic `plan` has the templates. The Claude Code plugin skill sends brainstorming
  flows through a plan ask.

### Sources on a request (WAG-354)

An agent cites where a claim comes from. "Agent cites, Waggle checks." Code: `daemon/src/protocol/sources.ts`
(shapes and marker helpers), `daemon/src/sessions/sources-check.ts` (the check).

**Input.** `waggle_ask` and `waggle_update` take an optional `sources` list, 1 to 24 entries. Each source:

- `id`: 1 to 24 characters, `[a-z0-9_-]`, unique in the list.
- `kind`: `file`, `document`, `image`, `search`, `history`, `test`, `database`, `api`, `tool`, `design`, `web`,
  `agent`, `you_said`, `decision`, `rule` or `none`.
- `label`: 1 to 60 characters, one line (the pill words).
- `note`: optional, up to 300 characters.
- `excerpt`: optional. The daemon cuts a text over 600 characters to 599 plus `…`. It never refuses the ask.
- `ref`: optional object of optional strings: `path`, `line`, `command`, `url`, `tool`, `case_id`.

**Marker.** Any agent text field (need, why, item question, option label, pros, cons (both the gist and the detail of an object entry), recommendation_why, the
update message) may hold `[[s:ID]]` or `[[s:ID,ID2]]` after a sentence. The daemon keeps a marker whose ids all name
a cited source. It removes an unknown id from the stored text and adds one warning line to the tool result
(`words_warning`, the same channel as the length warnings). More than 8 markers in one ask gives a warning, not a refusal.
A new round (an update with items) cites only its own `sources`. A message-only update may also cite the sources the
newest round holds, and its own `sources` are merged into that round (a known id is replaced, the list stays at 24).

**Storage.** `option_sets.sources_json` (migration 43, additive, NULL when the round cites none). It holds the sources
with `state` and `seen_at`. It never holds transcript content.

**Served.** `Case.sources` (newest round) and `Round.sources` (`cases.get`) carry each source plus:

- `state`: `seen` (the daemon found the matching call), `stated` (no match, or the read was not allowed) or
  `assumption` (`kind: none`, always).
- `seen_at`: optional, the ISO time of the matching call.

Both fields are absent when the round cites no source, so an ask with no `sources` reads as before.

**One-line places.** `stripSourceMarkers` (in `protocol/sources.ts`) removes the markers. Queue rows, chat messages
(`plainLine` in `connectors/manager.ts`) and the Context card (`plain` in `sessions/context.ts`) call it. No raw
`[[s:` reaches a connector.

**The check.** It runs when the ask or update is stored. It reads the session's Claude Code transcript with
`findTranscript` and reads at most the tail the Context card reads. It looks only at calls made before the ask, never
at the Waggle tools, never at helper (sidechain) records. A failure gives `stated`. No match, or no `ref`, gives
`stated`. When a usage switch forbids the transcript read (`usage-off`, `usage-transcript-off`), or the transcript is
absent, every source that needs the transcript is `stated`.

| kind | match |
|---|---|
| `file`, `document`, `image`, `rule` | a `Read` call whose `file_path` ends with `ref.path` |
| `search` | a `Grep` or `Glob` call, or a shell `grep`/`rg` command, that contains `ref.command` |
| `history`, `test`, `database` | a `Bash` command that contains `ref.command` |
| `api` | a `Bash` command that contains `ref.command` or `ref.url` |
| `tool`, `design` | a tool call whose name contains `ref.tool` (case ignored) |
| `web` | a `WebFetch` or `WebSearch` call that contains `ref.url` |
| `agent` | an `Agent` or `Task` call whose type or description contains `ref.tool` or the label |
| `you_said` | a human message that contains the first 80 characters of the excerpt (spaces collapsed, case ignored) |
| `decision` | a case `ref.case_id` exists in knock.db and has a reply (reads the database, not the transcript) |
| `none` | always `assumption` |

**Web link (WAG-407).** The app shows the host of an `http` or `https` `ref.url` in the source detail, with an "Open link"
action that opens the URL in the default browser on a click only. Any other scheme, a URL with no host and a URL with
user:password show nothing and are never opened. This holds for every state.

## Session title (WAG-279)

`waggle_ask` and `waggle_update` may carry `session_title` (1 to 60 characters after trim, additive).
The daemon stores it on the session (`sessions.session_title`, migration 39). The latest one wins; an
empty one is ignored. `sessions.list` returns it as `session_title` (nullable, absent from an older
daemon). The app picks the shown title in this order: `session_title`, `context.title` (Claude Code's
own title), `context.goal` (the first prompt, shortened), the folder name. A title that looks like a
branch, a path, a worktree slug or an id (for example `knock-waggle-xza23H`, `WAG-275`) falls through
to the next source.

## Session title (WAG-279)

`waggle_ask` and `waggle_update` may carry `session_title` (1 to 60 characters after trim, additive).
The daemon stores it on the session (`sessions.session_title`, migration 39). The latest one wins; an
empty one is ignored. `sessions.list` returns it as `session_title` (nullable, absent from an older
daemon). The app picks the shown title in this order: `session_title`, `context.title` (Claude Code's
own title), `context.goal` (the first prompt, shortened), the folder name. A title that looks like a
branch, a path, a worktree slug or an id (for example `knock-waggle-xza23H`, `WAG-275`) falls through
to the next source.

## Topic outside git (HAIL-163)

A session with no git root (the shim sent `git_root: null`; for example cwd `/`) has blank task and
project names. `waggle_ask` may then carry `topic`, a short name for the job (1 to 80 characters,
trimmed). The daemon makes one task per topic and session, named by the topic (task name and
project are both the topic). The match ignores letter case, so the same topic groups its asks in one
task. Asks without a topic stay in the session's own task, as today.

- A topic task has `tasks.owner_session_id` set (migration 29). A session owns its own task and
  every topic task it made, so `waggle_check`, `waggle_update` and `reply.ack` work on all of them. The
  session state, the nudge target and a failed queued reply (ended session) follow the same rule.
- HAIL-222: `changes` in `session.hello` is the git footprint of cwd (`files`, `added`, `removed`, `clean`,
  `last_commit`, or `null` for no repository). The shim reads it inside the agent's process and re-sends it when
  it changes. The daemon and the app never run git or read a file in a session's cwd: macOS would ask for access
  to the person's Desktop or Documents folder. `sessions.list` shows it as `context.changes`.
- `sessions.no_git` is 1 when `session.hello` carried `git_root: null`. An older shim omits
  `git_root`; that reads as "in git", so the topic is ignored.
- Inside git the topic is ignored: names, grouping and ownership do not change. No error.
- `follows` and `replaces` without a topic stay in the task of the case they name when the session
  owns it.
- Topic tasks group inside one session only. Two sessions with the same topic make two tasks.

### `waggle_check`

Input `{ "case_id": "..." }`. Same wait and return shape as `waggle_ask`. A session may only check its
own cases; another session's case id returns an error. This is the routing guarantee (AC 6).
On a case the operator shared (WAG-387), the result also has an optional `shared_comments` field with the team's
comments. They are input, not a reply. See "Sharing a case".

### `waggle_update`

Input `{ "case_id": "...", "message": "string", "artifact": <same as waggle_ask>?, "artifacts": <same as waggle_ask>?, "items": Item[]?, "stage": PlanStage?, "options": [{ id,
label, title?, pros?, cons?, effects?, facts?, artifact_ref?, anchor? }]?, "recommendation": "string"?, "recommendation_why": "string"?, "done": boolean?, "reply_to_comment": { comment_id, body }? }`. Adds an agent
message and, when an artifact is given, a new revision. `artifacts` (1 to 8, same rules as on `waggle_ask`: not
with `artifact`, each with its own name) adds one revision for each, in the order given. The input is strict: an
unknown field is rejected with "waggle_update has no field "x". To attach, use artifact (one) or artifacts (a
list)." Before, an unknown field such as `artifacts` was dropped and the update returned ok without the pictures.
The case returns to `needs_you`. Returns immediately.

Rounds (WAG-310). A `waggle_update` is the agent's next turn on the case, a **round**. It may carry any of: an
answer (`message`), a revised artifact, new items, a `stage` label, or `done`. `items` is the canonical way to send
new items (same `Item` shape and rules as `waggle_ask`, each item with its own recommendation). `options` +
`recommendation` + `recommendation_why` + `select` + `max` stay as the single-item shortcut, and sending them
together with `items` is rejected: "give items, or options with recommendation, select and max, not both: each item
carries its own". `stage` needs no options and no plan case (see "Plan asks"). A round that carries items is one
`option_sets` row, stored with the items in `items_json`; seq 0 is the ask itself. `done: true` still cannot carry
options or items.

New proposal with an update (HAIL-108, operator decision D):
- `options` follows the waggle_ask rules (same `Option` shape with `pros`, `cons`, `effects`, `facts`, `artifact_ref` and `anchor`, `title` at most 80 characters, at least
  one option). When present, `recommendation` is required and must equal one new option `id`.
  `recommendation_why` is optional, with the same 300-character limit as waggle_ask. `recommendation`
  or `recommendation_why` without `options` is rejected. `select` and `max` (HAIL-123) follow the
  waggle_ask rules and are also rejected without `options`; each option set stores its own. Without these fields an update behaves as
  before (old agents).
- The daemon stores one option set per update (table `option_sets`; set 0 is the ask's own). The
  case's `options`, `recommendation` and `recommendation_why` are always the newest set.
  `Case.first_options` and `first_recommendation` are set 0 (equal to the newest until an update
  sends options). `Case.options_updated_at` is when the newest set arrived with an update, or null.
- A reply's `choice` is validated: the newest set wins, an id only the first set has is accepted as
  a first-set choice, and an id in neither is rejected (error -32009, no reply stored). A case that
  never had options accepts any text. `reply.submit` and `reply.replace` take an optional
  `options_set` (`"first"` or `"latest"`) for an id both sets share. `Case.latest_reply_from_first_options`
  says which set the latest reply's choice is from.
- `choices` (HAIL-123, `reply.submit` and `reply.replace`) is the multi-select answer. Every id must
  be in one option set whose `select` is `"many"` (the newest, else the first), none may repeat,
  there are at most `max`, and `choice` is not sent with it. An empty list is allowed only with a
  non-empty `message` ("none of these"). A bad `choices` is rejected with -32009 and no reply is
  stored. `Reply.choices` and `Case.latest_reply_choices` carry the ticks. A reply without
  `choices` is unchanged.
- The reply text to the agent (`waggle_check`, `case.wait`) names the option label from the set the
  choice came from. A detail reply (`more_detail`) followed by an update follows the same rules.
- The answer box (app): with options in the newest update it shows a blue header "Options from the
  update" with the time, the update's options and recommendation, and a "First options" link that
  shows the first set dimmed under a "FIRST OPTIONS" divider. An update without options puts the
  reply field first (placeholder "Reply to the update…") and folds the first options under a
  "First options · <time> · Show N" row. Keys 1..N pick the visible options of the newest set.

Feedback without a decision (WAG-285, operator report 7 Oct):
- No wire change. A `reply.submit` with a non-empty `message`, no `choice`, no `choices` and no
  `answers`, on a case that has options or questions, is feedback on the page. The app sends it from
  the answers bar ("Send feedback") and from the options bar when no option is picked. Pinned comments
  travel with it as usual.
- The reply text to the agent starts, after the "Reply to ..." line, with "The human wants changes to
  the page before deciding. They chose nothing. Revise the artifact or the text, then send a new round
  with waggle_update on this case." The `Message:` line follows. The daemon decides this from the shape
  of the reply, so a chat-connector free-text reply on such a case reads the same way.
- The case goes to `waiting_on_agent` like any reply and is not `done`. The app words the status as
  "working on your feedback" while that reply is the latest.

Closing update (HAIL-152, operator decision 3 Oct):
- `done: true` (optional boolean) marks the update as a closing note: the work is finished and no
  answer is needed. A done update cannot carry `options`, `recommendation`, `recommendation_why`,
  `select` or `max`; the schema rejects it. Without `done` an update behaves as before.
- The daemon adds the message (and the revision, if any) and sets `Case.done_at`. The case goes to
  `waiting_on_agent` (a case already dismissed stays `resolved`) and never to `needs_you`. It starts
  no "not picked up" timer and offers no Nudge: `session.nudge` answers `already_picked_up`, and the
  Codex stop check ignores it. A later update without `done` clears `done_at` and returns the case to
  `needs_you`.
- `Case.done_at` is the ISO time of the done update, or null. An old app ignores the field and shows
  the case as an answered ask in "Waiting on agent".
- The app shows "Done · <first line of the message>" with a "Got it" button. Got it is `case.dismiss`:
  it closes the case locally and creates no reply, so nothing reaches the agent. Opening the ask shows
  the full message and the artifact.
- `case.wait` on a done case with no queued reply settles at once with "This case is closed as done.
  No answer will come." The shim's `waggle_update` result for a done update says the case is closed,
  no answer will come, and the agent must not wait or call `waggle_check`.
- Chat connectors do not send a done update: a connector sends an ask when the case is created only.

Progress note (WAG-377, operator decision, case c_840b440d):
- `working: true` (optional boolean) marks the update as a progress note: the agent is still working
  and needs no answer yet. A progress note carries only a `message` (and `sources`, `session_title`).
  The schema rejects `working: true` together with `done`, `items`, `options`, `artifact` or `stage`.
  Without `working` an update behaves as before. The legacy `knock_update` alias shares the schema.
- The daemon stores the message with `messages.working = 1` (migration 46) and sets the case to
  `waiting_on_agent` (a case already dismissed stays `resolved`) and clears `done_at`. It never sets
  `needs_you`, so no macOS notification, badge count or chat connector ask comes from it.
- `Case.working_note` (string or null, additive) holds the note text while the agent's newest message
  is a progress note and the human has sent no reply since. It is null after any real round (an
  update without `working`, with items or with an artifact), a reply or a dismissal. An old app ignores
  the field.
- `Message.working` (`true` or absent, additive) marks each stored progress note, not only the newest
  one, so the Conversation tab can fold back-to-back notes into "Worked: N steps". Other messages omit
  it. An old app ignores the field.
- The app shows a pulsing "Working on it" line with the note on the agent side, and folds the earlier
  options (collapsed, not deleted). The human can still type a free reply.
- The shim's `waggle_update` result for a progress note tells the agent to keep working and not to
  call `waggle_check`.

### `waggle_guide` (HAIL-38)

Deeper guidance the instructions text is too short to hold, modelled on pen.dev's `read_skill` and
Decode's `get_instructions`. Input `{ "topic"?: "string" }`.

- No `topic`: returns a short index, one row per topic (`topic`, "when to read it"), as plain text.
- `topic` set to one of the index's topics: returns that guide's full markdown text (WRONG / right
  examples, and for `artifacts`, ready templates).
- `topic` set to anything else: an MCP error, `Unknown guide topic "<topic>". Valid topics: <list>.`
  - not the schema-validation path, since the useful response here is the list, not a bare rejection.

Topics (`daemon/src/guide/*.md`, bundled into the compiled binary as text assets, so no separate
install step ships them):
- `writing-an-ask`: title as the question, the need's first line, a short `why`, options spelled
  out, a recommendation with its own short why.
- `artifacts`: choosing markdown vs. `html_bundle` vs. screenshot vs. diagram, a markdown write-up
  skeleton, a self-contained HTML plan/comparison page (inline CSS, no network, readable at 640px
  wide), a diagram template (a Mermaid flowchart), and how to stage an `html_bundle` directory.
- `reviews`: UI review asks, screenshots vs. a prototype, what the human sees.
- `after-the-reply`: applying a reply, `waggle_update`, detail requests, `follows`.
- Desktop flavour (HAIL-163): the shim treats a session as desktop when the runtime is `claude`, it
  cannot nudge and its environment has no `CLAUDE_CODE_*` variable. It then appends the "Desktop app
  note" to the MCP instructions in place of the Claude Code note (`DESKTOP_RUNTIME_NOTE`), and sends
  `flavour: "desktop"` on `guide.get`. The daemon adds `DESKTOP_GUIDE_SECTION` to the index and to
  the `artifacts` topic: keep calling `waggle_check` until the reply arrives (there is no nudge), send
  artifacts as content and not as paths, and pass a `topic`. A Claude Code or Codex session gets
  today's text.
- `whats-new` (HAIL-48 amendment A1): short, agent-facing changes per version - what a later
  release added that an already-open session's cached tool schemas do not show. Starts with 0.1.9
  (open schemas). The one-line notice above points here by name.

### Artifact preset (HAIL-100)

Settings > Artifacts lets the operator pick how agents build the artifacts they send: `quick`,
`visual` (default) or `rich`. The daemon is the only writer of `knock.db`, so the app reads and sets
the preset over `settings.get` / `settings.set` (`key` = `artifactPreset`, the only key). The daemon
stores it in the `settings` table (migration 19, `key TEXT PRIMARY KEY, value TEXT`). Unset, or a
stored value that is no longer valid, reads as `visual`.

`guide.get` (and so `waggle_guide`) for topic `artifacts` appends a `## Operator preferences` section
holding the preset's one-paragraph instructions (`PRESET_INSTRUCTIONS` in `daemon/src/guide`). The
guide is served live, so a change applies to the next `waggle_guide` read. Other topics and the index
are unchanged.

### Default design kit and `waggle_settings` (HAIL-166)

Settings > Artifacts holds one default design kit for the machine. It is optional and off by default.
The daemon is its only writer. It lives in the `settings` table (no migration): key `designKit` (the
current kit, JSON) and key `designKitPrev` (one previous kit, JSON, for Undo).

Kit fields: `design_system` (markdown, at most 1 MB; agents get the first 8 KB), `pen_file` (an absolute path on one line, or
empty; Waggle stores the string and never opens the file), `tone` (text, at most 1 KB), `enabled`
(bool, default false), `updated_at` (ISO time or null) and `updated_by` (`"you"`, or
`"<runtime>:<session id>"` for an agent; null while unset). No brand field.

RPCs (app and shim, no `session.hello` needed):

- `design_kit.get` `{}` → `{ kit, can_undo }`.
- `design_kit.set` `{ design_system?, pen_file?, tone?, enabled?, updated_by? }` → `{ kit, can_undo }`.
  At least one kit field. `updated_by` absent means `"you"`. A set that changes no field stores
  nothing. A real change saves the kit it replaces as the previous kit. A bad value is `-32602` with
  a message that names the field, the size and the limit.
- `design_kit.undo` `{}` → `{ kit, can_undo: false }`. Restores the previous kit as a change by
  `"you"` and drops the previous kit. With none, `-32602`.
- `waggle_settings` `{ action: "get" | "set", design_system?, pen_file?, tone?, enabled?,
  artifact_preset?, updated_by? }` → `{ kit, can_undo, artifact_preset }`. This is the call behind the
  MCP tool of the same name. `set` checks every field before it writes any, then writes the kit
  fields and the preset. The shim fills `updated_by` with `<runtime>:<session id>`.

MCP tool `waggle_settings` (the shim relays it; the daemon validates). `get` returns the kit and the
artifact preset. `set` changes any of `design_system`, `pen_file`, `tone`, `enabled`,
`artifact_preset`. The tool description tells agents to propose a kit from the project's design.md,
and to confirm with the person in Waggle before they turn the kit on or replace a design system that
is not empty. `waggle_guide` topic `design-kit` has a short note on the tool.

Guide: `waggle_guide` (shim side, like the project kit of HAIL-160) adds the default kit to the
`artifacts` topic and the index when the kit is enabled, has text in at least one field, and the
project has no `.knock/design-kit.md`. A project kit always wins. The kit is written in the same
markdown shape as `.knock/design-kit.md` (`## Design system`, `## Pen file`, `## Tone of copy`;
empty fields are left out), under `## Default design kit`, and the design system is cut to its first 8 KB at a line break, then the line "(Design kit cut at 8 KB. Ask the person in Waggle for the rest if you need it.)". Disabled or empty: the
guide is unchanged. The app and the daemon never read or write a project's files for this.

Transport note: the shim client now writes a request in parts when the unix socket takes fewer bytes
than the line (about 8 KB on macOS); before, a request line over that size was cut.

### Ask preferences (HAIL-101)

Setup step 3 and Settings > Asks let the operator say what agents bring them. Three more
`settings.get` / `settings.set` keys, stored in the same `settings` table (JSON text per key):

- `askTopics`: `{ scope: "any" | "pick", picked: AskTopic[] }`. Default `{ scope: "any", picked:
  [design, code, writing, reviews, private_info] }`. `AskTopic` is `marketing`, `design`,
  `operations`, `pricing`, `code`, `writing`, `data`, `personal`, `reviews` or `private_info`.
  `picked` counts only while `scope` is `pick`; an empty pick reads like `any`.
- `askFrequency`: `blocked` \| `choice` (default) \| `chat`.
- `askDetail`: `brief` (default) \| `rich`.
- `askReach` (HAIL-109): `everything` (default) \| `written` \| `visual`. Below `everything` the text adds one
  sentence on what stays in the terminal and drops ", not in the terminal," from the first sentence.
  HAIL-193 adds `off` (left of `visual`): the text says to ask everything in the terminal, and the shim
  answers `waggle_ask` with a short text and creates no case. Each tool call of a running shim reads
  `askReach`; when it differs from the level the shim last knew, the result gains one line "Waggle mode
  changed: <mode>. <what to do>". Mode names: Off, Things to look at (`visual`), Look and read (`written`),
  Everything.
- Not set up (HAIL-193): while the data folder has no `onboarded` marker (written by the app when setup
  ends), the shim starts no daemon and every tool replies "Waggle is not set up for this person. Ask in the
  terminal." (not an error).
- `askWords` (HAIL-140): `asd` (default) \| `normal`. `asd` asks for ASD-STE100 Simplified
  Technical English: the served text gains a "Write asks in ASD-STE100" section and the daemon
  warns (never rejects) when an ask breaks its limits. `normal` serves today's text and warns
  nothing.
- `askLearn` (WAG-384): `short` (default) \| `diagram` \| `steps` \| `try`. How the person likes to learn;
  it shapes an agent's answer to a "how it works" request. `askText` gains one line for the chosen style:
  "When the human asks how something works, explain only the part they name. <style>. Cite the files you
  read." (`short`: "Answer in up to 3 short lines"; `diagram`: "Start with a diagram of the parts, then up to
  3 short lines"; `steps`: "Use numbered steps"; `try`: "Send a small html_bundle they can click through").
  The line is left out when `askReach` is `off`. An unset or invalid value reads as `short`; an older app
  never sets it. The `after-the-reply` guide ("How it works") tells the agent how to answer each style.
  `waggle_settings` does not show it (as with `askWords`).
- `askAfterDecide` (WAG-385): `none` \| `record` \| `record_tasks` (default). What the agent does once the
  human has decided ("AFTER YOU DECIDE" in Settings > Requests). It is not part of `askText`: it reaches the
  agent in the reply. When the reply is a decision (`intent: "decision"` that chose something; not Keep talking,
  and not a message with no pick), the reply text from `waggle_check` ends with one more line.
  `none`: no line. `record`: "Now write the decision record: call waggle_guide with topic decision-record ...
  send it with waggle_update on this case (done: true, artifact named Decision record)." `record_tasks`: the
  same, plus "Then plan the tasks from the record: each task has acceptance criteria and names the record line
  it comes from." An unset or invalid value reads as `record_tasks`; an older app never sets it. The
  `decision-record` guide topic holds the template (Question and choice, Why, Constraints, Ruled out, Comments,
  Open questions, Sources), the path `docs/decisions/<yyyy-mm-dd>-<slug>.md` (or the repo's own decisions
  folder) and the task rules. The `project` guide tells the agent to read `docs/decisions/` before it asks.
  Waggle never writes into the repo: the agent writes the record. `waggle_settings` does not show it.
- Done after a decision (WAG-385): `waggle_update` with `done: true` and an artifact is accepted on a case that
  is already decided (replied, or dismissed). The artifact is stored as the next revision, the message is the
  last round, and the case waits for Got it (a dismissed case stays resolved). No daemon change was needed:
  the store never refused it; `test/wag-385-after-decide.test.ts` pins it.
- The two "how it works" requests (WAG-384) are plain Keep talking messages (`intent: "discuss"`, no pick),
  so the case stays open with its options and the agent answers with `waggle_update`. From the "Ask for" row
  or panel: `Explain how the code behind this decision works.` (usage `detail_format_picked`, `variant`
  `how_it_works`). From a text selection (the "Explain" button or the key E):
  `Explain how this works: "<selected text>"`, the quote cut at 300 characters with `…`.

`settings.get` also reads the derived key `askText`, the text agents get (`askAgentText` in
`daemon/src/guide/asks.ts`: one preference sentence plus one Detail sentence, then the
ASD-STE100 section while `askWords` is `asd`). `settings.set` rejects `askText`. Unset or invalid
stored values read as the defaults.

The text reaches agents two ways: `waggle mcp` reads `askText` after `session.hello` and appends
`## Operator preferences · asks` to its initialize instructions (it waits at most 4 s, then serves
the plain instructions; an older daemon without the key does the same), and `guide.get` with no
topic ends the index with the same section. Running sessions see a change the next time they read
the index. The `artifacts` topic and its `## Operator preferences` section are unchanged.

### Decide and Keep talking (WAG-310, WAG-313)

A reply has two outcomes. **Decide**: the human picks (or writes) the answer to every item and the agent goes ahead;
the case moves to `waiting_on_agent`. **Keep talking**: the human has not decided and the case stays open. Keep talking has
five forms, on the old wire: lean (`intent: "discuss"` with `leaning`), rule out (`discuss` with `ruled_out`), ask
(`discuss` with a `message`), more detail (`intent: "more_detail"` with `format`) and comments only (a `decision` with a
`message` or comments and no pick, on an ask that offers something to pick, WAG-285). The daemon classifies a reply with one
function, `replyOutcome(case, reply)`: `talk` for `more_detail` and `discuss` and for a comments-only reply, else
`decide`. `Reply` and `ReplySummary` carry the result as optional `outcome: "decide" | "talk"`. It is computed on
read and never stored. `Reply.intent` keeps its three values; the daemon sends no new one. An older app ignores `outcome`.

Item answers (additive). `reply.submit` and `reply.replace` take optional
`item_answers: [{ item_id, choice? | choices? | text?, note? }]` (exactly one of `choice`, `choices` or `text` per
entry). `choice` and `choices` stay and mean item 0 of a single-item ask; legacy `answers` keys
`<question id>/<point id>` map to item ids. On a multi-item ask a Decide reply with `item_answers` must answer every
item (a missing one is rejected, naming the item); legacy `answers` stay partial. On a multi-item ask a `leaning` or
`ruled_out` entry is `<item id>/<option id>`; on a single item it is the plain option id. The app offers lean and rule out
on single-item asks only; the wire accepts both (operator decision Q5). The stored reply returns `item_answers` and
fills the old fields (`choice`, `choices`, `answers`, `message`), so an old app reads it.

WAG-328: an entry may carry `confirmed: boolean`. `true` means the person chose it. `false` means it is only a
pre-selected recommendation: when the choice equals the item's recommendation on a Decide reply, the daemon stores the
reply as `discuss` with no choice (a reply with nothing else to send is refused). The field is never stored or returned.
An entry without it, from an older app, keeps the old rules.

The reply text to the agent keeps its three old forms. A single-item reply keeps the exact `Choice:` and `Choices:` lines, a
`questions` reply keeps `Q3 · point 1: ...`. A reply to a multi-item ask built from items adds:

```text
Answers:
Item 1 (Which layout?): a (Compact) · note: keep it small
Item 2 (Which areas?): x (Cart), z (Profile)
Item 3 (Any other idea?): Ship in two steps
```

A Keep talking reply on an ask with options starts with the "wants changes ... They chose nothing" sentence (see
"Feedback without a decision"). A review is such an ask since the review shortcut has options, so a review comment
with no pick reads that way.

### Reply intent and the "more detail" request (HAIL-33)

`reply.submit` carries `intent: "decision" | "more_detail" | "discuss"`, default `"decision"` so an older client
that never sends it is unaffected. A `more_detail` reply carries an optional `message` (the human's
question) and no `choice`; the case still moves to `waiting_on_agent`, and delivery states are
unchanged. When the agent picks it up via `waggle_ask`/`waggle_check`/`case.wait`, the payload is not
the usual "Reply to ..." text: it starts with the fixed phrase below, then the question, then one
fixed instruction sentence:

```text
The human wants more detail before deciding: Why don't we make the button blue?
Reply by calling waggle_update on this case with an explanation and the most useful artifact
(markdown for reasoning, html_bundle for a prototype or a chart), then call waggle_check to
wait for the decision.
```

#### The "discuss" reply (WAG-301)

`intent: "discuss"` means the human has not decided. They lean to some options, rule some out, or ask
a question. It carries `leaning: string[]` and `ruled_out: string[]` (option ids, both optional, no id
in both) and an optional `message`. At least one of the three is not empty. Only a discuss reply may
carry `leaning` or `ruled_out`. An id must belong to the ask's newest option set, or else its first
one. `reply.replace` takes the same two fields for a queued discuss reply (the intent itself never
changes, except that a queued discuss reply replaced with a `choice`, `choices` or `answers` becomes a `decision`). The reply has no `choice`. It is stored in `replies.leaning_json` and `replies.ruled_out_json`
(migration 40, which also widens the `intent` CHECK).

The case moves to `waiting_on_agent`, never `resolved`, and the discuss reply does not count as an
answer to a plan round. The payload for the agent is the usual "Reply to ..." line, then:

```text
The human has not decided. They want to talk it over first.
Leaning: Compact, Detailed
Ruled out: Wizard
Message: Does the sidebar hide on a phone?
Answer the message, or revise the ask, with waggle_update on this case. You may drop the ruled-out
options or send new ones. The ask stays open. Then call waggle_check to wait for the decision.
```

`Leaning` and `Ruled out` list option titles, and each line is left out when its list is empty. Chat
connectors do not offer lean or rule-out. They show a discuss reply in their history as "Talking it
over on your Mac".

A `more_detail` reply may also carry `format: "eli5" | "diagram" | "page"` (HAIL-139): how the human
wants the explanation back. Older clients that omit it are unaffected. When a format is present the
payload puts one extra imperative line between the fixed phrase and the human's question, exactly
`DETAIL_FORMAT_LINES` in `daemon/src/store.ts`:

```text
The human wants more detail before deciding:
Explain it as a diagram: one Mermaid or SVG diagram of the flow or the parts, with short labels.
Send it with waggle_update as a diagram artifact (see waggle_guide artifacts); if diagram is not
available, as an html_bundle with an inline SVG.
Why don't we make the button blue?
Reply by calling waggle_update on this case with an explanation and the most useful artifact
(markdown for reasoning, html_bundle for a prototype or a chart), then call waggle_check to
wait for the decision.
```

The three format lines are: `eli5` ("Explain it again like I'm five: short sentences, everyday
words, one concrete analogy, no jargon. Then say in one line what the choice means for me. Send it
with waggle_update as markdown."), `diagram` (as above), and `page` ("Explain it as a short
interactive page: one self-contained html_bundle, offline, no external links or fonts from the
network. Send it with waggle_update."). `format` is stored on the reply and denormalized onto `Case`
as `latest_reply_format` the same way `latest_reply_intent` is, so the app's thread row shows the
chosen format ("Asked for more detail · as a diagram") after a relaunch.

The agent answers on the same case with `waggle_update` (a message plus a `markdown` or `html_bundle`
artifact), then waits again with `waggle_check`. When that `waggle_update` arrives, the case returns to
`needs_you` with the M9 "v2 arrived" treatment; the new artifact and the agent's message show above
the reply options.

### Reply payload (returned to the agent)

MCP content array, in this order:
1. Text block:

```text
Reply to "Checkout layout: compact or detailed?" (case c_01J…)
Choice: a (Compact)            ← omitted when none
```

For a select `"many"` ask (HAIL-123) the choice lines are instead:

```text
Choices: a, c                  ← "Choices: none" for zero ticks
- a: Compact                   ← one line per choice: id, then the option title (label if no title)
- c: Cards
```

The text block then continues as below (the note and comments follow as usual):

```text
Message: Go with A. Two fixes:  ← omitted when empty
Comments on revision 2, capture 1:
[1] (region x=0.12 y=0.31 w=0.76 h=0.06) Default this to Monthly.
[2] (region x=0.06 y=0.88 w=0.88 h=0.07) Keep the pay button above the fold.
```

   The number in `[n]` is case-wide (HAIL-75): 1, 2, 3 across all captures in the order the
   comments were made, so a later capture's first comment may read `[3]`. The same number is drawn
   on that capture's image.

2. One image block per capture that has comments: the capture PNG with numbered boxes drawn on it
   (the app renders it, see `reply.submit`). For a `screenshots` artifact (HAIL-40), each image of
   the artifact is its own capture (see "Artifacts" below); its text line reads "Comments on
   Screen <n>[ · <caption>]:" instead of "Comments on revision <n>, capture <m>:" - the app sets
   this label on the capture's `note` field when it builds the reply.

Text comments (HAIL-150) add one block after the capture blocks, one per revision, with no image:

```text
Comments on the explanation (v1):
[1] "the quoted text" - the note
[2] "A long quote keeps its start...and its end" - the note
```

A quote longer than 123 characters keeps its first 60 and last 60, with `...` between. Line breaks in
a quote show as single spaces. The number is the same case-wide `n`.

### Comments on the text of a request (WAG-357)

A comment can anchor to the text of the request itself. The `anchor` of a comment then has a second kind
beside the markdown `TextAnchor` (`kind: "text"`). The change is additive. An old comment decodes unchanged.

```json
{ "kind": "ask_text", "part": "title|need|why|question|recommendation|pro|con|source",
  "item_id": "q1", "option_id": "a", "source_id": "s1",
  "quote": "the plain words", "start": 4, "end": 19 }
```

- `part` says where the words are. `item_id` goes with `question` (and with `pro`/`con` of an item option).
  `option_id` goes with `pro` and `con`. `source_id` goes with `source`. All three are optional.
- `quote` is the plain text on screen: markdown marks and `[[s:id]]` source markers removed. `start` and
  `end` are UTF-16 offsets into that plain text, `end` exclusive. The round is the newest round.
- `n` is the same case-wide number as for every other comment, in the order the person made them.

The reply text lists them after the text comments, one block:

```text
Comments on the request:
[3] On the title, "quoted words": the note
[4] On a pro of "Option title", "quoted words": the note
[5] On the question of "Item question", "quoted words": the note
```

The part reads in plain words: the title, what I need, the why, the question, the recommendation, a pro,
a con, a source. A long quote is trimmed like a text comment quote. Markdown and region comments read as before.

### Attached files (WAG-345)

A person can attach files to any reply from the comment bar: a decision, Keep talking, an ask answer
or comments. The change is additive. An older agent, shim or app keeps working.

- **App to daemon.** The app copies each file into `KNOCK_HOME/incoming/<uuid>/<name>`, one folder for
  each file. `reply.submit` then takes `attachments: [{ name, incoming_path, type? }]`. `reply.replace` takes
  the same list. A file the queued reply already holds is named by its stored `path` instead of
  `incoming_path`. On `reply.replace`, an omitted `attachments` keeps the files and an empty list drops them.
- **Limits.** At most 10 files in a reply. At most 25 MB for each file (`MAX_REPLY_ATTACHMENTS`,
  `MAX_ATTACHMENT_BYTES`). The daemon checks both and answers `-32004` with the file name. The app checks
  them first and shows a message at the bar. The daemon only reads a path inside `KNOCK_HOME/incoming/`.
- **Storage.** The daemon copies each file to `KNOCK_HOME/attachments/<reply id>/<name>`, makes the copy
  read-only (mode 0444), then removes the incoming folder. The name has no folder part. A second file with
  the same name becomes `<stem> 2.<ext>`. The list is stored in `replies.attachments_json`
  (migration 42, `NULL` for a reply with no files). `cases.purge_resolved` removes the files of a purged case.
- **Reply.** `attachments: [{ name, path, size, type }]`. `path` is absolute. `type` is a MIME type: the
  app's hint when it looks like one, else a guess from the extension, else `application/octet-stream`. The field is
  absent when there are no files.
- **Keep talking.** Files alone, with no pick, are a Keep talking reply (`intent: "discuss"`, WAG-328). A
  discuss reply needs leaning, a rule-out, a message, comments or files.
- **Check text.** After the message and the comments, before the edit lines, the daemon adds:

```text
Attached: 2 files
- shot.png: /Users/…/Knock/attachments/r_01J…/shot.png
- brief.pdf: /Users/…/Knock/attachments/r_01J…/brief.pdf
```

  The daemon writes this text, so an agent with an older shim sees the paths with no change. The agent
  reads the files at those paths.

### Edit docs in place (HAIL-168)

On a `markdown` revision the person can press Edit, change the text in place and press Done. The
app calls `revision.add_by_human { case_id, base_revision, markdown }`. The daemon stays the only
writer: it stages the markdown like any markdown revision (`blobs/<sha256>.md`), stores it as the
next revision `n` with `author: "you"`, `base_revision` (the revision the person started from) and
`passages_changed` (the number of separate groups of changed lines in a line diff of the two texts),
and emits `revision.added`. It returns that `Revision`. The base must be a `markdown` revision of
the case; any other base gives an artifact error (-32004). The text is at most 1 MB.

`Revision` now has `author: "agent" | "you"`. A revision by `"you"` is not an agent update: it does
not count in `revision_count` or `latest_revision_at`. The generic shape (case id, base revision,
markdown) is meant to carry over when Waggle moves versions into option artifacts.

`reply.submit` and `reply.replace` take an optional `edit: { revision }`, the revision by `"you"` to
attach to the reply (any other revision gives an artifact error). `reply.replace` without `edit`
drops it (the Remove button); the revision stays in history. A `Reply` that carries an edit has
`edit: { revision, base_revision, passages_changed }`.

The reply payload (`waggle_ask` and `waggle_check`) then ends with these lines:

```text
The person edited your document: v2 is their version, made from v1. 2 passages changed. Use their version as the base.
Diff v1 to v2:
```diff
--- v1
+++ v2 (by the person)
@@ -3,1 +3,1 @@
-We cache for **ten** minutes.
+We cache for **five** minutes.
```
The new text (v2):
~~~~markdown
…the full markdown of v2…
~~~~
```

The unified diff has 2 lines of context. The `waggle_guide` topic `after-the-reply` tells the agent:
"When the person edits your document, use their version as the base."

Safe markdown still holds: the app saves only the supported markdown (headings, bold, italics,
inline code, lists, paragraphs, pipe tables). It never writes a link, an image or HTML into the text.

### Errors that say what to tell the user (HAIL-38)

Most MCP errors are for the agent to fix by calling again (a bad field, an artifact path that does
not resolve, checking another session's case) and stay technical - the agent reads them, not the
human. A few errors need the opposite human's help to fix, and the agent cannot fix them by
retrying alone. For those, the shim (`daemon/src/mcp/errors.ts`, `translateDaemonError`) rewrites the
raw failure into text that starts with one exact sentence for the agent to relay verbatim, prefixed
`Please tell the user: `, followed by an instruction not to add a socket path, a port, a file path,
or any other technical detail the human cannot act on:

- The daemon is unreachable (never started, or the 3 s on-demand start in `docs/SERVICE.md` never
  became reachable) - covers both "the daemon isn't running" and "the app is closed", since opening
  the app also starts the daemon on demand:
  ```text
  Please tell the user: Waggle isn't running. Please open Waggle and tell me when it's ready.
  Do not mention sockets, ports, or other technical details. Once they say it's ready, call the
  same tool again.
  ```
- A rejected artifact path from a stale shim (`NOT_STAGED_BY_SHIM`, see Artifacts): the fix is
  restarting the coding session, which only the human can do:
  ```text
  Please tell the user: Waggle was updated, and this coding session is still using the old
  connection to it. Please close and reopen this coding session, then tell me when you've done
  that.
  Do not mention shims, sockets, or file paths. Once they say it's done, call the same tool again.
  ```

The two fixed sentences (`DAEMON_UNREACHABLE_ERROR`, `SHIM_OUTDATED_ERROR`) live in
`daemon/src/protocol/errors.ts` so both the shim and any future direct caller read the same text.

## Socket RPC (JSON-RPC 2.0, one JSON object per line)

App and CLI methods:

| Method | Params | Result |
|---|---|---|
| `cases.list` | `{ status?: "needs_you" \| "waiting_on_agent" \| "resolved" }` | `Case[]` |
| `cases.get` | `{ id }` | `CaseDetail` (case, task, messages, revisions, comments, replies). Reply captures are `CaptureSummary`, no image data |
| `artifact.path` | `{ case_id, revision }` | `{ kind, root, entry }` absolute staged path, or for a `screenshots` revision `{ kind: "screenshots", root: "", entry: "", items: [{ path, caption? }, ...] }`. For an `html_bundle` that declared one (HAIL-49): `viewport: { width, height }` and/or `preview: { kind: "html" \| "image", path }` (`path` absolute, inside `root`) |
| `reply.submit` | `{ case_id, idempotency_key, choice?, choices?: string[], message?, comments: Comment[], captures: Capture[], intent?: "decision" \| "more_detail" \| "discuss", leaning?: string[], ruled_out?: string[], format?: "eli5" \| "diagram" \| "page", source?: "mac" \| "telegram" \| "slack", edit?: { revision } }` | `Reply` with `CaptureSummary` captures |
| `reply.retry` | `{ reply_id }` | `Reply` with `CaptureSummary` captures (same id; never a second reply) |
| `reply.hand_over` | `{ reply_id }` | `Reply` (WAG-410). Marks a `failed` reply `handed_over`. Any other state is returned unchanged. Unknown id: `-32001` |
| `revision.add_by_human` | `{ case_id, base_revision, markdown }` | `Revision` (author `"you"`, HAIL-168) |
| `reply.replace` | `{ reply_id, edit?: { revision }, choice?, message?, comments: Comment[], captures: Capture[] }` | `Reply` with `CaptureSummary` captures (same id; queued only) |
| `capture.image` | `{ capture_id, which: "raw" \| "annotated" }` | `{ capture_id, which, png_base64 }` (error `-32001` for an unknown capture) |
| `case.dismiss` | `{ case_id }` | `Case` (resolved, `dismissed_at` set) |
| `case.restore` | `{ case_id }` | `Case` (`dismissed_at` cleared, prior status restored) |
| `events.subscribe` | `{}` | stream of `Event` notifications |
| `session.nudge` | `{ case_id }` | `{ sent: true }` or `{ sent: false, reason }` with `reason` = `session_closed` \| `not_supported` \| `already_picked_up` \| `rate_limited` \| `post_failed` (HAIL-76, see "Reply not picked up"). Unknown case: `-32001` |
| `session.send_prompt` | `{ session_id, text }` | `{ sent: true }` or `{ sent: false, reason }` with `reason` = `session_closed` \| `not_supported` \| `post_failed` (HAIL-169). The text goes to the session's mod as one prompt, submitted as if typed; a busy session takes it when its turn ends. Needs a live session with an attached mod (`not_supported` otherwise). The text is never stored or logged |
| `sessions.list` | `{}` | `SessionInfo[]`: `{ id, task_id, runtime, task_name, project, branch, cwd, pid, can_nudge, client_name, state, connected_at, last_seen_at }`. Live first, then disconnected, then ended, each newest `last_seen_at` first. `task_id` matches `Case.task_id`; `cwd` is the session's folder (HAIL-59); `pid` is the shim's parent pid, which the app walks up to the terminal app (HAIL-76); `client_name` (HAIL-173, nullable) is the MCP client that started the shim, see "MCP client name" below. Optional `context` (HAIL-72), see "Session context" below |
| `mod.report` | `{ session_id, event, tool?, case_id?, count?, source?, cwd? }` | `{ ok: true }` (HAIL-134, see "Claude Code plugin and mod") |
| `mod.poll` | `{ session_id, wait_ms?, seen?, mod_version? }` | `ModPollResult` (HAIL-134) |
| `case.open` | `{ case_id? }` | `{ ok: true }`; emits `case.open_requested` (without `case_id`: the app comes forward on its queue). Unknown case: `-32001` (HAIL-134) |
| `service.status` | `{}` | `{ version, data_root, sessions_live, cases_open, exec_path }` |
| `service.restart` | `{}` | `{ ok: true }` |
| `usage.record` | `{ event, source?, artifact_kind?, after_s?, variant?, case_id?, format?, n? }` | `{ ok: true }` |
| `usage.tool_call` | `{ tool, duration_ms, wait_ms, result, session_id?, client_name?, case_id?, artifact_kind?, error_code?, request_bytes, response_bytes, images }` | `{ ok: true }` (HAIL-195, WAG-409, shim only, see "Usage log: tool calls") |
| `usage.context` | `{ session_id, tool, input, cache_read, cache_creation, output }` | `{ ok: true }` (HAIL-195, from `waggle mod usage`) |
| `usage.summary` | `{ days? }` | `UsageSummaryResult` (HAIL-195) |
| `usage.export` | `{ path }` | `{ json_path, csv_path, tool_calls, usage_events, notes }` (HAIL-195, WAG-366) |
| `usage.control` | `{ record?, transcript?, export_text?, delete? }` | `{ record, transcript, export_text, retention_days, tool_calls, usage_events, deleted }` (HAIL-195, WAG-366) |
| `mcp.manifest` | `{}` | `{ daemon_version, tools: [{ name, description, inputSchema, annotations }] }` (HAIL-48, see "Live tool manifest" above) |
| `guide.get` | `{ topic? }` | `{ text }` (HAIL-48; same content and unknown-topic message as `waggle_guide`) |
| `settings.get` | `{ key }`, `key` = `artifactPreset` \| `askTopics` \| `askFrequency` \| `askDetail` \| `askReach` \| `askWords` \| `askLearn` \| `askAfterDecide` \| `askText` | `{ key, value }`; defaults when unset (HAIL-100 "Artifact preset", HAIL-101 "Ask preferences", HAIL-140 "Ask words") |
| `settings.set` | `{ key, value }` for any key but `askText` | `{ key, value }`; any other key or value is `-32602` (HAIL-100, HAIL-101, HAIL-140) |
| `design_kit.get` | `{}` | `{ kit, can_undo }` (HAIL-166, see "Default design kit") |
| `design_kit.set` | `{ design_system?, pen_file?, tone?, enabled?, updated_by? }` | `{ kit, can_undo }`; a bad value is `-32602` |
| `design_kit.undo` | `{}` | `{ kit, can_undo }`; no previous kit is `-32602` |
| `waggle_settings` | `{ action, design_system?, pen_file?, tone?, enabled?, artifact_preset?, updated_by? }` | `{ kit, can_undo, artifact_preset }` (the MCP tool's call) |
| `connectors.status` | `{}` | `{ telegram: TelegramStatus, slack: SlackStatus }` (HAIL-144, HAIL-145, see "Chat connectors") |
| `connectors.telegram.check_token` | `{ token }` | `TelegramStatus`; a refused token is `-32010` with plain words (HAIL-144) |
| `connectors.telegram.start_pairing` | `{}` | `TelegramStatus` with the one-time `code` (HAIL-144) |
| `connectors.telegram.send_test` | `{}` | `{ ok: true }` (HAIL-144) |
| `connectors.telegram.disconnect` | `{}` | `TelegramStatus` (state `off`) (HAIL-144) |
| `connectors.slack.check_tokens` | `{ app_token, bot_token }` | `SlackStatus`; a refused token is `-32010` with plain words (HAIL-145) |
| `connectors.slack.look_up_app` | `{ bot_token }` | `SlackStatus` with `app_id` filled when Slack names the app; saves nothing (HAIL-148) |
| `connectors.slack.start_pairing` | `{}` | `SlackStatus` with the one-time `code` (HAIL-145) |
| `connectors.slack.send_test` | `{}` | `{ ok: true }` (HAIL-145) |
| `connectors.slack.disconnect` | `{}` | `SlackStatus` (state `off`) (HAIL-145) |
| `cases.resolved_stats` | `{}` | `{ count, bytes }` (HAIL-52, see "`cases.purge_resolved`" below) |
| `stats.corrections` | `{ project?, weeks? }` | `{ project?, weeks: [{ week, starts, asks, corrections, per_ask }] }` (WAG-414, see "Corrections") |
| `cases.purge_resolved` | `{}` | `{ purged_cases, freed_bytes }` (HAIL-52, see "`cases.purge_resolved`" below) |
| `cases.auto_decided` | `{ since? }` | `Case[]` decided by a rule (WAG-412, see "Ask less") |
| `case.change_mind` | `{ case_id }` | `Case`, open again (WAG-412, see "Ask less") |

### Session context (HAIL-72)

`sessions.list` adds an optional `context` to each `SessionInfo`: `SessionContext | null`. It is `null`
(or absent) for Codex, for a session that is not live, and when no transcript is found. No new MCP
tool, no change to `session.hello`.

`SessionContext` is `{ title, goal, said, last_action, last_action_at, recent[], plan, growing?, changes }`. Every
field can be `null` (`recent` can be `[]`). Agent text is already plain (markers stripped) and one line. `goal` skips headings, fenced code and empty
lines of the first prompt; an `Objective: <text>` line wins (HAIL-124). `growing` (optional, HAIL-124) is true when the
transcript was written, or the last action happened, in the last 2 minutes. `live` (optional, HAIL-134) is
the exact state the Claude Code mod reports; see "Claude Code plugin and mod".
`title` is Claude's own session title (the transcript's `ai-title` record). `goal` is the first real user
prompt (up to 110 chars). `said` is the first sentence of the agent's last message. `last_action` is the
last tool call in plain words (the Bash `description` when present, else the command without pipes,
redirects and flags). `recent` is the last 3 actions. `plan` is `{ done, total, current }` from the last
`TodoWrite` or task list. `changes` is `{ files, added, removed, clean, last_commit }` from git in the
session `cwd`, or `null` when it is not a repository.

The daemon (never the app) reads the transcript and runs git. It reads the transcript's first 256 KB and
last 2 MB, caches by file size and mtime, ignores unknown record types and never fails `sessions.list`
on a parse error. Git runs at most every 5 s per folder, with a 2 s timeout. No network.

Finding the transcript: the shim's session id is the Claude Code session id when
`CLAUDE_CODE_SESSION_ID` is set, so the file is `~/.claude/projects/<cwd, every non-alphanumeric char as
"-">/<session id>.jsonl`. When that file does not exist (the shim made up a UUID), the newest non-empty
`.jsonl` in that folder written in the last 2 minutes is used. `KNOCK_CLAUDE_PROJECTS` overrides the
folder (tests).


### Ask less: decide small things by rule (WAG-412)

Off by default. Decision record: `docs/decisions/2026-10-27-fewer-low-stakes-asks.md`.

- **Setting.** `settings.get` / `settings.set` key `askLess`: `{ enabled: boolean, rules: { naming, wording, formatting, tests: boolean } }`.
  Default: everything `false`. The daemon stores it and keeps every rule `false` while `enabled` is `false`.
- **Input.** `waggle_ask` takes an optional `category` string. The fixed list is `naming`, `wording`, `formatting`, `tests`.
  The schema accepts any string up to 40 characters, so a wrong word never rejects an ask: the daemon ignores it and the ask
  goes to the queue. With the master off the daemon ignores `category` too.
- **When the daemon decides.** Only when ALL are true: the master is on; the rule of the category is on; the ask is a `question`
  (never a review, never a plan round); it is one item, `select: "one"`, with a recommendation that names one of its options; it
  replaces no case; and it does not follow a case whose reply is still `queued` or `failed`.
- **Result.** `case.create` returns the case as `resolved` with `auto_decided: { category, rule, choice, answer, at }` (`choice` is the
  option id, `answer` its title). `waggle_ask` returns at once, with no wait, one text block holding this JSON:
  `{ "status": "auto_decided", "decided_by": "rule", "category", "answer", "option_id", "case_id", "next" }`.
- **Storage.** Migration 56 adds `cases.auto_category`, `auto_rule`, `auto_choice`, `auto_answer`, `auto_at`. The case is `resolved`
  with no reply, so it is never `needs_you` (no Dock badge, no notification). The daemon emits `case.updated`, never `case.created`,
  so no phone connector and no share sees it.
- **Change my mind.** `case.change_mind` `{ case_id }` returns the case as `needs_you` again (it clears `auto_at`, so `auto_decided` goes and
  the case leaves `cases.auto_decided`; a case with no rule decision, or with a reply, is returned unchanged) and emits `case.updated`.
  The person then picks an option in the usual pane: a normal `reply.submit`. The reply is queued for the live session (the usual nudge
  applies), or fails with `session_unreachable` when the session ended.
- **`cases.auto_decided`** `{ since?: ISO time }` returns the decided cases, newest first, that have no reply yet.
- **Guide.** While the master is on, the `waggle_guide` index and the `writing-an-ask` topic end with a "small choices" section (ASD-STE100):
  send `category` and a recommendation for a small choice that is easy to undo; never for a choice that deletes data, spends money or ships.
  With the master off the section is absent.
- **Usage log.** Migration 56 adds `usage.category` and `usage.rule_id` and the event `ask_auto_decided`. It holds the category slug and the rule id
  (`ask_less_<category>`), never ask or answer text. `ask_created` carries `category` (slug only) while the master is on. The export has both columns.

### `case.dismiss` / `case.restore` (HAIL-32)

`case.dismiss` sets a case's status to `resolved` and stamps `dismissed_at`, remembering the status
the case held right before the dismiss (so a dismiss from `waiting_on_agent` restores back to
`waiting_on_agent`, not always `needs_you`). It emits `case.updated` and is idempotent: dismissing an
already-dismissed case is a no-op that returns the case unchanged, with no further event. Both RPCs
answer `-32001` ("case not found") for an unknown `case_id`.

If a live `case.wait` is waiting on the dismissed case (the agent is blocked in `waggle_ask` or
`waggle_check`), the dismiss settles it right there: the agent's tool call returns "The human dismissed
this ask without answering." as a normal reply, in the same shape `case.wait` always returns
(`{ reply_id, content }`) - never a timeout, never an error. A `waggle_check` on an already-dismissed
case gets the same message immediately.

`case.restore` is the Undo half: it clears `dismissed_at` and puts the case back in the status
`case.dismiss` recorded, also emitting `case.updated`. Restoring a case that was never dismissed (or
already restored) is a no-op that returns it unchanged.

The CLI exposes both ends of the dismiss half only: `waggle dismiss <case-id>`, or
`waggle dismiss --task "<task name>"` to dismiss every case of one task by name (for clearing test asks,
e.g. `waggle dismiss --task "Waggle test"` after `waggle test-ask`) - the CLI resolves the task name to
case ids with a plain `cases.list` call and dismisses each match; there is no separate RPC for it.

### `cases.purge_resolved` (HAIL-52)

The Data & privacy page's "Clear answered…" action. HAIL-236: it removes every finished case, the same
set `cases.resolved_stats` counts. Finished means nothing is left for the person or the agent: `status:
"resolved"` (dismissed, replaced, or closed with Got it), or `waiting_on_agent` with its latest reply
`delivered` and no pending done note. Never a case that `needs_you`, has a `queued` or `failed` reply,
or is a done case still waiting for Got it. It deletes each case's messages, replies,
comments, captures and revisions, then its staged bundle directory (`bundles/<case_id>/r<n>/`) and any
blob (`blobs/<sha256>.<ext>`) no surviving case's revision still references - blobs are content-addressed
and can be shared, so a shared one is kept. The append-only events log is left untouched. A surviving
case's `follows_case_id`/`replaces_case_id` pointing at a purged case is cleared first rather than left
dangling. Idempotent: purging with nothing finished returns `{ purged_cases: 0, freed_bytes: 0 }`.
The RPC names stay, so an older app keeps working.

`cases.resolved_stats` answers the same question read-only, for the row's own "N answered asks, ~M MB"
line before the operator clicks anything: `bytes` is a gross figure from the resolved set's own
artifacts (it does not discount a blob a surviving case happens to share, unlike `freed_bytes`, which is
exact).

### `reply.replace` (HAIL-34)

An answer is editable up to the moment the agent picks it up: `reply.replace` changes a `queued`
reply's `choice`/`message`/`comments`/`captures` in place, under its existing `reply_id` (never a
second reply). Its prior captures/comments are dropped first - the call sends the full replacement
set, not a delta. `created_at` is never touched (it keeps meaning "first submitted at" for the
"took" duration); `replaced_at` is set to now on every replace, so the app can show "changed HH:MM"
beside the original answer. Rejected once the reply is no longer `queued`: `-32006` with a message
naming why ("the agent already picked it up" for `delivered`, "the reply already failed" for
`failed`). `-32001` ("case not found") for an unknown `reply_id`.

### Reply not picked up: the fallback, and the nudge (HAIL-76)

A reply stays `queued` until the agent calls `waggle_ask` or `waggle_check`. If the agent ended its turn,
nothing picks it up. The app helps the human in two ways. The first needs no protocol call.

- **Copy prompt.** After the reply has been `queued` for 2 minutes (120 s, from `latest_reply_at`),
  the app shows "Copy prompt". It copies the line `Check Waggle for my reply` to the clipboard. The
  human pastes it in the agent's terminal.
- **Show the terminal.** The app takes `SessionInfo.pid` (the shim's parent pid), walks up the
  process tree, and brings the first regular macOS app it finds to the front. It sends no keystrokes
  and uses no AppleScript. If it finds no app, the app hides the button.

Both show for a live session, and also for an ended session (only "Copy prompt", with the line
"start the agent again in this project and paste this line"). They never change the reply state.

**The nudge** (Claude Code only). The nudge wakes a session that ended its turn, by
posting one line into Claude Code's own session inbox socket (mechanism A of the HAIL-76 research).
It is never automatic: a human click starts it. Since HAIL-129 it is on for every session that
reports `can_nudge`. The `labs.nudge` setting is gone.

*The shim.* At start the shim reads `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`.
The token stays in the shim process. The shim never sends it to the daemon and never logs it.
`session.hello.can_nudge` is `true` only when both variables exist and the parent Claude Code is
2.1.224 or later. The shim finds the version from the parent's executable path (the native install
names the binary by its version, `.../versions/2.1.285`), or else from `<parent> --version` when that
binary is named `claude`. An unknown version is `false`. An older shim omits `can_nudge`, which reads
as `false`. The daemon stores the value per session and reports it in `sessions.list`.

*Daemon push.* The daemon sends a JSON-RPC request on the session's own connection:
`session.nudge { case_id, title }` (`title` is the ask title). The shim connects to the inbox socket
and writes two lines, then closes:

```text
{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
{"type":"user","message":{"role":"user","content":"Waggle: the human answered \"<ask title>\". Call waggle_check with case_id <id> now."}}
```

The line holds the ask title and the case id. It never holds the reply: the reply reaches the agent
only through `waggle_check`, which keeps `reply.ack` and AC 8 as they are. The shim answers the push
with `{ ok: true }`, or with an error when the post failed. The error text never holds the token. The
daemon waits at most 10 s for the answer.

*App RPC.* `session.nudge { case_id }` returns `{ sent: true }` or `{ sent: false, reason }`. The daemon
checks in this order:

1. The case's session is not `live`, or has no shim connection: `session_closed`.
2. The case's latest reply is not `queued`: `already_picked_up`.
3. The session said `can_nudge: false`: `not_supported`.
4. The case got a nudge in the last 60 s (the daemon keeps the time in memory; the shim keeps its own
   copy): `rate_limited`.
5. The push failed or timed out: `post_failed`. A failed push does not start the 60 s window.

On success the daemon emits the event `session.nudged` (`{ type, case_id, reply_id, session_id, at }`).
The count of nudges per reply lives in `replies.nudge_count` (migration 17), and `sessions.can_nudge`
holds the flag. Success of the post does not prove the agent woke up. Claude Code may refuse the
message (`crossSessionInbound`), or the agent may be in a long step. The proof is the reply moving to
`delivered`.

*App states* (only for a session with `can_nudge`). The control shows after the same 2 minutes, and
it replaces the primary action of the fallback. "Copy prompt" and "Show the terminal" move into a
small "..." menu next to it. The waiting timer (from the send) keeps running through every state.

| State | When | Copy |
|---|---|---|
| Ready | queued 2 min, session live, `can_nudge` | "It may have finished its turn. A nudge asks it to check Waggle for your reply." [Nudge Claude Code] |
| Nudged | after a click that returned `sent: true` (or `rate_limited`), for 60 s | "Nudged · 12s" (seconds since the nudge) and "If it is in the middle of a long step, it sees the nudge when that step ends." |
| Delivered | the reply becomes `delivered` after a nudge | "Delivered · it woke up and has your answer" |
| Still asleep | 60 s after the nudge, still `queued` | [Nudge again], once per 60 s |

Any other error (`post_failed`, `not_supported`, `session_closed`) drops the nudge control: "Copy prompt"
becomes the primary action again, with one line (for example "Waggle could not post the nudge. Copy the
prompt instead."). The app keeps its nudge records in memory only. The daemon's 60 s window survives
an app restart.

*Hold while the session works (WAG-258).* A nudge posted into a session that is in the middle of a turn
waits behind that turn and starts a second one. The automatic nudge therefore holds while the session is
busy, then looks again: it sends only when the reply is still `queued`. A reply that `waggle_check` took
while the nudge was held is never nudged. The session is busy when the mod reports `working`. A session
without a mod is busy for 60 s after its last session RPC (not the keepalive hello) or after a hello that
brought it back, until a pending `waggle_check` result tells it that it may end its turn
(`KNOCK_WORKING_QUIET_MS` overrides the 60 s). The hold ends after 10 min. A click on Nudge never holds.

*Automatic nudge (HAIL-181).* A reply that becomes `queued` for a case of a `can_nudge` session starts
a nudge with no click, unless a `case.wait` holds the case. The daemon waits 3 s first (`KNOCK_AUTO_NUDGE_MS`
overrides it, `off` disables it), then runs the same checks and the same 60 s window as `session.nudge`.
This is the wake path: the agent may have ended its turn, and the nudge starts a new one that calls
`waggle_check` with the case id. A reply a waiting call takes is `delivered` and never nudged.
WAG-368: the 60 s window never drops this nudge. When the window is taken by a nudge that was sent before the
reply was queued (an earlier reply of the same talk), the daemon sends the nudge when the window ends, if the
reply is still `queued` and no `case.wait` holds the case. A nudge sent after the reply was queued (a click on
Nudge) covers it: no second nudge. The Claude Code mod does not report a subagent's `tool.call`
(the event has an `agentId`), so a background agent does not make an idle session look busy and hold the nudge.

*SDK hosts (WAG-258).* An Agent SDK host (`CLAUDE_CODE_ENTRYPOINT` starts with `sdk-`, for example T3 Code)
can close an idle session. For such a session the `pending` text of `waggle_ask` and `waggle_check` adds:
"The host can close this session when it is idle. Tell the human to send you a message after they answer."
Other hosts keep the text unchanged.

*A reply to a closed session (WAG-258).* A reply submitted while the owning session is `ended` is stored
as `failed` with `reason: session_unreachable` in one write, with one `reply.state_changed` event (not a
`queued` event and then a `failed` one). It is not an error: the session comes back, the daemon queues the
reply again (HAIL-192) and `waggle_check` delivers it. The app says "Saved · delivers when the agent's
session resumes" with Copy reply, and shows no Retry while the session is `ended`. An open ask whose
session is `ended` shows "This agent's session has closed" before the human answers.

*Images.* `waggle_check` and `waggle_ask` replies carry an `image` block only for a capture that has
at least one region comment. A plain choice or text reply carries none. Comment text, regions and
capture references stay in the text block.

Not in scope: hooks, `waggle install` changes, Codex.

### Claude Code plugin and mod (HAIL-134)

Waggle ships to Claude Code as a plugin (`plugins/claude-code/waggle`, marketplace `.claude-plugin/marketplace.json`,
`/plugin install waggle@waggle`). The plugin holds three parts: Waggle's MCP server (`waggle mcp` with
`KNOCK_RUNTIME=claude`, started through `bin/waggle-launcher`), a skill with the ask guidance, and a *mod*
(function hooks, Claude Code 2.1.287 or later). Below 2.1.287 the server and the skill still work.

*One server.* The plugin's server is named `plugin:waggle:waggle`, so its tools read
`mcp__plugin_waggle_waggle__waggle_ask` (the transcript reader treats them like `mcp__waggle__*`, and still reads the
old `mcp__plugin_knock_knock__knock_ask` names). A user-scope
`waggle` entry from `waggle install` would start a second server for the same session. So:
`waggle install claude` adds no entry when `claude plugin list --json` shows an enabled plugin named `waggle` (or the old `knock`),
and removes an older user entry; `waggle doctor` prints `ok Claude Code installed as plugin` and, when both
exist, `fail Claude Code runs Waggle twice ... (fix: waggle install claude)`; `waggle uninstall` removes the
plugin, its marketplace and the user entry. HAIL-135: the app ships the plugin at
`Contents/Resources/claude-plugin` (a local marketplace named `waggle`) and `waggle install claude` installs it
(`claude plugin marketplace add <that path>`, `claude plugin install waggle@waggle --scope user`) when
`claude plugin --help` works; otherwise it keeps `claude mcp add`. `waggle install claude --refresh` updates an
installed plugin and never installs one; the app runs it at launch. `waggle doctor` also prints
`ok Claude Code installed as MCP entry` in the other mode and `fail Claude Code plugin marketplace path
missing: <path>` when the app moved. Settings > Agents shows "Installed as Claude Code plugin"
and a "Remove old entry" button in the two-server case.

*How the mod reaches the daemon.* Only through `$.process.run` on `bin/waggle-launcher` (it finds
the Waggle of its own bundle when it runs in place, the path `waggle install claude` wrote to
`$KNOCK_HOME/knock-path`, `/Applications/Waggle.app`, `~/Applications/Waggle.app` (or `Knock.app` when an update kept the old folder name) or `~/.local/bin/waggle`; `KNOCK_BIN` overrides it for
tests; else exit 127 with a clear message), which runs `waggle mod <verb>`. Each verb makes one RPC, prints one
line of JSON, and starts the daemon on demand. No network call, no socket opened by the mod. The session id is
`$.session.id()`, which is `CLAUDE_CODE_SESSION_ID`, the id the shim says in `session.hello`.

`waggle mod poll --session <id> [--wait-ms N] [--seen SIG] [--mod-version V]` calls `mod.poll`.
`waggle mod report --session <id> --event E [--tool NAME] [--case ID] [--count N]` calls `mod.report`.
`waggle mod open [--case <id>]` calls `case.open` (no case: no RPC), then runs `open -b <KNOCK_BUNDLE_ID or
dev.limone.knock>`.

`mod.report` events: `turn.start`, `turn.complete`, `prompt.submit`, `tool.call`, `nudge.failed`. The params
are a strict object: a prompt text is rejected. Only `tool` (a tool name) and a burst `count` ride with
`tool.call`. `nudge.failed { case_id }` says the mod took a nudge and could not submit it; the daemon gives
the case's nudge window back (once per handed-over nudge).

`mod.poll` is the mod's heartbeat and its one read. It marks the session's mod attached, then answers at once,
or, with `wait_ms` (at most 25000), holds until a case or reply event, a queued nudge, or the timeout. A `seen`
that differs from the current `sig` answers at once. The result is
`{ now, sig, open_ask, open_count, other_open_count, answer, nudge }`:
`open_ask` is the session's oldest ask waiting on the human, `{ case_id, title, created_at, waiting_since }` (`waiting_since` is when the case last started waiting on
the human: its creation, or its latest `waggle_update`; the band's age counts from it);
`open_count` counts the session's own; `other_open_count` counts asks waiting on the human in every other
session; `answer` is the newest answer to an ask of this session, `{ case_id, title, choice, note, answered_at }`
(`choice` is the option's title or label, `null` for a note-only answer; titles, choices and notes are plain
one-line text, cut to 90, 80 and 160 characters); `nudge` is at most one `{ case_id, text }` to submit, and the
poll that returns it takes it. `sig` fingerprints the first four so the mod redraws only on change.

*Live state.* The daemon keeps what the mod reports in memory (never in `knock.db`): `LiveState`
`{ phase: "working" | "idle", since, last_tool, last_tool_at, tool_count, last_event, last_event_at }`.
`turn.start` sets working, `turn.complete` sets idle, a `tool.call` while idle sets working (a missed
`turn.start`), and `prompt.submit` records the event only. State is fresh while the mod polls: attached means
a poll in flight or a poll or report within 45 s. `sessions.list` then adds `context.live`, sets
`context.growing` from `live.phase` (instead of the transcript's write time), and fills `last_action` from
`live.last_tool` when the transcript has none. A session with no mod, or a stale one, keeps the transcript
reading of HAIL-72 and HAIL-124 unchanged. A session whose mod is attached reports `can_nudge: true`.

*Nudge.* `session.nudge` prefers the mod when the case's session is attached: the daemon queues the same
one-line text the messaging socket posts (`nudgeText`), and the next poll takes it; the mod submits it with
`$.prompt.submit`. If no poll takes it within 8 s, the daemon falls back to the messaging socket when the
session has one, else answers `post_failed`. The one-per-case-per-interval rule (HAIL-129) is the same
daemon window for both ways, and the mod keeps its own 60 s window too. A session without the mod is nudged
by the messaging socket as before (HAIL-76).

*The band.* The mod draws only on the `AbovePrompt` site (terminal and the Desktop Code tab), with `Box`,
`Text` and `Button`. With no open ask: nothing. In the first 60 s of an ask: nothing. From 60 s to 10 min: a dim
`Still waiting on your answer in Waggle · <age>` and `o: open`. After 10 min: `Waggle · waiting on your answer ·
<title> · <age>` in Waggle's colour. After an answer (not one that was there before the mod loaded): a toast
`Waggle · answered: <choice>` and a line `Waggle · you chose <choice> · "<note>"` until the next main-session
turn completes. When `other_open_count` is above 0 on an ask line, `+N in other sessions · q: queue` is
added on the right. `o` opens the app on the ask (`case.open`), `q` brings the app forward. The age redraws
every 15 s while an ask is open and no timer runs otherwise.

### Codex plugin and hooks (HAIL-137)

Waggle.app ships a Codex plugin at `Contents/Resources/codex-plugin` (a local marketplace named `waggle`:
`.agents/plugins/marketplace.json` plus `waggle/` with `plugin.json`, `mcp.json`, `skills/waggle/SKILL.md`,
`hooks/hooks.json`, `bin/waggle-launcher`). Verified against codex-cli 0.154.0 and the Codex docs
(developers.openai.com/codex/hooks, /codex/mcp, /plugins/build/plugins). `waggle install codex`, when
`codex plugin --help` works, runs `codex plugin marketplace add <dir>` and `codex plugin add waggle@waggle`,
keeps the `[mcp_servers.waggle]` entry (and moves an older `[mcp_servers.knock]` one), and records the bundle's binary in `$KNOCK_HOME/knock-path`.
`--refresh` runs `codex plugin add` again only when the plugin is installed and its version differs from the
bundled one. `waggle uninstall` runs `codex plugin remove waggle@waggle` and `codex plugin marketplace remove
waggle`. Without `codex plugin`, install keeps `codex mcp add waggle --env KNOCK_RUNTIME=codex`.
`waggle doctor` prints `ok Codex installed as plugin` (or `... as MCP entry`) and a warning that Codex skips
plugin hooks until the user trusts them (`/hooks`).

The hooks run `waggle mod codex-hook <Event>` through the launcher. The verb reads Codex's JSON from stdin,
makes one RPC and exits 0 whatever happens (a failed hook prints nothing). `SessionStart` starts the daemon
on demand; the other events never do. Mapping: `SessionStart` -> `turn.complete` (idle), `UserPromptSubmit` ->
`turn.start` (the prompt text is never read), `PreToolUse` -> `tool.call` with the tool name (`PostToolUse` is
not registered: it would count each call twice), `Stop` -> `turn.complete` then `mod.stop_check`, `SessionEnd`
-> `session.end`. Every report has `source: "codex-hooks"` and the session's `cwd`.

`mod.report` gains the event `session.end` (the daemon forgets the session's live state), the optional
`source` (`claude-mod` | `codex-hooks`) and `cwd`. A report from `codex-hooks` does not count as a poll: the
session is not nudgeable through a mod, and its live state stays fresh for 15 minutes after the last event
(a Claude Code mod's stays fresh while it polls, 45 s). `sessions.list` then fills `context.live` for a Codex
session too (it has no transcript reading).

*Session id.* The hook's `session_id` is Codex's thread id. The shim uses `CODEX_THREAD_ID` as its session id
when Codex puts it in the MCP server's environment, and then the ids are equal. Otherwise (the shim keeps a
generated UUID) the daemon matches the hook session to the one live Codex session with the same `cwd` and
remembers the match; with none or two candidates it matches nothing.

`mod.stop_check { session_id, cwd? }` -> `{ block, case_id, reason }`. `block` is true when the session has an
ask waiting on the human, or answered and not yet picked up. `reason` is `A Waggle ask is still open (<title>).
Call waggle_check with case_id <id> and wait for the answer before ending your turn.` The hook prints
`{"decision":"block","reason":...}`, which makes Codex continue the turn with that text. The daemon blocks at
most 3 times for one case (memory only), so a turn never loops forever.

*MCP timeout.* Codex's default `tool_timeout_sec` is 60. `waggle_ask` and `waggle_check` hold at most 50 s, so
they fit; the plugin's `mcp.json` also sets `tool_timeout_sec: 120`.

### Keeping questions in Waggle (WAG-265)

Three optional parts make agents ask in Waggle and not in the terminal.

*Claude Code hooks.* The plugin's `hooks/hooks.json` has two plain command hooks next to its `modules` entry
(the module API cannot block a stop, and has no `SessionStart` matcher or context result). Both run
`waggle mod claude-hook <Stop|SessionStart>` through the launcher, read Claude Code's JSON from stdin, and exit 0
whatever happens (fail open). They never start the daemon.

- `Stop`: prints `{"decision":"block","reason":"Ask this in Waggle: send it with waggle_ask (options and a
  recommendation), then wait for the reply."}` when the last assistant message asks the human something
  (`daemon/src/hooks/question-detector.ts`), the session has no open ask, and the switch is on. It never blocks
  when `stop_hook_active` is true, so it blocks at most once per stop. The message comes from
  `last_assistant_message`, else the tail of `transcript_path`.
- `SessionStart` (matcher `compact|resume`): prints one line of `additionalContext`, "Ask the human through
  waggle_ask, never in the terminal. Call waggle_guide if you need the details." Nothing for other sources.

`mod.open_ask { session_id, cwd? }` -> `{ open }`. `open` is true when the session has an ask waiting on the
human, or answered and not yet picked up. Unlike `mod.stop_check` it counts nothing. The result also carries
`case_ids` (WAG-268, additive): the ids of the session's open asks. The `SessionStart` reminder names them
("Your open ask is c_1. Call waggle_check with each case_id to get the reply.").

*Switch.* `settings.get/set` key `catchQuestions` (`on` | `off`, default `on`). Off writes the empty marker file
`catch-questions-off` in the data root; on removes it. The hook reads the file, so the switch works with no
daemon. Settings › Agents › "Catch questions in the terminal" sets it.

*Rule block.* `waggle rule <status|add|remove> [claude] [codex]` prints one JSON line
(`{ lines, agents: { <agent>: { path, present, state } } }`, `state` is `added`, `missing` or `damaged`). Add
appends the three-line block between `<!-- waggle:start -->` and `<!-- waggle:end -->` to
`~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md` (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` override the folders). It
leaves other text alone, does nothing when the block is there, and leaves a file with broken markers alone.
Remove deletes exactly the marked block. The app runs it only on the user's Add or Remove.

### `usage.record`

The app reports the usage events it owns (KNOCK-19, HAIL-83). Each event takes only the fields in the
table. Every field is a closed enum. The daemon rejects any other key and any other string, with error
`-32602`, and validates the record again with the write schema it uses for every usage event. It stores
only the event, the UTC hour and these enum fields. No title, text, path or project name is ever
accepted or stored. `waggle report --off` stops these events like all others.

*The ask of an event (WAG-366).* An event about one ask may carry `case_id` (the "ask" rows below). The
daemon does not store it: it stores `ask_h`, the first 12 hex characters of an HMAC-SHA256 of the id with
the per-install salt (the scheme of `project_h`). The daemon puts the same `ask_h` on its own
`ask_created`, `reply_submitted`, `ask_dismissed`, `ask_restored` and `round_added` records, so
`waggle report` can count per ask. `case_id` on any other event is rejected.

| `event` | Fields | Recorded when |
| --- | --- | --- |
| `case_opened` | `source` = `notification` \| `menu_bar` \| `queue` \| `sessions_panel` \| `auto_advance` \| `keyboard` | an ask opens |
| `comment_mode_started` | none | the review enters Comment mode |
| `artifact_opened_full` | `artifact_kind`, `after_s` | the preview card's "Open full size" or a tap on the card |
| `review_opened` | `artifact_kind`, `after_s` | "Open review" (bar or composer) |
| `preview_interacted` | `artifact_kind` | a click or scroll inside the inline preview card |
| `option_picked` | `source` = `click` \| `number_key` | an option is picked |
| `recommendation_accepted` | `source` = `button` \| `shortcut` | "Send recommended answer" |
| `reply_typed` | none | first keystroke in the reply field, once per ask |
| `ask_more_detail_opened` | `source?` = `button` for the three dots pill of the "Ask for" row (WAG-367) | "Ask for more detail" |
| `change_answer_started` | none | "Change answer" |
| `go_back_clicked` | none | "Go back" on the sent toast |
| `sessions_panel_opened` | none | the sessions popover opens |
| `session_detail_opened` | none | a session row opens |
| `screenshot_zoom_changed` | `variant` = `fit` \| `100` \| `zoom` | the zoom level changes |
| `screenshot_set_view_opened` | none | the screenshot set view opens |
| `comment_added` | `variant` = `point` \| `region`, `artifact_kind?` (WAG-413) | a comment is added |
| `nudge_clicked` | none | the nudge button is clicked |
| `copy_prompt_clicked` | none | "Copy prompt" is clicked |
| `sources_list_opened`, `source_opened`, `artifact_variant_selected` | none (ask) | the sources list opens, a source pill is pinned, a variant of the artifact is picked |
| `detail_format_picked` | `format` = `eli5` \| `diagram` \| `page` \| `none`, `variant?` = `tradeoffs` \| `prototype` \| `numbers` \| `example` \| `something_else` \| `screenshots` \| `how_it_works` (row only, WAG-367, WAG-384), `n?` = 1 for a pill of the "Ask for" row (WAG-367) (ask) | a row of "Ask for more detail", or a pill of the "Ask for" row, sends the request: a format row, a quick ask, or the typed one |
| `quick_reply_picked` | `variant` = `lets_discuss` \| `my_comments` \| `show_more` (ask) | a quick reply chip above the input sent its reply (WAG-411 pass 2); code only, never the text |
| `compare_toggled` | `variant` = `on` \| `off` (ask) | the Compare switch of the screenshot header is turned on or off (WAG-413); code only |
| `app_launched`, `app_active` | none | the app starts; the app comes to the front (at most once per UTC hour) |
| `onboarding_started`, `onboarding_continued`, `first_job_started`, `first_job_finished`, `onboarding_prompt_copied` | none | the steps of the setup window |
| `onboarding_agent_connected` | `variant` = `claude` \| `codex` | "Connect" on an agent row in setup |
| `tour_started`, `tour_finished`, `tour_skipped` | none | the coach marks |
| `getting_started_line_opened` | `variant` = `connect` \| `job` \| `decision` \| `talk` \| `notifications` \| `design_kit` | a click on a line of the getting started list |
| `getting_started_hidden` | none | the list is hidden |
| `settings_page_opened` | `variant` = the page: `agents` \| `notifications` \| `previews` \| `artifacts` \| `asks` \| `phone` \| `updates` \| `data` \| `help` | Settings opens, or another page is picked |
| `usage_exported` | none | the usage export is written from Settings |
| `new_idea_opened` | none | New idea opens. Not sent from WAG-362 on: the page is gone. Old rows stay. |
| `new_idea_started` | `variant` = the launch target (below) or `session`, `n?` = files attached | an idea is sent. Not sent from WAG-362 on. |
| `launch_target_chosen` | `variant` = `claudeTerminal` \| `codexTerminal` \| `claudeApp` \| `codexApp` \| `claudeSuperset` \| `codexSuperset` \| `conductor` \| `claudeT3` \| `codexT3` | the chip's menu picks where to start |
| `project_page_opened` | none | a project page loads |
| `update_prompt_shown`, `update_install_clicked`, `update_later_clicked`, `update_skipped`, `update_restart_clicked`, `whats_new_opened` | none | the update prompt and the "ready" toast |
| `split_fold_toggled` | `variant` = `queue` \| `ask` \| `both` | a fold button |

`case_id` is accepted on the rows marked "(ask)" and on every row from `case_opened` to `nudge_clicked`
except `sessions_panel_opened` and `session_detail_opened`.

*Daemon records (WAG-366).* `reply_submitted` also holds `intent` (`decision` \| `more_detail` \|
`discuss`), `source` (`mac` \| `telegram` \| `slack`), `format` (for `more_detail`), and `note`: the length
of the typed note as a bucket (`none` \| `1-20` \| `21-100` \| `101-400` \| `400+` characters), never the
text. `ask_created` and `round_added` hold `stage` and `n` (the number of decisions). `ask_dismissed` and
`ask_restored` record Dismiss and its undo.

`artifact_kind` is `screenshot` \| `html_bundle` \| `markdown` \| `screenshots` \| `diagram`. `after_s` is the time
since the ask was opened, as a bucket: `0-2` \| `3-10` \| `11-60` \| `60+` (seconds). The app never
sends a raw number. There is no event for hover or focus. The app records `artifact_opened_full`,
`review_opened`, `preview_interacted` and `reply_typed` at most once per ask opening.

The daemon adds `artifact_kind` to its own `reply_submitted` record (the kind of the ask's latest
artifact, absent when the ask has none). `waggle report` uses it for the "What you click" section
(counts per event and four derived lines). An old app that sends only `case_opened` and
`comment_mode_started` works unchanged. A new app that talks to an old daemon gets `-32602` for a new
event and ignores it: a usage call never fails a user action.

### Usage log: tool calls (HAIL-195)

The shim records every MCP tool call (`waggle_*` and the `knock_*` aliases, stored under the `waggle_*`
name) in the `tool_calls` table (migration 33). The daemon is the only writer: the shim reports each
finished call with `usage.tool_call`, without waiting for the answer. A daemon that is down, or too old
for the method, costs the call nothing.

*A row holds only:* `at`, `tool`, `duration_ms`, `wait_ms` (the time spent in `case.wait`),
`result` = `answered` \| `pending` \| `ok` \| `error_connection` \| `error_artifact` \| `error_invalid` \|
`error_other`, `session_id`, `client_name` (the MCP `clientInfo.name`, for example `claude-code`),
`case_id`, `artifact_kind`, `error_code` (WAG-409, see below), `request_bytes`, `response_bytes` (text only), `images` (images in the
response), and the token fields below. The params are a strict object: no ask text, reply text, artifact
content or path can be sent. A path or a long string fails validation with `-32602`.

*Error code (WAG-409).* A failed call (`result` = `error_*`) also carries `error_code`: a stable snake_case
word (`^[a-z][a-z0-9_]{1,59}$`) such as `bundle_dir_not_found`, `bundle_entry_missing`, `html_empty`,
`too_large`, `not_png_or_jpeg`, `unknown_guide_topic`, `invalid_params` or `daemon_unreachable`. The
`result` word comes from the code (`daemon/src/protocol/error-codes.ts`), never from words in the error
text. The daemon puts the code in `error.data.error_code` (also on `-32602` and `-32004`). A daemon that
names none gets the code from the RPC code, else `unclassified`. The error text is neither stored nor
exported. The column `tool_calls.error_code` is NULL for a call that did not fail and for rows older
than migration 53. The export row has the key `error_code` and the CSV has it as the last column, so old
readers still work. `usage.summary` has an optional `errors: [{ result, error_code, calls }]`, and
`waggle report --tools` prints it as "Failed calls by reason".

*Token estimate.* One heuristic, constants in `daemon/src/usage/tools.ts`: `tokens_written` =
`ceil(request_bytes / 4)`; `tokens_received` = `ceil(response_bytes / 4)` + 1,600 per image. Both are
estimates, not measurements.

*Context re-read (Claude Code only).* The Claude Code mod runs `waggle mod usage --session ID --tool NAME
--transcript PATH` before a Waggle tool runs. It reads the last assistant message of the session log
that has a `usage` object and sends four integers with `usage.context`: `input`, `cache_read`,
`cache_creation`, `output`. The path and every message stay in the `waggle` process; the daemon never
gets them. The daemon keeps the numbers in memory and stores them as `ctx_*` on the next row of the same
session and tool (at most 15 minutes later). A log that cannot be read leaves the `ctx_*` fields empty.

*Tokens, no money (HAIL-199).* The app, `usage.summary` and the export carry token counts only: no dollar
field, no price. A call's tokens are `tokens_written` + `tokens_received` + the measured context
(`ctx_input`, `ctx_cache_read`, `ctx_cache_creation`). `ctx_output` is stored but not counted. The "share
spent waiting" is the tokens of `waggle_check` over the total tokens. Top sessions carry `tokens`.

*Cost (operator only).* `waggle report --tools --cost` adds dollar columns, computed from the same rows
with the `PRICES` constants in `daemon/src/usage/tools.ts` (per million tokens: input $3, output $15,
cache read $0.30, cache write $3.75; a Sonnet-class reference, not the price of the model the person
runs). Per call: `tokens_written` at the output price, `tokens_received` and `ctx_input` at the input
price, `ctx_cache_read` and `ctx_cache_creation` at the cache prices. The operator can also work out cost
from the token counts in the export.

*Switches.* "Record usage on this Mac" is the existing `usage-off` marker file in `KNOCK_HOME`: one switch
for the hourly events and the tool calls (`waggle report --off|--on`, or `usage.control { record }`).
"Measure token use from my agent's session log" is the marker `usage-transcript-off` (`usage.control
{ transcript }`); the mod also checks both markers before it reads a log. `usage.control { delete: true }`
deletes every `tool_calls` and `usage` row and returns the count. Rows older than 90 days are deleted at
start and once a day (the hourly events too).
"Include my notes and comments in the export" (WAG-366, operator decision 13 Oct) is the marker
`usage-export-text` (`usage.control { export_text }`): off by default, and present = on. It changes the
export only. Nothing more is recorded.

*Export.* `usage.export { path }` and `waggle report --export PATH` write one JSON file (`.json` is
added when missing) and a CSV of the tool-call rows with the same name. The JSON holds `format`,
`exported_at`, `install_id` (random, made once, kept in the file `install-id`), `app_version`,
`plugin_version`, `macos_version`, the estimate constants, the `tool_calls` rows (token counts, no dollars) and the
hourly `usage_events`. It holds no user name, no path and no text. With the `usage-export-text` switch
on, it also holds `includes_text: true` and `notes`: for each reply of the kept days that has a note or
comments, `{ hour, ask_h, intent, format, source, note, comments[] }`, read from the replies at export
time. Nothing is sent: the person sends the file. `waggle report --tools [--days N]` and `usage.summary` give the same numbers as the Usage section
of Settings › Data & privacy. `--cost` is the only way to see dollars.

### `service.restart`

The app enforces its own daemon (HAIL-27): on launch and every reconnect it compares
`service.status.version` and `service.status.exec_path` with its own bundled binary and version. When
either differs it calls `service.restart`, then starts its own binary. The daemon replies
`{ ok: true }` immediately, then drains in-flight reply deliveries and exits cleanly after it flushes
writes. "In flight" means a reply that `case.wait` has returned but the shim has not yet acked
(`reply.ack`); the drain waits for those for at most 10 s. The next client starts the new binary on
demand (see `docs/SERVICE.md`). Queued replies and cases persist in the DB across the exit.

### Case fields

A `Case` (from `cases.list`, `cases.get`, `case.create` and `case.update`) carries its own fields
plus denormalized task fields, the latest artifact kind and the latest reply, so a queue row needs
no extra call:

```text
{ id, task_id, task_name, project, linear_key, kind, title, need, why, recommendation,
  recommendation_why, select, max, recommendations, options, status, has_artifact, artifact_kind, runtime, session_state,
  latest_reply_id, latest_reply_state, latest_reply_at, latest_reply_delivered_at, latest_reply_choice, latest_reply_choices, latest_reply_answer_text, latest_reply_message,
  first_reply_submitted_at, update_count, latest_update_at, latest_update_message, revision_count,
  dismissed_at, replaces_case_id, withdrawn_at, created_at, updated_at }
```

- `items` (WAG-312, additive): the items of the newest round, as `Case.options` is the newest option set. Always set;
  the daemon derives it from the old columns for a request stored before the three blocks. `CaseDetail.rounds`
  (additive, optional): every round that carries items, oldest first, each
  `{ seq, stage?, question, items, created_at, revision, own_artifact, artifact_kind, answer, talk_count }`. `answer` is
  null while the round is open, else `{ choice?, choices?, item_answers?, message?, created_at }`; `talk_count` counts the
  Keep talking replies. It generalises `PlanRound`. Turns without items (an answer only, a revised artifact, done) come from
  `messages` and `revisions`. `Case.kind`, `options`, `first_options`, `questions`, `recommendation`, `plan` and
  `CaseDetail.plan_rounds` are unchanged in meaning (see the dual write table).
- `latest_reply_answer_text` (WAG-295, additive, optional): the answer body `waggle_check` hands the agent,
  that is the reply text without its first `Reply to "<title>" (case <id>)` line. It is set only while the
  latest reply is a `decision` reply in state `queued` or `failed`; `null` or absent otherwise. The daemon
  builds it with the same formatter as `waggle_check`. The app wraps it in a standalone paste (title, case
  id, answer, hint) and never formats an answer itself.
- `task_name`, `project` and `linear_key` come from the case's task. `linear_key` is `null` when
  the task was named from a plain branch or the cwd folder.
- `artifact_kind` is `screenshot` | `html_bundle` | `markdown` | `screenshots` | `diagram` | `null`:
  the kind of the latest revision, `null` when the case has no artifact.
- A `cases.list` row (not `cases.get`, events or `case.*` results) leaves out `first_options` while
  it equals `options` (PERF-4, additive). A missing `first_options` means "same as `options`". The
  app reads `task_name`, `project` and `artifact_kind` from the row, so it makes no `cases.get` per
  queue row.
- `latest_reply_id`/`latest_reply_state`/`latest_reply_at` describe the case's most recent reply
  (`latest_reply_state` is `queued` | `delivered` | `failed` | `superseded` | `handed_over`, the last two added by
  HAIL-44 and WAG-410), all `null` when the case has no reply
  yet. `latest_reply_at` is that reply's `created_at`. This is how the app shows Delivered/Failed
  (and retries a failed reply) for a case after a relaunch, without a per-row `cases.get`
  (KNOCK-13 fold).
- `latest_reply_delivered_at` (HAIL-64) is when that reply was marked delivered (the agent picked it
  up), `null` while it is queued, failed or absent. The app uses it to move an answered ask from
  "Waiting on agent" to "Answered" 10 minutes after pickup, so the time survives a relaunch.
- `runtime` is `claude` | `codex`: denormalized from the session that created the case (KNOCK-20),
  the same way `task_name`/`project`/`linear_key` are denormalized from the task.
- `session_state` (HAIL-32) is `live` | `disconnected` | `ended` | `null`: the state of the case's
  owning session, denormalized the same way `runtime` is. `null` only for a case seeded without a
  session row (tests, `waggle test-ask`). The app uses this to decide whether dismissing a `needs_you`
  case needs a confirmation - a `live` session may be blocked in `waggle_ask`/`waggle_check` right now.
- `session_ended_at` (WAG-258) is when the owning session ended: the time of its newest
  `session.state_changed` event, set only while `session_state` is `ended`, else `null`. The app compares it
  with the reply time to say which came first (the session closed before the reply, or after it).
- `dismissed_at` (HAIL-32) is set by `case.dismiss` and cleared by `case.restore`; `null` for a case
  that was never dismissed.
- `latest_reply_choice`/`latest_reply_message` (HAIL-34) are the chosen option id and free-text
  message of the case's most recent reply, denormalized the same way `latest_reply_id`/`state`/`at`
  are; both `null` when the case has no reply yet, or when that reply carries no choice/message. The
  queue row's "you → <label>" line reads these without a per-row `cases.get`.
- `first_reply_submitted_at` (HAIL-34) is the earliest reply's `created_at` across every round of
  this case, `null` until the case has a first reply. Never moved by `reply.replace` (same row,
  `created_at` untouched) or by a later round's own reply. "Took" (the row and the opened ask's own
  header meta) is this minus `created_at`.
- `update_count`, `latest_update_at`, `latest_update_message`, `revision_count` (HAIL-67) describe
  what the agent sent with `waggle_update` after the human's first reply. `update_count` is the
  number of agent messages created after `first_reply_submitted_at` (0 before any reply; a message
  sent before the first reply is not an update). `latest_update_at` is the newest such message's
  `created_at` and `latest_update_message` its first 140 characters, both `null` when there is
  none. `revision_count` is the number of revisions; `latest_revision_at` (HAIL-68) is the newest
  revision's `created_at`, `null` with none, so the app can tell a revision an update added from one
  made before the reply. The app shows the "Updated" line and block
  only while the case is `needs_you` and `latest_update_at` is later than `latest_reply_at`, so it
  disappears once the human answers again. All four are additive; an older daemon omits them and
  the app decodes them as optional.
- `latest_reply_intent` (HAIL-33) is the intent (`"decision"` | `"more_detail"` | `"discuss"`) of the case's most
  recent reply, denormalized the same way `latest_reply_choice`/`message` are; `null` only when the
  case has no reply yet. Lets the app show "Asked for more detail - waiting for the agent" after a
  relaunch, without a per-row `cases.get`.
- `latest_reply_format` (HAIL-139) is the format (`"eli5"` | `"diagram"` | `"page"`) of the case's
  most recent reply, denormalized the same way `latest_reply_intent` is; `null` when the case has no
  reply yet, or that reply carried no format. Lets the app show "Asked for more detail · as a
  diagram" after a relaunch.
- `follows_case_id` (HAIL-33 amendment) is the `case_id` of the earlier ask this one follows up on,
  or `null`. Set only at creation by `waggle_ask`'s `follows`; the app shows a "Follow-up to: <earlier
  title>" line linking to that case, with a recap of its answer, and groups the follow-up under its
  earlier ask in the queue with a small indent.
- `replaces_case_id` (HAIL-44) is the `case_id` of the earlier ask this one replaces, or `null`. Set
  only at creation by `waggle_ask`'s `replaces`; the app shows a "Replaces: <earlier title>" line
  linking to that case, with a recap of its answer when it had one before it was withdrawn (see
  "Replacing an ask").
- `withdrawn_at` (HAIL-44) is set when a later ask's `replaces` withdrew this case, the same way
  `dismissed_at` is set by `case.dismiss`; `null` for a case that was never replaced. A withdrawn
  case disappears from the queue the same way a dismissed one does. There is no restore.

Session methods (shim only), settled in KNOCK-01:

| Method | Params | Result |
|---|---|---|
| `session.hello` | `{ session_id, cwd, branch?, git_root?, parent_pid, runtime?, client_version?, can_nudge?, changes? }` | `{ session_id, task_id }` |
| `case.create` | `waggle_ask` input + optional `client_request_id` (HAIL-197) | `Case` + `replaced_answer_note`, `words_warning` (both nullable) |
| `case.wait` | `{ case_id, wait_ms }` | reply payload, or `{ status: "pending", case_id, waited_s? }` |
| `case.update` | `waggle_update` input | `Case` + `words_warning` (nullable) |
| `reply.ack` | `{ reply_id }` | `Reply` (the shim confirms it received the payload; only then `delivered`). `case.wait` returns `reply_id` beside the content. |

Session states: `live` (shim connected), `disconnected` (connection closed, parent pid still alive),
`ended` (parent process gone). Only `ended` makes a queued reply `failed`.

The recorded `pid` is the shim's parent (the client process), taken from the first hello. HAIL-192:
a hello whose `parent_pid` is alive replaces it, because a client that restarts under the same
session id (resume, or a harness that respawns Claude Code) starts a new shim with a new parent.
HAIL-178: a live shim does not keep a session `live` when that pid is gone. The daemon
checks the recorded pid of every `live` or `disconnected` session every 15 s and on each
`session.hello` (a keepalive too), and ends the session when the pid no longer exists (pids 0 and 1
are not checked). A dead-pid hello does not bring the session back or stamp `last_seen_at`.
HAIL-192: a hello with a living parent, and any `case.create` / `case.wait` / `case.update` /
`reply.ack` from a shim whose recorded pid is alive (or 0 or 1), brings an `ended` or `disconnected`
session back to `live`, and its `failed` / `session_unreachable` replies go back to `queued`.
`case.wait` also returns a reply stored for its own case that is `failed` with `session_unreachable`
(the agent asking is alive); `reply.ack` then marks it `delivered`. `reply.retry` on a reply whose
session is still `ended` changes nothing and emits no event. The
shim also checks its parent every 5 s (`process.ppid` changed, or the pid is gone) and exits.

**Compatibility rule (KNOCK-21, HAIL-27).** A `waggle mcp` shim spawned before an update keeps running
the old code until its Claude Code or Codex session restarts. `session.hello`'s `client_version` is
optional: the daemon accepts a hello with no version or an older version and serves it with the
current protocol. When the daemon is older than the client, it answers `session.hello` with a clear
error instead of failing later: "Waggle's background service is older than this client (daemon X,
client Y). Quit and reopen Waggle, or run `waggle doctor`." Protocol changes from here on are additive;
an existing field keeps its meaning and new fields are optional. An unexpected daemon error returns
`-32603` with the real cause in `error.data.message`, so a client never prints a bare "Internal
error".

`Capture`: `{ id, revision, png_base64, annotated_png_base64, taken_at, note? }`.
Despite the field names, the app sends both images as JPEG with the long edge capped at 2048 px
(4 Oct: two full Retina PNGs per capture made one reply 17.8 MB and the send timed out). The human
reviews the full-resolution image locally; only the wire copy is smaller. A capture stored earlier
still holds PNG. The daemon sets the agent's image `mimeType` from the bytes (base64 `/9j/` is JPEG).
`CaptureSummary` (PERF-2): `{ id, revision, taken_at, note?, has_image: true }`. `cases.get`, `reply.submit`,
`reply.retry`, `reply.replace` and `reply.ack` return captures in this form, with no image data: on the
operator's data one 4-capture reply was 17.8 MB, and every refresh and every send echo carried it.
The app asks for one image with `capture.image` when it shows it, and keeps it in memory per capture id.
`reply.submit` and `reply.replace` still take full `Capture` in the request, and the agent's reply
payload still carries the annotated image. The change removes `png_base64` and `annotated_png_base64`
from those responses, so a client older than this change cannot show a stored capture. The app and the
daemon ship together, and the app restarts an older daemon (`service.restart`).
`Comment`: `{ id, capture_id, n, rect: {x,y,w,h} (0..1 of the capture), text }`, `n` from 1 in order.
Text comment (HAIL-150): a comment on a range of a markdown revision has no `capture_id` or `rect`.
It has `anchor: { kind: "text", revision, quote, start, end }` instead. `start` and `end` are offsets
in UTF-16 code units (end exclusive, the unit of a JavaScript string) into that revision's markdown
SOURCE. `quote` is the exact source text between them. A comment has either `capture_id` and `rect`
or an `anchor`, never both. `n` is shared with the capture comments of the case. A comment belongs
to its revision: a new revision does not move it. Compatibility: capture comments are unchanged. An
older daemon rejects a text comment with `-32602` (it requires `capture_id`), like any new field. The
`comments` table keeps `capture_id` and `rect_json` nullable (migration 25) and has `reply_id` and
`anchor_json`, so a reply finds its text comments without a capture.
`Reply`: `{ id, case_id, idempotency_key, choice?, message?, comments, captures, state, reason?,
format?, created_at, replaced_at?, delivered_at? }`. `format` (HAIL-139) is `"eli5"` | `"diagram"` |
`"page"` on a `more_detail` reply, absent otherwise and for a detail request that did not name one.
`delivered_at` (HAIL-68) is when the agent picked the reply up. `replaced_at` (HAIL-34) is set by `reply.replace`, absent for a reply
that has never been changed. `apply_state?` and `applied_at?` (WAG-267) are set only on a `delivered`
reply: see "Reply applied check (WAG-267)" below.

### Reply applied check (WAG-267)

`delivered` says the agent got the answer. It does not say the agent acted on it. A delivered reply
gets one later step, kept in a field beside `state` so `state` and every old client stay as they were
(additive; migration 35 adds `replies.applied_at` and `replies.not_applied_at`, both nullable).

- `Reply.apply_state` is `pending` | `applied` | `not_applied`. It is absent unless `state` is
  `delivered`, and absent from an older daemon. `Reply.applied_at` is set with `applied`.
- `applied`: the same session shows visible work after the delivery. Three signals count:
  a `waggle_update` (`case.update`) on the answered case; a new `waggle_ask` (`case.create`) from a
  session that owns the case; a turn that began after the delivery and finished (the Claude Code mod
  reports `turn.start` and `turn.complete` through `mod.report`). A `waggle_check` (`case.wait`) that
  only fetches the answer is delivery, not applied. The turn that fetched the answer does not count.
- `not_applied`: the session ended with no visible work, or `APPLY_WAIT_MS` (15 minutes) passed after
  `delivered_at` with none. A later visible work moves it to `applied`. No notification is sent.
- Each change emits `reply.state_changed` with `case_id` and `reply_id`.
- The app shows one line under the answer: "Sent", "The agent got it", "Applied", or "The agent got
  your answer but has not acted on it yet." (`not_applied`).

### Idempotent `case.create` (HAIL-197)

`case.create` takes an optional `client_request_id` (string, 8 to 100 characters) next to the
`waggle_ask` fields. It is not a `waggle_ask` tool field: the agent never sees it.

- The shim makes one random id for each `waggle_ask` tool call. It sends the same id on every retry of
  that call. The shim retries `case.create` once after a lost connection and once after a timeout.
- The daemon keeps the id in `cases.client_request_id`, with the creating session in
  `cases.request_session_id` (migration 34). The pair is unique where the id is set.
- When a case with the same session and id exists, the daemon creates nothing and returns that case.
  The result has the same shape as a fresh create. `replaced_answer_note` and `words_warning` are null.
  No second `case.created` event is sent.
- The id is in the database, so a daemon restart between the first try and the retry still returns
  the first case.
- A call with no `client_request_id` (an older shim) creates a case each time, as before.
- `reply.submit` is not changed. It keeps its own `idempotency_key`.

### An open ask survives a restart or a cancel (WAG-268)

Claude Code can cancel a waiting `waggle_ask` or `waggle_check` (`notifications/cancelled`) and can restart
the shim, around a compaction. All of this is additive.

- *Cancel.* The shim sends the notification `case.cancel_wait { case_id }` (no id, no answer). The daemon
  handles it at once, not in the connection queue behind the wait. It ends the open `case.wait` of that case
  on that connection. The shim does not ack a reply of a cancelled call. The reply stays queued.
- *Resume.* A session may use a case another session made when the case is open (not resolved, done,
  dismissed or withdrawn), every session of its task is not live, and both are in the same folder, branch and
  runtime. `case.wait`, `case.update` and `reply.ack` then work for the new session. A reply that failed as
  `session_unreachable` goes back to `queued`.
- *Reattach.* `case.create` with no `follows` or `replaces` returns the open case of the same task with
  the same `title` and `need`, and creates nothing. Open here also means no reply is delivered yet. An open
  case of an earlier session counts only when that session was seen in the last 30 minutes, and never
  across topics (HAIL-163).
- *Grace.* A case's `session_state` reads `live` while its session is `disconnected` for less than 60
  seconds. The daemon sends one more `session.state_changed` when that time ends.
- *Errors.* A failed call that names a case says that the ask is still open and names the next step, for
  example "The connection to Waggle restarted. Your ask c_… is still open. Wait a few seconds, then call
  waggle_check with case_id c_…". `not your case` and `case not found` also get a plain sentence.

## Case and reply states

```text
case:   needs_you ──reply──► waiting_on_agent ──waggle_update──► needs_you
                             waiting_on_agent ──waggle_update done:true──► waiting_on_agent (done_at set) ──Got it──► resolved
          │                  │
          └──── case.dismiss ┴──► resolved ──case.restore──► needs_you or waiting_on_agent
          │                  │
          └──── replaces ────┴──► resolved (withdrawn_at set, no restore)
                    └──────── resolved (reply delivered and agent session ended, or dismissed)

reply:  queued ──agent fetched via waggle_ask/waggle_check──► delivered ──► apply_state pending
                                                                  ├─ visible work ──► applied (WAG-267)
                                                                  └─ session ended or 15 min ──► not_applied
          │       └── reply.replace (HAIL-34, queued only) ──► queued (same id)
          ├── session gone (connection closed and pid dead) ──► failed ── reply.retry ──► queued
          ├── a newer ask's replaces withdrew this case (HAIL-44) ──► superseded (terminal)
          └── failed ── reply.hand_over (WAG-410, "Continue in a new session") ──► handed_over (terminal)
```

- `delivered` is set only when the daemon has written the payload to the shim and the shim
  acknowledged it. Never earlier (AC 8).
- `reply.submit` with an existing `idempotency_key` returns the existing reply. It never creates a
  second one (AC 8).
- `case.dismiss` (HAIL-32) can resolve a case from either `needs_you` or `waiting_on_agent`;
  `case.restore` puts it back in whichever of those it left. See "`case.dismiss` / `case.restore`"
  above for the full contract, including the message a waiting agent's `case.wait` receives.
- `superseded` (HAIL-44) is terminal, like `failed`, but for a different reason: the human answered
  the case, then a later `waggle_ask`'s `replaces` withdrew it before any agent picked that answer up.
  See "Replacing an ask" above. Unlike `failed`, there is no `reply.retry` for a superseded reply.
- `handed_over` (WAG-410) is terminal. The human clicked "Continue in a new session" on a case whose agent
  session ended, and the answer went to the new session in its prompt. The app calls `reply.hand_over` after
  the new session starts. The case then shows "Handed over to a new session", not a failure. It is never
  requeued by HAIL-192 (that reads `failed` only), `reply.retry` leaves it, and `waggle_check` never hands it
  to an agent. `reply.hand_over` writes one `reply.state_changed` event and clears `reason`.
- When the app cannot reach the socket, the app keeps the unsent reply locally and shows
  "Not sent · Waggle service is offline". On reconnect it re-submits with the same key.

## Chat connectors (HAIL-144)

Opt-in. Off by default. Operator decision 3 Oct: Telegram first, Slack next (HAIL-145, below) through the same
layer. The daemon talks to the service directly, outbound only. No listener, no webhook, no relay for chat.
(Sharing a case has its own opt-in relay, below.)

- Layer: `daemon/src/connectors/`. A `Connector` has `isActive`, `start`, `stop`, `disconnect`, `sendAsk`
  and `updateOutcome`. It receives replies by calling its host (`ConnectorManager.answer`), which makes a
  normal `reply.submit` with the connector as `source`. The manager sends each new `needs_you` ask to
  every active connector, remembers the message it sent (`connector_messages`, migration 24), and edits
  that message when the ask is answered from either side. The ask flow knows no connector by name.
- Telegram: `getUpdates` long polling, `sendMessage`, `editMessageText`, `answerCallbackQuery`, base URL
  `https://api.telegram.org` (`KNOCK_TELEGRAM_BASE_URL` overrides it in a dev build only, see "Test overrides" below).
- Connect: (1) the operator pastes a @BotFather token, `check_token` calls `getMe` and saves the token to
  the macOS Keychain (`KNOCK_SECRET_STORE=memory` keeps it in memory in a dev build only); (2) `start_pairing`
  makes a one-time code; (3) the operator sends `/start <code>` to the bot from a private chat and the
  daemon saves that chat id. `TelegramStatus.state`: `off` | `token_checked` | `waiting_for_start` |
  `connected`. The token never goes to `knock.db`, a log, or an RPC result. `settings` row `connector.telegram`
  holds only the bot name, the bot username, the chat id and the chat name.
- A new ask is one plain-text message (never HTML or markdown from an agent): title, the first line of
  the need, the recommendation, one inline button per option (select `one` only) and "Ask for more
  detail". An ask with an artifact says "Open Waggle on your Mac to see the prototype". Artifacts never travel.
- A tap becomes `reply.submit` with that choice (or `intent: more_detail`). A Telegram reply to the ask
  message becomes a free-text reply. The daemon makes the idempotency key (`telegram:cb:<case>:<index>`,
  `telegram:msg:<chat>:<message>`), so a double tap makes one reply. A reply to a case that is no longer
  `needs_you` is refused. Only updates from the saved chat id count; all others are ignored.
- After a reply the message is edited to "Answered: <option>", "Answered on your Mac" or "Asked for more
  detail", and the buttons go away.
- Three blocks (WAG-310, operator decision Q11): connectors are out of scope, and the only guarantee is that they do not
  crash on the new shapes. `askMessageFor` and `outcomeFor` still read the old fields of `Case` (`options`, `select`,
  `recommendation`) and the three intents; a connector sends no lean, rule out or item answers. A request with more than
  one item has no `options` there, so the phone shows it as a free-text ask ("Reply to this message to answer"). A text reply from the phone
  carries no pick, so the daemon reads it as Keep talking and the ask stays open for the Mac. A review now has the two review options, so the phone shows Approve and
  Request changes buttons. A tap sends the decision with no comments. `daemon/test/items.test.ts` ("connectors do not crash on the new
  shapes") covers a multi-item case, a reply item and a review.
- `Reply.source` (`mac` | `telegram` | `slack`, migration 24, default `mac`) and `Case.latest_reply_source`
  tell the app where an answer came from ("Answered from Telegram").

### Slack (HAIL-145)

Same layer, same rules. The daemon calls only `slack.com` (Web API: `auth.test`, `apps.connections.open`,
`conversations.open`, `users.info`, `chat.postMessage`, `chat.update`) and the `wss-*.slack.com` address that
`apps.connections.open` returns (Socket Mode). Outbound only: no listener, no request URL, no relay. The
daemon refuses a socket address that is not `wss://` on `slack.com`. `KNOCK_SLACK_BASE_URL` and
`KNOCK_SLACK_SOCKET_URL` point it at a fake Slack in a dev build only.

- Connect: (1) Settings shows an app manifest (`SlackStatus.manifest`, JSON) the operator copies into
  api.slack.com/apps, "From a manifest". It turns on Socket Mode, interactivity, the `message.im` event and
  the bot scopes `chat:write`, `im:write`, `im:history`, `users:read`. The daemon never opens a URL.
  (2) The operator pastes the app-level token (`xapp-`) and the bot token (`xoxb-`). `check_tokens` calls
  `auth.test`, opens a Socket Mode connection and waits for `hello`, then saves both tokens to the Keychain.
  (3) `start_pairing` makes a one-time code. The operator DMs the bot that code; the daemon saves that user
  and their DM channel id. `SlackStatus.state` uses the same values as Telegram. Settings row `connector.slack`
  holds the workspace, bot name, user id, user name and DM channel id, never a token.
- A new ask is one Block Kit message in the DM. Agent text goes only into `plain_text` fields, and the
  call sets `parse: none` and `mrkdwn: false`. It has the title, the first line of the need, the
  recommendation, one button per option (select `one` only), "Ask for more detail" and a note when the ask
  has an artifact.
- A `block_actions` envelope becomes `reply.submit`; a reply in the message thread becomes a free-text
  reply. Every envelope is acked at once, before the daemon acts. Keys: `slack:cb:<case>:<index>`,
  `slack:msg:<channel>:<ts>`. Only the saved user in the saved DM counts. A refused press or reply gets a
  short answer in the thread.
- After a reply the message is changed with `chat.update` to the outcome, and the buttons go away.
- A dropped socket, or a `disconnect` envelope (a refresh), opens a new one. Failures back off from 2 s up to
  30 s. A revoked token stops the loop and shows a plain error. Keep-alive is the same rule as Telegram.

## Sharing a case (WAG-387)

Opt-in. Off by default. Operator decisions 17 Oct (Waggle cases c_dee5799e, c_44008907, c_e785c70e): the operator
may share a case through the Waggle relay (`relay/`, WAG-386) so a team can read the rounds and comment. The relay
is a separate service. The core of Waggle is local use; sharing is an opt-in addition. Local use needs no account and no network. User-facing guide: `docs/sharing.md`.

- Switch: Settings > Sharing. The saved state is the `connector.relay` setting (`{ enabled, account_email? }`). With it off, the daemon makes
  no call to the relay: every network path starts with that check. It cannot go off while a case is shared (stop sharing
  first); the error says so.
- One host: `RELAY_BASE_URL = "https://app.waggle.so"` (`daemon/src/connectors/relay.ts`). A dev build replaces it with
  `KNOCK_RELAY_BASE_URL` through `connectorConfig()`; a release daemon ignores the variable. Outbound HTTPS only, no listener.
- Share (the Share button on the case, never an agent tool): the daemon makes a random 32-byte owner key, keeps it in the
  secret store as `relay-owner.<relay case id>`, and sends only its SHA-256 hex hash with `POST /api/cases
  { title, mode: "link" | "emails", emails, owner_key_hash }`. The relay case id and URL go to `relay_shares` (migration 48).
  The key never goes to `knock.db`, a log or an RPC result. The Keychain item has service `Knock chat connector` and account `<bundle id>.relay-owner.<relay case id>`. Every later owner call sends `Authorization: Bearer <key>`.
- Ask: `POST /api/cases` and each `POST /api/cases/<id>/rounds` also carry an optional `ask` with the case's current
  question: `{ need, why?, recommendation?, options?: [{ title, label, recommended? }] }`. `need` is `cases.need`, `why`
  is `cases.why`, `recommendation` is the text of the recommendation (`recommendation_why`), `options` are the newest
  option set (`title` falls back to the label; `recommended` marks the recommended ids). Text is cut at need 600, why 1000,
  recommendation 300, title 80, label 600 characters (a cut text ends with `...`), and at most 12 options. An empty part is
  left out; a case without a need sends no `ask`. A relay that does not know the field ignores it.
- Rounds: on share and on each `revision.added` of a shared case, the daemon uploads each revision it has not uploaded
  (`relay_rounds`) with `POST /api/cases/<id>/rounds { label: "Round <n>", entry, files: [{ path, body_base64 }] }`.
  `html_bundle` = the bundle folder (no `.git`, no links; 200 files and 1 MB per file at most); `markdown` = `index.md`;
  `screenshot` = `screenshot.<ext>`; `diagram` = `diagram.<ext>`; `screenshots` = `01.<ext>`, `02.<ext>`, ... (WAG-391)
  The relay Worker, not the daemon, commits the files into the case's Artifacts repo (git smart HTTP from the Worker), so
  the daemon still calls one host and the Mac needs no `git`. `label` is the artifact name (`revisions.artifact_name`) and is
  left out when there is none; the page shows "Round <seq>" and adds " · label" only when the label is not "Round <seq>".
  Limits: 200 files, 1 MB per file, 15 MB per round. A round the relay can never take (those limits, or a 400, 413 or 422
  answer) is skipped for good with a plain reason (`relay_skipped_rounds`, `SharingState.skipped`), and later rounds still go
  up. Any other failure stops that case only; the retry wait (60 s) is per case, not global.
- Share retry (WAG-391): `POST /api/cases` also carries a random `request_id`. A retry (the first answer was lost) sends
  the same `request_id` and key hash and gets the same case back (HTTP 200). The pair is kept in memory until the share ends.
- Comments back: `GET /api/cases/<id>/comments?since=<ms>&after=<comment id>` (the cursor is `(created_at, id)`, stored in
  `relay_shares.since`, `since_id`; migration 49) on share, when the app sends `sharing.refresh` (it opens the case),
  and every 60 s while the case is `needs_you` and shared. They go into `relay_comments`, keyed by the relay comment id
  (a repeat is ignored), with author name, body and the anchor (`quote`, `prefix`, `suffix`, or `box`). A new comment emits
  `case.updated`. A team comment is never a reply and never decides the case.
- Errors: a relay that is down or answers non-2xx gives one plain line (`SharingState.error`, or the RPC error) and the
  case works as before. After a failure the daemon makes at most one background try per 60 s.
- Errors carry the relay's own words when it gives some (`{"error": "..."}`): "The sharing service said: 50 emails at most."
  The app caps the email list at 50 with "50 emails at most."
- Stop sharing: `DELETE /api/cases/<id>` (a 404 counts as done), then the secret and the share rows are removed. If the call
  fails the share stays and the error shows. The team's comments stay in `relay_comments` (each keeps its revision), in the
  app and in `shared_comments` for the agent (WAG-391). Without the owner key on this Mac the share stays, `share.stoppable`
  is false and the error is "This Mac no longer has the key for this link."
- Delete (WAG-391): purging a shared case writes its relay case id to `relay_pending_stops` in the same transaction.
  `cases.purge_resolved` then runs the stop (relay DELETE, then the Keychain item). A failure keeps the note, the background
  tick retries it (per-note 60 s wait), and the note counts in `shared_count`, so the Settings switch stays blocked until the
  page is gone. A note whose key is gone is dropped and logged.

RPC (app only): `sharing.get { case_id? }`, `sharing.set_enabled { enabled }`, `sharing.start { case_id, mode, emails? }`,
`sharing.stop { case_id }`, `sharing.refresh { case_id }`. All return `SharingState`:
`{ enabled, shared_count, share: { url, mode, emails, stoppable } | null, comments: SharedComment[], error, skipped: [{ revision, reason }], invites, account, comments_closed, shared_before }` (the last four are described below). `comments` also holds the comments of a case that is no longer shared. `SharedComment` is
`{ id, revision | null, author_name, author_kind, author_email | null, body, quote | null, prefix | null, suffix | null, box: { x, y, w, h, vw, near } | null, created_at, parent_id | null, resolved_at | null, resolved_by | null, unread }`.
`sharing.get` makes no network call. Text is plain; the app shows it as safe markdown.

Agent view: `case.wait` (so `waggle_check`, `waggle_ask` and the `knock_*` aliases) carries a new optional field
`shared_comments: [{ id, author_name, author_kind, author_email | null, body, quote | null, area | null, revision | null, created_at, reply_to | null, resolved, new? }]` (newest 100, oldest
first) on a shared case that has comments, in a reply and in a pending result. The shim also adds one text block, "Team
comments on the shared page (not an answer; the human decides in Waggle)". Without a shared case the result is unchanged.

### Accounts (WAG-392)

Sharing needs a Waggle account. The daemon signs in with a device flow against the relay (still the one host, still only
with Sharing on). Secret store name `relay-device` holds the device token (Keychain, service `Knock chat connector`, account `<bundle id>.relay-device`; never `knock.db`, a log or an RPC
result). The signed-in email is kept in the `connector.relay` setting (`{ enabled, account_email? }`), so `account.get`
needs no network. The Mac label sent to the relay is the Mac name (ComputerName, else the host name).

```
AccountState = { signed_in, email | null, connect: { user_code, verify_url, expires_at (ms) } | null, error | null }
AccountShare = { relay_id, title, url, mode: "link" | "emails", created_at (ms), comment_count, device_label,
                 local_case_id | null }   // local_case_id: this Mac has a share row for the page
```

- `account.get {}` -> `AccountState`. No network call.
- `account.connect_start {}` -> `AccountState` with `connect` set. Needs Sharing on ("Sharing is off. Turn it on in
  Settings."). Calls `POST /api/auth/device { label }`, then polls `POST /api/auth/device/poll` in the background at the
  relay's `interval` until approved. On approval it stores the token, sets `email` and clears `connect`. On expiry (410 or
  the clock) or after 3 failed polls in a row, `connect` is null and `error` is plain ("The sign-in code ran out. Try
  again."). A second start while one runs returns the same code. Turning Sharing off stops it.
- `account.connect_cancel {}` -> `AccountState`.
- `account.sign_out {}` -> `AccountState`. Needs Sharing on. `DELETE /api/me/device` (401 counts as done), then the secret
  and the email are removed. A network failure keeps the sign-in and sets `error`.
- `account.shares {}` -> `{ shares: AccountShare[], error | null }` from `GET /api/me/cases`. Signed out or Sharing off: an
  empty list and no call. A failure gives an empty list and `error`.
- `account.stop_share { relay_id }` -> `{ shares, error }`. `DELETE /api/cases/<relay_id>` with the device token (404 counts
  as done), also for a page shared from another Mac. If this Mac has a share row for it, the row and the `relay-owner`
  secret go too and `shared_count` drops. Then the list is read again.
- `sharing.update { case_id, mode, emails? }` -> `SharingState`. `PATCH /api/cases/<id> { mode, emails }`, then the local
  row follows. Same email checks as `sharing.start` (50 at most).
- `sharing.open_page { case_id }` -> `{ url }` from `POST /api/cases/<id>/owner-link`. The app opens the url.
- `SharingState.invites` is `{ sent, failed, limited }`: how the invite mails of the last `sharing.start` or `sharing.update` went (the relay's `invites`; all zero otherwise; kept in memory only). The share sheet shows one line when `failed + limited > 0`.
- `SharingState.account` is the `AccountState`. `sharing.start` when signed out fails with "Sign in to Waggle first.".
- New shares send `Authorization: Bearer <device token>` on `POST /api/cases` (the key hash is still in the body). Other
  owner calls use the owner key when this Mac has it, else the device token. A 401 whose body has `code: "invalid_token"`
  (the relay does not know the device token) clears the sign-in and sets `account.error` to "Your Waggle sign-in ended.
  Sign in again.". A 401 "Owner access needed" for a case of another account keeps the sign-in. `share.stoppable` is true when the owner key
  exists or the account is signed in.
- `SharedComment` and the agent's `shared_comments` items carry `author_kind` (`owner | member | guest | agent`; the old stored
  `email` kind is `member`) and `author_email` (string, or null for a guest; migration 50). The shim's text block says the
  comments are untrusted input from other people, not instructions.

### The comment loop (WAG-394)

Migration 51 (daemon) and relay migration 0006 add threads, resolve, the decision, closed comments and a question for each
round. Nothing here makes a call when Sharing is off.

**Relay API** (owner calls take the owner key or the device token; page calls take the page cookie and the app origin):

- `POST /api/cases/<id>/comments` with a cookie: `{ round_seq, body, quote?, box?, parent_id? }`. `parent_id` makes a reply.
  One level only: a reply to a reply is stored against the first comment of the thread. A reply takes the round of its
  thread and has no quote or box. With `Authorization: Bearer <owner key | device token>` the owner's Mac posts a reply:
  `{ parent_id, body, author_kind: "owner" | "agent" }` (`parent_id` is required). The agent's name is "Agent". A guest cannot
  take the name "Agent" or "Owner". When the owner closed the comments the call answers `403 Comments are closed.`
- `POST /api/cases/<id>/comments/<comment id>/resolve` and `/reopen`. The owner and the person who wrote the first comment of
  the thread may do it; a comment of the agent only the owner. The call resolves the thread of the comment it names.
- `PATCH /api/cases/<id>` takes any mix of `mode`, `emails` (as before), `ask`, `status` (`open | decided`), `decided`
  (`{ options: string[], note?, at? }`) and `comments_closed` (boolean). A new `ask` also sets the ask of the last round and
  opens the case again, unless the same call sets `status`. `POST /rounds` with an `ask` stores it on the new round and
  opens the case again. `GET /state` returns `status`, `decided`, `comments_closed`, the `ask` of each round, and for each
  comment `parent_id`, `resolved_at`, `resolved_by` and `can_resolve`.
- `GET /api/cases/<id>/comments` (owner) also returns `resolved: [{ id, resolved_at, resolved_by }]` for every resolved
  thread and `case: { status, comments_closed }`, so a resolve or a close made on the page reaches the Mac.
- A stopped link answers `410` with `code: "stopped"` and the words "Sharing for this case was stopped by its owner." A link that
  never existed still answers `404`.
- An image or diagram round opens in a wrapper page on the content origin (`<round link>?view=1`). It has the same area
  script as an HTML round. A raster image is an `<img>`; an SVG goes inline, so its text can be selected. An area comment
  on an image has `near: "image <name>"` and the box in image pixels (`vw` is the image width). The path without the query is
  the raw file. A screenshots round sends `gallery: [file names]` with `POST /rounds` (relay migration 0007); its wrapper
  stacks all the images (`?view=1&g=<names>`), and an area comment names the image it is on and holds the box in that image's
  own pixels.
- The page polls `/state` every 20 s while it is visible. It pauses when hidden and stops after 30 minutes without use
  ("Paused. Reload for new comments."). A round link whose ticket ends within 5 minutes is replaced by a fresh one; the frame
  keeps its scroll position.

**Daemon.**

- `SharedComment` adds `parent_id`, `resolved_at`, `resolved_by`, `unread`, and `author_kind` may be `agent`.
  `SharingState` adds `comments_closed` and `shared_before` (the case was shared and stopped; the sheet says "This makes a
  new link. The old link stays off.").
- RPC (app): `sharing.reply { case_id, parent_id, body }` (as the owner), `sharing.resolve { case_id, comment_id, resolved }`,
  `sharing.close_comments { case_id, closed }` return `SharingState`. `sharing.comment { case_id, body }` (WAG-397) posts an owner
  comment with no parent: the daemon sends `POST /comments { round_seq: newest round, body, author_kind: "owner" }` with the
  owner auth, stores the answer and returns `SharingState`. The relay must accept an owner comment with no `parent_id` (today it
  asks for one); the Mac app shows the relay's line until it does. A local note never uses this call. `sharing.mark_seen { case_id }` and `sharing.unread {}`
  return `{ cases: [{ case_id, count }] }` (team comments the owner has not seen; no network call).
  `sharing.take_notifications {}` returns `{ items: [{ case_id, case_title, comment_id, author_name, body }] }`: the newest 5
  team comments not yet announced, and marks them announced.
- Late comments (WAG-401): a team comment (member or guest) created after the last reply with outcome `decide` (`replaced_at`
  when the answer was changed) is late. `SharingState.late_comments` is `{ count, new }` (`new` = not yet given to the agent;
  zero when the case is not decided). A late comment never starts the comment wake; a comment on an open case, or before the
  decision, wakes as before. `waggle_check` still lists late comments in `shared_comments` with `new: true`.
  `sharing.reopen { case_id, reopened }` -> `SharingState`: `true` sends `PATCH status "open"` (the page drops the Decided block;
  the daemon does not decide the page again until a new answer); `false` sends the old decision again. A new decide answer goes
  up as the new decision (existing outcome call). `sharing.mark_late_given { case_id }` -> `SharingState`: the app sent the late
  comments to the session with `session.send_prompt`; they are marked given. No relay change.
- Event `comment.added { case_id }` when team comments (a member or a guest) arrive. `case.updated` still comes for any change.
- Fetch schedule: the tick fetches the comments of every shared case, also after the answer. Every minute while an ask is open
  or the case was touched (an update, the app opened it, a team comment) in the last hour; every 10 minutes after; every 60
  minutes after 7 days. The daemon does not idle out while a case is shared and the app is connected. With the app closed it
  idles out as before (no LaunchAgent): comments come in at the next start.
- Limits and upgrade: the cap of 2000 comments per case counts and blocks member and guest comments only; owner and agent replies
  are never blocked by it or by closed comments. `round_seq` must name a round that exists. Daemon migration 52 gives each old
  share the signature of its last reply, so an answer made before the upgrade is not published as a decision.
- The answer: when the owner decides (a reply whose outcome is `decide`), the daemon sends `PATCH { status: "decided",
  decided: { options: [titles], note?, at } }`. A failed call is sent again by the tick. A reply that only keeps talking sends
  nothing.
- The ask: when the need, the options or the recommendation change with no new artifact, the daemon sends `PATCH { ask }`
  (not a new round). A change that comes with a new artifact goes up with that round.
- A follow-up (`follows` names a shared case), made while Sharing is on, uses the same link: its row in `relay_shares` has the
  same relay case and `root_case_id`; its artifacts are new rounds with its ask, or a `PATCH { ask }` when it has none. A
  comment goes to the case whose round it is on. Stop sharing of either case takes the page down for all of them. The
  Settings count counts links, not cases.
- Agent view: each `shared_comments` item adds `id`, `reply_to` (id of the first comment of its thread, or null), `resolved`,
  and `new: true` only when the agent was not given it before (the daemon marks the comments given when a result with them
  goes to the agent). `author_kind` may be `agent`. An area comment never has `area: null`: it is the words near the box, the
  image name, or "a region <w> by <h> px at <x>, <y>". A new team comment ends a waiting `case.wait` at once with a `pending`
  result that carries the comments, and wakes a session Waggle can nudge (the nudge says it is a comment, not an answer).
- `waggle_update` adds `reply_to_comment: { comment_id, body }`. The daemon posts it as the Agent. The update is applied in all
  cases. The result adds one line (`comment_reply` in `case.update`) when the reply failed (comments closed, an unknown
  comment id, Sharing off). See the guide topic `team-comments`.

## Events (`events.subscribe`)

Settled in KNOCK-02: `events.subscribe` first returns `result: {}`, then streams each event as a JSON-RPC
notification `{"jsonrpc":"2.0","method":"event","params":<Event>}` on the same connection.
Errors: invalid params `-32602`; unknown case id `-32001` ("case not found").
Storage adds a `messages` table (agent/human messages of a case) beside the eight listed tables.

`case.created`, `case.updated`, `revision.added`, `reply.state_changed`, `session.state_changed`,
`session.nudged` (HAIL-76, carries `case_id`, `reply_id`, `session_id`), `case.open_requested` (HAIL-134,
carries `case_id`: a Claude Code mod asked the app to open that case), `comment.added` (WAG-394, carries `case_id`: new
team comments reached a shared case).
Each carries `{ type, case_id?, reply_id?, session_id?, at }`. The app re-reads with `cases.get`.

Migration 6 (KNOCK-20) added `sessions.runtime` and `cases.runtime`, both `TEXT NOT NULL DEFAULT
'claude'` with a `claude`/`codex` check constraint, so an existing database still opens and every
pre-Codex row reads as `claude`.

## Artifacts

The shim does all the reading of the agent's project folder (HAIL-26). It resolves the artifact
path against its cwd, runs every validation rule, and copies the artifact into
`KNOCK_HOME/incoming/<uuid>/` - a screenshot as `shot.<ext>`, an HTML bundle as a directory - then
sends the daemon that incoming path. The daemon re-validates the incoming copy with the same rules,
moves it into storage, makes it read-only and removes the incoming directory.

- Screenshot: moved to `blobs/<sha256>.png` (PNG or JPEG accepted, max 20 MB).
- HTML bundle: the directory is moved to `bundles/<case_id>/r<revision>/` (max 50 MB, max 2000
  files). Reject symlinks, absolute paths and `..` segments. `entry` must exist inside it.
  - `viewport`/`preview` (HAIL-49; sizing amended HAIL-49 A1): the case pane's small card needs
    more than a desktop-width screenshot of `entry` to be informative. `viewport: { width, height }`
    is the size Waggle renders the bundle at instead of its own default (e.g. a phone at 390x844).
    `preview` names a file inside the bundle, purpose-built for the card - a small summary of the
    decision, never a screenshot of the page: a `.html` file renders at the card's own live size (its
    measured width, 280 pt tall), a `.png`/`.jpg` file shows scaled to the card's width. Both are
    optional and stored per revision (`waggle_update`'s new revision carries its own). `preview` takes
    priority over `viewport`; with neither, Waggle falls back to rendering `entry` at the card's own
    size too. Same path rules as `entry` (relative, no "..", no symlink, must resolve inside the
    bundle dir); an unrecognized `preview` extension is rejected. The app's card picks: the agent's
    preview, else the agent's viewport (a phone-shaped frame at a 420 pt card when narrower than
    tall, full fill-width crop otherwise), else the card-sized fallback, top-aligned, with a soft
    fade at the bottom only when the page's own content ran taller than the card. The card measures
    its own live width and re-renders when it changes by more than about 40 pt, debounced; the
    render is cached per case, revision and width bucket.
- Markdown (HAIL-33): one `.md` or `.markdown` file, staged the same way as a screenshot and moved to
  `blobs/<sha256>.md`, max 1 MB. The review viewer renders it with the app's typography (headings,
  lists, code blocks, tables, links); no remote images, no scripts. A link opens in the default
  browser only after a confirmation. Queue rows show "Explanation".
- Screenshots (HAIL-40): 2 to 12 images the operator flips through one at a time, each with an
  optional caption and optional `item`: `{ "type": "screenshots", "items": [{ "path": "...", "caption": "...", "item": "..." }, ...] }`.
  `item` (trimmed, 1 to 40 characters, additive): the id of the decision item the image belongs to. The shim
  stages it, the daemon stores it in `items_json` and `artifact.path` returns it per item. With several
  decisions the app shows only the images of the decision on screen; an image with no `item` shows with every
  decision. Without any `item` the app reads a caption prefix (a number, then a space, `·`, `.`, `:`, `)` or
  `-`, or a letter and number like `b1`), else the WAG-352 rule applies. A lone letter (`B · Tap`) names a
  variant of a decision, not a decision (2026-11-12): a set whose captions use only lone letters keeps every
  image with every decision.
  Each item is staged and re-validated exactly like a single screenshot (PNG or JPEG, max 20 MB,
  copied into `KNOCK_HOME/incoming/<uuid>/` as `shot-1.<ext>` .. `shot-N.<ext>`, incoming rules
  above) and moved into `blobs/<sha256>.<ext>` individually, so identical images across items or
  across cases still share one blob. A revision of this kind stores no single `sha256`/`ext`/
  `entry`: its ordered list of `{ sha256, ext, caption?, item? }` lives in the revision's `items_json`
  column instead, the same JSON-column convention `options_json`/`rect_json` already use. The app
  shows one image at a time with a thumbnail strip; in Comment mode each image is its own capture
  (see "Reply payload" above and "Case fields" `artifact_kind`), so the friend's pins on screen 2
  never mix with screen 5's. Queue rows show "Screenshots". Use it instead of one `screenshot` when
  there is more than one image to review in sequence, and instead of an `html_bundle` gallery when
  the images are not an interactive prototype - `waggle_guide`'s `artifacts` topic covers the choice.
- Diagram (HAIL-141): one `.mmd` (Mermaid source) or `.svg` file, staged the same way as a
  screenshot and moved to `blobs/<sha256>.<ext>`, max 512 KB. The review viewer renders it in the
  same isolated, offline web viewer as an `html_bundle`, wrapped in a small generated page. `.mmd`
  source is drawn with a pinned Mermaid build bundled in the app resources (MIT license shipped
  next to it, no CDN); `.svg` is shown as is after sanitising (strip `<script>`, `on*` attributes,
  `<foreignObject>`, and external `href`s). Zoom/pan (HAIL-127/131) and Comment mode work on it. A
  render error shows "Waggle could not draw this diagram" plus the source in a mono block. The case
  pane card shows a scaled render of the diagram (no separate preview file). Queue rows show
  "Diagram".
- `case.create` and `case.update` accept an artifact only when its path is inside
  `KNOCK_HOME/incoming/` after `realpath`. Any other path is rejected with
  "artifact must be staged by the shim", which tells an old shim's agent to restart the session so
  it picks up the updated connector. The daemon never falls back to reading the session cwd.
- Inline content (HAIL-163): the shim writes it into `KNOCK_HOME/incoming/<uuid>/` and sends the
  daemon the staged path, so the daemon, the storage and the app see no difference. The size limits
  are the same as for a file. `content` (markdown): at most 1 MB of UTF-8. `html`: at most 50 MB, one
  page staged as a one-file bundle (`index.html`); it takes `viewport` and rejects `preview` (there
  is no second file). `data_base64`: PNG or JPEG, an optional `data:image/...;base64,` prefix is
  stripped, at most 20 MB after decoding (the encoded text is about a third larger; agents should
  keep images small because the text passes through the chat). A rejected item leaves no case. A
  daemon call that still carries content (not through the shim) is rejected with "artifact must be
  staged by the shim". Diagram has no inline form.
- Staged copies are read-only (`chmod -R a-w`). A later change in the agent's working tree never
  changes a staged revision.

## HTML preview isolation (app side)

A staged bundle renders in a `WKWebView` that:
- loads with `loadFileURL(entry, allowingReadAccessTo: bundleRevisionDir)`;
- has a `WKContentRuleList` that blocks every URL that is not `file://` inside that directory;
- has no `WKScriptMessageHandler` and no injected user scripts (no bridge to the app);
- uses a non-persistent `WKWebsiteDataStore`.
If any isolation check fails, the app falls back to screenshot-only review for that case.

### Session line and earlier asks (HAIL-102)

No protocol change. The app builds both from data it already reads. The session line uses
`SessionInfo.context.said` from `sessions.list` (matched by `task_id`) and `connected_at`. The earlier
asks are the other `cases.list` rows with the same `task_id`, created before the open ask and not
dismissed or withdrawn. Each gives an answer item (`latest_reply_choice` or `latest_reply_message`) and an
update item (`latest_update_message`).

### Guided connect and test overrides (HAIL-148)

Settings > Phone guides the operator through each connector. Every URL it opens is opened by the app on a
click (`NSWorkspace`); the daemon only returns plain fields. Telegram: `https://t.me/BotFather`, then
`https://t.me/<bot_username>?start=<code>` (one tap sends `/start <code>`). Slack:
`https://api.slack.com/apps?new_app=1&manifest_json=<percent-encoded manifest>`, then
`https://api.slack.com/apps/<app_id>/general` for the app-level token, then `slack://user?team=<team_id>&id=<bot_user_id>`
to open the DM with the bot. `SlackStatus` carries `app_id`, `team_id` and `bot_user_id` for those links.
`check_tokens` swaps tokens pasted in each other's box and names the field in its error. A bad token shape is
refused before any call.

Test overrides: `KNOCK_TELEGRAM_BASE_URL`, `KNOCK_SLACK_BASE_URL`, `KNOCK_SLACK_SOCKET_URL`,
`KNOCK_RELAY_BASE_URL` (WAG-387) and `KNOCK_SECRET_STORE=memory` work only in a dev daemon (`bun run build`, which
defines `KNOCK_DEV_BUILD=true`). `bun run build:release`, used by `scripts/release.sh` and `scripts/build-local.sh`,
leaves it out: that daemon ignores all five. Unit tests pass fakes to the connector constructors and never use these variables.

## Corrections (WAG-414)

Migration 59 adds `replies.correction` (`1`, `0` or null) and `cases.mind_changed_at`. It also lets the usage log take the event `correction`.

A reply is a correction when it decides (Decide, not Keep talking) and at least one of these is true:

- A pick is not the recommended option. A multi-select pick is not the recommended set. An item with no recommendation is never a correction because of its pick.
- The person wrote their own answer: the text of a reply item.
- The person requested changes on a review (`request_changes`), or left comments on the reply.
- The person used "Change my mind" on an auto-decided ask. `changeMind` sets `cases.mind_changed_at`, so the next deciding reply on that case is a correction.

The daemon computes the flag from the stored reply (`daemon/src/corrections.ts`) when it stores or replaces the reply. `1` is a correction. `0` is a reply that decided and is not one. Null is a reply that did not decide (Keep talking, more detail, a feedback note). The migration backfills old replies from the stored picks, text and comments. A "Change my mind" of the past is not in the data: that reply keeps the flag its other rules give.

The usage log gets `{ event: "correction", ask_h }` once per reply that becomes a correction. It holds no ask text and no reply text. The export keeps coded values only.

`stats.corrections { project?, weeks = 12 }` returns `{ project?, weeks: [{ week, starts, asks, corrections, per_ask }] }`, oldest first. `week` is an ISO 8601 week such as `2026-W46`, in UTC. `starts` is its Monday. `asks` counts the cases with a deciding reply that week. `corrections` counts the flagged replies. `per_ask` is `corrections / asks` (two decimals), or null when `asks` is 0. A week with no asks is listed. Without `project` all projects count. Failed and superseded replies do not count.

## Project page (WAG-260)

A project is the `tasks.project` tag. Migration 35 adds `project_themes` and `project_prefs`.

- `project.get { project }`: `decisions`, `comments`, `last_decision_at`, `repo_records`, `themes`.
- `project.decisions { project, limit = 50, offset = 0 }`: `{ items, total }`, newest first. A case counts once, when its newest non-failed, non-superseded decision reply has a choice. Dismissed and withdrawn cases do not count. `why` is the reply note, else the `recommendation_why` of the option set the reply chose from.
- `project.theme_toggle { id, enabled }` and `project.set_repo_records { project, enabled }`.
- MCP `waggle_themes { action: "propose", themes: [{ text, evidence_count, quotes[≤3] }] }` (at most 8; alias `knock_themes`). The daemon merges by case-insensitive exact or prefix text and never turns an off theme on.
- `waggle_guide` topic `project`: the last 10 decisions, the ON themes, the `docs/decisions/` instruction when the switch is on, and, when themes are stale (none proposed yet, or more than 20 new comments since), the last 50 comments. A comment is a pin on a reply or the note of a decision reply.
