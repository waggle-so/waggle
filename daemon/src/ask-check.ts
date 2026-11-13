import type { DecidedMatch } from "./decided-index";

// WAG-416: the check inside waggle_ask. A decision ask that fits past decisions of its project is held once: no case
// is created and the agent gets the matches. The same ask sent again always creates the case.

// How long a held ask waits for its second send. The hold lives in daemon memory; a restart forgets it, and the
// ask is then held one more time at most.
export const HOLD_WINDOW_MS = 15 * 60_000;

interface Hold {
  at: number;
  matches: DecidedMatch[];
  requestIds: Set<string>;
}

export type AskCheckResult =
  | { action: "hold"; matches: DecidedMatch[] }
  | { action: "pass"; matchedCaseIds: string[] };

export class AskCheck {
  private readonly holds = new Map<string, Hold>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(sessionId: string, title: string): string {
    return `${sessionId}\n${title.trim().toLowerCase().replace(/\s+/g, " ")}`;
  }

  private expire(): void {
    const limit = this.now() - HOLD_WINDOW_MS;
    for (const [key, hold] of this.holds) if (hold.at < limit) this.holds.delete(key);
  }

  // `search` runs only when the ask is eligible (the caller checked: a decision, no follows or replaces, no rule
  // decides it). A throw in it is caught here: the ask passes.
  run(opts: {
    sessionId: string;
    title: string;
    requestId?: string;
    search: () => DecidedMatch[];
    onHeld?: (matchCount: number) => void;
    onFailed?: () => void;
  }): AskCheckResult {
    this.expire();
    const key = this.key(opts.sessionId, opts.title);
    const prior = this.holds.get(key);
    if (prior) {
      // A retry of the first call (same request id) gets the same hold back. Any other send of this title passes.
      if (opts.requestId !== undefined && prior.requestIds.has(opts.requestId)) return { action: "hold", matches: prior.matches };
      this.holds.delete(key);
      return { action: "pass", matchedCaseIds: prior.matches.map((m) => m.case_id) };
    }
    let matches: DecidedMatch[];
    try {
      matches = opts.search();
    } catch {
      opts.onFailed?.();
      return { action: "pass", matchedCaseIds: [] };
    }
    if (matches.length === 0) return { action: "pass", matchedCaseIds: [] };
    // A better ask that names the old decision still fits it. Hold only for a match this session has not seen lately.
    const shown = this.shownTo(opts.sessionId);
    const fresh = matches.filter((m) => !shown.has(m.case_id));
    if (fresh.length === 0) return { action: "pass", matchedCaseIds: matches.map((m) => m.case_id) };
    this.holds.set(key, {
      at: this.now(),
      matches,
      requestIds: new Set(opts.requestId !== undefined ? [opts.requestId] : []),
    });
    this.remember(opts.sessionId, matches);
    opts.onHeld?.(matches.length);
    return { action: "hold", matches };
  }

  // Cases already shown to a session in the window, so a better ask is not held again for the same decision.
  private readonly shownBySession = new Map<string, { at: number; ids: Set<string> }>();
  private shownTo(sessionId: string): Set<string> {
    const entry = this.shownBySession.get(sessionId);
    if (!entry || entry.at < this.now() - HOLD_WINDOW_MS) return new Set();
    return entry.ids;
  }
  private remember(sessionId: string, matches: DecidedMatch[]): void {
    const ids = this.shownTo(sessionId);
    for (const m of matches) ids.add(m.case_id);
    this.shownBySession.set(sessionId, { at: this.now(), ids });
  }
}
