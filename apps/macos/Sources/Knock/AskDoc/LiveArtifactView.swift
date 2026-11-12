import Combine
import SwiftUI
import WebKit

/// What the live artifact box has loaded for each tab of one case (WAG-276). An `html_bundle` runs live in
/// the same isolated web view as the review stage; a markdown artifact is text; any other kind falls back
/// to the still card.
@MainActor
final class LiveArtifactModel: ObservableObject {
    enum Content {
        case loading
        case web(entry: URL, directory: URL, configuration: WKWebViewConfiguration, viewport: ViewportSize?)
        case markdown(String)
        /// Another kind of artifact, or HTML preview off: the still card shows it.
        case still
    }

    let caseId: String
    private let client: KnockClient
    private let isolationGate: IsolationGate
    @Published private(set) var tabs: [ArtifactTab]
    @Published private(set) var selectedId: String? {
        didSet { if oldValue != selectedId { leaveCommentMode() } }
    }
    @Published private(set) var contents: [String: Content] = [:]
    @Published private(set) var anchorRequest: SandboxedHTMLView.AnchorRequest?
    private var anchorToken = 0
    /// WAG-307: the case's one comment store. The box draws its pins; `nil` draws none.
    let commentsStore: CommentsSessionStore?
    /// One page controller per live tab, so its pins follow its scroll and zoom.
    private var controllers: [String: WebViewCaptureController] = [:]
    private var commentsObserver: AnyCancellable?
    private var layoutWatch: AnyCancellable?
    /// WAG-311: the Interact / Comment tool of the box, as in full size. Comment mode belongs to the tab on
    /// show: another tab, a locked answer or Esc puts the box back to Interact.
    @Published private(set) var mode: ReviewMode = .interact
    /// The answer is still open, so a new comment can be made. The view sets it from the case's lock state.
    private(set) var canComment = false

    init(caseId: String, client: KnockClient, tabs: [ArtifactTab], isolationGate: IsolationGate = .shared, commentsStore: CommentsSessionStore? = nil) {
        self.caseId = caseId
        self.client = client
        self.tabs = tabs
        self.isolationGate = isolationGate
        self.commentsStore = commentsStore
        // The box shows the case's pins: a comment made, edited or deleted anywhere redraws it.
        commentsObserver = commentsStore?.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        self.selectedId = tabs.last?.id
        // Evidence only (WAG-300): `KNOCK_EVIDENCE_TAB=<kind>` opens the first tab of that kind.
        if let raw = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_TAB"],
           let tab = tabs.first(where: { $0.kind?.rawValue == raw }) { self.selectedId = tab.id }
        layoutWatch = EvidenceLayoutLog.watch(self, as: "send.liveArtifact")
    }

    var selectedTab: ArtifactTab? { tabs.first { $0.id == selectedId } ?? tabs.last }

    /// A new set of tabs (a new revision arrived). The tab that got a new version, or is new, comes to the
    /// front (WAG-282: the newest round's artifact shows, not the tab you left open). Else the tab on show stays.
    func update(tabs newTabs: [ArtifactTab]) {
        guard newTabs != tabs else { return }
        let old = Dictionary(uniqueKeysWithValues: tabs.map { ($0.id, $0.revision) })
        let changed = newTabs.last { tab in old[tab.id].map { $0 < tab.revision } ?? true }
        tabs = newTabs
        if let changed { selectedId = changed.id }
        else if !newTabs.contains(where: { $0.id == selectedId }) { selectedId = newTabs.first?.id }
    }

    func select(_ id: String) {
        guard tabs.contains(where: { $0.id == id }) else { return }
        selectedId = id
    }

    /// Selecting an option: show its artifact and scroll to its anchor. On a `screenshots` set the anchor is an
    /// image (WAG-352): the set flips to it.
    func apply(_ link: ArtifactLink?) {
        guard let link else { return }
        if let tabId = link.tabId { select(tabId) }
        guard let anchor = link.anchor else { return }
        if let tab = selectedTab, tab.kind == .screenshots {
            Task { await flipSet(tab, toAnchor: anchor) }
            return
        }
        scroll(toAnchor: anchor)
    }

    private func scroll(toAnchor anchor: String) {
        anchorToken += 1
        anchorRequest = SandboxedHTMLView.AnchorRequest(token: anchorToken, anchor: anchor)
    }

    // MARK: Decision follow (WAG-352)

    /// True once a request with several decisions drove the box: full size then opens on the tab on show.
    private(set) var followsDecisions = false
    private var decisionToken = 0

    /// The revision full size opens on: the tab on show while the box follows the decisions, else `nil` (the newest).
    var fullSizeRevision: Int? { followsDecisions ? selectedTab?.revision : nil }

    /// The decision on screen changed (a step pill, Back, Next, a pick): show its tab, anchor or image
    /// (`DecisionArtifactRule`). The person's own flip or tab change stays until the decision changes again.
    func follow(decision focus: DecisionFocus) async {
        followsDecisions = true
        decisionToken += 1
        let token = decisionToken
        // The captions of a set decide the image, so its images load first.
        guard let target = await DecisionArtifactRule.resolve(
                  for: focus, tabs: tabs, current: { [weak self] in self?.selectedTab?.id },
                  prepare: { [weak self] in await self?.loadStills(for: $0) },
                  captions: { [weak self] in self?.captions(ofTab: $0) },
                  items: { [weak self] in self?.items(ofTab: $0) }),
              token == decisionToken
        else { return }
        if let id = target.tabId { select(id) }
        if let anchor = target.anchor { scroll(toAnchor: anchor) }
        // The strip shows only the decision's images; its first image (or the anchored one) opens.
        commentsStore?.showDecisionGroup(target.group)
        if let image = target.image { showScreen(image) }
    }

    /// The captions of a set tab's images, once they are loaded; `nil` for any other tab.
    private func captions(ofTab id: String) -> [String?]? {
        guard let tab = tabs.first(where: { $0.id == id }), tab.kind == .screenshots else { return nil }
        return commentsStore?.captions(ofSet: tab.revision)
    }

    /// The `item` of a set tab's images, once they are loaded; `nil` for any other tab.
    private func items(ofTab id: String) -> [String?]? {
        guard let tab = tabs.first(where: { $0.id == id }), tab.kind == .screenshots else { return nil }
        return commentsStore?.items(ofSet: tab.revision)
    }

    /// An option's anchor on a set: the image it names.
    private func flipSet(_ tab: ArtifactTab, toAnchor anchor: String) async {
        await loadStills(for: tab)
        guard selectedTab?.id == tab.id, let names = captions(ofTab: tab.id),
              let image = DecisionArtifactRule.imageIndex(anchor: anchor, captions: names) else { return }
        showScreen(image)
    }

    /// The flip of the arrows and dots, to the image at `index` (0-based) of the set on show.
    private func showScreen(_ index: Int) {
        guard let store = commentsStore, store.screens.indices.contains(index) else { return }
        store.selectCapture(id: store.screens[index].id)
    }

    func key(_ tab: ArtifactTab) -> String { "\(tab.id)@\(tab.revision)" }

    func controller(for tab: ArtifactTab) -> WebViewCaptureController {
        let key = key(tab)
        if let existing = controllers[key] { return existing }
        let created = WebViewCaptureController()
        controllers[key] = created
        return created
    }

    // MARK: - Comment mode (WAG-311)

    func setCanComment(_ allowed: Bool) {
        canComment = allowed
        if !allowed { leaveCommentMode() }
        objectWillChange.send()
    }

    /// The tools the box toolbar offers for a tab: the full size rule for a live page (Interact, and Comment
    /// while the answer is open), Comment alone for a screenshot or a set, none for the rest. A write-up has
    /// no tool: its text is selected to comment on it, as in full size.
    func tools(for tab: ArtifactTab?) -> [ReviewMode] {
        guard commentsStore != nil, let tab else { return [] }
        switch content(for: tab) {
        case .web:
            return ArtifactViewerView.canvasTools(isLocked: !canComment, isMarkdown: false, interactAvailable: true)
        case .still:
            return canComment && (tab.kind == .screenshot || tab.kind == .screenshots) ? [.comment] : []
        case .loading, .markdown:
            return []
        }
    }

    /// True while a still shows its capture stage, where a region is dragged.
    func showsCaptureStage(for tab: ArtifactTab) -> Bool {
        mode == .comment && selectedId == tab.id && tab.kind != .htmlBundle && commentsStore?.shownStill(revision: tab.revision) != nil
    }

    /// Comment mode on the tab on show. A screenshot or a set loads its images as captures first.
    func enterCommentMode() async {
        guard mode != .comment, let tab = selectedTab, tools(for: tab).contains(.comment), let store = commentsStore else { return }
        if content(for: tab).isWeb {
            store.clearSelection()
        } else {
            await loadStills(for: tab)
            // The capture on view is the one the stage and the pins use.
            if let shown = store.shownStill(revision: tab.revision), store.selectedCaptureId != shown.id { store.selectCapture(id: shown.id) }
        }
        // The tab or the lock can change while the images load.
        guard selectedTab?.id == tab.id, tools(for: tab).contains(.comment) else { return }
        mode = .comment
        Task { try? await client.usageRecord(event: .commentModeStarted) }
    }

    func enterInteractMode() { leaveCommentMode() }

    /// Back to Interact: an open note belongs to the Comment layer, which goes.
    func leaveCommentMode() {
        guard mode == .comment else { return }
        commentsStore?.cancelDraft()
        commentsStore?.clearCommentSelection()
        mode = .interact
    }

    /// Where Comment goes for a tab (WAG-347): a screenshot, a set, a prototype and a diagram are too small in
    /// the box to place a note, so Comment opens them full size. A write-up keeps commenting in the box.
    enum CommentRoute: Equatable { case inline, fullSize }

    func commentRoute(for tab: ArtifactTab?) -> CommentRoute {
        switch tab?.kind {
        case .screenshot, .screenshots, .htmlBundle, .diagram: .fullSize
        default: .inline
        }
    }

    /// The page the box was on when Comment opened full size; the opener takes it once.
    private var pendingHandoff: CommentHandoff?

    func takeCommentHandoff() -> CommentHandoff? {
        defer { pendingHandoff = nil }
        return pendingHandoff
    }

    /// The Comment tool and the C key. A screenshot, a set, a prototype or a diagram opens full size in Comment
    /// mode (a screenshot or a set on the capture on show, a live page on the hash and scroll of the box); any
    /// other tab toggles Comment mode in the box.
    func startComment(openFullSize: () -> Void) async {
        guard let tab = selectedTab, tools(for: tab).contains(.comment) else { return }
        switch commentRoute(for: tab) {
        case .fullSize:
            pendingHandoff = tab.kind == .htmlBundle || tab.kind == .diagram ? await pageHandoff(for: tab) : nil
            openFullSize()
        case .inline: await toggleCommentMode()
        }
    }

    private func pageHandoff(for tab: ArtifactTab) async -> CommentHandoff {
        let controller = controller(for: tab)
        let view = await controller.readPageView()
        let viewport = await controller.readPageViewport()
        return CommentHandoff(hash: view?.hash, scroll: viewport?.scroll)
    }

    /// The C key.
    func toggleCommentMode() async {
        if mode == .comment { leaveCommentMode() } else { await enterCommentMode() }
    }

    /// Esc leaves Comment mode, unless a note is open: then Esc belongs to the note. True when it left.
    @discardableResult
    func handleEscape() -> Bool {
        guard mode == .comment, commentsStore?.draftPin == nil, commentsStore?.editingCommentId == nil else { return false }
        leaveCommentMode()
        return true
    }

    /// A screenshot or a set shows as a still; its images become the captures a region is dragged over.
    /// Nothing is added when this revision's images are in the store already (full size put them there).
    func loadStills(for tab: ArtifactTab) async {
        // One load per revision at a time: the box and a decision can ask for the same set together (WAG-352).
        if let running = stillLoads[tab.revision] { await running.value; return }
        let load = Task { await fetchStills(for: tab) }
        stillLoads[tab.revision] = load
        await load.value
        stillLoads[tab.revision] = nil
    }

    private var stillLoads: [Int: Task<Void, Never>] = [:]

    private func fetchStills(for tab: ArtifactTab) async {
        guard let store = commentsStore, tab.kind == .screenshot || tab.kind == .screenshots,
              !store.model.captures.contains(where: { $0.revision == tab.revision && store.imagesByCaptureId[$0.id] != nil }),
              let result = try? await client.artifactPath(caseId: caseId, revision: tab.revision) else { return }
        if tab.kind == .screenshot {
            if let image = NSImage(contentsOfFile: result.root) {
                store.selectCapture(id: store.addCapture(image: image, revision: tab.revision, isBase: true).id)
            }
        } else if let items = result.items, !items.isEmpty {
            let images = items.compactMap { item in NSImage(contentsOfFile: item.path).map { (image: $0, caption: item.caption) } }
            if images.count == items.count {
                store.replaceScreenshotsCaptures(images: images, revision: tab.revision)
                store.setScreenItems(items.map(\.item))
            }
        }
    }

    /// The latest capture of this page that a new pin can still land on: the full size rule (`ReviewViewModel.liveCapture`).
    private func liveCapture(for tab: ArtifactTab) -> CaptureRecord? {
        guard let store = commentsStore, let last = store.model.captures.last, !store.baseCaptureIds.contains(last.id) else { return nil }
        let controller = controller(for: tab)
        guard ReviewViewModel.shouldReuseLastCapture(
                  lastCapture: last, currentRevision: tab.revision, hasInteractedSinceLastCapture: controller.hasInteractedSinceLastCapture),
              last.page.map({ page in controller.pageViewport.map(page.matches) ?? true }) ?? true,
              PageView.shows(comment: last.view, current: controller.pageView) else { return nil }
        return last
    }

    /// A region was dragged over the live page (`rect` is 0...1 of the page frame). The same draft as full
    /// size: it reuses the live capture or starts the snapshot of a new one, and lists nothing until the note is saved.
    func beginLiveDraft(tab: ArtifactTab, rect: Rect, viewport: PageViewport?, variant: UsageVariant) {
        guard let store = commentsStore, store.draftPin == nil else { return }
        let controller = controller(for: tab)
        let element = Task { @MainActor in await controller.readElement(atX: rect.x + rect.w / 2, y: rect.y + rect.h / 2) }
        if let live = liveCapture(for: tab) {
            store.beginDraft(rect: rect, on: live.id, variant: variant, element: element)
        } else {
            let snapshot = Task { @MainActor in await controller.takeViewportSnapshot() }
            let view = Task { @MainActor in await controller.readPageView() }
            store.beginPendingDraft(rect: rect, revision: tab.revision, page: viewport, variant: variant, snapshot: snapshot, view: view, element: element)
        }
    }

    /// The arrows, the dots and the filmstrip: the previous or next screen of the set on show. No wrap.
    func stepScreen(by delta: Int) {
        guard let store = commentsStore, let tab = selectedTab, let current = store.shownStill(revision: tab.revision) else { return }
        let screens = store.galleryScreens
        var index = ScreenSetIndex(count: screens.count, current: screens.firstIndex { $0.id == current.id } ?? 0)
        guard index.step(by: delta) else { return }
        store.selectCapture(id: screens[index.current].id)
    }

    /// The set on show has more than one screen to flip through.
    func isFlippable(_ tab: ArtifactTab?) -> Bool {
        guard let tab, tab.kind == .screenshots, let store = commentsStore else { return false }
        return store.galleryScreens.count > 1 && store.shownStill(revision: tab.revision) != nil
    }

    /// Arrow keys flip the set, unless a note is being written.
    var allowsScreenKeys: Bool {
        guard let store = commentsStore else { return false }
        return store.draftPin == nil && store.editingCommentId == nil
    }

    func commitLiveDraft(tab: ArtifactTab) {
        guard let store = commentsStore else { return }
        let hadPending = store.pending != nil
        if store.commitDraftNow() != nil, hadPending { controller(for: tab).markCaptureTaken() }
    }

    /// Evidence only (WAG-307): `KNOCK_EVIDENCE_CASE_COMMENTS=live|gone|screens` puts comments in the
    /// case's store as if they had been made in full size, since no click can place a pin in a capture
    /// run. `live`: two pins on the shown state of a page. `gone`: those two, and a third on a state of
    /// the page that is not there (a hash the page does not have). `screens`: one pin on screen 2 of a
    /// set while screen 1 shows. `KNOCK_EVIDENCE_CASE_SHOW=<n>` then runs Show on comment n.
    private var didSeedEvidence = false

    func seedEvidenceComments(for tab: ArtifactTab) async {
        let environment = ProcessInfo.processInfo.environment
        guard !didSeedEvidence, let mode = environment["KNOCK_EVIDENCE_CASE_COMMENTS"], let store = commentsStore else { return }
        let controller = controller(for: tab)
        if mode == "screens" {
            guard tab.kind == .screenshots else { return }
            // The box loads a set's screens when it shows (WAG-323); this loads them when it has not yet.
            if store.screens.isEmpty { await loadStills(for: tab) }
            let records = store.screens
            // `KNOCK_EVIDENCE_BOX_SCREEN=<n>` (WAG-323): the pin goes on screen n, and the box ends on it.
            let target = (Int(environment["KNOCK_EVIDENCE_BOX_SCREEN"] ?? "") ?? 2) - 1
            guard records.count >= 2, records.indices.contains(target) else { return }
            didSeedEvidence = true
            store.selectCapture(id: records[target].id)
            store.beginDraft(rect: Rect(x: 0.15, y: 0.55, w: 0.5, h: 0.08))
            store.updateDraftText("The label is too tight here.")
            store.commitDraft()
            store.selectCapture(id: records[environment["KNOCK_EVIDENCE_BOX_SCREEN"] == nil ? 0 : target].id)
            await showEvidenceIfAsked(store, tab: tab)
            return
        }
        guard case .web = content(for: tab) else { return }
        // The page reports its scroll and size once the layer is polling it.
        for _ in 0..<40 where controller.pageViewport == nil { try? await Task.sleep(nanoseconds: 200_000_000) }
        try? await Task.sleep(nanoseconds: 800_000_000)
        guard let viewport = controller.pageViewport else { return }
        didSeedEvidence = true
        let placements: [(Rect, String, Bool)] = [
            (Rect(x: 0.12, y: 0.30, w: 0.18, h: 0.07), "Make this button say what it does.", false),
            (Rect(x: 0.55, y: 0.45, w: 0.2, h: 0.08), "This card needs more room.", false),
            (Rect(x: 0.30, y: 0.20, w: 0.2, h: 0.07), "The Share button was easier to find on the old tab.", true),
        ]
        for (rect, text, isGone) in placements where mode == "gone" ? (isGone || text.hasPrefix("Make")) : !isGone {
            let snapshot = Task { @MainActor in await controller.takeViewportSnapshot() }
            // The gone state is a view the page is not on, whose element is not on the page now.
            let view = Task { @MainActor () -> PageView? in
                isGone ? PageView(hash: "", fingerprint: "6f1c0a52d3e9b874") : await controller.readPageView()
            }
            let element = Task { @MainActor () -> PageElementContext? in
                isGone
                    ? PageElementContext(role: "button", text: "Share with a friend", selector: "main > button", heading: "")
                    : await controller.readElement(atX: rect.x + rect.w / 2, y: rect.y + rect.h / 2)
            }
            store.beginPendingDraft(rect: rect, revision: tab.revision, page: viewport, snapshot: snapshot, view: view, element: element)
            store.updateDraftText(text)
            store.commitDraftNow()
        }
        await store.settleCaptures()
        await showEvidenceIfAsked(store, tab: tab)
    }

    /// Evidence only (WAG-311): `KNOCK_EVIDENCE_BOX_COMMENT=draft|saved` enters Comment mode on a screenshot
    /// or a set and drags a region, as a click and a drag would in a capture run that has no pointer.
    /// `draft` leaves the note open with its text; `saved` saves it, so the pin and the list show.
    private var didRunBoxEvidence = false

    func runBoxCommentEvidence(for tab: ArtifactTab) async {
        guard !didRunBoxEvidence, let raw = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_BOX_COMMENT"],
              let store = commentsStore, tab.kind == .screenshot || tab.kind == .screenshots else { return }
        didRunBoxEvidence = true
        // The box sets its comment flag as it appears; a stacked box can be a beat later (WAG-316).
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        await enterCommentMode()
        guard let shown = store.shownStill(revision: tab.revision) else { return }
        store.beginDraft(rect: Rect(x: 0.2, y: 0.35, w: 0.4, h: 0.12), on: shown.id)
        store.updateDraftText("The spacing here feels tight.")
        if raw == "saved" { _ = store.commitDraft() }
    }

    private func showEvidenceIfAsked(_ store: CommentsSessionStore, tab: ArtifactTab) async {
        guard let raw = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_CASE_SHOW"], let n = Int(raw) else { return }
        let delay = Double(ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_CASE_SHOW_AFTER"] ?? "") ?? 0
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        if let comment = store.model.orderedComments.first(where: { $0.n == n }) { showComment(comment, openFullSize: {}) }
    }

    /// WAG-307: what the box shows, for the comment list under it.
    func commentContext(pageView: PageView?) -> CommentViewContext {
        guard let tab = selectedTab, let kind = tab.kind else { return .unknown }
        var context = CommentViewContext(kind: kind, revision: tab.revision)
        switch content(for: tab) {
        case .web:
            context.pageView = pageView
        case .markdown:
            break
        case .loading, .still:
            if kind == .screenshot || kind == .screenshots {
                context.shownCaptureId = commentsStore?.shownStill(revision: tab.revision)?.id
            } else {
                // A page or diagram that shows as a still has no pins, and no state to compare.
                context.kind = nil
            }
        }
        return context
    }

    /// Show on a row of "On other views" under the box. The box can switch to another tab, another
    /// screen, and a live page's address; a state it cannot reach opens full size.
    func showComment(_ comment: Comment, openFullSize: @escaping () -> Void) {
        guard let store = commentsStore, let tab = selectedTab else { return }
        store.setShowNotice(nil, for: comment.id)
        let controller = controller(for: tab)
        let actions = CommentShowActions(
            switchRevision: { [weak self] revision in
                if let target = self?.tabs.first(where: { $0.revision == revision }) { self?.select(target.id) } else { openFullSize() }
            },
            showCapture: { [weak store] id in store?.selectCapture(id: id) },
            setHash: { await controller.setHash($0) },
            findElement: { comment in
                let model = store.model
                guard let capture = model.captures.first(where: { $0.id == comment.captureId }), let page = capture.page else { return true }
                let spot = CommentPageMapping.pageRect(for: comment.rect, capture: page, fallbackSize: page.size)
                let found = await controller.readElement(pageX: spot.midX, pageY: spot.midY)
                return CommentShowPlan.elementFound(stored: model.elementContexts[comment.id], found: found)
            },
            reveal: { [weak store] in store?.selectComment(id: $0.id, origin: .list) },
            // The box shows the page itself, not a still of an older capture.
            canShowStill: false)
        let context = commentContext(pageView: controller.pageView)
        Task { @MainActor in
            let line = await CommentShowPlan.run(comment: comment, model: store.model, context: context, actions: actions)
            if let line { store.setShowNotice(line, for: comment.id) }
        }
    }

    func content(for tab: ArtifactTab) -> Content { contents[key(tab)] ?? .loading }

    /// Selecting an option: show the artifact it names. True when it named a tab, so a page can open a
    /// folded box for it.
    @discardableResult
    func follow(option: Option?) -> Bool {
        let link = ArtifactTabs.link(for: option, in: tabs, current: selectedTab?.id)
        apply(link)
        return link?.tabId != nil
    }

    /// Starts the load of a tab once. The load runs in a task the model owns, so a view task that a quick
    /// click cancels cannot cancel it and leave the tab stuck on a failed or empty state (WAG-289).
    func load(_ tab: ArtifactTab) async {
        let key = key(tab)
        guard contents[key] == nil else { return }
        contents[key] = .loading
        await Task { await fetch(tab, key: key) }.value
    }

    private func fetch(_ tab: ArtifactTab, key: String) async {
        guard let result = try? await client.artifactPath(caseId: caseId, revision: tab.revision) else {
            contents[key] = .still
            return
        }
        switch result.kind {
        case .htmlBundle:
            await isolationGate.runSelfCheckIfNeeded()
            let enabled = HTMLPreviewSettings.isEnabled(isolationPassed: isolationGate.htmlPreviewAvailable)
            guard enabled, let configuration = isolationGate.makeConfiguration() else {
                contents[key] = .still
                return
            }
            contents[key] = .web(
                entry: URL(fileURLWithPath: result.entry).resolvingSymlinksInPath(),
                directory: URL(fileURLWithPath: result.root).resolvingSymlinksInPath(),
                configuration: configuration, viewport: result.viewport)
        case .markdown:
            if let text = try? String(contentsOfFile: result.root, encoding: .utf8) {
                contents[key] = .markdown(text)
            } else {
                contents[key] = .still
            }
        case .screenshot, .screenshots, .diagram:
            contents[key] = .still
        }
    }
}

extension LiveArtifactModel.Content {
    /// True for a page that runs live.
    var isWeb: Bool { if case .web = self { return true } else { return false } }
}

/// WAG-324: where the header of a box sits while the page scrolls under it. Pure.
enum StickyHeader {
    /// The page's scroll view names its coordinate space with this.
    static let space = "askPageScroll"

    /// How far the header moves down from the top of the box: none while the box top is in view, then as far as
    /// the page has scrolled past it, and never past the bottom of the box.
    static func offset(boxTop: CGFloat, boxHeight: CGFloat, headerHeight: CGFloat) -> CGFloat {
        guard boxTop < 0 else { return 0 }
        return min(-boxTop, max(0, boxHeight - headerHeight))
    }
}

/// The artifact box of the decision page (prototype "V1"): the live artifact where the preview card was,
/// with a tab per artifact above it when the case has several, and "Open full size".
struct LiveArtifactBoxView: View {
    @ObservedObject var model: LiveArtifactModel
    let caseKind: Case.Kind
    let client: KnockClient
    let onOpen: () -> Void
    var onInteract: () -> Void = {}
    /// A write-up shows whole, not in a capped scroll box (the plan page's folded write-up).
    var showsWholeMarkdown = false
    /// The box fills the height it gets and scrolls on its own, with the version in the header (WAG-290,
    /// the left column of a plan page).
    var fillsHeight = false
    /// The Open menu's other places (WAG-284, WAG-291): a window of its own, the browser. They act on the
    /// tab on show, so the tabs pick which artifact opens. `nil` leaves the item out.
    var onOpenWindow: ((ArtifactTab) -> Void)?
    var onOpenBrowser: ((ArtifactTab) -> Void)?
    /// WAG-311: the answer is still open, so the box offers Comment as full size does. Off leaves the box as WAG-307 made it.
    var canComment = false
    /// WAG-324: on a stacked page the page scrolls, not the box. The header then stays at the top of the page's
    /// scroll view (`StickyHeader`), so "3 changes since v7" and its buttons stay in reach.
    var sticksHeader = false

    @State private var boxWidth: CGFloat = ArtifactPreviewPlan.defaultCardWidth
    @State private var boxFrame: CGRect = .zero
    @State private var headerHeight: CGFloat = 0
    @FocusState private var hasFocus: Bool
    /// WAG-321: the count and the up and down buttons in the header read the write-up on show.
    @StateObject private var changesHub = WriteUpChangesHub()

    var body: some View {
        let _ = EvidenceLayoutLog.bump("body.artifactBox")
        VStack(spacing: 0) {
            header
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { EvidenceLayoutLog.event("artifact.headerHeight", "old=\(headerHeight) new=\($0)"); headerHeight = $0 }
                .offset(y: sticksHeader
                    ? StickyHeader.offset(boxTop: boxFrame.minY, boxHeight: boxFrame.height, headerHeight: headerHeight) : 0)
                .zIndex(1)
            stageArea
        }
        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(StickyHeader.space)) }) { if sticksHeader { EvidenceLayoutLog.event("artifact.boxFrame", "old=\(boxFrame) new=\($0)"); boxFrame = $0 } }
        .frame(maxHeight: fillsHeight ? .infinity : nil, alignment: .top)
        // Case map `.card`: 1 pt `--line`, radius 10, white.
        .background(Theme.Colors.win)
        .clipShape(RoundedRectangle(cornerRadius: Theme.AskDoc.Chrome.cardRadius))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.AskDoc.Chrome.cardRadius)
                .stroke(Theme.Colors.line, lineWidth: 1))
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { EvidenceLayoutLog.event("artifact.boxWidth", "old=\(boxWidth) new=\($0)"); boxWidth = $0 }
        .onChange(of: canComment, initial: true) { _, allowed in model.setCanComment(allowed) }
        // C and Esc work while the box has focus (WAG-311). A click in the box, or a tool, gives it focus.
        // WAG-323: a set takes focus too, so the arrow keys flip its screens.
        .focusable(canComment || model.isFlippable(model.selectedTab)).focused($hasFocus).focusEffectDisabled()
        .simultaneousGesture(TapGesture().onEnded { if canComment || model.isFlippable(model.selectedTab) { hasFocus = true } })
        .onKeyPress(characters: ["c"], phases: .down) { press in
            guard press.modifiers.isEmpty, model.tools(for: model.selectedTab).contains(.comment) else { return .ignored }
            Task { await model.startComment(openFullSize: onOpen) }
            return .handled
        }
        .onKeyPress(.escape, phases: .down) { _ in model.handleEscape() ? .handled : .ignored }
        .onKeyPress(.leftArrow, phases: .down) { press in flip(by: -1, press) }
        .onKeyPress(.rightArrow, phases: .down) { press in flip(by: 1, press) }
        .task(id: model.selectedTab.map(model.key)) {
            if let tab = model.selectedTab {
                await model.load(tab)
                // WAG-323: a set's images are loaded as screens when it shows, so the box can flip them.
                if tab.kind == .screenshots { await model.loadStills(for: tab) }
                await model.seedEvidenceComments(for: tab)
                await model.runBoxCommentEvidence(for: tab)
            }
        }
    }

    private func flip(by delta: Int, _ press: KeyPress) -> KeyPress.Result {
        guard press.modifiers.isEmpty, model.isFlippable(model.selectedTab), model.allowsScreenKeys else { return .ignored }
        model.stepScreen(by: delta)
        return .handled
    }

    /// Every page that has loaded stays in the box, hidden while another tab shows, so coming back to it
    /// shows the page as you left it, never a blank frame (WAG-289). Other kinds draw on demand.
    @ViewBuilder
    private var stageArea: some View {
        if let selected = model.selectedTab {
            let loaded = model.tabs.filter { model.content(for: $0).isWeb }
            let showsWeb = model.content(for: selected).isWeb
            VStack(spacing: 0) {
                if !loaded.isEmpty {
                    ZStack(alignment: .top) {
                        ForEach(loaded) { tab in
                            let isOn = showsWeb && tab.id == selected.id
                            stage(tab).id(model.key(tab))
                                .opacity(isOn ? 1 : 0).allowsHitTesting(isOn).accessibilityHidden(!isOn)
                        }
                    }
                    .frame(height: fillsHeight ? nil : (showsWeb ? webHeight(selected) : 0))
                    .frame(maxHeight: fillsHeight && !showsWeb ? 0 : nil)
                    .clipped()
                }
                if !showsWeb { stage(selected).id(model.key(selected)) }
            }
            .frame(maxHeight: fillsHeight ? .infinity : nil, alignment: .top)
            .overlay(alignment: .bottom) { toolbar(for: selected) }
        }
    }

    /// The same Interact / Comment switch as full size, floating over the artifact.
    @ViewBuilder
    private func toolbar(for tab: ArtifactTab) -> some View {
        let tools = model.tools(for: tab)
        if !tools.isEmpty {
            CanvasToolbarView(tools: tools, mode: model.mode, showsKeys: false) { target in
                hasFocus = true
                if target == .interact { model.enterInteractMode() } else { Task { await model.startComment(openFullSize: onOpen) } }
            }
            .padding(.bottom, Self.toolbarBottomGap)
        }
    }

    /// The bottom padding of a still in the box: a band for the floating toolbar when it shows, so the toolbar never
    /// covers the bottom of the image (WAG-374).
    private func imageBottomInset(for tab: ArtifactTab, padding: CGFloat) -> CGFloat {
        model.tools(for: tab).isEmpty ? padding : max(padding, CanvasToolbarView.imageBottomInset(bottomGap: Self.toolbarBottomGap))
    }

    /// How far the toolbar floats above the bottom of the stage.
    static let toolbarBottomGap: CGFloat = 14

    private func webHeight(_ tab: ArtifactTab) -> CGFloat? {
        guard case .web(_, _, _, let viewport) = model.content(for: tab) else { return nil }
        return LiveArtifactGeometry.height(boxWidth: boxWidth, viewport: viewport)
    }

    /// Case map `.card-h`: 40 high, padding 0 10, gap 6, a line under it, white. The tabs are `.tab-a`; one artifact
    /// shows as the one selected tab ("Case map"), then the version (`.ver`) and "Open full size ↗" (`.btn-s`).
    private var header: some View {
        HStack(spacing: Theme.AskDoc.Chrome.cardHeaderGap) {
            if model.tabs.count > 1 {
                ArtifactTabStrip(tabs: model.tabs, selectedId: model.selectedTab?.id) { tab in
                    model.select(tab.id); onInteract()
                }
                .layoutPriority(0)
            } else if let tab = model.selectedTab {
                ArtifactTabLabel(symbol: Self.symbol(tab.kind), title: Self.caption(tab), isOn: true)
                    .help(tab.title)
            }
            if fillsHeight, let meta = versionLine {
                Text(meta)
                    .knockTextStyle(Theme.AskDoc.Chrome.version)
                    .foregroundColor(Theme.AskDoc.Colors.quiet)
                    .lineLimit(1)
                    .fixedSize()
            }
            Spacer(minLength: 8)
            WriteUpChangesControls(hub: changesHub)
            openMenu.layoutPriority(1)
        }
        .padding(.horizontal, Theme.AskDoc.Chrome.cardHeaderSide)
        .frame(minHeight: Theme.AskDoc.Chrome.cardHeaderHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.win)
        .overlay(Rectangle().fill(Theme.Colors.line).frame(height: 1), alignment: .bottom)
    }

    /// "v2 · 4 min read" for a write-up, "v2" for any other artifact.
    private var versionLine: String? {
        guard let tab = model.selectedTab else { return nil }
        if case .markdown(let text) = model.content(for: tab) {
            return "v\(tab.revision) · \(MarkdownDocumentCard.readingTime(for: text))"
        }
        return "v\(tab.revision)"
    }

    /// "Open full size" with the WAG-284 menu: Full size, In a new window, In the browser (a page only).
    private var openMenu: some View {
        let tab = model.selectedTab
        let items = Self.openItems(
            kind: tab?.kind, hasWindow: onOpenWindow != nil && tab != nil, hasBrowser: onOpenBrowser != nil && tab != nil)
        return HStack(spacing: 0) {
            Button(action: onOpen) {
                HStack(spacing: 4) {
                    Text("Open full size").knockTextStyle(Theme.AskDoc.Chrome.smallButton).lineLimit(1)
                    Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .medium))
                }
                .foregroundColor(Theme.Colors.ink)
                .padding(Theme.AskDoc.Chrome.smallButtonInset)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerCursor()
            if items.count > 1 {
                Rectangle().fill(Theme.Colors.line2).frame(width: 1, height: 18)
                Menu {
                    ForEach(items, id: \.self) { item in
                        Button(item.label) {
                            guard let tab else { return }
                            switch item {
                            case .fullSize: onOpen()
                            case .window: onOpenWindow?(tab)
                            case .browser: onOpenBrowser?(tab)
                            }
                        }
                    }
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(Theme.Colors.ink3)
                        .padding(EdgeInsets(top: 4, leading: 7, bottom: 4, trailing: 8))
                        .contentShape(Rectangle())
                }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
                .fixedSize().pointerCursor()
                .accessibilityLabel("Choose where to open")
            }
        }
        .background(Theme.Colors.win)
        .cornerRadius(Theme.AskDoc.Chrome.smallButtonRadius)
        .overlay(RoundedRectangle(cornerRadius: Theme.AskDoc.Chrome.smallButtonRadius).stroke(Theme.Colors.line2, lineWidth: 1))
        .fixedSize()
    }

    enum OpenItem: Hashable {
        case fullSize, window, browser

        var label: String {
            switch self {
            case .fullSize: "Full size"
            case .window: "In a new window"
            case .browser: "In the browser"
            }
        }
    }

    /// The menu of the box, top to bottom. Full size is always there; the browser only for a page.
    static func openItems(kind: ArtifactKind?, hasWindow: Bool, hasBrowser: Bool) -> [OpenItem] {
        var items: [OpenItem] = [.fullSize]
        if hasWindow { items.append(.window) }
        if hasBrowser, kind == .htmlBundle { items.append(.browser) }
        return items
    }

    @ViewBuilder
    private func stage(_ tab: ArtifactTab) -> some View {
        switch model.content(for: tab) {
        case .loading:
            LoadingStatus(label: "Loading the artifact", since: Date())
                .frame(maxWidth: .infinity, minHeight: 160)
                .background(Theme.Colors.list)
        case .web(let entry, let directory, let configuration, let viewport):
            let controller = model.controller(for: tab)
            SandboxedHTMLView(
                entryURL: entry, directoryURL: directory, configuration: configuration,
                captureController: model.commentsStore == nil ? nil : controller,
                magnification: LiveArtifactGeometry.scale(boxWidth: boxWidth, viewport: viewport),
                anchorRequest: model.anchorRequest)
                .frame(height: fillsHeight ? nil : LiveArtifactGeometry.height(boxWidth: boxWidth, viewport: viewport))
                .frame(maxWidth: .infinity, maxHeight: fillsHeight ? .infinity : nil)
                .background(Theme.Colors.list)
                .overlay {
                    // WAG-307: the same numbered pins as full size, for the comments already made.
                    // WAG-311: in Comment mode the same region layer, draft and note as full size.
                    if let store = model.commentsStore {
                        let isCommenting = model.mode == .comment && model.selectedTab?.id == tab.id
                        LiveCommentLayerView(
                            store: store, controller: controller, revision: tab.revision, isInteractive: !isCommenting,
                            onBeginDraft: { rect, viewport, variant in model.beginLiveDraft(tab: tab, rect: rect, viewport: viewport, variant: variant) },
                            onSave: { model.commitLiveDraft(tab: tab) })
                    }
                }
        case .markdown(let text):
            // WAG-320: "Changes since vN" for a write-up with more than one version.
            WriteUpChangesHost(
                caseId: model.caseId, artifact: tab.id, revisions: tab.revisions, shown: tab.revision, text: text,
                surface: "box", client: client, hub: changesHub
            ) { changes in
                markdownStage(tab: tab, text: text, changes: changes)
            }
            .id(model.key(tab))
        case .still:
            if let store = model.commentsStore, model.showsCaptureStage(for: tab),
               let capture = store.shownStill(revision: tab.revision), let image = store.imagesByCaptureId[capture.id] {
                // WAG-311: Comment mode on a screenshot or a set: drag a region on the capture, as in full size.
                VStack(spacing: 0) {
                    if store.galleryScreens.count > 1 {
                        ScreenRow(store: store, current: capture.id, onSelect: { store.selectCapture(id: $0) }, onStep: { model.stepScreen(by: $0) })
                    }
                    CommentCaptureStageView(image: image, store: store, captureId: capture.id, initialScrollFraction: capture.scrollFraction)
                        .padding(EdgeInsets(top: 12, leading: 12, bottom: imageBottomInset(for: tab, padding: 12), trailing: 12))
                        .frame(height: fillsHeight ? nil : Self.commentStageHeight)
                        .frame(maxHeight: fillsHeight ? .infinity : nil)
                        .background(Theme.Colors.list)
                }
            } else if let store = model.commentsStore, let still = store.shownStill(revision: tab.revision) {
                if model.isFlippable(tab) {
                    // WAG-323: flip through the set here; full size is for zoom and Set mode.
                    ScreenSetBoxView(
                        store: store, capture: still, fillsHeight: fillsHeight, hasFocus: hasFocus,
                        imageBottomInset: imageBottomInset(for: tab, padding: 0),
                        onStep: { model.stepScreen(by: $0) }, onSelect: { id in hasFocus = true; store.selectCapture(id: id) })
                        .frame(maxHeight: fillsHeight ? .infinity : nil)
                } else {
                    PinnedStillView(store: store, capture: still, fillsHeight: fillsHeight)
                        .padding(.bottom, imageBottomInset(for: tab, padding: 0))
                        .frame(maxHeight: fillsHeight ? .infinity : nil)
                }
            } else {
                stillCard(tab)
            }
        }
    }

    /// A write-up: the full text, with each change marked in place when a version before it exists (WAG-321).
    @ViewBuilder
    private func markdownStage(tab: ArtifactTab, text: String, changes: WriteUpChangesModel) -> some View {
        if changes.showsInline {
            let insets = EdgeInsets(top: 16, leading: 24, bottom: 18, trailing: 24)
            // WAG-322: the same commentable text as the plain write-up, with the changes marked in place.
            let canSelect = model.canComment && !showsWholeMarkdown
            if let store = model.commentsStore, canSelect || !store.model.textComments(onRevision: tab.revision).isEmpty {
                WriteUpCommentableInlineView(model: changes, markdown: text, revision: tab.revision, store: store, canComment: canSelect)
                    .frame(maxWidth: .infinity)
                    .frame(height: fillsHeight ? nil : LiveArtifactGeometry.defaultHeight)
                    .frame(maxHeight: fillsHeight ? .infinity : nil)
            } else if fillsHeight {
                WriteUpInlineView(model: changes, insets: insets).frame(maxHeight: .infinity)
            } else if showsWholeMarkdown {
                WriteUpInlineView(model: changes, insets: insets, scrolls: false)
            } else {
                WriteUpInlineView(model: changes, insets: insets)
                    .frame(maxHeight: LiveArtifactGeometry.defaultHeight)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            let page = MarkdownView(text: text)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(EdgeInsets(top: 16, leading: 24, bottom: 18, trailing: 24))
            // WAG-311: select text to comment on it, as in full size. A write-up shown whole stays plain.
            let canSelect = model.canComment && !showsWholeMarkdown
            if let store = model.commentsStore, canSelect || !store.model.textComments(onRevision: tab.revision).isEmpty {
                // WAG-307: the write-up with its highlights and numbers, as in full size.
                CommentableMarkdownView(markdown: text, revision: tab.revision, store: store, canComment: canSelect)
                    .frame(maxWidth: .infinity)
                    .frame(height: fillsHeight ? nil : LiveArtifactGeometry.defaultHeight)
                    .frame(maxHeight: fillsHeight ? .infinity : nil)
            } else if fillsHeight {
                ScrollView { page }.frame(maxHeight: .infinity)
            } else if showsWholeMarkdown {
                page
            } else {
                ScrollView { page }
                    .frame(maxHeight: LiveArtifactGeometry.defaultHeight)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func stillCard(_ tab: ArtifactTab) -> some View {
        ArtifactPreviewCard(
            caseId: model.caseId, revision: tab.revision, caseKind: caseKind, client: client,
            chromeless: true, fillsHeight: fillsHeight, onOpen: onOpen, onInteract: onInteract)
            .frame(maxHeight: fillsHeight ? .infinity : nil)
    }

    /// The height of a capture in Comment mode, room for a drag and for the note.
    static let commentStageHeight: CGFloat = 360

    static func symbol(_ kind: ArtifactKind?) -> String {
        switch kind {
        case .htmlBundle: return "macwindow"
        case .markdown: return "doc.text"
        case .screenshot: return "photo"
        case .screenshots: return "photo.on.rectangle"
        case .diagram: return "flowchart"
        case nil: return "doc"
        }
    }

    /// The tab title, in the same words and case as the full size toolbar (WAG-335).
    static func caption(_ tab: ArtifactTab) -> String { tab.title }
}

/// The artifact box wired to the ask's options: selecting an option that names an artifact or an anchor
/// switches to that tab and scrolls to the anchor.
struct DecisionArtifactView: View {
    @ObservedObject var model: LiveArtifactModel
    @ObservedObject var composer: ComposerViewModel
    let caseKind: Case.Kind
    let client: KnockClient
    let onOpen: () -> Void
    var onInteract: () -> Void = {}
    var fillsHeight = false
    var onOpenWindow: ((ArtifactTab) -> Void)?
    var onOpenBrowser: ((ArtifactTab) -> Void)?
    /// WAG-311: the answer is open, so the box can take comments.
    var canComment = false
    /// WAG-352: off for a request with several decisions, where the decision on screen drives the box.
    var followsComposer = true

    var body: some View {
        // The comment list is in the decision column's Comments tab (C8); the box keeps the pins.
        LiveArtifactBoxView(
            model: model, caseKind: caseKind, client: client, onOpen: onOpen, onInteract: onInteract,
            fillsHeight: fillsHeight, onOpenWindow: onOpenWindow, onOpenBrowser: onOpenBrowser, canComment: canComment)
            .onChange(of: composer.selectedOptionId) { _, _ in follow() }
            .task { follow() }
    }

    private func follow() {
        guard followsComposer else { return }
        let option = composer.selectedOptionId.flatMap { id in composer.options.first { $0.id == id } }
        model.follow(option: option)
    }
}
