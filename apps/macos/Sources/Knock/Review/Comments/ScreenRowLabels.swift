import Foundation

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

    static func labels(captions: [String?], items: [String?]?) -> [ScreenRowLabel] {
        let letters = captions.map(variantLetter)
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
    /// separator, or digits and then the end or a separator. Nil for a word ("Avviso") or no caption.
    static func variantLetter(_ caption: String?) -> Character? {
        guard let text = caption?.trimmingCharacters(in: .whitespaces),
              let first = text.first, first.isASCII, first.isLetter else { return nil }
        var rest = text.dropFirst()
        while let c = rest.first, c.isASCII, c.isNumber { rest = rest.dropFirst() }
        guard rest.first.map(separators.contains) ?? true else { return nil }
        return Character(first.uppercased())
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
}
