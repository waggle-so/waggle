# What does the Waggle Brain do, and how?

Decided: 2026-11-13 · Case: c_0376ace2-ac93-4913-93ab-bff7f064d27d

## Question and choice
The question: Waggle should collect the memory of past decisions and use it to inform the next ones. What does
the first version do, and how does it reach the agent?

The operator chose, in four rounds:
1. First job: "Better recommendations". Waggle gives the agent the past decisions and preferences that fit the ask.
2. Scope: "Two layers". Full decisions stay in their project. Short general preferences cross all projects.
3. Entry: "On at once, you can edit". A proposed preference works at once. The app shows it with its evidence.
4. Delivery: "Always loaded + check at ask". Preferences load when the agent connects. Waggle searches the
   project decisions at each ask and returns matches to the agent first.

## Why
- The goal is fewer corrections per ask: the recommendation and the first draft are closer to the operator's pick.
- Recall is the base. Auto-answers and a Brain page both need good recall first.
- Work content must not leak between projects. A short rule can cross; the full text cannot.
- Agents often skip an optional tool. The connect text and a check inside `waggle_ask` need no agent discipline.
- The operator gave no extra reasons in the replies. Each pick was the recommendation.

## Constraints
- Local only. No new network call. No model inside Waggle: an agent in session writes each preference.
- Evidence (cases, quotes) shows only in the app. Agents in other projects get the rule text only.
- An all-projects preference has no project name and no project content.
- A preference the operator turned off never comes back from a later proposal.
- A review is never held by the check. A second send of the same ask always goes through.
- If the search fails, the ask goes through.
- The usage log holds coded counts only. No ask text, no preference text.
- The connect block has at most 30 lines.
- UI copy: plain, friendly, no em-dashes. The Brain page gets a prototype round in Waggle before the build.

## Design

### 1. Preferences
- A preference is one short rule with a scope: `project` or `all`.
- Today's rows in `project_themes` become preferences with scope `project`. `waggle_themes` keeps working.
- Each preference keeps its evidence count and up to 3 quotes, as themes do today.

### 2. Corrections
Waggle marks a reply as a correction when one of these is true:
- the pick is not the recommended option,
- the operator wrote their own answer,
- the operator requested changes on a review, or left comments,
- the operator used "Change my mind" on an auto-decided ask.

The daemon computes this from the reply. It stores one flag per reply.

### 3. Learning
- When a project has enough new corrections since the last proposal, the `project` guide topic tells the agent to
  propose preferences. Today the trigger is 20 new comments (`STALE_COMMENT_COUNT`); corrections join it.
- The guide gives the agent the corrected asks: the question, the recommendation and what the operator did.
- The agent sends each proposal with a scope.

### 4. Delivery at connect
- The shim's connect text (`instructionsFor`) gets a block "How this person decides".
- Order: `all` rules first, then this project's rules. Limit: 30 lines.

### 5. Check at ask time
- An FTS5 table indexes each decided ask: question, option labels, pick, why. One row per case, with the project.
- On `waggle_ask` for a decision (not a review), the daemon searches this project and takes up to 3 strong matches.
- With matches, the first call returns them and does not create the case. The text tells the agent to drop the ask,
  send a better one that names the old decision, or send the same ask again.
- The second send creates the case. The case stores the matched case ids. The card shows "Based on N past decisions".

### 6. Where you see the rules (changed 13 Nov, case c_a9dcf761-d3b6-4616-83d7-23f60e1cf7fe)
- No Brain page. The operator asked "do we really need a brain page?" and picked a section in Settings.
- Settings > Requests gets a section "What your agents learned", under Small things.
- One plain list, like the other Settings rows: the rule, one grey line ("Every project · from 7 decisions"), a switch.
- Click a rule to unfold its evidence (question and what the operator did), with "Edit" and "Only this project" / "Every project" links.
- 5 rules show. The rest fold under "Show N more". The last link is "Add a rule".
- No measure on screen for now. The RPC from task 2 stays for later use.
- The approved prototype is in the case. The operator called the first, page version "very messy".

### 7. Tests
- Correction rules (unit). Search and hold on a temporary `KNOCK_HOME`. The connect text. The migration of themes.

## Ruled out
- Fewer asks first (auto-answers from the Brain): a wrong auto-answer costs trust, and it needs good recall first.
- A Brain page first: more UI before agents get better.
- All projects mixed in recall: work text from one project can show in another.
- A per-project privacy switch: the operator must remember to set it.
- Approve each preference first: one more queue to clear.
- A Brain page in the sidebar with the measure: the operator found it not needed and the first design messy.
- A recall tool only (`waggle_recall`): agents forget to call it.
- Always loaded only: no fit to the ask, and the list grows in every session.
- Meaning-based search (embeddings) in this version: full-text first, then measure the misses.

## Comments
none.

## Open questions
- The match threshold for "strong" in the full-text search. Set it from tests on real decided asks.
- How many new corrections make the preferences stale. Start with 5 and tune.
- Two ideas from the operator's reading (Every, "The most important formula in AI"): an ask that goes against a rule says so, and the agent states how sure it is. Not in this version; propose after tasks 1 to 8.

## Tasks
| # | Task | Done when | From |
|---|---|---|---|
| 1 | Corrections | Each decision reply stores a correction flag by the four rules; usage logs a coded `correction` event; unit tests pass | Design 2 |
| 2 | Measure | An RPC returns corrections per ask by week; the daemon test covers a week with and without corrections | Design 6, "One number" |
| 3 | Preferences with scope | A migration moves `project_themes` rows to scope `project`; propose, list and toggle accept a scope; a turned-off preference stays off | Design 1, Constraints |
| 4 | Learning trigger | The `project` guide lists corrected asks and asks for proposals after 5 new corrections; a test covers the trigger | Design 3 |
| 5 | Connect block | `instructionsFor` adds "How this person decides", `all` first, 30 lines at most, rule text only; snapshot test | Design 4, Constraints |
| 6 | Index | An FTS5 table holds each decided ask; a migration fills it from old cases; search filters by project | Design 5 |
| 7 | Check at ask | A decision ask with matches returns them one time; the second send creates the case with the matched ids; reviews and search errors pass through; `docs/protocol-mvp.md` updated | Design 5, Constraints |
| 8 | Card line | The case card shows "Based on N past decisions" with links to the cases | Design 5 |
| 9 | Settings prototype | Done 13 Nov: approved in case c_a9dcf761-d3b6-4616-83d7-23f60e1cf7fe | Design 6 |
| 10 | Settings section | Settings > Requests lists, unfolds, edits, toggles and adds rules as in the approved design; window capture of the section; Swift tests pass | Design 6 |

## Sources
- Case c_0376ace2-ac93-4913-93ab-bff7f064d27d
- `daemon/src/guide/project.ts`, `daemon/src/projects.ts` (recent decisions and themes today)
- `daemon/src/guide/decision-record.md`
- `docs/decisions/2026-10-27-fewer-low-stakes-asks.md` (the Ask less rules)
- `daemon/src/mcp/shim.ts` (`instructionsFor`, the connect text)
- The post the operator pasted on 13 Nov 2026 (one queue, a "brain" that learns the person's judgment)
