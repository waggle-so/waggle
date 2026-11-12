# Waggle: rules for coding agents in this repository

Waggle is a native macOS inbox where local coding agents (Claude Code, Codex) ask a human for decisions and
reviews. Humans: read [CONTRIBUTING.md](CONTRIBUTING.md). These rules are for agents, and they say the same
things in a form you can follow step by step.

## Read first

- `docs/protocol-mvp.md`: the contract between the daemon, the MCP shim and the app. Build to it. If your
  change needs a different contract, change that file in the same change and say so in your summary.
- `docs/SERVICE.md`: how the service runs. There is no LaunchAgent: `waggle daemon` starts on demand when
  `waggle mcp` or the app finds the socket unreachable, and stops after `KNOCK_IDLE_EXIT_MIN` idle minutes.
- `docs/decisions/`: product decisions and why. Do not reopen a decision without a new reason.
- `SECURITY.md`: the trust model and the only allowed network calls.

## Layout

```text
daemon/          TypeScript on Bun. One binary `waggle` with subcommands (daemon, mcp, install, doctor,
                 test-ask, uninstall, report). Owns SQLite (bun:sqlite) and the unix socket.
  src/protocol/  Zod schemas for every RPC and MCP payload. The single source of truth.
apps/macos/      Swift 6 + SwiftUI app, built with SwiftPM (Package.swift), macOS 14+.
relay/           The optional sharing relay (Cloudflare Worker). Sharing is hidden in the app for now.
plugins/         The Claude Code and Codex plugins.
site/            waggle.so (static pages).
docs/            protocol, service, decisions, release notes.
```

## Commands

Run these from the repository root.

```bash
cd daemon && bun install && bun test          # daemon unit and integration tests
cd daemon && bun run build                     # compiles ./dist/waggle
cd apps/macos && swift build && swift test     # app build and tests
cd relay && npm ci && npm test                 # relay tests
bash scripts/bundle-app.sh                     # wraps the app in apps/macos/.build/Waggle.app
```

## Rules

- NEVER register anything with the real user session. Do not run `waggle install` (or the old
  `knock install`), `launchctl load`, `launchctl bootstrap`, `launchctl kickstart`, or any
  SMAppService or login-item call outside a test with a fake `launchctl` on `PATH`. A temporary `HOME`
  does NOT isolate launchd: it registers a real background item on the user's Mac.
- Tests set `KNOCK_HOME` to a temporary folder. Never touch the real `~/Library/Application Support/Knock`
  or the real `~/.claude` settings in a test.
- No test calls a real service. Tests use a fake Telegram Bot API, a fake Slack and a fake relay on
  localhost. The env overrides for these fakes work in a dev build only, never in a release daemon.
- The daemon is the only writer of `knock.db`. The app and the shim talk to it over the socket only.
- Local only. The daemon and the app make no network call except the opt-in ones listed in
  `SECURITY.md` (Network). A new host needs an issue and a maintainer's yes first.
- Secrets (connector tokens, the relay device token, each shared case's owner key) live in the macOS
  Keychain, never in `knock.db` or a log.
- Agent content is untrusted. HTML bundles follow the isolation rules in `docs/protocol-mvp.md`. Text from
  agents renders as safe markdown only: bold, italics, inline code, lists, paragraphs, pipe tables
  (docs/decisions/2026-11-11-tables-in-agent-text.md). No links, no images,
  no HTML.
- Never capture the whole screen (`screencapture` without `-l <window id>`). It records the user's other
  apps. Capture one Waggle window by its CoreGraphics window id, or do not capture.
- Never commit screenshots, recordings or other binaries.
- Copy in the UI: plain, friendly words. No em-dashes.
- Tests that wait for something poll with a deadline. Do not assert after a fixed sleep: the full suites
  run in parallel and a loaded runner is slow.
- Small commits with clear messages. Do not push or merge unless the human asks.
- Every commit is signed: `main` refuses unsigned ones. Do not pass `--no-gpg-sign` or `-c commit.gpgsign=false`.
  If `git config commit.gpgsign` is not `true`, tell the human before you commit and point to
  CONTRIBUTING.md (Sign your commits). Do not set up a key for them.

## Names

The product is Waggle. Hidden ids keep the old name Knock on purpose, so updates stay in place: the bundle
id `dev.limone.knock` (and `.dev`), the data folder `~/Library/Application Support/Knock`, `knock.db`,
`knock.sock`, the `KNOCK_*` env vars, the Swift module and the `apps/macos/Sources/Knock` folder. Do not
rename them. The old `knock_*` MCP tool names, the `knock` command and the `knock@knock` plugin stay as
aliases behind `LEGACY_KNOCK_ALIASES` (`daemon/src/protocol/legacy-aliases.ts`) until a later release
removes them in one change.
