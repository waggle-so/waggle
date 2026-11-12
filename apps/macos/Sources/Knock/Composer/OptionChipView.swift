import SwiftUI

/// One row in the unified composer card's options section (docs/stories/
/// HAIL-54.md: Pen V1's row layout - one row each, hairline between, the
/// selected row filled `Theme.Colors.side` - with V3's numbered key badge in
/// place of a radio circle). Shared by `ComposerCardView`, so the case pane
/// and the review workspace's `AskColumnView` render one identical row rather
/// than each keeping its own copy (docs/stories/HAIL-25.md's original
/// duplication, folded here per the contract).
struct OptionChipView: View {
    let option: Option
    /// The row's 1-indexed badge number (contract: "each row starts with a
    /// 22 pt key badge showing 1, 2, 3…") - display order, not tied to the
    /// option's own id.
    let position: Int
    let isRecommended: Bool
    let isSelected: Bool
    /// The answer-lock state (docs/stories/HAIL-34.md operator report
    /// 21:11): once a reply exists for this round, the chosen option shows
    /// "Your answer" instead of "Recommended" and stays fully drawn; every
    /// other option dims to ~0.45 and stops responding to a tap.
    var isLocked: Bool = false
    /// A row of the first option set under "First options" (HAIL-108): drawn
    /// dimmed, with an empty badge, since keys 1..N pick the newest set only.
    var isFirstSetRow: Bool = false
    /// The recommended row's reason, on a second line under its title (HAIL-107); nil elsewhere.
    var recommendationWhy: String? = nil
    /// A select "many" row (HAIL-123): a check box in place of the number badge, with the number
    /// on the right. `isLimitDimmed` is an unticked row once the ticks reach `max`: drawn at 40%
    /// and it does not toggle.
    var isCheckbox = false
    var isLimitDimmed = false
    /// Shows the option's full text under its title (the decision doc has no separate Decision card).
    var showsFullLabel = false
    /// With `showsFullLabel`: only the selected row shows it (WAG-276).
    var fullLabelOnlyWhenSelected = false
    /// Shows the selected row's pros and cons under its text (WAG-276). The review panel and the plan page
    /// show them elsewhere, so they leave this off.
    var showsPoints = false
    /// Lean and rule out (WAG-301): drawn on the calm card's rows only.
    var isLeaning = false
    var isRuledOut = false
    var onLean: (() -> Void)? = nil
    var onRuleOut: (() -> Void)? = nil
    /// The card shows its details in place: the pick, else the recommendation (`CalmOption.openPosition`).
    var isOpen = false
    /// «On screen»: the screen on show in a screenshots set is this option's variant. It never picks.
    var isOnScreen = false
    let onSelect: () -> Void

    /// Rows are the calm card's compact rows everywhere (WAG-303); a pick-many row is the same row with a check box
    /// (WAG-329). Only the dimmed first set keeps the plain row.
    private var isCalm: Bool { true }

    /// The reason shows on the recommended row of the current set, while it can still be picked.
    private var whyLine: String? {
        guard !isLocked, !isFirstSetRow, isRecommended || (showsFullLabel && isSelected) else { return nil }
        return CalmOption.note(for: option, isRecommended: isRecommended, recommendationWhy: recommendationWhy)
    }

    /// The full text under the title, unless it only repeats the title.
    private var fullLabel: String? {
        guard showsFullLabel, isSelected || !fullLabelOnlyWhenSelected else { return nil }
        let body = OptionLabelFormatting.decisionBody(label: option.label, title: option.displayTitle)
        return DecisionSectionView.Entry(position: position, title: option.displayTitle, label: body, isRecommended: false).showsLabel ? body : nil
    }

    private var isDimmed: Bool { isLocked && !isSelected }
    private var rowOpacity: Double {
        if isLimitDimmed && !isSelected { return Self.limitDimmedOpacity }
        return isDimmed ? 0.45 : (isFirstSetRow && !isSelected ? 0.6 : 1)
    }
    static let limitDimmedOpacity = 0.4

    var body: some View {
        if isCalm {
            CalmOptionRowView(
                option: option, position: position, isSelected: isSelected, isRecommended: isRecommended,
                isLocked: isLocked, recommendationWhy: recommendationWhy,
                isLeaning: isLeaning, isRuledOut: isRuledOut, onLean: onLean, onRuleOut: onRuleOut,
                isCheckbox: isCheckbox, isLimitDimmed: isLimitDimmed, isOpen: isOpen, isOnScreen: isOnScreen, onSelect: onSelect)
            // The older set is the same bar row, dimmed (WAG-336).
            .opacity(isFirstSetRow && !isSelected ? 0.6 : 1)
        } else {
            classicBody
        }
    }

    private var classicBody: some View {
        HStack(alignment: whyLine == nil ? .center : .top, spacing: 10) {
            if isCheckbox { CheckBoxMark(isTicked: isSelected) } else { keyBadge }
            VStack(alignment: .leading, spacing: 2) {
                // HAIL-99: a long title wraps up to 3 lines; past that it is cut at a word.
                Text(OptionLabelFormatting.cutAtWord(option.displayTitle, limit: OptionLabelFormatting.maxRowTitleLength))
                    .knockTextStyle(Theme.Typography.optionLabel13w500)
                    .foregroundColor(Theme.Colors.ink)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                if let fullLabel {
                    OptionDescriptionView(text: fullLabel)
                }
                if showsPoints, isSelected, option.hasPoints {
                    ProsConsView(option: option).padding(.top, 4)
                }
                if let whyLine {
                    CalmNoteView(title: CalmNoteView.title(isRecommended: isRecommended), text: whyLine)
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
            if isLocked && isSelected {
                yourAnswerTag
            } else if isRecommended {
                recommendedTag
            } else if isCheckbox {
                Text("\(position)")
                    .knockTextStyle(Theme.Typography.keyBadge12w600)
                    .foregroundColor(Theme.Colors.ink3)
            }
        }
        .padding(EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isSelected ? Theme.Colors.honeySoft : Color.clear)
        .opacity(rowOpacity)
        .contentShape(Rectangle())
        .onTapGesture { if !isLocked && !(isLimitDimmed && !isSelected) { onSelect() } }.pointerCursor()
        .allowsHitTesting(!isLocked)
        .accessibilityElement(children: .ignore)
        .help(OptionLabelFormatting.displayLabel(option.label))
        .accessibilityLabel(option.displayTitle)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(
            isCheckbox
                ? Self.checkboxAccessibilityValue(isSelected: isSelected, isLocked: isLocked)
                : Self.accessibilityValue(isSelected: isSelected, isLocked: isLocked))
    }

    /// The numbered badge that replaces the old radio circle (contract: "22
    /// pt key badge …, 1 pt line2 stroke, radius 5, mono 12 pt semibold; the
    /// selected row's badge is filled ink with white number").
    private var keyBadge: some View {
        Text(isFirstSetRow ? "" : "\(position)")
            .knockTextStyle(Theme.Typography.keyBadge12w600)
            .foregroundColor(Theme.Colors.ink)
            .frame(width: 22, height: 22)
            .background(isSelected ? Theme.Colors.honey500 : Color.clear)
            .cornerRadius(Theme.Radius.chip)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.chip)
                    .stroke(isSelected ? Color.clear : Theme.Stroke.card.color, lineWidth: Theme.Stroke.card.width)
            )
    }

    private var recommendedTag: some View {
        HStack(spacing: 4) {
            Image(systemName: "sparkles")
                .font(.system(size: 11))
                .foregroundColor(Theme.Colors.recommendedTagText)
            Text("Recommended")
                .knockTextStyle(Theme.Typography.tagLabel10_5w500)
                .foregroundColor(Theme.Colors.recommendedTagText)
        }
    }

    private var yourAnswerTag: some View {
        HStack(spacing: 4) {
            Image(systemName: "checkmark")
                .font(.system(size: 11))
                .foregroundColor(Theme.Colors.ink2)
            Text("Your answer")
                .knockTextStyle(Theme.Typography.tagLabel10_5w500)
                .foregroundColor(Theme.Colors.ink2)
        }
    }
}

/// The check box of a select "many" row: the option card's box (mockup `.box`: 16, radius 4, 1.5 `line2`; ticked
/// `honey600` with a white ✓ 11), in a 22 pt slot like the number badge.
struct CheckBoxMark: View {
    let isTicked: Bool
    static let size = OptionCardStyle.markSize
    static let radius = OptionCardStyle.boxRadius

    var body: some View {
        OptionMark(isCheckbox: true, isOn: isTicked)
            .frame(width: 22, height: 22)
    }
}

extension OptionChipView {
    /// A check box row announces its tick state, not a pick (HAIL-123).
    static func checkboxAccessibilityValue(isSelected: Bool, isLocked: Bool) -> String {
        guard isSelected else { return "not ticked" }
        return isLocked ? "your answer" : "ticked, click again to untick"
    }

    /// Whether one option's chip reads as selected (docs/stories/HAIL-36.md):
    /// the reply's own choice once locked, never the composer's live
    /// selection - a locked chip must show nothing selected when the reply
    /// carried no choice, even if the composer still holds a stale selection
    /// from before the case locked. Pulled out as a pure function (the same
    /// pattern as `CasePaneDetailView.footerKind`) so "no choice sent, no
    /// option marked" is unit-testable without hosting the view.
    static func isSelected(optionId: String, isLocked: Bool, yourAnswerOptionId: String?, selectedOptionId: String?) -> Bool {
        optionId == (isLocked ? yourAnswerOptionId : selectedOptionId)
    }

    /// The chip's VoiceOver value (docs/stories/HAIL-43.md AC: "the option
    /// announces 'selected, click again to clear'") - a pure function, the
    /// same pattern as `isSelected` above, so it is unit-testable without
    /// hosting the view. A locked chip cannot be cleared by tapping it, so
    /// its selected state reads "your answer" instead.
    static func accessibilityValue(isSelected: Bool, isLocked: Bool) -> String {
        guard isSelected else { return "" }
        return isLocked ? "your answer" : "selected, click again to clear"
    }
}
