# Contributing to Waggle

Thanks for your help. Bug reports, fixes, docs and ideas are all welcome.

## License of your contribution

Waggle is licensed under Apache 2.0. A contribution you send is licensed under the same terms
(inbound = outbound, as in section 5 of the license). There is no CLA to sign.

## What you need

- macOS 14 or later, with Xcode 26 or later (Swift 6.2+). Swift 6.1 does not build the app.
- [Bun](https://bun.sh) 1.3 or later.
- No Apple Developer account. A build from source is ad-hoc signed.

## Build and test

Run these from the repository root.

```bash
cd daemon && bun install && bun test          # daemon unit and integration tests
cd daemon && bun run build                     # dev build of the daemon: ./dist/waggle
cd apps/macos && swift build && swift test     # app build and tests
bash scripts/bundle-app.sh                     # wraps the app in apps/macos/.build/Waggle.app
./scripts/build-local.sh                       # release-mode daemon and app in dist/, unsigned
```

A source build has no update feed, so it never asks to update itself. It cannot update a release install
either: run one or the other.

## Rules that protect your Mac

These rules exist because each one went wrong once.

- **Do not run `waggle install`** (or the old `knock install`), `launchctl load`, `launchctl bootstrap`,
  `launchctl kickstart`, or any login-item call outside a test with a fake `launchctl` on `PATH`. A temporary
  `HOME` does not isolate launchd: it registers a real background item.
- **Tests set `KNOCK_HOME` to a temporary folder.** A test never touches the real
  `~/Library/Application Support/Knock` or the real `~/.claude` settings.
- **No test calls a real service.** Tests use a fake Telegram, a fake Slack and a fake relay on localhost.
- **Never capture the whole screen.** To show a Waggle window, capture it by its window id
  (`screencapture -l <id>`). Do not commit screenshots or other binaries: attach them to the pull request.

## Rules for the code

- **Local only.** The daemon and the app make no network call except the opt-in ones in
  [SECURITY.md](SECURITY.md#network). A new host needs a discussion in an issue first.
- **Secrets go to the Keychain**, never to the database or a log.
- **The daemon is the only writer of `knock.db`.** The app and the shim use the socket.
- **`docs/protocol-mvp.md` is the contract** between the daemon, the shim and the app. If your change needs a
  different contract, update that file in the same pull request.
- **Agent content is untrusted.** Keep the HTML isolation and the safe-markdown rules in SECURITY.md.
- **UI copy:** plain, friendly words. No em-dashes.

## Names

The product is Waggle. Hidden ids keep the old name Knock on purpose, so updates stay in place: the bundle id
`dev.limone.knock`, the data folder `~/Library/Application Support/Knock`, `knock.db`, `knock.sock`, the
`KNOCK_*` environment variables, the Swift module and `apps/macos/Sources/Knock`. Please do not rename them.

Some code comments cite `docs/stories/...`, `MVP.md` or `docs/design/mvp-values.md`. Those are internal planning
notes from before the code was public, and they are not in this repository. The comment itself says what matters.

## Sign your commits

`main` accepts only signed commits, so GitHub refuses to merge a pull request with an unsigned commit. CI
checks this on each pull request. Set up signing once, with the SSH key you already use for GitHub:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

Then add the same public key on GitHub as a **Signing key** (Settings > SSH and GPG keys > New SSH key). A
GPG key works too: see [GitHub's guide](https://docs.github.com/en/authentication/managing-commit-signature-verification).

To sign commits you already pushed, sign them again and force-push the branch:

```bash
git rebase --exec 'git commit --amend --no-edit -S' origin/main
git push --force-with-lease
```

## Pull requests

- One change per pull request, with tests.
- Say what changed and how you checked it. For a UI change, add a window screenshot.
- Small, signed commits with clear messages (see [Sign your commits](#sign-your-commits)).
- CI runs the daemon and app tests, a secret scan and a commit signature check on each pull request.

## Forks

The code is yours to fork under Apache 2.0. The Waggle name and logo are not: see [TRADEMARK.md](TRADEMARK.md).

## Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
