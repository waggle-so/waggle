import SwiftUI

/// One numbered circle of a track: a tick when done, dark when current, an outline when upcoming.
struct PlanTrackDot: View {
    let index: Int
    let state: PlanText.TrackState
    let size: CGFloat

    var body: some View {
        ZStack {
            switch state {
            case .done:
                Circle().fill(Theme.Colors.ok)
                Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundColor(Theme.Colors.win)
            case .current:
                Circle().fill(Theme.Colors.ink)
                Text("\(index + 1)").font(.system(size: 10.5, weight: .semibold)).foregroundColor(Theme.Colors.win)
            case .upcoming:
                Circle().stroke(Theme.Colors.line2, lineWidth: 1.2)
                Text("\(index + 1)").font(.system(size: 10.5, weight: .medium)).foregroundColor(Theme.Colors.ink3)
            }
        }
        .frame(width: size, height: size)
    }
}

/// The narrowest form: "Stage 2 of 4 · Approaches" and four small dots (done and current lit).
struct PlanTrackLineView: View {
    let stage: PlanStageName
    let font: Theme.TextStyle

    var body: some View {
        HStack(spacing: 8) {
            Text(PlanTrackLayout.line(stage)).knockTextStyle(font).foregroundColor(Theme.Colors.ink).fixedSize()
            HStack(spacing: 4) {
                ForEach(Array(PlanText.track(current: stage).enumerated()), id: \.offset) { _, item in
                    Circle()
                        .fill(item.state == .done ? Theme.Colors.ok : (item.state == .current ? Theme.Colors.ink : Theme.Colors.line2))
                        .frame(width: 6, height: 6)
                }
            }
        }
    }
}

/// One earlier round for the fold: what was asked and what you answered.
struct RoundFoldEntry: Equatable {
    let question: String
    let answer: String
    /// "See vN" for a plan round that has its own revision.
    var revision: Int? = nil
    var seeLabel: String? = nil
    var seq: Int? = nil
}

/// "2 answered · Show": the earlier rounds folded away, read-only when opened (HAIL-151). Plan rounds and
/// update rounds use this one fold (WAG-335).
struct RoundFoldView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let entries: [RoundFoldEntry]
    /// The revision the stage shows read-only right now, else `nil` (HAIL-156).
    var viewingRevision: Int? = nil
    /// "See vN": opens that round's artifact read-only on the stage. `nil` hides the links.
    var onSeeRevision: ((Int) -> Void)? = nil
    @State private var isOpen = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_PLAN_FOLD_OPEN"] == "1"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                ReducedMotion.animate(reduceMotion: reduceMotion, .easeOut(duration: 0.15)) { isOpen.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.Colors.ok)
                    Text(PlanText.answeredLabel(entries.count))
                        .knockTextStyle(Theme.Typography.rowLabel12_5w500)
                        .foregroundColor(Theme.Colors.ink)
                    Spacer(minLength: 0)
                    Text(isOpen ? "Hide" : "Show")
                        .knockTextStyle(Theme.Typography.recommendLine12w400)
                        .foregroundColor(Theme.Colors.ink3)
                    Image(systemName: isOpen ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(Theme.Colors.ink3)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerCursor()
            if isOpen {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                        HStack(alignment: .top, spacing: 8) {
                            RoundFoldEntryText(question: entry.question, answer: entry.answer)
                            Spacer(minLength: 0)
                            if let onSeeRevision, let revision = entry.revision, let label = entry.seeLabel {
                                if viewingRevision == revision {
                                    Text("Viewing")
                                        .knockTextStyle(Theme.Typography.recommendLine12w400)
                                        .foregroundColor(Theme.Colors.ink3)
                                } else {
                                    Button(label) { onSeeRevision(revision) }
                                        .buttonStyle(.plain).pointerCursor()
                                        .knockTextStyle(Theme.Typography.priorRevisionLink12w500)
                                        .foregroundColor(Theme.Colors.ds)
                                        .accessibilityIdentifier("plan-see-round-\(entry.seq ?? 0)")
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(EdgeInsets(top: 2, leading: 12, bottom: 10, trailing: 12))
            }
        }
        .background(Theme.Colors.list)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.recommendedBlock).stroke(Theme.Colors.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.recommendedBlock))
    }
}

/// One answered round in the fold: the question and your answer, two lines each. When either is cut,
/// "Show all" shows both in full.
struct RoundFoldEntryText: View {
    let question: String
    let answer: String
    @State private var showsAll = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_SHOW_ALL"] == "1"
    @State private var questionCut = false
    @State private var answerCut = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ClampedLine(
                text: question, style: Theme.Typography.recommendLine12w400, color: Theme.Colors.ink3,
                showsAll: showsAll, isCut: $questionCut)
            ClampedLine(
                text: answer, style: Theme.Typography.rowLabel12_5w500, color: Theme.Colors.ink,
                showsAll: showsAll, isCut: $answerCut)
            if questionCut || answerCut || showsAll {
                Button(showsAll ? "Show less" : "Show all") { showsAll.toggle() }
                    .buttonStyle(.plain).pointerCursor()
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .foregroundColor(Theme.Colors.ink2)
                    .underline()
                    .padding(.top, 2)
                    .accessibilityIdentifier("plan-fold-show-all")
            }
        }
    }
}

/// Text cut at two lines, or shown in full. Reports through `isCut` whether two lines hide part of it.
private struct ClampedLine: View {
    let text: String
    let style: Theme.TextStyle
    let color: Color
    let showsAll: Bool
    @Binding var isCut: Bool
    @State private var shownHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0

    var body: some View {
        Text(text)
            .knockTextStyle(style)
            .foregroundColor(color)
            .lineLimit(showsAll ? nil : 2)
            .fixedSize(horizontal: false, vertical: showsAll)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { shownHeight = $0; update() }
            .background(
                Text(text).knockTextStyle(style)
                    .fixedSize(horizontal: false, vertical: true).hidden()
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { fullHeight = $0; update() }
            )
    }

    private func update() {
        if !showsAll { isCut = fullHeight > shownHeight + 1 }
    }
}

/// The plan's earlier answered rounds as fold entries.
extension PlanText {
    static func foldEntries(_ rounds: [PlanRound]) -> [RoundFoldEntry] {
        rounds.map { round in
            RoundFoldEntry(
                question: AgentMarkdown.singleLine(round.question), answer: answerSummary(round),
                revision: round.revision, seeLabel: PlanArtifacts.seeLabel(round), seq: round.seq)
        }
    }
}
