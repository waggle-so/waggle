import SwiftUI
import WebKit

/// The artifact viewer column (docs/design/mvp-values.md §M4 `MYn95` →
/// `p3INw`, §M10 `y0wuNs` → `nVlyf`, §M5 `z4rHb6` → `kSr5W`; HAIL-56 frames
/// `ovd06`/`PPM9l`): artifact tabs (chrome label, Capture chip, Offline/
/// Sandboxed badges), and the stage — a screenshot with zoom, a sandboxed
/// `WKWebView`, the frozen Comment-mode capture, or a preview-unavailable
/// notice — under a floating canvas toolbar (the Interact/Comment tool
/// switch, HAIL-56: moved off the artifact bar and its own hint bar, both
/// removed; how each tool works shows in a hover card, HAIL-58).
struct ArtifactViewerView: View {
    @ObservedObject var viewModel: ReviewViewModel
    /// Observed directly: the stage depends on which capture is picked and on
    /// the saved pins, which change without the view model publishing.
    @ObservedObject private var commentsStore: CommentsSessionStore
    /// HAIL-127: the prototype's zoom (pinch, readout, Fit).
    @ObservedObject private var prototypeZoom: PrototypeZoomModel
    /// Hides the Comment tool, its "C" shortcut and its hint text
    /// (docs/stories/HAIL-34.md fold: "Comment mode is off (Interact only)"
    /// once the answer is locked - queued without editing, or delivered).
    /// `ReviewWorkspaceView.isAnswerLocked` is the source of truth; this view
    /// has no `Case` of its own to derive it from.
    let isLocked: Bool
    @StateObject private var zoomController = ScreenshotZoomController()
    /// HAIL-73: zoom and One / Set for the screenshot stage.
    @StateObject private var stageModel: ScreenshotStageModel
    /// WAG-413: the Compare switch and its panel. Off by default.
    @StateObject private var compare: CompareModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var evidenceStageStarted = false
    /// WAG-321: the count and the up and down buttons in the header read the write-up on show.
    @StateObject private var changesHub = WriteUpChangesHub()
    /// Cancel with changes asks first (HAIL-168).
    @State private var confirmingDiscard = false
    /// The version that arrived while this page was on show; the header marks it "new" for a few seconds.
    @State private var newMarkRevision: Int?

    /// The toolbar's Open menu (WAG-309): the artifact on show in a window of its own, or in the browser.
    /// `nil` hides the item.
    var onOpenWindow: ((ArtifactTab) -> Void)?
    var onOpenBrowser: ((ArtifactTab) -> Void)?

    init(
        viewModel: ReviewViewModel, isLocked: Bool,
        onOpenWindow: ((ArtifactTab) -> Void)? = nil, onOpenBrowser: ((ArtifactTab) -> Void)? = nil
    ) {
        self.viewModel = viewModel
        self.isLocked = isLocked
        self.onOpenWindow = onOpenWindow
        self.onOpenBrowser = onOpenBrowser
        self._commentsStore = ObservedObject(wrappedValue: viewModel.commentsStore)
        self._prototypeZoom = ObservedObject(wrappedValue: viewModel.prototypeZoom)
        self._stageModel = StateObject(wrappedValue: ScreenshotStageModel(usage: viewModel.usage))
        self._compare = StateObject(wrappedValue: CompareModel(usage: viewModel.usage))
    }

    private var artifactState: ReviewArtifactState { viewModel.artifactState }
    private var mode: ReviewMode { viewModel.mode }

    /// The artifacts of the case, one tab each (WAG-309): the same list as the case page box.
    private var artifactTabList: [ArtifactTab] { viewModel.artifactTabs }

    private var selectedTabId: String? {
        ArtifactTabs.tabId(showing: viewModel.olderRevisionDisplay?.revision ?? artifactState.revision, revisions: viewModel.detail?.revisions ?? [])
    }

    private var selectedTab: ArtifactTab? { artifactTabList.first { $0.id == selectedTabId } }
    private var singleTab: ArtifactTab? { artifactTabList.count == 1 ? artifactTabList.first : nil }

    /// The tab strip shows when the case has several artifacts, as in the box header.
    private var showsTabStrip: Bool { artifactTabList.count > 1 }

    /// The artifact's version, once (WAG-309). With the tab strip the tab names the artifact, so only "v8"
    /// shows; else the name and the version. While an older version is on show it reads "v2 of 3".
    /// The capture position is in the filmstrip only.
    private var chromeText: String {
        let title: String
        switch artifactState {
        case .loading, .failed: return ""
        case .screenshot: title = ArtifactTabs.defaultTitle(.screenshot)
        case .htmlBundle, .htmlBundleUnavailable: title = ArtifactTabs.defaultTitle(.htmlBundle)
        case .diagram: title = ArtifactTabs.defaultTitle(.diagram)
        case .markdown:
            // HAIL-168: with the person's edit the version chips say which version this is.
            if viewModel.humanRevision != nil { return showsTabStrip ? "" : ArtifactTabs.defaultTitle(.markdown) }
            title = ArtifactTabs.defaultTitle(.markdown)
        case .screenshots: title = ArtifactTabs.defaultTitle(.screenshots)
        }
        guard let revision = artifactState.revision else { return "" }
        var text = ArtifactVersionLabel.header(title: showsTabStrip ? nil : title, revision: revision, latest: nil)
        if case .htmlBundleUnavailable = artifactState, !showsTabStrip { text += " · preview unavailable" }
        return text
    }

    private var showsIsolationBadges: Bool {
        switch artifactState {
        case .htmlBundle, .diagram: return true
        default: return false
        }
    }

    /// Markdown is read-only text: no Interact/Comment concept applies (no
    /// image to pin a note on), so the toggle - and the "C" shortcut wired
    /// below - never shows for it (HAIL-33; see the Choices ledger).
    private var isMarkdown: Bool {
        if case .markdown = artifactState { return true }
        return false
    }

    /// Text comments of the case's sent replies (HAIL-150), drawn read-only on their revision.
    private var sentTextComments: [Comment] {
        (viewModel.detail?.comments ?? []).filter { $0.anchor != nil }
    }

    private var interactAvailable: Bool { artifactState.interactAvailable }

    private var olderRevision: OlderRevisionDisplay? { viewModel.olderRevisionDisplay }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let olderRevision {
                olderRevisionTabs(olderRevision).zIndex(1)
                olderRevisionStage(olderRevision)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                artifactTabs.zIndex(1)
                if compareActive {
                    ComparePanel(compare: compare)
                        .transition(reduceMotion ? .identity : .opacity.combined(with: .move(edge: .top)))
                        .zIndex(0)
                }
                if let staleNote = viewModel.staleArtifactNote {
                    staleArtifactLine(staleNote)
                }
                stage
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .overlay(alignment: .bottom) {
                        if showsCanvasToolbar, !isSetView {
                            canvasToolbar
                                .padding(.bottom, Self.toolbarBottomGap)
                        }
                    }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.list)
        .overlay(
            Rectangle().fill(Theme.Colors.line).frame(width: 1),
            alignment: .trailing
        )
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: compareActive)
        .animation(.easeOut(duration: 0.2), value: newMarkRevision)
        .onChange(of: arrivals) { old, new in
            guard let mark = ArtifactVersionLabel.newMark(from: old, to: new, latest: latestRevision) else { return }
            newMarkRevision = mark
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(ArtifactVersionLabel.newMarkSeconds))
                if newMarkRevision == mark { newMarkRevision = nil }
            }
        }
        .task(id: compareAvailable) {
            if compareAvailable { compare.applyEvidenceOnce(ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_COMPARE"]) }
        }
        .task(id: compareLoadKey) { await loadCompare() }
        .task(id: compareDiffKey) { await loadCompareDiff() }
        .alert("Discard your changes?", isPresented: $confirmingDiscard) {
            Button("Keep editing", role: .cancel) {}
            Button("Discard", role: .destructive) { viewModel.cancelEditing() }
        } message: {
            Text("Your edits to this document will be lost.")
        }
        .background(
            HStack {
                Button("Interact") { viewModel.enterInteractMode() }
                    .keyboardShortcut("i", modifiers: [])
                if !isLocked, !isMarkdown {
                    Button("Comment") { Task { await viewModel.enterCommentMode() } }
                        .keyboardShortcut("c", modifiers: [])
                }
                if showsEditButton {
                    Button("Edit") { viewModel.beginEditing() }
                        .keyboardShortcut("e", modifiers: [])
                }
                // Esc clears the highlighted comment (HAIL-75). Off while a note
                // or a card edit is open, where Esc means cancel that instead.
                Button("Clear highlight") { commentsStore.clearCommentSelection() }
                    .keyboardShortcut(.escape, modifiers: [])
                    .disabled(commentsStore.selectedCommentId == nil || commentsStore.draftPin != nil || commentsStore.editingCommentId != nil)
                if isScreenshots {
                    if isSetView {
                        Button("Open Screen") { openOutlinedScreen() }
                            .keyboardShortcut(.return, modifiers: [])
                    }
                }
                if showsPrototypeZoom {
                    Button("Fit") { prototypeZoom.fit() }
                        .keyboardShortcut("0", modifiers: .command)
                    Button("Actual Size") { prototypeZoom.actualSize() }
                        .keyboardShortcut("1", modifiers: .command)
                    Button("Zoom In") { prototypeZoom.zoomIn() }
                        .keyboardShortcut("+", modifiers: .command)
                    Button("Zoom In (=)") { prototypeZoom.zoomIn() }
                        .keyboardShortcut("=", modifiers: .command)
                    Button("Zoom Out") { prototypeZoom.zoomOut() }
                        .keyboardShortcut("-", modifiers: .command)
                    Button("Reload") { prototypeZoom.reload() }
                        .keyboardShortcut("r", modifiers: .command)
                }
                if showsStageControls, !isSetView {
                    Button("Fit") { stageModel.userFit() }
                        .keyboardShortcut("0", modifiers: .command)
                    Button("Actual Size") { stageModel.userActualSize() }
                        .keyboardShortcut("1", modifiers: .command)
                    Button("Zoom In") { stageModel.userZoomIn() }
                        .keyboardShortcut("+", modifiers: .command)
                    Button("Zoom In (=)") { stageModel.userZoomIn() }
                        .keyboardShortcut("=", modifiers: .command)
                    Button("Zoom Out") { stageModel.userZoomOut() }
                        .keyboardShortcut("-", modifiers: .command)
                }
            }
            .opacity(0)
        )
        // Left and Right flip screens only while no text field has focus (HAIL-233).
        .background(ScreenArrowKeys(isActive: isScreenshots, onStep: { stepScreens(by: $0) }))
        .task(id: isLivePrototype) {
            // `KNOCK_EVIDENCE_FIT=1` (HAIL-141): presses Fit for a live diagram
            // once the page has loaded, so the window shot shows it filling the
            // viewer width. Fit is retried because Mermaid draws asynchronously
            // and the page width is only readable once its SVG is in the DOM.
            guard isLivePrototype, ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_FIT"] == "1" else { return }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            // Mermaid draws asynchronously; keep pressing Fit until its SVG
            // width is readable (the model settles on the fill scale and later
            // fits recompute the same value, so this is idempotent).
            for _ in 0..<12 {
                prototypeZoom.fit()
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            // Log the page geometry at Fit: the SVG box against the viewport, in CSS pixels.
            let probe = "(function(){var s=document.querySelector('#diagram svg');if(!s)return 'no svg';var r=s.getBoundingClientRect();return JSON.stringify({svgLeft:r.left,svgWidth:r.width,viewport:window.innerWidth,magnification:1})})()"
            if let report = await viewModel.webViewCapture.evaluate(probe) {
                FileHandle.standardError.write(Data("evidence-fit: \(report) scale=\(prototypeZoom.storedScale) bounds=\(viewModel.webViewCapture.webViewWidth)\n".utf8))
            }
        }
        .task(id: isLivePrototype) {
            // `KNOCK_EVIDENCE_ZOOM=<n>` (HAIL-127): zooms the live prototype to n times 100% once.
            guard isLivePrototype, let n = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_ZOOM"].flatMap(Double.init) else { return }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            // `KNOCK_EVIDENCE_ZOOM_AT=<x>,<y>` (HAIL-131): keep the page point at these 0...1 fractions of the view.
            let at = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_ZOOM_AT"]?.split(separator: ",").compactMap { Double($0) }
            if let at, at.count == 2 { prototypeZoom.pendingAnchorFraction = CGPoint(x: at[0], y: at[1]) }
            prototypeZoom.setScale(CGFloat(n))
            // `KNOCK_EVIDENCE_PAN_TO=<x>,<y>` (HAIL-131): then scrolls the zoomed page to this CSS offset.
            // With `KNOCK_EVIDENCE_WINDOW_SHOT` it writes `<prefix>-zoom.png` and `<prefix>-pan.png`.
            let env = ProcessInfo.processInfo.environment
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if let prefix = env["KNOCK_EVIDENCE_WINDOW_SHOT"] { _ = await viewModel.webViewCapture.writeWindowShot(to: "\(prefix)-zoom.png"); _ = await viewModel.webViewCapture.writeWebShot(to: "\(prefix)-zoom-page.png") }
            if let to = env["KNOCK_EVIDENCE_PAN_TO"]?.split(separator: ",").compactMap({ Double($0) }), to.count == 2 {
                await viewModel.webViewCapture.scrollPage(to: CGPoint(x: to[0], y: to[1]))
                try? await Task.sleep(nanoseconds: 800_000_000)
                if let prefix = env["KNOCK_EVIDENCE_WINDOW_SHOT"] { _ = await viewModel.webViewCapture.writeWindowShot(to: "\(prefix)-pan.png"); _ = await viewModel.webViewCapture.writeWebShot(to: "\(prefix)-pan-page.png") }
            }
        }
        .onChange(of: viewModel.commentsStore.currentCapture?.id) { _, _ in
            // Fit is the default for every screenshot.
            stageModel.fit()
        }
    }

    /// `KNOCK_EVIDENCE_SCREEN=<n>` then `KNOCK_EVIDENCE_STAGE` (HAIL-73
    /// evidence hooks): picks screen n, then sets the stage state a moment
    /// later, since picking a screen resets the zoom to Fit.
    private func applyEvidenceStage() {
        let env = ProcessInfo.processInfo.environment
        guard !evidenceStageStarted else { return }
        evidenceStageStarted = true
        if let n = env["KNOCK_EVIDENCE_SCREEN"].flatMap(Int.init) {
            let captures = viewModel.commentsStore.screens
            if captures.indices.contains(n - 1) { viewModel.selectScreen(id: captures[n - 1].id) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            stageModel.applyEvidenceOnce(env["KNOCK_EVIDENCE_STAGE"], current: viewModel.commentsStore.currentCapture?.id)
            stageModel.applyEvidenceZoomOnce(env["KNOCK_EVIDENCE_ZOOM"], at: env["KNOCK_EVIDENCE_ZOOM_AT"])
        }
    }

    private var isSingleScreenshot: Bool {
        if case .screenshot = artifactState { return true }
        return false
    }

    /// Fit, 100% and zoom apply to a screenshot and to a set's One view.
    private var showsStageControls: Bool {
        (isScreenshots || isSingleScreenshot) && olderRevision == nil
    }

    /// Pinch, readout and Fit apply to the live prototype (not an older revision's still).
    private var showsPrototypeZoom: Bool { isLivePrototype && olderRevision == nil }

    private var isSetView: Bool { isScreenshots && stageModel.arrangement == .set }

    // MARK: - Compare (WAG-413)

    /// The revision before the one on show, in the same artifact; nil for the first revision.
    private var compareBeforeRevision: Int? {
        guard showsStageControls, let capture = commentsStore.currentCapture else { return nil }
        let revisions = (selectedTab ?? singleTab)?.revisions ?? []
        return ComparePair.previous(of: capture.revision, in: revisions)
    }

    private var compareAvailable: Bool { compareBeforeRevision != nil }

    /// Compare is on and there is something to compare. Off in Set view and for an older revision.
    private var compareActive: Bool {
        compare.isOn && compareAvailable && !isSetView && mode == .comment
    }

    private var compareLoadKey: String {
        "\(compareActive)-\(commentsStore.currentCapture?.id ?? "")-\(compareBeforeRevision ?? 0)"
    }

    private var compareDiffKey: String {
        "\(compareActive && compare.showsChanges)-\(compare.beforeCaptureId ?? "")-\(commentsStore.currentCapture?.id ?? "")"
    }

    /// Finds or loads the earlier revision's still for the shown screen.
    private func loadCompare() async {
        guard compareActive, let after = commentsStore.currentCapture, let beforeRevision = compareBeforeRevision else {
            compare.beforeCaptureId = nil
            commentsStore.activeCompareBeforeId = nil
            return
        }
        let id = await viewModel.prepareCompareBefore(after: after, beforeRevision: beforeRevision)
        guard !Task.isCancelled else { return }
        compare.beforeCaptureId = id
        commentsStore.activeCompareBeforeId = id
    }

    /// The "what changed" boxes, found off the main thread.
    private func loadCompareDiff() async {
        guard compareActive, compare.showsChanges, let beforeId = compare.beforeCaptureId,
              let afterId = commentsStore.currentCapture?.id,
              let before = commentsStore.imagesByCaptureId[beforeId].flatMap(CompareDiff.cgImage),
              let after = commentsStore.imagesByCaptureId[afterId].flatMap(CompareDiff.cgImage) else {
            compare.changeBoxes = []
            return
        }
        let boxes = await Task.detached(priority: .userInitiated) { CompareDiff.boxes(before: before, after: after) }.value
        guard !Task.isCancelled else { return }
        compare.changeBoxes = boxes
    }

    private func stepScreens(by delta: Int) {
        if isSetView {
            stageModel.moveSetFocus(ids: viewModel.commentsStore.screens.map(\.id), by: delta)
        } else {
            viewModel.stepScreen(by: delta)
        }
    }

    private func openScreen(id: String) {
        viewModel.selectScreen(id: id)
        stageModel.showOne()
    }

    private func openOutlinedScreen() {
        if let id = stageModel.setFocusId { openScreen(id: id) }
    }

    private func showSet() {
        viewModel.commentsStore.cancelDraft()
        stageModel.userShowSet(current: viewModel.commentsStore.currentCapture?.id)
    }

    /// The capture chip is the first thing to go when the stage is narrow (HAIL-84): the
    /// "Screenshot N / M" label and the controls keep their full size.
    @ViewBuilder
    private var artifactTabs: some View {
        if let session = viewModel.editSession {
            editingBar(session)
        } else {
            ViewThatFits(in: .horizontal) {
                artifactTabsRow(showsCaptureChip: true)
                artifactTabsRow(showsCaptureChip: false)
                // Narrowest: the isolation badges go too, so the tabs keep room (WAG-309).
                artifactTabsRow(showsCaptureChip: false, showsBadges: false)
            }
        }
    }

    // MARK: - Edit docs in place (HAIL-168)

    private var showsEditButton: Bool { isMarkdown && !isLocked && viewModel.canEditInPlace }

    /// Edit: white fill, line-2 stroke, radius 7, "Edit" 12.5 semibold and the key hint "E".
    private var editButton: some View {
        Button(action: { viewModel.beginEditing() }) {
            HStack(spacing: 6) {
                Text("Edit")
                    .knockTextStyle(Theme.Typography.buttonSm12_5w600)
                    .foregroundColor(Theme.Colors.ink)
                Text("E")
                    .knockTextStyle(Theme.Typography.keyHint10_5w400)
                    .foregroundColor(Theme.Colors.ink3)
            }
            .padding(EdgeInsets(top: 6, leading: 11, bottom: 6, trailing: 11))
            .background(Theme.Colors.win)
            .cornerRadius(Theme.Radius.buttonSmall)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.buttonSmall).stroke(Theme.Colors.line2, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
        .help("Edit this document in place (E)")
    }

    /// The header while editing: a ds-soft bar with Cancel and Done on the right.
    private func editingBar(_ session: MarkdownEditSession) -> some View {
        HStack(spacing: 10) {
            Text("Editing write-up · Done saves it as v\(nextVersionNumber), by you")
                .knockTextStyle(Theme.Typography.titlebarTitle13w600)
                .foregroundColor(Theme.Colors.ds)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let error = viewModel.editError {
                Text(error)
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .foregroundColor(Theme.Colors.accent)
                    .lineLimit(2)
            }
            Button(action: { requestCancelEditing() }) {
                Text("Cancel")
                    .knockTextStyle(Theme.Typography.buttonSm12_5w600)
                    .foregroundColor(Theme.Colors.ink)
                    .padding(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                    .background(Theme.Colors.win)
                    .cornerRadius(Theme.Radius.buttonSmall)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.buttonSmall).stroke(Theme.Colors.line2, lineWidth: 1)
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerCursor()
            Button(action: { Task { await viewModel.finishEditing() } }) {
                Text("Done")
                    .knockTextStyle(Theme.Typography.buttonSm12_5w600)
                    .foregroundColor(Theme.Colors.win)
                    .padding(EdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14))
                    .background(Theme.Colors.ink)
                    .cornerRadius(Theme.Radius.buttonSmall)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerCursor()
            .disabled(viewModel.isSavingEdit)
            .opacity(viewModel.isSavingEdit ? 0.6 : 1)
        }
        .padding(EdgeInsets(top: 8, leading: 24, bottom: 8, trailing: 24))
        .frame(maxWidth: .infinity)
        .background(Theme.Colors.dsSoft)
        .overlay(Rectangle().fill(Theme.Colors.line).frame(height: 1), alignment: .bottom)
    }

    /// The version the edit would become: one after the newest revision.
    private var nextVersionNumber: Int {
        let known = (viewModel.detail?.revisions.map(\.n).max() ?? 0)
        return max(known, viewModel.humanRevision?.n ?? 0, artifactState.revision ?? 0) + 1
    }

    private func requestCancelEditing() {
        if viewModel.editSession?.hasChanges == true { confirmingDiscard = true } else { viewModel.cancelEditing() }
    }

    /// "v1" and "v2 · you" (HAIL-168): the selected one has the ds-soft fill and the ds stroke.
    private func versionChips(selectedBase: Bool) -> some View {
        let human = viewModel.humanRevision
        return HStack(spacing: 6) {
            if let base = human?.baseRevision {
                versionChip("v\(base)", selected: selectedBase) { viewModel.viewRevision(base) }
            }
            if let human {
                versionChip("v\(human.n) · you", selected: !selectedBase) { viewModel.returnToLatestRevision() }
            }
        }
    }

    private func versionChip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .knockTextStyle(Theme.Typography.versionChipLabel11w600)
                .foregroundColor(selected ? Theme.Colors.ds : Theme.Colors.ink2)
                .padding(EdgeInsets(top: 3, leading: 8, bottom: 3, trailing: 8))
                .background(selected ? Theme.Colors.dsSoft : Color.clear)
                .cornerRadius(Theme.Radius.chip)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.chip)
                        .stroke(selected ? Theme.Colors.ds : Theme.Colors.line2, lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
    }

    /// "Compare with v1": shows the edit over the version it started from.
    @ViewBuilder
    private var compareButton: some View {
        if let base = viewModel.humanRevision?.baseRevision, isMarkdown {
            Button(action: { Task { await viewModel.toggleComparison() } }) {
                Text(viewModel.comparison == nil ? "Compare with v\(base)" : "Hide comparison")
                    .knockTextStyle(Theme.Typography.body12_5w400)
                    .foregroundColor(Theme.Colors.ink2)
            }
            .buttonStyle(.plain).pointerCursor()
        }
    }

    /// Removed and Added samples, and the one rule of the editor, under the body.
    private var editLegend: some View {
        HStack(spacing: 14) {
            Text("Removed")
                .strikethrough(true, color: Theme.Colors.accent)
                .foregroundColor(Theme.Colors.accent)
                .padding(.horizontal, 4)
                .background(Theme.Colors.accentSoft)
                .cornerRadius(3)
            Text("Added")
                .foregroundColor(Theme.Colors.ok)
                .padding(.horizontal, 4)
                .background(Theme.Colors.okSoft)
                .cornerRadius(3)
            Text("You edit the text, not markdown. Bold, lists and headings keep their look.")
                .foregroundColor(Theme.Colors.ink3)
                .lineLimit(1)
        }
        .knockTextStyle(Theme.Typography.recommendLine12w400)
        .padding(EdgeInsets(top: 10, leading: 24, bottom: 12, trailing: 24))
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(Rectangle().fill(Theme.Colors.line).frame(height: 1), alignment: .top)
    }

    /// The document while editing: formatted text on the win fill with a 3pt ds stroke on the left.
    private func editorStage(_ session: MarkdownEditSession) -> some View {
        VStack(spacing: 0) {
            MarkdownEditorView(session: session, onCancel: { requestCancelEditing() })
                .background(Theme.Colors.win)
                .overlay(Rectangle().fill(Theme.Colors.ds).frame(width: 3), alignment: .leading)
            editLegend
        }
    }

    /// The artifact tabs, in the live header and in the older version's header alike. While an older version
    /// is on show a tab opens read-only (WAG-351), except the tab of the newest version, which is the live one.
    private var tabStrip: some View {
        ArtifactTabStrip(tabs: artifactTabList, selectedId: selectedTabId) { tab in
            guard tab.id != selectedTabId else { return }
            if viewModel.olderRevisionDisplay != nil {
                if tab.revision == latestRevision { viewModel.returnToLatestRevision() } else { viewModel.viewRevision(tab.revision) }
            } else { Task { await viewModel.show(revision: tab.revision) } }
        }
        .frame(minWidth: 150)
        .layoutPriority(-1)
    }

    /// The newest version of the case, as the header says "v2 of 3".
    private var arrivals: ArtifactVersionLabel.Arrivals {
        .init(caseId: viewModel.detail?.case.id, count: viewModel.detail?.revisions.count ?? 0)
    }

    private var latestRevision: Int? {
        (viewModel.detail?.revisions.map(\.n).max()).map { max($0, artifactState.revision ?? 0) } ?? artifactState.revision
    }

    private func artifactTabsRow(showsCaptureChip: Bool, showsBadges: Bool = true) -> some View {
        HStack(spacing: 6) {
            if showsTabStrip { tabStrip }
            Text(chromeText)
                .knockTextStyle(Theme.Typography.monoMeta12w400)
                .foregroundColor(Theme.Colors.ink2)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
            if isScreenshots, !isSetView {
                ScreenTitleLabel(store: viewModel.commentsStore)
            }
            if let mark = newMarkRevision, mark == artifactState.revision {
                Text("new")
                    .knockTextStyle(Theme.Typography.chipLabel11_5w600)
                    .foregroundColor(Theme.Colors.ds)
                    .padding(EdgeInsets(top: 1, leading: 6, bottom: 1, trailing: 6))
                    .background(Theme.Colors.dsUpdateFill)
                    .cornerRadius(Theme.Radius.chip)
                    .transition(.opacity)
                    .accessibilityLabel("New version")
            }
            if isMarkdown, viewModel.humanRevision != nil {
                versionChips(selectedBase: false)
                compareButton
            }
            if showsCaptureChip, mode == .comment, let capture = viewModel.commentsStore.currentCapture,
               !isLivePrototype || viewModel.showsStillOverLive {
                captureChip(capture)
            }
            if showsIsolationBadges, showsBadges {
                // Narrow column: icons only (label on hover), never a letter-per-line wrap.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        badge(icon: "wifi.slash", label: "Offline")
                        badge(icon: "lock.fill", label: "Sandboxed")
                    }
                    HStack(spacing: 6) {
                        badge(icon: "wifi.slash", label: "Offline", compact: true)
                        badge(icon: "lock.fill", label: "Sandboxed", compact: true)
                    }
                }
            }
            Spacer(minLength: 0)
            WriteUpChangesControls(hub: changesHub)
            if showsEditButton {
                editButton
            }
            if showsStageControls {
                StageHeaderControls(
                    stage: stageModel, showsSetToggle: isScreenshots, onShowSet: showSet,
                    compare: compare, compareAvailable: compareAvailable
                )
                    .fixedSize()
            } else if showsPrototypeZoom {
                PrototypeZoomControls(zoom: prototypeZoom)
                    .fixedSize()
            }
            if let tab = selectedTab ?? singleTab {
                ArtifactFullSizeOpenMenu(
                    kind: tab.kind,
                    onOpenWindow: onOpenWindow.map { open in { open(tab) } },
                    onOpenBrowser: onOpenBrowser.map { open in { open(tab) } })
            }
        }
        .padding(EdgeInsets(top: showsStageControls || showsPrototypeZoom || showsEditButton || showsTabStrip ? 8 : 12, leading: 24, bottom: showsStageControls || showsPrototypeZoom || showsEditButton || showsTabStrip ? 8 : 12, trailing: 24))
        .overlay(
            Rectangle().fill(Theme.Colors.line).frame(height: 1),
            alignment: .bottom
        )
    }

    private func badge(icon: String, label: String, compact: Bool = false) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 11))
                .foregroundColor(Theme.Colors.ink2)
            if !compact {
                Text(label)
                    .knockTextStyle(Theme.Typography.badgeLabel11w500)
                    .foregroundColor(Theme.Colors.ink2)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .help(label)
        .padding(EdgeInsets(top: 3, leading: 7, bottom: 3, trailing: 7))
        .background(Theme.Colors.side)
        .cornerRadius(Theme.Radius.chip)
    }

    /// "Capture <n> · v<rev> · <time>" (docs/stories/KNOCK-11.md AC), the
    /// M5 `gK5qu` chip recipe: same shape as `badge`, mono text.
    private func captureChip(_ capture: CaptureRecord) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "camera")
                .font(.system(size: 12))
                .foregroundColor(Theme.Colors.ink2)
            Text(ArtifactVersionLabel.captureChip(
                n: capture.n, captureRevision: capture.revision, artifactRevision: artifactState.revision,
                time: KnockDateFormat.shortTime(from: capture.takenAt)))
                .knockTextStyle(Theme.Typography.monoMeta11w400)
                .foregroundColor(Theme.Colors.ink2)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .layoutPriority(-1)
        .padding(EdgeInsets(top: 3, leading: 7, bottom: 3, trailing: 7))
        .background(Theme.Colors.side)
        .cornerRadius(Theme.Radius.chip)
    }

    /// One plain line when the newest update sent no artifact (HAIL-146).
    private func staleArtifactLine(_ note: StaleArtifactNote) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 12))
            Text(note.text)
                .knockTextStyle(Theme.Typography.monoMeta12w400)
                .lineLimit(1)
        }
        .foregroundColor(Theme.Colors.ink2)
        .padding(EdgeInsets(top: 7, leading: 24, bottom: 7, trailing: 24))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.list)
        .overlay(
            Rectangle().fill(Theme.Colors.line).frame(height: 1),
            alignment: .bottom
        )
        .accessibilityIdentifier("stale-artifact-note")
    }

    /// The header while browsing an earlier revision (the "view v<n-1>" link): the same tab strip, then one
    /// quiet marker, "v2 of 3", and a "See latest" action. There is nothing to Interact/Comment with here
    /// (Non-goal: no comment migration between revisions).
    private func olderRevisionTabs(_ older: OlderRevisionDisplay) -> some View {
        let showsChips = viewModel.humanRevision?.baseRevision == older.revision
        let title = (selectedTab ?? singleTab).map { ArtifactTabs.defaultTitle($0.kind) }
        return HStack(spacing: 6) {
            if showsTabStrip { tabStrip }
            if showsChips { versionChips(selectedBase: true) }
            // With the person's edit the chips name the versions, so the text adds no second one.
            Text(showsChips ? "" : ArtifactVersionLabel.header(title: showsTabStrip ? nil : title, revision: older.revision, latest: latestRevision))
                .knockTextStyle(Theme.Typography.monoMeta12w400)
                .foregroundColor(Theme.Colors.ink2)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
            Spacer(minLength: 0)
            Button(action: { viewModel.returnToLatestRevision() }) {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 11))
                    Text("See latest")
                }
                .knockTextStyle(Theme.Typography.priorRevisionLink12w500)
                .foregroundColor(Theme.Colors.ink2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerCursor()
            .help(latestRevision.map { "Back to v\($0)" } ?? "Back to the latest version")
        }
        .padding(EdgeInsets(top: showsTabStrip ? 8 : 12, leading: 24, bottom: showsTabStrip ? 8 : 12, trailing: 24))
        .overlay(
            Rectangle().fill(Theme.Colors.line).frame(height: 1),
            alignment: .bottom
        )
    }

    /// The browsed revision's own artifact (HAIL-142), then every capture staged
    /// against it, stacked (never side by side - Non-goal), each already carrying
    /// its numbered pins baked into the image (`OlderRevisionDisplay`). A bundle
    /// or diagram that has captures shows the captures only: they are stills of
    /// that page, and a web view cannot sit inside the scroll view.
    @ViewBuilder
    private func olderRevisionStage(_ older: OlderRevisionDisplay) -> some View {
        if case .markdown(let text) = older.content, older.captures.isEmpty {
            // HAIL-150: the earlier revision's own highlights, read-only.
            CommentableMarkdownView(
                markdown: text, revision: older.revision, store: commentsStore,
                extraComments: sentTextComments, canComment: false
            )
        } else if case .web(let entryURL, let directoryURL, let configuration) = older.content, older.captures.isEmpty {
            SandboxedHTMLView(entryURL: entryURL, directoryURL: directoryURL, configuration: configuration)
                .padding(28)
        } else if case .loading = older.content, older.captures.isEmpty {
            LoadingStatus(label: "Loading v\(older.revision)")
        } else if case .unavailable = older.content, older.captures.isEmpty {
            Text("v\(older.revision) can't be shown here.")
                .knockTextStyle(Theme.Typography.body13w400)
                .foregroundColor(Theme.Colors.ink2)
                .padding(28)
        } else {
            ScrollView {
                VStack(spacing: 20) {
                    switch older.content {
                    case .loading:
                        LoadingStatus(label: "Loading v\(older.revision)")
                    case .markdown(let text):
                        MarkdownView(text: text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    case .images(let images):
                        ForEach(Array(images.enumerated()), id: \.offset) { _, image in
                            olderRevisionImage(image)
                        }
                    case .web, .unavailable:
                        EmptyView()
                    }
                    ForEach(older.captures) { capture in
                        if let image = capture.image {
                            olderRevisionImage(image)
                        } else {
                            LoadingStatus(label: "Loading image")
                        }
                    }
                }
                .padding(28)
            }
        }
    }

    private func olderRevisionImage(_ image: NSImage) -> some View {
        Image(nsImage: image)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .cornerRadius(Theme.Radius.card)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.card)
                    .stroke(Theme.Stroke.card.color, lineWidth: Theme.Stroke.card.width)
            )
            .imageContextMenu(image)
    }

    /// Whether the floating canvas toolbar shows at all (HAIL-56 contract):
    /// hidden for markdown (no Interact/Comment concept applies, same gate
    /// `isMarkdown` already used for the old toggle), and while locked, only
    /// shown when Interact still has something to offer - matching the old
    /// toggle's own "hidden entirely once locked" rule, but keeping the
    /// interact-only hint visible for a locked `html_bundle` case (see
    /// `canvasToolbar`) since that hint has nowhere else to live now.
    private var showsCanvasToolbar: Bool { !Self.canvasTools(isLocked: isLocked, isMarkdown: isMarkdown, interactAvailable: interactAvailable).isEmpty }

    /// The tools the canvas toolbar offers (WAG-280: every surface that shows an artifact for an open ask,
    /// the review page, the case page's panel and full page and an own window, goes through this one
    /// rule, so Comment is on wherever the answer is not yet sent).
    static func canvasTools(isLocked: Bool, isMarkdown: Bool, interactAvailable: Bool) -> [ReviewMode] {
        guard !isMarkdown else { return [] }
        return (interactAvailable ? [.interact] : []) + (isLocked ? [] : [.comment])
    }

    /// The floating toolbar over the stage (HAIL-56 contract). The Interact tool is omitted entirely for
    /// an artifact with nothing to interact with (see `canvasTools` and the Choices ledger): the design
    /// has no disabled variant. The view itself is shared with the case page box (WAG-311).
    private var canvasToolbar: some View {
        CanvasToolbarView(
            tools: Self.canvasTools(isLocked: isLocked, isMarkdown: isMarkdown, interactAvailable: interactAvailable),
            mode: mode,
            onSelect: { target in
                if target == .interact {
                    viewModel.enterInteractMode()
                } else {
                    Task { await viewModel.enterCommentMode() }
                }
            })
    }

    /// The live prototype has no capture of its own on show: its pins draw on
    /// the page itself (HAIL-65), so the capture chip only names a still.
    private var isLivePrototype: Bool {
        switch artifactState {
        case .htmlBundle, .diagram: return true
        default: return false
        }
    }

    private var isScreenshots: Bool {
        if case .screenshots = artifactState { return true }
        return false
    }

    @ViewBuilder
    private var stage: some View {
        if isScreenshots {
            VStack(spacing: 0) {
                if isSetView {
                    ScreenshotSetView(
                        store: viewModel.commentsStore, outlinedId: stageModel.setFocusId,
                        onOpen: { openScreen(id: $0) }
                    )
                    .padding(EdgeInsets(top: 20, leading: 28, bottom: 12, trailing: 28))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    if viewModel.commentsStore.galleryScreens.count > 1 {
                        ScreenRow(
                            store: viewModel.commentsStore,
                            current: viewModel.commentsStore.currentCapture?.id,
                            onSelect: { viewModel.selectScreen(id: $0) },
                            onStep: { viewModel.stepScreen(by: $0) }
                        )
                    }
                    stageContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        } else {
            stageContent
        }
    }

    /// The live prototype (HAIL-65). Its `SandboxedHTMLView` sits at one fixed
    /// place in the tree, so switching Interact/Comment never remounts or
    /// reloads it. Comment mode only adds a layer on top: the region layer over
    /// the live page, or (only while an older capture is picked) that capture's
    /// still.
    /// Comment mode's region layer over the live page.
    private func commentLayer(revision: Int) -> some View {
        LiveCommentLayerView(
            store: viewModel.commentsStore,
            controller: viewModel.webViewCapture,
            revision: revision,
            onBeginDraft: { viewModel.beginLiveDraft(rect: $0, viewport: $1, variant: $2) },
            onSave: { viewModel.commitLiveDraftNow() },
            onJump: { viewModel.jumpToView(of: $0) }
        )
        .padding(28)
    }

    private func liveStage(entryURL: URL, directoryURL: URL, revision: Int, configuration: WKWebViewConfiguration) -> some View {
        ZStack {
            SandboxedHTMLView(
                entryURL: entryURL, directoryURL: directoryURL, configuration: configuration,
                captureController: viewModel.webViewCapture,
                zoom: prototypeZoom, magnification: prototypeZoom.storedScale,
                fragment: viewModel.pageFragment,
                anchorRequest: viewModel.anchorRequest
            )
            .padding(28)
            // Both modes draw pins at every zoom: the layer maps them through
            // the page's zoom (operator, 4 Oct).
            switch LiveStageLayer.make(mode: mode, showsStillOverLive: viewModel.showsStillOverLive) {
            case .pins:
                // HAIL-87: the pins stay on the page in Interact mode.
                LiveCommentLayerView(
                    store: viewModel.commentsStore,
                    controller: viewModel.webViewCapture,
                    revision: revision,
                    isInteractive: true,
                    onBeginDraft: { _, _, _ in },
                    onSave: {},
                    onJump: { viewModel.jumpToView(of: $0) }
                )
                .padding(28)
            case .still:
                if let image = viewModel.commentsStore.currentImage, let capture = viewModel.commentsStore.currentCapture {
                    CommentCaptureStageView(
                        image: image, store: viewModel.commentsStore,
                        captureId: capture.id, initialScrollFraction: capture.scrollFraction,
                        elementReader: { viewModel.readElementOnStill(rect: $0, captureId: $1) }
                    )
                    .padding(28)
                    .background(Theme.Colors.list)
                    .overlay(alignment: .topLeading) { backToLiveButton }
                } else {
                    commentLayer(revision: revision)
                }
            case .commentLayer:
                commentLayer(revision: revision)
            }
        }
    }

    private var backToLiveButton: some View {
        Button(action: { viewModel.commentsStore.clearSelection() }) {
            HStack(spacing: 5) {
                Image(systemName: "arrow.uturn.backward").font(.system(size: 11))
                Text("Back to the live page")
            }
            .knockTextStyle(Theme.Typography.priorRevisionLink12w500)
            .foregroundColor(Theme.Colors.ink2)
            .padding(EdgeInsets(top: 5, leading: 9, bottom: 5, trailing: 9))
            .background(Theme.Colors.side)
            .cornerRadius(Theme.Radius.chip)
        }
        .buttonStyle(.plain).pointerCursor()
        .padding(36)
    }

    /// The live web stage's entry, directory, revision and configuration, for
    /// either a prototype (`html_bundle`) or a diagram (HAIL-141) - both render
    /// through the same `liveStage`.
    private var webStage: (entryURL: URL, directoryURL: URL, revision: Int, configuration: WKWebViewConfiguration)? {
        switch artifactState {
        case .htmlBundle(let entryURL, let directoryURL, let revision, let configuration):
            return (entryURL, directoryURL, revision, configuration)
        case .diagram(let entryURL, let directoryURL, let revision, let configuration):
            return (entryURL, directoryURL, revision, configuration)
        default:
            return nil
        }
    }

    @ViewBuilder
    private var stageContent: some View {
        if let stage = webStage {
            liveStage(entryURL: stage.entryURL, directoryURL: stage.directoryURL, revision: stage.revision, configuration: stage.configuration)
        } else if compareActive, let image = viewModel.commentsStore.currentImage, let capture = viewModel.commentsStore.currentCapture,
                  let beforeRevision = compareBeforeRevision {
            CompareStageView(
                store: viewModel.commentsStore, compare: compare, stage: stageModel,
                after: capture, afterImage: image, beforeRevision: beforeRevision,
                onAfterViewport: {
                    stageModel.updateViewport(container: $0, image: $1)
                    applyEvidenceStage()
                }
            )
            .padding(imageInsets(16))
        } else if mode == .comment, let image = viewModel.commentsStore.currentImage, let capture = viewModel.commentsStore.currentCapture {
            CommentCaptureStageView(
                image: image, store: viewModel.commentsStore,
                captureId: capture.id, initialScrollFraction: capture.scrollFraction,
                zoom: showsStageControls ? stageModel.zoom : nil,
                onViewport: {
                    stageModel.updateViewport(container: $0, image: $1)
                    applyEvidenceStage()
                },
                stageModel: showsStageControls ? stageModel : nil
            )
            .padding(imageInsets(showsStageControls ? 16 : 28))
        } else {
            switch artifactState {
            case .loading:
                LoadingStatus(label: "Loading the prototype")
            case .failed(let message):
                Text(message)
                    .knockTextStyle(Theme.Typography.body13w400)
                    .foregroundColor(Theme.Colors.ink2)
                    .padding(28)
            case .screenshot(let image, _):
                ScreenshotStageView(image: image, controller: zoomController)
                    .padding(imageInsets(28))
            case .htmlBundle:
                EmptyView()
            case .htmlBundleUnavailable:
                previewUnavailableNotice
            case .diagram:
                EmptyView()
            case .markdown(_, _) where viewModel.editSession != nil:
                editorStage(viewModel.editSession!)
            case .markdown(_, _) where viewModel.comparison != nil:
                VStack(spacing: 0) {
                    MarkdownEditorView(session: viewModel.comparison!, onCancel: {})
                        .background(Theme.Colors.win)
                        .overlay(Rectangle().fill(Theme.Colors.ds).frame(width: 3), alignment: .leading)
                    editLegend
                }
            case .markdown(let text, let revision):
                markdownStage(text: text, revision: revision)
            case .screenshots:
                // Unreachable in practice: `load` always sets `mode = .comment`
                // for a screenshots case, so the branch above always handles
                // it. Kept for switch exhaustiveness and as a safe fallback.
                if let image = viewModel.commentsStore.currentImage {
                    ScreenshotStageView(image: image, controller: zoomController)
                        .padding(imageInsets(28))
                } else {
                    LoadingStatus(label: "Loading the screenshots")
                }
            }
        }
    }

    /// The padding around an image stage. While the canvas toolbar floats over the stage, the bottom edge keeps a band
    /// for it, so the toolbar never covers the bottom of the image (WAG-374).
    private func imageInsets(_ padding: CGFloat) -> EdgeInsets {
        let bottom = showsCanvasToolbar && !isSetView
            ? max(padding, CanvasToolbarView.imageBottomInset(bottomGap: Self.toolbarBottomGap)) : padding
        return EdgeInsets(top: padding, leading: padding, bottom: bottom, trailing: padding)
    }

    /// How far the canvas toolbar floats above the bottom of the stage (the filmstrip, when there is one, sits below).
    static let toolbarBottomGap: CGFloat = 20

    /// The write-up: the full text, with each change marked in place when a version before it exists (WAG-321).
    @ViewBuilder
    private func markdownStage(text: String, revision: Int) -> some View {
        let revisions = viewModel.detail?.revisions ?? []
        let artifact = ArtifactTabs.tabId(showing: revision, revisions: revisions)
        if let caseId = viewModel.detail?.case.id, let artifact {
            WriteUpChangesHost(
                caseId: caseId, artifact: artifact,
                revisions: ArtifactTabs.revisionNumbers(holding: revision, revisions: revisions),
                shown: revision, text: text, surface: "full", client: viewModel.writeUpClient, hub: changesHub
            ) { changes in
                if changes.showsInline {
                    // WAG-322: the inline changes inside the commentable text.
                    WriteUpCommentableInlineView(
                        model: changes, markdown: text, revision: revision, store: commentsStore,
                        extraComments: isLocked ? sentTextComments : [],
                        canComment: !isLocked,
                        onSelectComment: { _ in viewModel.selectTab(.comments) }
                    )
                } else {
                    commentableMarkdown(text: text, revision: revision)
                }
            }
            .id("\(artifact)@\(revision)")
        } else {
            commentableMarkdown(text: text, revision: revision)
        }
    }

    private func commentableMarkdown(text: String, revision: Int) -> some View {
        // HAIL-150: select text to comment on it. Once the answer is locked the
        // highlights stay (from the sent reply) but nothing new can be added.
        CommentableMarkdownView(
            markdown: text, revision: revision, store: commentsStore,
            extraComments: isLocked ? sentTextComments : [],
            canComment: !isLocked,
            onSelectComment: { _ in viewModel.selectTab(.comments) }
        )
    }

    private var previewUnavailableNotice: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "lock.slash")
                    .foregroundColor(Theme.Colors.accent)
                Text("HTML preview is unavailable")
                    .knockTextStyle(Theme.Typography.body13_5w400)
                    .fontWeight(.semibold)
                    .foregroundColor(Theme.Colors.accent)
            }
            Text("The isolation self-check failed at startup, so this prototype can't be shown safely. Review it from the recommendation and notes only.")
                .knockTextStyle(Theme.Typography.body12_5w400)
                .foregroundColor(Theme.Colors.ink2)
        }
        .padding(EdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 18))
        .frame(maxWidth: 420, alignment: .leading)
        .background(Theme.Colors.accentSoft)
        .cornerRadius(Theme.Radius.card)
        .padding(28)
    }
}
