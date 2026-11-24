import Foundation
import Testing
@testable import Knock

/// WAG-419: "What your agents learned": the order, the fold of 5, the empty state, the switch, and the edits.
@MainActor
struct LearnedRulesTests {
    private func rule(_ id: String, _ scope: Preference.Scope = .all, project: String? = nil, text: String? = nil,
                      count: Int = 3, enabled: Bool = true) -> Preference {
        Preference(id: id, scope: scope, project: project, text: text ?? "Rule \(id)", evidenceCount: count, enabled: enabled)
    }

    final class FakeAPI: PreferenceAPI, @unchecked Sendable {
        var items: [Preference]
        var projects: [String]
        var evidence: [String: PreferenceEvidence] = [:]
        var failWrites = false
        private(set) var toggled: [(String, Bool)] = []
        private(set) var added: [(String, String?)] = []
        private(set) var scoped: [(String, String?)] = []
        private(set) var updated: [(String, String)] = []

        init(items: [Preference], projects: [String] = []) {
            self.items = items
            self.projects = projects
        }

        struct Down: Error {}

        func listPreferences() async throws -> PreferenceListResult { PreferenceListResult(items: items, projects: projects) }
        func preferenceEvidence(id: String) async throws -> PreferenceEvidence {
            evidence[id] ?? PreferenceEvidence(items: [], project: nil)
        }
        func setPreferenceEnabled(id: String, enabled: Bool) async throws -> Preference {
            if failWrites { throw Down() }
            toggled.append((id, enabled))
            return items.first { $0.id == id }!
        }
        func updatePreference(id: String, text: String) async throws -> Preference {
            if failWrites { throw Down() }
            updated.append((id, text))
            let old = items.first { $0.id == id }!
            return Preference(id: id, scope: old.scope, project: old.project, text: text, evidenceCount: old.evidenceCount, enabled: old.enabled)
        }
        func setPreferenceScope(id: String, project: String?) async throws -> Preference {
            if failWrites { throw Down() }
            scoped.append((id, project))
            let old = items.first { $0.id == id }!
            return Preference(id: id, scope: project == nil ? .all : .project, project: project, text: old.text,
                              evidenceCount: old.evidenceCount, enabled: old.enabled)
        }
        func addPreference(text: String, project: String?) async throws -> Preference {
            if failWrites { throw Down() }
            added.append((text, project))
            return Preference(id: "new", scope: project == nil ? .all : .project, project: project, text: text,
                              evidenceCount: 0, enabled: true)
        }
    }

    private func loaded(_ items: [Preference], projects: [String] = []) async -> (LearnedRulesModel, FakeAPI) {
        let api = FakeAPI(items: items, projects: projects)
        let model = LearnedRulesModel(api: api, retryDelay: .milliseconds(1), maxAttempts: 2)
        await model.load()
        return (model, api)
    }

    @Test func ordersEveryProjectFirstThenProjectsGrouped() async {
        let (model, _) = await loaded([
            rule("w1", .project, project: "website"),
            rule("g1", .project, project: "Waggle"),
            rule("a1"),
            rule("g2", .project, project: "waggle"),
            rule("a2"),
        ])
        #expect(model.rules.map(\.id) == ["a1", "a2", "g1", "g2", "w1"])
    }

    @Test func foldsAtFiveThenShowsTheRestThenAddARule() async {
        let (model, _) = await loaded((1...9).map { rule("r\($0)") })
        #expect(model.visibleRules.count == 5)
        #expect(model.footerLink == "Show 4 more")
        model.footerTapped()
        #expect(model.visibleRules.count == 9)
        #expect(model.footerLink == "Add a rule")
        model.footerTapped()
        #expect(model.isAdding)
    }

    @Test func fiveOrFewerRulesShowAddARuleAtOnce() async {
        let (model, _) = await loaded((1...5).map { rule("r\($0)") })
        #expect(model.visibleRules.count == 5)
        #expect(model.hiddenCount == 0)
        #expect(model.footerLink == "Add a rule")
    }

    @Test func emptyState() async {
        let (model, _) = await loaded([])
        #expect(model.isEmpty)
        #expect(LearnedRulesCopy.empty == "No rules yet. When you correct an agent, it writes one here.")
        #expect(model.footerLink == "Add a rule")
    }

    @Test func subtitleLines() {
        #expect(LearnedRulesLogic.subtitle(rule("a", count: 7)) == "Every project · from 7 decisions")
        #expect(LearnedRulesLogic.subtitle(rule("a", count: 1)) == "Every project · from 1 decision")
        #expect(LearnedRulesLogic.subtitle(rule("p", .project, project: "knock-waggle", count: 2)) == "Knock waggle · from 2 decisions")
        #expect(LearnedRulesLogic.subtitle(rule("h", count: 0)) == "Every project · added by you")
    }

    @Test func toggleSavesAndKeepsTheOrder() async {
        let (model, api) = await loaded([rule("a"), rule("b")])
        await model.setEnabled(model.rules[1], false)
        #expect(model.rules[1].enabled == false)
        #expect(api.toggled.count == 1 && api.toggled[0].0 == "b" && api.toggled[0].1 == false)
        #expect(model.problem == nil)
    }

    @Test func failedToggleGoesBack() async {
        let (model, api) = await loaded([rule("a")])
        api.failWrites = true
        await model.setEnabled(model.rules[0], false)
        #expect(model.rules[0].enabled == true)
        #expect(model.problem == LearnedRulesCopy.problem)
    }

    @Test func unfoldLoadsEvidenceOnce() async {
        let (model, api) = await loaded([rule("a")])
        api.evidence["a"] = PreferenceEvidence(
            items: [PreferenceEvidenceLine(caseId: "c1", question: "Layout?", did: "Picked Compact.")], project: "waggle")
        await model.toggleExpanded(model.rules[0])
        #expect(model.isExpanded(model.rules[0]))
        #expect(model.evidence["a"]?.items.first?.question == "Layout?")
        #expect(model.scopeTarget(model.rules[0]) == "waggle")
        await model.toggleExpanded(model.rules[0])
        #expect(!model.isExpanded(model.rules[0]))
    }

    @Test func editSavesTheText() async {
        let (model, api) = await loaded([rule("a")])
        model.startEdit(model.rules[0])
        model.editDraft = "  New words  "
        await model.saveEdit()
        #expect(api.updated.first?.1 == "New words")
        #expect(model.rules[0].text == "New words")
        #expect(model.editingId == nil)
    }

    @Test func scopeChangeBothWays() async {
        let (model, api) = await loaded([rule("a")])
        api.evidence["a"] = PreferenceEvidence(items: [], project: "waggle")
        await model.toggleExpanded(model.rules[0])
        await model.changeScope(model.rules[0])
        #expect(api.scoped.first?.1 == "waggle")
        #expect(model.rules[0].scope == .project)
        await model.changeScope(model.rules[0])
        #expect(api.scoped.last?.1 == nil)
        #expect(model.rules[0].scope == .all)
    }

    @Test func addByHandIsEveryProjectUnlessAProjectIsPicked() async {
        let (model, api) = await loaded([rule("a")], projects: ["waggle"])
        model.startAdding()
        model.addDraft = " Keep it short "
        await model.commitAdd()
        #expect(api.added.last?.0 == "Keep it short" && api.added.last?.1 == nil)
        #expect(model.rules.contains { $0.id == "new" && $0.scope == .all })
        #expect(!model.isAdding)
        model.startAdding()
        model.addDraft = "Use tabs"
        model.addProject = "waggle"
        await model.commitAdd()
        #expect(api.added.last?.1 == "waggle")
    }

    @Test func decodesTheDaemonShapes() throws {
        let json = """
        {"items":[{"id":"th_1","scope":"project","project":"waggle","text":"T","evidence_count":2,"quotes":[],"case_ids":["c"],
         "enabled":false,"proposed_by":null,"created_at":"x","updated_at":"y"}],"projects":["waggle"]}
        """
        let list = try JSONDecoder().decode(PreferenceListResult.self, from: Data(json.utf8))
        #expect(list.items[0].project == "waggle" && list.items[0].enabled == false && list.projects == ["waggle"])
        let ev = try JSONDecoder().decode(
            PreferenceEvidence.self, from: Data(#"{"items":[{"case_id":"c","question":"Q","did":"Picked A."}],"project":null}"#.utf8))
        #expect(ev.items[0].did == "Picked A." && ev.project == nil)
    }
}
