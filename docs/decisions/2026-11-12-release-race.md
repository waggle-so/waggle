# How does a release survive a merge during its build?

Decided: 2026-11-12 · Case: c_e2b0ca94-c73c-4b18-9704-a9e3e52362fa

## Question and choice
The Release run for #23 published v0.2.70. Then it could not push its version bump, because #25 and #26
merged during the build. `main` stayed at 0.2.69, so the next run built v0.2.70 again and failed:
"a release with the same tag name already exists". How do we unstick `main` and stop this?

The human chose "Fix PR, then v0.2.71".

## What changes
1. `main` goes to 0.2.70 (BuildNumber 135), and tag v0.2.70 points at 75ab2c23, the commit v0.2.70 was built from.
2. release.yml pushes the tag first, then pushes the bump. If `main` moved, it rebases the bump and tries again, up to 3 times.
3. The Plan step stops early when the release already exists in waggle-releases, not after the build.
4. The merge of this change releases #25 and #26 as v0.2.71.

## Constraints
- The bump commit keeps `[skip ci]`, so it starts no CI run and no second release.
- The concurrency group `release` stays: only one release runs at a time.

## Ruled out
- Bump only: `main` gets unstuck, but the next merge during a build breaks it again.
- Do nothing: the tool hints stay unreleased, and each merge gets a failed Release run.
