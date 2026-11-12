import SwiftUI

/// Every design token from docs/design/mvp-values.md § 1 "Tokens", read live
/// from the Pen design file in design/ (GetVariables, and node reads on M3
/// `aWM03` and M11 `SyfHH`). No other file in this target may hardcode a
/// colour, font name, radius or stroke width; add the constant here instead.
enum Theme {
    // MARK: - 1.1 Colour variables

    enum Colors {
        static let win = Color(light: 0xFFFFFF, dark: 0x1C1E21)
        /// Text and glyphs drawn on a solid accent, ink or dark fill.
        static let onFill = Color(light: 0xFFFFFF, dark: 0x16181A)
        /// Text on an ink card (coach marks, the notifications tip): body, counter and quiet action.
        static let onInkBody = Color(light: 0xD9D9D9, dark: 0x3A3C40)
        static let onInkMuted = Color(light: 0xA9A9A9, dark: 0x66686C)
        static let onInkQuiet = Color(light: 0xBDBDBD, dark: 0x55575B)
        /// Base of every drop shadow; callers set the opacity.
        static let shadowBlack = Color(hex: 0x000000)
        /// The plugin band preview card (dark terminal strip) in Settings.
        static let bandPreviewFill = Color(hex: 0x1E2230)
        static let bandPreviewText = Color(hex: 0xD8DBE4)
        static let bandPreviewPrompt = Color(hex: 0x7D849A)
        /// Ask reach picker: the border and fill of a reached stop.
        static let reachBorder = Color(light: 0xF4C2BE, dark: 0x6B2A26)
        static let reachFill = Color(light: 0xFFFAF9, dark: 0x2A1817)
        static let side = Color(light: 0xF3F3F3, dark: 0x141517)
        static let list = Color(light: 0xFAFAFA, dark: 0x18191C)
        static let ink = Color(light: 0x16181A, dark: 0xF1F1EF)
        static let ink2 = Color(light: 0x4A4C50, dark: 0xC5C7CB)
        static let ink3 = Color(light: 0x6B6B6B, dark: 0x9C9EA3)
        static let line = Color(light: 0xE6E6E6, dark: 0x2D3034)
        static let line2 = Color(light: 0xD9D9D9, dark: 0x3C3F44)
        /// Hover fill of the prompt bar's icon and text buttons (HAIL-77 prototype `--hover`).
        static let hover = Color(light: 0xF0F0F0, dark: 0x26292D)
        /// Brand accent. Mirrors the Pen variable `$hail`.
        static let accent = Color(hex: 0xE0352B)
        /// Text and glyphs on an `accent` fill. White in both looks (`onFill` turns dark with the light `ink`).
        static let onAccent = Color(hex: 0xFFFFFF)
        /// Red as text on a window or soft red fill: `accent` is under 4.5:1 on a dark window.
        static let accentText = Color(light: 0xE0352B, dark: 0xFF8A80)
        /// The track of a small switch that is off, and the knob on it.
        static let switchOff = Color(light: 0xD0D0D0, dark: 0x3C3F44)
        static let switchOffKnob = Color(light: 0xFFFFFF, dark: 0x9C9EA3)
        /// The backdrop behind an image that does not fill its frame.
        static let imageWell = Color(light: 0xF6F5F2, dark: 0x26292D)
        /// Honey is only ever a fill (mark, selected queue row, ticked answer
        /// options, notes), never a text colour. Cell W brand (HAIL-171).
        static let honey300 = Color(hex: 0xF9C846)
        static let honey500 = Color(hex: 0xF2B01E)
        static let honey600 = Color(hex: 0xE89A0C)
        static let honeySoft = Color(light: 0xFDF4DA, dark: 0x3A2F12)
        /// The one place honey is text: the "recommended" tag (AA-ish on honeySoft).
        static let recommendedTagText = Color(light: 0xC98A00, dark: 0xF2B01E)

        // MARK: Request page mockups (decision 2026-11-10, STYLE-AUDIT.md §1)

        /// The need box fill (case map `--need-bg`); a touch deeper than `honeySoft`.
        static let needFill = Color(light: 0xFBF3D9, dark: 0x2F2812)
        /// The 1 pt line above "Why you" in the need box (case map `.need .why`).
        static let needDivider = Color(light: 0xEFE2B8, dark: 0x4A3F1C)
        /// Links and the "new" dot on the request page (case map `--link`); `ds` is the agent blue elsewhere.
        static let link = Color(light: 0x2F5BD8, dark: 0x8DA6FF)
        /// The picked option card's fill (mockup `.choice.on`).
        static let pickedFill = Color(light: 0xFFFDF5, dark: 0x27231A)
        /// The latest message's fill in the conversation and the column (mockup `.latest`, `.msg.latestm`).
        static let latestFill = Color(light: 0xF4F6FD, dark: 0x1E2436)
        static let accentSoft = Color(light: 0xFDEBE9, dark: 0x3B1614)
        /// A failed delivery on the status line (C10): red text and icon on a soft red fill. Darker than `accent`
        /// (4.45:1 on white) so the reason reads at 4.5:1 or more; a dark pair keeps that in a dark appearance.
        static let statusFailedText = Color(nsColor: StatusLineColors.failedText)
        static let statusFailedFill = Color(nsColor: StatusLineColors.failedFill)
        /// Defined but only ever drawn once in M1-M11 (M11 cached-row fill).
        static let sel = Color(light: 0xEBEBEB, dark: 0x2A2D31)
        static let ok = Color(light: 0x18A058, dark: 0x4CC38A)
        static let okSoft = Color(light: 0xE3F5EA, dark: 0x12301F)
        static let ds = Color(light: 0x2B59F0, dark: 0x8DA6FF)
        static let dsSoft = Color(light: 0xE8EEFE, dark: 0x1C2747)
        /// An agent update in the conversation: fill and stroke (Pen `n42ZJ`).
        static let dsUpdateFill = Color(light: 0xF2F5FE, dark: 0x1A2136)
        static let dsUpdateStroke = Color(light: 0xDCE4FD, dark: 0x2B3A66)
        /// The violet of the "writing the detail" status grid (HAIL-66).
        static let writing = Color(light: 0x5B4BDB, dark: 0xA99CFF)

        /// macOS system traffic-light colours drawn on M3/M11 (`aWM03`,
        /// `SyfHH` → "Traffic lights"). Fixed system colours, not tokens.
        static let trafficLightRed = Color(hex: 0xFF5F57)
        static let trafficLightYellow = Color(hex: 0xFEBC2E)
        static let trafficLightGreen = Color(hex: 0x28C840)

        /// M1 Step 1's "done" circle fill (`HxJDs` → `Y1QYk` → `lF4wW`,
        /// `#2F7D5B1A`): `ok` at ~10% alpha.
        static let stepDoneCircle = ok.opacity(Double(0x1A) / 255.0)

        /// HAIL-29 O5 terminal card's echoed lines (`#C7C4BC`) and its
        /// "applying changes" line (`#8FBFA0`) - the dark terminal card has
        /// no light/win-adaptive background, so these are fixed, not
        /// system-adaptive, like the traffic-light colours above.
        static let terminalLine = Color(hex: 0xC7C4BC)
        static let terminalApplying = Color(hex: 0x8FBFA0)

        // MARK: HAIL-56 Canvas toolbar additions (frames `ovd06`/`PPM9l`,
        // node `p4VxgR`/`pmToc` "Canvas tools"). Alphas of `onFill`, the text colour on the ink
        // toolbar: white on ink in the light look, ink on a light toolbar in the dark look.

        /// Inactive tool's icon/label, e.g. "Interact" while Comment is
        /// active (`Y8aDW`, 70%).
        static let toolbarInactiveText = onFill.opacity(Double(0xB3) / 255.0)
        /// Inactive tool's key hint, e.g. "I" while Comment is active
        /// (`XMkj6`, 40%).
        static let toolbarInactiveKey = onFill.opacity(Double(0x66) / 255.0)
    }

    // MARK: - Font families

    enum FontFamily {
        static let sans = "Inter Tight"
        static let mono = "JetBrains Mono"
    }

    /// Inter Tight Medium tracking for names and headings: -3.5% of the size.
    static let headingTracking: CGFloat = -0.035

    // MARK: - 1.2 Typography

    /// One named text style: font, its declared point size (needed to turn a
    /// CSS-style line-height multiplier into SwiftUI's `.lineSpacing`, which
    /// wants extra points, not a multiplier), and letter-spacing in points.
    /// `lineHeight`/`letterSpacing` are `nil` where mvp-values.md gives "—".
    struct TextStyle {
        let font: Font
        let size: CGFloat
        let lineHeight: CGFloat?
        let letterSpacing: CGFloat?
    }

    enum Typography {
        // Pen's 650 weight sits between SwiftUI's discrete `.semibold` (600)
        // and `.bold` (700); SwiftUI's `Font.Weight` has no public
        // arbitrary-value initializer, and macOS system/Inter rendering does
        // not expose variable weight via SwiftUI either. `.semibold` is used
        // as the nearest available step for every "650" style below.
        // HAIL-171 (Cell W): names and headings are Inter Tight Medium with
        // tracking -3.5% of the size; UI text stays Regular. The old weight
        // suffixes in the names below are historical.
        /// M11's case-pane title uses the same string at 600, not 650
        /// (confirmed on node `SyfHH` → `l4pvT`; mvp-values.md §7.1).
        static let panelTitle22w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 22).weight(.medium),
            size: 22, lineHeight: nil, letterSpacing: -0.77
        )
        static let dialogTitle19w650 = TextStyle(
            font: .custom(FontFamily.sans, size: 19).weight(.medium),
            size: 19, lineHeight: 1.3, letterSpacing: -0.665
        )
        static let sendHeading17w650 = TextStyle(
            font: .custom(FontFamily.sans, size: 17).weight(.medium),
            size: 17, lineHeight: nil, letterSpacing: -0.595
        )
        static let panelTitleSm16w650 = TextStyle(
            font: .custom(FontFamily.sans, size: 16).weight(.medium),
            size: 16, lineHeight: 1.3, letterSpacing: -0.56
        )
        static let cardTitle15w650 = TextStyle(
            font: .custom(FontFamily.sans, size: 15).weight(.medium),
            size: 15, lineHeight: nil, letterSpacing: -0.525
        )
        static let rowTitle13_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 13.5).weight(.medium),
            size: 13.5, lineHeight: 1.4, letterSpacing: -0.473
        )
        static let titlebarTitle13w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 13).weight(.medium),
            size: 13, lineHeight: nil, letterSpacing: -0.455
        )
        static let body13_5w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 13.5),
            size: 13.5, lineHeight: 1.5, letterSpacing: nil
        )
        static let body13w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 13),
            size: 13, lineHeight: 1.45, letterSpacing: nil
        )
        static let body12_5w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 12.5),
            size: 12.5, lineHeight: 1.4, letterSpacing: nil
        )
        static let labelCaps10_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 10.5).weight(.semibold),
            size: 10.5, lineHeight: nil, letterSpacing: 0.5
        )
        static let value13_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 13.5).weight(.semibold),
            size: 13.5, lineHeight: nil, letterSpacing: nil
        )
        static let button13_5w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 13.5).weight(.medium),
            size: 13.5, lineHeight: nil, letterSpacing: nil
        )
        static let button13_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 13.5).weight(.semibold),
            size: 13.5, lineHeight: nil, letterSpacing: nil
        )
        /// Prompt bar "Ask for more detail" (HAIL-77 prototype `.ask`).
        static let promptButton12w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 12).weight(.medium),
            size: 12, lineHeight: nil, letterSpacing: nil
        )
        /// Prompt bar "Send + N comments" (HAIL-77 prototype `.send`).
        static let promptSend12w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 12).weight(.semibold),
            size: 12, lineHeight: nil, letterSpacing: nil
        )
        static let buttonSm12_5w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 12.5).weight(.medium),
            size: 12.5, lineHeight: nil, letterSpacing: nil
        )
        static let buttonSm12_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 12.5).weight(.semibold),
            size: 12.5, lineHeight: nil, letterSpacing: nil
        )
        static let monoMeta12w400 = TextStyle(
            font: .custom(FontFamily.mono, size: 12),
            size: 12, lineHeight: nil, letterSpacing: nil
        )
        static let monoMeta11_5w400 = TextStyle(
            font: .custom(FontFamily.mono, size: 11.5),
            size: 11.5, lineHeight: nil, letterSpacing: nil
        )
        static let monoMetaRow10_5w400 = TextStyle(
            font: .custom(FontFamily.mono, size: 10.5),
            size: 10.5, lineHeight: nil, letterSpacing: nil
        )
        static let monoMetaRow10_5w600 = TextStyle(
            font: .custom(FontFamily.mono, size: 10.5).weight(.semibold),
            size: 10.5, lineHeight: nil, letterSpacing: nil
        )
        static let monoMeta11_5w600 = TextStyle(
            font: .custom(FontFamily.mono, size: 11.5).weight(.semibold),
            size: 11.5, lineHeight: nil, letterSpacing: nil
        )
        /// Queue-row "recommends →" label and value (§2.3): Inter 12/400,
        /// not part of the § 1.2 table (a component detail, not a listed
        /// token row), confirmed on node `YuTyu` → `Q25yB` (`CgIDG`/`lLNjw`).
        static let recommendLine12w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 12),
            size: 12, lineHeight: nil, letterSpacing: nil
        )
        /// The "new" chip beside a version number: Inter 11.5/600.
        static let chipLabel11_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 11.5).weight(.semibold),
            size: 11.5, lineHeight: nil, letterSpacing: nil
        )
        /// The check inside a tick circle (WAG-341): 8 pt bold.
        static let tickMark = TextStyle(
            font: .custom(FontFamily.sans, size: 8).weight(.bold),
            size: 8, lineHeight: nil, letterSpacing: nil
        )
        static let keyHint10_5w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 10.5),
            size: 10.5, lineHeight: nil, letterSpacing: nil
        )
        static let keyHint12_5w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 12.5),
            size: 12.5, lineHeight: nil, letterSpacing: nil
        )
        static let caption13w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 13).weight(.medium),
            size: 13, lineHeight: 1.35, letterSpacing: nil
        )
        /// The "waggle" wordmark next to the mark: Inter Tight Medium, tracking -3.5%.
        static func wordmark(size: CGFloat) -> TextStyle {
            TextStyle(
                font: .custom(FontFamily.sans, size: size).weight(.medium),
                size: size, lineHeight: nil, letterSpacing: size * headingTracking
            )
        }

        // MARK: M4/M10 review workspace additions (not in the §1.2 table;
        // read directly off nodes for this story, see the report's
        // "Design reads" section).

        /// Deadline chip text (`MYn95` → `od8dn` → `l5kX9G`): Inter 12/600.
        static let deadlineChip12w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 12).weight(.semibold),
            size: 12, lineHeight: nil, letterSpacing: nil
        )
        /// Offline/Sandboxed badge text (`p3INw` → `UflLb`/`IjLav`): Inter
        /// 11/500.
        static let badgeLabel11w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 11).weight(.medium),
            size: 11, lineHeight: nil, letterSpacing: nil
        )
        /// Option chip label (`O2LGd` → `LbKDC` → `VVvfW` → `rpTc4`): Inter
        /// 13/500.
        static let optionLabel13w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 13).weight(.medium),
            size: 13, lineHeight: nil, letterSpacing: nil
        )
        /// "Recommended" option tag text (`O2LGd` → `tiigK` → `G9XNdb`):
        /// Inter 10.5/500.
        static let tagLabel10_5w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 10.5).weight(.medium),
            size: 10.5, lineHeight: nil, letterSpacing: nil
        )
        /// A context card row's label (HAIL-107 prototype `.tl1`): Inter 12.5/500.
        static let rowLabel12_5w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 12.5).weight(.medium),
            size: 12.5, lineHeight: nil, letterSpacing: nil
        )
        // MARK: M5 Comment mode additions (`z4rHb6`, requirements `ZqW1R`;
        // see the report's "Design reads" section).

        /// Capture chip text (`kSr5W` → `gK5qu` → `YQDpZ`) and a comment
        /// card's region meta text (`uyrRs` → `OGZrm` → … → `k8EUCL`):
        /// JetBrains Mono 11/400.
        static let monoMeta11w400 = TextStyle(
            font: .custom(FontFamily.mono, size: 11),
            size: 11, lineHeight: nil, letterSpacing: nil
        )
        /// A drafting comment card's "typing…  ↵ to add" status (`uyrRs` →
        /// `O8Tw6` → `RHseg` → `MRFMW`): Inter 11/400.
        static let statusCaption11w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 11),
            size: 11, lineHeight: nil, letterSpacing: nil
        )
        /// Pin number label on a 20×20 pin (`t3SUea` → `JwA12`, `LR475` →
        /// `VNikX`): Inter 11/700.
        static let pinNumber11w700 = TextStyle(
            font: .custom(FontFamily.sans, size: 11).weight(.bold),
            size: 11, lineHeight: nil, letterSpacing: nil
        )
        /// Pin number label on a 16×16 pin, the note popover's head pin
        /// (`qAwAc` → `YvVkm` → `nIvP3`): Inter 9.5/700.
        static let pinNumber9_5w700 = TextStyle(
            font: .custom(FontFamily.sans, size: 9.5).weight(.bold),
            size: 9.5, lineHeight: nil, letterSpacing: nil
        )
        /// The variant badge inside a screen row thumbnail, "A2" (decision record 2026-11-12): Inter 9/700.
        static let screenBadge9w700 = TextStyle(
            font: .custom(FontFamily.sans, size: 9).weight(.bold),
            size: 9, lineHeight: nil, letterSpacing: nil
        )
        /// The title of the screen on show in the box and full-size header, "C2 Riepilogo…": Inter 12/400.
        static let screenTitle12w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 12),
            size: 12, lineHeight: nil, letterSpacing: nil
        )
        /// «On screen» on an option row: Inter 10/600.
        static let onScreenChip10w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 10).weight(.semibold),
            size: 10, lineHeight: nil, letterSpacing: nil
        )
        /// Comments-column composer key hint, "⌘↵" (`uyrRs` → `dpDYQ` →
        /// `SubDU` → `aUwYI`): Inter 11.5/400. Distinct from `keyHint12_5w400`
        /// (M4's composer uses 12.5pt for the same hint; M5's node is 11.5pt).
        static let keyHint11_5w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 11.5),
            size: 11.5, lineHeight: nil, letterSpacing: nil
        )

        // MARK: M6 Review-before-send additions (`Ea8Gs`, requirements
        // `a51tnr`; see the report's "Design reads" section).

        /// REPLY block's note, "Go with A. Two fixes below." (`Vz9Aj` →
        /// `oV2H7`): Inter 13/400, lineHeight 1.4. Distinct from the
        /// RECOMMENDED block's `body12_5w400` reason text - the M6 node is
        /// one point larger.
        static let replyNote13w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 13),
            size: 13, lineHeight: 1.4, letterSpacing: nil
        )
        /// "N comments on Capture n (vN)" section label (`zhosI` → `r21mUd`):
        /// Inter 11/600, letter-spacing 0.3.
        static let commentsSectionLabel11w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 11).weight(.semibold),
            size: 11, lineHeight: nil, letterSpacing: 0.3
        )
        /// A review-before-send note list item, e.g. "Default this to
        /// Monthly, not Annual." (`hy1kv` → `W23jr` → `UiZ7B`): Inter
        /// 12/400, lineHeight 1.4.
        static let reviewNoteText12w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 12),
            size: 12, lineHeight: 1.4, letterSpacing: nil
        )
        /// Destination row text, "Goes to: ..." (`yKpjN` → `HM11m`): Inter
        /// 12/500, lineHeight 1.4.
        static let destinationRow12w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 12).weight(.medium),
            size: 12, lineHeight: 1.4, letterSpacing: nil
        )

        // MARK: M1 Setup window additions (KNOCK-15; not in the §1.2 table,
        // read directly off `HxJDs` nodes).

        /// Setup-window header subtitle (`Wke0V` → `LnV01` → `G9i99A`,
        /// "Connect Claude Code and try the loop."): Inter 13/400.
        static let setupSubtitle13w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 13),
            size: 13, lineHeight: nil, letterSpacing: nil
        )

        // MARK: HAIL-29 Onboarding v2 (immersive) additions (`eZAOS`,
        // requirements per-screen cards `S74nBE`/`Yw8GG`/`L8M71B`/`P2sGRN`/
        // `qaARn`/`cqKAG`; read from the exported screens/requirements HTML,
        // see the story's Choices ledger — the worker could not open the
        // `.pen` file directly).

        /// O1/O2 dialog title, e.g. "Connect your agent" (regular weight,
        /// unlike the old M1 `dialogTitle19w650`): Inter 19/400.
        static let screenTitle19w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 19).weight(.medium),
            size: 19, lineHeight: 1.3, letterSpacing: -0.665
        )
        /// O3's larger dialog title (bigger 48×48 mark variant): Inter 20/400.
        static let screenTitle20w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 20).weight(.medium),
            size: 20, lineHeight: 1.3, letterSpacing: -0.7
        )
        /// O5's dialog title: Inter 18/400.
        static let screenTitle18w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 18).weight(.medium),
            size: 18, lineHeight: 1.3, letterSpacing: -0.63
        )
        /// O2's prompt-block label, "PROMPT · PASTE INTO A NEW SESSION":
        /// Inter 10/600, letter-spacing 0.5.
        static let monoLabelCaps10w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 10).weight(.semibold),
            size: 10, lineHeight: nil, letterSpacing: 0.5
        )
        /// O4 coach mark's "N of 4" counter: JetBrains Mono 10.5/600,
        /// letter-spacing 0.3.
        static let coachMarkCounter10_5w600 = TextStyle(
            font: .custom(FontFamily.mono, size: 10.5).weight(.semibold),
            size: 10.5, lineHeight: nil, letterSpacing: 0.3
        )
        /// O5 terminal card's echoed reply/comment lines: JetBrains Mono
        /// 11.5/400, lineHeight 1.45.
        static let terminalLine11_5w400 = TextStyle(
            font: .custom(FontFamily.mono, size: 11.5),
            size: 11.5, lineHeight: 1.45, letterSpacing: nil
        )
        /// O5 terminal card's success line, "✓ knock_ask resolved · ...":
        /// JetBrains Mono 12/600.
        static let terminalSuccessLine12w600 = TextStyle(
            font: .custom(FontFamily.mono, size: 12).weight(.semibold),
            size: 12, lineHeight: nil, letterSpacing: nil
        )
        /// O6's "TEST ASK" badge: Inter 10/400, letter-spacing 0.4 -
        /// deliberately not bold, unlike every other status chip, so it
        /// reads as synthetic rather than a real status.
        static let testAskBadge10w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 10),
            size: 10, lineHeight: nil, letterSpacing: 0.4
        )
        /// Onboarding step title, e.g. "Connect Claude Code" (`Y1QYk` →
        /// `OU3mN` → `M4Sgjl`): Inter 14.5/600.
        static let stepTitle14_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 14.5).weight(.semibold),
            size: 14.5, lineHeight: nil, letterSpacing: nil
        )
        /// Step circle number ("2", "3": `tlSBP` → `Yk3Dq`) and the
        /// connection-check success row text (`Z1jR3` → `sRRLV`): both
        /// Inter 12/600, different colours per usage site.
        static let micro12w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 12).weight(.semibold),
            size: 12, lineHeight: nil, letterSpacing: nil
        )
        /// Test-ask caption under its button (`UWJW3` → `jfi6l`,
        /// "Creates a sample review so you can see the loop."): Inter
        /// 11.5/400.
        static let caption11_5w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 11.5),
            size: 11.5, lineHeight: nil, letterSpacing: nil
        )

        // MARK: HAIL-30 Agent instructions panel additions (frame `eZAOS`
        // node `Z61v5y`; read directly, not in the §1.2 table).

        /// Panel column label, "THEY KNOCK WHEN…" (`Z61v5y` → `tJL7R`):
        /// Inter 9.5/600, letter-spacing 0.5.
        static let instructionsLabel9_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 9.5).weight(.semibold),
            size: 9.5, lineHeight: nil, letterSpacing: 0.5
        )
        /// Panel item text (`Z61v5y` → `RgIrQ`): Inter 11.5/400,
        /// lineHeight 1.35.
        static let instructionsItem11_5w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 11.5),
            size: 11.5, lineHeight: 1.35, letterSpacing: nil
        )

        // MARK: M8 Delivery states additions (`Egyj0`, requirements `Ufy4A`;
        // see the report's "Design reads" section).

        /// The locked reply bubble's text, "You: Go with A. Two fixes:"
        /// (`Bfg84`), and the offline banner's sub line, "Your reply is
        /// saved on this Mac." (`O6jELg`): both Inter 11.5/400, lineHeight
        /// 1.4.
        static let deliverySoftNote11_5w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 11.5),
            size: 11.5, lineHeight: 1.4, letterSpacing: nil
        )
        /// Offline/Failed banner title, e.g. "Not sent · Knock service is
        /// offline" (`NtJ90`, `LFCZ9`): Inter 12/600. Colour (`accent`) is
        /// applied by the caller.
        static let deliveryBannerTitle12w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 12).weight(.semibold),
            size: 12, lineHeight: nil, letterSpacing: nil
        )
        /// Retry button label (`V0mzPw`, `WYo5C`): Inter 12/500.
        static let deliveryRetryLabel12w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 12).weight(.medium),
            size: 12, lineHeight: nil, letterSpacing: nil
        )
        /// Failed banner's idempotency note, "Retry sends this same reply
        /// once, never twice." (`eLaGi`): Inter 11/400, lineHeight 1.4.
        static let deliveryIdempotentNote11w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 11),
            size: 11, lineHeight: 1.4, letterSpacing: nil
        )

        // MARK: M9 New revision arrived additions (`EDMW5`, requirements
        // `RI9HS`; see the report's "Design reads" section).

        /// The "v3 arrived" banner text (`un8Zh` → `I38AZy`): Inter 12.5/600.
        /// Colour (`$ds`) is applied by the caller.
        static let revisionBannerTitle12_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 12.5).weight(.semibold),
            size: 12.5, lineHeight: nil, letterSpacing: nil
        )
        /// Version chip text, "v3 · latest" (`z8L5gE` → `pm9vF`): Inter
        /// 11/600. Colour (`$ds`) is applied by the caller.
        static let versionChipLabel11w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 11).weight(.semibold),
            size: 11, lineHeight: nil, letterSpacing: nil
        )
        /// Thread message author, "checkout agent" (`W606g` → `FYSP6` →
        /// `TfGzU`): Inter 12.5/600.
        static let threadAuthor12_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 12.5).weight(.semibold),
            size: 12.5, lineHeight: nil, letterSpacing: nil
        )
        /// Thread message timestamp, "just now" (`W606g` → `FYSP6` →
        /// `vMRdd`): Inter 11.5/400.
        static let threadTimestamp11_5w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 11.5),
            size: 11.5, lineHeight: nil, letterSpacing: nil
        )
        /// Thread message body (`W606g` → `cXq53` → `kHZbs`): Inter 13/400,
        /// lineHeight 1.5. Distinct from `body13w400` (same size, but
        /// lineHeight 1.45 there).
        static let threadMessageBody13w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 13),
            size: 13, lineHeight: 1.5, letterSpacing: nil
        )
        /// "N comments on vN · view vN" link text (`E0OSB` → `fRst4`): Inter
        /// 12/500.
        static let priorRevisionLink12w500 = TextStyle(
            font: .custom(FontFamily.sans, size: 12).weight(.medium),
            size: 12, lineHeight: nil, letterSpacing: nil
        )

        // MARK: HAIL-50 Settings sidebar window additions. No Pen node
        // covers this window (docs/design/mvp-values.md does not list it);
        // sizes are the story contract's own given values, not a node read.

        /// Sidebar nav row label, unselected: Inter 13/400.
        static let sidebarRow13w400 = TextStyle(
            font: .custom(FontFamily.sans, size: 13),
            size: 13, lineHeight: nil, letterSpacing: nil
        )
        /// Sidebar nav row label, selected (contract: "selected row fill
        /// Theme.Colors.sel + semibold ink"): Inter 13/600.
        static let sidebarRow13w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 13).weight(.semibold),
            size: 13, lineHeight: nil, letterSpacing: nil
        )

        // MARK: HAIL-54 Unified composer card additions. No Pen node covers
        // this exact recipe (a V1/V3 hybrid); sizes are the story contract's
        // own given values (renders `gDa8Q`/`J7Z3jI`), not a node read.

        /// A composer option row's key badge number, "1"/"2"/"3" (contract:
        /// "mono 12 pt semibold"): JetBrains Mono 12/600.
        static let keyBadge12w600 = TextStyle(
            font: .custom(FontFamily.mono, size: 12).weight(.semibold),
            size: 12, lineHeight: nil, letterSpacing: nil
        )

        // MARK: HAIL-56 Canvas toolbar / column tabs additions (frames
        // `ovd06`/`PPM9l`; see the report's "Design reads" section).

        /// Canvas toolbar tool button's key hint, "I"/"C" (`Y8aDW` → `XMkj6`):
        /// JetBrains Mono 10.5/normal. Distinct from `keyHint10_5w400` (Inter,
        /// not mono) - the old Interact/Comment toggle's own key hint.
        static let toolbarKeyHint10_5w400 = TextStyle(
            font: .custom(FontFamily.mono, size: 10.5),
            size: 10.5, lineHeight: nil, letterSpacing: nil
        )
        /// Column tabs' count badge number, "2" (`j0oBU` → `AxL5j`): Inter
        /// 10.5/600.
        static let countBadge10_5w600 = TextStyle(
            font: .custom(FontFamily.sans, size: 10.5).weight(.semibold),
            size: 10.5, lineHeight: nil, letterSpacing: nil
        )
    }

    // MARK: - 1.3 Radii, strokes, shadows

    struct StrokeToken {
        let color: Color
        let width: CGFloat
    }

    struct ShadowToken {
        let color: Color
        let offset: CGSize
        let blur: CGFloat
    }

    enum Radius {
        static let window: CGFloat = 12
        static let setupWindow: CGFloat = 14
        static let card: CGFloat = 12
        static let chip: CGFloat = 5
        /// Observed exactly on M11 "Start service" (`A33YmA`, cornerRadius 7).
        static let buttonSmall: CGFloat = 7
        /// Observed exactly on M3 "Open review" (`sxrfg`, cornerRadius 8);
        /// mvp-values.md gives the primary button an 8-9 range, 8 is what the
        /// nodes this story reads actually use.
        static let buttonPrimary: CGFloat = 8
        /// Prompt bar attach, Ask and Send buttons (HAIL-77 prototype `.ib`, `.ask`, `.send`).
        static let promptButton: CGFloat = 8
        static let regionBox: CGFloat = 6
        static let notePopover: CGFloat = 10
        static let composer: CGFloat = 9
        static let recommendedBlock: CGFloat = 8
        /// The ask thread's card (HAIL-68, Pen `u9q5bu`).
        static let threadCard: CGFloat = 10
        /// A conversation message card or bubble (HAIL-71, Pen `n42ZJ`).
        static let conversationBubble: CGFloat = 10
        /// Comment card, saved and drafting (`uyrRs` → `OGZrm`/`O8Tw6`,
        /// cornerRadius 9).
        static let commentCard: CGFloat = 9
        /// Review-before-send capture thumbnail (`Ea8Gs` → `v5E0EL`,
        /// cornerRadius 8).
        static let reviewThumbnail: CGFloat = 8
        /// A delivery panel's locked reply bubble (`P6oot` and its Panel 2-4
        /// equivalents, cornerRadius 7).
        static let deliveryReplyBubble: CGFloat = 7
        /// A delivery banner/row - Sending, Delivered, Offline, Failed
        /// (`mhQbH`, `PRJDc`, `alW2Q`, `cXBVL`, all cornerRadius 8).
        static let deliveryBanner: CGFloat = 8
        /// Canvas toolbar tool button, active or inactive (`Y8aDW`/`EaCMK`,
        /// cornerRadius 9). The toolbar's own outer shell reuses `card` (12) -
        /// confirmed the same value on `p4VxgR`.
        static let toolbarButton: CGFloat = 9
        /// Column tabs track (`PBNIR`, cornerRadius 8).
        static let columnTabsTrack: CGFloat = 8
        /// Column tabs segment, active or inactive (`DcArO`/`b05Q3c`,
        /// cornerRadius 6).
        static let columnTabsSegment: CGFloat = 6
        /// Column tabs' count badge (`j0oBU`, cornerRadius 8).
        static let countBadge: CGFloat = 8
    }

    enum Stroke {
        static let window = StrokeToken(color: Colors.line2, width: 1)
        static let card = StrokeToken(color: Colors.line2, width: 1)
        static let hairline = StrokeToken(color: Colors.line, width: 1)
        static let regionBox = StrokeToken(color: Colors.accent, width: 1.5)
        static let notePopover = StrokeToken(color: Colors.line2, width: 1)
    }

    enum Shadow {
        static let window = ShadowToken(color: Color.black.opacity(hexAlpha(0x1F)), offset: CGSize(width: 0, height: 20), blur: 60)
        static let setupWindow = ShadowToken(color: Color.black.opacity(hexAlpha(0x29)), offset: CGSize(width: 0, height: 24), blur: 70)
        static let notePopover = ShadowToken(color: Color.black.opacity(hexAlpha(0x29)), offset: CGSize(width: 0, height: 8), blur: 24)
        /// The "Sent" toast (HAIL-79 prototype: `0 12px 30px rgba(0,0,0,.12)`).
        static let sentToast = ShadowToken(color: Color.black.opacity(hexAlpha(0x1F)), offset: CGSize(width: 0, height: 12), blur: 30)
        /// The floating canvas toolbar (`p4VxgR`/`pmToc`, `#00000033`
        /// offset (0,6) blur 18).
        static let canvasToolbar = ShadowToken(color: Color.black.opacity(hexAlpha(0x33)), offset: CGSize(width: 0, height: 6), blur: 18)
        /// A column tab's active segment (`b05Q3c`/`KS7Dx`, `#0000001A`
        /// offset (0,1) blur 3).
        static let columnTab = ShadowToken(color: Color.black.opacity(hexAlpha(0x1A)), offset: CGSize(width: 0, height: 1), blur: 3)

        /// The right pane's content cards (HAIL-107 prototype: `0 1px 2px rgba(28,27,25,.05)`).
        static let cardLift = ShadowToken(color: Color(hex: 0x16181A).opacity(0.05), offset: CGSize(width: 0, height: 1), blur: 2)
        /// The docked answer box's soft upward shadow (HAIL-107 prototype: `0 -6px 16px rgba(28,27,25,.06)`).
        static let dockUp = ShadowToken(color: Color(hex: 0x16181A).opacity(0.06), offset: CGSize(width: 0, height: -6), blur: 16)

        /// Treats a byte (0-255) as a CSS-style hex alpha channel, e.g. the
        /// `1F` in `#0000001F`.
        private static func hexAlpha(_ byte: Int) -> Double { Double(byte) / 255.0 }
    }

    enum Spacing {
        /// Selection bar on a selected queue row (`YuTyu` → `qCj0B`): a 3pt
        /// wide rectangle the full height of the row, filled `ink`.
        static let selectionBarWidth: CGFloat = 3
        /// Inbox list column width, fixed: mockup B's `.side` (300; was 392 from docs/design/mvp-values.md §2.1).
        static let listColumnWidth: CGFloat = AskDoc.Chrome.sidebarWidth
        /// Leading space the list header reserves so its own content never
        /// sits under the real system traffic-light buttons (Amendments,
        /// KNOCK-08): header padding-left 18 + the traffic-lights frame's
        /// own width (`aakb5`: padding [2,6,0,6] around three 12pt circles,
        /// gap 8 -> 48) + the header's gap 10 to the next child, rounded up.
        static let listHeaderLeadingReserve: CGFloat = 78
        /// A click (rather than a drag) in Comment mode drops this default
        /// region size, in points (`docs/stories/KNOCK-11.md` AC: "a click
        /// makes a default 40×40 pt region").
        static let defaultRegionSize: CGFloat = 40
        /// A drafting region's corner drag-handle, both dimensions
        /// (`snFiG`/`FqRI9`, 9×9 ellipses).
        static let regionHandleSize: CGFloat = 9
        /// Note popover width (`qAwAc`, width 230).
        static let notePopoverWidth: CGFloat = 230
        /// Pin diameter on the stage and in the comments list (`t3SUea`,
        /// `LR475`, `DSUxC`: all 20×20).
        static let pinLarge: CGFloat = 20
        /// Pin diameter on the note popover's head (`YvVkm`: 16×16).
        static let pinSmall: CGFloat = 16
        /// Review-before-send capture thumbnail width (`Ea8Gs` → `v5E0EL`,
        /// width 120); height follows the capture's own aspect ratio.
        static let reviewThumbnailWidth: CGFloat = 120
        /// Setup window width (`HxJDs` → `UZ8lR`, fixed 760).
        static let setupWindowWidth: CGFloat = 760
        /// Onboarding in the main window (WAG-341): the "agent is on it" card grows to this width and
        /// shrinks with the pane; its mark is 44 pt; the notifications tip is 250 pt wide.
        static let workingCardMaxWidth: CGFloat = 480
        static let workingMark: CGFloat = 44
        static let tipWidth: CGFloat = 250
        /// A tick circle in the getting started list, and the progress bar's height.
        static let tickSize: CGFloat = 16
        static let progressBarHeight: CGFloat = 4
        /// The round mark of a radio card in the first job step.
        static let radioSize: CGFloat = 14
    }

    enum Alpha {
        /// Region box fill on a committed comment (`#E4572E14`).
        static let regionCommitted: Double = Double(0x14) / 255.0
        /// Region box fill while a comment is still being drafted
        /// (`#E4572E0F`).
        static let regionDrafting: Double = Double(0x0F) / 255.0
        /// HAIL-75: the highlighted comment's region fill.
        static let regionSelected: Double = Double(0x33) / 255.0
        /// The stage's dim overlay while in Comment mode (`ycDvi`,
        /// `#1C1B190D`).
        static let dimOverlay: Double = Double(0x0D) / 255.0
    }
}

extension Color {
    /// A colour with one value for the light look and one for the dark look.
    init(light: UInt32, dark: UInt32) {
        self.init(nsColor: StatusLineColors.dynamic(light: light, dark: dark))
    }

    init(hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}

extension View {
    /// Draws a `Theme.ShadowToken` (CSS blur is twice SwiftUI's radius).
    func shadow(_ token: Theme.ShadowToken) -> some View {
        shadow(color: token.color, radius: token.blur / 2, x: token.offset.width, y: token.offset.height)
    }

    /// Applies a `Theme.TextStyle`'s font, tracking and (approximate)
    /// line spacing.
    func knockTextStyle(_ style: Theme.TextStyle) -> some View {
        var view = AnyView(self.font(style.font))
        if let tracking = style.letterSpacing {
            view = AnyView(view.tracking(tracking))
        }
        if let lineHeight = style.lineHeight {
            view = AnyView(view.lineSpacing(style.size * (lineHeight - 1.0)))
        }
        return view
    }
}

/// The status line's failed colors as appearance-aware `NSColor`s, so a test can resolve both appearances (C10).
enum StatusLineColors {
    static let failedText = dynamic(light: 0xB42318, dark: 0xFF9B94)
    static let failedFill = dynamic(light: 0xFDEBE9, dark: 0x3B1614)

    static func dynamic(light: UInt32, dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return srgb(isDark ? dark : light)
        }
    }

    static func srgb(_ hex: UInt32) -> NSColor {
        NSColor(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

// MARK: - CSS line height (request page mockups, STYLE-AUDIT.md rule 1)

extension Theme.Typography {
    /// The font's own line height as a share of its size, from the bundled TTFs' hhea metrics
    /// (ascent + descent + line gap): Inter Tight 1.21, JetBrains Mono 1.32.
    static let sansNaturalLineHeight: CGFloat = 1.21
    static let monoNaturalLineHeight: CGFloat = 1.32

    /// The `lineSpacing` that gives a CSS `line-height: lineHeight` (a line box of `lineHeight × size`), not
    /// `size × (lineHeight − 1)` on top of the font's own line height. Never negative: a CSS line height under
    /// the natural one (e.g. `/1`) draws at the natural height.
    static func cssLineSpacing(size: CGFloat, lineHeight: CGFloat, mono: Bool = false) -> CGFloat {
        let natural = mono ? monoNaturalLineHeight : sansNaturalLineHeight
        return max(0, size * (lineHeight - natural))
    }
}
