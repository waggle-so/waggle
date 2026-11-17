import Testing
import Foundation
@testable import Knock

/// WAG-418: "Based on N past decisions" on the case view.
struct WAG418Tests {
    private let base = #"{"id":"c_1","task_id":"t_1","kind":"question","title":"Name the helper","need":"N","why":"W","recommendation":"a","recommendation_why":"RW","options":[{"id":"a","label":"Call it parseRow","title":"parseRow"}],"status":"resolved","has_artifact":false,"runtime":"claude","created_at":"2026-10-27T10:00:00.000Z","updated_at":"2026-10-27T10:00:00.000Z""#

    @Test func decodesWithTheKey() throws {
        let json = base + #","matched_case_ids":["c_a","c_b"]}"#
        let decoded = try JSONDecoder().decode(Case.self, from: Data(json.utf8))
        #expect(decoded.matchedCaseIds == ["c_a", "c_b"])
    }

    @Test func decodesWithoutTheKey() throws {
        let decoded = try JSONDecoder().decode(Case.self, from: Data((base + "}").utf8))
        #expect(decoded.matchedCaseIds == nil)
    }

    @Test func lineTextForOneAndMany() {
        #expect(PastDecisions.label(count: 1) == "Based on 1 past decision")
        #expect(PastDecisions.label(count: 2) == "Based on 2 past decisions")
        #expect(PastDecisions.label(count: 7) == "Based on 7 past decisions")
    }

    @Test func aMissingCaseIsLeftOut() throws {
        let one = try JSONDecoder().decode(Case.self, from: Data((base + "}").utf8))
        let found = PastDecisions.found(ids: ["gone", "c_1"], loaded: ["c_1": one])
        #expect(found.map(\.id) == ["c_1"])
        #expect(PastDecisions.found(ids: ["gone"], loaded: [:]).isEmpty)
    }
}
