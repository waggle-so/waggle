#!/usr/bin/env bun
// HAIL-34 evidence harness: drives the daemon's own RPC surface (the same
// `DaemonClient` the shim and `waggle test-ask` use) to put cases into the
// queued/delivered/failed states the app's evidence screenshots need,
// without clicking anything - there is no accessibility permission for UI
// scripting in this environment (docs/stories/HAIL-34.md fold, gap 3).
//
// Run against ONE already-started daemon and ONE `KNOCK_HOME`, set the same
// way for every command below (docs/stories/HAIL-34.md fold: "One daemon,
// one KNOCK_HOME, started once; the app and every CLI call get the SAME
// KNOCK_HOME in the same shell script").
//
//   KNOCK_HOME=/tmp/knock-evNN bun daemon/scripts/evidence-harness.ts setup
//
// Prints case/reply ids as `CASE_QUEUED=...`, `CASE_DELIVERED=...`,
// `CASE_FAILED=...`, `CASE_COMMENTED=...`/`REPLY_COMMENTED=...`,
// `CASE_PENDING_1=...`, `CASE_PENDING_2=...` (shell-sourceable). Re-run with
// `replace <case id>` to exercise `reply.replace` on an already-queued case
// (the "Change answer" path), or `fail <case id>` to fail an already-queued
// case on its own, after `setup` already used it for something else.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { deflateSync } from "node:zlib";
import { stageBundle, stageDiagram, stageMarkdown, stageScreenshot, stageScreenshots } from "../src/artifacts/stage";
import { daemonPaths } from "../src/config";
import { DaemonClient } from "../src/mcp/client";
import { TEST_FIXTURE } from "../src/cli/test-ask-fixture";
import type { Artifact } from "../src/protocol";

const CASE_FIXTURE = {
  kind: "review" as const,
  title: "Pricing card: compact or detailed?",
  need: "Pick the pricing card layout to ship: A compact or B detailed.",
  why: "Both meet the spec. A optimizes for speed on repeat purchases, B explains the membership tiers.",
  recommendation: "a",
  recommendation_why:
    "Compact ships faster and reads cleaner on repeat visits; detailed gives new visitors room to compare.",
  options: [
    { id: "a", label: "A · Compact" },
    { id: "b", label: "B · Detailed" },
  ],
};

// The operator's 0.1.27 report (HAIL-70): an agent update that showed raw markdown.
const MARKDOWN_UPDATE = [
  "Right: they overlap, and showing both is confusing. The only difference is who they're for.",
  "- **\"Wrong email? Start again\"** is for someone signing up right now who mistyped their address. It takes them back to Create account with their details kept, so they can fix the email.",
  "- **\"Sign out\"** is for an existing member. Their email can't be edited, so \"Start again\" makes no sense for them. The code review also found that it's buggy for them: it opens Create account while they're still signed in.",
  "",
  "Fix: show exactly one link, never both.",
  "- A new sign-up sees \"Wrong email? Start again\", as in your design.",
  "- An existing member sent here by the check sees \"Sign out\".",
  "",
  "This also fixes that code-review finding. Approve and I'll apply it, with the other review fixes, before merging.",
].join("\n");

// A plain question ask with no artifact (HAIL-33): the origin of the detail-
// request flow, for the "ask with the field open" and "waiting" evidence
// (the case pane, no review workspace needed for either). Distinct title/
// need from CASE_FIXTURE so the evidence screenshots (and the queue) show
// which is which.
const DETAIL_QUESTION_FIXTURE = {
  kind: "question" as const,
  title: "Ship the settings page redesign this sprint?",
  need: "Decide if the settings redesign ships this sprint or slips to next.",
  why: "Trade-off between shipping speed and a cleaner layout, not a pure technical call.",
  recommendation: "yes",
  recommendation_why: "Support tickets say the current layout is confusing.",
};

// A review ask (HAIL-33): the origin case for the markdown/chart evidence.
// `KNOCK_OPEN_REVIEW` only opens the split review workspace for a
// review-kind case (`AppModel.activateSelection`), so the "returned round"
// screenshots - which must show the full `ArtifactViewerView`/`MarkdownView`
// rendering, not just the case pane's small preview card - need this kind,
// with an initial artifact (a review ask requires one at creation).
const DETAIL_REVIEW_FIXTURE = {
  kind: "review" as const,
  title: "Settings page redesign: ship or slip?",
  need: "Review the redesign and decide if it ships this sprint or slips to next.",
  why: "Trade-off between shipping speed and a cleaner layout, not a pure technical call.",
  recommendation: "a",
  recommendation_why: "Support tickets say the current layout is confusing.",
  options: [
    { id: "a", label: "Ship this sprint" },
    { id: "b", label: "Slip to next sprint" },
  ],
};

// A simple HTML "chart" bundle (HAIL-33): stands in for the agent's second
// detail-request round, the AC's "html_bundle for a prototype or a chart".
const CHART_FIXTURE = {
  "index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Support tickets</title><link rel="stylesheet" href="style.css" /></head>
  <body>
    <h1>Settings page: confused-user tickets per week</h1>
    <div class="bars">
      <div class="bar" style="height: 40%"><span>W1</span></div>
      <div class="bar" style="height: 55%"><span>W2</span></div>
      <div class="bar" style="height: 70%"><span>W3</span></div>
      <div class="bar" style="height: 30%"><span>W4</span></div>
    </div>
  </body>
</html>`,
  "style.css": `body { font-family: sans-serif; padding: 24px; }
.bars { display: flex; align-items: flex-end; gap: 12px; height: 200px; }
.bar { flex: 1; background: #3b5bdb; position: relative; }
.bar span { position: absolute; bottom: -20px; left: 0; right: 0; text-align: center; }`,
};

// HAIL-35 evidence: a review case whose prototype is at least 3 screens tall,
// for the full-page-capture-and-scroll evidence (#1 "Comment mode scrolled
// down, with a pin placed low on the page") and the multi-capture evidence
// (#2/#3, via `KNOCK_EVIDENCE_MULTI_CAPTURE`).
const TALL_PROTOTYPE_FIXTURE = {
  kind: "review" as const,
  title: "Onboarding walkthrough: keep the long scroll or cut it?",
  need: "Decide whether the onboarding walkthrough keeps its full-length scroll or gets split into steps.",
  why: "Both meet the spec. The long scroll shows everything at once; splitting it needs new step navigation.",
  recommendation: "keep",
  recommendation_why: "The long scroll ships today; splitting it into steps is a bigger change for later.",
  options: [
    { id: "keep", label: "Keep the long scroll" },
    { id: "split", label: "Split into steps" },
  ],
};

const TALL_PROTOTYPE_BUNDLE: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Onboarding walkthrough</title><link rel="stylesheet" href="style.css" /></head>
  <body>
    <section class="screen screen-1"><h1>Screen 1 · Welcome</h1><p>Start of the walkthrough.</p></section>
    <section class="screen screen-2"><h1>Screen 2 · Connect your project</h1><p>Middle of the walkthrough.</p></section>
    <section class="screen screen-3"><h1>Screen 3 · You're set up</h1><p>End of the walkthrough.</p>
      <button type="button" class="cta">Finish setup</button>
    </section>
  </body>
</html>`,
  "style.css": `body { margin: 0; font-family: sans-serif; }
.screen { height: 900px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.screen-1 { background: #e7ecfd; }
.screen-2 { background: #fceec4; }
.screen-3 { background: #e7f5ec; }
.cta { margin-top: 16px; padding: 12px 24px; font-size: 14px; font-weight: 600; border-radius: 8px; border: none; background: #e4572e; color: white; }`,
};

// HAIL-49: three review cases that each exercise one branch of the case
// pane's html_bundle preview rule (`ArtifactPreviewPlan.choose`) - no
// preview/viewport (Waggle's own fallback), an agent `preview.html`, and an
// agent phone viewport.

const PREVIEW_NONE_FIXTURE = {
  kind: "review" as const,
  title: "Dark landing page: ship this hero?",
  need: "Approve the new dark hero section before it ships.",
  why: "A visual call on contrast and copy placement, not a technical one.",
  recommendation: "a",
  recommendation_why: "It matches the rest of the site's dark theme.",
  options: [
    { id: "a", label: "Ship as is" },
    { id: "b", label: "Needs another pass" },
  ],
};

// No preview, no viewport: wide and tall on purpose, so the "fills the card,
// no side bands" fallback is obvious against the old letterboxed look. The
// headline sits near the TOP of the page (amendment A1: the card shows the
// page top-aligned, not centered) - a filler block below it is what makes
// the page taller than the card, so the truncation fade shows too.
const DARK_WIDE_PAGE: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Hero</title></head>
  <body style="margin:0;background:#0b0b10;color:#fff;font-family:-apple-system,sans-serif;">
    <div style="padding:40px 48px;box-sizing:border-box;">
      <h1 style="font-size:40px;margin:0 0 16px;">Ship faster with Waggle</h1>
      <p style="font-size:16px;color:#9a9aa2;margin:0;max-width:520px;">
        A calmer way to keep async agents moving without babysitting a terminal.
      </p>
    </div>
    <div style="height:1400px;"></div>
  </body>
</html>`,
};

const PREVIEW_HTML_FIXTURE = {
  kind: "review" as const,
  title: "Checkout layout: compact or detailed?",
  need: "Pick the checkout layout to ship: compact or detailed.",
  why: "Both meet the spec; a product call on how much detail to show up front.",
  recommendation: "a",
  recommendation_why: "Fewer fields on screen reads faster for repeat buyers.",
  options: [
    { id: "a", label: "Compact" },
    { id: "b", label: "Detailed" },
  ],
};

// A real page (`index.html`, what the review workspace opens to) plus a
// purpose-built `preview.html` card - the guide's own responsive template
// (daemon/src/guide/artifacts.md "Give your html_bundle a preview"; sizing
// amended HAIL-49 A1: fills any card width from 500 to 1100px at a fixed
// 280px height, not a fixed 1200x630 that would letterbox at the card's own
// live width).
const PREVIEW_HTML_BUNDLE: Record<string, string> = {
  "index.html": `<!doctype html><html><body><h1>Checkout page (the full prototype)</h1></body></html>`,
  "preview.html": `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 280px; overflow: hidden; }
  body {
    font: 14px/1.5 -apple-system, sans-serif; color: #1a1a1a;
    display: flex; flex-direction: column; justify-content: center;
    padding: 24px; box-sizing: border-box; background: #fafafa;
  }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .options { display: flex; gap: 16px; }
  .option { flex: 1; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 14px; }
  .option.recommended { border-color: #2f6fed; }
  .option h2 { font-size: 15px; margin: 0 0 6px; }
  .option p { margin: 0; color: #555; font-size: 14px; }
</style>
</head>
<body>
  <h1>Checkout layout: compact or detailed?</h1>
  <div class="options">
    <div class="option recommended">
      <h2>Compact (recommended)</h2>
      <p>Fewer fields on screen; two extra taps for shipping.</p>
    </div>
    <div class="option">
      <h2>Detailed</h2>
      <p>Everything on one screen; a longer scroll.</p>
    </div>
  </div>
</body>
</html>`,
};

const PREVIEW_PHONE_FIXTURE = {
  kind: "review" as const,
  title: "Onboarding screen: this layout on phone?",
  need: "Approve the onboarding screen's phone layout.",
  why: "A visual call on spacing at the phone size, not a technical one.",
  recommendation: "a",
  recommendation_why: "It matches the design file's phone frame.",
  options: [
    { id: "a", label: "Ship as is" },
    { id: "b", label: "Needs another pass" },
  ],
};

// The agent declares a 390x844 viewport (a phone) alongside this - the card
// should show it centred in a phone-shaped frame, not stretched.
const PHONE_PAGE: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Onboarding</title></head>
  <body style="margin:0;background:#1c1c1e;color:#fff;font-family:-apple-system,sans-serif;">
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:844px;gap:16px;">
      <h1 style="font-size:24px;margin:0;">Welcome</h1>
      <p style="margin:0;">Onboarding step 1 of 3</p>
    </div>
  </body>
</html>`,
};

// Stages an html_bundle with an optional viewport/preview and creates a
// review case with it - the same shape `connectedSession` uses for a plain
// bundle, plus the two HAIL-49 fields.
async function connectedBundleSession(
  pid: number,
  fixture: Record<string, unknown>,
  bundleFiles: Record<string, string>,
  extra: { viewport?: { width: number; height: number }; preview?: string } = {},
): Promise<{ client: DaemonClient; caseId: string; cwd: string }> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "Waggle");
  const proto = join(cwd, "proto");
  mkdirSync(proto, { recursive: true });
  for (const [name, contents] of Object.entries(bundleFiles)) {
    writeFileSync(join(proto, name), contents);
  }
  const staged = stageBundle({
    dir: "proto",
    entry: "index.html",
    cwd,
    incomingDir: join(daemonPaths().home, "incoming"),
    viewport: extra.viewport,
    preview: extra.preview,
  });
  const artifact: Artifact = {
    type: "html_bundle",
    dir: staged.path,
    entry: staged.entry,
    ...(staged.viewport !== undefined ? { viewport: staged.viewport } : {}),
    ...(staged.preview !== undefined ? { preview: staged.preview } : {}),
  };
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: pid },
    5000,
  );
  const created = (await client.call("case.create", { ...fixture, artifact }, 15000)) as { id: string };
  return { client, caseId: created.id, cwd };
}

async function previews(): Promise<void> {
  const none = await connectedBundleSession(process.pid, PREVIEW_NONE_FIXTURE, DARK_WIDE_PAGE);
  console.log(`CASE_PREVIEW_NONE=${none.caseId}`);

  const html = await connectedBundleSession(
    process.pid, PREVIEW_HTML_FIXTURE, PREVIEW_HTML_BUNDLE, { preview: "preview.html" },
  );
  console.log(`CASE_PREVIEW_HTML=${html.caseId}`);

  const phone = await connectedBundleSession(
    process.pid, PREVIEW_PHONE_FIXTURE, PHONE_PAGE, { viewport: { width: 390, height: 844 } },
  );
  console.log(`CASE_PREVIEW_PHONE=${phone.caseId}`);

  none.client.close();
  html.client.close();
  phone.client.close();
}

// HAIL-40: a review case with a 3-image `screenshots` artifact, for the
// review workspace's thumbnail strip, per-screen Comment mode, and
// review-before-send evidence.
const SCREENSHOTS_FIXTURE = {
  kind: "review" as const,
  title: "Onboarding flow: ready to ship?",
  need: "Review the 3-screen onboarding flow and decide if it ships this sprint.",
  why: "Both meet the spec. It needs a human eye on the copy and pacing across all 3 screens.",
  recommendation: "ship",
  recommendation_why: "Every screen reads cleanly and the flow is short.",
  options: [
    { id: "ship", label: "Ship this sprint" },
    { id: "hold", label: "Hold for more testing" },
  ],
};

const SCREENSHOTS_ITEMS: { name: string; caption: string; rgb: [number, number, number] }[] = [
  { name: "1-home.png", caption: "Home", rgb: [0xe7, 0xec, 0xfd] },
  { name: "2-verify.png", caption: "Verify email", rgb: [0xfc, 0xee, 0xc4] },
  { name: "3-welcome.png", caption: "You're set up", rgb: [0xe7, 0xf5, 0xec] },
];

// A minimal, dependency-free PNG encoder (8-bit RGB, one solid color, no
// interlace) - just enough for AppKit's `NSImage(contentsOfFile:)` to decode
// it, so the evidence thumbnails are visually distinct colors rather than
// identical blanks. Not exported: script-local, evidence only.
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function solidColorPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // per-row filter type: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
    }
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// HAIL-73: a PNG with landmarks (a border, a header band, a footer band and
// one stripe per tenth of the height) so a crop, or a whole-image fit, shows.
function landmarkPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      let c: [number, number, number] = rgb;
      const border = x < 6 || y < 6 || x >= width - 6 || y >= height - 6;
      const header = y < height * 0.08;
      const footer = y > height * 0.94;
      const stripe = Math.floor((y / height) * 20) % 2 === 1 && x > width * 0.1 && x < width * 0.9;
      if (border || header || footer) c = [0x1c, 0x1c, 0x24];
      else if (stripe) c = [Math.max(0, rgb[0] - 40), Math.max(0, rgb[1] - 40), Math.max(0, rgb[2] - 40)];
      raw[px] = c[0];
      raw[px + 1] = c[1];
      raw[px + 2] = c[2];
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PHONE_SET_ITEMS: { name: string; caption: string; rgb: [number, number, number] }[] = [
  { name: "1-before.png", caption: "Before", rgb: [0xe7, 0xec, 0xfd] },
  { name: "2-a.png", caption: "A · More room for the trend", rgb: [0xfc, 0xee, 0xc4] },
  { name: "3-b.png", caption: "B · Cards instead of a table", rgb: [0xe7, 0xf5, 0xec] },
  { name: "4-hrv.png", caption: "HRV detail", rgb: [0xf8, 0xe1, 0xe7] },
];


// WAG-413: a small page-like PNG made of filled rectangles, so two revisions differ in a few clear places.
function boxesPng(width: number, height: number, rects: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c: [number, number, number] = [0xfa, 0xfa, 0xfa];
      for (const r of rects) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) c = r.rgb;
      const px = y * (stride + 1) + 1 + x * 3;
      raw[px] = c[0];
      raw[px + 1] = c[1];
      raw[px + 2] = c[2];
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

// WAG-413 evidence: a pricing page in two revisions. Revision 2 turns the button honey, moves the badge and
// adds a banner. `arg` is screenshot (default) | screenshots | first (one revision only: Compare is disabled).
async function compareDemo(kind: string): Promise<void> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "Waggle");
  mkdirSync(join(cwd, "shots"), { recursive: true });
  const incomingDir = join(daemonPaths().home, "incoming");
  const ink: [number, number, number] = [0x16, 0x18, 0x1a];
  const white: [number, number, number] = [0xff, 0xff, 0xff];
  const line: [number, number, number] = [0xe6, 0xe6, 0xe6];
  const page = (v2: boolean) => [
    { x: 0, y: 0, w: 800, h: 56, rgb: ink },
    ...(v2 ? [{ x: 0, y: 56, w: 800, h: 40, rgb: [0xfd, 0xf4, 0xda] as [number, number, number] }] : []),
    { x: 60, y: 130, w: 320, h: 340, rgb: white },
    { x: 60, y: 130, w: 320, h: 2, rgb: line },
    { x: 100, y: 180, w: 180, h: 18, rgb: ink },
    { x: 100, y: 220, w: 240, h: 10, rgb: [0xb0, 0xb0, 0xb0] as [number, number, number] },
    { x: 100, y: 244, w: 200, h: 10, rgb: [0xb0, 0xb0, 0xb0] as [number, number, number] },
    { x: 100, y: 400, w: 140, h: 44, rgb: v2 ? ([0xf2, 0xb0, 0x1e] as [number, number, number]) : ink },
    { x: 420, y: 130, w: 320, h: 340, rgb: white },
    { x: 460, y: 180, w: 160, h: 18, rgb: ink },
    { x: 460, y: 220, w: 220, h: 10, rgb: [0xb0, 0xb0, 0xb0] as [number, number, number] },
    { x: v2 ? 640 : 460, y: v2 ? 150 : 300, w: 80, h: 28, rgb: [0xe0, 0x35, 0x2b] as [number, number, number] },
    { x: 460, y: 400, w: 140, h: 44, rgb: ink },
  ];
  const setNames = ["home.png", "pricing.png"];
  const write = (v2: boolean): Artifact => {
    if (kind === "screenshots") {
      setNames.forEach((name, i) => writeFileSync(join(cwd, "shots", name), boxesPng(800, 520, i === 0 ? page(v2) : page(false))));
      const staged = stageScreenshots({
        items: setNames.map((name, i) => ({ path: join("shots", name), caption: i === 0 ? "Pricing" : "Home" })),
        cwd,
        incomingDir,
      });
      return { type: "screenshots", items: staged.items };
    }
    writeFileSync(join(cwd, "shots", "pricing.png"), boxesPng(800, 520, page(v2)));
    const one = stageScreenshot({ path: join("shots", "pricing.png"), cwd, incomingDir });
    return { type: "screenshot", path: one.path };
  };
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: process.pid },
    5000,
  );
  const created = (await client.call(
    "case.create",
    { ...SCREENSHOTS_FIXTURE, title: "Is the new pricing button clear?", artifact: write(false) },
    15000,
  )) as { id: string };
  if (kind !== "first") {
    await client.call("case.update", { case_id: created.id, message: "Made the button honey and added a banner.", artifact: write(true) }, 15000);
  }
  console.log(`CASE_COMPARE=${created.id}`);
  console.log("COMPARE_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
}

// HAIL-73: a 4-screen phone set (390x844) and one 1440x900 desktop screenshot.
async function shotSet(): Promise<void> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "Waggle");
  const shotsDir = join(cwd, "shots");
  mkdirSync(shotsDir, { recursive: true });
  for (const item of PHONE_SET_ITEMS) writeFileSync(join(shotsDir, item.name), landmarkPng(390, 844, item.rgb));
  writeFileSync(join(shotsDir, "desktop.png"), landmarkPng(1440, 900, [0xe7, 0xec, 0xfd]));
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: process.pid },
    5000,
  );
  const staged = stageScreenshots({
    items: PHONE_SET_ITEMS.map((item) => ({ path: join("shots", item.name), caption: item.caption })),
    cwd,
    incomingDir: join(daemonPaths().home, "incoming"),
  });
  const phone = (await client.call(
    "case.create",
    { ...SCREENSHOTS_FIXTURE, title: "Which trend layout: A or B?", artifact: { type: "screenshots", items: staged.items } },
    15000,
  )) as { id: string };
  console.log(`CASE_PHONE_SET=${phone.id}`);
  const one = stageScreenshot({ path: join("shots", "desktop.png"), cwd, incomingDir: join(daemonPaths().home, "incoming") });
  const desktop = (await client.call(
    "case.create",
    { ...SCREENSHOTS_FIXTURE, title: "Dashboard on desktop: ready?", artifact: { type: "screenshot", path: one.path } },
    15000,
  )) as { id: string };
  console.log(`CASE_DESKTOP=${desktop.id}`);
  console.log("SHOTSET_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
}

// Decision record 2026-11-12: one decision whose variants have several screens (A1 A2 B C1 C2 C3), plus a
// shared legend, for the compact screen row.
const VARIANT_SET_ITEMS: { name: string; caption: string; rgb: [number, number, number] }[] = [
  { name: "a1.png", caption: "A · Row in the review panel", rgb: [0xfc, 0xee, 0xc4] },
  { name: "a2.png", caption: "A · After the click: closing confirmed", rgb: [0xf9, 0xe2, 0xa8] },
  { name: "b.png", caption: "B · Notice at the top of the procedure", rgb: [0xe7, 0xf5, 0xec] },
  { name: "c1.png", caption: "C · List of procedures", rgb: [0xe7, 0xec, 0xfd] },
  { name: "c2.png", caption: "C · Summary after the sync, with the notice on top", rgb: [0xd8, 0xe0, 0xfb] },
  { name: "c3.png", caption: "C · Procedure detail", rgb: [0xc9, 0xd4, 0xf8] },
  { name: "legend.png", caption: "Colour legend", rgb: [0xf3, 0xf3, 0xf3] },
];

async function variantSet(): Promise<void> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "Waggle");
  const shotsDir = join(cwd, "shots");
  mkdirSync(shotsDir, { recursive: true });
  for (const item of VARIANT_SET_ITEMS) writeFileSync(join(shotsDir, item.name), landmarkPng(1440, 900, item.rgb));
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: process.pid },
    5000,
  );
  const staged = stageScreenshots({
    items: VARIANT_SET_ITEMS.map((item) => ({ path: join("shots", item.name), caption: item.caption })),
    cwd,
    incomingDir: join(daemonPaths().home, "incoming"),
  });
  const created = (await client.call(
    "case.create",
    {
      ...SCREENSHOTS_FIXTURE,
      title: "How do we flag a procedure closed by mistake?",
      options: [
        { id: "a", title: "Row in the panel", label: "A row in the review panel." },
        { id: "b", title: "Notice on top", label: "A notice at the top of the procedure." },
        { id: "c", title: "Summary after the sync", label: "A summary after the sync." },
      ],
      recommendation: "a",
      artifact: { type: "screenshots", items: staged.items },
    },
    15000,
  )) as { id: string };
  console.log(`CASE_VARIANT_SET=${created.id}`);
  console.log("VARIANTSET_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
}

// --- HAIL-55: the "preview never spins forever" repro bundles ---
//
// The operator's report (29 Sep, Waggle 0.1.21): an omea-group review ask
// showed only a spinner, both in the case pane's still card and in the
// review window's stage, for a bundle the agent said was "rendered from the
// design's HTML export in Chrome" - many large PNG images. These three
// bundles are the contract's own repro list: (a) 20+ PNGs of 2-4 MB each in
// one long page, (b) a page referencing an external stylesheet/font/image
// URL (blocked by HTMLIsolation's content rule list), (c) a bundle near the
// 50 MB staging limit (MAX_BUNDLE_BYTES in daemon/src/artifacts/stage.ts).

function noisyPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = Math.floor(Math.random() * 256);
      raw[px + 1] = Math.floor(Math.random() * 256);
      raw[px + 2] = Math.floor(Math.random() * 256);
    }
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // level 1 (fastest): random pixel data does not compress regardless of
  // level, so there is no size cost to asking for speed here.
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Real, decodable PNGs (not just padded bytes) so a fix that actually decodes
// and paints every image is exercised the same way the operator's Chrome
// export was - `noisyPng`'s random pixels defeat PNG's own compression the
// same way a dense screenshot does, so file size tracks pixel count closely.
function manyLargeImagesBundleFiles(count: number, width: number, height: number): Record<string, string | Buffer> {
  const files: Record<string, string | Buffer> = {};
  let imgTags = "";
  for (let i = 0; i < count; i++) {
    const name = `shot-${i}.png`;
    files[name] = noisyPng(width, height);
    imgTags += `<img src="${name}" style="display:block;width:100%">\n`;
  }
  files["index.html"] =
    `<!doctype html><html><head><meta charset="utf-8"><title>Design export</title></head>` +
    `<body style="margin:0">${imgTags}</body></html>`;
  return files;
}

const BLOCKED_EXTERNAL_URL_BUNDLE_FILES: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Sign-in screens</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" />
<style>@font-face { font-family: 'Ext'; src: url(https://example.com/font.woff2); }</style>
</head>
<body style="margin:0;font-family:-apple-system,sans-serif;padding:24px;">
<h1>Sign-in screens</h1>
<img src="https://example.com/hero.jpg" alt="hero">
<p style="font-family:Ext">Rendered from the design's HTML export in Chrome.</p>
<script>fetch('https://example.com/data.json').then((r) => r.json()).catch(() => {});</script>
</body>
</html>`,
};

// A page whose own script never yields - root cause confirmed live
// (apps/macos/Tests/KnockTests/ArtifactPreviewLoaderTests.swift
// fallsBackToTimedOutWhenTheRenderNeverFinishesInTime): neither
// evaluateJavaScript nor takeSnapshot has a timeout of its own, so this is
// what the fix's ~10s bound has to catch. Stands in for a real design
// export's inline script (a web-font loader, a hydration boilerplate) that
// stalls once its own network calls are blocked by HTMLIsolation.
const BUSY_SCRIPT_BUNDLE_FILES: Record<string, string> = {
  "index.html": `<!doctype html>
<html><body style="margin:0">
<h1>Sign-in screens</h1>
<script>
var start = Date.now();
while (Date.now() - start < 30000) { /* spin, blocking the page's script thread */ }
</script>
</body></html>`,
};

const HAIL55_REVIEW_FIXTURE = {
  kind: "review" as const,
  title: "Review the new sign-in screens and the fixed onboarding frames",
  need: "Approve the new sign-in screens and the fixed onboarding frames before they ship.",
  why: "A visual call on layout and copy, not a technical one.",
  recommendation: "a",
  recommendation_why: "Matches the design file's latest pass.",
  options: [
    { id: "a", label: "Ship as is" },
    { id: "b", label: "Needs another pass" },
  ],
};

async function connectedBundleSessionWithBinaryFiles(
  pid: number,
  fixture: Record<string, unknown>,
  bundleFiles: Record<string, string | Buffer>,
): Promise<{ client: DaemonClient; caseId: string; cwd: string }> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "Waggle");
  const proto = join(cwd, "proto");
  mkdirSync(proto, { recursive: true });
  for (const [name, contents] of Object.entries(bundleFiles)) {
    writeFileSync(join(proto, name), contents);
  }
  const staged = stageBundle({
    dir: "proto",
    entry: "index.html",
    cwd,
    incomingDir: join(daemonPaths().home, "incoming"),
  });
  const artifact: Artifact = { type: "html_bundle", dir: staged.path, entry: staged.entry };
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: pid },
    5000,
  );
  const created = (await client.call("case.create", { ...fixture, artifact }, 15000)) as { id: string };
  return { client, caseId: created.id, cwd };
}

// `bigBundles`: creates the three HAIL-55 repro cases and prints their ids.
// Run against an already-started daemon, the same way `previews`/`setup` do.
async function bigBundles(): Promise<void> {
  const t0 = Date.now();
  // (a) 20 PNGs at ~2.7 MB each (1200x800 RGB noise) in one long page - ~54 MB
  // raw pixel data would land just over the 50 MB cap, so this uses 17 images
  // (~46 MB) to stay a comfortably-large bundle without tripping the cap -
  // scenario (c) below is the near-the-cap case on purpose.
  const a = await connectedBundleSessionWithBinaryFiles(
    process.pid, HAIL55_REVIEW_FIXTURE, manyLargeImagesBundleFiles(17, 1200, 800),
  );
  console.log(`CASE_BIG_A=${a.caseId}`);
  console.log(`# scenario a staged in ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const b = await connectedBundleSessionWithBinaryFiles(
    process.pid, HAIL55_REVIEW_FIXTURE, BLOCKED_EXTERNAL_URL_BUNDLE_FILES,
  );
  console.log(`CASE_BIG_B=${b.caseId}`);
  console.log(`# scenario b staged in ${Date.now() - t1}ms`);

  const t2 = Date.now();
  // (c) near the 50 MB staging limit: 18 images at ~2.7 MB = ~48.6 MB.
  const c = await connectedBundleSessionWithBinaryFiles(
    process.pid, HAIL55_REVIEW_FIXTURE, manyLargeImagesBundleFiles(18, 1200, 800),
  );
  console.log(`CASE_BIG_C=${c.caseId}`);
  console.log(`# scenario c staged in ${Date.now() - t2}ms`);

  a.client.close();
  b.client.close();
  c.client.close();
}

// `timeoutFallback`: the case that actually trips the ~10s render timeout
// (a page whose script never yields), for the fallback-state evidence.
async function timeoutFallback(): Promise<void> {
  const d = await connectedBundleSessionWithBinaryFiles(process.pid, HAIL55_REVIEW_FIXTURE, BUSY_SCRIPT_BUNDLE_FILES);
  console.log(`CASE_BIG_D=${d.caseId}`);
  d.client.close();
}

// Stages and attaches a `screenshots` artifact at case creation: 3 solid-
// color images with captions, staged the way the shim would (HAIL-40).
async function connectedScreenshotsSession(pid: number): Promise<{ client: DaemonClient; caseId: string }> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "Waggle");
  const shotsDir = join(cwd, "shots");
  mkdirSync(shotsDir, { recursive: true });
  for (const item of SCREENSHOTS_ITEMS) {
    writeFileSync(join(shotsDir, item.name), solidColorPng(400, 280, item.rgb));
  }
  const staged = stageScreenshots({
    items: SCREENSHOTS_ITEMS.map((item) => ({ path: join("shots", item.name), caption: item.caption })),
    cwd,
    incomingDir: join(daemonPaths().home, "incoming"),
  });
  const artifact: Artifact = { type: "screenshots", items: staged.items };
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: pid },
    5000,
  );
  const created = (await client.call("case.create", { ...SCREENSHOTS_FIXTURE, artifact }, 15000)) as {
    id: string;
  };
  return { client, caseId: created.id };
}

async function connectedSession(
  pid: number,
  fixture: Record<string, unknown> = CASE_FIXTURE,
  bundleFiles: Record<string, string> = TEST_FIXTURE,
  opts: { attachArtifact?: boolean } = {},
): Promise<{ client: DaemonClient; caseId: string; cwd: string }> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "Waggle");
  mkdirSync(cwd, { recursive: true });
  let artifact: Artifact | undefined;
  if (fixture.kind === "review" || opts.attachArtifact) {
    const proto = join(cwd, "proto");
    mkdirSync(proto, { recursive: true });
    for (const [name, contents] of Object.entries(bundleFiles)) {
      writeFileSync(join(proto, name), contents);
    }
    const staged = stageBundle({
      dir: "proto",
      entry: "index.html",
      cwd,
      incomingDir: join(daemonPaths().home, "incoming"),
    });
    artifact = { type: "html_bundle", dir: staged.path, entry: staged.entry };
  }
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: pid },
    5000,
  );
  const created = (await client.call(
    "case.create",
    { ...fixture, ...(artifact ? { artifact } : {}) },
    15000,
  )) as { id: string };
  return { client, caseId: created.id, cwd };
}

// Stages and attaches a markdown revision through case.update (waggle_update),
// on the session's own connection - case.update is a session method (HAIL-33:
// the agent answers a detail request this way).
// A question ask that carries an HTML plan artifact at creation (docs/
// stories/HAIL-36.md amendment 3 evidence: "a question ask with an HTML plan
// open in the review workspace"). Before the fix, `ArtifactPreviewCard`'s tap
// did nothing for a question-kind case - `AppModel.canOpenReview` now lets
// any ask with an artifact open the workspace, not only review-kind asks.
const QUESTION_WITH_ARTIFACT_FIXTURE = {
  kind: "question" as const,
  title: "Ship the new onboarding flow?",
  need: "Decide whether to ship the redesigned onboarding flow this sprint.",
  why: "The prototype trades a faster setup against skipping the profile step - a product call, not a technical one.",
  recommendation: "ship",
  recommendation_why: "Early tests show faster completion with no drop in signups.",
  options: [
    { id: "ship", label: "Ship this sprint" },
    { id: "hold", label: "Hold for more testing" },
  ],
};

async function knockUpdateMarkdown(
  client: DaemonClient, cwd: string, caseId: string, message: string, text: string, done = false,
): Promise<void> {
  const staged = stageMarkdown({
    path: "./explain.md",
    cwd: (() => { writeFileSync(join(cwd, "explain.md"), text); return cwd; })(),
    incomingDir: join(daemonPaths().home, "incoming"),
  });
  await client.call(
    "case.update",
    { case_id: caseId, message, artifact: { type: "markdown", path: staged.path }, ...(done ? { done: true } : {}) },
    15000,
  );
}

// Stages and attaches an html_bundle revision through case.update - the
// detail request's second round, "a chart" (HAIL-33).
async function knockUpdateChart(client: DaemonClient, cwd: string, caseId: string, message: string): Promise<void> {
  const chartDir = join(cwd, "chart");
  mkdirSync(chartDir, { recursive: true });
  for (const [name, contents] of Object.entries(CHART_FIXTURE)) {
    writeFileSync(join(chartDir, name), contents);
  }
  const staged = stageBundle({
    dir: "chart",
    entry: "index.html",
    cwd,
    incomingDir: join(daemonPaths().home, "incoming"),
  });
  await client.call(
    "case.update",
    { case_id: caseId, message, artifact: { type: "html_bundle", dir: staged.path, entry: staged.entry } },
    15000,
  );
}

// A more_detail reply (HAIL-33), submitted the way the app's "Ask" button
// does: no choice, the optional question as the message. `format` (HAIL-139)
// is the one-tap format the human picked, when any.
async function submitDetailReply(caseId: string, message: string | undefined, format?: string): Promise<string> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const reply = (await client.call(
    "reply.submit",
    {
      case_id: caseId,
      idempotency_key: randomUUID(),
      message,
      intent: "more_detail",
      ...(format !== undefined ? { format } : {}),
      comments: [],
      captures: [],
    },
    5000,
  )) as { id: string };
  client.close();
  return reply.id;
}

// A reply as the app itself would send it: `reply.submit` needs no session
// (it is an app-side call, not a session-side one) - `SendFlowController`
// calls it the same way over the app's own connection.
async function submitReply(caseId: string, choice: string): Promise<string> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const reply = (await client.call(
    "reply.submit",
    { case_id: caseId, idempotency_key: randomUUID(), choice, comments: [], captures: [] },
    5000,
  )) as { id: string };
  client.close();
  return reply.id;
}

// A reply with no choice at all (docs/stories/HAIL-36.md): the operator
// typed a note without ever picking an option - the case the operator's own
// bug report described (a stored reply of `choice: "catalogue"`, the
// recommendation, even though they never picked it; this harness proves the
// fix by sending no choice at all and checking nothing shows as chosen).
async function submitReplyMessageOnly(caseId: string, message: string): Promise<string> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const reply = (await client.call(
    "reply.submit",
    { case_id: caseId, idempotency_key: randomUUID(), message, comments: [], captures: [] },
    5000,
  )) as { id: string };
  client.close();
  return reply.id;
}

// A plain decision reply with both a choice and a message (HAIL-33's follow-
// up evidence needs both, unlike `submitReply`'s choice-only shape, so the
// recap line reads "You chose: <label>. <message>").
async function submitDetailReplyChoice(caseId: string, choice: string, message: string): Promise<string> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const reply = (await client.call(
    "reply.submit",
    { case_id: caseId, idempotency_key: randomUUID(), choice, message, comments: [], captures: [] },
    5000,
  )) as { id: string };
  client.close();
  return reply.id;
}

async function ackReply(client: DaemonClient, replyId: string): Promise<void> {
  await client.call("reply.ack", { reply_id: replyId }, 5000);
}

// A minimal valid 1x1 transparent PNG (docs/stories/HAIL-34.md fold, evidence
// #12: "Change answer ... with earlier comments restored" needs a capture
// the app's `NSImage(data:)` can actually decode - the pixels themselves
// don't matter for this screenshot).
const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Like `submitReply`, but with one comment pinned on one capture - the
// restore path evidence #12 needs (`CommentsSessionStore.restore(from:)`).
async function submitReplyWithComment(caseId: string, choice: string, pngBase64 = ONE_PX_PNG_BASE64): Promise<string> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const captureId = randomUUID();
  const reply = (await client.call(
    "reply.submit",
    {
      case_id: caseId,
      idempotency_key: randomUUID(),
      choice,
      comments: [
        { id: randomUUID(), capture_id: captureId, n: 1, rect: { x: 0.2, y: 0.2, w: 0.3, h: 0.2 }, text: "Make this button blue" },
      ],
      captures: [
        {
          id: captureId,
          revision: 1,
          png_base64: pngBase64,
          annotated_png_base64: pngBase64,
          taken_at: new Date().toISOString(),
        },
      ],
    },
    5000,
  )) as { id: string };
  client.close();
  return reply.id;
}

// The earlier ask a follow-up points to (HAIL-33 amendment): a decision
// case, answered with a choice and a message, so the follow-up's recap
// reads "You chose: Change something. Why don't we make the button blue?" -
// the story's own example text.
const FOLLOWUP_EARLIER_FIXTURE = {
  kind: "question" as const,
  title: "Change the button color?",
  need: "Decide whether to change the primary button to blue.",
  why: "A visual preference call, not a technical one.",
  recommendation: "keep",
  recommendation_why: "Blue does not match the rest of the palette.",
  options: [
    { id: "keep", label: "Keep it orange" },
    { id: "change", label: "Change something" },
  ],
};

const FOLLOWUP_QUESTION_FIXTURE = {
  kind: "question" as const,
  title: "Which shade of blue?",
  need: "Pick the exact blue for the primary button.",
  why: "Needs a decision on the palette before implementing.",
  recommendation: "brand",
  recommendation_why: "Matches the existing brand blue used elsewhere.",
};

// A dead pid as `parent_pid`: `session.hello` records it, and once the
// connection also closes, the daemon's own dead-parent check
// (`server.ts markDisconnected`) marks the session `ended`, which fails any
// reply still `queued` for its task - the exact path a real agent process
// dying mid-review takes (docs/store.ts `setSessionState`).
function deadPid(): number {
  const result = spawnSync("bash", ["-c", "echo $$"]);
  const pid = Number.parseInt(result.stdout.toString().trim(), 10);
  return pid + 1_000_000; // never a real pid on this machine
}

// HAIL-141 evidence: three review cases carrying a diagram artifact - a valid
// Mermaid flowchart, a valid .svg, and an invalid Mermaid source whose render
// error shows "Waggle could not draw this diagram" plus the source.
const DIAGRAM_MMD_SOURCE = [
  "flowchart TD",
  "    A[Open ask] --> B[Build]",
  "    B --> C[Review]",
  "    C --> D{Approved?}",
  "    D -- yes --> E[Ship]",
  "    D -- no --> B",
].join("\n");

const DIAGRAM_SVG_SOURCE = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 370 150" width="370" height="150">',
  '  <rect x="10" y="50" width="90" height="44" rx="8" fill="#2f6fed" />',
  '  <rect x="140" y="50" width="90" height="44" rx="8" fill="#595959" />',
  '  <rect x="270" y="50" width="90" height="44" rx="8" fill="#595959" />',
  '  <line x1="100" y1="72" x2="138" y2="72" stroke="#595959" stroke-width="2" marker-end="url(#a)" />',
  '  <line x1="230" y1="72" x2="268" y2="72" stroke="#595959" stroke-width="2" marker-end="url(#a)" />',
  '  <text x="55" y="78" text-anchor="middle" fill="#fff" font-size="13">Ask</text>',
  '  <text x="185" y="78" text-anchor="middle" fill="#fff" font-size="13">Build</text>',
  '  <text x="315" y="78" text-anchor="middle" fill="#fff" font-size="13">Ship</text>',
  "</svg>",
].join("\n");

// An unclosed bracket makes Mermaid's parser fail, so the wrapper shows the
// render-error state deterministically.
const DIAGRAM_ERROR_SOURCE = "flowchart TD\n  A[Start --> B";

async function diagram(): Promise<void> {
  const pid = process.pid;
  const make = async (label: string, ext: "mmd" | "svg", source: string): Promise<void> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
    const cwd = join(root, "Waggle");
    mkdirSync(cwd, { recursive: true });
    const rel = `diagram.${ext}`;
    writeFileSync(join(cwd, rel), source);
    const staged = stageDiagram({ path: rel, cwd, incomingDir: join(daemonPaths().home, "incoming") });
    await client.call(
      "session.hello",
      { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: pid },
      5000,
    );
    const created = (await client.call(
      "case.create",
      { ...CASE_FIXTURE, artifact: { type: "diagram", path: staged.path } },
      15000,
    )) as { id: string };
    console.log(`${label}=${created.id}`);
  };

  await make("DIAGRAM_MMD_CASE", "mmd", DIAGRAM_MMD_SOURCE);
  await make("DIAGRAM_SVG_CASE", "svg", DIAGRAM_SVG_SOURCE);
  await make("DIAGRAM_ERROR_CASE", "mmd", DIAGRAM_ERROR_SOURCE);
}

// `reproBundle <absolute dir>` (HAIL-143): stages a bundle already on disk
// (entry index.html) as a review ask and prints its case id.
async function reproBundle(dirPath: string): Promise<void> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const staged = stageBundle({
    dir: basename(dirPath),
    entry: "index.html",
    cwd: dirname(dirPath),
    incomingDir: join(daemonPaths().home, "incoming"),
  });
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd: dirname(dirPath), branch: "Waggle test", git_root: null, parent_pid: process.pid },
    5000,
  );
  const created = (await client.call(
    "case.create",
    { ...CASE_FIXTURE, artifact: { type: "html_bundle", dir: staged.path, entry: staged.entry } },
    15000,
  )) as { id: string };
  console.log(`REPRO_CASE=${created.id}`);
}

async function setup(): Promise<void> {
  // Two plain needs_you cases, created before anything else replies to
  // them, so the queue screenshot (evidence #13) has enough distinct
  // arrival times to show newest-first ordering in the Needs-you section
  // too, not only in Waiting-on-agent.
  const pending1 = await connectedSession(process.pid);
  console.log(`CASE_PENDING_1=${pending1.caseId}`);
  const pending2 = await connectedSession(process.pid);
  console.log(`CASE_PENDING_2=${pending2.caseId}`);

  const queued = await connectedSession(process.pid);
  const queuedReplyId = await submitReply(queued.caseId, "a");
  // Left queued on purpose - `queued.client` stays connected with a live
  // pid (this script's own), so it never fails.
  console.log(`CASE_QUEUED=${queued.caseId}`);
  console.log(`REPLY_QUEUED=${queuedReplyId}`);

  // A queued reply that also carries a comment/capture (docs/stories/
  // HAIL-34.md fold, evidence #12): "Change answer" on this one restores
  // that comment into the workspace's Comment mode.
  const commented = await connectedSession(process.pid);
  const commentedReplyId = await submitReplyWithComment(commented.caseId, "a");
  console.log(`CASE_COMMENTED=${commented.caseId}`);
  console.log(`REPLY_COMMENTED=${commentedReplyId}`);

  const delivered = await connectedSession(process.pid);
  const deliveredReplyId = await submitReply(delivered.caseId, "b");
  await ackReply(delivered.client, deliveredReplyId);
  console.log(`CASE_DELIVERED=${delivered.caseId}`);

  const failing = await connectedSession(deadPid());
  await submitReply(failing.caseId, "a");
  failing.client.close(); // the dead pid + the now-closed connection together mark the session ended
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log(`CASE_FAILED=${failing.caseId}`);

  // --- HAIL-33: "Ask for more detail" and the linked follow-up amendment ---

  // A plain question ask, left untouched: opens straight to "the ask with
  // the detail field open" evidence (click "Ask for more detail", type or
  // pick a chip).
  const detailAsk = await connectedSession(process.pid, DETAIL_QUESTION_FIXTURE);
  console.log(`CASE_DETAIL_ASK=${detailAsk.caseId}`);

  // A more_detail reply left queued, un-acked: "the waiting state" evidence
  // ("Asked for more detail · waiting for the agent").
  const detailWaiting = await connectedSession(process.pid, DETAIL_QUESTION_FIXTURE);
  await submitDetailReply(detailWaiting.caseId, "Show the numbers");
  console.log(`CASE_DETAIL_WAITING=${detailWaiting.caseId}`);

  // A more_detail reply picked up and answered with one waggle_update round:
  // a markdown explanation. Its own case, separate from the chart case
  // below, so its LATEST (only) revision is the markdown one - "the
  // returned round with a markdown explanation" evidence.
  const detailMarkdown = await connectedSession(process.pid, DETAIL_REVIEW_FIXTURE);
  const markdownReplyId = await submitDetailReply(detailMarkdown.caseId, "Explain the trade-offs");
  await ackReply(detailMarkdown.client, markdownReplyId);
  await knockUpdateMarkdown(
    detailMarkdown.client, detailMarkdown.cwd, detailMarkdown.caseId,
    "Here's the trade-off write-up.",
    "# Trade-offs\n\nShipping this sprint means less polish but faster user feedback.\n\n" +
      "- Faster to ship\n- Slightly more visual risk\n- Support load may rise short-term\n\n" +
      "| Option | Timeline |\n| --- | --- |\n| Ship now | This sprint |\n| Slip | Next sprint |\n",
  );
  console.log(`CASE_DETAIL_MARKDOWN=${detailMarkdown.caseId}`);

  // A more_detail reply answered with two waggle_update rounds - markdown
  // first, then an HTML chart (the evidence note's own scripted-agent
  // flow): "a second round with an HTML chart" evidence, the M9 "v2
  // arrived" treatment on a genuine v2.
  const detailChart = await connectedSession(process.pid, DETAIL_REVIEW_FIXTURE);
  const chartReplyId = await submitDetailReply(detailChart.caseId, "Show the numbers");
  await ackReply(detailChart.client, chartReplyId);
  await knockUpdateMarkdown(
    detailChart.client, detailChart.cwd, detailChart.caseId,
    "Here's the trade-off write-up first.",
    "# Trade-offs\n\nA short explanation before the numbers.\n",
  );
  await knockUpdateChart(detailChart.client, detailChart.cwd, detailChart.caseId, "And here's the ticket trend.");
  console.log(`CASE_DETAIL_CHART=${detailChart.caseId}`);

  // A follow-up ask (HAIL-33 amendment): the earlier ask answered with a
  // choice and a message, then a new, linked ask on the same session/task.
  const followUpEarlier = await connectedSession(process.pid, FOLLOWUP_EARLIER_FIXTURE);
  const earlierReplyId = await submitDetailReplyChoice(followUpEarlier.caseId, "change", "Why don't we make the button blue?");
  await ackReply(followUpEarlier.client, earlierReplyId);
  const followUpCreated = (await followUpEarlier.client.call(
    "case.create",
    { ...FOLLOWUP_QUESTION_FIXTURE, follows: followUpEarlier.caseId },
    15000,
  )) as { id: string };
  console.log(`CASE_FOLLOWUP_EARLIER=${followUpEarlier.caseId}`);
  console.log(`CASE_FOLLOWUP=${followUpCreated.id}`);

  // --- HAIL-35: Comment mode scroll + multi-capture evidence ---
  const tall = await connectedSession(process.pid, TALL_PROTOTYPE_FIXTURE, TALL_PROTOTYPE_BUNDLE);
  console.log(`CASE_TALL=${tall.caseId}`);

  // --- HAIL-40: the screenshots artifact's own evidence ---
  const screenshots = await connectedScreenshotsSession(process.pid);
  console.log(`CASE_SCREENSHOTS=${screenshots.caseId}`);

  // An options ask answered with a message and NO choice, delivered
  // (docs/stories/HAIL-36.md evidence: "an options case answered with a
  // message and NO choice, delivered") - both the pane (dimmed options, new
  // "Your answer" message card) and the review workspace's answered recap
  // must show no option marked, only the typed message. Created last, so
  // it sorts to the top of "Waiting on agent" (newest-first) and its row is
  // visible without scrolling the queue.
  const messageOnly = await connectedSession(process.pid);
  const messageOnlyReplyId = await submitReplyMessageOnly(
    messageOnly.caseId,
    "Let's hold off on both for now - can we see a version with a live cart preview first?",
  );
  await ackReply(messageOnly.client, messageOnlyReplyId);
  console.log(`CASE_MESSAGE_ONLY=${messageOnly.caseId}`);

  // A question ask with an HTML plan artifact, left unanswered (docs/
  // stories/HAIL-36.md amendment 3 evidence).
  const questionWithArtifact = await connectedSession(
    process.pid, QUESTION_WITH_ARTIFACT_FIXTURE, TEST_FIXTURE, { attachArtifact: true },
  );
  console.log(`CASE_QUESTION_ARTIFACT=${questionWithArtifact.caseId}`);

  // Every other session's own connection closes here too (the script exiting
  // normally closes every socket) - harmless, since `markDisconnected` only
  // escalates "disconnected" to "ended" when the recorded pid is ALSO
  // already dead, and this script's own pid is alive for the whole run.
  pending1.client.close();
  pending2.client.close();
  queued.client.close();
  commented.client.close();
  delivered.client.close();
  messageOnly.client.close();
  detailAsk.client.close();
  detailWaiting.client.close();
  detailMarkdown.client.close();
  detailChart.client.close();
  followUpEarlier.client.close();
  tall.client.close();
  questionWithArtifact.client.close();
  screenshots.client.close();
}

// HAIL-59: four live sessions for the sessions panel, one per state (needs
// you, working since a delivered reply, reply queued for pickup, idle). The
// connections stay open, so the sessions stay live, until this process gets
// SIGTERM. Prints `SESSIONS_READY=1` once they are all set up.
async function sessions(): Promise<void> {
  const clients: DaemonClient[] = [];
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const open = async (project: string, branch: string): Promise<DaemonClient> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    await client.call(
      "session.hello",
      { session_id: randomUUID(), cwd, branch, git_root: null, parent_pid: process.pid },
      5000,
    );
    clients.push(client);
    return client;
  };
  const ask = async (client: DaemonClient, title: string): Promise<string> => {
    const created = (await client.call(
      "case.create",
      { kind: "question", title, need: `${title} Pick one.`, why: "Evidence for the sessions panel.",
        recommendation: "yes", recommendation_why: "Simplest.",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      15000,
    )) as { id: string };
    return created.id;
  };

  const needsYou = await open("knock", "HAIL-59");
  await ask(needsYou, "Ship the settings page redesign this sprint?");
  await ask(needsYou, "Rename the footer label?");

  const working = await open("omea-group", "main");
  const workingCase = await ask(working, "Change the button color?");
  await ackReply(working, await submitReply(workingCase, "yes"));

  const queued = await open("knock", "main");
  await submitReply(await ask(queued, "Onboarding flow: ready to ship?"), "yes");

  await open("weekend-league", "main");

  console.log("SESSIONS_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const client of clients) client.close();
}

// HAIL-72 evidence: three live sessions for the context lines. One has an ask that needs you, one is
// a Claude session with a fake transcript (under $HOME/.claude/projects, so run this with the sandbox
// HOME) and a small git repo in its folder, one is Codex with no transcript. Stays live until SIGTERM.
async function sessionContext(): Promise<void> {
  const clients: DaemonClient[] = [];
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const open = async (project: string, branch: string, runtime: "claude" | "codex", id = randomUUID()) => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    await client.call("session.hello", { session_id: id, cwd, branch, git_root: null, parent_pid: process.pid, runtime }, 5000);
    clients.push(client);
    return { client, cwd, id };
  };

  const blocked = await open("knock", "HAIL-59", "claude");
  await blocked.client.call(
    "case.create",
    { kind: "question", title: "Ship the settings page redesign this sprint?", need: "Ship it?", why: "Evidence.",
      recommendation: "yes", recommendation_why: "Simplest.",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
    15000,
  );

  const withContext = await open("omea-group", "main", "claude");
  const slug = withContext.cwd.replace(/[^A-Za-z0-9]/g, "-");
  const projects = join(process.env.HOME!, ".claude", "projects", slug);
  mkdirSync(projects, { recursive: true });
  const git = (...a: string[]) =>
    spawnSync("git", ["-C", withContext.cwd, "-c", "user.email=e@e", "-c", "user.name=e", ...a], { stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(withContext.cwd, "notes.txt"), "one\ntwo\nthree\n");
  git("add", ".");
  git("commit", "-q", "-m", "Add the onboarding checklist");
  writeFileSync(join(withContext.cwd, "notes.txt"), "one\nTWO\nthree\nfour\nfive\n");
  writeFileSync(join(withContext.cwd, "checklist.md"), "- a\n- b\n");
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  const asst = (secondsAgo: number, blocks: object[]) =>
    JSON.stringify({ type: "assistant", timestamp: at(secondsAgo), message: { role: "assistant", content: blocks } });
  const tool = (name: string, input: object) => ({ type: "tool_use", name, input });
  const lines = [
    JSON.stringify({ type: "user", turnOrigin: "human", timestamp: at(900), message: { role: "user", content: "Make the onboarding checklist show progress and let members skip a step they have already done." } }),
    JSON.stringify({ type: "ai-title", aiTitle: "Onboarding checklist progress and skipping" }),
    asst(200, [tool("TodoWrite", { todos: [
      { content: "Read the checklist code", activeForm: "Reading the checklist code", status: "completed" },
      { content: "Add the progress bar", activeForm: "Adding the progress bar", status: "completed" },
      { content: "Wire up skip", activeForm: "Wiring up skip", status: "in_progress" },
      { content: "Write tests", activeForm: "Writing tests", status: "pending" },
    ] })]),
    asst(90, [tool("Edit", { file_path: "/x/src/Checklist.tsx" })]),
    asst(60, [tool("Bash", { command: "fleet board 2>&1 | grep -E 'HAIL|OME' | head" })]),
    asst(30, [tool("Bash", { command: "bun test 2>&1 | tail -5", description: "Run the checklist tests" })]),
    asst(12, [{ type: "text", text: "**Skip** now works for steps a member already did. Next I will cover it with tests and check the empty state." }, tool("Edit", { file_path: "/x/src/Checklist.test.tsx" })]),
  ];
  writeFileSync(join(projects, `${withContext.id}.jsonl`), lines.join("\n") + "\n");

  await open("weekend-league", "main", "codex");

  console.log("SESSIONS_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const client of clients) client.close();
}

// HAIL-69 evidence: one busy session ("omea-group · main") with 22 asks today (one needs you, the
// newest is being worked on, twenty answered), plus 16 other live sessions, so the sessions panel
// hits its height cap in both the list and the detail. Stays up until SIGTERM. Prints
// `MANY_READY=1`. Use with `KNOCK_SESSIONS_PANEL=list` or `detail:<n>` (n = 0 is omea-group).
async function manySessions(): Promise<void> {
  const clients: DaemonClient[] = [];
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const db = new Database(daemonPaths().db);
  db.exec("PRAGMA busy_timeout = 5000");
  const open = async (project: string, branch: string): Promise<DaemonClient> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    await client.call(
      "session.hello",
      { session_id: randomUUID(), cwd, branch, git_root: null, parent_pid: process.pid },
      5000,
    );
    clients.push(client);
    return client;
  };
  const ask = async (client: DaemonClient, title: string): Promise<string> => {
    const created = (await client.call(
      "case.create",
      { kind: "question", title, need: `${title} Pick one.`, why: "Evidence for the tall sessions panel.",
        recommendation: "yes", recommendation_why: "Simplest.",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      15000,
    )) as { id: string };
    return created.id;
  };
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  // Ask created `minutes` + 2 ago, reply at +1, pickup at `minutes`.
  const backdate = (caseId: string, minutes: number): void => {
    db.query("UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?").run(at(minutes + 2), at(minutes), caseId);
    db.query("UPDATE replies SET created_at = ?, delivered_at = CASE WHEN state = 'delivered' THEN ? END WHERE case_id = ?")
      .run(at(minutes + 1), at(minutes), caseId);
  };
  const now = new Date();
  const sinceMidnight = now.getHours() * 60 + now.getMinutes();
  const step = Math.max(1, Math.floor((sinceMidnight - 40) / 22));
  const titles = ["Rename the footer label?", "Ship 0.1.8 now?", "Keep the long scroll?", "Use the new icon set?",
    "Split the settings page?", "Drop the legacy import?", "Bump the minimum macOS?", "Cache the case list?"];

  // The other sessions first, so the busy one is the newest connection and sorts where the
  // detail hook (`detail:0`) finds it. Sessions sort by the daemon; check the order in the capture.
  const busy = await open("omea-group", "main");
  for (let i = 0; i < 20; i++) {
    const id = await ask(busy, `${titles[i % titles.length]} (${i + 1})`);
    await ackReply(busy, await submitReply(id, "yes"));
    backdate(id, 14 + i * step);
  }
  const needs = await ask(busy, "Ship the settings page redesign this sprint?");
  db.query("UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?").run(at(9), at(9), needs);
  const working = await ask(busy, "Change the button color?");
  await ackReply(busy, await submitReply(working, "yes"));
  backdate(working, 3);

  const projects = ["knock", "weekend-league", "acme-api", "acme-web", "acme-docs", "billing", "mobile-app", "infra",
    "design-system", "search", "onboarding", "notifications", "analytics", "auth", "admin", "landing"];
  for (const [i, project] of projects.entries()) {
    const client = await open(project, i % 3 === 0 ? "main" : `HAIL-${60 + i}`);
    if (i % 4 === 0) await ask(client, `${titles[i % titles.length]}`);
    else if (i % 4 === 1) {
      const id = await ask(client, titles[i % titles.length]);
      await ackReply(client, await submitReply(id, "yes"));
      backdate(id, 2);
    } else if (i % 4 === 2) await submitReply(await ask(client, titles[i % titles.length]), "yes");
  }

  db.close();
  console.log("MANY_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const client of clients) client.close();
}

// HAIL-62 evidence: one ask per orb state, on separate sessions, so the queue,
// the case pane, the sessions panel and Settings all show every state. Prints
// `CASE_<STATE>=<id>` lines. `orbs <n>` adds n more asks (mixed states) for the
// many-rows CPU measurement. Sessions stay open until SIGTERM.
async function orbs(extra: number): Promise<void> {
  const clients: DaemonClient[] = [];
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const open = async (project: string, branch: string): Promise<DaemonClient> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    await client.call(
      "session.hello",
      { session_id: randomUUID(), cwd, branch, git_root: null, parent_pid: process.pid },
      5000,
    );
    clients.push(client);
    return client;
  };
  const ask = async (client: DaemonClient, title: string): Promise<string> => {
    const created = (await client.call(
      "case.create",
      { kind: "question", title, need: `${title} Pick one.`, why: "Evidence for the orb.",
        recommendation: "yes", recommendation_why: "Simplest.",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      15000,
    )) as { id: string };
    return created.id;
  };

  const a = await open("knock", "HAIL-62");
  console.log(`CASE_NEEDS_YOU=${await ask(a, "Ship the settings page redesign this sprint?")}`);

  const b = await open("knock", "main");
  const queuedCase = await ask(b, "Onboarding flow: ready to ship?");
  await submitReply(queuedCase, "yes");
  console.log(`CASE_WAITING=${queuedCase}`);

  const c = await open("omea-group", "main");
  const workingCase = await ask(c, "Change the button color?");
  await ackReply(c, await submitReply(workingCase, "yes"));
  console.log(`CASE_WORKING=${workingCase}`);

  const d = await open("knock", "HAIL-54");
  const writingCase = await ask(d, "Pricing card: compact or detailed?");
  await ackReply(d, await submitDetailReply(writingCase, "Show the numbers"));
  console.log(`CASE_WRITING=${writingCase}`);

  await open("weekend-league", "main"); // connected, nothing to ask

  const f = await open("knock", "HAIL-51");
  const closedCase = await ask(f, "Which shade of blue?");
  await submitReply(closedCase, "yes");
  f.close(); // the session drops before it reads the reply
  console.log(`CASE_CLOSED=${closedCase}`);

  for (let i = 0; i < extra; i++) {
    const client = await open(`project-${i % 4}`, `branch-${i % 3}`);
    const id = await ask(client, `Extra ask ${i + 1}: keep going?`);
    if (i % 4 === 1) await submitReply(id, "yes");
    else if (i % 4 === 2) await ackReply(client, await submitReply(id, "yes"));
    else if (i % 4 === 3) await ackReply(client, await submitDetailReply(id, "More detail please"));
  }

  console.log("ORBS_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const client of clients) client.close();
}

// HAIL-64 evidence: the queue with asks in every state, some older than 10
// minutes and some from yesterday and earlier, so "Waiting on agent" and the
// collapsed/open "Answered" group both have content. Test-only backdating: it
// opens the temp KNOCK_HOME's own knock.db and moves the timestamps of asks it
// just made (never run against a real data root). Prints `CASE_<NAME>=<id>`.
// Sessions stay open until SIGTERM, except the ones the scenario closes.
async function answered(compact = false, slim = false): Promise<void> {
  const clients: DaemonClient[] = [];
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const db = new Database(daemonPaths().db);
  db.exec("PRAGMA busy_timeout = 5000");
  const open = async (project: string, branch: string): Promise<DaemonClient> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    await client.call(
      "session.hello",
      { session_id: randomUUID(), cwd, branch, git_root: null, parent_pid: process.pid },
      5000,
    );
    clients.push(client);
    return client;
  };
  const ask = async (client: DaemonClient, title: string): Promise<string> => {
    const created = (await client.call(
      "case.create",
      { kind: "question", title, need: `${title} Pick one.`, why: "Evidence for the Answered group.",
        recommendation: "yes", recommendation_why: "Simplest.",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      15000,
    )) as { id: string };
    return created.id;
  };
  // Moves the ask's creation to `minutes` + 2 minutes ago, its reply to +1 and
  // the pickup to `minutes` ago.
  const backdate = (caseId: string, minutes: number): void => {
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    db.query("UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?").run(at(minutes + 2), at(minutes), caseId);
    db.query("UPDATE replies SET created_at = ?, delivered_at = CASE WHEN state = 'delivered' THEN ? END WHERE case_id = ?")
      .run(at(minutes + 1), at(minutes), caseId);
  };
  // An answered ask on its own session, picked up `minutes` ago. `close` drops
  // the session after the pickup.
  const answeredAsk = async (project: string, title: string, minutes: number, close = false): Promise<string> => {
    const client = await open(project, "main");
    const id = await ask(client, title);
    await ackReply(client, await submitReply(id, "yes"));
    backdate(id, minutes);
    if (close) client.close();
    return id;
  };

  // Needs you.
  const a = await open("knock", "HAIL-64");
  console.log(`CASE_NEEDS_YOU=${await ask(a, "Ship the settings redesign this sprint?")}`);

  // Still waiting: queued, picked up just now, detail request, failed.
  const queuedClient = await open("knock", "main");
  const queued = await ask(queuedClient, "Onboarding flow: ready to ship?");
  await submitReply(queued, "yes");
  console.log(`CASE_QUEUED=${queued}`);

  if (!slim) {
  const workingClient = await open("omea-group", "main");
  const working = await ask(workingClient, "Change the button color?");
  await ackReply(workingClient, await submitReply(working, "yes"));
  backdate(working, 3);
  console.log(`CASE_WORKING=${working}`);

  const writingClient = await open("knock", "HAIL-54");
  const writing = await ask(writingClient, "Pricing card: compact or detailed?");
  await ackReply(writingClient, await submitDetailReply(writing, "Show the numbers"));
  backdate(writing, 45); // older than 10 minutes, but the agent is still writing
  console.log(`CASE_WRITING=${writing}`);
  }

  // `compact` (and `slim`) leave the failed ask out so the Answered header fits on screen.
  if (!compact) {
    const failedClient = await open("knock", "HAIL-51");
    const failed = await ask(failedClient, "Which shade of blue?");
    await submitReply(failed, "yes");
    failedClient.close(); // the session drops before it reads the reply
    console.log(`CASE_FAILED=${failed}`);
  }

  // Moves to Answered: 10 minutes after pickup (live), session closed, and a
  // newer ask on the same task.
  console.log(`CASE_OLD_LIVE=${await answeredAsk("acme-api", "Archive old Done Linear issues?", 12)}`);
  console.log(`CASE_CLOSED=${await answeredAsk("acme-web", "Answer box: which direction?", 2, true)}`);
  const followedClient = await open("acme-docs", "main");
  const followedOld = await ask(followedClient, "Onboarding audit: when to fix the gaps?");
  await ackReply(followedClient, await submitReply(followedOld, "yes"));
  backdate(followedOld, 4);
  const followedNew = await ask(followedClient, "Onboarding audit: which gap first?");
  await ackReply(followedClient, await submitReply(followedNew, "yes"));
  backdate(followedNew, 1);
  console.log(`CASE_FOLLOWED=${followedOld}`);

  // Bulk: more today, yesterday and earlier days, one session each.
  const now = new Date();
  const sinceMidnight = now.getHours() * 60 + now.getMinutes();
  const titles = ["Rename the footer label?", "Ship 0.1.8 now?", "Keep the long scroll?", "Use the new icon set?",
    "Split the settings page?", "Drop the legacy import?", "Bump the minimum macOS?", "Cache the case list?"];
  for (let i = 0; i < (slim ? 3 : 10); i++) {
    await answeredAsk(`today-${i}`, `${titles[i % titles.length]} (${i + 1})`, 20 + i * Math.max(1, Math.floor((sinceMidnight - 30) / 10)));
  }
  for (let i = 0; i < (slim ? 3 : 8); i++) {
    await answeredAsk(`yday-${i}`, `${titles[i % titles.length]} (y${i + 1})`, sinceMidnight + 120 + i * 90);
  }
  for (const [i, days] of (slim ? [2, 4] : [2, 2, 3, 5, 9]).entries()) {
    await answeredAsk(`older-${i}`, `${titles[i % titles.length]} (d${days})`, sinceMidnight + days * 1440 - 600 + i * 30);
  }

  db.close();
  console.log("ANSWERED_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const client of clients) client.close();
}

async function replace(replyId: string): Promise<void> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  await client.call("reply.replace", { reply_id: replyId, choice: "b", comments: [], captures: [] }, 5000);
  client.close();
  console.log(`replaced ${replyId}`);
}

// HAIL-67 evidence: asks that came back after a reply. CASE_ROUNDS (HAIL-68) has two
// rounds (reply, update with v2, reply, update with v3), backdated for the thread. CASE_REVISION is a
// review ask with one comment on v1, answered, then waggle_update with a new
// artifact (v2). CASE_TEXT is a question with no artifact, answered, then a
// text-only waggle_update. CASE_PLAIN was never answered, for comparison.
// Sessions stay open until SIGTERM.
async function updates(): Promise<void> {
  const db = new Database(daemonPaths().db);
  db.exec("PRAGMA busy_timeout = 5000");
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  // Moves an ask's history back in time so the thread shows real gaps ("worked 8m"):
  // creation, then each reply (picked up a minute later), each agent message and each
  // revision, in the order they were made. Minutes are ago-times, oldest first.
  const backdate = (caseId: string, t: { created: number; replies: [number, number][]; updates: number[]; revisions: number[] }): void => {
    db.query("UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?").run(ago(t.created), ago(t.updates.at(-1)!), caseId);
    const replies = db.query("SELECT id FROM replies WHERE case_id = ? ORDER BY rowid").all(caseId) as { id: string }[];
    replies.forEach((r, i) => {
      db.query("UPDATE replies SET created_at = ?, delivered_at = ? WHERE id = ?").run(ago(t.replies[i]![0]), ago(t.replies[i]![1]), r.id);
    });
    const msgs = db.query("SELECT id FROM messages WHERE case_id = ? AND role = 'agent' ORDER BY rowid").all(caseId) as { id: string }[];
    msgs.forEach((m, i) => db.query("UPDATE messages SET created_at = ? WHERE id = ?").run(ago(t.updates[i]!), m.id));
    const revs = db.query("SELECT id FROM revisions WHERE case_id = ? ORDER BY n").all(caseId) as { id: string }[];
    revs.forEach((r, i) => db.query("UPDATE revisions SET created_at = ? WHERE id = ?").run(ago(t.revisions[i]!), r.id));
  };

  const rounds = await connectedSession(process.pid, {
    ...CASE_FIXTURE,
    title: "OME-540: do the account screens match the design after the second pass?",
    need: "Confirm the account screens match the design.",
    why: "The first two passes changed spacing and copy.",
  });
  const round1 = await submitReplyWithComment(rounds.caseId, "b");
  await ackReply(rounds.client, round1);
  await new Promise((r) => setTimeout(r, 50));
  await knockUpdateChart(rounds.client, rounds.cwd, rounds.caseId, "Fixed the spacing under the heading and rebuilt the screens from the design file.");
  const round2 = await submitReply(rounds.caseId, "b");
  await ackReply(rounds.client, round2);
  await new Promise((r) => setTimeout(r, 50));
  await knockUpdateChart(rounds.client, rounds.cwd, rounds.caseId, "The button now matches the design (14 pt, underlined). Screens on the left are the new build.");
  backdate(rounds.caseId, { created: 60, replies: [[45, 44], [25, 24]], updates: [33, 4], revisions: [60, 33, 4] });
  console.log(`CASE_ROUNDS=${rounds.caseId}`);

  const review = await connectedSession(process.pid, {
    ...CASE_FIXTURE,
    title: "OME-534: do the 'Check your email' screens match the design?",
    need: "Confirm the 'Check your email' screens match the design.",
    why: "I compared them by eye and cannot be sure about the spacing.",
  });
  await submitReplyWithComment(review.caseId, "b");
  await new Promise((r) => setTimeout(r, 50));
  await knockUpdateChart(
    review.client, review.cwd, review.caseId,
    "Fixed the spacing under the heading and rebuilt both screens from the design file. Please look again.",
  );
  backdate(review.caseId, { created: 30, replies: [[20, 19]], updates: [2], revisions: [30, 2] });
  console.log(`CASE_REVISION=${review.caseId}`);

  const text = await connectedSession(process.pid, {
    ...DETAIL_QUESTION_FIXTURE,
    title: "Rename the footer label?",
    need: "Decide if the footer label says Help or Support.",
    options: [{ id: "help", label: "Help" }, { id: "support", label: "Support" }],
    recommendation: "help",
  });
  await submitReply(text.caseId, "support");
  await new Promise((r) => setTimeout(r, 50));
  await text.client.call(
    "case.update",
    { case_id: text.caseId, message: "Support is used in the header already, so I checked the docs: they say Help. Want me to keep Support anyway?" },
    5000,
  );
  console.log(`CASE_TEXT=${text.caseId}`);

  // HAIL-70: the operator's own update message, with markdown, in a thread.
  const markdown = await connectedSession(process.pid, {
    ...DETAIL_QUESTION_FIXTURE,
    title: "Onboarding: one link or two under the email field?",
    need: "Decide which link shows under the email field: **\"Wrong email? Start again\"** or **\"Sign out\"**.",
    why: "The two overlap:\n- **Start again** is for a new sign-up.\n- **Sign out** is for an existing member.",
    options: [{ id: "one", label: "Show exactly one" }, { id: "both", label: "Show both" }],
    recommendation: "one",
    recommendation_why: "Showing both is confusing. See `OnboardingEmailView` for the **current** layout.",
  });
  await submitReply(markdown.caseId, "one");
  await new Promise((r) => setTimeout(r, 50));
  await markdown.client.call("case.update", { case_id: markdown.caseId, message: MARKDOWN_UPDATE }, 5000);
  backdate(markdown.caseId, { created: 40, replies: [[27, 26]], updates: [5], revisions: [] });
  console.log(`CASE_MARKDOWN=${markdown.caseId}`);

  // HAIL-95: a text update that carries a shell command (the update card's dark Copy block).
  const command = await connectedSession(process.pid, {
    ...DETAIL_QUESTION_FIXTURE,
    title: "Where is the Paperclip API key for the research prototype?",
    need: "Can you put it in the omea repo's .env, or tell me where it lives?",
    options: [{ id: "env", label: "I'll add it to .env" }, { id: "pubmed", label: "Start with PubMed" }],
    recommendation: "env",
  });
  await submitReply(command.caseId, "env");
  await new Promise((r) => setTimeout(r, 50));
  await command.client.call(
    "case.update",
    {
      case_id: command.caseId,
      message: "Run this in a terminal. It asks for the key without showing it, and prints only \"saved\".\n```\nread -rs \"K?Paperclip key: \" && printf 'PAPERCLIP_API_KEY=%s\\n' \"$K\" >> ~/Documents/omea-group/omea/.env && unset K && echo saved\n```",
    },
    5000,
  );
  backdate(command.caseId, { created: 10, replies: [[6, 5]], updates: [1], revisions: [] });
  console.log(`CASE_COMMAND=${command.caseId}`);

  const plain = await connectedSession(process.pid, {
    ...DETAIL_QUESTION_FIXTURE, title: "Ship the settings page redesign this sprint?",
  });
  console.log(`CASE_PLAIN=${plain.caseId}`);
  console.log("UPDATES_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const c of [rounds, review, text, markdown, command, plain]) c.client.close();
}

// HAIL-75: one review case on a tall HTML prototype (five 640px sections), so
// comments can be made at two scroll positions.
const TALL_PAGE: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Tall prototype</title>
<style>
  body { margin: 0; font: 16px/1.5 -apple-system, sans-serif; color: #1a1a1a; }
  section { height: 640px; box-sizing: border-box; padding: 48px; border-bottom: 1px solid #ddd; }
  section:nth-child(odd) { background: #f4f6fb; }
  h2 { margin: 0 0 12px; }
  button { font-size: 16px; padding: 12px 22px; border-radius: 8px; border: 0; background: #2f6fed; color: #fff; }
</style></head>
<body>
  <section><h2>1 · Hero</h2><p>Start free today.</p><button>Get started</button></section>
  <section><h2>2 · Pricing</h2><p>Monthly or annual billing.</p><button>Choose plan</button></section>
  <section><h2>3 · Features</h2><p>Fast, private, local.</p><button>See all features</button></section>
  <section><h2>4 · Testimonials</h2><p>What people say.</p><button>Read more</button></section>
  <section><h2>5 · Footer</h2><p>Questions? Talk to us.</p><button>Contact</button></section>
</body>
</html>`,
};

// HAIL-131 evidence: a page with a labelled coordinate grid, so a zoom anchor and a pan are visible.
// Prints `CASE_GRID=<id>` and stays up until SIGTERM.
const GRID_PAGE: Record<string, string> = {
  "index.html": `<!doctype html>
<html><head><meta charset="utf-8"><title>Grid</title>
<style>
  body { margin: 0; width: 1600px; height: 2400px; font: 14px -apple-system, sans-serif;
    background-color: #fff;
    background-image: linear-gradient(#cfd6e6 1px, transparent 1px), linear-gradient(90deg, #cfd6e6 1px, transparent 1px);
    background-size: 100px 100px; position: relative; }
  .c { position: absolute; width: 100px; height: 100px; box-sizing: border-box; padding: 6px; color: #2f6fed; }
  .c b { color: #1a1a1a; }
</style></head>
<body>
<script>
  for (let y = 0; y < 24; y++) for (let x = 0; x < 16; x++) {
    const d = document.createElement("div"); d.className = "c";
    d.style.left = x * 100 + "px"; d.style.top = y * 100 + "px";
    d.innerHTML = "<b>" + x + "," + y + "</b>"; document.body.appendChild(d);
  }
</script>
</body></html>`,
};
async function gridPage(): Promise<void> {
  const grid = await connectedBundleSession(process.pid, PREVIEW_NONE_FIXTURE, GRID_PAGE);
  console.log(`CASE_GRID=${grid.caseId}`);
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  grid.client.close();
}

// HAIL-103 evidence: a prototype with two tabs addressed by #a and #b. Pair it with the app's
// `KNOCK_EVIDENCE_VIEWS=a,b` hook, which places one comment on each tab. Prints `CASE_TWO_TABS=<id>`.
const TWO_TABS_PAGE = {
  "index.html": `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: -apple-system, sans-serif; margin: 0; padding: 24px; color: #1a1a1a; background: #fff; }
      nav a { display: inline-block; padding: 8px 16px; margin-right: 8px; border-radius: 8px; background: #eee; color: #333; text-decoration: none; }
      nav a.on { background: #1a1a1a; color: #fff; }
      section { display: none; padding-top: 28px; }
      section.on { display: block; }
      h1 { font-size: 28px; margin: 0 0 8px; }
    </style>
  </head>
  <body>
    <nav><a href="#a" id="ta">Overview</a><a href="#b" id="tb">Pricing</a></nav>
    <section id="a"><h1>Overview tab</h1><p>Welcome. This is the overview of the plan.</p></section>
    <section id="b"><h1>Pricing tab</h1><p>Three plans, billed monthly or yearly.</p></section>
    <script>
      function render() {
        var id = location.hash === "#b" ? "b" : "a";
        ["a", "b"].forEach(function (k) {
          document.getElementById(k).className = k === id ? "on" : "";
          document.getElementById("t" + k).className = k === id ? "on" : "";
        });
      }
      addEventListener("hashchange", render);
      if (!location.hash) location.hash = "#a";
      render();
    </script>
  </body>
</html>`,
};

async function twoTabs(): Promise<void> {
  const tabs = await connectedBundleSession(process.pid, PREVIEW_NONE_FIXTURE, TWO_TABS_PAGE);
  console.log(`CASE_TWO_TABS=${tabs.caseId}`);
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  tabs.client.close();
}

async function tallPage(): Promise<void> {
  const tall = await connectedBundleSession(process.pid, PREVIEW_NONE_FIXTURE, TALL_PAGE);
  console.log(`CASE_TALL=${tall.caseId}`);
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  tall.client.close();
}

// HAIL-76 evidence: a fake Claude Code session that reports `can_nudge: true`, with one ask
// answered 3 minutes ago and not picked up, so the app shows the
// Nudge control. The fake session accepts the daemon's `session.nudge` push and posts to NO
// socket: nothing here connects to a real inbox. A second, older session (`can_nudge` false)
// has its own unpicked reply, to show the plain fallback. Prints `CASE_NUDGE=<id>` and
// `CASE_PLAIN_FALLBACK=<id>`, then `NUDGE_READY=1`, and stays up until SIGTERM.
async function nudge(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const db = new Database(join(daemonPaths().home, "knock.db"));
  const open = async (project: string, branch: string, canNudge: boolean): Promise<DaemonClient> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    await client.call(
      "session.hello",
      { session_id: randomUUID(), cwd, branch, git_root: null, parent_pid: process.pid, can_nudge: canNudge },
      5000,
    );
    if (canNudge) {
      client.onRequest = async (method, params) => {
        console.log(`PUSH ${method} ${JSON.stringify(params)}`);
        return { ok: true };
      };
    }
    return client;
  };
  const ask = async (client: DaemonClient, title: string): Promise<string> => {
    const created = (await client.call(
      "case.create",
      { kind: "question", title, need: `${title} Pick one.`, why: "Evidence for the nudge.",
        recommendation: "yes", recommendation_why: "Simplest.",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      15000,
    )) as { id: string };
    return created.id;
  };
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const answered = async (caseId: string): Promise<void> => {
    await submitReply(caseId, "yes");
    db.query("UPDATE cases SET created_at = ? WHERE id = ?").run(minutesAgo(6), caseId);
    db.query("UPDATE replies SET created_at = ? WHERE case_id = ?").run(minutesAgo(3), caseId);
  };

  const plain = await open("weekend-league", "main", false);
  const plainCase = await ask(plain, "Keep the long scroll?");
  await answered(plainCase);
  const nudgeable = await open("knock", "HAIL-76", true);
  const nudgeCase = await ask(nudgeable, "Ship the nudge as a button or as an automatic wake?");
  await answered(nudgeCase);

  db.close();
  console.log(`CASE_NUDGE=${nudgeCase}`);
  console.log(`CASE_PLAIN_FALLBACK=${plainCase}`);
  console.log("NUDGE_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  plain.close();
  nudgeable.close();
}

// HAIL-152 evidence: the incident. A case the operator answered, then the agent's closing note
// with done: true (with a markdown artifact), beside a normal ask that still needs the operator
// and an answered ask the agent has not picked up (to show Nudge still works for it).
// Prints CASE_DONE, CASE_NEEDS, CASE_QUEUED and DONE_READY=1, then stays up until SIGTERM.
async function doneUpdate(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const db = new Database(daemonPaths().db);
  db.exec("PRAGMA busy_timeout = 5000");
  const open = async (project: string, branch: string): Promise<{ client: DaemonClient; cwd: string }> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    await client.call(
      "session.hello",
      { session_id: randomUUID(), cwd, branch, git_root: null, parent_pid: process.pid },
      5000,
    );
    return { client, cwd };
  };
  const ask = async (client: DaemonClient, title: string): Promise<string> => {
    const created = (await client.call(
      "case.create",
      { kind: "question", title, need: `${title} Pick one.`, why: "Evidence for the done update.",
        recommendation: "yes", recommendation_why: "Simplest.",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      15000,
    )) as { id: string };
    return created.id;
  };
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  const done = await open("waggle", "main");
  const doneCase = await ask(done.client, "Ship the Cell W rebrand of waggle.so?");
  await submitReply(doneCase, "yes");
  db.query("UPDATE cases SET created_at = ? WHERE id = ?").run(minutesAgo(12), doneCase);
  db.query("UPDATE replies SET created_at = ?, state = 'delivered', delivered_at = ? WHERE case_id = ?")
    .run(minutesAgo(9), minutesAgo(9), doneCase);
  // One waggle_update with done: true and an artifact: the conversation shows one message.
  await knockUpdateMarkdown(
    done.client, done.cwd, doneCase,
    "Done and live. Every cell is honey now, and the old palette is gone from the site.",
    "# Cell W rebrand\n\nShipped to production.\n\n- Every cell is honey now\n- The old palette is removed\n- Lighthouse score is unchanged\n",
    true,
  );

  const needs = await open("knock", "HAIL-152");
  const needsCase = await ask(needs.client, "Use done: true for every closing note?");
  const queued = await open("weekend-league", "main");
  const queuedCase = await ask(queued.client, "Keep the long scroll?");
  await submitReply(queuedCase, "yes");
  db.query("UPDATE cases SET created_at = ? WHERE id = ?").run(minutesAgo(6), queuedCase);
  db.query("UPDATE replies SET created_at = ? WHERE case_id = ?").run(minutesAgo(3), queuedCase);

  db.close();
  console.log(`CASE_DONE=${doneCase}`);
  console.log(`CASE_NEEDS=${needsCase}`);
  console.log(`CASE_QUEUED=${queuedCase}`);
  console.log("DONE_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  done.client.close();
  needs.client.close();
  queued.client.close();
}

// HAIL-81 evidence: "answered" has 12 answered asks (delivered, picked up over 10 minutes ago) and
// nothing pending, so it shows no count. "queued" has one reply not picked up yet, so it shows
// "1 waiting on it". Stays up until SIGTERM. Prints `WAITCOUNT_READY=1`.
async function waitCount(): Promise<void> {
  const clients: DaemonClient[] = [];
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const db = new Database(daemonPaths().db);
  db.exec("PRAGMA busy_timeout = 5000");
  const open = async (project: string, branch: string): Promise<DaemonClient> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    await client.call(
      "session.hello",
      { session_id: randomUUID(), cwd, branch, git_root: null, parent_pid: process.pid },
      5000,
    );
    clients.push(client);
    return client;
  };
  const ask = async (client: DaemonClient, title: string): Promise<string> => {
    const created = (await client.call(
      "case.create",
      { kind: "question", title, need: `${title} Pick one.`, why: "Evidence for the waiting count.",
        recommendation: "yes", recommendation_why: "Simplest.",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      15000,
    )) as { id: string };
    return created.id;
  };
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  const answeredSession = await open("answered-project", "main");
  for (let i = 0; i < 12; i++) {
    const id = await ask(answeredSession, `Answered question ${i + 1}?`);
    await ackReply(answeredSession, await submitReply(id, "yes"));
    const minutes = 20 + i * 3;
    db.query("UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?").run(at(minutes + 2), at(minutes), id);
    db.query("UPDATE replies SET created_at = ?, delivered_at = CASE WHEN state = 'delivered' THEN ? END WHERE case_id = ?")
      .run(at(minutes + 1), at(minutes), id);
  }
  const queued = await open("queued-project", "main");
  await submitReply(await ask(queued, "Onboarding flow: ready to ship?"), "yes");

  db.close();
  console.log("WAITCOUNT_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const client of clients) client.close();
}

// WAG-304 evidence: one ask with three questions. Question 1 has rich options (pros and cons), question 2 has
// string options, question 3 has two points. Prints CASE_STEPS.
async function steps(): Promise<void> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const cwd = join(mkdtempSync(join(tmpdir(), "knock-evidence-")), "steps");
  mkdirSync(cwd, { recursive: true });
  await client.call("session.hello", { session_id: randomUUID(), cwd, branch: "main", git_root: null, parent_pid: process.pid }, 5000);
  const created = (await client.call(
    "case.create",
    {
      kind: "question",
      title: "Flagged conversations inbox",
      need: "Three decisions to shape the flagged-conversations inbox before I build it.",
      why: "They change the screens I draw first.",
      recommendation: "x",
      recommendation_why: "none",
      questions: [
        {
          id: "layout",
          title: "How should the flagged list look?",
          points: [
            {
              id: "shape",
              text: "Which layout fits a support lead scanning 40 flags?",
              options: [
                { label: "Dense table", pros: ["See 40 flags at once", "Sort by any column"], cons: ["Hard to read on a small window"] },
                { label: "Cards with a preview", pros: ["Shows the first message"], cons: ["Five flags per screen", "More scrolling", "Hides the owner"] },
                { label: "Grouped by reason", pros: ["Matches how leads triage"] },
              ],
            },
          ],
        },
        {
          id: "who",
          title: "Who sees a flag first?",
          points: [{ id: "owner", text: "Who gets notified when a conversation is flagged?", options: ["The assigned agent", "The team lead", "Everyone on the team"] }],
        },
        {
          id: "clear",
          title: "When does a flag go away?",
          points: [
            { id: "auto", text: "Should a flag clear itself after a reply?", options: [{ label: "Yes, after the next reply", pros: ["Less clean-up"], cons: ["Can hide a real problem"] }, "No, a person clears it"] },
            { id: "history", text: "Keep cleared flags in a history?", options: ["Yes", "No"] },
          ],
        },
      ],
    },
    15000,
  )) as { id: string };
  console.log(`CASE_STEPS=${created.id}`);
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
}

// WAG-305 evidence: five asks for the one-composer captures. DECIDE (options, no artifact), REPLY (no options),
// STEPS (three questions, no artifact), WS_OPTS (options and a prototype: the workspace) and WS_QUESTIONS
// (three questions and a prototype: the workspace column). Prints CASE_<name>=<id>.
async function oneComposer(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const clients: DaemonClient[] = [];
  const create = async (name: string, params: Record<string, unknown>, withPrototype = false): Promise<void> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, name);
    mkdirSync(cwd, { recursive: true });
    await client.call("session.hello", { session_id: randomUUID(), cwd, branch: "main", git_root: null, parent_pid: process.pid }, 5000);
    let artifact: Artifact | undefined;
    if (withPrototype) {
      mkdirSync(join(cwd, "proto"), { recursive: true });
      writeFileSync(
        join(cwd, "proto", "index.html"),
        `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fdf4da;font:600 40px -apple-system;display:flex;align-items:center;justify-content:center;height:100vh">Flagged inbox, draft 1</body>`,
      );
      const staged = stageBundle({ dir: "proto", entry: "index.html", cwd, incomingDir: join(daemonPaths().home, "incoming") });
      artifact = { type: "html_bundle", dir: staged.path, entry: staged.entry };
    }
    const created = (await client.call("case.create", { kind: "question", ...params, ...(artifact ? { artifact } : {}) }, 15000)) as { id: string };
    console.log(`CASE_${name}=${created.id}`);
    clients.push(client);
  };
  const options = [
    { id: "flagged", title: "Flagged first", label: "Show flagged conversations at the top of the inbox" },
    { id: "newest", title: "Newest first", label: "Keep the list newest first and add a flag filter" },
    { id: "tab", title: "Separate tab", label: "Move flagged conversations to their own tab" },
  ];
  const decide = { title: "Where should flagged conversations go?", need: "Pick how the inbox shows flagged conversations.", why: "It changes the first screen I draw.", recommendation: "flagged", recommendation_why: "Support leads scan flags first.", options };
  const questions = [
    { id: "layout", title: "How should the flagged list look?", points: [{ id: "shape", text: "Which layout fits a lead scanning 40 flags?", options: [
      { label: "Dense table", pros: ["See 40 flags at once"], cons: ["Hard to read in a small window"] },
      { label: "Cards with a preview", pros: ["Shows the first message"], cons: ["Five flags per screen"] }] }] },
    { id: "who", title: "Who sees a flag first?", points: [{ id: "owner", text: "Who gets notified?", options: ["The assigned agent", "The team lead"] }] },
    { id: "clear", title: "When does a flag go away?", points: [{ id: "auto", text: "Should a flag clear after a reply?", options: ["Yes", "No"] }] },
  ];
  const multi = { title: "Flagged conversations inbox", need: "Three decisions to shape the inbox before I build it.", why: "They change the screens I draw first.", recommendation: "x", recommendation_why: "none", questions };
  await create("DECIDE", decide);
  await create("REPLY", { title: "How should we name the flag filter?", need: "Tell me what to call the flag filter.", why: "It shows in the inbox header.", recommendation: "Flagged", recommendation_why: "Short and plain." });
  await create("STEPS", multi);
  await create("WS_OPTS", decide, true);
  await create("WS_QUESTIONS", multi, true);
  console.log("ONE_COMPOSER_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const client of clients) client.close();
}

// HAIL-85 evidence: two questions with long options, one from a new agent (each option has a short
// title) and one from an old agent (no titles: the app derives them). Prints CASE_TITLED / CASE_OLD.
async function decision(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const clients: DaemonClient[] = [];
  const create = async (name: string, options: Array<{ id: string; label: string; title?: string }>): Promise<string> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, name);
    mkdirSync(cwd, { recursive: true });
    await client.call(
      "session.hello",
      { session_id: randomUUID(), cwd, branch: "main", git_root: null, parent_pid: process.pid },
      5000,
    );
    clients.push(client);
    const created = (await client.call(
      "case.create",
      {
        kind: "question",
        title: "Where should the design and the question live?",
        need: "Pick how the ask page and the review page fit together.",
        why: "Both work. They differ in how much the operator has to switch between views.",
        recommendation: "b",
        recommendation_why: "One page keeps the design and the answer in view together.",
        options,
      },
      15000,
    )) as { id: string };
    return created.id;
  };
  const full = [
    { id: "a", label: "Two pages: keep the ask page and the review page apart, and open the review page from a button on the ask page when the operator wants to look at the design." },
    { id: "b", label: "One page: the ask page itself becomes the split view (design left, question and answer right), so the operator never leaves the page while deciding." },
    { id: "c", label: "Something else: tell me in your own words how you want the two pages to work together, and I will follow that." },
  ];
  const titles = ["Two pages", "One page", "Something else"];
  console.log(`CASE_TITLED=${await create("titled", full.map((o, i) => ({ ...o, title: titles[i] })))}`);
  console.log(`CASE_OLD=${await create("old", full)}`);
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const client of clients) client.close();
}

// HAIL-99: one ask whose options have no agent title, one long, one with a colon.
async function decisionNoTitle(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const cwd = join(root, "notitle");
  mkdirSync(cwd, { recursive: true });
  await client.call("session.hello", { session_id: randomUUID(), cwd, branch: "main", git_root: null, parent_pid: process.pid }, 5000);
  const created = (await client.call(
    "case.create",
    {
      kind: "question",
      title: "Should the guide mention the HTML prototype path?",
      need: "Pick whether the guide points to rich prototypes.",
      why: "Plain HTML is simpler, but stateful prototypes need three fixes.",
      recommendation: "a",
      recommendation_why: "It keeps plain HTML as the default and still helps the rare rich case.",
      options: [
        { id: "a", label: "Mention it as an optional path for rich, stateful prototypes, with the three fixes written in; plain HTML stays the default" },
        { id: "b", label: "Leave it out: plain HTML is good enough for reviews" },
      ],
    },
    15000,
  )) as { id: string };
  console.log(`CASE_NOTITLE=${created.id}`);
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
}

// HAIL-84: one prototype ask, one text-only ask, then the screenshots asks of `shotSet`
// (a 3-screen set and a single desktop screenshot), for the one-page layout captures.
// HAIL-86: `answer` also answers the prototype ask (queued, "Not picked up yet"); `delivered`
// answers it and acks the reply as the shim does (the "Working" state).
async function onePage(answer?: string): Promise<void> {
  const proto = await connectedSession(process.pid);
  console.log(`CASE_PROTOTYPE=${proto.caseId}`);
  // `answer-old` and `delivered-old` move the send 14 minutes back (test-only, temp KNOCK_HOME),
  // for the long-timer captures (HAIL-86 fix).
  const kind = answer?.replace(/-old$/, "");
  if (kind === "answer" || kind === "delivered") {
    const replyId = await submitDetailReplyChoice(proto.caseId, "b", "Keep the header as it is.");
    console.log(`REPLY_PROTOTYPE=${replyId}`);
    if (kind === "delivered") await ackReply(proto.client, replyId);
    if (answer?.endsWith("-old")) {
      const db = new Database(daemonPaths().db);
      db.exec("PRAGMA busy_timeout = 5000");
      const at = new Date(Date.now() - 14 * 60_000 - 5_000).toISOString();
      db.query("UPDATE replies SET created_at = ?, delivered_at = CASE WHEN state = 'delivered' THEN ? END WHERE case_id = ?").run(at, at, proto.caseId);
      db.close();
    }
  }
  const text = await connectedSession(process.pid, DETAIL_QUESTION_FIXTURE);
  console.log(`CASE_TEXT=${text.caseId}`);
  await shotSet();
  proto.client.close();
  text.client.close();
}

// HAIL-94: an update with a long inline command (the operator's screenshot) and
// a plain message that is itself a command, in one thread.
async function copyCase(): Promise<void> {
  const session = await connectedSession(process.pid, {
    ...DETAIL_QUESTION_FIXTURE,
    title: "Ship the settings page redesign this sprint?",
    options: [{ id: "yes", label: "Ship it" }, { id: "no", label: "Slip it" }],
  });
  await submitReply(session.caseId, "yes");
  await new Promise((r) => setTimeout(r, 50));
  await session.client.call(
    "case.update",
    {
      case_id: session.caseId,
      message:
        "Done. To try it on your machine, run `cd apps/macos && swift build && KNOCK_HOME=/tmp/knock-try .build/debug/Waggle` and open the settings page. The short one is `bun test`.",
    },
    5000,
  );
  await new Promise((r) => setTimeout(r, 50));
  await session.client.call("case.update", { case_id: session.caseId, message: "git log --oneline -5 --decorate" }, 5000);
  console.log(`CASE_COPY=${session.caseId}`);
  console.log("COPY_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  session.client.close();
}

// HAIL-102 evidence: a session with a transcript (the session line) and a third ask. Two earlier asks
// are answered (a chosen option, a typed answer) and the second got an update. `text` makes the third
// ask a plain question, `prototype` gives it an html_bundle (the one page). Run with the sandbox HOME,
// since the transcript goes under $HOME/.claude/projects. Prints `CASE_THIRD=<id>`. Stays up until SIGTERM.
async function sessionAsks(kind: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "omea-research");
  mkdirSync(cwd, { recursive: true });
  const id = randomUUID();
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  await client.call("session.hello", { session_id: id, cwd, branch: "main", git_root: null, parent_pid: process.pid }, 5000);
  const projects = join(process.env.HOME!, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  writeFileSync(join(projects, `${id}.jsonl`), [
    JSON.stringify({ type: "user", turnOrigin: "human", timestamp: at(7200), message: { role: "user", content: "Build the research prototype for the What the research says page." } }),
    JSON.stringify({ type: "assistant", timestamp: at(20), message: { role: "assistant", content: [
      { type: "text", text: "Building the research prototype for the **What the research says** page. Wiring a real source for summaries, blocked on this choice." }] } }),
  ].join("\n") + "\n");

  const db = new Database(daemonPaths().db);
  db.exec("PRAGMA busy_timeout = 5000");
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const ask = async (title: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const created = (await client.call(
      "case.create",
      { kind: "question", title, need: `${title} Pick one.`, why: "Paperclip has full texts but needs a paid key; PubMed is free, abstracts only.",
        recommendation: "b", recommendation_why: "No key needed today; Paperclip drops in later behind the same interface.",
        options: [{ id: "a", title: "Use Paperclip", label: "Use Paperclip" }, { id: "b", title: "Start with PubMed", label: "Start with PubMed" }],
        ...extra },
      15000,
    )) as { id: string };
    return created.id;
  };
  const backdate = (caseId: string, created: number, replied: number): void => {
    db.query("UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?").run(ago(created), ago(replied), caseId);
    db.query("UPDATE replies SET created_at = ?, delivered_at = ? WHERE case_id = ?").run(ago(replied), ago(replied), caseId);
  };
  db.query("UPDATE sessions SET connected_at = ? WHERE id = ?").run(ago(125), id);
  const first = await ask("How long should each summary be?", {
    options: [{ id: "a", title: "Plain language, 3 lines", label: "Plain language, 3 lines at most" }, { id: "b", title: "Technical", label: "Technical" }] });
  await ackReply(client, await submitReply(first, "a"));
  backdate(first, 110, 108);
  const second = await ask("What should each study card show?", { options: undefined, recommendation: "Study size and year" });
  await ackReply(client, await submitReplyMessageOnly(second, "Show study size and year on each card"));
  backdate(second, 70, 55);
  await client.call("case.update", { case_id: second, message: "Search box and results page are done.\nNext: a real source for summaries." }, 5000);
  const at2 = ago(40);
  db.query("UPDATE messages SET created_at = ? WHERE case_id = ? AND role = 'agent'").run(at2, second);
  db.query("UPDATE cases SET updated_at = ? WHERE id = ?").run(at2, second);

  const artifact = kind.startsWith("prototype") ? await (async (): Promise<Artifact> => {
    const proto = join(cwd, "proto");
    mkdirSync(proto, { recursive: true });
    for (const [name, contents] of Object.entries(TEST_FIXTURE)) writeFileSync(join(proto, name), contents);
    const staged = stageBundle({ dir: "proto", entry: "index.html", cwd, incomingDir: join(daemonPaths().home, "incoming") });
    return { type: "html_bundle", dir: staged.path, entry: staged.entry };
  })() : undefined;
  const third = await ask("Use Paperclip or start with PubMed for the research prototype?", artifact ? { artifact } : {});
  console.log(`CASE_THIRD=${third}`);
  if (kind === "prototypeSettled") {
    // HAIL-106: the third ask is answered long ago and a follow-up ask exists, so the open ask shows
    // the session block and the settled "Picked up at" line together.
    await ackReply(client, await submitReply(third, "b"));
    // The two earlier asks move 20 h back, so the answered one is still the 3rd of its session.
    const shift = 20 * 60;
    db.query("UPDATE cases SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, ?) WHERE id IN (?, ?)").run(`-${shift} minutes`, `-${shift} minutes`, first, second);
    db.query("UPDATE replies SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?), delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at, ?) WHERE case_id IN (?, ?)").run(`-${shift} minutes`, `-${shift} minutes`, first, second);
    db.query("UPDATE messages SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?) WHERE case_id IN (?, ?)").run(`-${shift} minutes`, first, second);
    db.query("UPDATE sessions SET connected_at = ? WHERE id = ?").run(ago(shift + 130), id);
    backdate(third, 15 * 60 + 5, 15 * 60);
    const followUp = await ask("Which PubMed fields should the card show?", { follows: third });
    console.log(`CASE_FOLLOWUP=${followUp}`);
  }
  console.log("ASKS_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
  db.close();
}

// HAIL-107 evidence: an OME-537-like third ask in a session with two earlier asks, you replied with a
// question, and the agent answered with a long update. `kind`: `text` (update brings new options),
// `plain` (update without options: the reply leads, the decision card is dimmed), `prototype` (the
// same with an html_bundle, the one page), `fresh` (no reply yet, for the detail rows). Run with the
// sandbox HOME. Prints `CASE_THIRD=<id>`. Stays up until SIGTERM.
async function paneAsks(kind: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "omea-group");
  mkdirSync(cwd, { recursive: true });
  const id = randomUUID();
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  await client.call("session.hello", { session_id: id, cwd, branch: "main", git_root: null, parent_pid: process.pid }, 5000);
  const projects = join(process.env.HOME!, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  writeFileSync(join(projects, `${id}.jsonl`), [
    JSON.stringify({ type: "user", turnOrigin: "human", timestamp: at(3700), message: { role: "user", content: "Fix the weekly check-in flow on Today (OME-537)." } }),
    JSON.stringify({ type: "assistant", timestamp: at(20), message: { role: "assistant", content: [
      { type: "text", text: "Fixing the weekly check-in flow on Today for **OME-537**. Waiting on a product call about hiding the card." }] } }),
  ].join("\n") + "\n");

  const db = new Database(daemonPaths().db);
  db.exec("PRAGMA busy_timeout = 5000");
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const ask = async (title: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const created = (await client.call(
      "case.create",
      { kind: "question", title, need: `${title} Pick one.`, why: "It changes what members see on Today for a whole week; a product call.",
        recommendation: "a", recommendation_why: "Matches how the daily cards behave; the card comes back next Sunday.",
        options: [{ id: "a", title: "Approve", label: "Approve" }, { id: "b", title: "Not now", label: "Not now" }],
        ...extra },
      15000,
    )) as { id: string };
    return created.id;
  };
  const backdate = (caseId: string, created: number, replied: number): void => {
    db.query("UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?").run(ago(created), ago(replied), caseId);
    db.query("UPDATE replies SET created_at = ?, delivered_at = ? WHERE case_id = ?").run(ago(replied), ago(replied), caseId);
  };
  db.query("UPDATE sessions SET connected_at = ? WHERE id = ?").run(ago(62), id);
  const first = await ask("Keep the card on Today until it is done?");
  await ackReply(client, await submitReply(first, "a"));
  backdate(first, 58, 57);
  const second = await ask("Where should the weekly check-in screen ship?", { options: undefined, recommendation: "Behind the flag" });
  await ackReply(client, await submitReplyMessageOnly(second, "Ship it behind the flag"));
  backdate(second, 50, 41);
  await client.call("case.update", { case_id: second, message: "Weekly check-in screen ships behind the flag." }, 5000);
  db.query("UPDATE messages SET created_at = ? WHERE case_id = ? AND role = 'agent'").run(ago(40), second);

  const artifact = kind === "prototype" ? await (async (): Promise<Artifact> => {
    const proto = join(cwd, "proto");
    mkdirSync(proto, { recursive: true });
    for (const [name, contents] of Object.entries(TEST_FIXTURE)) writeFileSync(join(proto, name), contents);
    const staged = stageBundle({ dir: "proto", entry: "index.html", cwd, incomingDir: join(daemonPaths().home, "incoming") });
    return { type: "html_bundle", dir: staged.path, entry: staged.entry };
  })() : undefined;
  const third = await ask("OME-537: weekly check-in card disappears once done. Approve?", {
    need: "Approve the weekly check-in card hiding once this week is answered or skipped.",
    why: "It changes what members see on Today for a whole week; a product call.",
    recommendation: "a",
    recommendation_why: "Matches how the daily cards behave; the card comes back next Sunday.",
    options: [
      { id: "a", title: "Approve", label: "Hide the card once this week is answered or skipped; it comes back next Sunday." },
      { id: "b", title: "Approve, keep a skipped card", label: "Hide it once answered, but keep a small \"Skipped this week\" card on Today." },
      { id: "c", title: "Changes", label: "Tell me what to change before it ships." },
    ],
    ...(artifact ? { artifact } : {}),
  });
  console.log(`CASE_THIRD=${third}`);
  if (kind !== "fresh") {
    await ackReply(client, await submitReplyMessageOnly(third, "How we define skipped? When a weekly check-in become skipped?"));
    const update = [
      "\"Skipped\" only ever means the member tapped \"Skip this week\" on the weekly check-in screen. It never happens automatically.",
      "- **When:** the check-in week runs Sunday to Saturday on the phone's own clock. The card is due from that week's Sunday. If the member taps Skip, we record \"skipped\" for that week and save no answers. A skipped week stays separate from an unanswered one, so the trend never contains made-up data.",
      "- **If they do nothing:** nothing is recorded, and the card stays on Today all week. The next Sunday a new week starts and the card is due again, for the new week. The old week is simply left unanswered, not marked as skipped.",
    ].join("\n");
    await client.call("case.update", {
      case_id: third, message: update,
      ...(kind === "plain" ? {} : {
        options: [
          { id: "a", title: "Approve as is", label: "Hide the card once answered or skipped; an unanswered week stays visible." },
          { id: "x", title: "Approve, show skipped weeks", label: "Hide it once answered, but mark skipped weeks on the trend." },
        ],
        recommendation: "a",
        recommendation_why: "Skipped stays separate from unanswered, so the trend has no made-up data.",
      }),
    }, 5000);
    db.query("UPDATE cases SET created_at = ? WHERE id = ?").run(ago(35), third);
    db.query("UPDATE option_sets SET created_at = ? WHERE case_id = ? AND seq = 0").run(ago(35), third);
    db.query("UPDATE replies SET created_at = ?, delivered_at = ? WHERE case_id = ?").run(ago(31), ago(30.7), third);
    db.query("UPDATE messages SET created_at = ? WHERE case_id = ? AND role = 'agent'").run(ago(30), third);
    db.query("UPDATE option_sets SET created_at = ? WHERE case_id = ? AND seq > 0").run(ago(30), third);
  }
  console.log("ASKS_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
  db.close();
}

// HAIL-104: an old answered ask (picked up 15 h 23 m ago) with a follow-up ask, and a fresh one
// still working. Prints CASE_OLD, CASE_FOLLOWUP and CASE_FRESH, then stays up until SIGTERM.
async function settled(): Promise<void> {
  const db = new Database(daemonPaths().db);
  db.exec("PRAGMA busy_timeout = 5000");
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const open = async (project: string): Promise<DaemonClient> => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    await client.call("session.hello", { session_id: randomUUID(), cwd, branch: "main", git_root: null, parent_pid: process.pid }, 5000);
    return client;
  };
  const ask = async (client: DaemonClient, title: string, follows?: string): Promise<string> =>
    ((await client.call("case.create", { kind: "question", title, need: `${title} Pick one.`, why: "Evidence for HAIL-104.",
      recommendation: "yes", recommendation_why: "Simplest.", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      ...(follows ? { follows } : {}) }, 15000)) as { id: string }).id;
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const oldClient = await open("acme-docs");
  const old = await ask(oldClient, "Onboarding audit: when to fix the gaps?");
  await ackReply(oldClient, await submitReply(old, "yes"));
  const minutes = 15 * 60 + 23;
  db.query("UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?").run(at(minutes + 2), at(minutes), old);
  db.query("UPDATE replies SET created_at = ?, delivered_at = CASE WHEN state = 'delivered' THEN ? END WHERE case_id = ?").run(at(minutes + 1), at(minutes), old);
  const followUp = await ask(oldClient, "Onboarding audit: which gap first?", old);
  console.log(`CASE_OLD=${old}`);
  console.log(`CASE_FOLLOWUP=${followUp}`);
  const freshClient = await open("acme-api");
  const fresh = await ask(freshClient, "Change the button color?");
  await ackReply(freshClient, await submitReply(fresh, "yes"));
  db.query("UPDATE replies SET delivered_at = ? WHERE case_id = ?").run(at(3), fresh);
  console.log(`CASE_FRESH=${fresh}`);
  console.log("SETTLED_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  oldClient.close();
  freshClient.close();
}

// HAIL-106: two live sessions (one ask each) for the footer count across a daemon restart.
// Stays up until SIGTERM. Prints `CASE_ONE=<id>` and `TWO_SESSIONS_READY=1`.
async function twoSessions(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const clients: DaemonClient[] = [];
  const ids: string[] = [];
  let stopping = false;
  for (const [project, branch] of [["knock", "main"], ["omea-group", "main"]]) {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    const hello = { session_id: randomUUID(), cwd, branch, git_root: null, parent_pid: process.pid };
    await client.call("session.hello", hello, 5000);
    // Like the real shim (HAIL-63): when the daemon goes away, reconnect and say hello again.
    let live = client;
    const reconnect = (): void => {
      void (async () => {
        while (!stopping) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const next = new DaemonClient();
            await next.connect(daemonPaths().socket);
            await next.call("session.hello", hello, 5000);
            next.onClose = reconnect;
            live = next;
            clients.push(next);
            console.log(`RECONNECTED ${project}`);
            return;
          } catch { /* daemon not back yet */ }
        }
      })();
    };
    client.onClose = reconnect;
    void live;
    const created = (await client.call(
      "case.create",
      { kind: "question", title: `Ship ${project}?`, need: `Ship ${project}? Pick one.`, why: "Evidence for the footer.",
        recommendation: "yes", recommendation_why: "Simplest.",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      15000,
    )) as { id: string };
    ids.push(created.id);
    clients.push(client);
  }
  console.log(`CASE_ONE=${ids[0]}`);
  console.log("TWO_SESSIONS_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  stopping = true;
  for (const c of clients) c.close();
  process.exit(0);
}

// HAIL-110: a more_detail reply that carries a long question, left queued. The sent card says
// "YOU ASKED" with the question, and the thread bubble shows it in full.
async function detailQuestion(): Promise<void> {
  const session = await connectedSession(process.pid);
  await submitDetailReply(session.caseId, "What is a guide rule? I want to see an example before I pick.");
  console.log(`CASE_DETAIL_QUESTION=${session.caseId}`);
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  session.client.close();
}

// HAIL-139: a more_detail reply that names a format ("diagram"), left queued. The thread row
// says "Asked for more detail · as a diagram".
async function detailFormat(): Promise<void> {
  const session = await connectedSession(process.pid, DETAIL_QUESTION_FIXTURE);
  await submitDetailReply(session.caseId, undefined, "diagram");
  console.log(`CASE_DETAIL_FORMAT=${session.caseId}`);
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  session.client.close();
}

// HAIL-108: an ask whose update sends new options, one whose update sends none, and one with no
// update. The app shows the first as "Options from the update" (First options folded, or open
// with KNOCK_EVIDENCE_SHOW_FIRST_OPTIONS=1), the second with the reply field leading.
async function updateOptions(): Promise<void> {
  const db = new Database(daemonPaths().db);
  db.exec("PRAGMA busy_timeout = 5000");
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const base = {
    kind: "question" as const,
    title: "Group the optional details under a heading?",
    need: "Decide how the optional details on the sign-up form are grouped.",
    why: "The grey label alone reads like another field label.",
    recommendation: "a",
    recommendation_why: "A heading is the smallest change that fixes the confusion.",
    options: [
      { id: "a", title: "Heading only", label: "Add an OPTIONAL DETAILS heading above the optional fields" },
      { id: "b", title: "Heading and divider", label: "Add the heading and a thin divider above it" },
      { id: "c", title: "Something else", label: "Tell me in your own words" },
    ],
  };
  // Moves creation, reply and update back in time so the times read like a real afternoon.
  const backdate = (caseId: string, created: number, reply: number, update: number | null): void => {
    db.query("UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?").run(ago(created), ago(update ?? reply), caseId);
    db.query("UPDATE option_sets SET created_at = ? WHERE case_id = ? AND seq = 0").run(ago(created), caseId);
    db.query("UPDATE replies SET created_at = ?, delivered_at = ? WHERE case_id = ?").run(ago(reply), ago(reply - 0.5), caseId);
    if (update !== null) {
      db.query("UPDATE messages SET created_at = ? WHERE case_id = ? AND role = 'agent'").run(ago(update), caseId);
      db.query("UPDATE option_sets SET created_at = ? WHERE case_id = ? AND seq > 0").run(ago(update), caseId);
    }
  };

  const withOptions = await connectedSession(process.pid, base);
  const r1 = await submitReply(withOptions.caseId, "c");
  await ackReply(withOptions.client, r1);
  await new Promise((r) => setTimeout(r, 50));
  await withOptions.client.call(
    "case.update",
    {
      case_id: withOptions.caseId,
      message: "Agreed: in grey at that size it reads like another field label. New proposal: group the details under a heading, and pin the Save button to the bottom.",
      options: [
        { id: "a", title: "Both together", label: "Heading and a pinned Save button in one change" },
        { id: "x", title: "Heading first", label: "Ship the heading now, the pinned button in a follow-up" },
      ],
      recommendation: "a",
      recommendation_why: "One review, and the two changes depend on each other.",
    },
    5000,
  );
  backdate(withOptions.caseId, 19, 12, 6);
  console.log(`CASE_UPD_OPTIONS=${withOptions.caseId}`);

  const plain = await connectedSession(process.pid, { ...base, title: "Group the optional details under a heading? (no new options)" });
  const r2 = await submitReply(plain.caseId, "c");
  await ackReply(plain.client, r2);
  await new Promise((r) => setTimeout(r, 50));
  await plain.client.call(
    "case.update",
    { case_id: plain.caseId, message: "Agreed: in grey at that size it reads like another field label. Go for both the heading and the pinned Save button, or the heading only? Reply in your own words." },
    5000,
  );
  backdate(plain.caseId, 19, 12, 6);
  console.log(`CASE_UPD_PLAIN=${plain.caseId}`);

  const original = await connectedSession(process.pid, { ...base, title: "Group the optional details under a heading? (no update)" });
  console.log(`CASE_UPD_NONE=${original.caseId}`);
  console.log("UPDATE_OPTIONS_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const c of [withOptions, plain, original]) c.client.close();
}

// HAIL-114: an open ask gets a new revision that reuses the SAME file names with different
// images. `arg` is screenshots | screenshot | bundle. Prints CASE_REVISION=<id>, waits for
// SIGUSR1 (sent after the app shows revision 1), then sends the update and prints UPDATED=1.
async function revisionUpdate(kind: string): Promise<void> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "Waggle");
  mkdirSync(join(cwd, "shots"), { recursive: true });
  const incomingDir = join(daemonPaths().home, "incoming");
  const names = ["home.png", "list.png", "detail.png"];
  const writeRevision = (rgbs: [number, number, number][]): void => {
    names.forEach((name, i) => writeFileSync(join(cwd, "shots", name), landmarkPng(390, 844, rgbs[i]!)));
  };
  const v1: [number, number, number][] = [[0xe7, 0xec, 0xfd], [0xe7, 0xec, 0xfd], [0xe7, 0xec, 0xfd]];
  const v2: [number, number, number][] = [[0xfc, 0xdc, 0xc4], [0xfc, 0xdc, 0xc4], [0xfc, 0xdc, 0xc4]];
  const bundle = (color: string, label: string): void => {
    mkdirSync(join(cwd, "proto"), { recursive: true });
    writeFileSync(
      join(cwd, "proto", "index.html"),
      `<!doctype html><meta charset="utf-8"><body style="margin:0;background:${color};font:600 48px -apple-system;display:flex;align-items:center;justify-content:center;height:100vh">${label}</body>`,
    );
  };
  const artifactFor = (rgbs: [number, number, number][], color: string, label: string): Artifact => {
    if (kind === "markdown") {
      const text = `# ${label}\n\nThis is the **${label}** write-up, with a short list:\n\n- first point\n- second point\n`;
      writeFileSync(join(cwd, "explain.md"), text);
      const staged = stageMarkdown({ path: "./explain.md", cwd, incomingDir });
      return { type: "markdown", path: staged.path };
    }
    if (kind === "bundle") {
      bundle(color, label);
      const staged = stageBundle({ dir: "proto", entry: "index.html", cwd, incomingDir });
      return { type: "html_bundle", dir: staged.path, entry: staged.entry };
    }
    writeRevision(rgbs);
    if (kind === "screenshot" || kind === "commented") {
      const one = stageScreenshot({ path: join("shots", "home.png"), cwd, incomingDir });
      return { type: "screenshot", path: one.path };
    }
    const staged = stageScreenshots({
      items: names.map((name) => ({ path: join("shots", name), caption: name })),
      cwd,
      incomingDir,
    });
    return { type: "screenshots", items: staged.items };
  };
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: process.pid },
    5000,
  );
  const created = (await client.call(
    "case.create",
    { ...SCREENSHOTS_FIXTURE, title: "Add a dashed line to the chart?", artifact: artifactFor(v1, "#e7ecfd", "Revision 1 (blue)") },
    15000,
  )) as { id: string };
  console.log(`CASE_REVISION=${created.id}`);
  await new Promise<void>((resolve) => process.on("SIGUSR1", () => resolve()));
  if (kind === "commented") {
    // HAIL-142: v1 carries one comment, so "See v1" has a capture with a pin to show.
    const replyId = await submitReplyWithComment(created.id, "ship", landmarkPng(120, 260, [0xe7, 0xec, 0xfd]).toString("base64"));
    await ackReply(client, replyId);
    await new Promise((r) => setTimeout(r, 50));
  }
  if (kind === "noArtifact") {
    // HAIL-146: a message and new options, no artifact: the stage keeps v1 and says so.
    await client.call(
      "case.update",
      {
        case_id: created.id,
        message: "Rewrote only the last beat.",
        options: [
          { id: "x", title: "Dashed line", label: "Add the dashed line" },
          { id: "y", title: "No line", label: "Leave the chart as it is" },
        ],
        recommendation: "x",
      },
      15000,
    );
  } else {
    await client.call(
      "case.update",
      { case_id: created.id, message: "Added the dashed line.", artifact: artifactFor(v2, "#fcdcc4", "Revision 2 (orange)") },
      15000,
    );
  }
  console.log("UPDATED=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
}

// HAIL-117 evidence: the caught-up screen's "Right now" list. Five live sessions, nothing needs the
// operator: working after an answer, working with no asks, writing, idle after an answer (older than
// 10 minutes) and idle with no asks. Run with the sandbox HOME: session titles come from fake
// transcripts under $HOME/.claude/projects. Prints `CAUGHT_UP_READY=1`. Test-only backdating of the
// temp KNOCK_HOME's own knock.db. `caughtUp zero` opens no session.
async function caughtUp(mode?: string): Promise<void> {
  const clients: DaemonClient[] = [];
  if (mode === "zero") {
    console.log("CAUGHT_UP_READY=1");
    await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const db = new Database(daemonPaths().db);
  db.exec("PRAGMA busy_timeout = 5000");
  const open = async (project: string, branch: string, title: string | null, said?: string) => {
    const client = new DaemonClient();
    await client.connect(daemonPaths().socket);
    const cwd = join(root, project);
    mkdirSync(cwd, { recursive: true });
    const id = randomUUID();
    if (title) {
      const dir = join(process.env.HOME!, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const at = new Date().toISOString();
      writeFileSync(
        join(dir, `${id}.jsonl`),
        [
          JSON.stringify({ type: "user", turnOrigin: "human", timestamp: at, message: { role: "user", content: title } }),
          JSON.stringify({ type: "ai-title", aiTitle: title }),
          // HAIL-119: the agent's last message must not become the session summary.
          ...(said ? [JSON.stringify({ type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: said }] } })] : []),
        ].join("\n") + "\n",
      );
    }
    await client.call("session.hello", { session_id: id, cwd, branch, git_root: null, parent_pid: process.pid, runtime: "claude" }, 5000);
    clients.push(client);
    return client;
  };
  const ask = async (client: DaemonClient, title: string, options: { id: string; label: string; title?: string }[]): Promise<string> => {
    const created = (await client.call(
      "case.create",
      { kind: "question", title, need: `${title} Pick one.`, why: "Evidence for the caught-up list.",
        recommendation: options[0]!.id, recommendation_why: "Simplest.", options },
      15000,
    )) as { id: string };
    return created.id;
  };
  const backdate = (caseId: string, minutes: number): void => {
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    db.query("UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?").run(at(minutes + 2), at(minutes), caseId);
    db.query("UPDATE replies SET created_at = ?, delivered_at = CASE WHEN state = 'delivered' THEN ? END WHERE case_id = ?")
      .run(at(minutes + 1), at(minutes), caseId);
  };
  const yesNo = [{ id: "approve", label: "Approve, show skipped weeks on the trend", title: "Approve, show skipped weeks" }, { id: "no", label: "No" }];

  const a = await open("omea-group", "main", "Fixing the weekly check-in flow on Today (OME-537)", "0.1.44 is out (build 47): https://example.com/releases/0.1.44");
  // HAIL-119: two earlier asks today, for the expanded row.
  const earlier2 = await ask(a, "Where should the weekly check-in screen ship?", [{ id: "flag", label: "Ship it behind the flag", title: "Ship it behind the flag" }, { id: "now", label: "Now" }]);
  await ackReply(a, await submitReply(earlier2, "flag"));
  backdate(earlier2, 150);
  const earlier1 = await ask(a, "OME-537: same ask, before the update", yesNo);
  await ackReply(a, await submitReply(earlier1, "approve"));
  backdate(earlier1, 70);
  console.log(`CASE_EARLIER=${earlier1}`);
  const working = await ask(a, "Weekly check-in: how to show skipped weeks?", yesNo);
  await ackReply(a, await submitReply(working, "approve"));
  backdate(working, 4);

  await open("knock", "story/HAIL-115", "Settings > Agents says Not installed while connected");

  const c = await open("gym-os", "main", "Weight and calorie chart in one view");
  const writing = await ask(c, "Chart: one axis or two?", yesNo);
  await ackReply(c, await submitDetailReply(writing, "Dashed calorie line, weight stays the hero"));
  backdate(writing, 1);

  const d = await open("health-avatar", "main", "Avatar onboarding copy");
  const idle = await ask(d, "Tone of the avatar copy?", [{ id: "playful", label: "Keep it playful", title: "Keep it playful" }, { id: "plain", label: "Plain" }]);
  await ackReply(d, await submitReply(idle, "playful"));
  backdate(idle, 38);

  // HAIL-121: a session whose only asks are from yesterday ("no asks today").
  const league = await open("weekend-league", "main", "Fixture list for the weekend league");
  for (const [n, title, minutes] of [[1, "Show the league table by points or by goal difference?", 26 * 60], [2, "Name the new fixture list screen?", 27 * 60]] as const) {
    const old = await ask(league, title, [{ id: "pts", label: "By points", title: "By points" }, { id: "gd", label: "By goal difference" }]);
    await ackReply(league, await submitReply(old, "pts"));
    backdate(old, minutes);
    console.log(`CASE_OLDER_${n}=${old}`);
  }

  db.close();
  console.log("CAUGHT_UP_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const client of clients) client.close();
}

// HAIL-124 evidence: a headless fleet session (no ai-title; brief with a heading, a fence and an
// `Objective:` line) whose transcript is still growing. `home` has no ask (Working, "busy, no asks yet",
// doing-now line). `card` has one open ask, for the Context card. Run with the sandbox HOME.
async function headlessBusy(mode: string): Promise<void> {
  const clients: DaemonClient[] = [];
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const id = randomUUID();
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const cwd = join(root, "HAIL-123");
  mkdirSync(cwd, { recursive: true });
  await client.call("session.hello", { session_id: id, cwd, branch: "HAIL-123", git_root: null, parent_pid: process.pid, runtime: "claude" }, 5000);
  clients.push(client);
  const dir = join(process.env.HOME!, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  const brief = ["# HAIL-123: multi-select", "", "```", "cd apps/macos", "```", "", "Objective: Agents can send \"pick several\" asks; the operator ticks options and sends them together.", "", "More detail follows."].join("\n");
  const asst = (secondsAgo: number, blocks: object[]) =>
    JSON.stringify({ type: "assistant", timestamp: at(secondsAgo), message: { role: "assistant", content: blocks } });
  const lines = [
    JSON.stringify({ type: "user", turnOrigin: "human", timestamp: at(1200), message: { role: "user", content: brief } }),
    asst(60, [{ type: "tool_use", name: "Edit", input: { file_path: "/x/AppModel.swift" } }]),
    asst(20, [{ type: "tool_use", name: "Bash", input: { command: "swift test", description: "Ran swift test" } }]),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  if (mode === "card") {
    const created = (await client.call(
      "case.create",
      { kind: "question", title: "Tick several or one at a time?", need: "Tick several?", why: "Evidence.",
        recommendation: "yes", recommendation_why: "Simplest.",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      15000,
    )) as { id: string };
    console.log(`CASE_ID=${created.id}`);
  }
  console.log("HEADLESS_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const c of clients) c.close();
}

// HAIL-123: "pick several" asks. Three cases for the window captures: pick any (two ticked), pick up
// to 2 (at the limit), and a sent answer with two choices.
const MULTI_OPTIONS = [
  { id: "a", title: "Fix the pinned Save button", label: "It slides under the keyboard on small phones." },
  { id: "b", title: "Add an empty state", label: "New members see a blank list on day one." },
  { id: "c", title: "Shorten the onboarding copy", label: "Step 2 is 4 lines; aim for 2." },
  { id: "d", title: "Dark mode for the chart", label: "Grid lines vanish on dark." },
  { id: "e", title: "Haptic on check-in", label: "A light tap when the week is done." },
];
const MULTI_ASK = {
  kind: "question" as const,
  title: "Which fixes ship in this release?",
  need: "Pick the fixes to ship today; the rest go to next week.",
  why: "Each fix is small, but together they push the release past 5 pm.",
  recommendation: ["a", "b"],
  recommendation_why: "The first two block new members; the rest can wait.",
  select: "many" as const,
  options: MULTI_OPTIONS,
};

async function multiSelect(): Promise<void> {
  const make = async (fixture: Record<string, unknown>) => connectedSession(process.pid, fixture);
  const any = await make(MULTI_ASK);
  console.log(`CASE_MULTI_ANY=${any.caseId}`);
  const limit = await make({ ...MULTI_ASK, title: "Which two fixes ship in this release?", max: 2 });
  console.log(`CASE_MULTI_LIMIT=${limit.caseId}`);
  const sent = await make({ ...MULTI_ASK, title: "Which fixes ship? (sent)", max: 3 });
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  await client.call(
    "reply.submit",
    { case_id: sent.caseId, idempotency_key: randomUUID(), choices: ["a", "c"], message: "Skip the empty state for now.", comments: [], captures: [] },
    5000,
  );
  client.close();
  console.log(`CASE_MULTI_SENT=${sent.caseId}`);
  // A review ask: its split workspace shows the "You picked" card once the answer is sent.
  const review = await make({ ...MULTI_ASK, kind: "review", title: "Which fixes ship? (review)", max: 3 });
  const reviewClient = new DaemonClient();
  await reviewClient.connect(daemonPaths().socket);
  await reviewClient.call(
    "reply.submit",
    { case_id: review.caseId, idempotency_key: randomUUID(), choices: ["a", "c"], message: "Skip the empty state for now.", comments: [], captures: [] },
    5000,
  );
  reviewClient.close();
  console.log(`CASE_MULTI_REVIEW_SENT=${review.caseId}`);
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  for (const c of [any, limit, sent, review]) c.client.close();
}

// HAIL-123: the MCP round trip a fake shim makes: waggle_ask with select "many" (case.create), the
// human's reply with choices, then the text waggle_check returns (case.wait). Writes a log file.
async function multiSelectRoundTrip(logPath: string): Promise<void> {
  const lines: string[] = [];
  const log = (label: string, value: unknown): void => {
    lines.push(`${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
  };
  const agent = new DaemonClient();
  await agent.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "fake-shim");
  mkdirSync(cwd, { recursive: true });
  await agent.call("session.hello", { session_id: randomUUID(), cwd, branch: "main", git_root: null, parent_pid: process.pid }, 5000);
  const ask = { ...MULTI_ASK, max: 2 };
  log("waggle_ask (case.create) request", ask);
  const created = (await agent.call("case.create", ask, 15000)) as Record<string, unknown>;
  log("case.create result (select, max, recommendation, recommendations)", {
    id: created.id, select: created.select, max: created.max, recommendation: created.recommendation, recommendations: created.recommendations,
  });
  const bad = async (label: string, params: Record<string, unknown>): Promise<void> => {
    const c = new DaemonClient();
    await c.connect(daemonPaths().socket);
    try {
      await c.call("reply.submit", { case_id: created.id, idempotency_key: randomUUID(), comments: [], captures: [], ...params }, 5000);
      log(label, "ACCEPTED (unexpected)");
    } catch (err) {
      log(label, `rejected: ${(err as Error).message}`);
    }
    c.close();
  };
  await bad("reply.submit choices over max (a, b, c; max 2)", { choices: ["a", "b", "c"] });
  await bad("reply.submit choice not offered (a, zzz)", { choices: ["a", "zzz"] });
  await bad("reply.submit zero choices without a message", { choices: [] });
  const human = new DaemonClient();
  await human.connect(daemonPaths().socket);
  const params = { case_id: created.id, idempotency_key: randomUUID(), choices: ["a", "c"], message: "Skip the empty state for now.", comments: [], captures: [] };
  log("reply.submit request (the app's Send 2)", params);
  const reply = (await human.call("reply.submit", params, 5000)) as { id: string };
  human.close();
  const waited = await agent.call("case.wait", { case_id: created.id, wait_ms: 5000 }, 10000);
  log("waggle_check result (case.wait)", waited as Record<string, unknown>);
  const none = await (async () => {
    const c2 = (await agent.call("case.create", { ...ask, title: "Which fixes ship? (none)" }, 15000)) as { id: string };
    const h = new DaemonClient();
    await h.connect(daemonPaths().socket);
    await h.call("reply.submit", { case_id: c2.id, idempotency_key: randomUUID(), choices: [], message: "None of these. Ship nothing today.", comments: [], captures: [] }, 5000);
    h.close();
    return agent.call("case.wait", { case_id: c2.id, wait_ms: 5000 }, 10000);
  })();
  log("waggle_check result for zero choices with a message", none as Record<string, unknown>);
  agent.close();
  writeFileSync(logPath, lines.join("\n"));
  console.log(`ROUND_TRIP_LOG=${logPath} reply=${reply.id}`);
}

// HAIL-150: a markdown explanation (a long essay draft) for text comments. `markdownEssay` opens the
// ask and waits; `markdownRoundTrip <log>` also submits a reply with two text comments, as the app
// sends it, and logs what the agent gets back from `waggle_check` (case.wait).
const ESSAY = [
  "# Why we should keep the inbox small",
  "",
  "An inbox that **grows without limit** is a to-do list that nobody trusts. People stop opening it, and the one message that mattered sits at the bottom with the rest. The fix is not a better filter. The fix is to say *no* earlier, and to say it where the work starts.",
  "",
  "## What the design asks for",
  "",
  "Three rules keep the list short:",
  "",
  "- Every ask has **one** question, written as the question itself.",
  "- An ask that the repo or the tests can answer is never sent. The agent reads `docs/` first.",
  "- A reply closes the ask. A new ask needs a new reason.",
  "",
  "These rules sound strict. They are also cheap to follow, because the agent already knows the answer to most questions before it asks them.",
  "",
  "## What it costs",
  "",
  "The cost is a slower first draft. The agent holds a question for a minute, checks the code, and sometimes decides alone. That is the point: *a held question is a saved interruption*.",
  "",
  "In the pilot, the median ask took 40 seconds to read and 9 seconds to answer. The longest ones were reviews with a screenshot, and those are worth the time.",
  "",
  "### A note on tone",
  "",
  "Write the ask the way you would speak to a colleague who is busy. Give the **recommendation first**, then the reason. Use `waggle_update` when the answer changes the plan, not when it only adds detail.",
].join("\n");

async function markdownEssay(roundTripLog?: string): Promise<void> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "Waggle");
  mkdirSync(cwd, { recursive: true });
  const incomingDir = join(daemonPaths().home, "incoming");
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: process.pid },
    5000,
  );
  writeFileSync(join(cwd, "essay.md"), ESSAY);
  const staged = stageMarkdown({ path: "./essay.md", cwd, incomingDir });
  const created = (await client.call(
    "case.create",
    {
      kind: "review" as const,
      title: "Is the inbox essay ready to publish?",
      need: "Read the draft and say if it ships. Comment on any passage that needs work.",
      why: "It is the first public write-up of the inbox rules.",
      recommendation: "ship",
      recommendation_why: "The argument is short and the rules are concrete.",
      options: [
        { id: "ship", label: "Ship it" },
        { id: "rework", label: "Rework the weak passages" },
      ],
      artifact: { type: "markdown", path: staged.path },
    },
    15000,
  )) as { id: string };
  console.log(`CASE_ESSAY=${created.id}`);
  if (!roundTripLog) {
    await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
    client.close();
    return;
  }
  const at = (phrase: string): { quote: string; start: number; end: number } => {
    const start = ESSAY.indexOf(phrase);
    if (start < 0) throw new Error(`phrase not in essay: ${phrase}`);
    return { quote: phrase, start, end: start + phrase.length };
  };
  const long = "An inbox that **grows without limit** is a to-do list that nobody trusts. People stop opening it, and the one message that mattered sits at the bottom with the rest.";
  const comments = [
    { id: randomUUID(), n: 1, text: "Too absolute. Say what grows.", anchor: { kind: "text", revision: 1, ...at("grows without limit") } },
    { id: randomUUID(), n: 2, text: "Cut this sentence.", anchor: { kind: "text", revision: 1, ...at(long) } },
    { id: randomUUID(), n: 3, text: "Is 40 seconds from the pilot data?", anchor: { kind: "text", revision: 1, ...at("the median ask took 40 seconds to read") } },
  ];
  const human = new DaemonClient();
  await human.connect(daemonPaths().socket);
  const params = { case_id: created.id, idempotency_key: randomUUID(), choice: "rework", message: "Three passages need work.", comments, captures: [] };
  const reply = (await human.call("reply.submit", params, 5000)) as { id: string };
  human.close();
  const waited = await client.call("case.wait", { case_id: created.id, wait_ms: 5000 }, 10000);
  writeFileSync(
    roundTripLog,
    `reply.submit request (comments as the app sends them)\n${JSON.stringify(params, null, 2)}\n\nknock_check result (case.wait)\n${JSON.stringify(waited, null, 2)}\n`,
  );
  console.log(`ROUND_TRIP_LOG=${roundTripLog} reply=${reply.id}`);
}

// HAIL-151: a plan ask walked through its stages, like an agent doing a brainstorm. One case,
// markdown artifact per round, every earlier round answered the way the Mac would (a reply).
//   planAsk <questions|approaches|design|spec>   stops with that round waiting on the human
//   planAsk all                                  walks every stage, PLAN_STEP_MS (default 4000) apart
// With the plan case there are 3 other asks, so the queue shows the plan row among 4 rows. Prints
// CASE_PLAN=<id> and each stage as it opens, then waits for SIGTERM (the session stays live).
type PlanStageName = "questions" | "approaches" | "design" | "spec";

const PLAN_ASK_OTHERS = [
  {
    kind: "question" as const,
    title: "Ship build 0.9 to the pilot group?",
    need: "Tests pass. One open bug, in settings.",
    why: "It is a release call, not a technical one.",
    recommendation: "yes",
    recommendation_why: "The bug has a workaround and the pilot group is small.",
  },
  {
    kind: "review" as const,
    title: "Agent guidance v2: copy pen.dev and Decode?",
    need: "Pick how far to take Waggle's agent guidance.",
    why: "Both meet the spec. One costs a week more.",
    recommendation: "a",
    recommendation_why: "The smaller change fixes the confusion.",
    options: [
      { id: "a", title: "Copy the pattern", label: "Copy the pen.dev pattern only" },
      { id: "b", title: "Copy both", label: "Copy pen.dev and Decode" },
    ],
  },
  {
    kind: "question" as const,
    title: "Checkout: one page or two steps?",
    need: "Pick the layout to ship.",
    why: "A product call on how much to show up front.",
    recommendation: "a",
    recommendation_why: "One page has the shorter path.",
    options: [
      { id: "a", title: "One page", label: "One page with everything" },
      { id: "b", title: "Two steps", label: "Two steps, address then payment" },
    ],
  },
];

const PLAN_CONTEXT_MD = [
  "# Brainstorm: weekly brand posts",
  "",
  "## Goal",
  "",
  "Post to Instagram and TikTok every week for negozio, with less work for you. The agent drafts and queues. You stay in charge of what goes live.",
  "",
  "## What I found",
  "",
  "- Your brand voice file says: warm, plain, no hype.",
  "- Last 4 weeks: 5 posts a week, Instagram and TikTok.",
  "- Buffer is connected. Posting is manual today.",
  "- The spring range has 12 new items to feature.",
  "",
  "## Decided so far",
  "",
  "- The agent drafts and queues. You publish.",
  "- You approve in Waggle, once a week.",
  "",
  "Next up: how it picks the themes each week.",
].join("\n");

const PLAN_APPROACHES_MD = [
  "# Three ways to run it",
  "",
  "## A. A weekly run",
  "",
  "A schedule starts Claude Code every Monday. It reads the voice file and the last 4 weeks, then drafts 5 posts. **Least to maintain.**",
  "",
  "## B. A watcher",
  "",
  "A small service posts as soon as stock changes. More moving parts, and it needs a server.",
  "",
  "## C. A manual trigger",
  "",
  "You start it from the terminal when you want posts. No schedule, so it is easy to forget.",
].join("\n");

function planDesignMd(section: number): string {
  const titles = ["Architecture", "Weekly flow", "If something fails"];
  const bodies = [
    "The weekly run has four parts. Nothing is published by the agent.\n\n- A schedule starts Claude Code in the negozio folder every Monday at 09:00.\n- The agent reads the voice file and the last 4 weeks, then drafts 5 posts.\n- It sends ONE plan ask to Waggle. You approve it once.\n- Approved posts become drafts in Buffer. You press publish.",
    "Monday 09:00 the run starts. By 09:10 you have one ask in Waggle with the five drafts. You approve, change or skip each one.",
    "If Buffer is down, the drafts wait in a file and the next run picks them up. If you do not answer by Friday, nothing posts and the agent tells you.",
  ];
  return `# ${titles[section - 1]}\n\n${bodies[section - 1]}\n\nSection ${section} of 3.`;
}

const PLAN_SPEC_MD = [
  "# Weekly brand posts: spec",
  "",
  "## Purpose",
  "",
  "Draft five posts a week for negozio. The operator approves once, then presses publish in Buffer.",
  "",
  "## Parts",
  "",
  "1. A Monday 09:00 schedule that starts Claude Code.",
  "2. A drafting step that reads the voice file and the last 4 weeks.",
  "3. One Waggle plan ask for the weekly approval.",
  "4. A Buffer draft per approved post.",
  "",
  "## Out of scope",
  "",
  "- Posting without a human press.",
  "- Any channel except Instagram and TikTok.",
].join("\n");

async function planAsk(arg: string | undefined): Promise<void> {
  const target = (arg ?? "questions") as PlanStageName | "all";
  const pause = Number(process.env.PLAN_STEP_MS ?? 4000);
  for (const [i, other] of PLAN_ASK_OTHERS.entries()) {
    const made = await connectedSession(process.pid, other);
    console.log(`CASE_OTHER_${i + 1}=${made.caseId}`);
  }
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "negozio");
  mkdirSync(cwd, { recursive: true });
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "brainstorm", git_root: null, parent_pid: process.pid },
    5000,
  );
  const md = (text: string): Artifact => {
    writeFileSync(join(cwd, "plan.md"), text);
    const staged = stageMarkdown({ path: "./plan.md", cwd, incomingDir: join(daemonPaths().home, "incoming") });
    return { type: "markdown", path: staged.path };
  };
  const opt = (id: string, title: string, label: string) => ({ id, title, label });
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const questions = [
    {
      q: "How should it pick the themes each week?",
      options: [
        opt("arrivals", "From the new arrivals", "Features whatever stock landed that week"),
        opt("best", "From last week's best posts", "Repeats what already worked"),
        opt("monday", "I give a theme every Monday", "You write one line. The agent does the rest"),
      ],
      rec: "arrivals",
      why: "New arrivals change every week, so there is always something fresh to post. It needs nothing from you.",
    },
    {
      q: "Where should the drafts wait for your approval?",
      options: [
        opt("knock", "In Waggle", "One ask a week, with all five drafts"),
        opt("buffer", "In Buffer", "Drafts sit in Buffer until you open it"),
      ],
      rec: "knock",
      why: "You already answer asks in Waggle, so it is one place to look.",
    },
    {
      q: "Which channels come first?",
      options: [
        opt("both", "Instagram and TikTok", "Both, as you do today"),
        opt("ig", "Instagram only", "Start small, add TikTok later"),
      ],
      rec: "both",
      why: "It matches your current routine, so nothing changes for your followers.",
    },
  ];
  const stageOf = (name: PlanStageName, step?: number, total?: number, estimate?: boolean) => ({
    name,
    ...(step !== undefined ? { step } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(estimate ? { total_is_estimate: true } : {}),
  });

  let caseId = "";
  const open = async (
    stage: ReturnType<typeof stageOf>,
    question: string,
    options: { id: string; title: string; label: string }[],
    rec: string,
    why: string,
    artifact: Artifact,
  ): Promise<void> => {
    if (caseId === "") {
      const created = (await client.call(
        "case.create",
        {
          kind: "plan",
          stage,
          title: "Brainstorm: weekly brand posts",
          need: question,
          why: "It decides how the agent plans the week.",
          recommendation: rec,
          recommendation_why: why,
          options,
          artifact,
        },
        15000,
      )) as { id: string };
      caseId = created.id;
      console.log(`CASE_PLAN=${caseId}`);
    } else {
      await client.call(
        "case.update",
        { case_id: caseId, message: question, stage, options, recommendation: rec, recommendation_why: why, artifact },
        15000,
      );
    }
    console.log(`PLAN_STAGE=${stage.name}${stage.step ? ` step ${stage.step}` : ""}`);
  };
  const answer = async (choice: string): Promise<void> => {
    await wait(40);
    await submitReply(caseId, choice);
    await wait(40);
  };
  const reached = (name: PlanStageName): boolean => target === name;

  // Questions: three rounds. The human takes the second option on question 2.
  const picks = ["arrivals", "buffer", "both"];
  for (const [i, q] of questions.entries()) {
    await open(stageOf("questions", i + 1, 5, true), q.q, q.options, q.rec, q.why, md(PLAN_CONTEXT_MD));
    if (reached("questions") && i === questions.length - 1) break;
    if (target === "all") await wait(pause);
    await answer(picks[i]!);
  }
  if (!reached("questions")) {
    await open(
      stageOf("approaches"),
      "Which approach fits best?",
      [
        opt("weekly", "A weekly run", "A schedule starts Claude Code every Monday"),
        opt("watcher", "A watcher", "A small service posts when stock changes"),
        opt("manual", "A manual trigger", "You start it from the terminal"),
      ],
      "weekly",
      "It is the least to maintain, and it matches how you work today.",
      md(PLAN_APPROACHES_MD),
    );
    if (target === "all") await wait(pause);
  }
  if (!reached("questions") && !reached("approaches")) {
    await answer("weekly");
    for (const section of [1, 2, 3]) {
      await open(
        stageOf("design", section, 3),
        "Does this section look right?",
        [opt("ok", "Looks right", "Approve this section and show the next one")],
        "ok",
        "It matches every answer so far.",
        md(planDesignMd(section)),
      );
      if (reached("design") && section === 1) break;
      if (target === "all") await wait(pause);
      if (section < 3 || target === "spec" || target === "all") await answer("ok");
    }
  }
  if (target === "spec" || target === "all") {
    await open(
      stageOf("spec"),
      "The spec is ready for your review.",
      [opt("approve", "Approve and start planning", "Approve the spec and write the implementation plan")],
      "approve",
      "Every design section was approved.",
      md(PLAN_SPEC_MD),
    );
  }
  console.log("PLAN_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
}

// HAIL-156: a plan ask whose rounds each carry another artifact type, walked like an agent would.
//   planAsk mixed-questions   round 1: screenshots (a visual choice)
//   planAsk mixed-approaches  round 2: html_bundle (a prototype of the layout)
//   planAsk mixed-design      round 3: diagram (an architecture section)
//   planAsk mixed-spec        round 4: markdown (the spec); also the base of the history shots
// Earlier rounds are answered the way the Mac would (a reply). The plan stops with the named round open.
async function planAskMixed(target: string): Promise<void> {
  const want = target.replace("mixed-", "") as PlanStageName;
  for (const [i, other] of PLAN_ASK_OTHERS.entries()) {
    const made = await connectedSession(process.pid, other);
    console.log(`CASE_OTHER_${i + 1}=${made.caseId}`);
  }
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const root = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  const cwd = join(root, "negozio");
  const incomingDir = join(daemonPaths().home, "incoming");
  mkdirSync(join(cwd, "shots"), { recursive: true });
  mkdirSync(join(cwd, "proto"), { recursive: true });
  const looks: { name: string; caption: string; rgb: [number, number, number] }[] = [
    { name: "warm.png", caption: "A · Warm and personal", rgb: [0xfc, 0xee, 0xc4] },
    { name: "clean.png", caption: "B · Clean and bright", rgb: [0xe7, 0xec, 0xfd] },
    { name: "bold.png", caption: "C · Bold and dark", rgb: [0xd9, 0xd9, 0xe0] },
  ];
  for (const look of looks) writeFileSync(join(cwd, "shots", look.name), landmarkPng(390, 844, look.rgb));
  writeFileSync(
    join(cwd, "proto", "index.html"),
    `<!doctype html><meta charset="utf-8"><style>
body{font:16px system-ui;margin:0;background:#faf8f4;color:#222}header{padding:24px 32px;font-weight:700;font-size:20px}
.hero{padding:48px 32px;background:#f2e6d0}.hero h1{margin:0 0 8px;font-size:34px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:32px}.card{background:#fff;border:1px solid #e3dccd;border-radius:12px;padding:20px}
button{background:#2f6fed;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px}</style>
<header>negozio</header><section class="hero"><h1>New this week</h1><p>The spring range, picked for you.</p><button onclick="this.textContent='Added'">Shop the range</button></section>
<section class="grid"><div class="card"><h3>Linen shirt</h3><p>Soft, light, plain.</p></div><div class="card"><h3>Canvas tote</h3><p>Holds the week.</p></div><div class="card"><h3>Clay mug</h3><p>Made by hand.</p></div></section>`,
  );
  writeFileSync(
    join(cwd, "arch.mmd"),
    [
      "flowchart LR",
      "    S[Monday 09:00 schedule] --> A[Claude Code run]",
      "    A --> V[Read voice file]",
      "    A --> H[Read last 4 weeks]",
      "    V --> D[Draft 5 posts]",
      "    H --> D",
      "    D --> K{{Waggle plan ask}}",
      "    K -- approved --> B[Buffer drafts]",
      "    B --> P[You press publish]",
    ].join("\n"),
  );
  writeFileSync(join(cwd, "plan.md"), PLAN_SPEC_MD);
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "brainstorm", git_root: null, parent_pid: process.pid },
    5000,
  );
  const opt = (id: string, title: string, label: string) => ({ id, title, label });
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let caseId = "";
  const round = async (
    stage: { name: PlanStageName; step?: number; total?: number; total_is_estimate?: boolean },
    question: string,
    options: { id: string; title: string; label: string }[],
    rec: string,
    why: string,
    artifact: Artifact,
  ): Promise<void> => {
    if (caseId === "") {
      const created = (await client.call(
        "case.create",
        {
          kind: "plan",
          stage,
          title: "Brainstorm: weekly brand posts",
          need: question,
          why: "It decides how the agent plans the week.",
          recommendation: rec,
          recommendation_why: why,
          options,
          artifact,
        },
        15000,
      )) as { id: string };
      caseId = created.id;
      console.log(`CASE_PLAN=${caseId}`);
    } else {
      await client.call(
        "case.update",
        { case_id: caseId, message: question, stage, options, recommendation: rec, recommendation_why: why, artifact },
        15000,
      );
    }
    console.log(`PLAN_STAGE=${stage.name}`);
  };
  const answer = async (choice: string): Promise<void> => {
    await wait(40);
    await submitReply(caseId, choice);
    await wait(40);
  };

  const shots = stageScreenshots({
    items: looks.map((l) => ({ path: join("shots", l.name), caption: l.caption })),
    cwd,
    incomingDir,
  });
  await round(
    { name: "questions", step: 1, total: 3, total_is_estimate: true },
    "Which look fits the posts best?",
    [
      opt("warm", "Warm and personal", "Soft colours, hand-made feel"),
      opt("clean", "Clean and bright", "White space, one accent colour"),
      opt("bold", "Bold and dark", "High contrast, big type"),
    ],
    "warm",
    "It matches your brand voice file: warm, plain, no hype.",
    { type: "screenshots", items: shots.items },
  );
  if (want !== "questions") {
    await answer("warm");
    const bundle = stageBundle({ dir: "proto", entry: "index.html", cwd, incomingDir });
    await round(
      { name: "approaches" },
      "Which layout do you want for the weekly page?",
      [
        opt("hero", "Hero first", "One big picture, then the cards"),
        opt("cards", "Cards only", "No hero, just the cards"),
      ],
      "hero",
      "The hero gives each week one clear message. Try the prototype.",
      { type: "html_bundle", dir: bundle.path, entry: bundle.entry },
    );
  }
  if (want === "design" || want === "spec") {
    await answer("hero");
    const diagram = stageDiagram({ path: "arch.mmd", cwd, incomingDir });
    await round(
      { name: "design", step: 1, total: 2 },
      "Design, section 1 of 2: how the weekly run works. Does it look right?",
      [opt("ok", "Looks right", "Approve this section and show the next one")],
      "ok",
      "It matches every answer so far.",
      { type: "diagram", path: diagram.path },
    );
  }
  if (want === "spec") {
    await answer("ok");
    const md = stageMarkdown({ path: "plan.md", cwd, incomingDir });
    await round(
      { name: "spec" },
      "The spec is ready for your review.",
      [opt("approve", "Approve and start planning", "Approve the spec and write the implementation plan")],
      "approve",
      "Every design section was approved.",
      { type: "markdown", path: md.path },
    );
  }
  console.log("PLAN_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
}

// WAG-410: an open question whose agent session already ended (no reply yet).
async function endedAsk(): Promise<void> {
  const ended = await connectedSession(deadPid(), DETAIL_QUESTION_FIXTURE);
  ended.client.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log(`CASE_ENDED_ASK=${ended.caseId}`);
}

// WAG-410 pass 2: an answered question whose agent session ended, so its reply is failed. The app's
// "Continue in a new session" then marks that reply handed over.
async function endedAnswered(): Promise<void> {
  const ended = await connectedSession(deadPid(), {
    ...DETAIL_QUESTION_FIXTURE,
    options: [{ id: "yes", label: "Ship it" }, { id: "no", label: "Slip it" }],
  });
  ended.client.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const replyId = await submitReply(ended.caseId, "yes");
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log(`CASE_ENDED_ANSWERED=${ended.caseId}`);
  console.log(`REPLY_ENDED_ANSWERED=${replyId}`);
}

// WAG-418: a case that carries `matched_case_ids`. Two decided asks, then a similar ask: held once, then sent again.
async function pastDecisions(): Promise<void> {
  const client = new DaemonClient();
  await client.connect(daemonPaths().socket);
  const cwd = mkdtempSync(join(tmpdir(), "knock-evidence-"));
  await client.call(
    "session.hello",
    { session_id: randomUUID(), cwd, branch: "Waggle test", git_root: null, parent_pid: process.pid },
    5000,
  );
  const options = [
    { id: "a", label: "A · parseRow" },
    { id: "b", label: "B · readRow" },
  ];
  const base = { kind: "question" as const, why: "Both read well.", recommendation: "a", recommendation_why: "It matches the other helpers.", options };
  for (const title of ["Name the helper that parses a table row", "What to name the helper that parses a table row"]) {
    const made = (await client.call("case.create", { ...base, title, need: "Pick one name." }, 15000)) as { id: string };
    await client.call(
      "reply.submit",
      { case_id: made.id, idempotency_key: randomUUID(), choice: "a", intent: "decision", comments: [], captures: [] },
      5000,
    );
    console.log(`CASE_DECIDED=${made.id}`);
  }
  const ask = { ...base, title: "Name the helper that parses a table row", need: "Pick one name for the new helper.", accepts_hold: true };
  const first = (await client.call("case.create", ask, 15000)) as { held?: boolean };
  console.log(`FIRST_HELD=${first.held === true}`);
  const second = (await client.call("case.create", ask, 15000)) as { id: string; matched_case_ids?: string[] };
  console.log(`CASE_MATCHED=${second.id}`);
  console.log(`MATCHED_IDS=${(second.matched_case_ids ?? []).join(",")}`);
  console.log("PAST_READY=1");
  await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  client.close();
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "headlessBusy") {
  await headlessBusy(arg ?? "home");
} else if (cmd === "setup") {
  await setup();
} else if (cmd === "endedAnswered") {
  await endedAnswered();
} else if (cmd === "endedAsk") {
  await endedAsk();
} else if (cmd === "diagram") {
  await diagram();
} else if (cmd === "reproBundle") {
  await reproBundle(arg ?? "");
} else if (cmd === "caughtUp") {
  await caughtUp(arg);
} else if (cmd === "sessions") {
  await sessions();
} else if (cmd === "waitCount") {
  await waitCount();
} else if (cmd === "sessionContext") {
  await sessionContext();
} else if (cmd === "paneAsks") {
  await paneAsks(arg ?? "text");
} else if (cmd === "sessionAsks") {
  await sessionAsks(arg ?? "text");
} else if (cmd === "manySessions") {
  await manySessions();
} else if (cmd === "answered") {
  await answered(arg === "compact" || arg === "slim", arg === "slim");
} else if (cmd === "twoSessions") {
  await twoSessions();
} else if (cmd === "settled") {
  await settled();
} else if (cmd === "copyCase") {
  await copyCase();
} else if (cmd === "updates") {
  await updates();
} else if (cmd === "orbs") {
  await orbs(Number(arg ?? 0));
} else if (cmd === "gridPage") {
  await gridPage();
} else if (cmd === "tallPage") {
  await tallPage();
} else if (cmd === "twoTabs") {
  await twoTabs();
} else if (cmd === "previews") {
  await previews();
} else if (cmd === "bigBundles") {
  await bigBundles();
} else if (cmd === "timeoutFallback") {
  await timeoutFallback();
} else if (cmd === "onePage") {
  await onePage(arg);
} else if (cmd === "shotSet") {
  await shotSet();
} else if (cmd === "variantSet") {
  await variantSet();
} else if (cmd === "decision") {
  await decision();
} else if (cmd === "decisionNoTitle") {
  await decisionNoTitle();
} else if (cmd === "steps") {
  await steps();
} else if (cmd === "oneComposer") {
  await oneComposer();
} else if (cmd === "detailQuestion") {
  await detailQuestion();
} else if (cmd === "detailFormat") {
  await detailFormat();
} else if (cmd === "markdownEssay") {
  await markdownEssay(arg);
} else if (cmd === "compareDemo") {
  await compareDemo(arg ?? "screenshot");
} else if (cmd === "revisionUpdate") {
  await revisionUpdate(arg ?? "screenshots");
} else if (cmd === "updateOptions") {
  await updateOptions();
} else if (cmd === "multiSelect") {
  await multiSelect();
} else if (cmd === "multiSelectRoundTrip" && arg) {
  await multiSelectRoundTrip(arg);
} else if (cmd === "planAsk") {
  if (arg?.startsWith("mixed-")) await planAskMixed(arg);
  else await planAsk(arg);
} else if (cmd === "pastDecisions") {
  await pastDecisions();
} else if (cmd === "nudge") {
  await nudge();
} else if (cmd === "doneUpdate") {
  await doneUpdate();
} else if (cmd === "replace" && arg) {
  await replace(arg);
} else {
  console.error("usage: evidence-harness.ts setup | steps | diagram | reproBundle <dir> | caughtUp [zero] | tallPage | previews | sessions | sessionContext | sessionAsks [text|prototype] | paneAsks [text|plain|prototype|fresh] | manySessions | waitCount | updates | answered | orbs [extra] | bigBundles | timeoutFallback | shotSet | variantSet | onePage | pastDecisions | nudge | doneUpdate | decision | detailQuestion | detailFormat | updateOptions | multiSelect | multiSelectRoundTrip <log path> | compareDemo [screenshot|screenshots|first] | revisionUpdate [screenshots|screenshot|bundle|markdown|commented|noArtifact] | replace <reply_id> | planAsk <questions|approaches|design|spec|all|mixed-questions|mixed-approaches|mixed-design|mixed-spec>");
  process.exit(2);
}
