import Foundation

// The Brain's rules (WAG-415, WAG-419): "What your agents learned" in Settings > Requests.
// docs/protocol-mvp.md "Project page". The daemon is the only writer.

struct Preference: Decodable, Equatable, Sendable, Identifiable {
    enum Scope: String, Decodable, Sendable { case project, all }

    let id: String
    let scope: Scope
    /// The project of a project rule; nil for a rule that holds for every project.
    let project: String?
    let text: String
    let evidenceCount: Int
    var enabled: Bool

    private enum CodingKeys: String, CodingKey {
        case id, scope, project, text, evidenceCount = "evidence_count", enabled
    }
}

struct PreferenceListResult: Decodable, Equatable, Sendable {
    let items: [Preference]
    let projects: [String]
}

/// One evidence line: the question of a stored case and what the person did.
struct PreferenceEvidenceLine: Decodable, Equatable, Sendable, Identifiable {
    let caseId: String
    let question: String
    let did: String
    var id: String { caseId }

    private enum CodingKeys: String, CodingKey { case caseId = "case_id", question, did }
}

struct PreferenceEvidence: Decodable, Equatable, Sendable {
    let items: [PreferenceEvidenceLine]
    /// The project most of the cases belong to: the target of "Only this project".
    let project: String?
}

private struct PreferenceListParams: Encodable, Sendable {}
private struct PreferenceIdParams: Encodable, Sendable { let id: String }
private struct PreferenceAddParams: Encodable, Sendable {
    let text: String
    let project: String?
    private enum CodingKeys: String, CodingKey { case text, project }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        try c.encodeIfPresent(project, forKey: .project)
    }
}
private struct PreferenceUpdateParams: Encodable, Sendable { let id: String; let text: String }
private struct PreferenceSetScopeParams: Encodable, Sendable {
    let id: String
    let scope: String
    let project: String?
    private enum CodingKeys: String, CodingKey { case id, scope, project }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(scope, forKey: .scope)
        try c.encodeIfPresent(project, forKey: .project)
    }
}

/// What the rules list needs from the daemon. `KnockClient` is the real one; tests use a fake.
protocol PreferenceAPI: Sendable {
    func listPreferences() async throws -> PreferenceListResult
    func preferenceEvidence(id: String) async throws -> PreferenceEvidence
    func setPreferenceEnabled(id: String, enabled: Bool) async throws -> Preference
    func updatePreference(id: String, text: String) async throws -> Preference
    /// Scope all when `project` is nil.
    func setPreferenceScope(id: String, project: String?) async throws -> Preference
    /// Scope all when `project` is nil.
    func addPreference(text: String, project: String?) async throws -> Preference
}

extension KnockClient: PreferenceAPI {
    func listPreferences() async throws -> PreferenceListResult {
        try await call("preference.list", params: PreferenceListParams())
    }

    func preferenceEvidence(id: String) async throws -> PreferenceEvidence {
        try await call("preference.evidence", params: PreferenceIdParams(id: id))
    }

    func setPreferenceEnabled(id: String, enabled: Bool) async throws -> Preference {
        try await call("project.theme_toggle", params: ProjectThemeToggleParams(id: id, enabled: enabled))
    }

    func updatePreference(id: String, text: String) async throws -> Preference {
        try await call("preference.update", params: PreferenceUpdateParams(id: id, text: text))
    }

    func setPreferenceScope(id: String, project: String?) async throws -> Preference {
        try await call(
            "preference.set_scope",
            params: PreferenceSetScopeParams(id: id, scope: project == nil ? "all" : "project", project: project))
    }

    func addPreference(text: String, project: String?) async throws -> Preference {
        try await call("preference.add", params: PreferenceAddParams(text: text, project: project))
    }
}
