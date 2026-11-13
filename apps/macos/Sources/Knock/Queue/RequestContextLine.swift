import SwiftUI

/// What the context line under the top bar holds (C2): the ask this one follows or replaces, the plan stage
/// track, and the status. Pure, so each case is tested without a view.
enum ContextLine {
    /// The ask this one comes from.
    enum Link: Equatable {
        /// "↩ Follow-up to X": a click opens that ask.
        case followUp(caseId: String)
        /// "Replaces X": the earlier ask is withdrawn, so it is plain text.
        case replaces(caseId: String)
    }

    struct Content: Equatable {
        var link: Link?
        var plan: PlanInfo?
        /// The status words (C10); the line shows them with their buttons.
        var status: String?

        var isEmpty: Bool { link == nil && plan == nil && (status ?? "").isEmpty }
    }

    /// A follow-up wins over a replace: an ask carries one of them in practice.
    static func content(for item: Case, status: String? = nil) -> Content {
        let link: Link? = item.followsCaseId.map { .followUp(caseId: $0) } ?? item.replacesCaseId.map { .replaces(caseId: $0) }
        return Content(link: link, plan: item.plan, status: status)
    }

    /// The words before the earlier ask's title.
    static func linkPrefix(_ link: Link) -> String {
        switch link {
        case .followUp: "↩ Follow-up to"
        case .replaces: "Replaces"
        }
    }
}

/// The earlier answer, folded to one line: "You chose B · Show" (C2).
enum PreviousAnswer {
    /// "You chose B · Options in place", "You chose A, B", "You answered 3 questions", "You replied". `nil` for a
    /// case with no reply.
    static func label(_ item: Case) -> String? {
        guard item.latestReplyId != nil else { return nil }
        if !item.options.isEmpty || !item.firstOptions.isEmpty {
            if !item.latestReplyChoices.isEmpty { return "You chose \(item.repliedChoiceTitles.joined(separator: ", "))" }
            if let choice = item.latestReplyChoice {
                return "You chose \(item.repliedOptions.first { $0.id == choice }?.displayTitle ?? choice)"
            }
        }
        if !item.latestReplyAnswers.isEmpty {
            let count = Set(item.latestReplyAnswers.map(\.questionId)).count
            return count == 1 ? "You answered 1 question" : "You answered \(count) questions"
        }
        if let message = item.latestReplyMessage, !message.isEmpty { return "You replied" }
        return nil
    }

    /// The answer inside a sentence, as the context line says it: "you chose B" (mockup `.fu`).
    static func inline(_ item: Case) -> String? {
        guard let label = label(item), let first = label.first else { return nil }
        return first.lowercased() + label.dropFirst()
    }

    /// The title of a folded earlier round on the page: the answer when there is one, else `fallback`.
    static func foldTitle(_ item: Case, fallback: String) -> String { label(item) ?? fallback }
}

extension PlanText {
    /// The tooltip of one stage word: "Questions: done", "Approaches · round 2", "Design: not started".
    static func trackHelp(_ name: PlanStageName, state: TrackState, plan: PlanInfo) -> String {
        switch state {
        case .done: return "\(title(name)): done"
        case .current:
            let label = progressLabel(plan.stage)
            let named = label.hasPrefix(title(name)) ? label : "\(title(name)) · \(label)"
            return plan.rounds > 1 ? "\(named) · round \(plan.rounds)" : named
        case .upcoming: return "\(title(name)): not started"
        }
    }
}

/// The context lines at the top of the Decision tab's scroll (C2), as the case map mockup draws them: the follow-up
/// line (`.fu`: "↩ Follow-up to **X** · you chose B Show", one line, the title cut with "…"), the status (C10), then
/// the plan track (`.track`: numbered circles joined by lines). Each piece keeps the mockup's gap under it, so the
/// next part (the step bar or the title) follows with no gap of its own. It shows only when there is context.
struct RequestContextLine: View {
    let item: Case
    var planRounds: [PlanRound] = []
    var viewingRevision: Int? = nil
    var onSeeRevision: ((Int) -> Void)? = nil
    var status: String? = nil
    /// The status line's view (`RequestStatusLineView`), with its buttons.
    var statusView: AnyView? = nil
    let onOpenCase: (String) -> Void

    @StateObject private var loader: FollowedCaseLoader
    @State private var isAnswerOpen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private typealias Column = Theme.AskDoc.Column

    init(
        item: Case, client: KnockClient?, planRounds: [PlanRound] = [], viewingRevision: Int? = nil,
        onSeeRevision: ((Int) -> Void)? = nil, status: String? = nil, statusView: AnyView? = nil,
        onOpenCase: @escaping (String) -> Void
    ) {
        self.item = item
        self.planRounds = planRounds
        self.viewingRevision = viewingRevision
        self.onSeeRevision = onSeeRevision
        self.status = status
        self.statusView = statusView
        self.onOpenCase = onOpenCase
        _loader = StateObject(wrappedValue: FollowedCaseLoader(client: client))
    }

    private var content: ContextLine.Content { ContextLine.content(for: item, status: status) }

    private var linkedId: String? {
        switch content.link {
        case .followUp(let id)?, .replaces(let id)?: id
        case nil: nil
        }
    }

    // A plain `VStack` root, never `Group`: a `Group` empty on first appearance never mounts, so `.task` never
    // fires (HAIL-33 ledger). The zero-size anchor keeps it concrete before the earlier ask loads.
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let link = content.link, let earlier = loader.followedCase {
                // `.fu`: margin-bottom 10.
                linkPiece(link, earlier: earlier)
                    .padding(.bottom, isAnswerOpen ? 6 : 10)
                if isAnswerOpen, let recap = earlier.followUpRecapLine {
                    Text(recap)
                        .knockTextStyle(Column.followUp)
                        .foregroundColor(Theme.Colors.ink2)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .transition(.opacity)
                        .padding(.bottom, 10)
                }
            }
            if let statusView {
                statusView.padding(.bottom, 10)
            }
            if let plan = content.plan {
                // `.track`: margin-bottom 12.
                PlanWordTrack(plan: plan, rounds: planRounds, viewingRevision: viewingRevision, onSeeRevision: onSeeRevision)
                    .padding(.bottom, 12)
            }
            Color.clear.frame(width: 0, height: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: linkedId) { if let linkedId { await loader.load(caseId: linkedId) } }
    }

    /// `.fu`: 12 ink3, gap 6; the title 500 ink, cut first (its full text is in the tooltip), so "you chose X · Show"
    /// stays readable. Only when the answer alone is wider than the line is it cut too.
    private func linkPiece(_ link: ContextLine.Link, earlier: Case) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(ContextLine.linkPrefix(link))
                .knockTextStyle(Column.followUp)
                .foregroundColor(Theme.Colors.ink3)
                .fixedSize()
            titleText(link, earlier: earlier).layoutPriority(0)
            if let answer = PreviousAnswer.inline(earlier) {
                Text("· \(answer)")
                    .knockTextStyle(Column.followUp)
                    .foregroundColor(Theme.Colors.ink3)
                    .lineLimit(1).truncationMode(.tail)
                    .layoutPriority(1)
                    .help(answer)
                Button {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { isAnswerOpen.toggle() }
                } label: {
                    Text(isAnswerOpen ? "Hide" : "Show")
                        .knockTextStyle(Column.followUp)
                        .foregroundColor(Theme.Colors.ink3)
                        .underline()
                }
                .buttonStyle(.plain).pointerCursor().fixedSize()
                .accessibilityLabel(isAnswerOpen ? "Hide your earlier answer" : "Show your earlier answer")
            }
        }
        .lineLimit(1)
        .frame(minHeight: Column.lineBox(12), alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func titleText(_ link: ContextLine.Link, earlier: Case) -> some View {
        let title = Text(AgentMarkdown.singleLine(earlier.title))
            .knockTextStyle(Column.followUpTitle)
            .foregroundColor(Theme.Colors.ink)
            .lineLimit(1).truncationMode(.tail)
            .help(earlier.title)
        switch link {
        case .followUp(let id):
            Button { onOpenCase(id) } label: { title.contentShape(Rectangle()) }
                .buttonStyle(.plain).pointerCursor()
                .help("Open the earlier request: \(earlier.title)")
        case .replaces:
            title
        }
    }
}

/// The plan stages as the case map's `.track` (C2): a 15 pt circle per stage with its number (✓ when done) and its
/// name, joined by 1 pt lines that share the width. Done: an ok circle with a white ✓; current: an ink circle with a
/// white number and the name in 600 ink; the rest 11.5 quiet. Each stage says more in its tooltip. The earlier
/// answered rounds open from "N answered ⌄", with their "See vN" links.
struct PlanWordTrack: View {
    let plan: PlanInfo
    let rounds: [PlanRound]
    var viewingRevision: Int? = nil
    var onSeeRevision: ((Int) -> Void)? = nil
    @State private var isAnsweredOpen = false

    private typealias Column = Theme.AskDoc.Column

    var body: some View {
        HStack(spacing: 6) {
            let items = PlanText.track(current: plan.stage.name)
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                if index > 0 {
                    Rectangle().fill(Theme.Colors.line2).frame(minWidth: 8, maxWidth: .infinity).frame(height: 1)
                }
                stage(index + 1, item.name, state: item.state)
            }
            let earlier = PlanText.earlierAnswered(rounds)
            if !earlier.isEmpty { answeredMenu(PlanText.foldEntries(earlier)).padding(.leading, 4) }
        }
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Plan stage: \(PlanText.title(plan.stage.name))")
    }

    private func stage(_ number: Int, _ name: PlanStageName, state: PlanText.TrackState) -> some View {
        HStack(spacing: 5) {
            ZStack {
                Circle().fill(state == .done ? Theme.Colors.ok : (state == .current ? Theme.Colors.ink : Color.clear))
                Circle().strokeBorder(
                    state == .done ? Theme.Colors.ok : (state == .current ? Theme.Colors.ink : Theme.Colors.line2), lineWidth: 1)
                Text(state == .done ? "✓" : "\(number)")
                    .knockTextStyle(Column.trackGlyph)
                    .foregroundColor(state == .upcoming ? Theme.AskDoc.Colors.quiet : Theme.Colors.win)
            }
            .frame(width: 15, height: 15)
            Text(PlanText.title(name))
                .knockTextStyle(state == .current ? Column.trackCurrent : Column.track)
                .foregroundColor(state == .current ? Theme.Colors.ink : Theme.AskDoc.Colors.quiet)
                .fixedSize()
        }
        .help(PlanText.trackHelp(name, state: state, plan: plan))
    }

    private func answeredMenu(_ entries: [RoundFoldEntry]) -> some View {
        Button { isAnsweredOpen.toggle() } label: {
            HStack(spacing: 3) {
                Text(PlanText.answeredLabel(entries.count))
                    .knockTextStyle(Column.track)
                    .foregroundColor(Theme.Colors.ink3)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold)).foregroundColor(Theme.Colors.ink3)
            }
            .fixedSize()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
        .help("Your earlier answers in this plan")
        .popover(isPresented: $isAnsweredOpen, arrowEdge: .bottom) {
            // The same rows as the old fold: what was asked, what you answered, "See vN" or "Viewing".
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.question)
                                .knockTextStyle(Theme.Typography.recommendLine12w400)
                                .foregroundColor(Theme.Colors.ink3)
                                .lineLimit(2)
                            Text(entry.answer)
                                .knockTextStyle(Theme.Typography.rowLabel12_5w500)
                                .foregroundColor(Theme.Colors.ink)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 0)
                        if let onSeeRevision, let revision = entry.revision, let label = entry.seeLabel {
                            if viewingRevision == revision {
                                Text("Viewing")
                                    .knockTextStyle(Theme.Typography.recommendLine12w400)
                                    .foregroundColor(Theme.Colors.ink3)
                            } else {
                                Button(label) { isAnsweredOpen = false; onSeeRevision(revision) }
                                    .buttonStyle(.plain).pointerCursor()
                                    .knockTextStyle(Theme.Typography.priorRevisionLink12w500)
                                    .foregroundColor(Theme.Colors.ds)
                                    .accessibilityIdentifier("plan-see-round-\(entry.seq ?? 0)")
                            }
                        }
                    }
                }
            }
            .padding(14)
            .frame(width: 320, alignment: .leading)
        }
    }
}
