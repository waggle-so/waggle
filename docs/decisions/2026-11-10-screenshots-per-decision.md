# How does a screenshots set know which images belong to each decision?

Decided: 2026-11-10 · Case: c_c4d01e6f-6c26-4d80-a852-51b240bbc0d4

> **Replaced in part (2026-11-12):** a lone letter ("b · Tap on the ring") no longer names a decision; it names
> a variant of one decision. Numbers and letter-plus-number ("b1") still name a decision. See
> `2026-11-12-variants-in-a-screenshots-set.md`.

## Question and choice
A request with several decisions can carry one `screenshots` set. Today a decision maps to one image only:
the anchor of its pick, else image K for decision K (WAG-352). With 4 decisions and 12 images, decision 2
does not open on its own images (4 to 6).

- How the app knows the images of a decision: "Field, caption as fallback". Each screenshot may name its
  decision with a new optional field `item` (the decision item id). When no image of the set has `item`,
  the app reads a leading letter or number in the caption: "b · Tap on the ring" belongs to decision 2.
- What the filmstrip shows: "Only its images". While a decision is on screen, the strip shows only the
  images of that decision, with a count like 1 / 3. Moving to the next decision opens its first image.

## Why
- The field is exact for new asks.
- The caption rule fixes the asks agents already send with letter captions, like the one that raised this.
- A strip with only the decision's images is less to scan.

## Constraints
- Additive: an ask without `item` and without letter captions works as today (WAG-352 rules).
- An anchor on the pick still wins inside the decision's images.
- An image with no decision (no `item`, no prefix) shows with every decision.
- A request with one decision shows all images, as today.
- Full size and the case box follow the same rule (WAG-381).

## Ruled out
- New field only: this ask and older asks stay wrong.
- Caption prefix only: breaks when a caption starts with something else.
- All images in the strip with a jump: the person asked for only the decision's images.

## Comments
none

## Open questions
- Caption prefix forms: a letter (`a`, `b`) or a number (`1`, `2`), followed by a space, `·`, `.`, `:`,
  `)` or `-`, or a letter and a number (`b1`, `b2`). A number prefix means a decision, not an image.

## Sources
- Case c_c4d01e6f-6c26-4d80-a852-51b240bbc0d4.
- apps/macos/Sources/Knock/AskDoc/DecisionArtifactRule.swift (WAG-352 rule).
- daemon/src/protocol/nouns.ts (`ScreenshotsItem`), docs/protocol-mvp.md (`anchor` on a screenshots set).

## Tasks

1. **Add `item` to a screenshot of a set.** Criteria: `ScreenshotsItem` takes optional `item` (trimmed,
   1 to 40 characters); the shim stages it; the daemon stores and returns it; docs/protocol-mvp.md and the
   waggle_ask tool text describe it; a daemon test covers a round trip. From: Question and choice, point 1.
2. **Group the images by decision in the app.** Criteria: a pure rule gives the images of each decision
   from `item`, else from the caption prefix, else `nil` (today's rule); Swift tests cover the field, each
   prefix form, an image with no decision, and one decision. From: Question and choice, point 1; Constraints.
3. **Show only the decision's images.** Criteria: in the case box and in full size, the strip shows only
   the images of the decision on screen with "k / n"; Next or a choice moves to the next decision's first
   image. From: Question and choice, point 2.
4. **Tell agents.** Criteria: the waggle_guide artifacts topic shows a screenshots set with `item`. From:
   Why, line 1.
