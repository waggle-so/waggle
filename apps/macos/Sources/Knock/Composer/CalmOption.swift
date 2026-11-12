import AppKit
import SwiftUI

/// The rules of the calm card as plain functions, so a test can check them without hosting a view.
enum CalmOption {
    /// A closed row shows this many words of the description.
    static let shortWords = 8
    /// An option card opens with a 220 ms ease-out on its height.
    static let openDuration = 0.22
    static let cardRadius: CGFloat = 16

    /// The option cards of the decision column (decision 2026-11-10, mockup `.choice`): radius 10, 6 apart.
    static let rowRadius: CGFloat = 10
    static let rowGap: CGFloat = 6
    /// A ruled-out row dims to this (WAG-301).
    static let ruledOutOpacity = 0.55
    static let leanTip = "I lean to this, but I am not sure"
    static let ruleOutTip = "Rule this out"
    /// The tooltip of a closed card shows after the pointer rests on the card this long. A chip shows it at once.
    static let tooltipDelay = 0.4
    /// The block in the page swaps its text with a 150 ms fade.
    static let blockFade = 0.15

    /// The title of the effects list (WAG-360).
    static let effectsTitle = "If you pick this"
    static let recommendedPill = "Recommended"
    /// The label over the option list (mockup `.ol`).
    static let listLabel = "Your choice"
    /// A locked row and an unticked row at the limit do not react to a click (WAG-379 keeps the rule of WAG-334).
    static func acceptsPick(isLocked: Bool, isLimitDimmed: Bool, isSelected: Bool) -> Bool {
        !isLocked && !(isLimitDimmed && !isSelected)
    }
    /// The focus that a click gives a row comes within this time of the press. It does not open the tooltip.
    static let pointerFocusWindow = Duration.milliseconds(400)
    static func isPointerFocus(_ sincePress: Duration?) -> Bool {
        guard let sincePress else { return false }
        return sincePress < pointerFocusWindow
    }
    /// The tag in a tight row (WAG-311): the whole "★ Recommended" when it fits, else "★" alone with the word
    /// in its tooltip. It never shows a cut word.
    static let recommendedMark = "★"

    /// True when the title on one line and the whole "★ Recommended" tag (`.rec`: 600 10.5, padding 6) fit in `room`.
    /// Before the first layout (`room` 0) the whole tag shows.
    static func fitsFullRecommendedTag(title: String, room: CGFloat) -> Bool {
        guard room > 0 else { return true }
        let tagFont = PromptBarLogic.sansFont(size: 10.5, weight: .semibold)
        let tag = ceil(NSAttributedString(string: "\(recommendedMark) \(recommendedPill)", attributes: [.font: tagFont]).size().width) + 12
        return CSSText.lineWidth(title, size: OptionCardStyle.title.size, semibold: true) + OptionCardStyle.itemGap + tag <= room
    }

    /// Which card of a list is open (mockup: the picked card opens in place): the pick, else the recommended one.
    /// A pick-several list opens none (mockup template `multi`). Positions are 1-based; nil opens none.
    static func openPosition(selected: Int?, recommended: Int?, isCheckbox: Bool) -> Int? {
        isCheckbox ? nil : selected ?? recommended
    }

    /// The line under a closed card (mockup `.tl`): the first pro, the first con and "+N" for the rest of the pros,
    /// cons and effects. Nil when the option has no pros and no cons.
    struct Teaser: Equatable {
        let pro: String?
        let con: String?
        let more: Int
    }

    static func teaser(pros: [String], cons: [String], effects: [String] = []) -> Teaser? {
        guard !pros.isEmpty || !cons.isEmpty else { return nil }
        let shown = (pros.isEmpty ? 0 : 1) + (cons.isEmpty ? 0 : 1)
        return Teaser(
            pro: pros.first.map { AgentMarkdown.singleLine($0) }, con: cons.first.map { AgentMarkdown.singleLine($0) },
            more: pros.count + cons.count + effects.count - shown)
    }

    /// Text the card can draw as plain wrapped text (`CSSText`): one paragraph, no markdown, no source markers.
    static func isPlainLine(_ text: String) -> Bool {
        !text.contains("\n") && !text.contains("[[s:") && !text.contains(where: { "*`_[".contains($0) })
    }

    /// "+3", with "3 more" spoken and in the tooltip.
    static func moreText(_ count: Int) -> String { "+\(count)" }
    static func moreTip(_ count: Int) -> String { "\(count) more" }

    /// The reason at the end of an open card (mockup `.because`): "Why I recommend it: …" on the recommended
    /// option, "Why: …" on an option that carries its own why.
    static func becauseLine(_ note: String, isRecommended: Bool) -> String {
        "\(CalmNoteView.title(isRecommended: isRecommended)): \(note)"
    }

    /// The block label (WAG-303): the plan round's preselected recommendation is not yet the person's pick.
    static func isPick(selectedId: String?, pickIsDefault: Bool) -> Bool { selectedId != nil && !pickIsDefault }

    /// What the page block shows: the pick, or before any pick the recommendation.
    struct PickBlock: Equatable {
        let option: Option
        let position: Int
        let isPick: Bool
    }

    static func pickBlock(options: [Option], selectedId: String?, recommendationId: String?, pickIsDefault: Bool = false) -> PickBlock? {
        if let selectedId, let index = options.firstIndex(where: { $0.id == selectedId }) {
            return PickBlock(option: options[index], position: index + 1, isPick: !pickIsDefault)
        }
        if let recommendationId, let index = options.firstIndex(where: { $0.id == recommendationId }) {
            return PickBlock(option: options[index], position: index + 1, isPick: false)
        }
        return nil
    }

    /// "YOUR PICK · 2", or "RECOMMENDED · 2" before any pick.
    static func blockLabel(position: Int, isPick: Bool, suffix: String? = nil) -> String {
        let base = "\(isPick ? "YOUR PICK" : "RECOMMENDED") · \(position)"
        return suffix.map { base + " · " + $0 } ?? base
    }

    /// The pick of a step point, plain string answers included (WAG-304). Nil without a pick.
    /// A point has no recommendation in the protocol, so there is no "RECOMMENDED" block before a pick.
    static func pointPick(_ point: QuestionPoint, choice: String?) -> (option: PointOption, position: Int)? {
        guard let choice, let index = point.choices.firstIndex(where: { $0.label == choice }) else { return nil }
        return (point.choices[index], index + 1)
    }

    /// The grey note: the recommendation's why on the recommended option; on the others only their own
    /// why, when the agent sent one.
    static func note(for option: Option, isRecommended: Bool, recommendationWhy: String?) -> String? {
        let clean = { (text: String?) -> String? in
            guard let text else { return nil }
            let line = AgentMarkdown.singleLine(text, keepingSources: true)
            return AgentMarkdown.singleLine(line).isEmpty ? nil : line
        }
        if isRecommended, let why = clean(recommendationWhy) { return why }
        return clean(option.why)
    }

    /// The description under the title, unless it only repeats the title.
    static func description(of option: Option, position: Int) -> String? {
        let body = OptionLabelFormatting.decisionBody(label: option.label, title: option.displayTitle)
        let entry = DecisionSectionView.Entry(position: position, title: option.displayTitle, label: body, isRecommended: false)
        return entry.showsLabel ? body : nil
    }

    /// "YOUR PICK · 2 MERGE AS IT IS".
    static func pickLabel(_ option: Option, position: Int) -> String {
        "YOUR PICK · \(position) \(AgentMarkdown.singleLine(option.displayTitle).uppercased())"
    }
}

/// WAG-357: the item and the option the recommended block (and its Good and Watch out lists) speaks of, so a comment on
/// its words names them. `nil` ids mean the block takes no comment (an option row).
struct AskCommentIds: Equatable {
    var itemId: String?
    var optionId: String?
}

/// The Good and Watch out lists (WAG-281): two columns on the decision page, one in the side panel.
struct GoodWatchOutView: View {
    let pros: [String]
    let cons: [String]
    var columns = true
    /// WAG-357: set on the recommended block of the page. The lines of an option row take no comment.
    var commentIds: AskCommentIds? = nil

    var body: some View {
        if !pros.isEmpty || !cons.isEmpty {
            Group {
                if columns {
                    HStack(alignment: .top, spacing: 28) {
                        list("Good", lines: pros, color: Theme.Colors.ok, part: .pro)
                        list("Watch out", lines: cons, color: Theme.AskDoc.Colors.watch, part: .con)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        list("Good", lines: pros, color: Theme.Colors.ok, part: .pro)
                        list("Watch out", lines: cons, color: Theme.AskDoc.Colors.watch, part: .con)
                    }
                }
            }
            .accessibilityElement(children: .contain)
        }
    }

    @ViewBuilder
    private func list(_ title: String, lines: [String], color: Color, part: AskTextPart) -> some View {
        if !lines.isEmpty {
            let bases = commentIds == nil ? [] : AskTextContent.lineBases(lines)
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .fontWeight(.semibold)
                    .foregroundColor(color)
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle().fill(color).frame(width: 6, height: 6).offset(y: -1)
                        SourcedText(
                            text: line, style: Theme.AskDoc.Typography.optionCard13, color: Theme.Colors.ink2,
                            target: commentIds.map {
                                AskCommentTarget(part, itemId: $0.itemId, optionId: $0.optionId, slot: "\(index)", baseOffset: bases[index])
                            })
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(title): \(AgentMarkdown.singleLine(line))")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The effects of an option (WAG-360): "If you pick this" and up to 3 lines. Always one full-width column, below
/// Good and Watch out. It looks like one Good column, with neutral ink3 for the title and the dots.
struct EffectsView: View {
    let effects: [String]
    /// WAG-357: set on the recommended block of the page. The lines of an option row take no comment.
    var commentIds: AskCommentIds? = nil

    var body: some View {
        if !effects.isEmpty {
            let bases = commentIds == nil ? [] : AskTextContent.lineBases(effects)
            VStack(alignment: .leading, spacing: 5) {
                Text(CalmOption.effectsTitle)
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .fontWeight(.semibold)
                    .foregroundColor(Theme.Colors.ink3)
                ForEach(Array(effects.enumerated()), id: \.offset) { index, line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle().fill(Theme.Colors.ink3).frame(width: 6, height: 6).offset(y: -1)
                        SourcedText(
                            text: line, style: Theme.AskDoc.Typography.optionCard13, color: Theme.Colors.ink2,
                            target: commentIds.map {
                                AskCommentTarget(.effect, itemId: $0.itemId, optionId: $0.optionId, slot: "\(index)", baseOffset: bases[index])
                            })
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(CalmOption.effectsTitle): \(AgentMarkdown.singleLine(line))")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The quiet grey note "Why I recommend it" (or just "Why" on an option's own reason).
struct CalmNoteView: View {
    let title: String
    let text: String
    /// WAG-357: set on the reason in the recommended block of the page. `nil` in an option row.
    var target: AskCommentTarget? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .knockTextStyle(Theme.Typography.caption11_5w400)
                .fontWeight(.semibold)
                .foregroundColor(OptionText.whyLabelColor)
            SourcedText(text: text, style: OptionText.whyStyle, color: OptionText.whyColor, target: target)
        }
        .padding(EdgeInsets(top: 9, leading: 12, bottom: 9, trailing: 12))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.list)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }

    static func title(isRecommended: Bool) -> String { isRecommended ? "Why I recommend it" : "Why" }
}

/// Level 2 of an option's text (WAG-288): the description, body 13 regular in ink2, one step under the
/// semibold ink title. Every view that shows an option's description uses this one view.
struct OptionDescriptionView: View {
    let text: String

    var body: some View {
        AgentMarkdownText(text: text, style: OptionText.descriptionStyle, color: OptionText.descriptionColor, showsSources: true)
    }
}

/// The three text levels of an option (WAG-288): the title, the description (`OptionDescriptionView`) and
/// the why (`CalmNoteView`, a small soft block with a label). One place for the values.
enum OptionText {
    static let descriptionStyle = Theme.Typography.body13w400
    static let descriptionColor = Theme.Colors.ink2
    static let whyStyle = Theme.Typography.body12_5w400
    static let whyColor = Theme.Colors.ink2
    static let whyLabelColor = Theme.Colors.ink3
}

/// The type and sizes of the option cards, from the case map mockup CSS (decision 2026-11-10; 1 CSS px = 1 pt).
/// CSS line heights go through `cssLine`, so a line box is `lineHeight × size` as in the browser.
enum OptionCardStyle {
    /// The exact Inter Tight face: `Font.custom("Inter Tight").weight(.semibold)` draws heavier than the mockup's 600.
    static func sans(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> Font {
        .custom(PromptBarLogic.sansFaceName(for: weight), size: size)
    }
    /// `.ch b`: Inter Tight 600 13.5, line height 1.45 (inherited). Drawn by `CSSText`.
    static let title = Theme.TextStyle(font: sans(13.5, .semibold), size: 13.5, lineHeight: nil, letterSpacing: nil)
    /// `.x`, `.tl`: Inter Tight 400 12, line height 1.45.
    static let body = Theme.TextStyle(font: sans(12), size: 12, lineHeight: nil, letterSpacing: nil)
    /// `.rec`: Inter Tight 600 10.5, line height 1.
    static let tag = Theme.TextStyle(font: sans(10.5, .semibold), size: 10.5, lineHeight: nil, letterSpacing: nil)
    /// `.key`: JetBrains Mono 400 10.5, line height 1.
    static let key = Theme.TextStyle(font: .custom(Theme.FontFamily.mono, size: 10.5), size: 10.5, lineHeight: nil, letterSpacing: nil)
    /// `.ol`: Inter Tight 600 10.5, line height 1, letter spacing .06em, upper case.
    static let label = Theme.TextStyle(font: sans(10.5, .semibold), size: 10.5, lineHeight: nil, letterSpacing: 0.63)
    /// `.ol u`: Inter Tight 500 12, underlined 2 pt under the text.
    static let labelLink = Theme.TextStyle(font: sans(12, .medium), size: 12, lineHeight: nil, letterSpacing: nil)
    static let lineHeight: CGFloat = 1.45

    /// `.radio`, `.box`: 16, border 1.5. The dot of a picked radio is 8; the box tick is "✓" 11.
    static let markSize: CGFloat = 16
    static let markBorder: CGFloat = 1.5
    static let dotSize: CGFloat = 8
    static let boxRadius: CGFloat = 4
    /// `.key`, `.rec`: radius 5.
    static let badgeRadius: CGFloat = 5
    /// The key badge's height (`.key`: 10.5 + 2 × 3 + 2 × 1). Lean and Rule out take the same height.
    static let keyHeight: CGFloat = 18.5
    /// `.choice` border.
    static let borderWidth: CGFloat = 1
    /// `.ch` padding 9 / 12, `.ch.slim` 7 / 12, item gap 10; `.x` and `.tl` start under the title (12 + 16 + 10).
    static let openHeaderPadding: CGFloat = 9
    static let slimHeaderPadding: CGFloat = 7
    static let sidePadding: CGFloat = 12
    static let itemGap: CGFloat = 10
    static let textIndent: CGFloat = 38
    /// `.x` bottom 11, `.x .d` margin 6, `.pc` gap 3 / 14, mark margin 5, `.because` margin 7 + padding 6.
    static let openBottom: CGFloat = 11
    static let descriptionGap: CGFloat = 6
    static let gridRowGap: CGFloat = 3
    static let gridColumnGap: CGFloat = 14
    static let gridMarkGap: CGFloat = 5
    static let becauseTop: CGFloat = 7
    static let becausePadding: CGFloat = 6
    /// `.tl`: bottom 9, gap 14, mark margin 4.
    static let teaserBottom: CGFloat = 9
    static let teaserGap: CGFloat = 14
    static let teaserMarkGap: CGFloat = 4
    /// `.ol` margin below 8.
    static let labelGap: CGFloat = 8
    /// Space between the blue update strip and the list label under it, so the label does not touch the strip.
    static let updateHeaderGap: CGFloat = 10
}

extension OptionCardStyle {
    /// The height SwiftUI gives one line of the bundled fonts at the card sizes, measured (it rounds each line to
    /// whole points, so it is not `size × 1.21`): Inter Tight 10.5 → 14, 12 → 15, 13.5 → 17; JetBrains Mono 10.5 → 14.
    /// Other sizes fall back to the font's own line height, rounded up.
    static func drawnLineHeight(size: CGFloat, mono: Bool) -> CGFloat {
        switch (size, mono) {
        case (10.5, _): 14
        case (12, false): 15
        case (13.5, false): 17
        default: (size * (mono ? Theme.Typography.monoNaturalLineHeight : Theme.Typography.sansNaturalLineHeight)).rounded(.up)
        }
    }
}

extension View {
    /// A CSS `line-height: lineHeight` on text of `size`: the room between lines, and half of the difference to
    /// the drawn line height above and below (negative under it, as `/1` is in CSS), so a line box is
    /// `lineHeight × size` as in the mockup.
    func cssLine(size: CGFloat, lineHeight: CGFloat, mono: Bool = false) -> some View {
        let extra = size * lineHeight - OptionCardStyle.drawnLineHeight(size: size, mono: mono)
        return self
            .lineSpacing(max(0, extra))
            .padding(.vertical, extra / 2)
    }
}

/// The label over an option list (mockup `.ol`): "YOUR CHOICE", or for pick-several the header with its links.
struct OptionListLabel: View {
    var text: String = CalmOption.listLabel
    var color: Color = Theme.AskDoc.Colors.quiet

    var body: some View {
        Text(text.uppercased())
            .knockTextStyle(OptionCardStyle.label)
            .foregroundColor(color)
            .lineLimit(1)
            .cssLine(size: 10.5, lineHeight: 1)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The leading mark of a card: a radio (pick one) or a box (pick several), honey when picked.
struct OptionMark: View {
    let isCheckbox: Bool
    let isOn: Bool

    var body: some View {
        let border = isOn ? Theme.Colors.honey600 : Theme.Colors.line2
        Group {
            if isCheckbox {
                RoundedRectangle(cornerRadius: OptionCardStyle.boxRadius)
                    .fill(isOn ? Theme.Colors.honey600 : Color.clear)
                    .overlay(RoundedRectangle(cornerRadius: OptionCardStyle.boxRadius).strokeBorder(border, lineWidth: OptionCardStyle.markBorder))
                    .overlay {
                        if isOn {
                            // Inter Tight's own ✓, as the mockup draws it.
                            Text("✓").font(OptionCardStyle.sans(11)).foregroundColor(Theme.Colors.onFill)
                        }
                    }
            } else {
                Circle()
                    .strokeBorder(border, lineWidth: OptionCardStyle.markBorder)
                    .overlay {
                        if isOn { Circle().fill(Theme.Colors.honey600).frame(width: OptionCardStyle.dotSize, height: OptionCardStyle.dotSize) }
                    }
            }
        }
        .frame(width: OptionCardStyle.markSize, height: OptionCardStyle.markSize)
        .accessibilityHidden(true)
    }
}

/// The key badge at the right end of a card (mockup `.key`): the option's number key.
struct OptionKeyBadge: View {
    let position: Int

    var body: some View {
        Text("\(position)")
            .knockTextStyle(OptionCardStyle.key)
            .foregroundColor(Theme.AskDoc.Colors.quiet)
            .lineLimit(1)
            .fixedSize()
            .cssLine(size: 10.5, lineHeight: 1, mono: true)
            .padding(EdgeInsets(top: 3, leading: 5, bottom: 3, trailing: 5))
            .padding(1)
            .overlay(RoundedRectangle(cornerRadius: OptionCardStyle.badgeRadius).strokeBorder(Theme.Colors.line2, lineWidth: 1))
            .help("Press \(position)")
            .accessibilityLabel("Key \(position)")
    }
}

/// One option card of the decision column (decision 2026-11-10, mockup `.choice`): radio or box, the title,
/// "★ Recommended" right after it, then Lean ◐, Rule out × and the key badge at the right end. The open card (the
/// pick, else the recommendation) is variant `gist` of the option text mockup (task 11b): its fact chips, the
/// description on one line, the gists in two plain columns under quiet PROS / CONS labels with hanging + / –, the
/// reason under a dashed line, and "Show the full points" for every full point, effect, description and reason. A
/// closed card shows its fact chips (or the first words of its first pro and con) and "+N –N", and its details in a
/// tooltip.
struct CompactOptionRow: View {
    let position: Int
    let title: String
    var description: String? = nil
    var pros: [String] = []
    var cons: [String] = []
    var effects: [String] = []
    var note: String? = nil
    /// Task 11b: the option's facts, and its points with their gists. `nil` points read `pros` / `cons` as full points.
    var facts: [String] = []
    var proPoints: [OptionPoint]? = nil
    var conPoints: [OptionPoint]? = nil
    let isSelected: Bool
    var isRecommended = false
    var isLocked = false
    /// The card shows its details in place (`CalmOption.openPosition`).
    var isOpen = false
    /// Lean and rule out (WAG-301). The two icons show when `onLean` and `onRuleOut` are set and the row is not locked.
    var isLeaning = false
    var isRuledOut = false
    var onLean: (() -> Void)? = nil
    var onRuleOut: (() -> Void)? = nil
    /// A pick-many row (WAG-329): a box in place of the radio, and the tick is the state. Same card, same tag,
    /// same tooltip as a single ask. `isLimitDimmed` is an unticked row once the ticks reach `max`.
    var isCheckbox = false
    var isLimitDimmed = false
    /// The screen on show in a screenshots set is this option's variant (decision record 2026-11-12). It never picks.
    var isOnScreen = false
    let onSelect: () -> Void

    @State private var showsTip = false
    @State private var hoverTask: Task<Void, Never>?
    /// The press state is read in no body, so it lives in a class: a write does not draw the row again.
    @State private var press = PressState()
    @FocusState private var isFocused: Bool
    /// "Show the full points" is open.
    /// Evidence only: `KNOCK_EVIDENCE_FULL_POINTS=1` opens it on every card, for the renders.
    @State private var showsFull = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_FULL_POINTS"] == "1"
    /// The width of the text under the title, for the cuts at a whole word. 0 before the first layout: nothing is cut.
    @State private var textWidth: CGFloat = 0
    /// The room for the title and its tag, between the mark and the icons.
    @State private var titleRoom: CGFloat = 0

    private var proList: [OptionPoint] { proPoints ?? pros.map { OptionPoint(detail: $0) } }
    private var conList: [OptionPoint] { conPoints ?? cons.map { OptionPoint(detail: $0) } }
    private var proDetails: [String] { proList.map(\.detail) }
    private var conDetails: [String] { conList.map(\.detail) }
    private var hasTip: Bool {
        !isOpen && Self.hasTip(description: description, pros: proDetails, cons: conDetails, effects: effects, note: note)
    }
    private var hasDiscuss: Bool { !isLocked && onLean != nil && onRuleOut != nil }
    private var rowFill: Color {
        isSelected ? Theme.Colors.pickedFill : isLeaning ? Theme.Colors.dsSoft : Theme.Colors.win
    }

    /// The tooltip opens for a row with a description, a list (Good, Watch out or effects) or a note.
    static func hasTip(description: String?, pros: [String], cons: [String], effects: [String] = [], note: String?) -> Bool {
        description != nil || !pros.isEmpty || !cons.isEmpty || !effects.isEmpty || note != nil
    }

    /// "Recommended" is part of the spoken label of the recommended option.
    static func accessibilityLabel(title: String, isRecommended: Bool) -> String {
        isRecommended ? "\(title), \(CalmOption.recommendedPill)" : title
    }

    private static func stamp() -> String { String(format: "%.1f", ProcessInfo.processInfo.systemUptime * 1000) }

    var body: some View {
        let _ = RunLoopTurnProbe.startIfLogging()
        let _ = isSelected && EvidenceLayoutLog.enabled ? { RunLoopTurnProbe.wantsDrawn = true }() : ()
        let _ = isSelected ? EvidenceLayoutLog.event("opt.sel", "t=\(Self.stamp()) pos=\(position) tip=\(showsTip)") : ()
        VStack(alignment: .leading, spacing: 0) {
            header
            if isOpen {
                openBody
            } else {
                closedLine
            }
        }
        // The 1 pt border sits outside the padding, as in CSS (`border-box`): the content starts 1 pt in.
        .padding(OptionCardStyle.borderWidth)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(rowFill)
        .clipShape(RoundedRectangle(cornerRadius: CalmOption.rowRadius))
        .overlay(border)
        .opacity(
            isLimitDimmed && !isSelected ? OptionChipView.limitDimmedOpacity
                : isLocked && !isSelected ? 0.45 : isRuledOut ? CalmOption.ruledOutOpacity : 1
        )
        .contentShape(RoundedRectangle(cornerRadius: CalmOption.rowRadius))
        // The row acts on the press, not on the release (WAG-379): the pick shows at once, and a tooltip that is
        // open or about to open never holds it back. A tooltip window can take the release of a click that opened
        // it, so a tap gesture there could wait for the tooltip, or never fire.
        .gesture(DragGesture(minimumDistance: 0).onChanged { _ in pressRow() }.onEnded { _ in press.isPressing = false })
        // The text takes its own clicks, so it can be selected; a click on it that selects nothing picks, on the release.
        .onCSSTextClick { pressRow(); press.isPressing = false }
        .modifier(PickCursor(isOn: !isLocked))
        .focusable(hasTip).focused($isFocused).focusEffectDisabled()
        .onChange(of: showsTip) { _, shown in EvidenceLayoutLog.event("opt.tipOn", "t=\(Self.stamp()) shown=\(shown) focus=\(isFocused)") }
        .onChange(of: isFocused) { _, focused in
            if focused {
                // A click focuses the row too, but only keyboard focus opens the tooltip.
                showsTip = hasTip && !CalmOption.isPointerFocus(press.at.map { $0.duration(to: .now) })
            } else { hideTip() }
        }
        .onChange(of: isOpen) { _, open in if open { hideTip() } }
        .onHover { inside in
            hoverTask?.cancel()
            if inside, hasTip {
                hoverTask = Task {
                    try? await Task.sleep(for: .seconds(CalmOption.tooltipDelay))
                    if !Task.isCancelled { showsTip = true }
                }
            } else {
                showsTip = false
            }
        }
        .background(
            OptionTipPresenter(isPresented: showsTip && hasTip, onDismiss: { showsTip = false }) {
                OptionTooltipView(description: description, pros: proDetails, cons: conDetails, effects: effects, note: note, isRecommended: isRecommended, facts: facts)
            })
        .overlay(alignment: .top) {
            // Evidence only: a popover is its own window, which the window snapshot cannot see, so
            // `KNOCK_EVIDENCE_OPTION_TIP=<position>` draws the same tooltip content above that row.
            if hasTip, ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_OPTION_TIP"] == String(position) {
                OptionTooltipView(description: description, pros: proDetails, cons: conDetails, effects: effects, note: note, isRecommended: isRecommended, facts: facts)
                    .fixedSize(horizontal: false, vertical: true)
                    .background(Theme.Colors.win)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.Colors.line, lineWidth: 1))
                    .frame(height: 0, alignment: .bottom)
                    .offset(y: -6)
            }
        }
        .zIndex(ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_OPTION_TIP"] == String(position) ? 1 : 0)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Self.accessibilityLabel(title: title, isRecommended: isRecommended))
        .accessibilityHint(description.map { AgentMarkdown.singleLine($0) } ?? "")
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(
            (isCheckbox
                ? OptionChipView.checkboxAccessibilityValue(isSelected: isSelected, isLocked: isLocked)
                : OptionChipView.accessibilityValue(isSelected: isSelected, isLocked: isLocked))
                + (isLeaning ? "leaning" : isRuledOut ? "ruled out" : ""))
    }

    /// `.choice`: 1 pt `line` inside the card; picked `.choice.on`: 1 pt `honey500` plus a 1 pt ring outside it.
    /// Leaning (no mockup) keeps its blue 1.5 pt edge.
    @ViewBuilder
    private var border: some View {
        let shape = RoundedRectangle(cornerRadius: CalmOption.rowRadius)
        if isSelected {
            shape.stroke(Theme.Colors.honey500, lineWidth: 2)
        } else if isLeaning {
            shape.strokeBorder(Theme.Colors.ds, lineWidth: 1.5)
        } else {
            shape.strokeBorder(Theme.Colors.line, lineWidth: 1)
        }
    }

    private var displayedTitle: String {
        AgentMarkdown.singleLine(OptionLabelFormatting.cutAtWord(title, limit: OptionLabelFormatting.maxRowTitleLength))
    }

    private var titleText: some View {
        CSSText(
            runs: [.init(text: displayedTitle, semibold: true, color: Theme.Colors.ink, strikethrough: isRuledOut)],
            size: OptionCardStyle.title.size)
            .accessibilityHidden(true)
    }

    /// `.ch`: the mark, the title and its tag, then Lean, Rule out and the key at the right end.
    private var header: some View {
        HStack(spacing: OptionCardStyle.itemGap) {
            OptionMark(isCheckbox: isCheckbox, isOn: isSelected)
            // The title and its tag take the room left of the icons. The tag gives way before the title does: the word
            // goes first, then only the star is left. The choice is measured, so the whole tag shows whenever it fits.
            HStack(spacing: OptionCardStyle.itemGap) {
                titleText.layoutPriority(1)
                if isLocked && isSelected {
                    tag("✓ Your answer", Theme.Colors.ink2, Theme.Colors.side).fixedSize()
                } else if isRecommended {
                    if CalmOption.fitsFullRecommendedTag(title: displayedTitle, room: titleRoom) {
                        tag("\(CalmOption.recommendedMark) \(CalmOption.recommendedPill)", Theme.Colors.recommendedTagText, Theme.Colors.honeySoft)
                            .fixedSize()
                    } else {
                        tag(CalmOption.recommendedMark, Theme.Colors.recommendedTagText, Theme.Colors.honeySoft)
                            .fixedSize()
                            .help(CalmOption.recommendedPill)
                    }
                }
                if isOnScreen { onScreenChip.fixedSize() }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { titleRoom = $0 }
            HStack(spacing: 4) {
                // Lean and Rule out (no mockup) sit right before the key, at its height, on every card.
                if hasDiscuss { discussMarks }
                OptionKeyBadge(position: position)
            }
            .fixedSize()
        }
        .padding(.vertical, isOpen ? OptionCardStyle.openHeaderPadding : OptionCardStyle.slimHeaderPadding)
        .padding(.horizontal, OptionCardStyle.sidePadding)
    }

    // MARK: Open card (variant `gist`)

    private typealias Gist = GistCardStyle

    /// The one-line description and reason are cut at a whole word only once the width is known.
    private func fits(_ text: String, extra: CGFloat = 0) -> Bool {
        textWidth <= 0 || CSSText.lineWidth(text) + extra <= textWidth
    }

    private var descriptionLine: String? { description.map(OptionGist.flatLine) }
    private var descriptionCut: (text: String, isCut: Bool)? {
        descriptionLine.map { OptionGist.cutAtWord($0, fits: { fits($0) }) }
    }
    private var reasonLead: String { "\(CalmNoteView.title(isRecommended: isRecommended)):" }
    private var reasonCut: (text: String, isCut: Bool)? {
        let leadWidth = CSSText.lineWidth(reasonLead + " ", semibold: true)
        return note.map { OptionGist.cutAtWord(OptionGist.flatLine($0), fits: { fits($0, extra: leadWidth) }) }
    }
    private var hasHiddenDetail: Bool {
        OptionGist.hasHiddenDetail(
            pros: proList, cons: conList, effects: effects, facts: facts,
            descriptionCut: descriptionCut?.isCut ?? false, reasonCut: reasonCut?.isCut ?? false)
    }

    /// `.x`: the fact chips, the description on one line, the gists in two columns, the reason under a dashed line and
    /// "Show the full points". Open, the full points replace the gists and the full description and reason show.
    private var openBody: some View {
        let shownFacts = OptionGist.shownFacts(facts)
        let hasPoints = !proList.isEmpty || !conList.isEmpty
        return VStack(alignment: .leading, spacing: 0) {
            if !shownFacts.isEmpty { FactChips(facts: shownFacts) }
            if let description, let cut = descriptionCut {
                Group {
                    if showsFull {
                        fullText(description, color: Theme.Colors.ink2, lineHeight: Gist.descriptionLineHeight)
                    } else {
                        CSSText(runs: CSSText.inlineRuns(cut.text, color: Theme.Colors.ink2), lineHeight: Gist.descriptionLineHeight)
                            .frame(height: 12 * Gist.descriptionLineHeight, alignment: .topLeading)
                            .clipped()
                            .accessibilityLabel(AgentMarkdown.singleLine(description))
                    }
                }
                .padding(.top, shownFacts.isEmpty ? 0 : Gist.descriptionTop)
                .padding(.bottom, hasPoints ? Gist.descriptionBottom : 0)
            }
            if hasPoints {
                Group {
                    if showsFull { fullPoints } else { gistColumns }
                }
                .padding(.top, (description == nil && !shownFacts.isEmpty ? Gist.gridAfterFacts : 0) + Gist.gridTop)
            }
            if showsFull { fullExtras }
            if let note, let cut = reasonCut {
                becauseLine(note: note, cut: cut)
                    .padding(.top, description == nil && !hasPoints && shownFacts.isEmpty ? 0 : Gist.becauseTop)
            }
            if hasHiddenDetail || showsFull {
                Button { showsFull.toggle() } label: {
                    Text(showsFull ? OptionGist.hideFull : OptionGist.showFull)
                        .font(OptionCardStyle.sans(12))
                        .foregroundColor(Theme.Colors.ink3)
                        .underline()
                        .cssLine(size: 12, lineHeight: OptionCardStyle.lineHeight)
                }
                .buttonStyle(.plain).pointerCursor()
                .padding(.top, Gist.footTop)
                .accessibilityLabel(showsFull ? "Hide the full points of \(title)" : "Show the full points of \(title)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { textWidth = $0 }
        .padding(EdgeInsets(
            top: 0, leading: OptionCardStyle.textIndent, bottom: OptionCardStyle.openBottom, trailing: OptionCardStyle.sidePadding))
    }

    /// Agent text in full: plain wrapped text (code as chips), or markdown and source pills through the shared view.
    @ViewBuilder
    private func fullText(_ text: String, color: Color, lineHeight: CGFloat = OptionCardStyle.lineHeight) -> some View {
        if OptionGist.isFlatLine(text) {
            CSSText(runs: CSSText.inlineRuns(text, color: color), lineHeight: lineHeight)
        } else {
            AgentMarkdownText(text: text, style: OptionCardStyle.body, color: color, showsSources: true)
                .cssLine(size: 12, lineHeight: lineHeight)
        }
    }

    /// `.pcg`: PROS and CONS, each a list of gists (the full point when there is no gist) with a hanging sign.
    private var gistColumns: some View {
        HStack(alignment: .top, spacing: Gist.columnGap) {
            pointColumn(OptionGist.prosLabel, proList, mark: "+", color: Theme.AskDoc.Colors.pro, word: "Pro", full: false)
            pointColumn(OptionGist.consLabel, conList, mark: "–", color: Theme.AskDoc.Colors.watch, word: "Con", full: false)
        }
    }

    /// The full points, one list under the other (long sentences read better at the card's width).
    private var fullPoints: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !proList.isEmpty {
                pointColumn(OptionGist.prosLabel, proList, mark: "+", color: Theme.AskDoc.Colors.pro, word: "Pro", full: true)
            }
            if !conList.isEmpty {
                pointColumn(OptionGist.consLabel, conList, mark: "–", color: Theme.AskDoc.Colors.watch, word: "Con", full: true)
            }
        }
    }

    @ViewBuilder
    private func pointColumn(_ label: String, _ points: [OptionPoint], mark: String, color: Color, word: String, full: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !points.isEmpty {
                GistHeadLabel(text: label).padding(.bottom, Gist.headLabelGap)
                VStack(alignment: .leading, spacing: Gist.pointGap) {
                    ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                        HangingLine(
                            mark: mark, color: color, text: full ? point.detail : point.shown,
                            lineHeight: full ? OptionCardStyle.lineHeight : Gist.pointLineHeight)
                            .accessibilityLabel(OptionGist.spokenPoint(point, word: word))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// Under the full points: "If you pick this" with the effects, and any fact past the third.
    @ViewBuilder
    private var fullExtras: some View {
        if !effects.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                GistHeadLabel(text: CalmOption.effectsTitle).padding(.bottom, Gist.headLabelGap)
                VStack(alignment: .leading, spacing: Gist.pointGap) {
                    ForEach(Array(effects.enumerated()), id: \.offset) { _, line in
                        HangingLine(mark: "→", color: Theme.AskDoc.Colors.quiet, text: line, lineHeight: OptionCardStyle.lineHeight)
                            .accessibilityLabel("\(CalmOption.effectsTitle): \(AgentMarkdown.singleLine(line))")
                    }
                }
            }
            .padding(.top, 10)
        }
        let extra = OptionGist.extraFacts(facts)
        if !extra.isEmpty { FactChips(facts: extra).padding(.top, 10) }
    }

    /// `.x .because`: "Why I recommend it:" in 600 ink2, the reason in ink3, on one line cut at a whole word; in full
    /// once "Show the full points" is open.
    private func becauseLine(note: String, cut: (text: String, isCut: Bool)) -> some View {
        let lead = CSSText.Run(text: reasonLead + " ", semibold: true, color: Theme.Colors.ink2)
        return Group {
            if showsFull || !cut.isCut, !OptionGist.isFlatLine(note) {
                SourcedText(text: CalmOption.becauseLine(note, isRecommended: isRecommended), style: OptionCardStyle.body, color: Theme.Colors.ink3)
                    .cssLine(size: 12, lineHeight: OptionCardStyle.lineHeight)
            } else if showsFull {
                CSSText(runs: [lead] + CSSText.inlineRuns(OptionGist.flatLine(note), color: Theme.Colors.ink3))
            } else {
                CSSText(runs: [lead] + CSSText.inlineRuns(cut.text, color: Theme.Colors.ink3))
                    .frame(height: 12 * OptionCardStyle.lineHeight, alignment: .topLeading)
                    .clipped()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(CalmOption.becauseLine(AgentMarkdown.singleLine(note), isRecommended: isRecommended))
        // The 1 pt dashed border, then its 6 pt padding.
        .padding(.top, 1 + OptionCardStyle.becausePadding)
        .overlay(alignment: .top) { DashedRule() }
    }

    // MARK: Closed card

    /// `.cl`: the fact chips and "+N –N →N" at the right. An option with no facts shows the first words of its first pro
    /// and first con instead of the chips, cut at a whole word.
    @ViewBuilder
    private var closedLine: some View {
        let tally = OptionGist.tally(pros: proList, cons: conList, effects: effects)
        let shown = OptionGist.shownFacts(facts)
        if !shown.isEmpty || tally != nil {
            HStack(alignment: .center, spacing: Gist.closedGap) {
                if !shown.isEmpty {
                    FactChips(facts: shown).layoutPriority(1)
                } else {
                    // The teaser never sets the card's width: it takes the room the column gives and clips, so the
                    // width measured below is the column's, and the cut fits it on the next pass.
                    closedTeaser(tally: tally)
                        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                        .clipped()
                }
                Spacer(minLength: 0)
                if let tally { TallyView(tally: tally).onHover { inside in if inside, hasTip { hoverTask?.cancel(); showsTip = true } } }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { textWidth = $0 }
            .accessibilityElement(children: .contain)
            .padding(EdgeInsets(
                top: 0, leading: OptionCardStyle.textIndent, bottom: OptionCardStyle.teaserBottom, trailing: OptionCardStyle.sidePadding))
        }
    }

    private func closedTeaser(tally: OptionGist.Tally?) -> some View {
        let markRoom = 12 + OptionCardStyle.teaserMarkGap
        let room = textWidth <= 0 ? CGFloat.greatestFiniteMagnitude : textWidth - (tally.map(TallyView.width) ?? 0) - Gist.closedGap
        let teaser = OptionGist.closedTeaser(
            pro: proList.first, con: conList.first, width: room, gap: OptionCardStyle.teaserGap,
            measure: { CSSText.lineWidth($0) + markRoom })
        return HStack(spacing: OptionCardStyle.teaserGap) {
            if let pro = teaser.pro, let point = proList.first {
                teaserPart("+", Theme.AskDoc.Colors.pro, pro).accessibilityLabel(OptionGist.spokenPoint(point, word: "Pro"))
            }
            if let con = teaser.con, let point = conList.first {
                teaserPart("–", Theme.AskDoc.Colors.watch, con).accessibilityLabel(OptionGist.spokenPoint(point, word: "Con"))
            }
        }
        .frame(height: 12 * OptionCardStyle.lineHeight)
        .clipped()
    }

    /// One closed-card part on one row, its sign inline.
    private func teaserPart(_ mark: String, _ color: Color, _ line: String) -> some View {
        CSSText(runs: [.init(text: mark, semibold: true, color: color, gapAfter: OptionCardStyle.teaserMarkGap)]
            + CSSText.inlineRuns(line, color: Theme.Colors.ink2))
        .fixedSize()
        .accessibilityElement(children: .ignore)
    }

    /// Lean ◐ and Rule out × (WAG-301).
    @ViewBuilder
    private var discussMarks: some View {
        if let onLean, let onRuleOut {
            DiscussIconButton(kind: .lean, isOn: isLeaning, optionTitle: title, action: onLean)
            DiscussIconButton(kind: .ruleOut, isOn: isRuledOut, optionTitle: title, action: onRuleOut)
        }
    }

    final class PressState {
        var isPressing = false
        var at: ContinuousClock.Instant?
    }

    /// One press: closes the tooltip and picks the row. `isPressing` keeps a held press from picking twice.
    private func pressRow() {
        guard !press.isPressing else { return }
        press.isPressing = true
        press.at = .now
        EvidenceLayoutLog.event("opt.tap", "t=\(Self.stamp()) pos=\(position)")
        hideTip()
        if CalmOption.acceptsPick(isLocked: isLocked, isLimitDimmed: isLimitDimmed, isSelected: isSelected) { onSelect() }
    }

    private func hideTip() { hoverTask?.cancel(); showsTip = false }

    /// `.rec`: 600 10.5 / 1, padding 3 / 6, radius 5.
    /// «On screen»: a honey dot and the words, in a thin outline, so it never reads as a pick or a recommendation.
    private var onScreenChip: some View {
        HStack(spacing: 4) {
            Circle().fill(Theme.Colors.honey500).frame(width: 6, height: 6)
            Text("On screen")
                .knockTextStyle(Theme.Typography.onScreenChip10w600)
                .foregroundColor(Theme.Colors.ink2)
                .lineLimit(1)
        }
        .padding(EdgeInsets(top: 2, leading: 5, bottom: 2, trailing: 5))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.Colors.line2, lineWidth: 1))
        .help("This option's screen is on show")
        .accessibilityLabel("On screen")
    }

    private func tag(_ text: String, _ color: Color, _ fill: Color) -> some View {
        Text(text)
            .knockTextStyle(OptionCardStyle.tag)
            .foregroundColor(color)
            .lineLimit(1)
            .cssLine(size: 10.5, lineHeight: 1)
            .padding(EdgeInsets(top: 3, leading: 6, bottom: 3, trailing: 6))
            .background(fill)
            .clipShape(RoundedRectangle(cornerRadius: OptionCardStyle.badgeRadius))
            .onHover { inside in if inside, hasTip { hoverTask?.cancel(); showsTip = true } }
    }
}

/// `.x .because`'s top edge: a 1 pt dashed `line2` rule.
private struct DashedRule: View {
    var body: some View {
        GeometryReader { proxy in
            Path { path in
                path.move(to: CGPoint(x: 0, y: 0.5))
                path.addLine(to: CGPoint(x: proxy.size.width, y: 0.5))
            }
            .stroke(Theme.Colors.line2, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
        }
        .frame(height: 1)
    }
}

/// The pointing hand over a row that can be picked. A locked row keeps its hover (its tooltip still opens) but
/// shows the plain arrow.
private struct PickCursor: ViewModifier {
    let isOn: Bool

    func body(content: Content) -> some View {
        if isOn { content.pointerCursor() } else { content }
    }
}

/// The right half of a disc. The lean icon (WAG-301, WAG-303) is an outline circle with this half filled:
/// off in quiet, on in `ds`.
struct HalfDiscShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let r = min(rect.width, rect.height) / 2
        let c = CGPoint(x: rect.midX, y: rect.midY)
        path.addArc(center: c, radius: r, startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: false)
        path.closeSubpath()
        return path
    }
}

/// The two small icon buttons before the key badge of an option card (WAG-301): lean (half circle) and rule out (×).
/// Both toggle. Each is focusable with a visible focus ring, and VoiceOver names the action and the option.
struct DiscussIconButton: View {
    enum Kind { case lean, ruleOut }

    let kind: Kind
    let isOn: Bool
    let optionTitle: String
    let action: () -> Void

    @FocusState private var isFocused: Bool
    @State private var hovered = false

    static func accessibilityLabel(kind: Kind, optionTitle: String) -> String {
        switch kind {
        case .lean: return "Lean to \(optionTitle)"
        case .ruleOut: return "Rule out \(optionTitle)"
        }
    }

    var body: some View {
        Button(action: action) {
            ZStack {
                switch kind {
                case .lean:
                    let color = isOn ? Theme.Colors.ds : Theme.AskDoc.Colors.quiet
                    ZStack {
                        Circle().stroke(color, lineWidth: 1.2)
                        HalfDiscShape().fill(color)
                    }
                    .frame(width: 11, height: 11)
                case .ruleOut:
                    if isOn {
                        Circle().fill(Theme.AskDoc.Colors.watch).frame(width: 14, height: 14)
                            .overlay(Image(systemName: "xmark").font(.system(size: 7, weight: .bold)).foregroundColor(Theme.Colors.win))
                    } else {
                        Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundColor(Theme.AskDoc.Colors.quiet)
                    }
                }
            }
            // The key badge's height, so the two icons and the key read as one group (no mockup).
            .frame(width: OptionCardStyle.keyHeight, height: OptionCardStyle.keyHeight)
            .background(hovered && !isOn ? Theme.Colors.hover : Color.clear)
            .clipShape(Circle())
            .overlay(Circle().stroke(Theme.Colors.ds, lineWidth: 2).opacity(isFocused ? 1 : 0))
            .contentShape(Circle())
        }
        .buttonStyle(.plain).pointerCursor()
        .focusable().focused($isFocused).focusEffectDisabled()
        .onHover { hovered = $0 }
        .help(kind == .lean ? CalmOption.leanTip : CalmOption.ruleOutTip)
        .accessibilityLabel(Self.accessibilityLabel(kind: kind, optionTitle: optionTitle))
        .accessibilityValue(isOn ? "on" : "off")
    }
}

/// The tooltip of a bar row: the full description, Good, Watch out and the why of that option.
struct OptionTooltipView: View {
    var description: String? = nil
    let pros: [String]
    let cons: [String]
    var effects: [String] = []
    var note: String? = nil
    var isRecommended = false
    /// The option's facts (task 11b), every one of them.
    var facts: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !facts.isEmpty { FactChips(facts: facts) }
            if let description { OptionDescriptionView(text: description) }
            GoodWatchOutView(pros: pros, cons: cons, columns: false)
            EffectsView(effects: effects)
            if let note { CalmNoteView(title: CalmNoteView.title(isRecommended: isRecommended), text: note) }
        }
        .padding(14)
        .frame(width: 320, alignment: .leading)
    }
}

/// One option card of a decision (WAG-281, decision 2026-11-10).
struct CalmOptionRowView: View {
    let option: Option
    let position: Int
    let isSelected: Bool
    let isRecommended: Bool
    var isLocked = false
    var recommendationWhy: String? = nil
    var isLeaning = false
    var isRuledOut = false
    var onLean: (() -> Void)? = nil
    var onRuleOut: (() -> Void)? = nil
    var isCheckbox = false
    var isLimitDimmed = false
    /// The card shows its details in place (`CalmOption.openPosition`).
    var isOpen = false
    var isOnScreen = false
    let onSelect: () -> Void

    var body: some View {
        CompactOptionRow(
            position: position, title: option.displayTitle,
            description: CalmOption.description(of: option, position: position),
            pros: option.pros, cons: option.cons, effects: option.effects,
            note: CalmOption.note(for: option, isRecommended: isRecommended, recommendationWhy: recommendationWhy),
            facts: option.facts, proPoints: option.proPoints, conPoints: option.conPoints,
            isSelected: isSelected, isRecommended: isRecommended, isLocked: isLocked, isOpen: isOpen,
            isLeaning: isLeaning, isRuledOut: isRuledOut, onLean: onLean, onRuleOut: onRuleOut,
            isCheckbox: isCheckbox, isLimitDimmed: isLimitDimmed, isOnScreen: isOnScreen, onSelect: onSelect)
    }
}

/// "YOUR PICK · 2" (or "RECOMMENDED · 2" before any pick) in the page (WAG-293): a honey-stroke card with the
/// title, the full description, Good and Watch out, and the why. A new pick swaps it with a 150 ms fade.
struct YourPickBlockView: View {
    let label: String
    /// `nil` for a recommendation that names no option (an older ask's free text): the card shows the why alone.
    let title: String?
    var description: String? = nil
    var pros: [String] = []
    var cons: [String] = []
    var effects: [String] = []
    var note: String? = nil
    var noteTitle = "Why"
    var columns = true
    /// Changes with the pick, so the card fades.
    let swapId: String
    /// WAG-357: the item and option the card speaks of. Its title, reason, Good and Watch out take comments.
    var commentIds: AskCommentIds? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topLeading) { content.id(swapId).transition(reduceMotion ? .identity : .opacity) }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .animation(reduceMotion ? nil : .easeOut(duration: CalmOption.blockFade), value: swapId)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(label)
                .knockTextStyle(Theme.AskDoc.Typography.monoLabel10_5)
                .foregroundColor(Theme.Colors.honey600)
                .lineLimit(1)
            if let title {
                if let ids = commentIds {
                    SourcedText(
                        text: AgentMarkdown.singleLine(title), style: Theme.Typography.value13_5w600, color: Theme.Colors.ink,
                        target: AskCommentTarget(.recommendation, itemId: ids.itemId, optionId: ids.optionId, slot: "title"), weight: .semibold)
                } else {
                    Text(AgentMarkdown.singleLine(title))
                        .knockTextStyle(Theme.Typography.value13_5w600)
                        .foregroundColor(Theme.Colors.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let description { OptionDescriptionView(text: description) }
            GoodWatchOutView(pros: pros, cons: cons, columns: columns, commentIds: commentIds)
            EffectsView(effects: effects, commentIds: commentIds)
            if let note {
                CalmNoteView(
                    title: noteTitle, text: note,
                    target: commentIds.map {
                        // The reason follows the title in the plain text of the recommendation.
                        let start = title.map { AskTextContent.plainLength(of: AgentMarkdown.singleLine($0), mode: .line) + 1 } ?? 0
                        return AskCommentTarget(.recommendation, itemId: $0.itemId, optionId: $0.optionId, slot: "reason", baseOffset: start)
                    })
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.win)
        .clipShape(RoundedRectangle(cornerRadius: CalmOption.cardRadius))
        .overlay(RoundedRectangle(cornerRadius: CalmOption.cardRadius).stroke(Theme.Colors.honey500, lineWidth: 1.5))
        .accessibilityElement(children: .contain)
    }
}

/// The page block of a simple decision. It watches the composer, so it follows the pick.
struct DecisionPickBlockView: View {
    @ObservedObject var composer: ComposerViewModel
    var isLocked = false
    var yourAnswerOptionId: String? = nil
    var columns = true

    var body: some View {
        if composer.isMultiSelect {
            manyCard
        } else if let block = CalmOption.pickBlock(
               options: composer.options,
               selectedId: isLocked ? yourAnswerOptionId : composer.selectedOptionId,
               recommendationId: composer.knockCase.recommendation,
               pickIsDefault: !isLocked && composer.pickIsDefault) {
            let isRecommended = block.option.id == composer.knockCase.recommendation
            YourPickBlockView(
                label: CalmOption.blockLabel(position: block.position, isPick: block.isPick),
                title: block.option.displayTitle,
                description: CalmOption.description(of: block.option, position: block.position),
                pros: block.option.pros, cons: block.option.cons, effects: block.option.effects,
                note: CalmOption.note(for: block.option, isRecommended: isRecommended, recommendationWhy: composer.knockCase.recommendationWhy),
                noteTitle: CalmNoteView.title(isRecommended: isRecommended),
                columns: columns, swapId: block.option.id + (block.isPick ? "" : "-rec"),
                commentIds: AskCommentIds(itemId: nil, optionId: block.option.id))
        }
    }

    /// A pick-several ask shows its recommendation as one card, "RECOMMENDED · 1 and 2", with the reason (WAG-334).
    /// It goes once the person ticks: their own ticks stand (WAG-329). The same card an item in a step has.
    @ViewBuilder
    private var manyCard: some View {
        if let card = Self.manyCard(
            options: composer.options, recommendations: composer.knockCase.recommendations,
            why: composer.knockCase.recommendationWhy, hasPick: composer.hasPick, isLocked: isLocked) {
            YourPickBlockView(
                label: card.label, title: card.title, note: card.note, noteTitle: CalmNoteView.title(isRecommended: true),
                columns: columns, swapId: "many-rec", commentIds: AskCommentIds(itemId: nil, optionId: nil))
        }
    }

    /// The words of the pick-several card, or `nil` when it does not show (locked, ticked, or nothing recommended).
    static func manyCard(
        options: [Option], recommendations: [String], why: String, hasPick: Bool, isLocked: Bool
    ) -> (label: String, title: String, note: String?)? {
        let picked = options.enumerated().filter { recommendations.contains($0.element.id) }
        guard !isLocked, !hasPick, !picked.isEmpty else { return nil }
        let reason = AgentMarkdown.singleLine(why, keepingSources: true)
        return (
            "RECOMMENDED · " + PromptBarLogic.positionList(picked.map { $0.offset + 1 }),
            picked.map { $0.element.displayTitle }.joined(separator: ", "), reason.isEmpty ? nil : reason)
    }
}

/// Wrapped card text laid out as the mockup's browser does (decision 2026-11-10): a fixed CSS line box
/// (`lineHeight × size`, the glyphs centred in it) and plain greedy wrapping. SwiftUI `Text` moves a word down so the
/// last line never holds a single word, so "+ The decision is in the first / screen" would break one word early.
/// The runs are plain text; a mark ("+", "–", "→") is a run with its own color and weight and a trailing gap.
/// A `code` run draws as the mockup's `code` chip. With `hanging`, the first run is a sign in its own column and every
/// wrapped line starts under the text (`.hl li`).
struct CSSText: NSViewRepresentable {
    struct Run: Equatable {
        let text: String
        var semibold = false
        var color: Color
        /// Extra room after the run (a CSS `margin-right` on a `::before`).
        var gapAfter: CGFloat = 0
        var strikethrough = false
        /// A `code` chip (mono 11.5 ink on side, 1 pt line border); a path in it shows as a `.path` chip.
        var code = false
    }

    let runs: [Run]
    /// A click on the text that selects nothing: the option card picks its option (`View.onCSSTextClick`).
    @Environment(\.cssTextClick) private var onClick
    var size: CGFloat = 12
    var lineHeight: CGFloat = OptionCardStyle.lineHeight
    /// The first run is a sign centred in a column; the other runs hang at `OptionGist.Hanging.textInset`.
    var hanging = false

    /// Splits agent text on backticks: plain runs in `color`, code runs as chips. An unclosed backtick stays as text.
    static func inlineRuns(_ text: String, color: Color) -> [Run] {
        let parts = text.components(separatedBy: "`")
        guard parts.count >= 3 else { return [Run(text: text, color: color)] }
        var out: [Run] = []
        for (index, part) in parts.enumerated() where !part.isEmpty {
            let isLastOdd = index == parts.count - 1 && index % 2 == 1
            if index % 2 == 1 && !isLastOdd {
                out.append(Run(text: part, color: Theme.Colors.ink, code: true))
            } else {
                out.append(Run(text: isLastOdd ? "`" + part : part, color: color))
            }
        }
        return out
    }

    var attributed: NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = size * lineHeight
        style.maximumLineHeight = size * lineHeight
        style.lineBreakMode = .byWordWrapping
        style.lineBreakStrategy = []
        let regular = NeedNumbers.tabular(PromptBarLogic.sansFont(size: size))
        let semibold = NeedNumbers.tabular(PromptBarLogic.sansFont(size: size, weight: .semibold))
        if hanging, let mark = runs.first {
            let markWidth = NSAttributedString(string: mark.text, attributes: [.font: mark.semibold ? semibold : regular]).size().width
            style.firstLineHeadIndent = OptionGist.Hanging.markOffset(markWidth: markWidth)
            style.headIndent = OptionGist.Hanging.textInset
            style.tabStops = [NSTextTab(textAlignment: .left, location: OptionGist.Hanging.textInset)]
            style.defaultTabInterval = OptionGist.Hanging.textInset
        }
        // TextKit puts the extra room of a fixed line above the glyphs; CSS splits it (half-leading).
        let extra = size * lineHeight - (regular.ascender - regular.descender)
        let out = NSMutableAttributedString()
        var chips: [(NSRange, TextChipKind)] = []
        for (index, run) in runs.enumerated() {
            var attributes: [NSAttributedString.Key: Any] = [
                .font: run.semibold ? semibold : regular, .foregroundColor: NSColor(run.color), .paragraphStyle: style,
                .baselineOffset: extra / 2,
            ]
            if run.gapAfter > 0 { attributes[.kern] = run.gapAfter }
            if run.strikethrough {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                attributes[.strikethroughColor] = NSColor(run.color)
            }
            let text = hanging && index == 0 ? run.text + "\t" : run.text
            let start = out.length
            out.append(NSAttributedString(string: text, attributes: attributes))
            if run.code { chips.append((NSRange(location: start, length: out.length - start), InlinePaths.isPath(run.text) ? .path : .code)) }
        }
        for (range, kind) in chips {
            ChipPainter.mark(out, range: range, kind: kind, ink: NSColor(Theme.Colors.ink), quiet: NSColor(Theme.AskDoc.Colors.quiet))
        }
        return out
    }

    var plainText: String { runs.map(\.text).joined(separator: hanging ? " " : "") }

    func makeNSView(context: Context) -> CSSTextNSView {
        let view = CSSTextNSView()
        view.text = attributed
        view.onClick = onClick
        return view
    }

    func updateNSView(_ view: CSSTextNSView, context: Context) {
        view.text = attributed
        view.onClick = onClick
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: CSSTextNSView, context: Context) -> CGSize? {
        fitSize(proposedWidth: proposal.width)
    }

    func fitSize(proposedWidth: CGFloat?) -> CGSize {
        let width = proposedWidth ?? .greatestFiniteMagnitude
        let text = attributed
        let used = CSSTextNSView.usedSize(text, width: width.isFinite ? width : 1e6)
        // The width the lines take, as a CSS flex item's: a title leaves the rest of the row to its tag. TextKit wraps a
        // line a little before its used width (about 2 pt), so the width grows until the drawing keeps the same lines;
        // else the view gets a width where a line wraps and the next line draws over it.
        var fit = min(ceil(used.width), width)
        while fit < width, CSSTextNSView.usedSize(text, width: fit).height > used.height + 0.5 { fit = min(fit + 1, width) }
        return CGSize(width: fit, height: ceil(used.height))
    }

    /// The width of one line of this text, for a cut at a whole word.
    static func lineWidth(_ text: String, size: CGFloat = 12, semibold: Bool = false, color: Color = Theme.Colors.ink) -> CGFloat {
        let css = CSSText(runs: inlineRuns(text, color: color).map { var r = $0; if !r.code { r.semibold = semibold }; return r }, size: size)
        return ceil(css.attributed.size().width)
    }
}

/// Draws `CSSText` as read-only text that can be selected and copied (operator review, 11 Nov). A click that
/// selects nothing goes to `onClick`, so the option card under it still picks; a drag or a double click selects.
final class CSSTextNSView: NSTextView {
    var text = NSAttributedString() {
        didSet {
            guard text != oldValue else { return }
            textStorage?.setAttributedString(text)
            setAccessibilityLabel(text.string.replacingOccurrences(of: "\t", with: " "))
        }
    }
    var onClick: (@MainActor @Sendable () -> Void)?

    init() {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        // Room to spare below: a frame rounded to the pixel can be a hair under the text's height, and no line that
        // does not fit whole is dropped.
        let container = NSTextContainer(size: NSSize(width: 0, height: 1e6))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = true
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        isRichText = false
        drawsBackground = false
        textContainerInset = .zero
        isVerticallyResizable = false
        isHorizontallyResizable = false
        focusRingType = .none
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .staticText }

    override func mouseDown(with event: NSEvent) {
        let before = window?.firstResponder
        super.mouseDown(with: event)  // tracks until the mouse is up
        guard selectedRange().length == 0 else { return }
        // A plain click: the card picks, and the focus goes back where it was (the reply field keeps the keys).
        if let before, before !== self { window?.makeFirstResponder(before) }
        onClick?()
    }

    override func resignFirstResponder() -> Bool {
        setSelectedRange(NSRange(location: 0, length: 0))
        return super.resignFirstResponder()
    }

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        guard let layoutManager, let textContainer else { return }
        ChipPainter.paint(layout: layoutManager, container: textContainer, origin: textContainerOrigin)
    }

    /// The size the text's lines take at `width`, laid out exactly as the view lays them out.
    static func usedSize(_ text: NSAttributedString, width: CGFloat) -> CGSize {
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: width, height: 1e6))
        container.lineFragmentPadding = 0
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        layout.ensureLayout(for: container)
        return layout.usedRect(for: container).size
    }
}

private struct CSSTextClickKey: EnvironmentKey {
    static let defaultValue: (@MainActor @Sendable () -> Void)? = nil
}

extension EnvironmentValues {
    var cssTextClick: (@MainActor @Sendable () -> Void)? {
        get { self[CSSTextClickKey.self] }
        set { self[CSSTextClickKey.self] = newValue }
    }
}

extension View {
    /// What a click on a `CSSText` inside this view does when it selects nothing.
    func onCSSTextClick(_ action: @escaping @MainActor @Sendable () -> Void) -> some View { environment(\.cssTextClick, action) }
}
