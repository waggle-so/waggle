# Compact screen row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every screen of the decision on screen in one compact row above the image, labelled A1 A2 B C1…, with the title of the screen on show in the box header and «On screen» on the matching option.

**Architecture:** A pure `ScreenRowLabels` computes each screen's badge, variant and shared flag from captions and items. One SwiftUI `ScreenRow` view draws the row; `ScreenSetBoxView` (box) and `ArtifactViewerView` (full size) both use it in place of today's dots, thumbnails and `ScreenshotFilmstrip`. The box header and the option rows read the current screen's label from `CommentsSessionStore`.

**Tech Stack:** Swift 6, SwiftUI (macOS), Swift Testing (`apps/macos/Tests/KnockTests`).

**Spec:** `docs/decisions/2026-11-12-variants-in-a-screenshots-set.md` · mockup `design/mockups/2026-11-12-screen-row-v4/index.html`

## Global Constraints
- A set holds 2 to 12 images (`daemon/src/protocol/nouns.ts:212`): the row fits 12 with no scroll in a box of 600 pt.
- Thumbnail: one size for all, 46 × 29 pt, corner 4, gap 4 pt inside a variant, 6 pt between variants, a 1 pt line before shared images.
- Badge: top left inside the thumbnail, 13 pt high, 9 pt bold; black with white text on the current screen, white with ink text elsewhere.
- No caption line under the row. Caption of any thumbnail on hover (`.help`).
- Counter `‹ n / total ›` at the end of the row (the arrows step one screen).
- The comment count badge (top right, accent) stays on thumbnails.
- `galleryScreens` filtering by decision stays as it is.

## Review Focus
- A set with no lettered captions: no badges, no gaps; row still fits and steps. (Task 1 test `plainCaptionsGetNoBadge`.)
- Captions "A · x", "a · y" (case) and "A: z" (other separator) are one variant A1 A2 A3. (Task 1 test `letterCaseAndSeparatorsAgree`.)
- A one-screen set, or a box under 600 pt: today's dots/arrows still work; the row hides with one screen. (Task 2 step.)
- A decision whose options outnumber the letters, or a letter past the options (F with 3 options): no «On screen». (Task 4 test `letterPastTheOptionsMarksNothing`.)
- A caption "A1 · x" in a set with no `item`: still read as decision A by `captionDecision` (record, Open questions); labels read it as variant A. (Task 1 test `letterNumberCaptionIsVariantA`.)

---

### Task 1: ScreenRowLabels (pure)
From the record: "The app numbers the screens of a variant itself (A1, A2) from captions that start with the same lone letter." and "A variant with one screen keeps only its letter ("B"). Screens with no lettered caption get no label."

**Files:**
- Create: `apps/macos/Sources/Knock/Review/Comments/ScreenRowLabels.swift`
- Test: `apps/macos/Tests/KnockTests/ScreenRowLabelsTests.swift`

**Interfaces:**
- Produces: `struct ScreenRowLabel: Equatable { let badge: String?; let variant: Character?; let isShared: Bool }` and `enum ScreenRowLabels { static func labels(captions: [String?], items: [String?]?) -> [ScreenRowLabel]; static func variantLetter(_ caption: String?) -> Character? }`

Rules: `variantLetter` = first char an ASCII letter, followed by end, a separator (` ·.:)-`) or digits then a separator; uppercased. Badge = letter when the letter appears once in `captions`, else letter + its 1-based count in order. `isShared` = `items` has any non-nil and this item is nil.

- [ ] **Step 1: Write the failing tests**: `oneScreenPerVariant` (["A · x","B · y","C · z"] → badges A, B, C); `severalScreensNumbered` (["A · x","A · y","B · z","C · 1","C · 2"] → A1 A2 B C1 C2); `plainCaptionsGetNoBadge` (["Riga", nil] → nil, nil); `letterCaseAndSeparatorsAgree` (["A · x","a · y","A: z"] → A1 A2 A3); `letterNumberCaptionIsVariantA` (["A1 · x","A2 · y"] → A1 A2); `sharedComesFromItems` (items [d1, nil] → isShared false, true; items nil → all false); `wordIsNotAVariant` (["Legend","Avviso"] → nil).
- [ ] **Step 2:** `cd apps/macos && swift test --filter ScreenRowLabels` → FAIL (type missing).
- [ ] **Step 3:** Implement `ScreenRowLabels.swift`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(review): label the screens of a set by variant`.

Acceptance: all 7 tests pass; no change to `DecisionArtifactRule`.

### Task 2: ScreenRow view in the box
From the record: "One flat row of every screen of the decision … ← → go screen by screen", "Small thumbnails, all one size, on one line. Up to 12 screens fit with no scroll", "The counter ‹ 5 / 7 › sits at the end of the row."

**Files:**
- Create: `apps/macos/Sources/Knock/Review/Comments/ScreenRow.swift`
- Modify: `apps/macos/Sources/Knock/AskDoc/ScreenSetBoxView.swift` (replace `dots`, `thumbnails` and the caption `Text`; row moves above `PinnedStillView`)
- Modify: `apps/macos/Sources/Knock/Review/Comments/CommentsSessionStore.swift` (add `var galleryLabels: [ScreenRowLabel]` from `captions`/`items` of `galleryScreens`, built with Task 1)
- Test: `apps/macos/Tests/KnockTests/ScreenRowLabelsTests.swift` (add `galleryLabelsFollowTheDecisionGroup`)

**Interfaces:**
- Consumes: `ScreenRowLabels.labels`.
- Produces: `struct ScreenRow: View { init(store: CommentsSessionStore, current: String?, onSelect: (String) -> Void, onStep: (Int) -> Void) }`; `CommentsSessionStore.galleryLabels: [ScreenRowLabel]`, `CommentsSessionStore.currentLabel: ScreenRowLabel?`.

- [ ] **Step 1:** Failing test `galleryLabelsFollowTheDecisionGroup`: store with 4 screens captions A·, A·, B·, legend, items [d1,d1,d1,nil]; `showDecisionGroup([0,1,3])` → badges A1, A2, nil; the third has `isShared == true`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement `galleryLabels`, `currentLabel`, `ScreenRow` (sizes from Global Constraints; `.help(store.screenTitle(for:))`; accessibility label "Screen A2" or "Screen 3"). **Step 4:** run → PASS.
- [ ] **Step 5:** Build and look: `cd apps/macos && swift build` OK; run the app (`run` skill) with the round-3 Waggle case and screenshot the box: 7 screens one line, C2 black badge.
- [ ] **Step 6:** Commit `feat(review): compact screen row in the artifact box`.

Acceptance: row above the image; 12 screens fit at 600 pt with no scroll; with one screen the row hides; ← → still step (existing `onStep`); comment badges still show.

### Task 3: Same row in full size, title in both headers
From the record: "Full size uses the same row (one component)" and "The title of the screen on show sits in the box header, next to the set name".

**Files:**
- Modify: `apps/macos/Sources/Knock/Review/ArtifactViewerView.swift:864` (`ScreenshotFilmstrip` → `ScreenRow` above `stageContent`)
- Modify: `apps/macos/Sources/Knock/AskDoc/LiveArtifactView.swift:680` (`header`: after the tab label, for a screenshots tab, `Text` "<badge> <caption>" with badge bold, truncating tail, a 1 pt line before it)
- Modify: full-size header in `ArtifactViewerView.swift` (same text)
- Delete: `ScreenshotFilmstrip` in `ScreenshotSetViews.swift` if nothing else uses it (`rg ScreenshotFilmstrip`)

**Interfaces:** Consumes `ScreenRow`, `CommentsSessionStore.currentLabel`, `screenTitle(for:)`.

- [ ] **Step 1:** Replace and add the header text. **Step 2:** `swift build` OK; `swift test` all pass. **Step 3:** run the app, screenshot box and full size on the same screen: same row, title "C2 Riepilogo…" in both headers. **Step 4:** Commit `feat(review): screen title in the header, one row in full size`.

Acceptance: no caption line under any row; header title updates on ← →; a screen with no caption shows "Screen N".

### Task 4: «On screen» on the option of the current screen
From the record: "In the decision panel, the option of the screen on show gets «On screen». The pick does not change."

**Files:**
- Modify: `apps/macos/Sources/Knock/Composer/OptionChipView.swift` (new `var isOnScreen = false`: a small chip "On screen" with a honey dot, after the title)
- Modify: `apps/macos/Sources/Knock/Composer/ComposerCardView.swift:279` (pass `isOnScreen: option.id == onScreenOptionId`; new input `onScreenOptionId: String?`, find its callers with `rg "ComposerCardView\("`)
- Create in `ScreenRowLabels.swift`: `static func onScreenOption(letter: Character?, options: [Option], anchorImage: (Option) -> Int?, labels: [ScreenRowLabel]) -> String?`
- Test: `ScreenRowLabelsTests.swift`

Rule: an option whose `anchor` resolves (`DecisionArtifactRule.imageIndex`) to an image with the current letter wins; else the option at position letter−'A' when it exists; else nil.

- [ ] **Step 1:** Failing tests `anchorWins`, `positionWhenNoAnchor` (letter C, 3 options → third), `letterPastTheOptionsMarksNothing` (F, 3 options → nil), `noLetterMarksNothing`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement and wire. **Step 4:** run → PASS; `swift test` all pass.
- [ ] **Step 5:** run the app: on C2, option 3 shows «On screen», the pick stays on option 1. Screenshot.
- [ ] **Step 6:** Commit `feat(review): mark the option of the screen on show`.

Acceptance: the chip never changes the pick; it shows only while a screenshots set with lettered captions is on screen.

### Task 5: Guide text and release check
From the record, Open questions: "Agents should use `item` for decisions and a lone letter for variants".

**Files:** Modify `daemon/src/guide/artifacts.md:347-353` (one paragraph: letter the variants "A · …", several screens of a variant share the letter, Waggle numbers them A1 A2; use `item` for the decision).

- [ ] **Step 1:** Edit. **Step 2:** `cd daemon && npm install && npm test` (the worktree has no `node_modules`). **Step 3:** Commit `docs(guide): letter the variants, Waggle numbers their screens`.

Acceptance: daemon tests pass; the guide no longer suggests "b1" captions for variants.
