# How should the answered card show long text?

Decided: 2026-11-17 · Case: c_026fe8aa-bc3d-489c-a906-ba2ea8a81d0b

## Question and choice
The "1 answered" card cuts the question and the answer after 2 lines. The round title cuts at 80
characters with "…". Nothing showed the full text. The human chose "Add a Show all link": "Keep the
2-line view. Add a \"Show all\" link that opens the full question and answer in place. Do the same for
the round title."

## Why
The human could not read the full answer in a later round ("why i cannot read it all here?").
The card stays short and easy to scan, and the full text is one click away.

## Constraints
- The answered card still shows 2 lines for each text by default.
- "Show all" shows only when the text is really cut. "Show less" closes it again.
- A title stays short (WAG-249). "Show all" shows the whole first sentence as the title, and the
  description shows only the text after that sentence.
- The links come after the text, never between a cut title and its continuation.

## Ruled out
- Always show the full text: long answers make the card tall in every round.
- Leave it as it is: the human cannot read their own earlier answer.

## Comments
none

## Open questions
none

## Sources
- Case c_026fe8aa-bc3d-489c-a906-ba2ea8a81d0b
- apps/macos/Sources/Knock/Plan/PlanViews.swift (the answered card)
- apps/macos/Sources/Knock/Queue/TitleSplit.swift (the 80-character title cut)
