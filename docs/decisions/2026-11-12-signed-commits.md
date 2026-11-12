# How do we make every contributor sign their commits?

Decided: 2026-11-12 · Case: c_241e71e0-8cb9-43a3-9dc2-9ea779eb4a3e

## Question and choice
`main` accepts only signed commits. Contributors find this out only when GitHub refuses the merge, as with
caso's PRs #20 to #24. How do we make signing the default?

The human chose "Docs and a CI check".

## Why
- GitHub cannot sign commits on a contributor's machine. It can only refuse the merge.
- The docs tell people before they commit. CONTRIBUTING.md and AGENTS.md said nothing about signing.
- The CI check fails on the first push of a pull request. At merge time the fix is a rebase and a force-push,
  and the force-push dismisses the approvals.

## Constraints
- The branch rule on `main` (required signatures) stays. The CI job only reports earlier.
- The repo keeps merge commits.
- Agents never turn signing off and never set up a key for the human.

## Ruled out
- Docs only: people still miss it until merge time.
- Squash merges for outside PRs: GitHub would sign the squash commit, but the repo uses merge commits.
