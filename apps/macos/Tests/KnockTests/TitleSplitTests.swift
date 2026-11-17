import Foundation
import Testing
@testable import Knock

/// WAG-249: a long title keeps its first sentence; the rest becomes a description.
struct TitleSplitTests {
    @Test func shortTitleIsUnchanged() {
        let split = TitleSplit.make("Ship the side panel?")
        #expect(split.title == "Ship the side panel?")
        #expect(split.description == nil)
    }

    @Test func exactly80CharactersIsUnchanged() {
        let text = String(repeating: "a", count: 79) + "?"
        #expect(text.count == 80)
        #expect(TitleSplit.make(text) == TitleSplit(title: text, description: nil))
    }

    @Test func eightyOneCharactersIsCutOnAWordBoundary() {
        let text = String(repeating: "word ", count: 16) + "end"
        #expect(text.count == 83)
        let split = TitleSplit.make(text)
        #expect(split.title == String(repeating: "word ", count: 15) + "word…")
        #expect(split.description == "end")
        #expect(split.title.count <= 81)
    }

    @Test func longSingleSentenceCutsAtAWordWithAnEllipsis() {
        let text = "Which of these three very different layouts for the flagged conversations inbox should we build first"
        let split = TitleSplit.make(text)
        #expect(split.title == "Which of these three very different layouts for the flagged conversations inbox…")
        #expect(split.description == "should we build first")
    }

    @Test func aCutTitleKeepsItsWholeSentenceForShowAll() {
        let text = "Which of these three very different layouts for the flagged conversations inbox should we build first? "
            + "We can change it later."
        let split = TitleSplit.make(text)
        #expect(split.title == "Which of these three very different layouts for the flagged conversations inbox…")
        #expect(split.description == "should we build first? We can change it later.")
        #expect(split.fullTitle == "Which of these three very different layouts for the flagged conversations inbox should we build first?")
        #expect(split.fullDescription == "We can change it later.")
    }

    @Test func aTitleThatIsNotCutHasNoShowAll() {
        let split = TitleSplit.make("Here is the side panel variant. Open a flagged conversation.")
        #expect(split.fullTitle == nil)
        #expect(split.fullDescription == nil)
        let oneSentence = TitleSplit.make(String(repeating: "word ", count: 16) + "end")
        #expect(oneSentence.fullTitle == String(repeating: "word ", count: 16) + "end")
        #expect(oneSentence.fullDescription == nil)
    }

    @Test func severalSentencesKeepTheFirst() {
        let text = "Here is the side panel variant. Open a flagged conversation. The panel slides in from the right."
        let split = TitleSplit.make(text)
        #expect(split.title == "Here is the side panel variant.")
        #expect(split.description == "Open a flagged conversation. The panel slides in from the right.")
    }

    @Test func aBlankLineSplitsToo() {
        let split = TitleSplit.make("Use the new copy?\n\nDetails here.")
        #expect(split.title == "Use the new copy?")
        #expect(split.description == "Details here.")
    }

    @Test func aDecimalOrAnEllipsisDoesNotSplit() {
        #expect(TitleSplit.make("Bump to 0.2.11?").description == nil)
        #expect(TitleSplit.make("Wait...").description == nil)
    }

    @Test func oneLongParagraphUpdateLeadsWithItsFirstSentence() {
        let message = "Here is the side panel variant. Open a flagged conversation. The panel opens beside the list. "
            + "It keeps the list in view. Tell me if the width feels right. I can try a wider panel."
        let heading = RoundHeading.make(seq: 1, question: nil, message: message, originalTitle: "Which layout?", answer: "Side panel")
        #expect(heading != nil)
        #expect(TitleSplit.make(heading!.title).title == "Here is the side panel variant.")
        #expect(heading!.cardMessage(message) == "")
    }
}
