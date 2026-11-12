import SwiftUI

/// The case pane / detail column (docs/design/mvp-values.md §M3 `aWM03` →
/// `BFz3X`, and the disconnected §M11 `SyfHH` → `neoem` variant).
///
/// KNOCK-08 built the read-only Needs-you queue (M3) and the offline state
/// (M11). HAIL-25 makes the options interactive and adds the artifact
/// preview card; both live in `CasePaneDetailView` below, keyed by case id
/// so their state resets when the selected case changes. "Open review" sets
/// `model.reviewRequestCaseId`, which `MainWindowView` uses to swap in the
/// KNOCK-10 review workspace (M4).
struct CasePaneView: View {
    @ObservedObject var model: AppModel
    /// The header's expand icon (HAIL-96): folds the queue and the conversation together.
    var isBothFolded = false
    var onToggleBothFolded: (() -> Void)?
    /// "Your agent is on it" while the first job runs (WAG-338), and the action behind "Try a sample instead".
    @ObservedObject var firstRun: GettingStartedModel = .inert
    var onTrySample: () -> Void = {}

    private var isOffline: Bool { model.connectionState != .connected }

    private var hasAnswered: Bool {
        FirstRunRules.hasAnswered(
            decided: firstRun.state.decided, sampleAnswered: firstRun.sampleAnswered,
            waitingCount: model.visibleWaitingCases.count, answeredCount: model.visibleAnsweredCases.count)
    }

    var body: some View {
        Group {
            if let detail = model.selectedCaseDetail {
                CasePaneDetailView(
                    model: model, detail: detail,
                    isBothFolded: isBothFolded, onToggleBothFolded: onToggleBothFolded)
                    .id(detail.case.id)
            } else if !isOffline, firstRun.sampleOpen, firstRun.sampleAvailable, model.needsYouCases.isEmpty {
                CasePaneDetailView(
                    model: model, detail: SampleRequest.detail,
                    isBothFolded: isBothFolded, onToggleBothFolded: onToggleBothFolded,
                    sample: SampleHooks(onAnswered: firstRun.answerSample, onDismiss: firstRun.dismissSample))
                    .id(SampleRequest.caseId)
            } else if !isOffline, let working = firstRun.agentOnIt {
                AgentOnItCard(working: working, sample: firstRun.sample, onTrySample: onTrySample)
            } else if !isOffline && model.needsYouCases.isEmpty {
                // Once no ask needs you: the explainer before the first answer, "All caught up" after it.
                switch FirstRunRules.pane(sampleOpen: false, hasAnswered: hasAnswered) {
                case .caughtUp: CaughtUpView(stats: model.caughtUpStats)
                case .explainer, .sample: HomeView()
                }
            } else {
                VStack {
                    Spacer()
                    Text(FirstRunRules.noSelectionLine)
                        .knockTextStyle(Theme.Typography.body13w400)
                        .foregroundColor(Theme.Colors.ink2)
                    Spacer()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.win)
    }
}

/// What the built-in sample request changes on the real request page: Decide and Dismiss act on the first-run
/// state only.
struct SampleHooks {
    let onAnswered: () -> Void
    let onDismiss: () -> Void
}

/// One selected case's toolbar, body and bottom action bar. A fresh instance
/// per case id (`CasePaneView` keys it with `.id`), so `sendFlow` - and the
/// `ComposerViewModel` it owns - never leaks a prior case's selection into a
/// newly opened one. Not `private`: `footerKind` below is a pure static
/// function tests reach via `@testable import Knock`, the same pattern
/// `ReviewWorkspaceView.rightColumnKind` uses.
struct CasePaneDetailView: View {
    @ObservedObject var model: AppModel
    let detail: CaseDetail
    @StateObject private var sendFlow: SendFlowController
    /// The decision doc's own state: the answers, the open artifact and its viewer (WAG-257).
    @StateObject private var askDoc: AskDocController
    /// WAG-280: the case's comments, so the Send count follows a pin placed on the opened artifact.
    @ObservedObject private var commentsStore: CommentsSessionStore
    /// The live artifact of the page and its tabs (WAG-276).
    @StateObject private var liveArtifact: LiveArtifactModel
    /// WAG-410: "Continue in a new session" for a case whose agent session ended. Starts only on a click.
    @StateObject private var continueSession = ContinueEvidence.makeModel()
    /// Failures hidden on the status line (C10).
    @ObservedObject private var hiddenStatus = HiddenStatusStore.shared
    /// The decision column's dragged width (task 13a).
    @ObservedObject private var paneWidths = PaneWidthStore.shared
    @Environment(\.openWindow) private var openWindow
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Identifies this pane's unsent-work check in `AppModel` (HAIL-118).
    @State private var probeId = UUID()
    /// The sources of the round on screen and their card and list (WAG-356). Not observed here: the host and
    /// the pills observe it, so a hover does not redraw the page.
    @State private var sourcesHub: SourcesHub
    @State private var askHub: AskCommentsHub
    /// Gates the Dismiss confirmation (HAIL-32); non-nil only while that
    /// dialog is on screen.
    @State private var showDismissConfirmation = false
    /// The decision column's own width, for the plan page's two columns (WAG-290).
    @State private var decisionHeight: CGFloat = 800
    @State private var decisionWidth: CGFloat = 1200
    /// The decision column's tab (C8). Every case opens on Decision: the pane is keyed by case id.
    @State private var columnTab: ReviewColumnTab
    /// Team comments unread when the case opened (opening clears the queue's mark), for the Comments tab's dot.
    @State private var unreadAtOpen: Int
    /// The Comments tab was opened on this case, so its dot is gone.
    @State private var commentsTabSeen = false
    let isBothFolded: Bool
    let onToggleBothFolded: (() -> Void)?
    /// Set only for the built-in sample request: the page is the real one, but Decide stays on this Mac.
    let sample: SampleHooks?

    private var isOffline: Bool { model.connectionState != .connected }
    /// The ask's thread, once you have replied (HAIL-71).
    private var thread: ThreadModel? {
        detail.threadModel(artifactKind: model.artifactKindByCaseId[detail.case.id])
    }
    /// The Conversation tab's messages: the thread, or the ask alone before a reply.
    private var conversation: ThreadModel {
        detail.conversationModel(artifactKind: model.artifactKindByCaseId[detail.case.id])
    }
    private var lockState: ReplyLockState { detail.case.replyLockState }
    init(
        model: AppModel, detail: CaseDetail,
        isBothFolded: Bool = false, onToggleBothFolded: (() -> Void)? = nil, sample: SampleHooks? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.model = model
        self.detail = detail
        self.sample = sample
        _commentsStore = ObservedObject(wrappedValue: model.commentsStore(forCase: detail.case.id))
        self.isBothFolded = isBothFolded
        self.onToggleBothFolded = onToggleBothFolded
        let sendFlow = SendFlowController(
            knockCase: detail.case,
            // WAG-280: the case's one comment store, shared with the opened artifact's viewer, the
            // own window and the review workspace. Send goes straight through, comments included.
            commentsStore: model.commentsStore(forCase: detail.case.id),
            coordinator: sample == nil ? model.sendCoordinator : model.sampleCoordinator,
            client: model.client,
            revisionArrival: detail.revisionArrival,
            replies: detail.replies,
            usage: sample == nil ? model.usage : nil,
            onSent: {},
            onAnswerSent: { answer in
                if let sample { sample.onAnswered() } else { model.advanceAfterSend(answeredCaseId: detail.case.id, answer: answer) }
            }
        )
        // Every `KNOCK_PANE_*` hook below targets only the case `KNOCK_OPEN_CASE`
        // named (Contract HAIL-53 fold): a case with no `KNOCK_OPEN_CASE` set
        // acts on any case, same as before. With one set, `AppModel.
        // advanceAfterSend`'s "Next ask" (this story) can open a SECOND
        // needs_you case right after the first send - a fresh
        // `CasePaneDetailView` for it, with the same process-wide env vars
        // still set, would otherwise re-select and re-send on THAT case too,
        // cascading through the whole queue instead of touching only the one
        // case evidence asked for.
        let isEvidenceHookTarget = environment["KNOCK_OPEN_CASE"] == nil || environment["KNOCK_OPEN_CASE"] == detail.case.id
        // `KNOCK_PANE_SELECT_OPTION=<option id>` (Amendments): the
        // orchestrator's evidence hook for a non-default selection, since it
        // cannot click a specific option row itself - the same pattern as
        // `KNOCK_REVIEW_MODE`.
        if isEvidenceHookTarget, let optionId = environment["KNOCK_PANE_SELECT_OPTION"],
           detail.case.options.contains(where: { $0.id == optionId }) {
            sendFlow.composer.selectOption(optionId)
            // `KNOCK_PANE_DESELECT_OPTION=1` (HAIL-43 evidence): clicks the
            // same option again, since the orchestrator cannot click a chip
            // twice itself - proves the chip clears rather than staying
            // picked.
            if environment["KNOCK_PANE_DESELECT_OPTION"] == "1" {
                sendFlow.composer.selectOption(optionId)
            }
        }
        // `KNOCK_PANE_DRAFT_TEXT=<text>` (HAIL-41 evidence): the
        // orchestrator's evidence hook for a typed reply, since it cannot
        // type into the composer's field itself - the same pattern as
        // `KNOCK_PANE_SELECT_OPTION` above.
        if isEvidenceHookTarget, let draftText = environment["KNOCK_PANE_DRAFT_TEXT"] {
            sendFlow.composer.draftText = draftText
        }
        // `KNOCK_PANE_SEND=1` (HAIL-41 evidence): the orchestrator's evidence
        // hook for the pane's own Send action (the selected option plus
        // whatever is typed) - distinct from `KNOCK_PANE_SEND_RECOMMENDATION`
        // below, which always sends the recommendation regardless of any
        // selection or typed text. One shot per run: `init` runs again on every re-render, each time with a new
        // throwaway `SendFlowController`, and the case stays needs_you until the daemon's update comes back.
        if isEvidenceHookTarget, environment["KNOCK_PANE_SEND"] == "1", detail.case.status == .needsYou,
           !Self.evidenceSendFired {
            Self.evidenceSendFired = true
            sendFlow.send()
        }
        // `KNOCK_PANE_SEND_RECOMMENDATION=1` (Amendments, HAIL-32 evidence):
        // the orchestrator's evidence hook for the M8 Sending/Sent/Delivered
        // sequence, since it cannot click "Send recommended answer" itself -
        // the same pattern as `KNOCK_PANE_SELECT_OPTION` above. Gated on
        // `detail.case.status == .needsYou`: this initializer runs again on
        // every SwiftUI re-render of this case (an unchanged `@StateObject`
        // identity, but a fresh struct init each time), and unlike selecting
        // an option, sending is not a no-op to repeat - without this guard a
        // single case.updated event from the first send retriggers another
        // send, which retriggers another event, forever.
        // The status gate alone let it fire once per re-render before the update arrived (4 replies, app check
        // 2026-11-09), so it is one shot per run too.
        if isEvidenceHookTarget, environment["KNOCK_PANE_SEND_RECOMMENDATION"] == "1", detail.case.status == .needsYou,
           !Self.evidenceSendFired {
            Self.evidenceSendFired = true
            sendFlow.acceptRecommendation()
        }
        // `KNOCK_PANE_CHANGE_ANSWER=1` (Amendments, HAIL-34 evidence): the
        // orchestrator's evidence hook for the queued "Change answer" flow,
        // since it cannot click that text button itself - the same pattern
        // as `KNOCK_PANE_SEND_RECOMMENDATION` above. Gated on `.queued`, the
        // one state the button is even shown in.
        if isEvidenceHookTarget, environment["KNOCK_PANE_CHANGE_ANSWER"] == "1", detail.case.replyLockState == .queued {
            sendFlow.beginChangingAnswer()
        }
        // `KNOCK_PANE_ASK_FOR_DETAIL=1` (HAIL-33 evidence): the orchestrator's
        // evidence hook for the inline "Ask for more detail" field, since it
        // cannot click that secondary button itself - the same pattern as
        // `KNOCK_PANE_CHANGE_ANSWER` above.
        if isEvidenceHookTarget, environment["KNOCK_PANE_ASK_FOR_DETAIL"] == "1", detail.case.replyLockState == .editable {
            sendFlow.composer.beginAskingForDetail()
        }
        // `KNOCK_PANE_ASK_MORE_DETAIL=<text>` or `format:<eli5|diagram|page>` (HAIL-147 evidence):
        // sends the detail request itself, so the delivery banner can be captured.
        if isEvidenceHookTarget, let ask = environment["KNOCK_PANE_ASK_MORE_DETAIL"], detail.case.status == .needsYou,
           !Self.evidenceMoreDetailSent {
            Self.evidenceMoreDetailSent = true
            sendFlow.composer.beginAskingForDetail()
            if ask.hasPrefix("format:") {
                sendFlow.askForMoreDetail(format: ReplyFormat(rawValue: String(ask.dropFirst(7))))
            } else {
                sendFlow.composer.fillDetailChip(ask)
                sendFlow.askForMoreDetail()
            }
        }
        // `KNOCK_PANE_TAB=conversation|comments` or `KNOCK_CONVERSATION_OPEN=1` (evidence): opens that tab on the
        // targeted case, since a capture run cannot click it.
        _columnTab = State(initialValue: isEvidenceHookTarget ? ConversationTabRouting.initialTab(environment: environment) : .question)
        _unreadAtOpen = State(initialValue: model.unreadByCaseId[detail.case.id] ?? 0)
        _sendFlow = StateObject(wrappedValue: sendFlow)
        _sourcesHub = State(initialValue: SourcesHub(book: detail.currentSourceBook, evidenceOpen: EvidenceSources.open))
        _askHub = State(initialValue: AskCommentsHub(store: model.commentsStore(forCase: detail.case.id)))
        _askDoc = StateObject(wrappedValue: AskDocController(client: model.client, usage: model.usage, request: detail.case, commentsStore: model.commentsStore(forCase: detail.case.id), store: model.askDocMemory, itemAnswers: Self.sentItemAnswers(detail)))
        _liveArtifact = StateObject(wrappedValue: LiveArtifactModel(
            caseId: detail.case.id, client: model.client, tabs: detail.artifactTabs(),
            commentsStore: model.commentsStore(forCase: detail.case.id)))
    }

    /// Re-renders re-run `init`; the evidence send must happen once.
    @MainActor private static var evidenceMoreDetailSent = false
    /// `KNOCK_PANE_SEND` / `KNOCK_PANE_SEND_RECOMMENDATION` (evidence): sent once per run, never per re-render.
    @MainActor private static var evidenceSendFired = false

    var body: some View {
        EvidenceLayoutLog.bump("body.casePane")
        return VStack(spacing: 0) {
            toolbarRow
            AskCommentsHost(hub: askHub, onExplain: { [sendFlow] in sendFlow.explain(selection: $0) }) {
            SourcesHost(hub: sourcesHub) {
                decisionColumn
                    .environment(\.roundTagInEyebrow, isPageLayout)
            }
            }
            .clipped()
            .onChange(of: isAnswerDisplayLocked, initial: true) { _, _ in askHub.sync(detail: detail, canComment: !isAnswerDisplayLocked) }
            .onChange(of: detail.replies) { _, _ in askHub.sync(detail: detail, canComment: !isAnswerDisplayLocked) }
        }
        .boundedIdealWidth()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Paused: Decide and Send are off, and one line next to them says why.
        .environment(\.pausedAnswerLine, isOffline ? PausedCopy.answerLine : nil)
        .modifier(OnScreenVariantProvider(store: commentsStore, isShowingSet: liveArtifact.selectedTab?.kind == .screenshots))
        // Files dropped on the request attach to the reply (WAG-345), until it is sent.
        .attachesDroppedFiles(to: sendFlow.composer.files, enabled: !isAnswerDisplayLocked || sendFlow.isEditingLockedAnswer)
        // A stale `.sent` from a prior send-and-cycle: the case returning to
        // needs_you (a `knock_update`, docs/protocol-mvp.md "Case and reply
        // states") means it is time to compose a fresh reply, not still show
        // the last one's outcome (docs/stories/HAIL-32.md "One state
        // source" - the footer must never show a state older than reality).
        // WAG-387: opening a shared case uploads missing rounds and fetches new comments.
        .task(id: detail.case.id) { if sample == nil { await sharing.refresh() } }
        .onChange(of: detail.case) { _, updated in
            if sample == nil { Task { await sharing.load() } }
            // An update may bring new options (HAIL-108): the composer reads the newest set.
            sendFlow.refreshCase(updated)
            askDoc.refresh(with: updated, itemAnswers: Self.sentItemAnswers(detail))
        }
        .onChange(of: detail.currentSourceBook) { _, book in sourcesHub.update(book: book) }
        .onChange(of: detail.revisions) { _, _ in
            liveArtifact.update(tabs: detail.artifactTabs())
        }
        .onChange(of: detail.planRounds) { _, _ in
            liveArtifact.update(tabs: detail.artifactTabs())
        }
        // WAG-352: the artifact follows the decision on screen.
        .onChange(of: decisionFocus) { _, focus in followDecision(focus) }
        .task { followDecision(decisionFocus) }
        .onChange(of: sendFlow.isEditingLockedAnswer) { _, editing in
            if editing { askDoc.doc?.unlock() }
        }
        .onChange(of: unhiddenStatusLine?.canHide == true) { _, failing in
            hiddenStatus.follow(caseId: detail.case.id, failing: failing)
        }
        .onChange(of: detail.case.status) { _, newStatus in
            if newStatus == .needsYou {
                sendFlow.startNewRound()
            }
        }
        .background(
            EscapeKeyCatcher(
                shouldHandle: { window in
                    HomeLink.escapeGoesHome(
                        isVisible: showsHomeLink, textInputFocused: HomeLink.textInputHasFocus(in: window),
                        holdsUnsentWork: model.holdsUnsentWork,
                        dialogOpen: showDismissConfirmation || window?.attachedSheet != nil || askDoc.open != nil || sourcesHub.isOpen, isBothFolded: isBothFolded)
                },
                onEscape: model.goHome)
        )
        .background(
            CaseScreenKeyCatcher { delta, window in
                guard CaseScreenKeys.flips(
                    isFlippable: liveArtifact.isFlippable(liveArtifact.selectedTab), allowsScreenKeys: liveArtifact.allowsScreenKeys,
                    textInputFocused: HomeLink.textInputHasFocus(in: window), fullSizeOpen: askDoc.open != nil,
                    sheetOpen: showDismissConfirmation || window?.attachedSheet != nil) else { return false }
                liveArtifact.stepScreen(by: delta)
                return true
            }
        )
        .background(
            Button("Toggle conversation") { toggleConversation() }
                .keyboardShortcut(SplitFoldShortcuts.ask)
                .opacity(0)
        )
        .onAppear {
            startRequestedChangeAnswer()
            model.registerUnsentWorkProbe(id: probeId) { [weak sendFlow] in sendFlow?.hasUnsentWork ?? false }
        }
        .onDisappear { model.unregisterUnsentWorkProbe(id: probeId) }
        .task { await runUsageEvidenceSteps() }
        .task {
            guard let delay = ContinueEvidence.clickDelay else { return }
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            continueInNewSession()
        }
        .task {
            // `KNOCK_EVIDENCE_OPEN_REVIEW=1` (HAIL-150): opens the review workspace once, as a click would.
            guard ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_OPEN_REVIEW"] == "1" else { return }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            openReview()
        }
        .onChange(of: model.changeAnswerRequestCaseId) { _, _ in startRequestedChangeAnswer() }
        .onChange(of: detail.case.replyLockState) { _, _ in startRequestedChangeAnswer() }
        .confirmationDialog(
            "Dismiss this decision?",
            isPresented: $showDismissConfirmation
        ) {
            Button("Dismiss", role: .destructive) {
                if let sample { sample.onDismiss() } else { Task { await model.dismiss(caseId: detail.case.id) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The agent is waiting on \"\(detail.case.title)\". Dismissing it now sends back \"The human dismissed this ask without answering.\"")
        }
    }

    /// The decision on screen of a request with several decisions, for the artifact box. `nil` otherwise.
    private var decisionFocus: DecisionFocus? {
        askDoc.doc.flatMap { DecisionFocus.make(case: detail.case, doc: $0) }
    }

    private func followDecision(_ focus: DecisionFocus?) {
        guard let focus else { return }
        Task { await liveArtifact.follow(decision: focus) }
    }

    /// `KNOCK_EVIDENCE_USAGE=open,full,pick:2,send` (HAIL-83 evidence hook, same
    /// style as the other `KNOCK_PANE_*` ones): runs those steps once on the
    /// case `KNOCK_OPEN_CASE` names, since a capture run cannot click. `open` is a queue click; `full`
    /// records the preview's "Open full size" without switching screens; `pick:N`
    /// is the number key N; `send` is the composer's Send.
    private func runUsageEvidenceSteps() async {
        let env = ProcessInfo.processInfo.environment
        guard let steps = env["KNOCK_EVIDENCE_USAGE"], env["KNOCK_OPEN_CASE"] == detail.case.id else { return }
        for step in steps.split(separator: ",") {
            if step == "open" {
                await model.open(caseId: detail.case.id, source: .queue)
            } else if step == "full" {
                for _ in 0..<60 where model.artifactKindByCaseId[detail.case.id] == nil {
                    try? await Task.sleep(for: .milliseconds(50))
                }
                model.recordPreviewOpen(
                    .artifactOpenedFull, caseId: detail.case.id, artifactKind: model.artifactKindByCaseId[detail.case.id])
            } else if step.hasPrefix("pick:"), let n = Int(step.dropFirst(5)) {
                sendFlow.composer.selectOption(atPosition: n)
            } else if step == "send", detail.case.status == .needsYou {
                sendFlow.send()
            }
            try? await Task.sleep(for: .milliseconds(300))
        }
    }

    /// The toast's "Change answer" (HAIL-79): once this pane shows the answered
    /// case with a queued reply, starts the same flow as the footer's button.
    /// A reply that is no longer queued drops the request.
    private func startRequestedChangeAnswer() {
        guard model.changeAnswerRequestCaseId == detail.case.id else { return }
        switch lockState {
        case .queued:
            if !sendFlow.isEditingLockedAnswer { sendFlow.beginChangingAnswer() }
            model.clearChangeAnswerRequest()
        case .delivered, .failed:
            model.clearChangeAnswerRequest()
        case .editable:
            break
        }
    }

    /// The page's one layout at the pane's width (C1): artifact beside the column, folded to the pinned bar, or no artifact.
    private var pageLayout: AskLayout.Layout {
        AskLayout.layout(width: decisionWidth, hasArtifact: detail.case.hasArtifact, preferred: paneWidths.decisionColumnWidth)
    }

    /// The artifact beside the column. An artifact opened in the page's own panel or full page takes its place.
    private var showsArtifactBeside: Bool { pageLayout == .beside && askDoc.open == nil }

    /// The column's content edges, as the case map mockup's `.cs` (18 at each side): every tab's scroll keeps inside
    /// them. The tabs keep 14 (`.tabs`), the answer area 14 (`.ans`).
    private var columnLeadingInset: CGFloat { Theme.AskDoc.Column.scrollInset.leading }
    static let columnTrailingInset: CGFloat = Theme.AskDoc.Column.scrollInset.trailing
    /// The answer area's side edge outside the prompt bar's own padding, so its content sits 14 in (`.ans`).
    private static let answerSideInset = max(0, Theme.AskDoc.Column.answerSideInset - PromptBarLogic.barPadding)

    /// The pane below the top bar: the artifact and the decision column, or an artifact opened full page.
    private var decisionColumn: some View {
        VStack(spacing: 0) {
            if let open = askDoc.open, open.placement == .fullPage {
                ArtifactFullPageView(controller: askDoc, open: open, isLocked: isAnswerDisplayLocked)
                answerDock(inColumn: false)
                footer
            } else {
                if showsArtifactBeside {
                    AskColumnsLayout(preferredColumnWidth: paneWidths.decisionColumnWidth) {
                        DecisionArtifactView(
                            model: liveArtifact, composer: sendFlow.composer, caseKind: detail.case.kind, client: model.client,
                            onOpen: { openReview(.artifactOpenedFull) }, onInteract: { recordPreviewInteraction() },
                            fillsHeight: true, onOpenWindow: openTabInWindow, onOpenBrowser: openTabInBrowser,
                            canComment: !isAnswerDisplayLocked, followsComposer: askDoc.doc?.isStepped != true)
                            .coachMarkAnchor(.artifact)
                            .padding(Theme.AskDoc.Chrome.artInset)
                            .frame(maxWidth: .infinity)
                        // `.col`: a 1 pt line on its left, white.
                        askColumn
                            .frame(maxWidth: .infinity)
                            .background(Theme.Colors.win)
                            .overlay(alignment: .leading) { Rectangle().fill(Theme.Colors.line).frame(width: 1) }
                            // Task 13a: the line moves by drag; the hit area is centred on it.
                            .overlay(alignment: .leading) {
                                PaneBorderHandle(
                                    border: .decisionColumn, store: paneWidths,
                                    limit: AskLayout.dragLimit(width: decisionWidth))
                                    .offset(x: 0.5 - PaneBorderHandle.hitWidth / 2)
                            }
                    }
                } else {
                    HStack(spacing: 0) {
                        // The column is the page: centred, at most `AskLayout.pageMaxWidth` wide.
                        askColumn
                            .frame(maxWidth: AskLayout.pageMaxWidth)
                            .frame(maxWidth: .infinity)
                        if let open = askDoc.open, open.placement == .beside {
                            ArtifactPanelView(controller: askDoc, open: open, isLocked: isAnswerDisplayLocked)
                                .onChange(of: askDoc.doc?.step) { _, _ in followStepInPanel() }
                                .transition(reduceMotion ? .identity : .move(edge: .trailing))
                        }
                    }
                    .clipped()
                    // The panel slides in over 220 ms, ease-out; with Reduce Motion it just appears.
                    .animation(
                        reduceMotion ? nil : .easeOut(duration: Theme.AskDoc.Metrics.panelSlide),
                        value: askDoc.open?.placement == .beside)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { EvidenceLayoutLog.event("case.decisionWidth", "old=\(decisionWidth) new=\($0)"); decisionWidth = $0 }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { EvidenceLayoutLog.event("case.decisionHeight", "old=\(decisionHeight) new=\($0)"); decisionHeight = $0 }
        // The answer box grows to 40 % of the pane's column (C6).
        .environment(\.answerBoxAvailableHeight, decisionHeight)
    }

    /// The decision column (C1): the pinned artifact bar when the artifact is folded, the latest agent message and
    /// the tabs (C8), then the tab's scroll (Decision: the question, the need and the options, once), and the answer
    /// box and send row pinned at the bottom.
    private var askColumn: some View {
        VStack(spacing: 0) {
            if !showsArtifactBeside, detail.case.hasArtifact { pinnedArtifactBar }
            // The tabs first (`.tabs`, margin 10 14 0). The context line (C2, C10) is the first thing in the
            // Decision tab's scroll, as in the mockup; the other tabs keep the status under the tabs. A failure stays
            // under the tabs in every tab, so the red line never scrolls away (spec §2, §8).
            DecisionColumnHeader(
                thread: thread, caseId: detail.case.id, tab: columnTab, commentCount: commentsStore.model.comments.count,
                decisionHeadsWithLatest: decisionHeadsWithLatest,
                commentsDot: CommentsDot.shows(
                    unreadAtOpen: unreadAtOpen, lateNew: sharing.lateComments.new, seen: commentsTabSeen, tab: columnTab),
                onSelect: selectTab)
                .padding(Theme.AskDoc.Column.tabsInset)
            if let line = statusLine, columnTab != .question || Self.pinsStatus(line) {
                statusLineView(line)
                    .padding(EdgeInsets(top: 12, leading: columnLeadingInset, bottom: 0, trailing: Self.columnTrailingInset))
            }
            switch columnTab {
            case .question:
                scrollBody
            case .conversation:
                conversationTab
            case .comments:
                commentsTab
            }
            // The scroll gives way first, so the answer box and Send stay on screen at any window height. The box
            // keeps to the column's content edges, as the option rows above it do.
            VStack(spacing: 0) {
                answerDock(inColumn: true)
                footer
            }
            .padding(EdgeInsets(top: 0, leading: Self.answerSideInset, bottom: 0, trailing: Self.answerSideInset))
            .layoutPriority(1)
        }
    }

    /// The header icon and ⌘] (C8): open the Conversation tab; a second press goes back to Decision.
    private func toggleConversation() {
        selectTab(ConversationTabRouting.toggled(columnTab))
    }

    private func selectTab(_ tab: ReviewColumnTab) {
        if tab == .comments { commentsTabSeen = true }
        columnTab = tab
    }

    /// The Decision tab already heads with the agent's newest message (a progress note or a message-only update),
    /// so the line above the tabs would repeat it.
    private var decisionHeadsWithLatest: Bool {
        detail.case.workingNoteText != nil || detail.case.messageOnlyUpdate != nil
    }

    /// The Conversation tab (C8): earlier requests on top, then the messages and the turn line.
    private var conversationTab: some View {
        let conversation = conversation
        return ConversationTabView(
            model: conversation,
            turn: detail.threadTurn(
                conversation, delivery: model.deliveryStatusByCaseId[detail.case.id],
                settled: AnswerGrouping.settled(
                    detail.case, allCases: model.needsYouCases + model.waitingOnAgentCases, now: model.now)),
            earlier: earlierAsks,
            onOpenCase: { id in Task { await model.open(caseId: id, source: .queue) } },
            onSeeInReview: detail.case.hasArtifact ? { openReviewOnPriorRevision() } : nil,
            leadingPadding: columnLeadingInset, trailingPadding: Self.columnTrailingInset)
    }

    /// The Comments tab (C8, task 8): late team comments, "N comments on vN · view vN", and the comment cards.
    /// Show on a card highlights its pin in the artifact box.
    private var commentsTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                // WAG-401: late team comments on a decided shared case. It shows nothing when there are none.
                LateCommentsBarView(
                    sharing: sharing, item: detail.case, onChangeAnswer: sendFlow.beginChangingAnswer,
                    sendPrompt: LateCommentsSend.toSession(client: model.client, item: detail.case),
                    showsChangeAnswer: lockState == .queued && !sendFlow.isEditingLockedAnswer)
                if let arrival = detail.revisionArrival, arrival.priorCommentCount > 0 {
                    PriorRevisionCommentsLink(arrival: arrival, action: openReviewOnPriorRevision)
                }
                ArtifactCommentsSection(
                    model: liveArtifact, store: commentsStore, sharing: sharing,
                    onOpenFullSize: { openReview(.artifactOpenedFull, revision: liveArtifact.selectedTab?.revision) })
            }
            .padding(EdgeInsets(
                top: Theme.AskDoc.Column.scrollInset.top, leading: columnLeadingInset, bottom: 20, trailing: Self.columnTrailingInset))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: .infinity)
    }

    /// Which footer to show, as a pure function of state (docs/stories/
    /// HAIL-34.md fold, gap 1: "the queued state and Change answer apply to
    /// the pane AND the review workspace, for every ask kind") -
    /// unit-testable without hosting the view.
    enum FooterKind: Equatable {
        case composer
        case confirmedOutcome
        case changeAnswerBar
        /// Review-kind only, queued and not yet being edited in the pane: the
        /// same Sent line + Change answer the question kind shows, plus
        /// "Open review" as a secondary action (HAIL-41: "Change answer" now
        /// puts the pane itself into edit mode - `.composer` - rather than
        /// only opening the workspace; "Open review" stays reachable for
        /// pins/Comment mode).
        case reviewChangeAnswerBar
        case openReviewBar
    }

    static func footerKind(
        kind: Case.Kind, lockState: ReplyLockState, isEditingLockedAnswer: Bool, hasConfirmedOutcome: Bool
    ) -> FooterKind {
        // Checked before the kind split (HAIL-41): a review ask being edited
        // via "Change answer" now composes in the pane too, exactly like a
        // question ask - previously this pane never reached `.composer` for
        // a review ask at all, so "Change answer" had to hand off to the
        // workspace instead.
        if isEditingLockedAnswer { return .composer }
        if hasConfirmedOutcome {
            return kind == .review ? .openReviewBar : .confirmedOutcome
        }
        if lockState == .queued {
            return kind == .review ? .reviewChangeAnswerBar : .changeAnswerBar
        }
        // Editable and unanswered (HAIL-41): a review ask now gets the same
        // composer a question ask gets, not just an "Open review" bar - the
        // operator can pick an option and reply right here.
        return .composer
    }

    private var footerKind: FooterKind {
        Self.footerKind(
            kind: detail.case.kind, lockState: lockState,
            isEditingLockedAnswer: sendFlow.isEditingLockedAnswer,
            hasConfirmedOutcome: model.deliveryStatusByCaseId[detail.case.id] != nil
        )
    }

    /// The answer box of a reply-only ask. Once the answer is sent, the status line (C10) says where it is and
    /// holds its buttons (Change answer, Open review, Retry), so the bottom of the column stays empty: no second
    /// banner, no answer box on a done ask.
    private var showsAnswerBox: Bool {
        !detail.case.isDone && sendFlow.deliveryState.state == .idle && (footerKind == .composer || lockState == .editable)
    }

    @ViewBuilder
    private var footer: some View {
        // An options case carries its reply field in `answerDock`'s `ComposerCardView`; a free-text case (no
        // options) has no card above, so it gets the standalone footer.
        if showsAnswerBox, AskBarMode.forCase(detail.case) == .reply {
            composerFooter
        }
    }

    private var composerFooter: some View {
        ComposerFooterView(
            composer: sendFlow.composer,
            sendFlow: sendFlow,
            deliveryState: sendFlow.deliveryState,
            commentCount: commentsStore.model.comments.count,
            placeholder: PromptBarLogic.placeholder(for: .reply, hasRevision: detail.revisionArrival != nil),
            // Review-kind only (HAIL-41): the pane's own escape hatch to the
            // full review workspace for pins and Comment mode, which the
            // pane itself never offers (Non-goal). A question ask has no
            // workspace to open, so this stays nil for it.
            onOpenReview: detail.case.kind == .review ? { openReview() } : nil,
            showsStatus: false
        )
        .disabled(isOffline)
    }

    private func requestDismiss() {
        if let sample {
            sample.onDismiss()
        } else if detail.case.needsDismissConfirmation {
            showDismissConfirmation = true
        } else {
            Task { await model.dismiss(caseId: detail.case.id) }
        }
    }

    /// The page header. The conversation icon is part of it (WAG-299), so it spans the whole width.
    private var toolbarRow: some View {
        toolbar.fixedSize(horizontal: false, vertical: true)
    }

    /// "← Home" shows for a case that is not in Needs you (HAIL-119).
    private var showsHomeLink: Bool { HomeLink.isVisible(caseId: detail.case.id, needsYou: model.needsYouCases) }

    /// The crumbs line. The project name opens the project page (WAG-260); the session title gives way first.
    private var breadcrumb: some View {
        TopBarCrumb(
            task: detail.task, sessionTitle: model.sessionTitle(for: detail.case),
            onOpenProject: { model.openProjectPage(detail.task.project) })
    }

    /// The case's sharing state (WAG-387).
    private var sharing: SharingModel { SharingModels.model(for: detail.case.id, client: model.client) }

    /// Mockup B: with no artifact the page has no top bar line and no crumb; the crumb and the times move into the
    /// eyebrow over the title (`PageEyebrow`). With an artifact the bar is the case map's `.top`.
    private var isPageLayout: Bool { pageLayout == .page }

    /// The header meta split for the bar (case map `.top`): "arrived 15:24" in the line, "Waiting 7m" as the pill.
    private var topBarMeta: TopBarMeta { TopBarMeta(detail.headerMetaLabel(now: model.now)) }

    private var toolbar: some View {
        HStack(spacing: Theme.AskDoc.Chrome.topBarGap) {
            if showsHomeLink {
                HStack(spacing: 6) { HomeLinkButton(action: model.goHome) }
            }
            if sample != nil {
                Text(FirstRunRules.sampleToolbarLine)
                    .knockTextStyle(Theme.AskDoc.Chrome.crumb)
                    .foregroundColor(Theme.Colors.ink3)
                    .lineLimit(1)
                    .accessibilityIdentifier("sample-toolbar-line")
            } else if !isPageLayout {
                // "Waggle / Request page UI cleanup · arrived 15:24" (`.top`, mono 11.5, the project in ink).
                HStack(spacing: 0) {
                    breadcrumb
                    // "Arrived 21:14 · answered 21:30 · took 16m" (docs/stories/HAIL-34.md 21:38): the opened ask's
                    // own header meta, ticking every minute off `model.now` while still pending.
                    Text(" · \(topBarMeta.line)")
                        .knockTextStyle(Theme.AskDoc.Chrome.crumb)
                        .foregroundColor(Theme.Colors.ink3)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: Theme.AskDoc.Chrome.rightGap) {
                if let waiting = topBarMeta.waiting { TopBarPill(text: waiting) }
                if sample == nil {
                    ShareCaseButton(
                        model: sharing,
                        onViewComments: AppModel.canOpenReview(kind: detail.case.kind, hasArtifact: detail.case.hasArtifact)
                            ? { model.openReviewOnComments(caseId: detail.case.id) } : nil)
                }
                FoldIconButton(
                    symbol: BothFoldedCopy.symbol(isBothFolded: isBothFolded), isActive: isBothFolded,
                    help: BothFoldedCopy.help(isBothFolded: isBothFolded), action: { onToggleBothFolded?() })
                // Share, fold both, then ⋯ last (C2).
                Menu {
                    Button("Dismiss", role: .destructive, action: requestDismiss)
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: Theme.AskDoc.Chrome.iconSize - 1))
                        .foregroundColor(Theme.Colors.ink3)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
        }
        .padding(.horizontal, Theme.AskDoc.Chrome.topBarSide)
        .frame(height: isPageLayout ? Theme.AskDoc.Chrome.pageTopBarHeight : Theme.AskDoc.Chrome.topBarHeight)
        .overlay(alignment: .bottom) {
            if !isPageLayout { Rectangle().fill(Theme.Colors.line).frame(height: 1) }
        }
    }

    /// WAG-410: starts a new session with the question, the options and the answer (the sent one, else the open draft).
    private func continueInNewSession() {
        let composer = sendFlow.composer
        let draft = ContinuePrompt.draftAnswer(
            options: liveCase.options, selectedIds: composer.selectedOptionIds, note: composer.draftText)
        let item = liveCase
        let failedReplyId = detail.replies.last { $0.state == .failed }?.id
        Task {
            await continueSession.start(item: item, answer: draft) { try await model.client.sessionsList() }
            // WAG-410: the new session has the answer, so the failed reply is handed over.
            if continueSession.phase == .started { await model.handOverFailedReply(caseId: item.id, failedReplyId: failedReplyId) }
        }
    }

    /// The case with the session fields the lists keep fresh (WAG-258).
    private var liveCase: Case { model.listedCase(id: detail.case.id) ?? detail.case }

    /// The status line (C10, spec section 8): one line in the context line, with a button only when there is
    /// something to do. It replaces the done strip, the agent status strip, the session-closed notice and the
    /// delivery banners; each button calls what the old one did.
    private var statusLine: RequestStatus.Line? {
        guard let line = unhiddenStatusLine else { return nil }
        if line.canHide, hiddenStatus.isHidden(HiddenStatusStore.key(caseId: detail.case.id, line: line)) { return nil }
        return line
    }

    /// The status line before the person's hidden failures are taken out.
    private var unhiddenStatusLine: RequestStatus.Line? {
        let delivery = model.deliveryStatusByCaseId[detail.case.id]
        let agent = AgentStatus.forCase(liveCase, deliveryStatus: delivery)
        let line = RequestStatus.line(RequestStatus.Input(
            item: liveCase, confirmed: delivery, local: sendFlow.deliveryState.state,
            isEditingLockedAnswer: sendFlow.isEditingLockedAnswer,
            settled: AnswerGrouping.settled(
                detail.case, allCases: model.needsYouCases + model.waitingOnAgentCases,
                deliveredAt: Self.readAt(delivery), now: model.now),
            pickup: PickupFallback.kind(for: liveCase, now: model.now),
            since: AgentStatus.timerStart(detail.case, status: agent, deliveryStatus: delivery),
            readAt: Self.readAt(delivery) ?? detail.case.latestReplyDeliveredAtDate,
            wokeAfterNudge: Nudge.wokeUp(item: liveCase, record: model.nudgeRecords[detail.case.id])))
        return line
    }

    /// A failure is pinned under the tabs, out of the Decision tab's scroll.
    static func pinsStatus(_ line: RequestStatus.Line) -> Bool { line.tone == .failed }

    /// The context line with the status in it, unless the status is pinned under the tabs.
    private var statusContextLine: some View {
        let line = statusLine.flatMap { Self.pinsStatus($0) ? nil : $0 }
        return RequestContextLine(
            item: detail.case, client: model.client, planRounds: detail.planRounds ?? [],
            status: line?.text,
            statusView: line.map { AnyView(statusLineView($0)) },
            onOpenCase: { id in Task { await model.open(caseId: id, source: .queue) } })
    }

    private func statusLineView(_ line: RequestStatus.Line) -> some View {
        RequestStatusLineView(
            line: line, item: liveCase, continueSession: continueSession,
            onAction: { performStatus($0) },
            onHide: { hiddenStatus.hide(HiddenStatusStore.key(caseId: detail.case.id, line: line)) })
    }

    /// A status line button: the same call the old banner, strip or bar made.
    private func performStatus(_ action: RequestStatus.Action) {
        switch action {
        case .retry:
            hiddenStatus.showAgain(caseId: detail.case.id)
            switch sendFlow.deliveryState.state {
            case .offline, .refused, .failed:
                Task { await sendFlow.retryDelivery() }
            default:
                Task { await model.retryDelivery(caseId: detail.case.id) }
            }
        case .copyAnswer:
            ClaudeCheck.copyReply(for: liveCase)
        case .viewReview, .openReview:
            openReview()
        case .changeAnswer:
            sendFlow.beginChangingAnswer()
        case .continueInNewSession:
            continueInNewSession()
        case .gotIt:
            Task { await model.dismiss(caseId: detail.case.id) }
        case .openFollowUp(let id):
            Task { await model.open(caseId: id, source: .queue) }
        }
    }

    private static func readAt(_ delivery: DeliveryState?) -> Date? {
        if case .delivered(let at)? = delivery { return at }
        return nil
    }

    private var scrollBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Mockup B `.ctx`: "SAMPLE BLOG · IMAGE HOSTING · ROUND 2 · 15:00", 10 over the title, when there is
                // no artifact and so no crumb in the top bar.
                if isPageLayout {
                    PageEyebrow(
                        task: detail.task, sessionTitle: model.sessionTitle(for: detail.case),
                        meta: topBarMeta.eyebrowTimes,
                        onOpenProject: { model.openProjectPage(detail.task.project) })
                        .padding(.bottom, Theme.AskDoc.Chrome.eyebrowGap)
                }
                // The mockup's order: the latest agent message (`.latest`), the follow-up line (`.fu`), the status,
                // the plan track (`.track`); each keeps its own gap under it.
                DecisionLatestMessage(
                    thread: thread, tab: columnTab, decisionHeadsWithLatest: decisionHeadsWithLatest,
                    onOpen: { selectTab(.conversation) })
                statusContextLine
                scrollSections
            }
            .padding(EdgeInsets(
                top: Theme.AskDoc.Column.scrollInset.top, leading: columnLeadingInset, bottom: 20, trailing: Self.columnTrailingInset))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .coordinateSpace(name: StickyHeader.space)
        // Explicit, not left to the ScrollView's own ideal size (docs/
        // stories/HAIL-36.md layout bug: the delivered banner + "If it needs
        // more from you..." line above this ScrollView, in the same VStack,
        // once overlapped the RECOMMENDED block at short window heights) -
        // without this the ScrollView can hug its own content height instead
        // of claiming exactly the space left after `toolbar`/`deliveryOutcome`/
        // `footer`, the standard ScrollView-in-VStack sizing gotcha.
        .frame(maxHeight: .infinity)
    }

    /// The Decision tab under the context lines: the title, the need (14 under it, `.need`), the options.
    private var scrollSections: some View {
            VStack(alignment: .leading, spacing: Theme.AskDoc.Column.needGap) {
                // A done note heads the page in full size; the old decision folds under it (WAG-333).
                // A folded earlier round keeps its pick card: its options are not offered again in the column.
                if let note = DoneNote.message(for: detail.case) {
                    AskTitleView(heading: nil, title: note, width: headerWidth)
                    EarlierDecisionFold(title: PreviousAnswer.foldTitle(detail.case, fallback: "Earlier decision")) {
                        pageDecision(showsPick: true)
                    }
                } else if let note = detail.case.workingNoteText {
                    // A progress note heads the page; the round it follows folds (WAG-377).
                    WorkingNoteLine(note: note)
                    EarlierDecisionFold(title: PreviousAnswer.foldTitle(detail.case, fallback: "Earlier round")) {
                        pageDecision(showsPick: true)
                    }
                } else if let update = detail.case.messageOnlyUpdate?.fullText(from: detail.messages, after: detail.case.latestReplyAtDate) {
                    LatestMessageNote(note: update, width: headerWidth)
                    if update.staysLive {
                        // A talk reply or a question keeps the round live: the message sits above it (WAG-393).
                        pageDecision(showsPick: false)
                    } else {
                        // A message-only update heads the page; the round it answers folds (WAG-337).
                        EarlierDecisionFold(title: PreviousAnswer.foldTitle(detail.case, fallback: "Earlier round")) {
                            pageDecision(showsPick: true)
                        }
                    }
                } else {
                    pageDecision(showsPick: false)
                    // WAG-343: new options replaced the questions; the questions fold as the earlier round.
                    if detail.case.questionsReplacedByLaterRound {
                        EarlierDecisionFold(title: "Earlier round") { earlierQuestions }
                    }
                }
                // The options, once, in the column above the answer box (C1, C3): they scroll with the page, so
                // the pinned bottom holds only the answer box and the send row.
                if showsOptionsInColumn { optionsInColumn }
                // The team's comments are in the Comments tab; one line here opens it (WAG-397, as full size).
                TeamCountLine(model: sharing) { selectTab(.comments) }
                // A typed answer with no options shows here, where the options would be.
                if detail.case.options.isEmpty, isAnswerDisplayLocked,
                   !(detail.case.latestReplyMessage ?? "").isEmpty || !sentFiles.isEmpty {
                    answerMessageCard(detail.case.latestReplyMessage ?? "")
                }
            }
    }

    /// `showsPick`: the pick card of a simple decision, for a round folded under a note, whose options the column
    /// does not list again. A live round lists its options once, in the column (C1), and shows no card.
    @ViewBuilder
    private func pageDecision(showsPick: Bool) -> some View {
        if let doc = askDoc.doc, doc.isStepped {
            steppedBody(doc)
        } else {
            documentBody(showsPick: showsPick)
        }
    }

    /// The ask as one page: its title, the need and, for an ask with questions, a section per question.
    @ViewBuilder
    private func documentBody(showsPick: Bool) -> some View {
        // `h1`: 10 under the title.
        VStack(alignment: .leading, spacing: Theme.AskDoc.Column.titleGap) {
            AskTitleView(heading: detail.case.roundHeading, title: detail.case.title, width: headerWidth)
                .coachMarkAnchor(.round)

            // The stage sits in the context line; a "Section n of N:" the stage says is dropped from the need (WAG-294).
            NeedCalloutView(
                need: detail.case.displayNeed(planRounds: detail.planRounds),
                why: detail.case.currentWhy,
                labelAbove: detail.case.plan.map { PlanText.progressLabel($0.stage) })
        }

        // The pick of a folded earlier round, under the need box (WAG-293).
        if showsPick, askDoc.doc == nil, AskBarMode.forCase(detail.case) == .decide {
            DecisionPickBlockView(
                composer: sendFlow.composer, isLocked: isAnswerDisplayLocked,
                yourAnswerOptionId: detail.case.latestReplyChoice, columns: !showsArtifactBeside)
        }

        // Between the recommended block and the option rows (WAG-356). A round with no sources adds nothing.
        SourcesButtonSlot()

        if let instruction = detail.case.roundHeading?.instruction {
            RoundInstructionView(text: instruction)
        }

        // An ask with questions: a section per question. The options of a simple ask follow the page in the
        // column (`optionsInColumn`), once.
        if let doc = askDoc.doc {
            questionSections(doc)
        }
    }

    /// A decision with several questions, one step at a time (WAG-287): the step bar, then the usual page
    /// of that question, or the summary on the last step.
    @ViewBuilder
    private func steppedBody(_ doc: QuestionsDocModel) -> some View {
        let binding = Binding(get: { askDoc.doc ?? doc }, set: { askDoc.doc = $0 })
        VStack(alignment: .leading, spacing: Theme.AskDoc.Column.needGap) {
            // `.steps`: 8 under the step bar; `h1`: 10 under the title.
            StepBarView(doc: binding)
                .padding(.bottom, 8 - Theme.AskDoc.Column.needGap)
            if let question = doc.currentQuestion {
                VStack(alignment: .leading, spacing: Theme.AskDoc.Column.titleGap) {
                    // The group title is in the step's tooltip (C2); the step title is the question, once.
                    SourcedText(
                        text: question.title, style: headerWidth.titleStyle, color: Theme.Colors.ink,
                        target: AskCommentTarget(.question, itemId: question.id), weight: .semibold)
                        .textSelection(.enabled)
                    // Every step shows the need of the request with its own step label (WAG-334), so a later
                    // step is never an empty page. Its pick or recommendation card follows in `questionStep`.
                    NeedCalloutView(need: detail.case.need, why: detail.case.why, labelAbove: doc.sectionLabel(of: question))
                }
                questionStep(question, doc: binding)
                // The step's points in the column, above the answer box (C1); the bar keeps Back, Next and Send.
                StepPointsInColumn(
                    question: question, doc: binding, sendFlow: sendFlow, composer: sendFlow.composer,
                    deliveryState: sendFlow.deliveryState, isLocked: isAnswerDisplayLocked)
                SourcesButtonSlot()
            } else {
                Text("Send your \(doc.questions.count) decisions?")
                    .knockTextStyle(headerWidth.titleStyle)
                    .foregroundColor(Theme.Colors.ink)
                    .fixedSize(horizontal: false, vertical: true)
                ReviewStepView(doc: binding)
            }
        }
        .id(doc.step)
        .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(x: 6)))
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: doc.step)
    }

    private func questionStep(_ question: Question, doc: Binding<QuestionsDocModel>) -> some View {
        let revision = detail.revisions.map(\.n).max() ?? 1
        return QuestionSectionView(
            question: question, doc: doc, cards: [],
            selectedCardId: askDoc.open.flatMap { $0.questionId == question.id ? $0.card.id : nil },
            lastTarget: askDoc.lastTarget,
            onOpen: { card, target in openArtifact(card, question: question.id, target: target) },
            showsHeader: false, showsPoints: !DecisionDock.optionsInDock(.step), showsPicks: true)
    }

    /// The folded artifact: a bar at the top of the column that stays on screen (C1).
    private var pinnedArtifactBar: some View {
        PinnedArtifactBar(
            model: liveArtifact, composer: sendFlow.composer, followsComposer: askDoc.doc?.isStepped != true,
            onOpen: { openReview(.artifactOpenedFull, revision: liveArtifact.selectedTab?.revision) })
            .coachMarkAnchor(.artifact)
    }

    private func recordPreviewInteraction() {
        model.recordPreviewInteraction(
            caseId: detail.case.id, artifactKind: model.artifactKindByCaseId[detail.case.id])
    }

    /// The title is the decision column's `h1` in every layout: the page with no artifact is the same column, only
    /// wider (decision 2026-11-10: the case map mockup sets the sizes).
    /// Mockup B: the page with no artifact has the large title (600 28/1.15) under the eyebrow.
    private var headerWidth: AskHeaderWidth { isPageLayout ? .wide : .narrow }

    /// "N earlier requests ▾" at the top of the Conversation tab (C8).
    private var earlierAsks: EarlierAsksModel {
        EarlierAsksModel.make(item: detail.case, cases: model.needsYouCases + model.waitingOnAgentCases, now: model.now)
    }

    /// The questions of round 0 after a later round replaced them: read-only, no answers bar.
    private var earlierQuestions: some View {
        let doc = QuestionsDocModel(request: detail.case, itemAnswers: [])
        return VStack(alignment: .leading, spacing: 34) {
            ForEach(doc.questions) { question in
                QuestionSectionView(
                    question: question, doc: .constant(doc), cards: [], selectedCardId: nil,
                    lastTarget: { askDoc.lastTarget(fullSize: $0) }, onOpen: { _, _ in })
                    .padding(.top, 8)
                    .allowsHitTesting(false)
                    // The earlier round is a record: no option is «On screen».
                    .environment(\.onScreenVariant, nil)
            }
        }
    }

    private func questionSections(_ doc: QuestionsDocModel) -> some View {
        let revision = detail.revisions.map(\.n).max() ?? 1
        let binding = Binding(get: { askDoc.doc ?? doc }, set: { askDoc.doc = $0 })
        return VStack(alignment: .leading, spacing: 34) {
            ForEach(doc.questions) { question in
                QuestionSectionView(
                    question: question, doc: binding, cards: [],
                    selectedCardId: askDoc.open.flatMap { $0.questionId == question.id ? $0.card.id : nil },
                    lastTarget: { askDoc.lastTarget(fullSize: $0) },
                    onOpen: { card, target in openArtifact(card, question: question.id, target: target) })
                    .padding(.top, 8)
                    .overlay(Rectangle().fill(Theme.Colors.line).frame(height: 1), alignment: .top)
            }
        }
        .padding(.top, 6)
    }

    /// The side panel shows the question of the current step. The review step leaves it as it is.
    private func followStepInPanel() {
        guard let doc = askDoc.doc, let question = doc.currentQuestion, let open = askDoc.open, open.placement == .beside,
              open.questionId != question.id else { return }
        let revision = detail.revisions.map(\.n).max() ?? 1
        let card = ArtifactCardModel.cards(for: detail.case, revision: revision, question: question).first ?? open.card
        askDoc.retarget(card: card, questionId: question.id)
    }

    /// A card's Open: this page or its panel, or outside it (a window, the browser).
    private func openArtifact(_ card: ArtifactCardModel, question: String?, target: ArtifactOpenTarget) {
        guard let external = askDoc.choose(target, card: card, questionId: question) else {
            Task { await askDoc.ensureLoaded(detail: detail, revision: card.revision) }
            return
        }
        let fragment = askDoc.fragment(for: question)
        switch external {
        case .fullSize:
            openReview(.artifactOpenedFull)
        case .ownWindow:
            openWindow(id: ArtifactWindowRequest.sceneID, value: ArtifactWindowRequest(
                caseId: detail.case.id, fragment: fragment, title: "\(card.name) · \(detail.case.title)"))
        case .browser:
            Task { await openInBrowser(revision: card.revision, fragment: fragment) }
        }
    }

    /// The artifact box's Open menu (WAG-291): the tab on show opens in a window of its own.
    private func openTabInWindow(_ tab: ArtifactTab) {
        openWindow(id: ArtifactWindowRequest.sceneID, value: ArtifactWindowRequest(
            caseId: detail.case.id, fragment: nil, title: "\(tab.title) · \(detail.case.title)", revision: tab.revision))
    }

    private func openTabInBrowser(_ tab: ArtifactTab) {
        Task { await openInBrowser(revision: tab.revision, fragment: nil) }
    }

    /// "In the browser": the staged bundle behind a sandboxed page (`BrowserWrapper`), in the default browser.
    private func openInBrowser(revision: Int, fragment: String?) async {
        guard let found = try? await model.client.artifactPath(caseId: detail.case.id, revision: revision),
              found.kind == .htmlBundle else { return }
        let entry = URL(fileURLWithPath: found.entry).resolvingSymlinksInPath()
        guard let page = try? BrowserWrapper.write(
            entry: entry, root: URL(fileURLWithPath: found.root), fragment: fragment, title: detail.case.title, caseId: detail.case.id, name: "\(detail.case.id)-v\(revision)")
        else { return }
        NSWorkspace.shared.open(page)
    }

    /// The item answers of the newest Decide reply, for a sent request with items to show (WAG-315).
    static func sentItemAnswers(_ detail: CaseDetail) -> [ItemAnswer] {
        detail.replies.last { $0.itemAnswers?.isEmpty == false && $0.outcome != .talk }?.itemAnswers ?? []
    }

    /// Whether the column lists the options of a simple decision. A done note's closed decision does not offer
    /// them again (WAG-333).
    private var showsOptionsInColumn: Bool {
        AskBarMode.forCase(detail.case) == .decide && DoneNote.message(for: detail.case) == nil
    }

    /// The options of a simple decision, once, in the column's scroll (C1, C3): the same rows, keys and headers as
    /// the old dock, which now holds only the answer box and the send row (`answerDock`).
    private var optionsInColumn: some View {
        composerCard(part: .optionsOnly, optionsCap: nil)
            .coachMarkAnchor(.options)
    }

    /// The pinned bottom of the column: the answer box and the send row. `inColumn` false is the artifact's own
    /// full page, which has no column: its bar keeps the options too, capped, as before.
    @ViewBuilder
    private func answerDock(inColumn: Bool) -> some View {
        switch AskBarMode.forCase(detail.case) {
        case .reply:
            EmptyView()
        case .answers:
            // Hidden once the answers are sent: the status line (C10) then says where they are.
            if askDoc.doc != nil, !isAnswerDisplayLocked, sendFlow.deliveryState.state == .idle {
                AnswersBarView(
                    doc: Binding(get: { askDoc.doc ?? QuestionsDocModel(request: detail.case, itemAnswers: Self.sentItemAnswers(detail)) }, set: { askDoc.doc = $0 }),
                    sendFlow: sendFlow, deliveryState: sendFlow.deliveryState, isChanging: sendFlow.isEditingLockedAnswer,
                    maxPointsHeight: DecisionDock.cap(.step, windowHeight: decisionHeight) ?? DecisionDock.minCap,
                    pointsInColumn: inColumn)
                    .disabled(isOffline)
            }
        case .decide where DoneNote.message(for: detail.case) != nil:
            // The done note heads the page; the closed decision's rows are not offered again (WAG-333).
            EmptyView()
        case .decide:
            if inColumn {
                // Once sent, the status line holds what the answer box showed (C10); a done ask has none.
                if showsAnswerBox { composerCard(part: .replyOnly, optionsCap: nil) }
            } else {
                composerCard(part: .whole, optionsCap: Self.maxOptionsHeight)
                    .coachMarkAnchor(.options)
            }
        }
    }

    /// The unified composer card (docs/stories/HAIL-54.md). The column uses it twice: its option rows in the
    /// scroll (`.optionsOnly`) and its answer box and send row pinned at the bottom (`.replyOnly`).
    private func composerCard(part: ComposerCardView.Part, optionsCap: CGFloat?) -> some View {
        ComposerCardView(
            composer: sendFlow.composer,
            sendFlow: sendFlow,
            deliveryState: sendFlow.deliveryState,
            recommendationId: detail.case.recommendation,
            commentCount: commentsStore.model.comments.count,
            placeholder: PromptBarLogic.placeholder(for: .decide, hasRevision: detail.revisionArrival != nil),
            isLocked: isAnswerDisplayLocked,
            yourAnswerOptionId: detail.case.latestReplyChoice,
            yourAnswerOptionIds: Set(detail.case.latestReplyChoices),
            lockedMessage: detail.case.latestReplyMessage,
            lockedAttachments: sentFiles,
            onOpenReview: detail.case.kind == .review ? { openReview() } : nil,
            maxOptionsHeight: optionsCap,
            showsFullOptions: true,
            fullLabelOnlyWhenSelected: detail.case.plan != nil,
            showsStatus: false,
            part: part
        )
        .disabled(isOffline)
    }

    /// The artifact's full page keeps the options in its bar: the open calm card plus two one-line rows; more
    /// scroll inside it.
    static let maxOptionsHeight: CGFloat = 420

    /// Whether this ask's options/answer read as locked (docs/stories/
    /// HAIL-34.md operator report 21:11): the ask has a reply for this round
    /// and "Change answer" has not put `sendFlow` back into edit mode.
    /// Shared by `optionsList` (dims every option but the one actually sent)
    /// and the "Your answer" message card below it.
    private var isAnswerDisplayLocked: Bool { lockState != .editable && !sendFlow.isEditingLockedAnswer }

    /// The locked answer's own "Your answer" card (docs/stories/HAIL-36.md):
    /// under the options, showing the typed message that went with the
    /// reply - alone when no option was chosen, alongside the chosen
    /// option's own "Your answer" tag when one was. Full text, wraps, never
    /// truncated - the same card recipe as the RECOMMENDED block above it.
    /// The files the person sent with the latest reply (WAG-345).
    private var sentFiles: [ReplyAttachment] {
        detail.replies.first { $0.id == detail.case.latestReplyId }?.attachments ?? []
    }

    private func answerMessageCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("YOUR ANSWER")
                .knockTextStyle(Theme.Typography.labelCaps10_5w600)
                .foregroundColor(Theme.Colors.ink3)
            if !message.isEmpty {
                Text(message)
                    .knockTextStyle(Theme.Typography.value13_5w600)
                    .foregroundColor(Theme.Colors.ink)
            }
            SentAttachmentsView(files: sentFiles).padding(.top, message.isEmpty ? 2 : 4)
        }
        .padding(EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.side)
        .cornerRadius(Theme.Radius.recommendedBlock)
    }

    private func openReviewOnPriorRevision() {
        model.recordPreviewOpen(
            .reviewOpened, caseId: detail.case.id, artifactKind: model.artifactKindByCaseId[detail.case.id])
        sendFlow.composer.focusDraftOnOpen = true
        model.activateSelectionOnPriorRevision()
    }

    /// `event` says which control opened it: the preview card's "Open full
    /// size" (`artifactOpenedFull`) or "Open review" (`reviewOpened`, HAIL-83).
    private func openReview(_ event: UsageEvent = .reviewOpened, revision: Int? = nil) {
        model.recordPreviewOpen(
            event, caseId: detail.case.id, artifactKind: model.artifactKindByCaseId[detail.case.id])
        sendFlow.composer.focusDraftOnOpen = true
        // Comment in the case box leaves its page here (WAG-347); a plain Open full size leaves nothing.
        model.activateSelection(commentHandoff: liveArtifact.takeCommentHandoff(), revision: revision ?? liveArtifact.fullSizeRevision)
    }
}
