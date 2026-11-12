import SwiftUI

/// The label of one screen in the screen row: its badge ("A", "A2"), its variant letter, and whether
/// every decision shares it.
struct ScreenRowLabel: Equatable {
    let badge: String?
    let variant: Character?
    let isShared: Bool
}

/// Labels the screens of a screenshots set by variant. A caption that starts with a lone letter
/// ("A · …", "a: …", "A1 · …") names variant A; Waggle numbers the screens of a variant itself
/// (A1, A2) and keeps a lone letter when the variant has one screen.
enum ScreenRowLabels {
    private static let separators: Set<Character> = [" ", "·", ".", ":", ")", "-"]

    /// `setCaptions` and `setItems` are those of the whole set (default: `captions`, `items`). See `usesVariants`.
    static func labels(
        captions: [String?], items: [String?]?, setCaptions: [String?]? = nil, setItems: [String?]? = nil
    ) -> [ScreenRowLabel] {
        let lettered = usesVariants(setCaptions ?? captions, items: setItems ?? items)
        let letters = captions.map { lettered ? variantLetter($0) : nil }
        var totals: [Character: Int] = [:]
        for letter in letters.compactMap({ $0 }) { totals[letter, default: 0] += 1 }
        let usesItems = items?.contains { $0 != nil } ?? false
        var seen: [Character: Int] = [:]
        return letters.enumerated().map { index, letter in
            let shared = usesItems && (items.flatMap { index < $0.count ? $0[index] : nil } == nil)
            guard let letter else { return ScreenRowLabel(badge: nil, variant: nil, isShared: shared) }
            seen[letter, default: 0] += 1
            let badge = totals[letter, default: 0] > 1 ? "\(letter)\(seen[letter]!)" : String(letter)
            return ScreenRowLabel(badge: badge, variant: letter, isShared: shared)
        }
    }

    /// The variant letter a caption starts with, uppercased: an ASCII letter followed by the end, a
    /// separator, or digits and then the end or a separator. Nil for a word ("Avviso"), an article or a
    /// hyphenated word ("A new ring", "E-mail": only spaces or a hyphen, then a lowercase letter), or no caption.
    static func variantLetter(_ caption: String?) -> Character? {
        guard let text = caption?.trimmingCharacters(in: .whitespaces),
              let first = text.first, first.isASCII, first.isLetter else { return nil }
        var rest = text.dropFirst()
        while let c = rest.first, c.isASCII, c.isNumber { rest = rest.dropFirst() }
        guard rest.first.map(separators.contains) ?? true else { return nil }
        let run = rest.prefix { separators.contains($0) }
        if run == " " || run == "-", let next = rest.dropFirst(run.count).first, next.isLowercase {
            return nil
        }
        return Character(first.uppercased())
    }

    /// Whether a set's captions name variants: at least two different letters (one lettered caption is more likely
    /// a plain title), and, in a set with no `item`, not "b1"-style captions that name two or more decisions
    /// (`DecisionArtifactRule.captionDecision`): there the letter is the decision.
    static func usesVariants(_ captions: [String?], items: [String?]? = nil) -> Bool {
        guard Set(captions.compactMap(variantLetter)).count >= 2 else { return false }
        if items?.contains(where: { $0 != nil }) == true { return true }
        return Set(captions.compactMap(DecisionArtifactRule.captionDecision)).count < 2
    }

    /// The caption without its variant letter ("C · Riepilogo" → "Riepilogo"); nil when nothing is left.
    static func title(caption: String?) -> String? {
        guard let caption else { return nil }
        guard variantLetter(caption) != nil else { return caption }
        let rest = caption.trimmingCharacters(in: .whitespaces).dropFirst()
            .drop { $0.isASCII && $0.isNumber }
            .drop { separators.contains($0) }
        return rest.isEmpty ? nil : String(rest)
    }

    /// The 0-based option of the variant on screen: an option whose anchor names an image of `letter` wins, else
    /// the option at the letter's place (C → third) when there is one. `anchors` has one entry per option; `captions`
    /// are the captions of the whole set, which anchors number.
    static func onScreenOption(letter: Character?, anchors: [String?], captions: [String?]) -> Int? {
        guard let letter else { return nil }
        if let anchored = anchors.firstIndex(where: { anchor in
            DecisionArtifactRule.imageIndex(anchor: anchor, captions: captions)
                .map { variantLetter(captions[$0]) == letter } ?? false
        }) { return anchored }
        guard let ascii = letter.asciiValue, let a = Character("A").asciiValue else { return nil }
        let position = Int(ascii) - Int(a)
        return anchors.indices.contains(position) ? position : nil
    }
}

/// The variant of the screen on show, for the option rows of the decision panel («On screen»).
struct OnScreenVariant: Equatable {
    let letter: Character
    /// The captions of the whole set, which anchors number.
    let captions: [String?]
    /// The decision item the screen belongs to (`item` of the set); nil when the set does not use `item`.
    var item: String? = nil

    /// The 0-based option of this variant, from the options' anchors in order. When the screen belongs to a
    /// decision item, only that decision (`item`) gets one. With no `item` the set cannot say which decision it
    /// belongs to, so only a request with one decision (`decisionCount`) gets one.
    func option(anchors: [String?], item decision: String?, decisionCount: Int) -> Int? {
        if let item {
            guard item == decision else { return nil }
        } else if decisionCount > 1 {
            return nil
        }
        return ScreenRowLabels.onScreenOption(letter: letter, anchors: anchors, captions: captions)
    }
}

extension EnvironmentValues {
    @Entry var onScreenVariant: OnScreenVariant? = nil
}

/// Full size reports whether its set view (every screen at once) is on show.
struct ShowsScreenSetViewKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

extension CommentsSessionStore {
    /// The variant on show while a screenshots set with lettered captions is on screen; nil otherwise.
    var onScreenVariant: OnScreenVariant? {
        guard isScreenshotsCase, let capture = currentCapture, let letter = currentLabel?.variant else { return nil }
        return OnScreenVariant(
            letter: letter, captions: screens.map { captionsByCaptureId[$0.id] }, item: itemsByCaptureId[capture.id])
    }
}

/// Puts the variant on show into the environment, and keeps it current as the person flips screens. `isShowingSet`
/// is false while another tab (HTML, markdown) or the set view is on show: then no option is «On screen».
struct OnScreenVariantProvider: ViewModifier {
    @ObservedObject var store: CommentsSessionStore
    var isShowingSet: Bool

    func body(content: Content) -> some View {
        content.environment(\.onScreenVariant, isShowingSet ? store.onScreenVariant : nil)
    }
}
