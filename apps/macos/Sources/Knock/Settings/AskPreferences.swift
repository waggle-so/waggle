import SwiftUI

/// The copy on the ask preferences (HAIL-101, prototype `h101-onboard`). Plain
/// words for the operator; the daemon holds the separate text agents read.
extension AskTopic {
    var title: String {
        switch self {
        case .marketing: "Marketing and campaigns"
        case .design: "Design and UX"
        case .operations: "Operations and process"
        case .pricing: "Pricing and money"
        case .code: "Code and architecture"
        case .writing: "Writing and naming"
        case .data: "Data and numbers"
        case .personal: "Personal and creative"
        case .reviews: "Reviews before something ships"
        case .privateInfo: "Info only I have (keys, accounts)"
        }
    }
}

extension AskScope {
    var title: String {
        switch self {
        case .any: "Anything"
        case .pick: "Let me pick"
        }
    }
}

extension AskFrequency {
    var title: String {
        switch self {
        case .blocked: "Only when blocked"
        case .choice: "When there's a real choice"
        case .chat: "Anything they'd ask in chat"
        }
    }
}

extension AskDetail {
    var title: String {
        switch self {
        case .brief: "Brief"
        case .rich: "Rich"
        }
    }

    var note: String {
        switch self {
        case .brief: "Short requests: the need, one line on why, and the options with a pick."
        case .rich: "Agents add where things stand and what they tried, and attach an artifact when needed."
        }
    }
}

extension AskWords {
    var title: String {
        switch self {
        case .asd: "Simple, exact English (ASD-STE100)"
        case .normal: "Normal"
        }
    }
}

extension AskLearn {
    var title: String {
        switch self {
        case .short: "Short text"
        case .diagram: "Diagram first"
        case .steps: "Step by step"
        case .try: "Something to try"
        }
    }

    var note: String {
        switch self {
        case .short: "When you ask how something works, agents answer in up to 3 short lines."
        case .diagram: "When you ask how something works, agents start with a small diagram of the parts, then up to 3 short lines."
        case .steps: "When you ask how something works, agents walk you through it in numbered steps."
        case .try: "When you ask how something works, agents send a small page you can click through."
        }
    }
}

extension AskAfterDecide {
    var title: String {
        switch self {
        case .nothing: "Nothing"
        case .record: "A record"
        case .recordTasks: "A record and tasks"
        }
    }
}

/// The "What comes to Knock" copy (HAIL-109, prototype `h109-format`). Each
/// level is also a column: a column goes to Knock when it is at or left of the
/// chosen level.
extension AskReach {
    var title: String {
        switch self {
        case .off: "Off"
        case .visual: "Things to look at"
        case .written: "Write-ups and drafts"
        case .everything: "Quick questions"
        }
    }

    /// The name in the menu bar switch (HAIL-193). The same words the daemon puts in the
    /// "Waggle mode changed" line agents read.
    var menuTitle: String {
        switch self {
        case .off: "Off"
        case .visual: "Things to look at"
        case .written: "Look and read"
        case .everything: "Everything"
        }
    }

    /// The kinds of request, one column each. Off is a level, not a kind.
    static var kinds: [AskReach] { allCases.filter { $0 != .off } }

    var kindNote: String {
        switch self {
        case .off: "Nothing comes to Waggle"
        case .visual: "Prototypes, designs, screenshots, charts, pages"
        case .written: "A plan, a trade-off, a draft to read"
        case .everything: "A yes/no, a name, a default"
        }
    }

    var examples: [String] {
        switch self {
        case .off: []
        case .visual: ["Pricing card: compact or detailed?", "Three hero designs from Pen: which one?"]
        case .written: ["Migrate to Postgres now or after launch?", "Is this reply to the customer too blunt?"]
        case .everything: ["Keep the default port 3000?", "Name the branch fix/login or login-fix?"]
        }
    }

    /// The line under the slider for this level.
    var summary: String {
        switch self {
        case .off: "Off · agents keep every question in the terminal. Waggle stays installed and quiet"
        case .everything: "Everything · every decision comes to Waggle (today)"
        case .written: "Things to look at and read · quick questions stay in the terminal"
        case .visual: "Only things to look at · write-ups and quick questions stay in the terminal"
        }
    }

    var stopIndex: Int { Self.allCases.firstIndex(of: self) ?? 0 }

    /// Whether asks of the `kind` column come to Knock at this level.
    /// Off brings nothing: its index is 0 and every kind sits at 1 or more.
    func bringsToKnock(_ kind: AskReach) -> Bool { kind.stopIndex <= stopIndex }
}

/// Holds the four ask preferences and the text the daemon generates from
/// them. The daemon owns every value (only it writes knock.db) and the text,
/// so a pick is sent over `settings.set`, then the text is read again. A failed
/// send puts the previous pick back. Shared by Setup step 3 and Settings › Asks.
@MainActor
final class AskPreferencesModel: ObservableObject {
    /// The daemon's defaults, shown until the first read lands.
    @Published private(set) var topics = AskTopics(
        scope: .any, picked: [.design, .code, .writing, .reviews, .privateInfo])
    @Published private(set) var frequency: AskFrequency = .choice
    @Published private(set) var detail: AskDetail = .brief
    @Published private(set) var reach: AskReach = .everything
    @Published private(set) var words: AskWords = .asd
    @Published private(set) var learn: AskLearn = .short
    @Published private(set) var afterDecide: AskAfterDecide = .recordTasks
    /// What Knock tells agents at the start of every session. Empty until the
    /// daemon answers.
    @Published private(set) var text = ""

    private let client: KnockClient
    private let retryDelay: Duration
    private let maxAttempts: Int

    init(client: KnockClient, retryDelay: Duration = .milliseconds(500), maxAttempts: Int = 20) {
        self.client = client
        self.retryDelay = retryDelay
        self.maxAttempts = maxAttempts
    }

    /// The socket may still be connecting (or the daemon still starting on
    /// demand) when the screen first appears, so a failed read is retried for a
    /// few seconds rather than leaving the defaults showing.
    func load() async {
        for attempt in 0..<maxAttempts {
            if let stored = try? await client.askTopics(),
               let storedFrequency = try? await client.askFrequency(),
               let storedDetail = try? await client.askDetail() {
                topics = stored
                frequency = storedFrequency
                detail = storedDetail
                // An older daemon has no askReach: that reads as "everything".
                reach = (try? await client.askReach()) ?? .everything
                // An older daemon has no askWords: that reads as "asd".
                words = (try? await client.askWords()) ?? .asd
                // An older daemon has no askLearn: that reads as "short".
                learn = (try? await client.askLearn()) ?? .short
                // An older daemon has no askAfterDecide: that reads as "record_tasks".
                afterDecide = (try? await client.askAfterDecide()) ?? .recordTasks
                await refreshText()
                return
            }
            if attempt < maxAttempts - 1 { try? await Task.sleep(for: retryDelay) }
        }
    }

    /// Reads the level again, without the retry loop of `load()`. The menu bar calls it each time
    /// the menu opens, so a pick made in Settings (or by another window) shows there.
    func refreshReach() async {
        if let stored = try? await client.askReach(), stored != reach { reach = stored }
    }

    func setScope(_ scope: AskScope) async {
        guard scope != topics.scope else { return }
        var next = topics
        next.scope = scope
        await sendTopics(next)
    }

    func toggle(_ topic: AskTopic) async {
        var next = topics
        if let index = next.picked.firstIndex(of: topic) {
            next.picked.remove(at: index)
        } else {
            next.picked.append(topic)
        }
        await sendTopics(next)
    }

    func setFrequency(_ next: AskFrequency) async {
        guard next != frequency else { return }
        let previous = frequency
        frequency = next
        do {
            try await client.setAskFrequency(next)
            await refreshText()
        } catch {
            frequency = previous
        }
    }

    func setDetail(_ next: AskDetail) async {
        guard next != detail else { return }
        let previous = detail
        detail = next
        do {
            try await client.setAskDetail(next)
            await refreshText()
        } catch {
            detail = previous
        }
    }

    func setReach(_ next: AskReach) async {
        guard next != reach else { return }
        let previous = reach
        reach = next
        do {
            try await client.setAskReach(next)
            await refreshText()
        } catch {
            reach = previous
        }
    }

    func setWords(_ next: AskWords) async {
        guard next != words else { return }
        let previous = words
        words = next
        do {
            try await client.setAskWords(next)
            await refreshText()
        } catch {
            words = previous
        }
    }

    func setLearn(_ next: AskLearn) async {
        guard next != learn else { return }
        let previous = learn
        learn = next
        do {
            try await client.setAskLearn(next)
            await refreshText()
        } catch {
            learn = previous
        }
    }

    func setAfterDecide(_ next: AskAfterDecide) async {
        guard next != afterDecide else { return }
        let previous = afterDecide
        afterDecide = next
        do {
            try await client.setAskAfterDecide(next)
        } catch {
            afterDecide = previous
        }
    }

    private func sendTopics(_ next: AskTopics) async {
        let previous = topics
        topics = next
        do {
            topics = try await client.setAskTopics(next)
            await refreshText()
        } catch {
            topics = previous
        }
    }

    private func refreshText() async {
        if let fresh = try? await client.askText() { text = fresh }
    }
}

/// The three preference sections and the generated text, as the prototype
/// shows them. Used by Setup step 3 and Settings › Asks.
struct AskPreferencesView: View {
    @ObservedObject var model: AskPreferencesModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            section("BRING ME") {
                AskSegmented(options: AskScope.allCases, selected: model.topics.scope, title: \.title) { scope in
                    Task { await model.setScope(scope) }
                }
                if model.topics.scope == .pick {
                    AskTopicChecklist(model: model)
                }
            }
            section("WHAT COMES TO WAGGLE") {
                AskReachView(selected: model.reach) { level in
                    Task { await model.setReach(level) }
                }
            }
            section("HOW OFTEN") {
                AskSegmented(options: AskFrequency.allCases, selected: model.frequency, title: \.title) { value in
                    Task { await model.setFrequency(value) }
                }
            }
            section("DETAIL") {
                AskSegmented(options: AskDetail.allCases, selected: model.detail, title: \.title) { value in
                    Task { await model.setDetail(value) }
                }
                Text(model.detail.note)
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .foregroundColor(Theme.Colors.ink3)
            }
            section("HOW AGENTS WRITE TO YOU") {
                AskSegmented(options: AskWords.allCases, selected: model.words, title: \.title) { value in
                    Task { await model.setWords(value) }
                }
                Text("Short sentences, one instruction each, approved words only. This is ASD-STE100, Simplified Technical English, the controlled language of aircraft maintenance manuals.")
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .foregroundColor(Theme.Colors.ink3)
            }
            section("HOW YOU LIKE TO LEARN") {
                AskSegmented(options: AskLearn.allCases, selected: model.learn, title: \.title) { value in
                    Task { await model.setLearn(value) }
                }
                Text(model.learn.note)
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .foregroundColor(Theme.Colors.ink3)
            }
            section("AFTER YOU DECIDE") {
                AskSegmented(options: AskAfterDecide.allCases, selected: model.afterDecide, title: \.title) { value in
                    Task { await model.setAfterDecide(value) }
                }
                Text("After you decide, your agent writes down what you chose and why, in docs/decisions, and plans the work from it.")
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .foregroundColor(Theme.Colors.ink3)
            }
            agentText
        }
    }

    private func section<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionLabel(label)
            content()
        }
    }

    private var agentText: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionLabel("WHAT WAGGLE TELLS YOUR AGENTS AT THE START OF EVERY SESSION")
            Text(model.text.isEmpty ? " " : model.text)
                .knockTextStyle(Theme.Typography.monoMeta12w400)
                .foregroundColor(Theme.Colors.ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.side)
        .cornerRadius(10)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.Colors.line, lineWidth: 1))
    }
}

/// The slider (Off and three stops) and its three columns (prototype `.ladder`).
/// A click on a stop or a column sets the level. `recommended` marks one level
/// (HAIL-193: "Things to look at").
struct AskReachView: View {
    let selected: AskReach
    var recommended: AskReach? = .visual
    let onSelect: (AskReach) -> Void

    private static let stopSize: CGFloat = 16
    private static let inBorder = Theme.Colors.reachBorder
    private static let inFill = Theme.Colors.reachFill

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            track
            HStack(alignment: .top, spacing: 8) {
                ForEach(AskReach.kinds) { kind in column(kind) }
            }
            .fixedSize(horizontal: false, vertical: true)
            Text(selected.summary)
                .knockTextStyle(Theme.Typography.caption11_5w400)
                .foregroundColor(Theme.Colors.ink2)
        }
        .animation(.easeOut(duration: 0.15), value: selected)
    }

    private var track: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let third = width / CGFloat(AskReach.allCases.count)
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.Colors.sel).frame(height: 6)
                Capsule().fill(Theme.Colors.accent)
                    .frame(width: selected == .off ? 0 : third * CGFloat(selected.stopIndex + 1), height: 6)
                ForEach(AskReach.allCases) { level in
                    let isOn = level == .off ? selected == .off : level.stopIndex <= selected.stopIndex
                    Button(action: { onSelect(level) }) {
                        Circle()
                            .fill(Theme.Colors.win)
                            .overlay(Circle().stroke(isOn ? Theme.Colors.accent : Theme.Colors.line2, lineWidth: 2))
                            .frame(width: Self.stopSize, height: Self.stopSize)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain).pointerCursor()
                    .accessibilityLabel(level.title)
                    .accessibilityAddTraits(level == selected ? [.isSelected] : [])
                    .offset(x: third * (CGFloat(level.stopIndex) + 0.5) - Self.stopSize / 2)
                }
            }
            .frame(height: Self.stopSize)
        }
        .frame(height: Self.stopSize)
    }

    private func column(_ kind: AskReach) -> some View {
        let inKnock = selected.bringsToKnock(kind)
        return Button(action: { onSelect(kind) }) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 6) {
                    Text(kind.title)
                        .knockTextStyle(Theme.Typography.buttonSm12_5w600)
                        .foregroundColor(Theme.Colors.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Text(inKnock ? "Waggle" : "Terminal")
                        .knockTextStyle(Theme.Typography.monoMetaRow10_5w600)
                        .foregroundColor(inKnock ? Theme.Colors.win : Theme.Colors.ink3)
                        .padding(.vertical, 2)
                        .padding(.horizontal, 7)
                        .background(inKnock ? Theme.Colors.accent : Theme.Colors.sel)
                        .cornerRadius(5)
                        .fixedSize()
                }
                if kind == recommended {
                    Text("Recommended")
                        .knockTextStyle(Theme.Typography.caption11_5w400)
                        .foregroundColor(Theme.Colors.ink2)
                        .padding(.top, 2)
                }
                Text(kind.kindNote)
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .foregroundColor(Theme.Colors.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
                    .padding(.bottom, 6)
                ForEach(kind.examples, id: \.self) { example in
                    Rectangle().fill(Theme.Colors.line).frame(height: 1)
                    Text(example)
                        .knockTextStyle(Theme.Typography.caption11_5w400)
                        .foregroundColor(Theme.Colors.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 4)
                }
            }
            .padding(EdgeInsets(top: 9, leading: 11, bottom: 5, trailing: 11))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(inKnock ? Self.inFill : Theme.Colors.win)
            .cornerRadius(10)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(inKnock ? Self.inBorder : Theme.Colors.line, lineWidth: 1))
            .opacity(inKnock ? 1 : 0.55)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
        .accessibilityLabel("\(kind.title), \(inKnock ? "Waggle" : "Terminal")")
        .accessibilityAddTraits(kind == selected ? [.isSelected] : [])
    }
}

/// A switch that is only as wide as its buttons (prototype `.seg`).
struct AskSegmented<Option: Hashable & Identifiable>: View {
    let options: [Option]
    let selected: Option
    let title: KeyPath<Option, String>
    let onSelect: (Option) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.element.id) { index, option in
                let isOn = option == selected
                Button(action: { onSelect(option) }) {
                    Text(option[keyPath: title])
                        .knockTextStyle(isOn ? Theme.Typography.buttonSm12_5w600 : Theme.Typography.buttonSm12_5w500)
                        .foregroundColor(isOn ? Theme.Colors.ink : Theme.Colors.ink2)
                        .padding(.vertical, 6)
                        .padding(.horizontal, 12)
                        .background(isOn ? Theme.Colors.side : Theme.Colors.win)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerCursor()
                .accessibilityAddTraits(isOn ? [.isSelected] : [])
                if index < options.count - 1 {
                    Rectangle().fill(Theme.Colors.line2).frame(width: 1)
                }
            }
        }
        .fixedSize()
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.Colors.line2, lineWidth: 1))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension AskScope: Identifiable { var id: String { rawValue } }

/// The two-column check list of the ten topics (prototype `.checks`).
struct AskTopicChecklist: View {
    @ObservedObject var model: AskPreferencesModel

    private var rows: [[AskTopic]] {
        stride(from: 0, to: AskTopic.allCases.count, by: 2).map { Array(AskTopic.allCases[$0..<min($0 + 2, AskTopic.allCases.count)]) }
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Rectangle().fill(Theme.Colors.line).frame(height: 1) }
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.element.id) { column, topic in
                        if column > 0 { Rectangle().fill(Theme.Colors.line).frame(width: 1) }
                        cell(topic)
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.Colors.line, lineWidth: 1))
    }

    private func cell(_ topic: AskTopic) -> some View {
        let isOn = model.topics.picked.contains(topic)
        return Button(action: { Task { await model.toggle(topic) } }) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(isOn ? Theme.Colors.ink : Theme.Colors.win)
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(isOn ? Theme.Colors.ink : Theme.Colors.line2, lineWidth: 1.5)
                    if isOn {
                        Image(systemName: "checkmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(Theme.Colors.win)
                    }
                }
                .frame(width: 16, height: 16)
                Text(topic.title)
                    .knockTextStyle(Theme.Typography.body13w400)
                    .foregroundColor(Theme.Colors.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
        .accessibilityLabel(topic.title)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}

/// Settings › Asks (HAIL-101): the same three sections and the generated text.
struct AsksSettingsView: View {
    @ObservedObject var model: AskPreferencesModel
    /// Asks the daemon for the "Small things" card (the old Ask less page).
    let client: KnockClient

    var body: some View {
        SettingsPageChrome(title: SettingsPage.asks.title, subtitle: SettingsPage.asks.subtitle) {
            AskPreferencesView(model: model)
            AskLessSection(client: client)
            Text("New sessions get this at the start. Running sessions hear about a new level on their next Waggle call, and read other changes the next time they open Waggle's guide.")
                .knockTextStyle(Theme.Typography.body12_5w400)
                .foregroundColor(Theme.Colors.ink3)
        }
        .task {
            await model.load()
            await AskEvidence.applyIfRequested(to: model)
        }
    }
}

/// Evidence only: `KNOCK_EVIDENCE_ASKS_PICK=1` switches the preferences to
/// "Let me pick" (sent to the daemon like a click) so a capture can show the
/// topic list. `KNOCK_EVIDENCE_ASKS_REACH=<visual|written|everything>` sets
/// "What comes to Knock" the same way (HAIL-109).
/// `KNOCK_EVIDENCE_ASKS_WORDS=<asd|normal>` sets "How agents write to you"
/// (HAIL-140). `KNOCK_EVIDENCE_ASKS_LEARN=<short|diagram|steps|try>` sets "How you like to learn".
enum AskEvidence {
    @MainActor
    static func applyIfRequested(
        to model: AskPreferencesModel,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) async {
        if let raw = environment["KNOCK_EVIDENCE_ASKS_REACH"], let level = AskReach(rawValue: raw) {
            await model.setReach(level)
        }
        if let raw = environment["KNOCK_EVIDENCE_ASKS_WORDS"], let words = AskWords(rawValue: raw) {
            await model.setWords(words)
        }
        if let raw = environment["KNOCK_EVIDENCE_ASKS_LEARN"], let learn = AskLearn(rawValue: raw) {
            await model.setLearn(learn)
        }
        guard environment["KNOCK_EVIDENCE_ASKS_PICK"] == "1" else { return }
        await model.setScope(.pick)
    }
}
