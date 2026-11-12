import Foundation

/// WAG-352: the decision on screen in a request with several decisions: its place, its options, and what the
/// person chose or was pre-picked (recommended). The artifact box follows it.
struct DecisionFocus: Equatable {
    /// 0-based position of the decision.
    var index: Int
    var count: Int
    var options: [Option]
    /// Option ids the person chose, in the order chosen.
    var chosen: [String]
    /// Option ids the agent recommends (the pre-pick).
    var recommended: [String]
    /// WAG-364: the question of the decision. The artifact name rule reads it first.
    var question: String? = nil
    /// The item ids of the decision's points. A screenshot of a set names its decision with one of them.
    var itemIds: [String] = []

    /// The chosen option, else the recommended one.
    var pick: Option? {
        for id in chosen + recommended {
            if let option = options.first(where: { $0.id == id }) { return option }
        }
        return nil
    }
}

/// What the box does for a decision: the tab to show, the page anchor to scroll to, the image of a set to flip to.
struct DecisionArtifactTarget: Equatable {
    var tabId: String?
    var anchor: String?
    var image: Int?
    /// The 0-based images of the set that belong to the decision, in order; `nil` when the set has no grouping
    /// (the strip then shows every image).
    var group: [Int]? = nil
}

/// WAG-352: which tab, anchor or image of the artifact belongs to a decision. Pure.
enum DecisionArtifactRule {
    /// Rules 1 and 2: the tab (and anchor) the decision names.
    /// 1. The chosen or pre-picked option has `artifact_ref`: that tab, with its `anchor`.
    /// 2. Else every option that has an `artifact_ref` names one artifact: that tab (and the anchor all share).
    static func link(for focus: DecisionFocus, tabs: [ArtifactTab]) -> ArtifactLink? {
        if let pick = focus.pick, let link = ArtifactTabs.link(for: pick, in: tabs, current: nil), link.tabId != nil {
            return link
        }
        let named = focus.options.filter { clean($0.artifactRef) != nil }
        let links = named.map { ArtifactTabs.link(for: $0, in: tabs, current: nil) }
        guard let first = links.first, let tabId = first?.tabId,
              links.allSatisfy({ $0?.tabId == tabId }) else { return nil }
        let anchors = Set(links.map { $0?.anchor })
        return ArtifactLink(tabId: tabId, anchor: anchors.count == 1 ? anchors.first ?? nil : nil)
    }

    /// WAG-364: the one artifact whose name appears in the words of the decision: the question first, then the option
    /// titles and labels. Case and extra spaces are ignored; a name of fewer than 3 characters never matches. With no
    /// name, or more than one, `nil`.
    static func nameMatch(for focus: DecisionFocus, tabs: [ArtifactTab]) -> ArtifactLink? {
        let words = ([focus.question] + focus.options.flatMap { [$0.title, $0.label] }).compactMap(collapse)
        let matches = tabs.filter { tab in
            guard tab.hasName, let name = collapse(tab.title), name.count >= 3 else { return false }
            return words.contains { $0.contains(name) }
        }
        guard matches.count == 1, let tab = matches.first else { return nil }
        return ArtifactLink(tabId: tab.id, anchor: nil)
    }

    private static func collapse(_ text: String?) -> String? {
        let words = (text ?? "").lowercased().split(whereSeparator: \.isWhitespace)
        return words.isEmpty ? nil : words.joined(separator: " ")
    }

    /// The whole rule. `captions` gives the captions of a `screenshots` tab's images (`nil` entry: no caption);
    /// `nil` for a tab that is not a loaded set.
    /// 3. Else the one artifact whose name the words of the decision contain (`nameMatch`).
    /// 4. Else, on a `screenshots` set with more than one decision: the image of the decision. The anchor of the
    ///    pick (else the one anchor the options share) wins, as a number or a caption; with no anchor, decision K
    ///    shows image K when the decisions are as many as the images.
    /// 5. Else: `nil`, nothing changes.
    static func target(
        for focus: DecisionFocus, tabs: [ArtifactTab], current: String?, captions: (String) -> [String?]?,
        items: (String) -> [String?]? = { _ in nil }
    ) -> DecisionArtifactTarget? {
        if let link = link(for: focus, tabs: tabs) ?? nameMatch(for: focus, tabs: tabs), let tabId = link.tabId, let tab = tabs.first(where: { $0.id == tabId }) {
            guard tab.kind == .screenshots else { return DecisionArtifactTarget(tabId: tabId, anchor: link.anchor) }
            let names = captions(tabId)
            let group = names.flatMap { imageGroup(for: focus, captions: $0, items: items(tabId)) }
            let image = link.anchor.flatMap { anchor in names.flatMap { imageIndex(anchor: anchor, captions: $0) } }
            return DecisionArtifactTarget(tabId: tabId, anchor: nil, image: within(image, group), group: group)
        }
        guard focus.count > 1, let tab = tabs.first(where: { $0.id == current }), tab.kind == .screenshots,
              let names = captions(tab.id) else { return nil }
        // The images of the decision: its own, else today's rule (the anchor of the pick, else image K).
        if let group = imageGroup(for: focus, captions: names, items: items(tab.id)) {
            let anchored = imageIndex(anchor: decisionAnchor(focus), captions: names)
            return DecisionArtifactTarget(tabId: nil, anchor: nil, image: within(anchored, group), group: group)
        }
        let position = focus.index < names.count && focus.count <= names.count ? focus.index : nil
        guard let image = imageIndex(anchor: decisionAnchor(focus), captions: names) ?? position else { return nil }
        return DecisionArtifactTarget(tabId: nil, anchor: nil, image: image)
    }

    /// An image of a group: the anchor's when it is in the group, else the first of the group. With no group,
    /// the image as it is.
    private static func within(_ image: Int?, _ group: [Int]?) -> Int? {
        guard let group else { return image }
        if let image, group.contains(image) { return image }
        return group.first
    }

    /// The images of the decision on screen in a `screenshots` set: the 0-based indexes, in order, or `nil` when
    /// the set does not say (today's WAG-352 rule then applies unchanged). Pure.
    /// - An image has an `item` (the id of a decision): when any image of the set has one, only `item` counts.
    /// - Else a caption starts with a decision: a number (`1`, `2`), then a space, `·`, `.`, `:`, `)` or `-`; or a
    ///   letter and a number (`b1`). Letter `a` and number 1 are the first decision. A lone letter (`B · Tap`) is a
    ///   variant's name, not a decision. The
    ///   captions count only when they name at least two different decisions, all inside the request, so a lone
    ///   caption like "A new ring" is not read as a decision.
    /// An image that names no decision shows with every decision. A request with one decision has no group.
    static func imageGroup(for focus: DecisionFocus, captions: [String?], items: [String?]? = nil) -> [Int]? {
        guard focus.count > 1 else { return nil }
        let ids = (items ?? []).map { clean($0) }
        if ids.contains(where: { $0 != nil }) {
            let mine = Set(focus.itemIds)
            let group = ids.indices.filter { ids[$0] == nil || mine.contains(ids[$0]!) }
            return group.isEmpty ? nil : group
        }
        let parsed = captions.map { captionDecision($0) }
        let named = Set(parsed.compactMap { $0 })
        guard named.count >= 2, named.allSatisfy({ $0 < focus.count }) else { return nil }
        let group = parsed.indices.filter { parsed[$0] == nil || parsed[$0] == focus.index }
        return group.isEmpty ? nil : group
    }

    /// The 0-based decision a caption starts with, else `nil`. Case is ignored.
    static func captionDecision(_ caption: String?) -> Int? {
        guard let text = clean(caption) else { return nil }
        let chars = Array(text)
        let separators: Set<Character> = [" ", "·", ".", ":", ")", "-"]
        func isLetter(_ c: Character) -> Bool { c.isASCII && c.isLetter }
        func isDigit(_ c: Character) -> Bool { c.isASCII && c.isNumber }
        func ends(at i: Int) -> Bool { i >= chars.count || separators.contains(chars[i]) }
        if isLetter(chars[0]) {
            let letter = Int(chars[0].lowercased().unicodeScalars.first!.value) - 97
            // A lone letter ("B · Tap") names a variant, not a decision: agents letter the variants of one
            // decision A, B, C, so reading the letter as a decision split them across decisions.
            // A letter and a number: "b1", "b2 Tap".
            var end = 1
            while end < chars.count, isDigit(chars[end]) { end += 1 }
            return end > 1 && ends(at: end) ? letter : nil
        }
        if isDigit(chars[0]) {
            var end = 0
            while end < chars.count, isDigit(chars[end]) { end += 1 }
            // A number is a decision only with a separator after it: "2. Tap", "2 Tap".
            guard end < chars.count, separators.contains(chars[end]), let number = Int(String(chars[0..<end])), number >= 1 else { return nil }
            return number - 1
        }
        return nil
    }

    /// WAG-381: the step the case box and full size share. The set a decision lands on is prepared first (`prepare`
    /// loads or shows it), because its captions decide the image; then the whole rule runs. The caller applies the
    /// target and drops it when a newer decision arrived during the wait.
    @MainActor
    static func resolve(
        for focus: DecisionFocus, tabs: [ArtifactTab], current: () -> String?,
        prepare: (ArtifactTab) async -> Void, captions: (String) -> [String?]?,
        items: (String) -> [String?]? = { _ in nil }
    ) async -> DecisionArtifactTarget? {
        let tabId = link(for: focus, tabs: tabs)?.tabId ?? current()
        if let tab = tabs.first(where: { $0.id == tabId }), tab.kind == .screenshots { await prepare(tab) }
        return target(for: focus, tabs: tabs, current: current(), captions: captions, items: items)
    }

    /// The anchor of the decision: its pick's, else the one anchor the options that have one share.
    static func decisionAnchor(_ focus: DecisionFocus) -> String? {
        if let anchor = clean(focus.pick?.anchor) { return anchor }
        let anchors = Set(focus.options.compactMap { clean($0.anchor) })
        return anchors.count == 1 ? anchors.first : nil
    }

    /// The 0-based image an anchor names: a number from 1, else a caption (case and spaces ignored).
    static func imageIndex(anchor: String?, captions: [String?]) -> Int? {
        guard let anchor = clean(anchor) else { return nil }
        if let number = Int(anchor), number >= 1, number <= captions.count { return number - 1 }
        let wanted = squash(anchor)
        return captions.firstIndex { $0.map(squash) == wanted }
    }

    private static func squash(_ text: String) -> String {
        text.lowercased().filter { !$0.isWhitespace }
    }

    private static func clean(_ text: String?) -> String? {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension DecisionFocus {
    /// The decision on screen of a stepped request that has items, with the person's picks so far. `nil` for a
    /// request with one decision, an older questions request (its points carry no artifact link) and the review step.
    static func make(case request: Case, doc: QuestionsDocModel) -> DecisionFocus? {
        guard doc.usesItems, doc.questions.count > 1, let question = doc.currentQuestion,
              let index = doc.questions.firstIndex(where: { $0.id == question.id }) else { return nil }
        var options: [Option] = []
        var chosen: [String] = []
        var recommended: [String] = []
        for point in question.points {
            guard let item = request.items.first(where: { $0.id == point.itemId }), item.select != .reply else { continue }
            options += item.options
            recommended += item.recommendation
            let draft = doc.draft(question.id, point.id)
            chosen += (point.select == .many ? draft.choices : draft.choice.map { [$0] } ?? []).map(point.optionId(forLabel:))
        }
        return DecisionFocus(index: index, count: doc.questions.count, options: options, chosen: chosen, recommended: recommended, question: question.points.first?.text,
                             itemIds: question.points.compactMap(\.itemId))
    }
}
