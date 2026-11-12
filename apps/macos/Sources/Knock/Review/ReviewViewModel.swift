import AppKit
import Foundation
import WebKit

/// Interact vs Comment. Comment mode's actual behaviour (freeze into a
/// capture, drop a pin, write a note) is KNOCK-11; this story only builds
/// the toggle shell that switches between the two.
enum ReviewMode: Equatable {
    case interact
    case comment
}

/// Which content the right column shows (HAIL-56 contract): independent of
/// `ReviewMode` (the canvas toolbar's Interact/Comment tool) - "the tab no
/// longer changes when the tool changes", so switching tools alone never
/// touches this.
enum ReviewColumnTab: Equatable {
    case question
    /// The thread as messages (C8): the pane and full size alike.
    case conversation
    case comments
}

/// What the artifact viewer has to show for one case's latest revision.
enum ReviewArtifactState {
    case loading
    /// A screenshot artifact, loaded as an image.
    case screenshot(NSImage, revision: Int)
    /// A staged `html_bundle`, isolated and ready to render.
    case htmlBundle(entryURL: URL, directoryURL: URL, revision: Int, configuration: WKWebViewConfiguration)
    /// An `html_bundle` case, but the isolation self-check failed at
    /// startup: fall back to a screenshot-only notice per the story
    /// ("HTML preview is disabled and bundles show a notice with
    /// screenshot-only review").
    case htmlBundleUnavailable(revision: Int)
    /// A staged `markdown` artifact (HAIL-33), loaded as plain text and
    /// rendered by `MarkdownView`.
    case markdown(String, revision: Int)
    /// A staged `screenshots` artifact (HAIL-40): 2 to 12 images, already
    /// loaded as captures in `commentsStore` (with their captions in
    /// `commentsStore.captionsByCaptureId`) - this case carries only the
    /// revision, not the images themselves, so there is one source of truth
    /// for "which screen is shown" (`commentsStore.currentCapture`), per the
    /// HAIL-35 reuse instruction.
    case screenshots(revision: Int)
    /// A staged `diagram` artifact (HAIL-141), rendered as a generated page in
    /// the same isolated web viewer as an `html_bundle` - so zoom, pan and
    /// Comment mode work unchanged.
    case diagram(entryURL: URL, directoryURL: URL, revision: Int, configuration: WKWebViewConfiguration)
    case failed(String)

    var revision: Int? {
        switch self {
        case .loading, .failed: return nil
        case .screenshot(_, let revision): return revision
        case .htmlBundle(_, _, let revision, _): return revision
        case .htmlBundleUnavailable(let revision): return revision
        case .markdown(_, let revision): return revision
        case .screenshots(let revision): return revision
        case .diagram(_, _, let revision, _): return revision
        }
    }

    /// The artifact kind on the stage, `nil` while loading or failed (HAIL-156).
    var artifactKind: ArtifactKind? {
        switch self {
        case .loading, .failed: return nil
        case .screenshot: return .screenshot
        case .htmlBundle, .htmlBundleUnavailable: return .htmlBundle
        case .markdown: return .markdown
        case .screenshots: return .screenshots
        case .diagram: return .diagram
        }
    }

    /// Interact mode only makes sense for a rendered web stage: an
    /// `html_bundle` or a `diagram`.
    var interactAvailable: Bool {
        switch self {
        case .htmlBundle, .diagram: return true
        default: return false
        }
    }

    /// The revision of a live web stage (an `html_bundle` or a `diagram`),
    /// which Comment mode pins onto directly instead of freezing a capture.
    var webRevision: Int? {
        switch self {
        case .htmlBundle(_, _, let revision, _), .diagram(_, _, let revision, _): return revision
        default: return nil
        }
    }
}

/// Loads the artifact for one case's latest revision and holds the
/// Interact/Comment mode for the review workspace (docs/stories/KNOCK-10.md),
/// plus Comment mode's captures and pins (docs/stories/KNOCK-11.md).
/// WAG-347: what the case box hands to the full size view when Comment opens it: the page hash and the scroll
/// of a live page. A screenshot or a set needs none: the case's one comment store keeps its screen.
struct CommentHandoff: Equatable {
    var hash: String?
    var scroll: CGPoint?
}

@MainActor
final class ReviewViewModel: ObservableObject {
    @Published private(set) var artifactState: ReviewArtifactState = .loading {
        // WAG-280: only a live web stage has page elements for a pin to point at.
        didSet { commentsStore.showsPageElements = artifactState.webRevision != nil }
    }

    /// The stage shows a screenshots set (not an HTML or markdown tab): the option rows may mark «On screen».
    var isShowingScreenshots: Bool {
        if case .screenshots = artifactState { return true }
        return false
    }
    /// WAG-347: where the page was in the case box when the operator pressed Comment there. Set before `load`;
    /// the live stage uses it once, to start in Comment mode on that page.
    var commentHandoff: CommentHandoff?
    /// The URL hash a decision doc sets on the bundle's page (`plans?variant=table`), or `nil` for none (WAG-257).
    @Published var pageFragment: String?
    @Published private(set) var mode: ReviewMode = .interact {
        // HAIL-65: in Comment mode the region layer takes the clicks.
        didSet {
            webViewCapture.ignoresClicksAndKeys = mode == .comment
        }
    }
    /// The right column's Question | Comments switch (HAIL-56 contract).
    /// Starts on `.question` regardless of artifact type or starting `mode` -
    /// even a screenshot-only case (which forces `mode = .comment` on load,
    /// having no Interact to offer) opens on the ask, not the comments list.
    @Published private(set) var tab: ReviewColumnTab = .question
    /// Non-nil while this case's latest revision just returned it to Needs
    /// you (docs/design/mvp-values.md §M9). Read once at `load`, from the
    /// same `CaseDetail` the case pane already fetched - never recomputed
    /// against a later, different case's data.
    @Published private(set) var revisionArrival: RevisionArrival?
    /// Non-nil while the newest agent update has no artifact of its own (HAIL-146).
    @Published private(set) var staleArtifactNote: StaleArtifactNote?
    /// Non-nil while the friend is looking at an earlier revision read-only,
    /// via the §M9 "view v<n-1>" link. Replaces `artifactState` in the
    /// viewer entirely until `returnToLatestRevision()`.
    @Published private(set) var olderRevisionDisplay: OlderRevisionDisplay?

    /// Edit docs in place (HAIL-168). Non-nil while the person edits the markdown explanation.
    @Published private(set) var editSession: MarkdownEditSession?
    /// Non-nil while "Compare with v1" shows the person's edit over the version it started from.
    @Published private(set) var comparison: MarkdownEditSession?
    /// The newest revision the person saved from an edit; the header shows its chip.
    @Published private(set) var humanRevision: Revision?
    @Published private(set) var isSavingEdit = false
    @Published private(set) var editError: String?
    /// Called with the revision the person just saved, so the reply can carry it.
    var onDocumentEdited: ((Revision) -> Void)?

    /// This case's captures and pins. Scoped to this view model's lifetime,
    /// i.e. one case's review workspace — see `CommentsSessionStore`.
    let commentsStore: CommentsSessionStore
    private(set) var detail: CaseDetail?
    private var olderRevisionTask: Task<Void, Never>?
    private var olderRevisionImagesTask: Task<Void, Never>?
    /// The bridge `SandboxedHTMLView` registers its live webview into, so a
    /// capture of an `html_bundle` can call `WKWebView.takeSnapshot`.
    let webViewCapture = WebViewCaptureController()
    /// HAIL-127: the prototype's zoom. Reset by every `present` (a new ask or revision);
    /// Comment mode pauses it (see `PrototypeZoomModel`).
    let prototypeZoom = PrototypeZoomModel()

    private let client: KnockClient
    /// WAG-320: the write-up Changes view loads the older version through the same client.
    var writeUpClient: KnockClient { client }
    private let isolationGate: IsolationGate
    /// `KNOCK_REVIEW_MODE=comment` (Amendments): the orchestrator's evidence
    /// hook to open a case straight into Comment mode, since it cannot send
    /// the "C" keystroke to the app.
    private let startInCommentMode: Bool
    /// `KNOCK_EVIDENCE_SCROLL_FRACTION=<0...1>` (HAIL-35 evidence hook, same
    /// style as `startInCommentMode`): scrolls the live page before the
    /// first capture, since the evidence harness has no accessibility
    /// permission for a real scroll gesture.
    private let evidenceScrollFraction: Double?
    /// `KNOCK_EVIDENCE_PIN_TEXT=<text>` (HAIL-35 evidence hook): drops one
    /// committed pin near the bottom of the first capture right after it is
    /// taken, in place of a drag gesture the harness cannot send.
    private let evidencePinText: String?
    /// `KNOCK_EVIDENCE_MULTI_CAPTURE=comment|interact` (HAIL-35 evidence
    /// hook): runs Interact → Comment → Interact → Comment with a pin on
    /// each capture, ending in the named mode - the "two captures, comments
    /// on both stay visible" and "N comments on M captures · Show" evidence,
    /// neither reachable without a real "C" keypress or mode-switch click.
    private let evidenceMultiCaptureFinalMode: String?
    /// `KNOCK_EVIDENCE_FLAT_COMMENTS=<n>` (HAIL-75 evidence hook): on a tall
    /// prototype, places two comments at the top and two after scrolling down,
    /// scrolls back to the top, then lists comment `n` as clicked
    /// (`KNOCK_EVIDENCE_SELECT_COMMENT` picks a different one). No click can
    /// reach the region layer in evidence.
    private let evidenceFlatComments: Int?
    /// `KNOCK_EVIDENCE_VIEWS=a,b` (HAIL-103 evidence hook): for each hash, sets
    /// it on the live page and places one comment there, then shows each view
    /// again and writes a window shot per view (`<prefix>-<hash>.png`).
    private let evidenceViews: [String]?
    /// `KNOCK_EVIDENCE_SCREENSHOTS_COMMENTS=1|send` (HAIL-40 evidence hook,
    /// same style as `evidenceMultiCaptureFinalMode`): for a `screenshots`
    /// case, drops one pin on the first screen and one on the last, then
    /// lands on the middle screen - the "thumbnail strip on screen 2 of 3"
    /// and "comments on 2 different screens" evidence, neither reachable
    /// without a real click on a thumbnail or a drag gesture. `"send"` also
    /// presses Send right after (`ReviewWorkspaceView`'s own `.task`), for
    /// the "You're sending" evidence with both screens' comments listed.
    private let evidenceScreenshotsComments: String?
    /// `KNOCK_EVIDENCE_TOGGLE_TOOL_AFTER=<seconds>` (HAIL-65 evidence hook):
    /// on a live prototype, switches Interact → Comment after that delay and
    /// back to Interact after the same delay again, in one running process, so
    /// window captures can prove the page is untouched by the switch.
    private let evidenceToggleToolAfter: Double?

    /// Where the workspace's clicks are reported (HAIL-83).
    let usage: UsageReporter?

    init(
        client: KnockClient, usage: UsageReporter? = nil, isolationGate: IsolationGate = .shared,
        commentsStore: CommentsSessionStore = CommentsSessionStore(),
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.client = client
        self.commentsStore = commentsStore
        self.usage = usage
        self.isolationGate = isolationGate
        self.startInCommentMode = environment["KNOCK_REVIEW_MODE"] == "comment"
        self.evidenceScrollFraction = environment["KNOCK_EVIDENCE_SCROLL_FRACTION"].flatMap(Double.init)
        self.evidencePinText = environment["KNOCK_EVIDENCE_PIN_TEXT"]
        self.evidenceMultiCaptureFinalMode = environment["KNOCK_EVIDENCE_MULTI_CAPTURE"]
        self.evidenceScreenshotsComments = environment["KNOCK_EVIDENCE_SCREENSHOTS_COMMENTS"]
        self.evidenceFlatComments = environment["KNOCK_EVIDENCE_FLAT_COMMENTS"].flatMap(Int.init)
        self.evidenceViews = environment["KNOCK_EVIDENCE_VIEWS"].map { $0.split(separator: ",").map(String.init) }
        self.evidenceToggleToolAfter = environment["KNOCK_EVIDENCE_TOGGLE_TOOL_AFTER"].flatMap(Double.init)
        self.commentsStore.usage = usage
    }

    /// The artifact (by revision) the person opened from a card while another artifact is the newest one
    /// (WAG-289). A refresh keeps it until a newer revision arrives, which then comes to the front.
    private var pinnedRevision: Int?

    /// Opens another artifact of the case, by its revision. Nothing else changes.
    func show(revision: Int) async {
        guard let detail, artifactState.revision != revision else { return }
        let latest = detail.revisions.map(\.n).max() ?? 1
        pinnedRevision = revision == latest ? nil : revision
        await present(caseId: detail.case.id, revision: revision, replacing: false)
    }

    func load(detail: CaseDetail, revision: Int? = nil) async {
        artifactState = .loading
        editSession = nil
        comparison = nil
        humanRevision = detail.revisions.filter { $0.author == .you }.max { $0.n < $1.n }
        self.detail = detail
        revisionArrival = detail.case.plan == nil ? detail.revisionArrival : nil
        staleArtifactNote = detail.staleArtifactNote
        olderRevisionDisplay = nil
        let latestRevision = detail.revisions.map(\.n).max() ?? 1
        let revision = revision.flatMap { $0 < latestRevision ? $0 : nil } ?? latestRevision
        pinnedRevision = revision < latestRevision ? revision : nil
        await present(caseId: detail.case.id, revision: revision, replacing: false)
        // An update that arrived while this load ran: show it now.
        if let latest = self.detail, latest.revisions.map(\.n).max() ?? 1 > revision {
            await refresh(detail: latest)
        }
    }

    /// The open ask got a newer detail (HAIL-114: `load` runs once per case, so a `knock_update`
    /// with a new revision left the old artifact on screen). Shows the newest revision in place:
    /// no Loading flash, the mode and the comments on earlier revisions stay, and a gallery keeps
    /// its screen index. A detail with no newer revision only refreshes the banner and the arrival.
    func refresh(detail: CaseDetail) async {
        let previousRounds = self.detail?.planRounds?.count
        let previousLatest = self.detail?.revisions.map(\.n).max() ?? 0
        self.detail = detail
        let newLatest = detail.revisions.map(\.n).max() ?? 1
        if pinnedRevision != nil, newLatest > previousLatest { pinnedRevision = nil }
        if let newest = detail.revisions.filter({ $0.author == .you }).max(by: { $0.n < $1.n }),
           newest.n > (humanRevision?.n ?? 0) {
            humanRevision = newest
        }
        revisionArrival = detail.case.plan == nil ? detail.revisionArrival : nil
        staleArtifactNote = detail.staleArtifactNote
        // A new plan round shows its own question on the live stage, not an earlier round read-only.
        if let rounds = detail.planRounds?.count, let previousRounds, rounds != previousRounds { returnToLatestRevision() }
        let latest = newLatest
        guard pinnedRevision == nil, let shown = artifactState.revision, latest > shown else { return }
        olderRevisionDisplay = nil
        // HAIL-156: a plan round can send another kind of artifact. The comment store holds the old
        // kind's stills, so a kind change starts the stage over instead of swapping in place.
        let newKind = detail.planRounds?.last(where: { $0.revision == latest })?.artifactKind
        if let newKind, let shownKind = artifactState.artifactKind, newKind != shownKind {
            commentsStore.resetArtifactCaptures()
            await present(caseId: detail.case.id, revision: latest, replacing: false)
            return
        }
        await present(caseId: detail.case.id, revision: latest, replacing: true)
    }

    /// Stages and shows one revision. `replacing` is the in-place swap of `refresh`: it skips the
    /// evidence hooks and keeps the operator's mode.
    private func present(caseId: String, revision: Int, replacing: Bool) async {
        prototypeZoom.reset()
        do {
            let result = try await client.artifactPath(caseId: caseId, revision: revision)
            switch result.kind {
            case .screenshot:
                guard let image = NSImage(contentsOfFile: result.root) else {
                    artifactState = .failed("Could not load the staged screenshot.")
                    return
                }
                artifactState = .screenshot(image, revision: revision)
                if replacing {
                    await takeCapture()
                    mode = .comment
                } else {
                    // A screenshot has no Interact mode to switch from, so its
                    // first capture is automatic rather than waiting for a "C"
                    // that has nothing to toggle away from.
                    await enterCommentMode(force: true)
                }
            case .markdown:
                guard let text = try? String(contentsOfFile: result.root, encoding: .utf8) else {
                    artifactState = .failed("Could not load the staged explanation.")
                    return
                }
                artifactState = .markdown(text, revision: revision)
                mode = .interact
                if !replacing { runEditEvidenceHookIfRequested() }
            case .screenshots:
                guard let items = result.items, !items.isEmpty else {
                    artifactState = .failed("Could not load the staged screenshots.")
                    return
                }
                var loaded: [(image: NSImage, caption: String?)] = []
                for item in items {
                    guard let image = NSImage(contentsOfFile: item.path) else {
                        artifactState = .failed("Could not load the staged screenshots.")
                        return
                    }
                    loaded.append((image: image, caption: item.caption))
                }
                if replacing {
                    commentsStore.replaceScreenshotsCaptures(images: loaded, revision: revision)
                } else {
                    commentsStore.addScreenshotsCaptures(images: loaded, revision: revision)
                }
                commentsStore.setScreenItems(items.map(\.item))
                artifactState = .screenshots(revision: revision)
                // Every image is already frozen as its own capture up front
                // (HAIL-40: "no interactive 'take a capture' step makes sense
                // for a pre-existing set of images") - Comment mode starts
                // immediately, without `enterCommentMode`'s own capture step,
                // which would freeze a redundant extra one.
                mode = .comment
                if !replacing, evidenceScreenshotsComments != nil {
                    placeEvidenceScreenshotsCommentsIfNeeded()
                }
            case .htmlBundle:
                await isolationGate.runSelfCheckIfNeeded()
                // KNOCK-17: the Settings "HTML preview" toggle gates rendering.
                // It is on by default when the self-check passed, so a
                // screenshot-only ship is just one toggle away.
                let htmlEnabled = HTMLPreviewSettings.isEnabled(
                    isolationPassed: isolationGate.htmlPreviewAvailable
                )
                if htmlEnabled, let configuration = isolationGate.makeConfiguration() {
                    // A prototype's Fit only shrinks; it never scales a page up.
                    prototypeZoom.fitUpscales = false
                    // A note being written, or a still picked, belongs to the old revision's page.
                    if replacing {
                        commentsStore.cancelDraft()
                        commentsStore.clearSelection()
                    }
                    artifactState = .htmlBundle(
                        // Resolve symlinks (e.g. /tmp -> /private/tmp) so the read-access
                        // grant and the subresource URLs name the same path; otherwise
                        // WebKit can load index.html but refuse its CSS/JS.
                        entryURL: URL(fileURLWithPath: result.entry).resolvingSymlinksInPath(),
                        directoryURL: URL(fileURLWithPath: result.root).resolvingSymlinksInPath(),
                        revision: revision,
                        configuration: configuration
                    )
                    if replacing {
                        return
                    }
                    await finishLiveStage(replacing: false)
                } else {
                    artifactState = .htmlBundleUnavailable(revision: revision)
                    await enterCommentMode(force: true)
                }
            case .diagram:
                guard let text = try? String(contentsOfFile: result.root, encoding: .utf8) else {
                    artifactState = .failed("Could not load the staged diagram.")
                    return
                }
                await isolationGate.runSelfCheckIfNeeded()
                guard isolationGate.htmlPreviewAvailable, let configuration = isolationGate.makeConfiguration() else {
                    artifactState = .failed("Waggle could not draw this diagram.")
                    return
                }
                do {
                    // A diagram's Fit fills the viewer width, scaling a small
                    // diagram up (HAIL-141); 100% shows its natural size.
                    prototypeZoom.fitUpscales = true
                    let format = DiagramFormat(pathExtension: (result.root as NSString).pathExtension)
                    let directory = try DiagramPage.makeTempDirectory()
                    let entry = try DiagramPage.materialize(
                        source: text, format: format,
                        mermaidJSURL: MermaidResource.mermaidJSURL(),
                        into: directory
                    )
                    if replacing {
                        commentsStore.cancelDraft()
                        commentsStore.clearSelection()
                    }
                    artifactState = .diagram(
                        entryURL: entry.resolvingSymlinksInPath(),
                        directoryURL: directory.resolvingSymlinksInPath(),
                        revision: revision,
                        configuration: configuration
                    )
                    if replacing {
                        return
                    }
                    await finishLiveStage(replacing: false)
                } catch {
                    artifactState = .failed("Could not load the staged diagram: \(error)")
                }
            }
        } catch {
            artifactState = .failed("Could not load this case's artifact: \(error)")
        }
    }

    /// The post-load evidence/mode chain shared by the two live web stages
    /// (`html_bundle` and `diagram`): the operator's Comment-mode entry, the
    /// evidence pin, or plain Interact mode with the tool-toggle hook.
    private func finishLiveStage(replacing: Bool) async {
        if replacing { return }
        // WAG-347: Comment in the case box opened this full size view. Comment mode starts on the page the
        // box was on, so the note is placed on the same view.
        if let handoff = commentHandoff {
            commentHandoff = nil
            await enterCommentMode()
            Task { await restorePage(handoff) }
            return
        }
        if let prefix = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_COMMENT_ZOOM"] {
            await runCommentZoomEvidenceHook(prefix: prefix)
        } else if evidenceViews != nil {
            await runViewsEvidenceHook()
        } else if evidenceFlatComments != nil {
            await runFlatCommentsEvidenceHook()
        } else if evidenceMultiCaptureFinalMode != nil {
            await runMultiCaptureEvidenceHook()
        } else if startInCommentMode {
            await enterCommentMode(force: true)
            await placeEvidencePinIfNeeded()
        } else {
            mode = .interact
            scheduleEvidenceToolToggleIfNeeded()
        }
    }

    /// Puts the live page on the hash and the scroll the case box had (WAG-347). The page may still be loading:
    /// the read returns `nil` until it has loaded, so this waits for it, up to about four seconds.
    private func restorePage(_ handoff: CommentHandoff) async {
        var view = await webViewCapture.readPageView()
        for _ in 0..<40 where view == nil {
            try? await Task.sleep(nanoseconds: 100_000_000)
            view = await webViewCapture.readPageView()
        }
        guard view != nil else { return }
        if let hash = handoff.hash, !hash.isEmpty, hash != view?.hash { await webViewCapture.setHash(hash) }
        if let scroll = handoff.scroll, scroll != .zero { await webViewCapture.scrollPage(to: scroll) }
    }

    func enterInteractMode() {
        guard olderRevisionDisplay == nil, artifactState.interactAvailable else { return }
        // An open note belongs to the Comment layer, which is hidden now.
        commentsStore.cancelDraft()
        commentsStore.clearSelection()
        commentsStore.clearCommentSelection()
        mode = .interact
    }

    /// Enters Comment mode (HAIL-65). It takes no capture: a live prototype
    /// stays mounted and untouched, and the region layer draws over it. A
    /// capture is taken in the background when a comment is actually placed
    /// (`beginLiveDraft`). `force` only marks `load`'s own automatic first
    /// entry, which is not counted as the operator using Comment mode.
    /// A no-op while browsing an earlier revision read-only (§M9).
    func enterCommentMode(force: Bool = false) async {
        guard olderRevisionDisplay == nil else { return }
        guard force || mode != .comment else { return }
        if !force { commentsStore.clearSelection() }
        if force, case .screenshot = artifactState { await takeCapture() }
        mode = .comment
        // Only a user-initiated entry counts; `load`'s automatic first entry
        // (force) would make every screenshot review look like Comment mode use.
        if !force { reportCommentModeStarted() }
    }

    /// The capture the live prototype's region layer can still pin onto
    /// (HAIL-65): the latest capture, on this revision, while the operator has
    /// not touched the page since it was taken. `nil` means a new comment on
    /// the live view needs a new capture.
    var liveCapture: CaptureRecord? {
        guard let revision = artifactState.webRevision,
              let last = commentsStore.model.captures.last, !commentsStore.baseCaptureIds.contains(last.id),
              Self.shouldReuseLastCapture(
                  lastCapture: last, currentRevision: revision,
                  hasInteractedSinceLastCapture: webViewCapture.hasInteractedSinceLastCapture
              ),
              // HAIL-75: a scrollbar drag or a click-to-reveal scrolls the page
              // without an event the interaction monitor sees, so the page
              // must also still sit where the capture was taken.
              last.page.map({ page in webViewCapture.pageViewport.map(page.matches) ?? true }) ?? true,
              // HAIL-103: and the page must still be on the view it was taken on.
              PageView.shows(comment: last.view, current: webViewCapture.pageView) else { return nil }
        return last
    }

    /// True while Comment mode shows a still of an older capture instead of
    /// the live prototype: the operator picked a capture that is not the live
    /// one (HAIL-65: "show it only in that case").
    var showsStillOverLive: Bool {
        guard let selected = commentsStore.selectedCaptureId else { return false }
        return selected != liveCapture?.id
    }

    /// A region was dragged over the live prototype (`rect` is 0...1 of the
    /// prototype's frame). Reuses the live capture, or starts the background
    /// snapshot of a new one; nothing is listed until the note is saved.
    func beginLiveDraft(rect: Rect, viewport: PageViewport? = nil, variant: UsageVariant = .region) {
        guard commentsStore.draftPin == nil, let revision = artifactState.webRevision else { return }
        let controller = webViewCapture
        // HAIL-240: what is under the pin, read from the page in the background.
        let element = Task { @MainActor in await controller.readElement(atX: rect.x + rect.w / 2, y: rect.y + rect.h / 2) }
        if let live = liveCapture {
            commentsStore.beginDraft(rect: rect, on: live.id, variant: variant, element: element)
        } else {
            let scroll = evidenceScrollFraction
            let snapshot = Task { @MainActor in await controller.takeViewportSnapshot(scrollFractionBeforeCapture: scroll) }
            let view = Task { @MainActor in await controller.readPageView() }
            commentsStore.beginPendingDraft(rect: rect, revision: revision, page: viewport, variant: variant, snapshot: snapshot, view: view, element: element)
        }
    }

    /// WAG-280: a pin dropped on a still of an earlier capture of the live page. The pin keeps the
    /// region either way; when the page is live, on the same view and as wide as it was, the pin's
    /// spot is mapped to page coordinates (the capture's scroll offset plus the rect, in CSS px) and
    /// the element there is read. Otherwise there is no element to read and the answer is `nil`.
    func readElementOnStill(rect: Rect, captureId: String) -> Task<PageElementContext?, Never>? {
        guard let revision = artifactState.webRevision,
              let capture = commentsStore.model.captures.first(where: { $0.id == captureId }),
              capture.revision == revision, let page = capture.page,
              PageView.shows(comment: capture.view, current: webViewCapture.pageView) else { return nil }
        if let now = webViewCapture.pageViewport, abs(now.width - page.width) > 2 || abs(now.zoom - page.zoom) > 0.001 { return nil }
        let spot = CommentPageMapping.pageRect(for: rect, capture: page, fallbackSize: page.size)
        let controller = webViewCapture
        return Task { @MainActor in await controller.readElement(pageX: spot.midX, pageY: spot.midY) }
    }

    /// HAIL-103: brings the page to the view a comment was made on. A comment
    /// with a hash sets the hash on the live page; otherwise its saved capture
    /// opens as a still, as before. No-op when the comment's view is showing.
    func jumpToView(of comment: Comment) {
        guard olderRevisionDisplay == nil,
              !PageView.shows(comment: commentsStore.model.view(of: comment), current: webViewCapture.pageView) else { return }
        if let hash = commentsStore.model.view(of: comment)?.hash, !hash.isEmpty {
            let controller = webViewCapture
            Task { await controller.setHash(hash) }
        } else {
            commentsStore.selectCapture(id: comment.captureId)
            mode = .comment
        }
    }

    /// WAG-307: what the stage shows, for the comment list's "On other views".
    var commentViewContext: CommentViewContext {
        if let older = olderRevisionDisplay {
            switch older.content {
            case .markdown: return CommentViewContext(kind: .markdown, revision: older.revision)
            case .images: return CommentViewContext(kind: .screenshots, revision: older.revision)
            default: return .unknown
            }
        }
        guard let kind = artifactState.artifactKind, let revision = artifactState.revision else { return .unknown }
        var context = CommentViewContext(kind: kind, revision: revision)
        if artifactState.interactAvailable {
            context.pageView = webViewCapture.pageView
            context.shownCaptureId = showsStillOverLive ? commentsStore.selectedCaptureId : nil
            // A still over the live page is not the live state: its capture is the one on view.
            if showsStillOverLive { context.kind = .screenshot }
        } else if kind == .screenshot || kind == .screenshots {
            context.shownCaptureId = commentsStore.currentCapture?.id
        }
        return context
    }

    /// Show on a row of "On other views": reopens what can be reopened, and says so when it cannot.
    func showComment(_ comment: Comment) {
        let controller = webViewCapture
        let store = commentsStore
        store.setShowNotice(nil, for: comment.id)
        let actions = CommentShowActions(
            switchRevision: { [weak self] revision in
                guard let self else { return }
                if revision == self.artifactState.revision { self.returnToLatestRevision() } else { self.viewRevision(revision) }
            },
            showCapture: { [weak self] id in
                store.selectCapture(id: id)
                if self?.artifactState.interactAvailable == true { self?.mode = .comment }
            },
            setHash: { await controller.setHash($0) },
            findElement: { comment in
                let model = store.model
                guard let capture = model.captures.first(where: { $0.id == comment.captureId }), let page = capture.page else { return true }
                let spot = CommentPageMapping.pageRect(for: comment.rect, capture: page, fallbackSize: page.size)
                let found = await controller.readElement(pageX: spot.midX, pageY: spot.midY)
                return CommentShowPlan.elementFound(stored: model.elementContexts[comment.id], found: found)
            },
            reveal: { store.selectComment(id: $0.id, origin: .list) })
        let context = commentViewContext
        Task { @MainActor in
            let line = await CommentShowPlan.run(comment: comment, model: store.model, context: context, actions: actions)
            if let line { store.setShowNotice(line, for: comment.id) }
        }
    }

    /// ↵ on the live layer's note popover.
    /// Saves at once (HAIL-112): the comment counts in this same frame.
    @discardableResult
    func commitLiveDraftNow() -> Comment? {
        let hadPending = commentsStore.pending != nil
        let comment = commentsStore.commitDraftNow()
        if comment != nil, hadPending { webViewCapture.markCaptureTaken() }
        return comment
    }

    @discardableResult
    func commitLiveDraft() async -> Comment? {
        let comment = commitLiveDraftNow()
        await commentsStore.settleCaptures()
        return comment
    }

    /// The Interact column's "N comments on M captures · Show" line
    /// (HAIL-35 contract): switches to Comment mode on the session's
    /// existing latest capture, without freezing a new one - this is "look
    /// at what I already marked", not "C"'s "capture what I see now". A
    /// no-op without any capture yet, or while browsing an earlier revision
    /// read-only. Also opens the Comments tab (HAIL-56 contract: "`showExistingComments`
    /// ('Show') opens the Comments tab").
    func showExistingComments() {
        guard olderRevisionDisplay == nil, let latest = commentsStore.model.captures.last else { return }
        // A live prototype draws every capture's pins on the page itself
        // (HAIL-75); only a still (screenshot) needs its capture picked.
        if !artifactState.interactAvailable { commentsStore.selectCapture(id: latest.id) }
        mode = .comment
        tab = .comments
    }

    /// The Question | Comments switch itself (HAIL-56 contract): a direct
    /// pick always wins, independent of the canvas toolbar's tool.
    func selectTab(_ tab: ReviewColumnTab) {
        self.tab = tab
    }

    /// The thumbnail strip's click handler (HAIL-40): a thin wrapper over
    /// `commentsStore.selectCapture`, so the strip has one source of truth
    /// for "which screen is shown" - no `selectedScreenIndex` of its own.
    func selectScreen(id: String) {
        commentsStore.selectCapture(id: id)
    }

    /// ← / → (HAIL-40): moves to the next/prior screen in capture order,
    /// clamped at both ends. A no-op outside a screenshots case, or without
    /// a current capture to step from.
    func stepScreen(by delta: Int) {
        guard case .screenshots = artifactState else { return }
        let captures = commentsStore.galleryScreens
        guard let current = commentsStore.currentCapture,
              let index = captures.firstIndex(where: { $0.id == current.id }) else { return }
        let target = max(0, min(captures.count - 1, index + delta))
        commentsStore.selectCapture(id: captures[target].id)
    }

    /// Whether re-entering Comment mode should reuse the session's last
    /// capture instead of freezing a new one. Pure and testable without a
    /// live webview: `hasInteractedSinceLastCapture` is
    /// `WebViewCaptureController`'s own tracked signal.
    static func shouldReuseLastCapture(lastCapture: CaptureRecord, currentRevision: Int, hasInteractedSinceLastCapture: Bool) -> Bool {
        lastCapture.revision == currentRevision && !hasInteractedSinceLastCapture
    }

    /// The §M9 "`<k> comments on v<n-1>` · view v<n-1>" link: freezes the
    /// viewer onto that earlier revision's own captures and pins, read-only.
    /// A no-op without a revision arrival to browse away from.
    func viewOlderRevision() {
        guard let arrival = revisionArrival else { return }
        viewRevision(arrival.priorRevision)
    }

    /// The tab on show: the one that holds the revision on the stage.
    var shownTab: ArtifactTab? {
        guard let revision = artifactState.revision else { return nil }
        return artifactTabs.first { $0.revisions.contains(revision) || $0.revision == revision }
    }

    /// An option or decision anchor to scroll to in the live page (WAG-381). A new `token` runs it once.
    @Published private(set) var anchorRequest: SandboxedHTMLView.AnchorRequest?
    private var anchorToken = 0
    private var decisionToken = 0

    /// WAG-381: the decision on screen changed (an answer that moves on, Next, Back, a step pill, a pick). Show its
    /// tab, anchor or image with the rule of the case box (`DecisionArtifactRule.resolve`). The person's own flip or
    /// tab change stays until the decision changes again.
    func follow(decision focus: DecisionFocus) async {
        guard olderRevisionDisplay == nil else { return }
        decisionToken += 1
        let token = decisionToken
        let tabs = artifactTabs
        guard let target = await DecisionArtifactRule.resolve(
                  for: focus, tabs: tabs, current: { [weak self] in self?.shownTab?.id },
                  prepare: { [weak self] in await self?.show(revision: $0.revision) },
                  captions: { [weak self] id in tabs.first { $0.id == id }.flatMap { self?.commentsStore.captions(ofSet: $0.revision) } },
                  items: { [weak self] id in tabs.first { $0.id == id }.flatMap { self?.commentsStore.items(ofSet: $0.revision) } }),
              token == decisionToken
        else { return }
        if let id = target.tabId, let tab = tabs.first(where: { $0.id == id }) { await show(revision: tab.revision) }
        guard token == decisionToken else { return }
        if let anchor = target.anchor {
            anchorToken += 1
            anchorRequest = SandboxedHTMLView.AnchorRequest(token: anchorToken, anchor: anchor)
        }
        commentsStore.showDecisionGroup(target.group)
        if let image = target.image, commentsStore.screens.indices.contains(image) {
            commentsStore.selectCapture(id: commentsStore.screens[image].id)
        }
    }

    /// The artifact tabs of the round on screen (WAG-351): the round of the earlier revision being read, else
    /// the newest round.
    var artifactTabs: [ArtifactTab] { detail?.artifactTabs(viewing: olderRevisionDisplay?.revision) ?? [] }

    /// Shows one revision read-only on the stage. A plan round's "See vN" (HAIL-156) and the
    /// "view v<n-1>" link both come here.
    func viewRevision(_ revision: Int) {
        guard let detail else { return }
        olderRevisionDisplay = OlderRevisionDisplay.build(revision: revision, from: detail)
        olderRevisionTask?.cancel()
        let caseId = detail.case.id
        olderRevisionTask = Task { [weak self] in
            guard let self else { return }
            let content = await self.loadOlderRevisionContent(caseId: caseId, revision: revision)
            guard !Task.isCancelled, self.olderRevisionDisplay?.revision == revision else { return }
            self.olderRevisionDisplay?.content = content
        }
        loadOlderRevisionImages(revision: revision)
    }

    /// Fills in the browsed revision's capture images once they arrive (PERF-2).
    private func loadOlderRevisionImages(revision: Int) {
        guard let pendingCaptures = olderRevisionDisplay?.captures, pendingCaptures.contains(where: { $0.image == nil }) else { return }
        olderRevisionImagesTask?.cancel()
        olderRevisionImagesTask = Task { [weak self, client] in
            let images = await OlderRevisionDisplay.loadedImages(for: pendingCaptures, with: client)
            guard !Task.isCancelled, let self, self.olderRevisionDisplay?.revision == revision else { return }
            for index in self.olderRevisionDisplay?.captures.indices ?? 0..<0 {
                if let image = images[self.olderRevisionDisplay!.captures[index].id] {
                    self.olderRevisionDisplay?.captures[index].image = image
                }
            }
        }
    }

    /// Loads one earlier revision's own artifact for the read-only stage (HAIL-142).
    /// Never touches the live `artifactState`, mode or captures.
    private func loadOlderRevisionContent(caseId: String, revision: Int) async -> OlderRevisionContent {
        guard let result = try? await client.artifactPath(caseId: caseId, revision: revision) else { return .unavailable }
        await isolationGate.runSelfCheckIfNeeded()
        let htmlEnabled = HTMLPreviewSettings.isEnabled(isolationPassed: isolationGate.htmlPreviewAvailable)
        switch OlderRevisionPlan.plan(for: result, htmlEnabled: htmlEnabled) {
        case .markdown(let path):
            guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return .unavailable }
            return .markdown(text)
        case .images(let paths):
            let images = paths.compactMap { NSImage(contentsOfFile: $0) }
            return images.count == paths.count && !images.isEmpty ? .images(images) : .unavailable
        case .bundleImage(let path):
            return NSImage(contentsOfFile: path).map { .images([$0]) } ?? .unavailable
        case .bundle(let entry, let root):
            guard let configuration = isolationGate.makeConfiguration() else { return .unavailable }
            return .web(
                entryURL: URL(fileURLWithPath: entry).resolvingSymlinksInPath(),
                directoryURL: URL(fileURLWithPath: root).resolvingSymlinksInPath(),
                configuration: configuration
            )
        case .diagram(let path):
            guard let text = try? String(contentsOfFile: path, encoding: .utf8),
                  isolationGate.htmlPreviewAvailable, let configuration = isolationGate.makeConfiguration() else { return .unavailable }
            do {
                let directory = try DiagramPage.makeTempDirectory()
                let entry = try DiagramPage.materialize(
                    source: text, format: DiagramFormat(pathExtension: (path as NSString).pathExtension),
                    mermaidJSURL: MermaidResource.mermaidJSURL(), into: directory
                )
                return .web(
                    entryURL: entry.resolvingSymlinksInPath(), directoryURL: directory.resolvingSymlinksInPath(),
                    configuration: configuration
                )
            } catch {
                return .unavailable
            }
        case .unavailable:
            return .unavailable
        }
    }

    // MARK: - Edit in place (HAIL-168)

    /// The Edit button shows on a markdown explanation that is not locked, not an older revision.
    var canEditInPlace: Bool {
        guard case .markdown = artifactState else { return false }
        return olderRevisionDisplay == nil && editSession == nil && !isSavingEdit
    }

    /// Opens the editor on the shown revision. The diff the agent gets is against the version the
    /// person started from: when they edit their own v2 again, that is still the agent's v1.
    func beginEditing() {
        guard canEditInPlace, case .markdown(let text, let revision) = artifactState else { return }
        let shown = ([humanRevision].compactMap { $0 } + (detail?.revisions ?? [])).first { $0.n == revision }
        let base = shown?.author == .you ? (shown?.baseRevision ?? revision) : revision
        comparison = nil
        editError = nil
        editSession = MarkdownEditSession(markdown: text, baseRevision: base)
    }

    /// Leaves the editor and drops what was typed.
    func cancelEditing() {
        editSession = nil
        editError = nil
    }

    /// Done: stores the edit as the next revision by the person and shows it.
    func finishEditing() async {
        guard let session = editSession, let caseId = detail?.case.id, !isSavingEdit else { return }
        guard session.hasChanges else {
            cancelEditing()
            return
        }
        isSavingEdit = true
        editError = nil
        defer { isSavingEdit = false }
        do {
            let saved = try await client.revisionAddByHuman(
                caseId: caseId, baseRevision: session.baseRevision, markdown: session.markdown)
            editSession = nil
            humanRevision = saved
            await present(caseId: caseId, revision: saved.n, replacing: true)
            onDocumentEdited?(saved)
        } catch {
            editError = "Could not save your edit. Your changes are still here. Try Done again."
        }
    }

    /// "Compare with v1": the edit over the version it started from, or back to the plain view.
    func toggleComparison() async {
        if comparison != nil {
            comparison = nil
            return
        }
        guard let human = humanRevision, let base = human.baseRevision, let caseId = detail?.case.id,
              case .markdown(let current, let shown) = artifactState, shown == human.n,
              let result = try? await client.artifactPath(caseId: caseId, revision: base),
              let old = try? String(contentsOfFile: result.root, encoding: .utf8) else { return }
        comparison = MarkdownEditSession(comparing: old, to: current, baseRevision: base)
    }

    /// `KNOCK_EVIDENCE_EDIT="ten=>five;;a phrase=>"` (HAIL-168 evidence hook): opens the editor on
    /// the explanation and applies those replacements, as typing would; `;;done` ends with Done.
    /// Never set outside evidence runs.
    private func runEditEvidenceHookIfRequested() {
        guard let spec = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_EDIT"] else { return }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard let self else { return }
            self.beginEditing()
            guard let session = self.editSession else { return }
            var finish = false
            for item in spec.components(separatedBy: ";;") {
                if item == "done" { finish = true; continue }
                let parts = item.components(separatedBy: "=>")
                guard parts.count == 2 else { continue }
                let text = String(decoding: session.model.displayText, as: UTF16.self) as NSString
                let found = text.range(of: parts[0])
                guard found.location != NSNotFound else { continue }
                _ = session.replace(found.location..<(found.location + found.length), with: parts[1])
            }
            if finish { await self.finishEditing() }
        }
    }

    /// Returns the viewer to the live latest revision.
    func returnToLatestRevision() {
        olderRevisionTask?.cancel()
        olderRevisionImagesTask?.cancel()
        olderRevisionDisplay = nil
    }

    private func scheduleEvidenceToolToggleIfNeeded() {
        guard let delay = evidenceToggleToolAfter else { return }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            await self?.enterCommentMode()
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            self?.enterInteractMode()
        }
    }

    /// `KNOCK_EVIDENCE_PIN_TEXT` (see the property doc): a committed pin
    /// near the bottom of the live prototype, in place of a drag gesture. A
    /// no-op without the env var.
    private func placeEvidencePinIfNeeded() async {
        guard let evidencePinText else { return }
        await placeLiveEvidenceComment(evidencePinText, rect: Rect(x: 0.3, y: 0.92, w: 0.35, h: 0.05))
    }

    private func placeLiveEvidenceComment(_ text: String, rect: Rect) async {
        beginLiveDraft(rect: rect)
        commentsStore.updateDraftText(text)
        await commitLiveDraft()
    }

    /// `KNOCK_EVIDENCE_SCREENSHOTS_COMMENTS` (see the property doc): one pin
    /// on the first screen, one on the last, then lands on the middle screen
    /// - with fewer than 3 screens, lands on the last screen instead. A
    /// no-op without at least 2 captures.
    private func placeEvidenceScreenshotsCommentsIfNeeded() {
        let captures = commentsStore.model.captures
        // `=inline` (HAIL-75 rebase evidence): three numbered pins low on the
        // first screen, stay there, open the first pin's inline card.
        if evidenceScreenshotsComments == "inline", let first = captures.first {
            for (index, text) in ["Tighten the copy here.", "Make this button bigger.", "Wrong icon."].enumerated() {
                commentsStore.selectCapture(id: first.id)
                commentsStore.beginDraft(rect: Rect(x: 0.08, y: 0.60 + 0.12 * Double(index), w: 0.3, h: 0.05))
                commentsStore.updateDraftText(text)
                commentsStore.commitDraft()
            }
            commentsStore.selectCapture(id: first.id)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [commentsStore] in
                if let comment = commentsStore.model.orderedComments.first(where: { $0.n == 1 }) {
                    commentsStore.selectComment(id: comment.id, origin: .artifact)
                }
            }
            return
        }
        guard captures.count >= 2 else { return }
        pinComment("Tighten the copy on this screen.", on: captures.first!.id)
        pinComment("Increase the CTA button size here.", on: captures.last!.id)
        let middleIndex = (captures.count - 1) / 2
        commentsStore.selectCapture(id: captures[middleIndex].id)
    }

    private func pinComment(_ text: String, on captureId: String) {
        commentsStore.selectCapture(id: captureId)
        commentsStore.beginDraft(rect: Rect(x: 0.3, y: 0.85, w: 0.35, h: 0.05))
        commentsStore.updateDraftText(text)
        commentsStore.commitDraft()
    }

    /// `KNOCK_EVIDENCE_FLAT_COMMENTS` (see the property doc).
    private func runFlatCommentsEvidenceHook() async {
        mode = .interact
        await enterCommentMode(force: true)
        var placements: [(scrollY: Double, rect: Rect, text: String)] = [
            (0, Rect(x: 0.05, y: 0.12, w: 0.3, h: 0.08), "Hero headline is too vague."),
            (0, Rect(x: 0.05, y: 0.30, w: 0.25, h: 0.08), "Make this button bigger."),
            (700, Rect(x: 0.05, y: 0.30, w: 0.3, h: 0.08), "Pricing copy: say what annual saves."),
            (700, Rect(x: 0.4, y: 0.60, w: 0.35, h: 0.08), "Add a testimonial photo."),
        ]
        // HAIL-75 evidence: four pins on one screen.
        if ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_INLINE"] != nil {
            placements = placements.enumerated().map { index, item in
                (0, Rect(x: 0.08 + 0.2 * Double(index % 2), y: 0.14 + 0.16 * Double(index), w: 0.25, h: 0.08), item.text)
            }
        }
        for placement in placements {
            await webViewCapture.scrollPage(to: CGPoint(x: 0, y: placement.scrollY))
            var viewport = webViewCapture.pageViewport
            for _ in 0..<40 where viewport == nil || abs((viewport?.scrollY ?? 0) - placement.scrollY) > 1 {
                try? await Task.sleep(nanoseconds: 100_000_000)
                await webViewCapture.scrollPage(to: CGPoint(x: 0, y: placement.scrollY))
                viewport = webViewCapture.pageViewport
            }
            beginLiveDraft(rect: placement.rect, viewport: viewport)
            commentsStore.updateDraftText(placement.text)
            await commitLiveDraft()
        }
        await webViewCapture.scrollPage(to: .zero)
        let shotPrefix = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_WINDOW_SHOT"]
        if let shotPrefix {
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            _ = await webViewCapture.writeWindowShot(to: "\(shotPrefix)-top.png")
        }
        // `KNOCK_EVIDENCE_INLINE=<n>` (HAIL-75 evidence): with the window shot
        // prefix, shows comment n's hover preview, then its open inline card.
        if let shotPrefix, let n = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_INLINE"].flatMap(Int.init),
           let comment = commentsStore.model.orderedComments.first(where: { $0.n == n }) {
            commentsStore.setHoveredComment(comment.id)
            try? await Task.sleep(nanoseconds: 800_000_000)
            _ = await webViewCapture.writeWindowShot(to: "\(shotPrefix)-hover.png")
            commentsStore.selectComment(id: comment.id, origin: .artifact)
            try? await Task.sleep(nanoseconds: 800_000_000)
            _ = await webViewCapture.writeWindowShot(to: "\(shotPrefix)-edit.png")
            return
        }
        let pick = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_SELECT_COMMENT"].flatMap(Int.init) ?? evidenceFlatComments ?? 1
        if pick > 0, let comment = commentsStore.model.orderedComments.first(where: { $0.n == pick }) {
            try? await Task.sleep(nanoseconds: 400_000_000)
            commentsStore.selectComment(id: comment.id, origin: .list)
        }
        if let shotPrefix {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            _ = await webViewCapture.writeWindowShot(to: "\(shotPrefix)-selected.png")
        }
    }

    /// `KNOCK_EVIDENCE_COMMENT_ZOOM=<prefix>` (operator, 4 Oct: Comment mode
    /// zooms): on a page with a `#target` element, enters Comment mode at
    /// 200%, logs the scroll probe (`evidenceScrollProbe`), places a comment exactly on the
    /// target, then at 50%, 100% and 400% logs where the pin is drawn against
    /// where the target is on screen (`evidence-comment-zoom:` lines on
    /// stderr). Writes `<prefix>-capture.png` (the comment's snapshot).
    private func runCommentZoomEvidenceHook(prefix: String) async {
        func log(_ line: String) { FileHandle.standardError.write(Data("evidence-comment-zoom: \(line)\n".utf8)) }
        let controller = webViewCapture
        // `KNOCK_EVIDENCE_COMMENT_ZOOM_TARGET` picks another element (`#diagram svg` for a diagram).
        let selector = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_COMMENT_ZOOM_TARGET"] ?? "#target"
        let target = "(function(){var r=document.querySelector(\"\(selector)\").getBoundingClientRect();return [r.left,r.top,r.width,r.height];})()"
        func targetInLayer() async -> CGRect? {
            guard let raw = await controller.evaluate(target) else { return nil }
            let numbers = raw.split(whereSeparator: { !"0123456789.-".contains($0) }).compactMap { Double($0) }
            guard numbers.count == 4 else { return nil }
            let zoom = controller.pageViewport?.zoom ?? 1
            return CGRect(x: numbers[0] * zoom, y: numbers[1] * zoom, width: numbers[2] * zoom, height: numbers[3] * zoom)
        }
        func settle() async {
            try? await Task.sleep(nanoseconds: 900_000_000)
            await controller.scrollPage(to: controller.pageViewport?.scroll ?? .zero)
        }
        await enterCommentMode(force: true)
        for _ in 0..<60 where controller.pageViewport == nil { try? await Task.sleep(nanoseconds: 100_000_000) }
        prototypeZoom.setScale(2)
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        await controller.scrollPage(to: CGPoint(x: 1000, y: 700))
        await settle()
        log("window=\(controller.evidenceWindowNumber) layer=\(controller.evidenceLayerSize) at200=\(String(describing: controller.pageViewport))")
        log("scroll probe: \(await controller.evidenceScrollProbe())")
        await settle()
        log("after scroll: \(String(describing: controller.pageViewport))")
        guard let onScreen = await targetInLayer() else { return log("no #target") }
        let size = controller.evidenceLayerSize
        let rect = Rect(x: onScreen.minX / size.width, y: onScreen.minY / size.height, w: onScreen.width / size.width, h: onScreen.height / size.height)
        beginLiveDraft(rect: rect, viewport: controller.pageViewport)
        commentsStore.updateDraftText("On the target at 200%.")
        guard let comment = await commitLiveDraft() else { return log("no comment") }
        if let image = commentsStore.imagesByCaptureId[comment.captureId], let tiff = image.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: "\(prefix)-capture.png"))
            log("capture image \(image.size) rect \(rect)")
        }
        for scale in [0.5, 1, 4] as [CGFloat] {
            prototypeZoom.setScale(scale)
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if scale == 4 { await controller.scrollPage(to: CGPoint(x: 1150, y: 860)) }
            await settle()
            let capture = commentsStore.model.captures.first { $0.id == comment.captureId }?.page
            let pin = CommentPageMapping.layerRect(for: comment.rect, capture: capture, current: controller.pageViewport, layerSize: size)
            let actual = await targetInLayer()
            log("scale \(scale): pin \(pin.integral) target \(actual.map { "\($0.integral)" } ?? "nil") viewport \(String(describing: controller.pageViewport))")
            try? await Task.sleep(nanoseconds: 2_500_000_000)
        }
        log("done")
    }

    /// `KNOCK_EVIDENCE_VIEWS` (see the property doc).
    private func runViewsEvidenceHook() async {
        guard let hashes = evidenceViews else { return }
        await enterCommentMode(force: true)
        // The page has to be loaded and tracked before its hash can be set.
        for _ in 0..<60 where webViewCapture.pageView == nil { try? await Task.sleep(nanoseconds: 100_000_000) }
        for hash in hashes {
            await webViewCapture.setHash(hash)
            try? await Task.sleep(nanoseconds: 700_000_000)
            // A comment on a new view must not reuse the last view's capture.
            await placeLiveEvidenceComment("Comment on tab \(hash.uppercased()).", rect: Rect(x: 0.3, y: 0.3, w: 0.35, h: 0.1))
        }
        let prefix = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_WINDOW_SHOT"]
        for hash in hashes {
            await webViewCapture.setHash(hash)
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            if let prefix { _ = await webViewCapture.writeWindowShot(to: "\(prefix)-\(hash).png") }
        }
    }

    /// `KNOCK_EVIDENCE_MULTI_CAPTURE` (see the property doc): Interact →
    /// Comment (capture 1, pinned) → Interact (with a simulated interaction,
    /// since there is no accessibility permission to actually click the
    /// prototype) → Comment (capture 2, pinned), ending in the requested
    /// mode.
    private func runMultiCaptureEvidenceHook() async {
        mode = .interact
        await enterCommentMode(force: true)
        await placeLiveEvidenceComment("Fix the footer CTA copy.", rect: Rect(x: 0.3, y: 0.08, w: 0.35, h: 0.05))

        enterInteractMode()
        webViewCapture.recordInteraction()
        await enterCommentMode()
        await placeLiveEvidenceComment("Increase the CTA button contrast.", rect: Rect(x: 0.3, y: 0.85, w: 0.35, h: 0.05))

        if evidenceMultiCaptureFinalMode == "interact" {
            enterInteractMode()
            // HAIL-87: a window shot of the page with its pins, in Interact mode.
            if let shotPrefix = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_WINDOW_SHOT"] {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                _ = await webViewCapture.writeWindowShot(to: "\(shotPrefix)-interact.png")
            }
        }
    }

    /// Reports comment_mode_started (KNOCK-19) without blocking. Dropped on
    /// failure, so it never delays entering Comment mode.
    private func reportCommentModeStarted() {
        if let usage {
            usage.record(.commentModeStarted)
        } else {
            Task { try? await client.usageRecord(event: .commentModeStarted) }
        }
    }

    /// WAG-413: the still Compare shows beside `after`, from `beforeRevision`. For a set it is the screen that
    /// goes with the shown one (`ComparePair.screenIndex`). Reuses a still the store holds. Returns its
    /// capture id, or nil when the earlier revision has no such screen or cannot be read.
    func prepareCompareBefore(after: CaptureRecord, beforeRevision: Int) async -> String? {
        guard let caseId = detail?.case.id,
              let result = try? await client.artifactPath(caseId: caseId, revision: beforeRevision) else { return nil }
        let shownIndex = commentsStore.screenIndexByCaptureId[after.id] ?? 0
        let path: String
        let index: Int
        var caption: String?
        switch result.kind {
        case .screenshot:
            path = result.root
            index = 0
        case .screenshots:
            let items = result.items ?? []
            guard let found = ComparePair.screenIndex(
                shownIndex: shownIndex, shownCaption: commentsStore.captionsByCaptureId[after.id], beforeCaptions: items.map(\.caption)
            ) else { return nil }
            path = items[found].path
            index = found
            caption = items[found].caption
        default:
            return nil
        }
        if let existing = commentsStore.compareStill(revision: beforeRevision, screenIndex: index) { return existing.id }
        guard let image = NSImage(contentsOfFile: path) else { return nil }
        return commentsStore.addCompareStill(image: image, revision: beforeRevision, screenIndex: index, caption: caption).id
    }

    /// Adds the base capture of a single screenshot artifact (its own image;
    /// not listed or counted until it has a comment). A live prototype takes
    /// its captures lazily instead (`beginLiveDraft`).
    private func takeCapture() async {
        guard case .screenshot(let image, let revision) = artifactState else { return }
        // The case page box may have put this screenshot in the store already (WAG-311): use that capture.
        if let existing = commentsStore.model.captures.first(where: { $0.revision == revision && commentsStore.baseCaptureIds.contains($0.id) }) {
            commentsStore.selectCapture(id: existing.id)
            return
        }
        commentsStore.addCapture(image: image, revision: revision, isBase: true)
    }
}
