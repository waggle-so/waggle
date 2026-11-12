import SwiftUI

/// The review workspace (docs/design/mvp-values.md §M4 `MYn95`, §M10
/// `y0wuNs`, §M6 `Ea8Gs`): titlebar, the artifact viewer, and the 430pt
/// right column - the ask, its comments, or (once Send is pressed with
/// comments pinned) the review-before-send summary. Opened from the
/// Needs-you case pane's "Open review" action; the back chevron returns
/// there, as does a successful send (docs/protocol-mvp.md: the case moves to
/// `waiting_on_agent`, which the queue reflects once back there).
struct ReviewWorkspaceView: View {
    let detail: CaseDetail
    /// `AppModel.now`, ticking once a minute, so the titlebar's idle chip
    /// stays current (see `ReviewTitlebarView`).
    let now: Date
    let onBack: () -> Void
    /// `AppModel.retryDelivery(caseId:)` (docs/stories/HAIL-34.md: "Failed:
    /// banner with Retry, same as the pane"): the pane's own failed banner
    /// already reads `AppModel.deliveryStatusByCaseId`, the persisted
    /// outcome, rather than this workspace's own `sendFlow.deliveryState` -
    /// which starts fresh, `.idle`, every time this view is built, and so
    /// never itself knows about a failure from an earlier session. Routing
    /// through the same model method keeps both Retry actions consistent.
    let onRetryDelivery: () -> Void
    /// O4's coach-mark completion by action (docs/stories/HAIL-29.md
    /// contract: "entering Comment mode completes 3, pressing Send
    /// completes 4"). `nil` outside onboarding - every other caller of this
    /// view passes neither.
    var onEnteredCommentMode: (() -> Void)?
    var onSendPerformed: (() -> Void)?
    /// Opens the earlier ask a follow-up's header links to (HAIL-33
    /// amendment) - a no-op default so every pre-HAIL-33 call site (and
    /// test) keeps compiling unchanged.
    var onOpenCase: (String) -> Void = { _ in }
    /// `AppModel.advanceAfterSend` (Contract "Next ask"): the review window
    /// "closes back to the list after sending" via `onSent`/`onBack` first,
    /// then this selects the next ask in the now-visible pane - a no-op
    /// default so every pre-HAIL-53 call site (and test) keeps compiling
    /// unchanged.
    var onAnswerSent: (String) -> Void = { _ in }
    /// Opens on the version before the latest (HAIL-71, the conversation's
    /// "see in review" link).
    var opensOnPriorRevision = false
    /// WAG-347: Comment in the case box opened this view, so it starts in Comment mode on the box's page.
    var commentHandoff: CommentHandoff?
    /// WAG-352: full size opens on this revision (the tab the case box showed for its decision), else the newest.
    var opensOnRevision: Int?
    /// WAG-397: an unread mark or a comment notification opened this view: start on the Comments tab.
    var opensOnComments = false
    /// Non-nil when this view is the one-page layout of a visual ask (HAIL-84): the artifact
    /// stage and the question column sit beside the queue, with fold controls in the header
    /// and no back chevron. `nil` is the full-window review, kept for markdown asks.
    let fold: SplitFoldState?
    /// `AppModel.deliveryStatusByCaseId[case]`: the live event view of the delivery, which can
    /// know about a pickup before the case row does (the "You picked" card's status).
    var deliveryStatus: DeliveryState? = nil
    /// The session line and earlier asks above RECOMMENDED (HAIL-102).
    var sessionContext: SessionContextBlock? = nil
    /// The session title for the titlebar crumb (WAG-302), and the menu of earlier asks (WAG-276).
    var sessionTitle: String? = nil
    var earlierAsks: EarlierAsksModel? = nil
    /// Non-nil when the ask is answered long ago (HAIL-104): the card shows a settled line.
    var settled: AnswerGrouping.Settled? = nil
    /// Where this view's unsent-work check is registered, so a new ask never moves the
    /// selection away from a comment being written (HAIL-118).
    var unsentWorkRegistry: AppModel? = nil
    /// Non-nil when the ask is not in Needs you: "← Home" and Esc call it (HAIL-121).
    var onHome: (() -> Void)? = nil
    @State private var probeId = UUID()
    @Environment(\.openWindow) private var openWindow
    private let client: KnockClient
    @StateObject private var viewModel: ReviewViewModel
    @StateObject private var sendFlow: SendFlowController
    /// The answers of an ask with questions (WAG-305); shared with the case pane through `askDocMemory`.
    @StateObject private var askDoc: AskDocController
    /// The sources of the round: the card and the list over the question column (WAG-356).
    @State private var sourcesHub: SourcesHub
    @State private var askHub: AskCommentsHub
    /// The question column's width, for the header segment above it (HAIL-91).
    @State private var askColumnWidth: CGFloat = AskLayout.columnWidth
    /// The width of the artifact and the column together, for the column's width rule (C9).
    @State private var stageWidth: CGFloat = 1440

    init(
        detail: CaseDetail, now: Date, client: KnockClient, sendCoordinator: SendCoordinator,
        onBack: @escaping () -> Void, onRetryDelivery: @escaping () -> Void,
        onEnteredCommentMode: (() -> Void)? = nil, onSendPerformed: (() -> Void)? = nil,
        onOpenCase: @escaping (String) -> Void = { _ in },
        onAnswerSent: @escaping (String) -> Void = { _ in },
        opensOnPriorRevision: Bool = false,
        commentHandoff: CommentHandoff? = nil,
        opensOnRevision: Int? = nil,
        opensOnComments: Bool = false,
        usage: UsageReporter? = nil,
        unsentWorkRegistry: AppModel? = nil,
        fold: SplitFoldState? = nil,
        onHome: (() -> Void)? = nil,
        deliveryStatus: DeliveryState? = nil,
        sessionContext: SessionContextBlock? = nil,
        settled: AnswerGrouping.Settled? = nil,
        sessionTitle: String? = nil,
        earlierAsks: EarlierAsksModel? = nil,
        commentsStore: CommentsSessionStore = CommentsSessionStore(),
        askDocMemory: AskDocMemory? = nil
    ) {
        self.sessionTitle = sessionTitle
        self.earlierAsks = earlierAsks
        self.unsentWorkRegistry = unsentWorkRegistry
        self.sessionContext = sessionContext
        self.settled = settled
        self.fold = fold
        self.onHome = onHome
        self.deliveryStatus = deliveryStatus
        self.detail = detail
        self.now = now
        self.client = client
        self.onBack = onBack
        self.onRetryDelivery = onRetryDelivery
        self.onEnteredCommentMode = onEnteredCommentMode
        self.onSendPerformed = onSendPerformed
        self.onOpenCase = onOpenCase
        self.onAnswerSent = onAnswerSent
        self.opensOnPriorRevision = opensOnPriorRevision
        self.commentHandoff = commentHandoff
        self.opensOnRevision = opensOnRevision
        self.opensOnComments = opensOnComments
        let viewModel = ReviewViewModel(client: client, usage: usage, commentsStore: commentsStore)
        _viewModel = StateObject(wrappedValue: viewModel)
        _sourcesHub = State(initialValue: SourcesHub(book: detail.currentSourceBook, evidenceOpen: EvidenceSources.open))
        _askHub = State(initialValue: AskCommentsHub(store: commentsStore))
        _askDoc = StateObject(wrappedValue: AskDocController(
            client: client, usage: usage, request: detail.case, commentsStore: viewModel.commentsStore, store: askDocMemory))
        let sendFlow = SendFlowController(
            knockCase: detail.case,
            commentsStore: viewModel.commentsStore,
            coordinator: sendCoordinator,
            client: client,
            revisionArrival: detail.revisionArrival,
            replies: detail.replies,
            usage: usage,
            // On the one page there is nothing to close after a send: the next ask takes over.
            onSent: fold == nil ? onBack : {},
            onAnswerSent: onAnswerSent
        )
        // `KNOCK_REVIEW_CHANGE_ANSWER=1` (Amendments, HAIL-34 evidence): the
        // orchestrator's evidence hook for the review workspace's own
        // "Change answer" (`AnsweredAskColumnView`), since it cannot click
        // that text button itself - the same pattern as the pane's
        // `KNOCK_PANE_CHANGE_ANSWER` (`CasePaneDetailView.init`). Gated on
        // `.queued`, the one state the button is even shown in.
        if ProcessInfo.processInfo.environment["KNOCK_REVIEW_CHANGE_ANSWER"] == "1",
           detail.case.replyLockState == .queued {
            sendFlow.beginChangingAnswer()
        }
        // `KNOCK_PANE_ASK_FOR_DETAIL=1` (HAIL-107 evidence): opens the detail rows here too.
        if ProcessInfo.processInfo.environment["KNOCK_PANE_ASK_FOR_DETAIL"] == "1",
           detail.case.replyLockState == .editable {
            sendFlow.composer.beginAskingForDetail()
        }
        // HAIL-168: the person's saved edit goes out with the reply.
        viewModel.onDocumentEdited = { [weak sendFlow] revision in
            guard let base = revision.baseRevision else { return }
            sendFlow?.attachEdit(.init(revision: revision.n, baseRevision: base, passagesChanged: revision.passagesChanged ?? 0))
        }
        _sendFlow = StateObject(wrappedValue: sendFlow)
    }

    var body: some View {
        Group {
            if let fold {
                SplitFoldObserver(fold: fold) { splitLayout($0) }
            } else {
                VStack(spacing: 0) {
                    ReviewTitlebarView(
                        knockCase: detail.case, task: detail.task, sessionTitle: sessionTitle, now: now,
                        changedAt: detail.latestReplyChangedAtDate, roundArrivedAt: detail.roundArrivedAtDate, onBack: onBack,
                        shareControl: AnyView(ShareCaseButton(model: sharing, onViewComments: { viewModel.selectTab(ShareSheetLogic.viewTab) }))
                    )
                    HStack(spacing: 0) {
                        ArtifactViewerView(
                            viewModel: viewModel, isLocked: isAnswerLocked,
                            onOpenWindow: openTabInWindow, onOpenBrowser: openTabInBrowser)
                        rightColumn
                            .frame(width: columnWidth)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { stageWidth = $0 }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.win)
        .overlay(alignment: .bottom) { CommentUndoLineView(store: viewModel.commentsStore) }
        .modifier(OnScreenVariantProvider(store: viewModel.commentsStore))
        .onAppear {
            unsentWorkRegistry?.registerUnsentWorkProbe(id: probeId) { [weak sendFlow, weak viewModel] in
                (sendFlow?.hasUnsentWork ?? false) || (viewModel?.editSession?.hasChanges ?? false)
            }
        }
        .onDisappear { unsentWorkRegistry?.unregisterUnsentWorkProbe(id: probeId) }
        .onChange(of: detail.case) { _, updated in
            askDoc.refresh(with: updated)
            Task { await sharing.load() }
        }
        // WAG-387: opening a shared case uploads missing rounds and fetches new comments.
        .task(id: detail.case.id) { await sharing.refresh() }
        // WAG-381: the artifact follows the decision on screen, as the case box does.
        .onChange(of: decisionFocus) { _, focus in followDecision(focus) }
        .task(id: detail.case.id) {
            viewModel.commentHandoff = commentHandoff
            await viewModel.load(detail: detail, revision: opensOnRevision)
            // Opened from the box: the box already put the tab on show (`opensOnRevision`). Else start on the decision.
            if opensOnRevision == nil { followDecision(decisionFocus) }
            if opensOnComments { viewModel.selectTab(.comments) }
            // `KNOCK_EVIDENCE_OLDER_REVISION=1` (HAIL-142 evidence hook): opens "See v<n-1>".
            if opensOnPriorRevision || ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_OLDER_REVISION"] == "1" {
                viewModel.viewOlderRevision()
            }
            // `KNOCK_EVIDENCE_FULL_TAB=<n>` (WAG-309 evidence hook): switches the full-size view to the
            // n-th artifact tab (1-based), as a click on the tab strip does.
            if let n = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_FULL_TAB"].flatMap(Int.init) {
                let tabs = detail.artifactTabs()
                if tabs.indices.contains(n - 1) { await viewModel.show(revision: tabs[n - 1].revision) }
            }
            // `KNOCK_EVIDENCE_PLAN_SEE=<revision>` (HAIL-156 evidence hook): opens that round's artifact
            // read-only, as "See v<n>" in the answered history does.
            if let see = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_PLAN_SEE"].flatMap(Int.init) {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                viewModel.viewRevision(see)
            }
            // `KNOCK_EVIDENCE_MULTI_CAPTURE=send` (HAIL-35 fold evidence: the
            // "You're sending" step must summarize every capture with
            // comments, not only the selected one): after the multi-capture
            // hook above leaves two commented captures in `commentsStore`,
            // press Send the same way ⌘↵ does - the orchestrator has no
            // click for that button either.
            if ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_MULTI_CAPTURE"] == "send" {
                sendFlow.send()
            }
            // `KNOCK_EVIDENCE_SCREENSHOTS_COMMENTS=send` (HAIL-40 evidence):
            // same idea, for the two screen comments `ReviewViewModel.
            // placeEvidenceScreenshotsCommentsIfNeeded` just placed.
            if ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_SCREENSHOTS_COMMENTS"] == "send" {
                sendFlow.send()
            }
        }
        .background(
            Group {
                if fold == nil {
                    Button("Back", action: onBack)
                        .keyboardShortcut(.escape, modifiers: [])
                        .disabled(viewModel.editSession != nil)
                }
            }
            .opacity(0)
        )
        // A new revision on the open ask shows at once (HAIL-114).
        .onChange(of: detail.revisions.map(\.n).max()) { _, _ in
            Task { await viewModel.refresh(detail: detail) }
        }
        // An update with no new artifact still moves the stale-artifact line (HAIL-146).
        .onChange(of: detail.staleArtifactNote) { _, _ in
            Task { await viewModel.refresh(detail: detail) }
        }
        .onChange(of: viewModel.mode) { _, mode in
            if mode == .comment { onEnteredCommentMode?() }
        }
        .onChange(of: detail.case) { _, updated in sendFlow.refreshCase(updated) }
        .onChange(of: detail.case.status) { _, newStatus in
            if newStatus == .needsYou { sendFlow.startNewRound() }
        }
        .onChange(of: sendFlow.isSending) { _, isSending in
            if isSending { onSendPerformed?() }
        }
    }

    /// The column's width (C9): 440 pt, narrower when the artifact would get under 60 % of the window.
    private var columnWidth: CGFloat { AskLayout.fullSizeColumnWidth(window: stageWidth) }

    /// The case's sharing state (WAG-387): the header button and the team's comments read the same model.
    private var sharing: SharingModel { SharingModels.model(for: detail.case.id, client: client) }

    /// The decision on screen of a request with several decisions, for the artifact viewer. `nil` otherwise.
    private var decisionFocus: DecisionFocus? {
        askDoc.doc.flatMap { DecisionFocus.make(case: detail.case, doc: $0) }
    }

    private func followDecision(_ focus: DecisionFocus?) {
        guard let focus else { return }
        Task { await viewModel.follow(decision: focus) }
    }

    /// The one page (HAIL-84): header, the artifact stage, and the question column or the slim
    /// strip it folds into. The expand icon folds both sides to their rails (HAIL-96).
    private func splitLayout(_ fold: SplitFoldState) -> some View {
        VStack(spacing: 0) {
            SplitFoldHeaderView(
                fold: fold, knockCase: detail.case, task: detail.task, sessionTitle: sessionTitle, now: now,
                changedAt: detail.latestReplyChangedAtDate, roundArrivedAt: detail.roundArrivedAtDate, askColumnWidth: askColumnWidth, onHome: onHome,
                shareControl: AnyView(ShareCaseButton(model: sharing, onViewComments: { viewModel.selectTab(ShareSheetLogic.viewTab) })))
            HStack(spacing: 0) {
                ArtifactViewerView(
                            viewModel: viewModel, isLocked: isAnswerLocked,
                            onOpenWindow: openTabInWindow, onOpenBrowser: openTabInBrowser)
                if !fold.isAskFolded {
                    rightColumn
                        .frame(width: columnWidth)
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { askColumnWidth = $0 }
                } else {
                    AskFoldedStripView(label: AskStripCopy.label(for: detail.case), onUnfold: fold.toggleAsk)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { stageWidth = $0 }
        }
        .background(
            EscapeKeyCatcher(
                shouldHandle: { window in
                    HomeLink.escapeGoesHome(
                        isVisible: onHome != nil, textInputFocused: HomeLink.textInputHasFocus(in: window),
                        holdsUnsentWork: unsentWorkRegistry?.holdsUnsentWork ?? sendFlow.hasUnsentWork,
                        dialogOpen: window?.attachedSheet != nil || sourcesHub.isOpen, isBothFolded: fold.isBothFolded)
                },
                onEscape: { onHome?() })
        )
        .background(
            Group {
                Button("Toggle queue", action: fold.toggleQueue)
                    .keyboardShortcut(SplitFoldShortcuts.queue)
                Button("Toggle decision", action: fold.toggleAsk)
                    .keyboardShortcut(SplitFoldShortcuts.ask)
                Button("Fold both sides", action: fold.toggleBothFolded)
                    .keyboardShortcut(SplitFoldShortcuts.bothFolded)
                Button("Show both sides", action: fold.exitBothFolded)
                    .keyboardShortcut(SplitFoldShortcuts.leaveBothFolded)
                    .disabled(!fold.isBothFolded)
            }
            .opacity(0)
        )
    }

    /// The toolbar's Open menu (WAG-309): the artifact on show in a window of its own.
    private func openTabInWindow(_ tab: ArtifactTab) {
        openWindow(id: ArtifactWindowRequest.sceneID, value: ArtifactWindowRequest(
            caseId: detail.case.id, fragment: nil, title: "\(tab.title) · \(detail.case.title)", revision: tab.revision))
    }

    /// The same page behind a sandboxed wrapper, in the default browser (a page only).
    private func openTabInBrowser(_ tab: ArtifactTab) {
        Task {
            guard let found = try? await client.artifactPath(caseId: detail.case.id, revision: tab.revision),
                  found.kind == .htmlBundle else { return }
            let entry = URL(fileURLWithPath: found.entry).resolvingSymlinksInPath()
            guard let page = try? BrowserWrapper.write(
                entry: entry, root: URL(fileURLWithPath: found.root), fragment: nil, title: detail.case.title,
                caseId: detail.case.id, name: "\(detail.case.id)-v\(tab.revision)")
            else { return }
            NSWorkspace.shared.open(page)
        }
    }

    /// Whether the artifact viewer's Interact|Comment toggle should hide its
    /// Comment option (docs/stories/HAIL-34.md fold: "delivered review
    /// workspace still shows the Interact | Comment switch ... Comment mode
    /// is off"). Same condition `rightColumnKind` uses to route to
    /// `.askWithStatus` - Comment mode is unreachable there either way, but
    /// the switch itself lives in `ArtifactViewerView`, outside `rightColumn`,
    /// so it needs its own copy of this check. A `static func`, not a private
    /// `var`, so it is unit-testable the same way `rightColumnKind` is.
    static func isAnswerLocked(lockState: ReplyLockState, isEditingLockedAnswer: Bool) -> Bool {
        lockState != .editable && !isEditingLockedAnswer
    }

    private var isAnswerLocked: Bool {
        Self.isAnswerLocked(lockState: detail.case.replyLockState, isEditingLockedAnswer: sendFlow.isEditingLockedAnswer)
    }

    @ViewBuilder
    private var rightColumn: some View {
        switch Self.rightColumnKind(
            lockState: detail.case.replyLockState,
            isEditingLockedAnswer: sendFlow.isEditingLockedAnswer,
            tab: viewModel.tab
        ) {
        case .askWithStatus:
            askColumn(sentCard: sentCard)
        case .comments:
            CommentsColumnView(
                store: viewModel.commentsStore, composer: sendFlow.composer, sendFlow: sendFlow,
                shared: sharing,
                tab: viewModel.tab, onSelectTab: { viewModel.selectTab($0) },
                context: viewModel.commentViewContext, onShow: { viewModel.showComment($0) },
                thread: detail.threadModel(artifactKind: nil), caseId: detail.case.id
            )
        case .interact:
            askColumn(sentCard: nil)
        }
    }

    /// WAG-401: the bar for late team comments on a decided shared case.
    private var lateBar: AnyView {
        AnyView(LateCommentsBarView(
            sharing: sharing, item: detail.case, onChangeAnswer: sendFlow.beginChangingAnswer,
            sendPrompt: LateCommentsSend.toSession(client: client, item: detail.case), showsChangeAnswer: false))
    }

    /// The one page's answer area after Send: the "You picked" card, or the failed status line (C10) with
    /// its Retry. Never a second status beside it.
    private var sentCard: AnyView {
        if detail.case.replyLockState == .failed,
           let line = RequestStatus.line(RequestStatus.Input(item: detail.case, confirmed: deliveryStatus)) {
            return AnyView(RequestStatusLineView(
                line: line.keeping(only: [.retry, .copyAnswer]), item: detail.case, onAction: performStatus))
        }
        return AnyView(
            SentAnswerCardView(
                item: detail.case, reply: detail.replies.first { $0.id == detail.case.latestReplyId }, delivery: deliveryStatus, settled: settled,
                onChangeAnswer: sendFlow.beginChangingAnswer, onOpenCase: onOpenCase, lateBar: lateBar))
    }

    /// A status line button in full size: Retry, Copy answer, Open the follow-up (the rest have no place here).
    private func performStatus(_ action: RequestStatus.Action) {
        switch action {
        case .retry: onRetryDelivery()
        case .copyAnswer: ClaudeCheck.copyReply(for: detail.case)
        case .changeAnswer: sendFlow.beginChangingAnswer()
        case .openFollowUp(let id): onOpenCase(id)
        case .viewReview, .openReview, .continueInNewSession, .gotIt: break
        }
    }

    private func askColumn(sentCard: AnyView?) -> some View {
        AskCommentsHost(hub: askHub, onExplain: { [sendFlow] in sendFlow.explain(selection: $0) }) { SourcesHost(hub: sourcesHub) { askColumnBody(sentCard: sentCard) } }
            .onChange(of: isAnswerLocked, initial: true) { _, _ in askHub.sync(detail: detail, canComment: !isAnswerLocked) }
            .onChange(of: detail.replies) { _, _ in askHub.sync(detail: detail, canComment: !isAnswerLocked) }
            .onChange(of: detail.currentSourceBook) { _, book in sourcesHub.update(book: book) }
    }

    private func askColumnBody(sentCard: AnyView?) -> some View {
        AskColumnView(
                knockCase: detail.case,
                planRounds: detail.planRounds,
                messages: detail.messages,
                composer: sendFlow.composer,
                sendFlow: sendFlow,
                commentCount: viewModel.commentsStore.model.comments.count,
                captureCount: viewModel.commentsStore.commentedCaptures.count,
                revisionArrival: viewModel.revisionArrival,
                now: now,
                thread: detail.threadModel(artifactKind: nil).map { ($0, detail.threadTurn($0, settled: settled)) },
                conversation: { let c = detail.conversationModel(); return (c, detail.threadTurn(c, settled: settled)) }(),
                onViewPriorRevision: { viewModel.viewOlderRevision() },
                onSeePlanRevision: { viewModel.viewRevision($0) },
                viewingRevision: viewModel.olderRevisionDisplay?.revision,
                onShowComments: { viewModel.showExistingComments() },
                client: client,
                onOpenCase: onOpenCase,
                sessionContext: sessionContext,
                tab: viewModel.tab,
                onSelectTab: { viewModel.selectTab($0) },
                sentCard: sentCard,
                earlierAsks: earlierAsks,
                askDoc: askDoc,
                shared: sharing
        )
    }

    /// Which right column to show, as a pure function of state (docs/stories/
    /// HAIL-34.md operator report 21:37: "the review workspace ignores the
    /// delivery state ... Open review still opens a live composer") -
    /// unit-testable without hosting the view. Once the answer is locked
    /// (`Case.replyLockState != .editable`, and "Change answer" has not put
    /// `sendFlow` back into edit mode) the column is `.askWithStatus`, the same
    /// view the case pane shows after Decide: the question stays, with its tabs,
    /// and the answer box is the status card ("YOU PICKED", Applied). It takes
    /// priority over `tab`. The full window and the one page share it.
    enum RightColumnKind: Equatable {
        /// Answer sent: the question stays, the answer box is the status card.
        case askWithStatus
        case comments
        case interact
    }

    static func rightColumnKind(
        lockState: ReplyLockState, isEditingLockedAnswer: Bool, tab: ReviewColumnTab
    ) -> RightColumnKind {
        if lockState != .editable && !isEditingLockedAnswer { return .askWithStatus }
        return tab == .comments ? .comments : .interact
    }
}

/// Redraws `content` when the fold state changes; `ReviewWorkspaceView` holds the fold as an
/// optional, which `@ObservedObject` cannot wrap.
private struct SplitFoldObserver<Content: View>: View {
    @ObservedObject var fold: SplitFoldState
    let content: (SplitFoldState) -> Content

    var body: some View { content(fold) }
}
