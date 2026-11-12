import Foundation

/// The one Ask view reads a request as a list of steps (WAG-315). A request with more than one item gets
/// its steps from `Case.items`: one step per item (WAG-364). An older payload (no items) keeps
/// its `questions` and renders exactly as it did in 0.2.20.
extension Case {
    /// True when the request shows the step bar and the answers bar: more than one item, or the old
    /// questions shape.
    var hasQuestionsDoc: Bool { items.count > 1 || (!questions.isEmpty && !questionsReplacedByLaterRound) }

    /// WAG-343: a later round with a single item (a `waggle_update` with new options) replaces the legacy
    /// `questions` doc. The case keeps `questions` as its round 0, so the page folds them as the earlier
    /// round, and the reply carries the new choice, not the round 0 answers.
    var questionsReplacedByLaterRound: Bool { items.count <= 1 && !questions.isEmpty && optionsSeq > 0 }

    /// True when the steps come from `items`, so the answers go back as `item_answers`.
    var docUsesItems: Bool { items.count > 1 }

    /// The steps of the request: one per item.
    var docQuestions: [Question] {
        docUsesItems ? Question.steps(from: items, fallbackTitle: title) : questions
    }
}

extension Question {
    /// One step per item, in the order sent (WAG-364). An item of a group keeps the group's title as a heading and
    /// its "how it works now" lines and variants; the group does not merge items into one page. The item's
    /// question is the step title.
    static func steps(from items: [Item], fallbackTitle: String) -> [Question] {
        items.map { item in
            let point = QuestionPoint(item: item, fallbackText: fallbackTitle)
            let group = item.group
            return Question(
                id: item.id, title: point.text, now: group?.now, points: [QuestionPoint(point, hidesText: true)],
                artifactRef: nil, variants: group?.variants, variantLabel: group?.variantLabel, groupTitle: group?.title, groupId: group?.id)
        }
    }
}

extension QuestionPoint {
    /// A point for an item. The answers are the item's options by their short title; a reply item has none.
    init(item: Item, fallbackText: String) {
        var seen: [String: Int] = [:]
        let options: [PointOption]? = item.select == .reply ? nil : item.options.enumerated().map { index, option in
            // Two options with one title would be one answer: the later one gets a number.
            let title = option.displayTitle
            seen[title, default: 0] += 1
            let label = seen[title] == 1 ? title : "\(title) (\(seen[title]!))"
            // The full text, the facts and the gists go with the answer, so the card drops nothing the agent sent.
            return PointOption(
                label: label, effects: option.effects, optionId: option.id,
                proPoints: option.proPoints, conPoints: option.conPoints, facts: option.facts,
                detail: CalmOption.description(of: option, position: index + 1), why: option.why, anchor: option.anchor)
        }
        let recommended: [String]
        if item.select == .reply {
            recommended = item.recommendation
        } else {
            recommended = item.recommendation.compactMap { id in options?.first { $0.optionId == id }?.label }
        }
        self.init(
            id: item.id, text: item.question ?? fallbackText, options: options, itemId: item.id, select: item.select,
            max: item.max, recommended: recommended, recommendationWhy: item.recommendationWhy)
    }

    /// The same point with `hidesText` set.
    init(_ point: QuestionPoint, hidesText: Bool) {
        self = point
        self.hidesText = hidesText
    }

    /// True for a point that came from an item.
    var isItem: Bool { itemId != nil }

    /// The id the daemon knows an answer by: the option's id for an item, else the label.
    func optionId(forLabel label: String) -> String {
        choices.first { $0.label == label }?.optionId ?? label
    }

    /// "Pick up to 2" for a pick-several point; `nil` for any other.
    var pickHint: String? {
        guard select == .many else { return nil }
        if let max { return "Pick up to \(max)" }
        return "Pick any number"
    }
}

/// Evidence only (WAG-315): `KNOCK_EVIDENCE_ITEMS=<json file>` gives the items of the cases it names, by title
/// (`{"Case title": [item, ...]}`), for a daemon that does not serve `items` yet. It works only in a process whose
/// `KNOCK_BUNDLE_ID` starts with `dev.limone.knock.evidence`, and never replaces items a daemon sent.
enum EvidenceItems {
    private static let overlay: [String: [Item]] = {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment["KNOCK_EVIDENCE_ITEMS"], environment["KNOCK_BUNDLE_ID"]?.hasPrefix("dev.limone.knock.evidence") == true,
              let data = FileManager.default.contents(atPath: path),
              let map = try? JSONDecoder().decode([String: [Item]].self, from: data) else { return [:] }
        return map
    }()

    static func items(forTitle title: String) -> [Item] { overlay[title] ?? [] }
}
