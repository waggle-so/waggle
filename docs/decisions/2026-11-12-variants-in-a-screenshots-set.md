# How do we show the variants of a decision in a screenshots set?

Decided: 2026-11-12 · Case: c_f5c99209-8cd2-4b83-bc72-91b2f7949918

## Question and choice
A screenshots set "Varianti S7" in a request with 4 decisions showed variant A on decision 1, B on decision 2
and C on decision 3. How should the box show all the variants of a decision?

Two parts:
1. **Bug, fixed (cfe6128).** A caption that starts with a lone letter ("B · Riga…") was read as decision B.
   A lone letter now names a variant; numbers ("2. …") and a letter plus a number ("b1") still name a decision.
   This replaces the lone-letter part of `2026-11-10-screenshots-per-decision.md`.
   - Open cases and agents on an older guide: a set with no `item` whose captions use lone letters ("b · …")
     stops filtering by decision once this ships, and every image shows with every decision. Accepted: nothing
     is hidden, and the guide now tells agents to use `item`.
   - When a set with no `item` uses "b1"-style captions that name decisions, the letters are decisions, not
     variants: no badges and no «On screen».
2. **Design, after 5 rounds: "Compact row, title on top"** (`design/mockups/2026-11-12-screen-row-v4/`).
   - One flat row of every screen of the decision: A1 A2 B C1 C2 C3, then the shared images after a line.
     No grouping by variant; ← → go screen by screen.
   - Small thumbnails, all one size, on one line. Up to 12 screens fit with no scroll.
   - The variant label sits inside the thumbnail, top left (black on the screen on show). A variant with one
     screen keeps only its letter ("B"). Screens with no lettered caption get no label.
   - The title of the screen on show sits in the box header, next to the set name: "C2 Riepilogo dopo la sync…".
     Other captions show on hover.
   - The counter ‹ 5 / 7 › sits at the end of the row.
   - In the decision panel, the option of the screen on show gets «On screen». The pick does not change.
     A click on an option's letter goes to its first screen.

## Why
- "tutte le varianti dovrebbero essere raggruppate meglio qui ed essere sempre visibili" (the bug report).
- "metterei tutti gli screen in alto senza raggrupparli per variante … vorrei girare tra una schermata e l'altra
  molto velocemente … A1, A2, A3, B1, B2, B3" (round 2).
- "cerchiamo di guadagnare il più spazio possibile … tutte le varianti sono spiegate nella prima sezione … lo
  facciamo solo on over … la lettera possiamo anche metterla interna oppure in alto a sinistra" (round 4).
- "mostrerei da qualche parte il titolo di quello che stiamo visualizzando, quindi non solo on over" (round 5).
- Mine: a set holds at most 12 images (`daemon/src/protocol/nouns.ts:212`), so a row that fits 12 never scrolls.
  «On screen» ties the screen to the option, which is what the bug broke.

## Constraints
- A set still filters to the decision on screen (`CommentsSessionStore.galleryScreens`); shared images show with
  every decision, after the line.
- The app numbers the screens of a variant itself (A1, A2) from captions that start with the same lone letter.
  Agents do not have to write "A1".
- No caption line under the row: the title lives in the box header.
- The comment count badge on a thumbnail stays.
- Full size uses the same row (one component), so the box and full size look the same.

## Ruled out
- Round 1 "Grouped strip" and "Compare side by side": the person picked tabs, then asked for a flat row.
- Round 1/2 "Named tabs" and "Letter tabs + pager": two levels (variant, then screen) slow down flipping.
- Round 3 caption line under the row: costs height; the options already explain the variants.
- Labels under the thumbnails (round 4): replaced by the letter inside the thumbnail.
- Reading captions against option titles to find variants: fragile with free text.

## Comments
- Round 1, "metterei solo A, B o C": labels are letters only.
- Round 1, "se una variante ha più screen … dobbiamo gestire bene": A1 A2 numbering, every screen in the row.
- Round 4 scrawl, thumbnails not aligned: one size for every thumbnail, letter inside, so they align.
- Round 4 scrawl, "questa come dimensione": the compact size is the size for every set.
- Round 5 scrawl, title always visible: title in the box header.
- Round 3, "possiamo fare ancora meglio vedendo i contro?": round 4 fixed the four cons (scroll, names,
  numbers vs letters, long rows).

## Open questions
- A caption "A1 · …" in a set with no `item` still names decision A (the "b1" rule). Agents should use `item`
  for decisions and a lone letter for variants; the guide already says "Prefer `item`". Decided: no rule change now.

## Sources
- Case c_f5c99209-8cd2-4b83-bc72-91b2f7949918, rounds 1–5.
- Mockups: `design/mockups/2026-11-12-variants-grouping/` (round 1) and `-screen-row-v4/` (chosen), HTML only.
  Rounds 2 to 4 (variant tabs, screen row v1 to v3) are summed up under Ruled out and not kept in the repo.
- `apps/macos/Sources/Knock/AskDoc/DecisionArtifactRule.swift` (imageGroup, captionDecision).
- `apps/macos/Sources/Knock/AskDoc/ScreenSetBoxView.swift`, `apps/macos/Sources/Knock/Review/Comments/ScreenshotSetViews.swift`.
- `daemon/src/protocol/nouns.ts:212` (2 to 12 images per set).
