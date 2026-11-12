import Testing
@testable import Knock

@Suite struct ScreenRowLabelsTests {
    private func badges(_ captions: [String?], items: [String?]? = nil) -> [String?] {
        ScreenRowLabels.labels(captions: captions, items: items).map(\.badge)
    }

    @Test func oneScreenPerVariant() {
        #expect(badges(["A · x", "B · y", "C · z"]) == ["A", "B", "C"])
    }

    @Test func severalScreensNumbered() {
        #expect(badges(["A · x", "A · y", "B · z", "C · 1", "C · 2"]) == ["A1", "A2", "B", "C1", "C2"])
    }

    @Test func plainCaptionsGetNoBadge() {
        let labels = ScreenRowLabels.labels(captions: ["Riga", nil], items: nil)
        #expect(labels.map(\.badge) == [nil, nil])
        #expect(labels.map(\.variant) == [nil, nil])
    }

    @Test func letterCaseAndSeparatorsAgree() {
        #expect(badges(["A · x", "a · y", "A: z"]) == ["A1", "A2", "A3"])
    }

    @Test func letterNumberCaptionIsVariantA() {
        #expect(badges(["A1 · x", "A2 · y"]) == ["A1", "A2"])
        #expect(ScreenRowLabels.variantLetter("A1 · x") == "A")
    }

    @Test func sharedComesFromItems() {
        let withItems = ScreenRowLabels.labels(captions: ["A · x", "Legenda"], items: ["d1", nil])
        #expect(withItems.map(\.isShared) == [false, true])
        let noItems = ScreenRowLabels.labels(captions: ["A · x", "Legenda"], items: nil)
        #expect(noItems.map(\.isShared) == [false, false])
    }

    @Test func wordIsNotAVariant() {
        #expect(badges(["Legend", "Avviso"]) == [nil, nil])
        #expect(ScreenRowLabels.variantLetter("Avviso") == nil)
    }
}
