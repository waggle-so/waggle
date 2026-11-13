import SwiftUI

/// WAG-418: "Based on N past decisions" on the case view. The ids come from `Case.matchedCaseIds`; the line counts only
/// the cases that still exist, so a deleted case never shows.
enum PastDecisions {
    /// "Based on 1 past decision" or "Based on N past decisions".
    static func label(count: Int) -> String {
        count == 1 ? "Based on 1 past decision" : "Based on \(count) past decisions"
    }

    /// The matched cases that were found, in the order the daemon sent them.
    static func found(ids: [String], loaded: [String: Case]) -> [Case] {
        ids.compactMap { loaded[$0] }
    }
}

/// Fetches each matched case once (shared `FollowedCaseCache`). A case that cannot be fetched is left out.
@MainActor
final class MatchedCasesLoader: ObservableObject {
    @Published private(set) var cases: [Case] = []

    private let client: KnockClient?
    private let cache: FollowedCaseCache

    init(client: KnockClient?, cache: FollowedCaseCache = .shared) {
        self.client = client
        self.cache = cache
    }

    func load(ids: [String]) async {
        var loaded: [String: Case] = [:]
        for id in ids {
            if let cached = cache.get(id) {
                loaded[id] = cached
            } else if let client, let detail = try? await client.casesGet(id: id) {
                cache.store(detail.case)
                loaded[id] = detail.case
            }
        }
        cases = PastDecisions.found(ids: ids, loaded: loaded)
    }
}

/// The quiet line and its list, which opens in place under the line. Nothing shows until at least one matched case is found.
struct PastDecisionsLine: View {
    let ids: [String]
    let client: KnockClient?
    let onOpenCase: (String) -> Void

    @StateObject private var loader: MatchedCasesLoader
    @State private var isOpen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(ids: [String], client: KnockClient?, onOpenCase: @escaping (String) -> Void) {
        self.ids = ids
        self.client = client
        self.onOpenCase = onOpenCase
        _loader = StateObject(wrappedValue: MatchedCasesLoader(client: client))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !loader.cases.isEmpty {
                Button {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { isOpen.toggle() }
                } label: {
                    Text(PastDecisions.label(count: loader.cases.count))
                        .knockTextStyle(Theme.Typography.rowLabel12_5w500)
                        .foregroundColor(Theme.Colors.ink3)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerCursor()
                .accessibilityIdentifier("past-decisions-line")
                .padding(.bottom, isOpen ? 6 : 10)
                if isOpen { list.transition(.opacity).padding(.bottom, 10) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: ids) { await loader.load(ids: ids) }
        .onAppear { Self.openForEvidenceIfRequested(&isOpen) }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(loader.cases) { item in
                Button {
                    isOpen = false
                    onOpenCase(item.id)
                } label: {
                    Text(AgentMarkdown.singleLine(item.title))
                        .knockTextStyle(Theme.Typography.rowLabel12_5w500)
                        .foregroundColor(Theme.Colors.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerCursor()
                .help("Open this decision")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Evidence hook (dev only): `KNOCK_EVIDENCE_PAST_DECISIONS_OPEN=1` opens the list on appear.
    private static func openForEvidenceIfRequested(_ isOpen: inout Bool) {
        if ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_PAST_DECISIONS_OPEN"] == "1" { isOpen = true }
    }
}
