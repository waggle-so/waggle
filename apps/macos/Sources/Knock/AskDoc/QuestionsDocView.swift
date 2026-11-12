import SwiftUI

/// Wraps its children onto new lines, like text. Used for answer chips.
struct ChipFlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxX, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

/// One question of the doc: "QUESTION n OF N", the title, the artifact cards, "How it works now" folded,
/// "TO DECIDE · n" and a card per point.
struct QuestionSectionView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let question: Question
    @Binding var doc: QuestionsDocModel
    let cards: [ArtifactCardModel]
    let selectedCardId: String?
    let lastTarget: (Bool) -> ArtifactOpenTarget
    let onOpen: (ArtifactCardModel, ArtifactOpenTarget) -> Void
    /// False on a step: the page above already shows the question as its title.
    var showsHeader = true
    /// False on a step: the points sit in the bottom bar (WAG-291), not in the page.
    var showsPoints = true
    /// True on a step: "YOUR PICK" blocks for the points with option cards (WAG-293).
    var showsPicks = false
    @State private var nowOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if showsHeader {
                Text(doc.sectionLabel(of: question))
                    .knockTextStyle(Theme.AskDoc.Typography.monoLabel10_5)
                    .foregroundColor(Theme.Colors.ink3)
                    .padding(.bottom, 6)
                SourcedText(
                    text: question.title, style: Theme.AskDoc.Typography.questionTitle23, color: Theme.Colors.ink,
                    target: AskCommentTarget(.question, itemId: question.id), weight: .semibold)
                    .textSelection(.enabled)
            }
            if showsPicks { picks }
            if !cards.isEmpty {
                ArtifactCardsView(cards: cards, selectedId: selectedCardId, lastTarget: lastTarget, onOpen: onOpen)
                    .padding(.top, showsHeader ? 14 : 0)
            }
            if let lines = question.now, !lines.isEmpty { nowSection(lines).padding(.top, 10) }
            if showsPoints {
                Text(QuestionsDocModel.toDecideLabel(question))
                    .knockTextStyle(Theme.AskDoc.Typography.monoLabel10_5)
                    .foregroundColor(Theme.Colors.honey600)
                    .padding(.top, 16).padding(.bottom, 6)
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(Array(question.points.enumerated()), id: \.element.id) { index, point in
                        ItemRowsView(number: index + 1, point: point, questionId: question.id, pointCount: question.points.count, doc: $doc)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The card of each point (WAG-326), only where the rows do not already say it: an older ask's why and a
    /// reply's suggested text (C3).
    @ViewBuilder
    private var picks: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(doc.pagePointBlocks(of: question), id: \.swapId) { block in
                ItemBlockView(block: block)
            }
        }
        .padding(.top, showsHeader ? 14 : 0)
    }

    private func nowSection(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { ReducedMotion.animate(reduceMotion: reduceMotion, .easeOut(duration: 0.15)) { nowOpen.toggle() } } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(nowOpen ? 90 : 0))
                    Text(QuestionsDocModel.nowLabel(lines))
                        .knockTextStyle(Theme.Typography.body13w400)
                }
                .foregroundColor(Theme.Colors.ink3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerCursor()
            .accessibilityValue(nowOpen ? "open" : "folded")
            if nowOpen {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("•")
                            Text(AgentMarkdown.singleLine(line)).fixedSize(horizontal: false, vertical: true)
                        }
                        .knockTextStyle(Theme.Typography.body13_5w400)
                        .foregroundColor(Theme.Colors.ink2)
                    }
                }
                .padding(.leading, 13)
            }
        }
    }
}

/// The card of a point in the page: the single decision's own `YourPickBlockView`.
struct ItemBlockView: View {
    let block: QuestionsDocModel.PointBlock

    var body: some View {
        YourPickBlockView(
            label: block.label, title: block.title, pros: block.pros, cons: block.cons, effects: block.effects, note: block.note,
            noteTitle: block.noteTitle, swapId: block.swapId, commentIds: AskCommentIds(itemId: block.itemId, optionId: block.optionId))
    }
}

/// One item to decide, as a plain section (WAG-304, WAG-315): its text, then the answers as the same option
/// rows a single decision has (`CompactOptionRow`), string answers included. An answered item shows its pick
/// box under the rows (`YourPickBlockView`). The one note field is the prompt bar's (WAG-324). In the bottom
/// bar the pick box sits in the page instead. A pick-several item ticks rows; a reply item is a text field.
/// Lean and rule-out icons show on items (WAG-326). This one view draws every item of every request.
struct ItemRowsView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The variant of the screen on show (decision record 2026-11-12): its option gets «On screen».
    @Environment(\.onScreenVariant) private var onScreenVariant
    let number: Int
    let point: QuestionPoint
    let questionId: String
    /// How many points the question has: a lone point needs no number.
    var pointCount = 1
    @Binding var doc: QuestionsDocModel
    /// In the bottom bar (WAG-293): the pick's details show in the page, not here.
    var inBar = false

    @State private var isReplyFocused = false
    @State private var replyWidth: CGFloat = 0

    private var draft: QuestionsDocModel.Draft { doc.draft(questionId, point.id) }
    private var isLocked: Bool { doc.isLocked }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if showsHeading { heading }
            // A pick-several item has the header of a single request (WAG-334); other items keep their hint.
            if point.select != .many, let hint = point.pickHint {
                Text(hint)
                    .knockTextStyle(Theme.AskDoc.Typography.artifactMeta12_5)
                    .foregroundColor(Theme.Colors.ink3)
            }
            if point.select == .reply { replyField } else { answers }
            if !inBar, let question = doc.questions.first(where: { $0.id == questionId }) {
                ForEach(doc.pageBlocks(question: question, point: point, pointNumber: pointCount > 1 ? number : nil), id: \.swapId) {
                    ItemBlockView(block: $0)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A lone point whose text is the step's own title does not say it twice (WAG-334).
    private var showsHeading: Bool {
        if point.hidesText && pointCount <= 1 { return false }
        guard pointCount <= 1, let question = doc.questions.first(where: { $0.id == questionId }) else { return true }
        return AgentMarkdown.singleLine(point.text) != AgentMarkdown.singleLine(question.title)
    }

    private var heading: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if pointCount > 1 {
                Text("\(number)")
                    .knockTextStyle(Theme.AskDoc.Typography.monoLabel10_5)
                    .foregroundColor(Theme.Colors.honey600)
            }
            SourcedText(
                text: point.text, style: Theme.AskDoc.Typography.pointText14_5, color: Theme.Colors.ink,
                target: AskCommentTarget(.question, itemId: point.itemId ?? point.id, slot: "point"), weight: .semibold)
                .textSelection(.enabled)
        }
    }

    /// The rows of the point: the same cards a single decision has, with the lean and rule-out icons (WAG-326).
    private var answers: some View {
        let isMany = point.select == .many
        let rows = doc.optionRows(question: questionId, point: point)
        let onScreen = onScreenVariant?.option(
            anchors: point.choices.map(\.anchor), item: point.itemId,
            decisionCount: doc.questions.reduce(0) { $0 + $1.points.count })
        let open = CalmOption.openPosition(
            selected: rows.first(where: \.isSelected)?.position, recommended: rows.first(where: \.isRecommended)?.position,
            isCheckbox: isMany)
        return VStack(alignment: .leading, spacing: CalmOption.rowGap) {
            Group {
                if isMany && !isLocked {
                    PickSeveralHeaderView(
                        count: draft.choices.count, max: point.max, isAtLimit: doc.isAtLimit(point, draft),
                        canTickRecommended: doc.canTickRecommended(point, question: questionId),
                        onTickRecommended: { doc.tickRecommended(question: questionId, point: point.id) },
                        onClear: { doc.clearTicks(question: questionId, point: point.id) })
                } else {
                    OptionListLabel()
                }
            }
            .padding(.bottom, OptionCardStyle.labelGap - CalmOption.rowGap)
            ForEach(rows, id: \.position) { row in
                let label = point.choices[row.position - 1].label
                CompactOptionRow(
                    position: row.position, title: row.title, description: row.description, pros: row.pros, cons: row.cons,
                    effects: row.effects, note: row.note, facts: row.facts, proPoints: row.proPoints, conPoints: row.conPoints,
                    isSelected: row.isSelected, isRecommended: row.isRecommended, isLocked: isLocked, isOpen: open == row.position,
                    isLeaning: row.isLeaning, isRuledOut: row.isRuledOut,
                    onLean: row.canDiscuss ? { doc.toggleLean(label, question: questionId, point: point.id) } : nil,
                    onRuleOut: row.canDiscuss ? { doc.toggleRuleOut(label, question: questionId, point: point.id) } : nil,
                    isCheckbox: isMany, isLimitDimmed: row.isLimitDimmed, isOnScreen: onScreen == row.position - 1) {
                    // A click animates the open row once; number keys pick with no animation.
                    ReducedMotion.animate(reduceMotion: reduceMotion, .easeOut(duration: CalmOption.openDuration)) {
                        doc.choose(label, question: questionId, point: point.id)
                    }
                }
            }
        }
    }

    /// A reply item: the person writes the answer. The agent's suggested reply shows as the placeholder.
    /// It is the prompt bar's text view (WAG-370), so Shift-Return starts a new line here too.
    private var replyField: some View {
        let placeholder = point.recommended.first.map { "For example: \($0)" } ?? PromptBarLogic.placeholder(.reply)
        let inset = PromptBarLogic.textInset
        return ZStack(alignment: .topLeading) {
            if isLocked {
                Text(draft.text)
                    .knockTextStyle(Theme.Typography.body13_5w400)
                    .foregroundColor(Theme.Colors.ink)
                    .padding(EdgeInsets(top: inset.height, leading: inset.width, bottom: inset.height, trailing: inset.width))
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                if ComposerPlaceholder.isVisible(draftText: draft.text) {
                    Text(placeholder)
                        .knockTextStyle(Theme.Typography.body13_5w400)
                        .foregroundColor(Theme.Colors.ink3)
                        .lineLimit(ReplyItemField.minLines)
                        .truncationMode(.tail)
                        .padding(EdgeInsets(top: inset.height, leading: inset.width, bottom: 0, trailing: inset.width))
                        .allowsHitTesting(false)
                }
                PromptTextView(
                    text: Binding(
                        get: { draft.text },
                        set: { doc.setText($0, question: questionId, point: point.id) }),
                    isFocused: $isReplyFocused,
                    canSend: false,
                    onSend: {})
                    .frame(height: ReplyItemField.height(text: draft.text, textWidth: replyWidth - inset.width * 2))
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { replyWidth = $0 }
        .padding(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
        .background(Theme.Colors.win)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.Colors.line, lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture { if !isLocked { isReplyFocused = true } }
    }
}

/// The answer box of a reply item (WAG-370): two lines tall when empty, it grows to six, then scrolls.
enum ReplyItemField {
    static let minLines = 2
    static let maxLines = 6

    /// `textWidth` is 0 before the first layout: then only the typed line breaks count.
    static func height(text: String, textWidth: CGFloat) -> CGFloat {
        let lines = textWidth > 0
            ? PromptBarLogic.lineCount(text: text, textWidth: textWidth)
            : text.components(separatedBy: "\n").count
        return PromptBarLogic.fieldHeight(totalLines: max(lines, minLines), maxLines: maxLines)
    }
}
