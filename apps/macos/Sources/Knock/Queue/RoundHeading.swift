import SwiftUI

/// An update that brought new options (HAIL-174): its question leads the ask column, the old title
/// drops to a "Was:" line, and the update card keeps only what changed. Pure, so it is unit-tested.
struct RoundHeading: Equatable {
    /// "Round 2": the option set's seq + 1.
    let tag: String
    /// The round's question: the first paragraph of the update message (or of the option set's question).
    let title: String
    /// "Was: <original title> · You answered: <answer>".
    let was: String
    /// The earlier round for the fold (WAG-335): its question and your answer. `nil` while you have no
    /// answer to show; the "Was" line stands alone then.
    let earlier: RoundFoldEntry?
    /// The message's last paragraph when it speaks to the person (the one after the details).
    let instruction: String?
    /// What the honey "What I need from you" box says in this round: the details after the question,
    /// else the question itself. WAG-282: the first round's need never stands in for a later round.
    let need: String

    /// Splits text at blank lines.
    static func paragraphs(_ text: String) -> [String] {
        var out: [String] = []
        var current: [String] = []
        for line in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                if !current.isEmpty { out.append(current.joined(separator: "\n")); current = [] }
            } else {
                current.append(line)
            }
        }
        if !current.isEmpty { out.append(current.joined(separator: "\n")) }
        return out
    }

    /// nil for a first-round ask (seq 0) or a round with no text: those keep today's look. A round with
    /// one short paragraph still leads with it (WAG-282). `question` (the option set's) wins over
    /// `message` (the update's).
    static func make(seq: Int, question: String?, message: String?, originalTitle: String, answer: String?) -> RoundHeading? {
        guard seq > 0 else { return nil }
        let source = [question, message].compactMap { $0 }.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard let source else { return nil }
        let parts = paragraphs(source)
        let title = AgentMarkdown.singleLine(parts.first ?? "")
        guard !title.isEmpty else { return nil }
        let details = parts.count >= 3 ? parts[1..<(parts.count - 1)] : parts.dropFirst()
        let oldTitle = AgentMarkdown.singleLine(originalTitle)
        var was = "Was: \(oldTitle)"
        var earlier: RoundFoldEntry?
        if let answer, !answer.isEmpty {
            // A separator that needs no stop: an old title that ends in "?" gives no "?." (WAG-335).
            was += " · You answered: \(AgentMarkdown.singleLine(answer))"
            earlier = RoundFoldEntry(question: oldTitle, answer: AgentMarkdown.singleLine(answer))
        }
        return RoundHeading(
            tag: "Round \(seq + 1)", title: title, was: was, earlier: earlier,
            instruction: parts.count >= 3 ? parts[parts.count - 1] : nil,
            need: details.isEmpty ? parts[0] : details.joined(separator: "\n\n"))
    }

    /// What the update card shows: the message without the question paragraph and without the
    /// instruction. A message that is not the one that brought the round stays whole.
    func cardMessage(_ message: String) -> String {
        let parts = Self.paragraphs(message)
        // One paragraph that became the heading: the heading shows all of it.
        if parts.count == 1, AgentMarkdown.singleLine(parts[0]) == title { return "" }
        guard parts.count >= 2, AgentMarkdown.singleLine(parts[0]) == title else { return message }
        var kept = Array(parts.dropFirst())
        if instruction != nil, kept.count >= 2, kept.last == instruction { kept.removeLast() }
        return kept.joined(separator: "\n\n")
    }
}

extension Case {
    /// The short title of your last answer: the picked option titles, else your own words.
    var lastAnswerShortTitle: String? {
        guard latestReplyId != nil else { return nil }
        if !latestReplyChoices.isEmpty { return repliedChoiceTitles.joined(separator: ", ") }
        if let words = latestReplyWithChangesWords { return words }
        if let choice = latestReplyChoice {
            return repliedOptions.first { $0.id == choice }?.displayTitle ?? choice
        }
        return latestReplyMessage.map { AgentMarkdown.singleLine($0) }
    }

    /// The heading of the newest round, while it waits for you and after you answered it (WAG-282).
    /// Plan asks keep their stage header and are left unchanged: their round text already opens the
    /// right column as the headline. "You answered" joins only while the round waits: once you answer
    /// it, your last answer belongs to this round, not to the one before.
    var roundHeading: RoundHeading? {
        guard plan == nil else { return nil }
        return RoundHeading.make(
            seq: optionsSeq, question: roundQuestion, message: nil, originalTitle: title,
            answer: status == .needsYou ? lastAnswerShortTitle : nil)
    }

    /// The text of the honey box: the newest round's, else the ask's own need or a plan round's question.
    func currentNeed(planRounds: [PlanRound]?) -> String {
        roundHeading?.need ?? PlanText.currentQuestion(for: self, rounds: planRounds)
    }

    /// The line under the need box. It belongs to the first round: an update carries no new reason, so a
    /// later round (an update with options, or a plan round after the first) shows none instead of the
    /// old one (WAG-335, audit F15). Nil when the ask has none.
    var currentWhy: String? { roundNumber > 1 ? nil : why }

    /// 1 for the ask's own round; a plan counts its rounds, any other ask counts its option sets.
    var roundNumber: Int { plan?.rounds ?? (optionsSeq + 1) }

    /// The need as the honey box shows it: empty when it only repeats the title shown above it (an update
    /// round with no details has the question as its need, audit F9).
    func displayNeed(planRounds: [PlanRound]?) -> String {
        let need = currentNeed(planRounds: planRounds)
        let shown = roundHeading?.title ?? title
        return NeedText.repeats(need, title: shown) || NeedText.repeats(need, title: TitleSplit.make(shown).title) ? "" : need
    }

    /// The queue row's first line: the newest round's question, else the title.
    /// A long title or several sentences keep their first sentence here (WAG-249).
    var rowTitle: String { TitleSplit.make(roundHeading?.title ?? title).title }
}

/// The "ROUND 2" mark of a later round: the same in a plan and in an update round (WAG-335). It is the eyebrow
/// over the title, as mockup B's `.ctx`: mono 11.5, quiet, capitals. The project and the session are in the top bar,
/// so the eyebrow does not repeat them.
struct RoundTagView: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .knockTextStyle(Theme.AskDoc.Column.eyebrow)
            .foregroundColor(Theme.AskDoc.Colors.quiet)
            .accessibilityLabel(text)
    }
}

/// Tag, question and the earlier round (a fold, or the "Was" line) over an ask column or pane (HAIL-174,
/// Pen `M4gc9E`).
struct RoundHeadingView: View {
    let heading: RoundHeading
    let titleStyle: Theme.TextStyle
    /// Mockup B: on the page with no artifact the round is in the eyebrow over the page, not here again.
    @Environment(\.roundTagInEyebrow) private var roundTagInEyebrow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // `.ctx`: margin-bottom 10.
            if !roundTagInEyebrow { RoundTagView(text: heading.tag).padding(.bottom, 6) }
            SplitTitleView(text: heading.title, style: titleStyle)
            if let earlier = heading.earlier {
                RoundFoldView(entries: [earlier]).padding(.top, 6)
            } else {
                Text(heading.was)
                    .knockTextStyle(Theme.Typography.recommendLine12w400)
                    .foregroundColor(Theme.Colors.ink3)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
    }
}

/// The instruction paragraph above the answer box.
struct RoundInstructionView: View {
    let text: String

    var body: some View {
        Text(AgentMarkdown.plainText(text).replacingOccurrences(of: "\n", with: " "))
            .knockTextStyle(Theme.Typography.body13w400)
            .foregroundColor(Theme.Colors.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
