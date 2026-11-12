import AppKit
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

    @Test func theTitleDropsTheLetterOfTheCaption() {
        #expect(ScreenRowLabels.title(caption: "C · Riepilogo dopo la sync") == "Riepilogo dopo la sync")
        #expect(ScreenRowLabels.title(caption: "A2: Conferma") == "Conferma")
        #expect(ScreenRowLabels.title(caption: "Avviso in cima") == "Avviso in cima")
        #expect(ScreenRowLabels.title(caption: "B") == nil)
        #expect(ScreenRowLabels.title(caption: nil) == nil)
    }

    @MainActor @Test func galleryLabelsFollowTheDecisionGroup() {
        let store = CommentsSessionStore()
        let captions: [String?] = ["A · uno", "A · due", "B · tre", "Legenda"]
        let images = captions.map { (image: NSImage(size: NSSize(width: 10, height: 10)), caption: $0) }
        let records = store.addScreenshotsCaptures(images: images, revision: 1)
        store.setScreenItems(["d1", "d1", "d1", nil])
        store.showDecisionGroup([0, 1, 3])
        let labels = store.galleryLabels
        #expect(labels.map(\.badge) == ["A1", "A2", nil])
        #expect(labels.map(\.isShared) == [false, false, true])
        store.selectCapture(id: records[1].id)
        #expect(store.currentLabel?.badge == "A2")
    }

    // MARK: «On screen»

    private let setCaptions: [String?] = ["A · uno", "B · due", "C · tre", "C · quattro"]

    @Test func anchorWins() {
        // The second option anchors on image 3, a C screen: it is the option of C, though C is the third letter.
        let position = ScreenRowLabels.onScreenOption(letter: "C", anchors: [nil, "3", nil], captions: setCaptions)
        #expect(position == 1)
    }

    @Test func positionWhenNoAnchor() {
        #expect(ScreenRowLabels.onScreenOption(letter: "C", anchors: [nil, nil, nil], captions: setCaptions) == 2)
    }

    @Test func letterPastTheOptionsMarksNothing() {
        #expect(ScreenRowLabels.onScreenOption(letter: "F", anchors: [nil, nil, nil], captions: setCaptions) == nil)
    }

    @Test func noLetterMarksNothing() {
        #expect(ScreenRowLabels.onScreenOption(letter: nil, anchors: [nil, nil, nil], captions: setCaptions) == nil)
    }
}
