import SwiftUI

/// The words of "What your agents learned" (WAG-419). Plain, friendly, no em-dashes.
enum LearnedRulesCopy {
    static let label = "What your agents learned"
    static let empty = "No rules yet. When you correct an agent, it writes one here."
    static let footer = "Agents read these rules before they ask you."
    static let addRule = "Add a rule"
    static let edit = "Edit"
    static let onlyThisProject = "Only this project"
    static let everyProject = "Every project"
    static let save = "Save"
    static let cancel = "Cancel"
    static let addPlaceholder = "Write a rule for your agents"
    static let problem = "Waggle could not save this. Try again."
    static let everyProjectName = "Every project"

    static func showMore(_ count: Int) -> String { "Show \(count) more" }
}

/// The ordering, the fold and the lines of the list. Pure, so the words are unit-tested.
enum LearnedRulesLogic {
    /// How many rules show before "Show N more".
    static let foldCount = 5

    /// Every-project rules first, then project rules grouped by project name (case-insensitive). The
    /// order the daemon gave stays inside each group.
    static func ordered(_ rules: [Preference]) -> [Preference] {
        let all = rules.filter { $0.scope == .all }
        let byProject = Dictionary(grouping: rules.filter { $0.scope == .project }) { ($0.project ?? "").lowercased() }
        let groups = byProject.keys.sorted().flatMap { byProject[$0] ?? [] }
        return all + groups
    }

    /// "knock-waggle" reads "Knock waggle": separators become spaces, the first letter is a capital.
    static func projectInWords(_ project: String) -> String {
        let spaced = project.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
            .trimmingCharacters(in: .whitespaces)
        guard let first = spaced.first else { return project }
        return first.uppercased() + spaced.dropFirst()
    }

    /// "Every project · from 7 decisions" or "Waggle · from 1 decision". A rule written by hand has no decisions.
    static func subtitle(_ rule: Preference) -> String {
        let place = rule.scope == .all ? LearnedRulesCopy.everyProjectName : projectInWords(rule.project ?? "")
        let from = rule.evidenceCount == 0
            ? "added by you"
            : (rule.evidenceCount == 1 ? "from 1 decision" : "from \(rule.evidenceCount) decisions")
        return "\(place) · \(from)"
    }
}

/// Holds the list. The daemon owns the rules (only it writes knock.db): every change is sent over an RPC,
/// and a failed send puts the old value back.
@MainActor
final class LearnedRulesModel: ObservableObject {
    @Published private(set) var rules: [Preference] = []
    @Published private(set) var projects: [String] = []
    @Published private(set) var loaded = false
    @Published private(set) var showingAll = false
    @Published private(set) var expanded: Set<String> = []
    @Published private(set) var evidence: [String: PreferenceEvidence] = [:]
    @Published private(set) var editingId: String?
    @Published var editDraft = ""
    @Published private(set) var isAdding = false
    @Published var addDraft = ""
    /// nil: every project.
    @Published var addProject: String?
    @Published private(set) var problem: String?

    private let api: PreferenceAPI
    private let retryDelay: Duration
    private let maxAttempts: Int

    init(api: PreferenceAPI, retryDelay: Duration = .milliseconds(500), maxAttempts: Int = 20) {
        self.api = api
        self.retryDelay = retryDelay
        self.maxAttempts = maxAttempts
    }

    func load() async {
        for attempt in 0..<maxAttempts {
            if let result = try? await api.listPreferences() {
                rules = LearnedRulesLogic.ordered(result.items)
                projects = result.projects
                loaded = true
                return
            }
            if attempt < maxAttempts - 1 { try? await Task.sleep(for: retryDelay) }
        }
    }

    // MARK: The fold

    var visibleRules: [Preference] { showingAll ? rules : Array(rules.prefix(LearnedRulesLogic.foldCount)) }
    var hiddenCount: Int { showingAll ? 0 : max(0, rules.count - LearnedRulesLogic.foldCount) }
    var isEmpty: Bool { loaded && rules.isEmpty }

    /// "Show N more" while rules are folded, then "Add a rule".
    var footerLink: String { hiddenCount > 0 ? LearnedRulesCopy.showMore(hiddenCount) : LearnedRulesCopy.addRule }

    /// The footer link: unfolds the rest, else opens the add form.
    func footerTapped() {
        if hiddenCount > 0 { showingAll = true } else { startAdding() }
    }

    // MARK: Evidence

    func isExpanded(_ rule: Preference) -> Bool { expanded.contains(rule.id) }

    func toggleExpanded(_ rule: Preference) async {
        if expanded.contains(rule.id) {
            expanded.remove(rule.id)
            if editingId == rule.id { cancelEdit() }
            return
        }
        expanded.insert(rule.id)
        if evidence[rule.id] == nil, let loaded = try? await api.preferenceEvidence(id: rule.id) {
            evidence[rule.id] = loaded
        }
    }

    /// The project "Only this project" would use, once the evidence is in.
    func scopeTarget(_ rule: Preference) -> String? { evidence[rule.id]?.project }

    // MARK: Changes

    func setEnabled(_ rule: Preference, _ on: Bool) async {
        guard rule.enabled != on else { return }
        replace(rule.id) { $0.enabled = on }
        problem = nil
        do {
            _ = try await api.setPreferenceEnabled(id: rule.id, enabled: on)
        } catch {
            replace(rule.id) { $0.enabled = !on }
            problem = LearnedRulesCopy.problem
        }
    }

    func startEdit(_ rule: Preference) {
        editingId = rule.id
        editDraft = rule.text
    }

    func cancelEdit() {
        editingId = nil
        editDraft = ""
    }

    func saveEdit() async {
        guard let id = editingId else { return }
        let text = editDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return cancelEdit() }
        problem = nil
        do {
            let saved = try await api.updatePreference(id: id, text: text)
            apply(saved)
            cancelEdit()
        } catch {
            problem = LearnedRulesCopy.problem
        }
    }

    /// "Only this project" for a rule of every project, "Every project" for a project rule.
    func changeScope(_ rule: Preference) async {
        let target: String?
        if rule.scope == .all {
            guard let project = scopeTarget(rule) else { return }
            target = project
        } else {
            target = nil
        }
        problem = nil
        do {
            apply(try await api.setPreferenceScope(id: rule.id, project: target))
        } catch {
            problem = LearnedRulesCopy.problem
        }
    }

    func startAdding() {
        isAdding = true
        addDraft = ""
        addProject = nil
    }

    func cancelAdding() {
        isAdding = false
        addDraft = ""
        addProject = nil
    }

    func commitAdd() async {
        let text = addDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return cancelAdding() }
        problem = nil
        do {
            let saved = try await api.addPreference(text: text, project: addProject)
            apply(saved)
            if let project = saved.project, !projects.contains(project) { projects.append(project) }
            showingAll = true
            cancelAdding()
        } catch {
            problem = LearnedRulesCopy.problem
        }
    }

    // MARK: Helpers

    private func replace(_ id: String, _ change: (inout Preference) -> Void) {
        guard let index = rules.firstIndex(where: { $0.id == id }) else { return }
        change(&rules[index])
    }

    /// Puts a rule the daemon returned into the list (new or changed) and orders the list again.
    private func apply(_ rule: Preference) {
        var next = rules.filter { $0.id != rule.id }
        next.append(rule)
        rules = LearnedRulesLogic.ordered(next)
        // The old target may not fit the new scope.
        evidence[rule.id] = nil
        if expanded.contains(rule.id) {
            Task { if let fresh = try? await api.preferenceEvidence(id: rule.id) { evidence[rule.id] = fresh } }
        }
    }
}

/// "What your agents learned" on the Requests page.
struct LearnedRulesSection: View {
    @StateObject private var model: LearnedRulesModel

    init(client: KnockClient) {
        _model = StateObject(wrappedValue: LearnedRulesModel(api: client))
    }

    init(model: LearnedRulesModel) {
        _model = StateObject(wrappedValue: model)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionLabel(LearnedRulesCopy.label.uppercased())
            if model.isEmpty {
                Text(LearnedRulesCopy.empty)
                    .knockTextStyle(Theme.Typography.body12_5w400)
                    .foregroundColor(Theme.Colors.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 2)
            } else if model.loaded {
                list
            }
            if model.isAdding { addForm }
            if let problem = model.problem {
                Text(problem)
                    .knockTextStyle(Theme.Typography.body12_5w400)
                    .foregroundColor(Theme.Colors.accentText)
            }
            if model.loaded { footer }
        }
        .task { await model.load() }
    }

    private var list: some View {
        let rules = model.visibleRules
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rules.enumerated()), id: \.element.id) { index, rule in
                if index > 0 { hairline }
                LearnedRuleRow(model: model, rule: rule)
            }
        }
        .background(Theme.Colors.win)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.Colors.line, lineWidth: 1))
    }

    private var hairline: some View { Rectangle().fill(Theme.Colors.line).frame(height: 1) }

    private var footer: some View {
        HStack(alignment: .firstTextBaseline) {
            if !model.isEmpty {
                Text(LearnedRulesCopy.footer)
                    .knockTextStyle(Theme.Typography.body12_5w400)
                    .foregroundColor(Theme.Colors.ink3)
            }
            Spacer(minLength: 12)
            if !model.isAdding || model.hiddenCount > 0 {
                RuleLink(model.footerLink) { model.footerTapped() }
            }
        }
        .padding(.horizontal, 2)
    }

    private var addForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(LearnedRulesCopy.addPlaceholder, text: $model.addDraft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .knockTextStyle(Theme.Typography.body13w400)
                .lineLimit(1...4)
                .onSubmit { Task { await model.commitAdd() } }
            HStack(spacing: 16) {
                Menu {
                    Button(LearnedRulesCopy.everyProjectName) { model.addProject = nil }
                    ForEach(model.projects, id: \.self) { project in
                        Button(LearnedRulesLogic.projectInWords(project)) { model.addProject = project }
                    }
                } label: {
                    Text(model.addProject.map(LearnedRulesLogic.projectInWords) ?? LearnedRulesCopy.everyProjectName)
                        .knockTextStyle(Theme.Typography.body12_5w400)
                }
                .menuStyle(.borderlessButton).fixedSize().pointerCursor()
                Spacer()
                RuleLink(LearnedRulesCopy.cancel) { model.cancelAdding() }
                RuleLink(LearnedRulesCopy.save) { Task { await model.commitAdd() } }
            }
        }
        .padding(14)
        .background(Theme.Colors.win)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.Colors.line, lineWidth: 1))
    }
}

/// A text link: grey, underlined, pointing-hand cursor.
private struct RuleLink: View {
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .knockTextStyle(Theme.Typography.body12_5w400)
                .foregroundColor(Theme.Colors.ink2)
                .underline(true, color: Theme.Colors.line)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
    }
}

private struct LearnedRuleRow: View {
    @ObservedObject var model: LearnedRulesModel
    let rule: Preference
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 14) {
                Button(action: { Task { await model.toggleExpanded(rule) } }) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(rule.text)
                            .knockTextStyle(Theme.Typography.button13_5w500)
                            .foregroundColor(rule.enabled ? Theme.Colors.ink : Theme.Colors.ink3)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(LearnedRulesLogic.subtitle(rule))
                            .knockTextStyle(Theme.Typography.body12_5w400)
                            .foregroundColor(Theme.Colors.ink3)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerCursor()
                .accessibilityAddTraits(model.isExpanded(rule) ? [.isSelected] : [])
                Toggle("", isOn: Binding(get: { rule.enabled }, set: { on in Task { await model.setEnabled(rule, on) } }))
                    .labelsHidden()
                    .toggleStyle(.switch).pointerCursor()
                    .accessibilityLabel(rule.text)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 16)
            .background(hovering ? Theme.Colors.list : Color.clear)
            .onHover { hovering = $0 }
            if model.isExpanded(rule) {
                Rectangle().fill(Theme.Colors.line).frame(height: 1)
                unfolded
            }
        }
    }

    private var unfolded: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(model.evidence[rule.id]?.items ?? []) { line in
                HStack(alignment: .top, spacing: 10) {
                    Rectangle().fill(Theme.Colors.honey500).frame(width: 2)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(line.question)
                            .knockTextStyle(Theme.Typography.buttonSm12_5w500)
                            .foregroundColor(Theme.Colors.ink)
                        if !line.did.isEmpty {
                            Text(line.did)
                                .knockTextStyle(Theme.Typography.body12_5w400)
                                .foregroundColor(Theme.Colors.ink2)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            if model.editingId == rule.id {
                TextField(LearnedRulesCopy.addPlaceholder, text: $model.editDraft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .knockTextStyle(Theme.Typography.body13w400)
                    .lineLimit(1...4)
                    .onSubmit { Task { await model.saveEdit() } }
                HStack(spacing: 16) {
                    RuleLink(LearnedRulesCopy.save) { Task { await model.saveEdit() } }
                    RuleLink(LearnedRulesCopy.cancel) { model.cancelEdit() }
                }
            } else {
                HStack(spacing: 16) {
                    RuleLink(LearnedRulesCopy.edit) { model.startEdit(rule) }
                    if rule.scope == .project {
                        RuleLink(LearnedRulesCopy.everyProject) { Task { await model.changeScope(rule) } }
                    } else if model.scopeTarget(rule) != nil {
                        RuleLink(LearnedRulesCopy.onlyThisProject) { Task { await model.changeScope(rule) } }
                    }
                }
            }
        }
        .padding(.vertical, 8)
        .padding(.leading, 16)
        .padding(.trailing, 16)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.list)
    }
}
