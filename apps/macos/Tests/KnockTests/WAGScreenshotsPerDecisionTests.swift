import AppKit
import Foundation
import Testing
@testable import Knock

/// A screenshots set in a request with several decisions: the images of each decision.
@MainActor
struct ScreenshotsPerDecisionTests {
    private func focus(_ index: Int, count: Int = 3, itemIds: [String] = [], anchor: String? = nil) -> DecisionFocus {
        let option = Option(id: "a", label: "A", anchor: anchor)
        return DecisionFocus(index: index, count: count, options: [option], chosen: ["a"], recommended: [], itemIds: itemIds)
    }

    private func group(_ index: Int, count: Int = 3, ids: [String] = [], captions: [String?], items: [String?]? = nil) -> [Int]? {
        DecisionArtifactRule.imageGroup(for: focus(index, count: count, itemIds: ids), captions: captions, items: items)
    }

    // MARK: The field

    @Test func theItemFieldGivesTheImagesOfEachDecision() {
        let items: [String?] = ["ring", "ring", "badge", "badge", "badge", "streak"]
        let captions = [String?](repeating: nil, count: 6)
        #expect(group(0, ids: ["ring"], captions: captions, items: items) == [0, 1])
        #expect(group(1, ids: ["badge"], captions: captions, items: items) == [2, 3, 4])
        #expect(group(2, ids: ["streak"], captions: captions, items: items) == [5])
    }

    @Test func theFieldBeatsTheCaptionPrefix() {
        let items: [String?] = ["x", "y", "x"]
        let captions: [String?] = ["b · one", "a · two", "c · three"]
        #expect(group(0, ids: ["x"], captions: captions, items: items) == [0, 2])
    }

    @Test func aDecisionWithNoImageOfItsOwnAndNoSharedImageHasNoGroup() {
        #expect(group(2, ids: ["z"], captions: [nil, nil], items: ["x", "y"]) == nil)
    }

    // MARK: The caption prefix

    @Test(arguments: [
        ["1 Tap", "2 Tap", "3 Tap"],
        ["1. Tap", "2. Tap", "3. Tap"],
        ["1: Tap", "2: Tap", "3: Tap"],
        ["1) Tap", "2) Tap", "3) Tap"],
        ["1 · Tap", "2 · Tap", "3 · Tap"],
        ["1 - Tap", "2 - Tap", "3 - Tap"],
        ["a1 Tap", "b1 Tap", "c1 Tap"],
        ["a1", "b1", "c1"],
    ])
    func eachPrefixFormNamesTheDecision(captions: [String]) {
        #expect(group(1, captions: captions) == [1])
        #expect(group(2, captions: captions) == [2])
    }

    @Test func severalImagesOfOneDecisionShareAPrefix() {
        let captions: [String?] = ["a1 · idle", "b1 · idle", "b2 · tapped", "c1 · done"]
        #expect(group(1, captions: captions) == [1, 2])
    }

    /// The variants A, B, C of the first decision stay together: a lone letter is a variant, not a decision.
    @Test(arguments: [
        ["A · Banner in the page", "B · Row in the check panel", "C · Sync summary", "Legend"],
        ["a Tap", "b Tap", "c Tap"],
        ["A. Tap", "B) Tap", "C - Tap"],
    ])
    func loneLetterVariantsAreNotSplitAcrossDecisions(captions: [String]) {
        #expect(DecisionArtifactRule.captionDecision(captions[0]) == nil)
        for index in 0..<4 { #expect(group(index, count: 4, captions: captions) == nil) }
    }

    @Test func aCaptionWithNoPrefixIsNotADecisionAndLoneProseIsIgnored() {
        #expect(DecisionArtifactRule.captionDecision("Tap on the ring") == nil)
        #expect(DecisionArtifactRule.captionDecision("Apple") == nil)
        // A big number names a decision the request does not have, so it is no grouping.
        #expect(group(0, captions: ["2026 plan", "a · x", "Done"]) == nil)
        #expect(DecisionArtifactRule.captionDecision("2") == nil)
        // One caption that looks like a prefix ("A new ring") does not make a grouping.
        #expect(group(0, captions: ["A new ring", "Tap on the ring", "Done"]) == nil)
    }

    @Test func aPrefixOutsideTheRequestIsNotAGrouping() {
        #expect(group(0, count: 2, captions: ["a · x", "e · y"]) == nil)
    }

    // MARK: An image with no decision, one decision

    @Test func anImageWithNoDecisionShowsWithEveryDecision() {
        let items: [String?] = ["ring", nil, "badge"]
        #expect(group(0, ids: ["ring"], captions: [nil, nil, nil], items: items) == [0, 1])
        #expect(group(1, ids: ["badge"], captions: [nil, nil, nil], items: items) == [1, 2])
        let captions: [String?] = ["1 · x", "Legend", "2 · y"]
        #expect(group(1, captions: captions) == [1, 2])
    }

    @Test func aRequestWithOneDecisionShowsAllImages() {
        #expect(group(0, count: 1, ids: ["ring"], captions: ["a · x", "b · y"], items: ["ring", "badge"]) == nil)
    }

    @Test func aSetWithNeitherFieldNorPrefixKeepsTodaysRule() {
        let tab = ArtifactTabs.tabs(revisions: [
            Revision(id: "r1", caseId: "c1", n: 1, createdAt: "2026-10-10T10:00:00Z", author: .agent, baseRevision: nil, name: "Deck", kind: .screenshots),
        ])
        let target = DecisionArtifactRule.target(for: focus(1), tabs: tab, current: tab[0].id) { _ in ["x", "y", "z"] }
        #expect(target == DecisionArtifactTarget(tabId: nil, anchor: nil, image: 1))
    }

    // MARK: The anchor inside a group

    private func target(_ f: DecisionFocus, captions: [String?], items: [String?]) -> DecisionArtifactTarget? {
        let tab = ArtifactTabs.tabs(revisions: [
            Revision(id: "r1", caseId: "c1", n: 1, createdAt: "2026-10-10T10:00:00Z", author: .agent, baseRevision: nil, name: "Deck", kind: .screenshots),
        ])
        return DecisionArtifactRule.target(for: f, tabs: tab, current: tab[0].id, captions: { _ in captions }, items: { _ in items })
    }

    @Test func aDecisionOpensOnItsFirstImage() {
        let items: [String?] = ["ring", "ring", "badge", "badge"]
        let t = target(focus(1, count: 2, itemIds: ["badge"]), captions: [nil, nil, nil, nil], items: items)
        #expect(t == DecisionArtifactTarget(tabId: nil, anchor: nil, image: 2, group: [2, 3]))
    }

    @Test func theAnchorOfThePickWinsInsideTheGroup() {
        let items: [String?] = ["ring", "ring", "badge", "badge"]
        let t = target(focus(1, count: 2, itemIds: ["badge"], anchor: "4"), captions: [nil, nil, nil, nil], items: items)
        #expect(t?.image == 3)
        #expect(t?.group == [2, 3])
    }

    @Test func anAnchorOutsideTheGroupFallsBackToTheFirstImageOfTheGroup() {
        let items: [String?] = ["ring", "ring", "badge", "badge"]
        let t = target(focus(1, count: 2, itemIds: ["badge"], anchor: "1"), captions: [nil, nil, nil, nil], items: items)
        #expect(t?.image == 2)
    }

    // MARK: The box and the strip

    private func store(count: Int) -> (CommentsSessionStore, [CaptureRecord]) {
        let store = CommentsSessionStore()
        let images = (0..<count).map { _ in (image: NSImage(size: NSSize(width: 10, height: 10)), caption: String?.none) }
        let records = store.addScreenshotsCaptures(images: images, revision: 1)
        return (store, records)
    }

    @Test func theStripShowsOnlyTheDecisionsImagesAndStepsInsideThem() {
        let (store, records) = store(count: 6)
        store.setScreenItems(["ring", "ring", "badge", "badge", "badge", nil])
        #expect(store.galleryScreens.count == 6)
        store.showDecisionGroup([2, 3, 4, 5])
        #expect(store.galleryScreens.map(\.id) == records[2...5].map(\.id))
        store.showDecisionGroup(nil)
        #expect(store.galleryScreens.count == 6)
        #expect(store.items(ofSet: 1) == ["ring", "ring", "badge", "badge", "badge", nil])
    }
}
