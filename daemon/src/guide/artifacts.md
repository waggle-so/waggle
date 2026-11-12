# Choosing and building an artifact

Attach an artifact whenever the human needs to read more than a few sentences or see something.
Pick the type by what you are showing:

- markdown: reasoning, a written comparison, or a plan.
- html_bundle: a prototype, a chart, a visual comparison, or a visual plan.
- screenshot: one image of something that already exists.
- screenshots: 2 to 12 images the human should flip through and comment on one at a time - a
  multi-step flow, before/after states, or several screens of the same feature.
- diagram: a flow or a structure with more than 3 parts (a .mmd Mermaid file or a .svg).

## Name your artifacts: tabs and linked options

Give an artifact a `name` (1 to 40 characters, for example "Flow diagram"). Every artifact type
accepts it. Rules:

- Revisions with the same `name` are versions of one artifact. The decision page shows the newest.
- Revisions with no name group by kind (all markdown together, all diagrams together).
- A new name or a new kind is a new artifact. The decision page shows one tab for each artifact.
  To add a tab, send `waggle_update` with an artifact that has a new name.
- A markdown artifact shows as text in its tab.
- A new version of the same artifact keeps the same `name`, so it becomes a version and not a new tab.
  Do not put a version number in the `name`. Waggle numbers the versions for you.
  Waggle folds a trailing version word ("v2", "rev 2", "version 3") into the artifact, but do not rely on it.
  The page shows the artifacts of the round on screen, and earlier rounds keep their own.

Link an option to an artifact. When the human selects the option, Waggle switches to that tab.

- `artifact_ref` on the option is the `name` of the artifact. Waggle compares it without case and
  without spaces at the ends.
- `anchor` on the option points to a place inside an HTML artifact. In your HTML, mark the place
  with `id="step-2"` or `data-waggle-anchor="step-2"`. Waggle scrolls to it and highlights it.
- A page can also react itself. Waggle sends the page this message:
  `window.addEventListener("message", (e) => { if (e.data && e.data.type === "waggle:anchor") { /* e.data.anchor */ } })`.
  The page has no network and cannot send anything back.
- With several decisions, give the options of each decision `artifact_ref` (and `anchor`). The
  artifact then follows the decision on screen. For a `screenshots` set, `anchor` is the image
  number (from 1) or its caption: Waggle flips the set to that image.

Copyable example:

    waggle_ask({
      title: "Which checkout flow?",
      need: "Which checkout flow do we build?",
      why: "It sets the first screen.",
      options: [
        { id: "one", title: "One page", label: "One page with all fields",
          pros: ["Fastest for the buyer"], cons: ["Long form on a phone"],
          artifact_ref: "Flow diagram", anchor: "one-page" },
        { id: "steps", title: "Three steps", label: "Three short steps",
          pros: ["Short screens"], cons: ["More taps"],
          effects: ["Touches the checkout form and the cart", "Needs a progress bar"],
          artifact_ref: "Flow diagram", anchor: "three-steps" }
      ],
      recommendation: "steps",
      recommendation_why: "Short screens work better on a phone.",
      artifact: { type: "html_bundle", name: "Flow diagram", dir: "./proto/flow", entry: "index.html" }
    })

In `proto/flow/index.html`, write `<section id="one-page">` and `<section data-waggle-anchor="three-steps">`.

## Updating an artifact

When you answer a reply with waggle_update, the human keeps seeing the artifact from your last
revision. If the update changes something the artifact shows (copy, layout, a picture), send a new
artifact with it. An update with only a message keeps the old artifact on screen.

WRONG
    Change the sentences in your options and send waggle_update with only a message.
right
    Send waggle_update with the new screenshots, prototype, diagram or markdown as `artifact`.

## Diagram

Attach a diagram when the explanation has more than 3 parts or a flow. A diagram is one `.mmd`
(Mermaid source) or `.svg` file, at most 512 KB. Waggle renders it offline in the review viewer
with zoom, pan and comments, so the human can look at the parts and pin notes on them.

Draw a clean diagram with the waggle-diagram skill. It keeps 9 nodes and 12 arrows at most, uses right-angle connectors only, and takes colours and fonts from the project's design system. Send a `.svg` as a `diagram` artifact when the person needs the drawing alone. Send an `html_bundle` with `tokens.css` and a preview when a title, a legend or cards around the drawing carry meaning. With no design system, use a neutral style and say so in the ask.

Use Mermaid when the diagram is a flow or a structure that reads better from a small source:

    flowchart TD
        A[Open ask] --> B[Build]
        B --> C[Review]
        C --> D{Approved?}
        D -- yes --> E[Ship]
        D -- no --> B

Stage it by writing the file into your working tree, then pass its path:

    artifact: { type: "diagram", path: "./notes/review-flow.mmd" }

Use `.svg` when you already have the drawing as a file. Waggle shows it as is after sanitising it.

WRONG
    Explain a six-step flow in prose when a diagram would show the order at a glance.
right
    Attach a .mmd flowchart, or a .svg you already have, and keep the prose for the tradeoffs.

## screenshot vs screenshots vs an html_bundle gallery

- One image, nothing to step through: screenshot.
- Several images, each its own thing to look at and comment on in order (a signup flow, three
  states of the same screen): screenshots. The human sees one image at a time with a thumbnail
  strip and moves with the arrow keys; a comment always belongs to the image it was placed on.
- Several images laid out together as one interactive page, or with your own commentary and
  layout around them (a side-by-side comparison, an annotated collage): html_bundle. Build the
  page yourself; the human sees it as one artifact, not a sequence.

WRONG
    Stitch 5 screenshots into one tall image and attach it as a single screenshot.
right
    Attach the 5 images as a screenshots artifact, one per screen, so each gets its own comments.

WRONG
    Put a 500-word comparison of three approaches directly in why.
right
    Keep why to one sentence and attach a markdown artifact with the comparison.

## Markdown template

Use this skeleton for a write-up or a plan:

    # <the question, restated>

    ## Recommendation
    <one paragraph>

    ## Options considered
    - **<option>**: <tradeoff>
    - **<option>**: <tradeoff>

    ## Why this matters now
    <one paragraph>

Stage it by writing the file into your working tree, then pass its path:

    artifact: { type: "markdown", path: "./notes/checkout-layout.md" }

## HTML plan or comparison page

A self-contained html_bundle page: inline CSS, no network requests, no external fonts or scripts,
readable at 640px wide (the preview pane is narrow). One index.html is enough for a single
comparison; add more files only for real assets, such as a screenshot.

    <!doctype html>
    <html>
    <head>
    <meta charset="utf-8">
    <style>
      body { font: 14px/1.5 -apple-system, sans-serif; max-width: 640px; margin: 24px; color: #222; }
      h1 { font-size: 18px; }
      table { border-collapse: collapse; width: 100%; }
      td, th { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; }
    </style>
    </head>
    <body>
      <h1>Checkout layout: compact or detailed?</h1>
      <table>
        <tr><th>Option</th><th>Pro</th><th>Con</th></tr>
        <tr><td>Compact</td><td>Fewer fields</td><td>Two extra taps for shipping</td></tr>
        <tr><td>Detailed</td><td>Everything on one screen</td><td>Longer scroll</td></tr>
      </table>
    </body>
    </html>

WRONG
    Load a chart library from a CDN, or embed a script src pointing at a URL.
right
    Draw the chart with inline SVG or plain CSS bars. The preview allows no network access.

## Decision pages: five patterns for a 640 px pane

Patterns adapted from visualize by careerhackeralex (MIT).

Copy a pattern, change the words and numbers, keep the rest. Each one is inline CSS and inline SVG
only: no network, no script, no web font. Every page starts with this shared token block:

    <style>
      :root { --bg:#fafafa; --surface:#fff; --border:#ddd; --text:#1a1a1a; --muted:#595959;
              --accent:#2f6fed; --good:#1a7f37; --bad:#c62828; }
      body { font:14px/1.5 -apple-system,sans-serif; background:var(--bg); color:var(--text);
             max-width:640px; margin:24px; }
      h1 { font-size:18px; margin:0 0 16px; }
    </style>

Restraint rules:

- One accent colour. Use it for the one thing you recommend.
- No decoration that carries no meaning: no gradients, glows, shadows, animation or emoji.
- Text 14 px or larger, including text inside SVG.
- Lead with the takeaway: the title says what to decide or what the data shows.
- Label everything: axes, units, options, captions. Write values on the bars.
- Readable without colour: pair every colour with a word, a mark or a shape.

### 1. Options side by side, recommendation marked

    <h1>Checkout layout: compact or detailed?</h1>
    <style>
      .cards { display:flex; gap:12px; flex-wrap:wrap; }
      .card { flex:1 1 260px; background:var(--surface); border:1px solid var(--border);
              border-radius:8px; padding:14px; }
      .card.rec { border:2px solid var(--accent); }
      .tag { color:var(--accent); font-weight:600; }
      .card h2 { font-size:15px; margin:0 0 6px; }
      .trade { color:var(--muted); margin:8px 0 0; }
    </style>
    <div class="cards">
      <div class="card rec"><h2>Compact <span class="tag">Recommended</span></h2>
        <p>Fewer fields on one screen.</p><p class="trade">Tradeoff: two extra taps for shipping.</p></div>
      <div class="card"><h2>Detailed</h2>
        <p>Everything on one screen.</p><p class="trade">Tradeoff: a longer scroll.</p></div>
    </div>

### 2. Before / after

    <h1>The error message now says what to fix</h1>
    <style>
      .pair { display:flex; gap:12px; flex-wrap:wrap; }
      .pane { flex:1 1 260px; background:var(--surface); border:1px solid var(--border);
              border-radius:8px; padding:14px; }
      .pane h2 { font-size:14px; color:var(--muted); margin:0 0 8px; }
      del { color:var(--bad); }
      ins { color:var(--good); font-weight:600; }
    </style>
    <div class="pair">
      <div class="pane"><h2>Before</h2><p><del>Something went wrong.</del></p></div>
      <div class="pane"><h2>After</h2><p><ins>Card number is 15 digits. Enter 16.</ins></p></div>
    </div>
    <p>Changed text is struck through (before) or bold and underlined (after), so colour is not needed.</p>

### 3. Trade-off grid

Marks are relative within each column: mark the best value good, the worst bad, and leave the
others plain. Never mark every row good.

    <h1>B wins on cost and risk; A wins on speed</h1>
    <style>
      table { border-collapse:collapse; width:100%; background:var(--surface); }
      th, td { border:1px solid var(--border); padding:8px 10px; text-align:left; }
      .good { color:var(--good); font-weight:600; }
      .bad { color:var(--bad); font-weight:600; }
    </style>
    <table>
      <tr><th>Option</th><th>Speed</th><th>Cost</th><th>Risk</th></tr>
      <tr><td>A: rewrite</td><td class="good">&#10003; Good: 2 days</td>
        <td class="bad">&#10007; Bad: $4k</td><td class="bad">&#10007; Bad: new bugs</td></tr>
      <tr><td>B: patch (recommended)</td><td class="bad">&#10007; Bad: 5 days</td>
        <td class="good">&#10003; Good: $1k</td><td class="good">&#10003; Good: small diff</td></tr>
      <tr><td>C: hybrid</td><td>3 days</td><td>$2k</td><td>some new bugs</td></tr>
    </table>

WRONG
    Every cell in the Conversion column marked "Good" because each value looks fine alone.
right
    Compare within the column: best "Good", worst "Bad", the rest plain values with no mark.

### 4. Bar chart in inline SVG

    <h1>Caching cuts page load from 820 ms to 190 ms</h1>
    <p style="color:var(--muted);margin:0 0 8px">p95 page load (ms), lower is better</p>
    <svg viewBox="0 0 600 230" width="100%" role="img" aria-label="Page load p95: 820, 310 and 190 ms"
         font-family="-apple-system,sans-serif" font-size="14">
      <line x1="40" y1="200" x2="600" y2="200" stroke="#ddd"/>
      <rect x="70" y="40" width="120" height="160" fill="#595959"/>
      <rect x="240" y="140" width="120" height="60" fill="#595959"/>
      <rect x="410" y="163" width="120" height="37" fill="#2f6fed"/>
      <g text-anchor="middle" font-weight="600" fill="#1a1a1a">
        <text x="130" y="32">820 ms</text><text x="300" y="132">310 ms</text><text x="470" y="155">190 ms</text>
      </g>
      <g text-anchor="middle" fill="#1a1a1a">
        <text x="130" y="222">Today</text><text x="300" y="222">Cache</text><text x="470" y="222">Cache + index</text>
      </g>
    </svg>

Keep the subtitle outside the SVG. Scale the bars yourself: height = value x one fixed factor, from
one shared baseline, so the tallest bar ends at least 28 px below the SVG top and its value label
fits above it. For a line, use a `<polyline>` with a dot and a written value at each point.

### 5. Flow or timeline

    <h1>A push reaches the phone in four steps</h1>
    <svg viewBox="0 0 600 90" width="100%" role="img" aria-label="Client, API, queue, phone"
         font-family="-apple-system,sans-serif" font-size="14">
      <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8"
        orient="auto"><path d="M0 0L10 5L0 10z" fill="#595959"/></marker></defs>
      <g fill="#fff" stroke="#ddd"><rect x="0" y="20" width="120" height="50" rx="8"/>
        <rect x="160" y="20" width="120" height="50" rx="8"/><rect x="320" y="20" width="120" height="50" rx="8"/>
        <rect x="480" y="20" width="120" height="50" rx="8" stroke="#2f6fed" stroke-width="2"/></g>
      <g stroke="#595959" stroke-width="2" marker-end="url(#a)"><line x1="122" y1="45" x2="158" y2="45"/>
        <line x1="282" y1="45" x2="318" y2="45"/><line x1="442" y1="45" x2="478" y2="45"/></g>
      <g text-anchor="middle" fill="#1a1a1a"><text x="60" y="50">1 Client</text><text x="220" y="50">2 API</text>
        <text x="380" y="50">3 Queue</text><text x="540" y="50">4 Phone</text></g>
    </svg>

WRONG
    A page with a gradient hero, a glow on the best option, and green vs red as the only signal.
right
    Plain surfaces, one accent on the recommendation, and a word or mark next to every colour.

Use one or two patterns per page, the ones that carry the decision. Do not stack all five. Keep
the page short.

WRONG
    Cards + chart + grid that repeat the same three facts.
right
    Cards with the tradeoff line, plus the one chart that shows the trend.

## Design helpers (optional)

If the impeccable skill is available, use it at these moments. New prototype: run `shape` first, then build. A variant from the person's comments: apply them, then run `polish`.
Before you send an artifact in waggle_ask or waggle_update: run `critique` and `audit`, then fix the findings. Maintaining a prototype: run `harden`. Without impeccable, use the waggle-prototype skill's checklist at the same moments.

Build a prototype in the project's own design system. Before you build, find its colours, type, radii and spacing in the repo (start in the folder of the project the screen belongs to), put them in one `tokens.css` in the bundle, and say the source in one line: "Uses your design system: <path> (N colours, N fonts)". With nothing found, use a neutral style and say "No design system found; neutral style." The waggle-prototype skill has the search steps. Do not commit the `.waggle/design-tokens.json` cache.

## Designed it in Pen? Send HTML, not a PNG

If this guide ends with a "This project's design kit" section, design in the Pen file it names and follow its brand values. If it has no such section, do nothing extra.

Designed it in Pen? Export the frames with Pen's HTML export (Export(..., 'html-css', '<dir>/index.html')) and send them as an html_bundle, not a PNG: the person can zoom, select text and comment on parts. Pen's export links fonts from the network, which the sandbox blocks: before waggle_ask, run the script from waggle_guide topic "bundle-fonts" on the bundle folder so the fonts stay.

## Staging a screenshots artifact

Pass the images in the order the human should flip through them, each with an optional caption:

    artifact: {
      type: "screenshots",
      items: [
        { path: "./shots/1-signup.png", caption: "Signup" },
        { path: "./shots/2-verify.png", caption: "Verify email" },
        { path: "./shots/3-welcome.png", caption: "Welcome" },
      ],
    }

2 to 12 items. Each path is staged and validated exactly like a single screenshot (PNG or JPEG,
max 20 MB). A caption is optional per item; skip it when the image speaks for itself.

In a request with several decisions, give each image `item`: the id of the decision item it belongs
to. While that decision is on screen, Waggle shows only its images, counted inside the decision
("1 / 3"), and opens its first image. An image with no `item` shows with every decision:

    items: [
      { path: "./shots/a1.png", caption: "Ring, idle", item: "ring" },
      { path: "./shots/a2.png", caption: "Ring, tapped", item: "ring" },
      { path: "./shots/b1.png", caption: "Badge", item: "badge" },
      { path: "./shots/legend.png", caption: "Legend" },
    ]

With no `item`, Waggle reads a caption that starts with a number ("2. Badge") or a letter and a
number ("b1 Badge") as the decision (1 or a1 is the first decision, 2 or b1 the second). A caption
that starts with a lone letter ("B · Badge") names a variant, not a decision. Prefer `item`.

## Variants of an html_bundle in a multi-question ask

A waggle_ask can carry items with a group (see waggle_guide topic "writing-an-ask"). Give one html_bundle as the
ask's artifact and show every question in it. Waggle shows the bundle inside each question's section:

- Waggle opens the bundle at `#<question id>`. Read `location.hash` when the page loads and show
  that question's screen.
- A question may list `variants` ([{ id, label }]). When the person picks one, Waggle sets
  `location.hash = "<question id>?variant=<variant id>"` on the bundle's frame. Nothing else: Waggle
  never calls into your page. Listen for `hashchange` and switch the screen.
- Parse the hash as `<question id>` then an optional `?variant=<variant id>`. With no variant, show the
  first one.

    function route() {
      const [question, query] = location.hash.slice(1).split("?");
      const variant = new URLSearchParams(query || "").get("variant");
      show(question, variant);
    }
    addEventListener("hashchange", route); route();

Keep the page working on its own with no hash. The bundle stays sandboxed: no network, no parent access.

## Give your html_bundle a preview

The `preview` is optional. The decision page now shows the live artifact, not the preview. The
preview still feeds the small card in the queue. Skip it if the page reads well at card size.

Without a preview, Waggle renders your entry page at the case pane card's own size and shows that -
fine for a real prototype, but a narrow page or a dense one reads as a blur at card size. Give the
card something purpose-built instead: `preview` names a file inside the bundle, built for the
card, not the page itself.

A good preview is a small summary card built for the decision: the question, the options side by
side in miniature, the key number or chart. It is never a screenshot of the page, and never the
same file as `entry` scaled down.

    artifact: {
      type: "html_bundle",
      dir: "./proto/checkout",
      entry: "index.html",
      preview: "preview.html",
    }

`preview.html` renders responsively at the card's own size and shows at the card's full width: a
flex layout that fills any width from 500 to 1100 px, at a fixed height of 280 px. Text 14 px or
larger, no scrolling. A `preview.png` or `preview.jpg` shows scaled to the card's full width - use
this when a chart or mockup you already have as an image says it better than a page would.

WRONG
    preview: "index.html"   (the entry page itself, just smaller - still not informative)
right
    preview: "preview.html"  (a small card built for this decision, sized for the card)

Template for `preview.html` - inline CSS, no network, a responsive flex layout, text 14 px or
larger, no scrolling:

    <!doctype html>
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
    </html>

## Sizing the render for a phone or other viewport

Without a preview, `viewport` sets the size Waggle renders the entry page at, instead of the card's
own default size - use it when the prototype is a phone screen or another fixed size a plain
card-sized render would distort:

    artifact: { type: "html_bundle", dir: "./proto/checkout", entry: "index.html", viewport: { width: 390, height: 844 } }

`viewport` is ignored when `preview` is set - build the preview at the size you want instead.

## Tabs, variants and steps in a prototype

Give each tab, variant or step its own #address (location.hash) and render from it on hashchange, so
the human's comments stay on the view they were made on. Waggle records the hash with each comment
and shows a pin only while the page is on that hash.

WRONG
    Switch tabs by toggling a class in a click handler, so the URL never changes.
right
    Set location.hash = "#pricing" on a tab click, and show the right tab from a hashchange listener
    (also run it once on load).

## Prototypes: flow first

Flow first, then screens. Order: 1) goal and who uses it, 2) user flows: the steps, what comes first and why, 3) the order of screens from the flow, 4) screen detail. Do not start at the screens.

Send the flow (markdown or a small diagram) before the screen bundle.

## Rich interactive prototypes (optional)

Plain HTML, CSS and vanilla JavaScript in one index.html is the default for a prototype: it builds
in seconds and stays small. Use a bundled React build only when the prototype needs real state or
many components (a multi-screen flow with forms, filters and lists that react to each other).

If the artifacts-builder skill (anthropics/skills, Apache-2.0) is installed, it builds React,
Tailwind and shadcn/ui into one self-contained HTML file that works with no network. Copy its
bundle.html into your bundle dir as index.html. Known fixes on macOS:

- After init-artifact.sh, delete the stray file named `index.html''` in the project root.
- If bundle-artifact.sh stops with ERR_PNPM_IGNORED_BUILDS, run
  `pnpm rebuild @parcel/watcher @swc/core lmdb msgpackr-extract`, then bundle again.
- If Parcel cannot resolve `@radix-ui/primitive/is-development`, replace that shadcn component
  (Checkbox, for example) with the native HTML element.
- Remove the favicon link from index.html before bundling.

Then check the output: no `src=`, `href=`, `@import` or `fetch(` pointing at a URL. React's own
namespace and error-message strings are fine; they load nothing.

WRONG
    Reach for React for a two-screen flow or a static comparison.
right
    Build it in plain HTML; keep the bundled React path for prototypes with real state.

## Staging an html_bundle directory

Write the bundle under your working tree, then pass the directory and its entry file, both
relative paths with no ".." segments and no symlinks:

    artifact: { type: "html_bundle", dir: "./proto/checkout", entry: "index.html" }

Waggle copies the whole directory before showing it, so every asset the page needs (an image, a
second stylesheet) must already be inside dir.

## Several screenshots: a gallery page

For screens the human should flip through and comment on one at a time, use the screenshots
artifact (above). Build a gallery page instead when the screens belong together on one page: your
own commentary between them, or "before / after" pairs shown side by side. It is a self-contained
html_bundle with numbered images and a short caption under each.

Resize the screenshots first, so the bundle stays small:

    sips -Z 1400 ./shots/*.png

Folder layout: index.html sits next to the images it shows, all in one directory.

    proto/gallery/
      index.html
      01-checkout.png
      02-checkout-error.png
      03-before.png
      03-after.png

index.html: inline CSS, no network requests, no scripts. Each image gets max-width:100%, so it
never overflows; the page reads as one column at 640px and stays comfortable at full width.

    <!doctype html>
    <html>
    <head>
    <meta charset="utf-8">
    <style>
      body { font: 14px/1.5 -apple-system, sans-serif; margin: 24px; color: #222; }
      .shot { margin-bottom: 32px; }
      .shot img { max-width: 100%; display: block; border: 1px solid #ddd; }
      .shot figcaption { font-size: 13px; color: #555; margin-top: 6px; }
      .pair { display: flex; gap: 12px; flex-wrap: wrap; }
      .pair > div { flex: 1 1 260px; }
      .pair img { max-width: 100%; display: block; }
      .pair p { font-size: 12px; color: #777; margin: 4px 0 0; text-align: center; }
    </style>
    </head>
    <body>
      <figure class="shot">
        <img src="01-checkout.png" alt="Checkout, step 1">
        <figcaption>1. Checkout: cart summary and shipping form.</figcaption>
      </figure>
      <figure class="shot">
        <img src="02-checkout-error.png" alt="Checkout, validation error">
        <figcaption>2. Checkout: the card field shows a validation error.</figcaption>
      </figure>
      <figure class="shot">
        <figcaption>3. Empty state, before and after the redesign.</figcaption>
        <div class="pair">
          <div><img src="03-before.png" alt="Empty state, before"><p>Before</p></div>
          <div><img src="03-after.png" alt="Empty state, after"><p>After</p></div>
        </div>
      </figure>
    </body>
    </html>

Stage the directory and pass it the same way as any html_bundle:

    artifact: { type: "html_bundle", dir: "./proto/gallery", entry: "index.html" }

WRONG
    Stitch a before and an after screen into one image with no labels.
right
    Build one gallery page with the before / after pair side by side and a caption each, and attach
    it as a single html_bundle. (Screens to flip through one by one: use screenshots instead.)
