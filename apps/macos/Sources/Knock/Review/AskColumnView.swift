import SwiftUI

/// The review workspace's right column (docs/design/mvp-values.md §M4
/// `MYn95` → `O2LGd`, fixed width 430pt): the ask — title, the context card,
/// need and why, and the decision card (HAIL-107) — plus the docked answer box
/// (docs/design/mvp-values.md §M7 panels A/B).
struct AskColumnView: View {
    let knockCase: Case
    /// The rounds of a plan ask (HAIL-151); `nil` for any other ask.
    var planRounds: [PlanRound]? = nil
    /// The case's messages, for the agent's full text (WAG-393); the case row holds a cut preview.
    var messages: [Message] = []
    @ObservedObject var composer: ComposerViewModel
    @ObservedObject var sendFlow: SendFlowController
    let commentCount: Int
    /// How many captures this session's comments are spread across (HAIL-35
    /// contract: "N comments on M captures · Show"). `0` when `commentCount`
    /// is `0` — the summary line never shows either way.
    var captureCount: Int = 0
    /// Non-nil for a case whose latest revision just arrived (docs/design/
    /// mvp-values.md §M9): adds the agent's Thread message and the
    /// prior-revision link under the need box, and the composer's placeholder.
    var revisionArrival: RevisionArrival? = nil
    /// `AppModel.now`, for the Thread message's relative timestamp.
    var now: Date = Date()
    /// The ask's thread (HAIL-68), the same one the pane shows. It carries the
    /// agent's update in full, so the M9 Thread message below is left out when it shows.
    var thread: (model: ThreadModel, turn: ThreadTurn)? = nil
    /// The Conversation tab's messages (C8): the thread, or the ask alone before a reply. nil hides the tab's content.
    var conversation: (model: ThreadModel, turn: ThreadTurn)? = nil
    var onViewPriorRevision: () -> Void = {}
    /// "See vN" in a plan's answered history (HAIL-156), and the revision shown read-only now.
    var onSeePlanRevision: ((Int) -> Void)? = nil
    var viewingRevision: Int? = nil
    /// "Show": `ReviewViewModel.showExistingComments()` (HAIL-35 contract) -
    /// enters Comment mode on the latest capture without freezing a new one.
    var onShowComments: () -> Void = {}
    /// The client to fetch a followed-ask's title/recap with, and where to
    /// send its "open" tap (HAIL-33 amendment). `nil` keeps every existing
    /// call site - and every pre-HAIL-33 test - compiling unchanged; a
    /// `nil` client simply never shows the follow-up header.
    var client: KnockClient? = nil
    var onOpenCase: (String) -> Void = { _ in }
    /// The session line and the earlier asks (HAIL-102), rows of the context card. `nil` shows neither.
    var sessionContext: SessionContextBlock? = nil
    /// The right column's Question | Comments switch (HAIL-56 contract).
    let tab: ReviewColumnTab
    var onSelectTab: (ReviewColumnTab) -> Void = { _ in }
    /// The one page's answer area once the answer is sent (HAIL-86): replaces the composer and
    /// the Question | Comments switch, and the question above stays.
    var sentCard: AnyView? = nil
    /// The earlier asks of the session, at the top of the Conversation tab (C8).
    var earlierAsks: EarlierAsksModel? = nil
    /// The answers of an ask with questions (WAG-305): the same controller the case pane uses.
    /// `nil` for an ask without questions.
    var askDoc: AskDocController? = nil
    /// The sharing state of the case (WAG-387). The team's comments show when there are any.
    var shared: SharingModel? = nil

    /// The need, the revision thread, the questions and the pick of the round (folded under a message-only update, WAG-337).
    @ViewBuilder
    private var roundBody: some View {
        // "Why you" always closes the need box (C3, spec section 3); a returned revision adds the agent's message under it.
        VStack(alignment: .leading, spacing: Theme.AskDoc.Column.needGap) {
            // The questions branch shows the need once, on its first step.
            if !hidesNeedForSteps {
                NeedCalloutView(
                    need: knockCase.displayNeed(planRounds: planRounds),
                    why: knockCase.currentWhy,
                    isCompact: true,
                    labelAbove: knockCase.plan.map { PlanText.progressLabel($0.stage) })
            }

            if let revisionArrival {
                threadSection(revisionArrival)
            }

            // An ask with questions: the steps, one question at a time, as in the case pane (WAG-305).
            if let askDoc, askDoc.doc != nil, AskPanelLayout.showsQuestions(knockCase) {
                AskColumnQuestionsBody(knockCase: knockCase, askDoc: askDoc, sendFlow: sendFlow)
            }

            if let instruction = knockCase.roundHeading?.instruction {
                RoundInstructionView(text: instruction)
            }

            // The options, once, in the column's scroll (C1, C3, C9): the same rows as the case pane. The pinned
            // bottom holds only the answer box and the send row.
            if showsOptionsInColumn {
                optionsCard(part: .optionsOnly)
            }
            SourcesButtonSlot()
        }
        .coachMarkAnchor(.options)
    }

    /// The message-only update with the agent's full text (WAG-393).
    private var messageNote: MessageOnlyUpdate? {
        knockCase.messageOnlyUpdate?.fullText(from: messages, after: knockCase.latestReplyAtDate)
    }

    var body: some View {
        VStack(spacing: 0) {
            if sentCard == nil {
                // The latest agent message and the tabs, the same header as the case pane (C8).
                DecisionColumnHeader(
                    thread: thread?.model, caseId: knockCase.id, tab: tab, commentCount: commentCount,
                    decisionHeadsWithLatest: decisionHeadsWithLatest, onSelect: onSelectTab)
                    .padding(Theme.AskDoc.Column.tabsInset)
            }
            if sentCard == nil, tab == .conversation, let conversation {
                ConversationTabView(
                    model: conversation.model, turn: conversation.turn, earlier: earlierAsks, onOpenCase: onOpenCase)
            } else {
                decisionScroll
            }
            if let sentCard {
                sentCard.padding(EdgeInsets(top: 0, leading: Self.answerSideInset, bottom: 12, trailing: Self.answerSideInset))
            } else {
                // The answer area keeps 14 from the column's sides (`.ans`), the prompt bar's own padding included.
                composerFooter.padding(.horizontal, Self.answerSideInset)
            }
        }
        .frame(minWidth: AskLayout.fullSizeMinColumnWidth, idealWidth: AskLayout.columnWidth, maxWidth: AskLayout.columnWidth)
        .frame(width: Self.evidenceColumnWidth)
        .frame(maxHeight: .infinity)
        .background(Theme.Colors.win)
        // `.col`: a 1 pt line on its left.
        .overlay(alignment: .leading) { Rectangle().fill(Theme.Colors.line).frame(width: 1) }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { EvidenceLayoutLog.event("ask.columnHeight", "old=\(columnHeight) new=\($0)"); columnHeight = $0 }
        // The answer box grows to 40 % of the column (C6).
        .environment(\.answerBoxAvailableHeight, columnHeight)
        // Files dropped on the request attach to the reply (WAG-345).
        .attachesDroppedFiles(to: composer.files)
    }

    /// The Decision tab's scroll: the context line, the title or the agent's note, and the round.
    private var decisionScroll: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                // The mockup's order: the latest agent message, the follow-up line and the plan track with its
                // "See vN" (C2), each with its own gap under it.
                DecisionLatestMessage(
                    thread: thread?.model, tab: tab, decisionHeadsWithLatest: decisionHeadsWithLatest,
                    onOpen: { onSelectTab(.conversation) })
                RequestContextLine(
                    item: knockCase, client: client, planRounds: planRounds ?? [], viewingRevision: viewingRevision,
                    onSeeRevision: onSeePlanRevision, onOpenCase: onOpenCase)
                VStack(alignment: .leading, spacing: Theme.AskDoc.Column.titleGap) {
                    // The title, once (WAG-333). The project crumb is in the top bar (C2), as in the case pane. A
                    // stepped ask shows each question as its title. `h1`: 10 under it.
                    if let note = knockCase.workingNoteText {
                        WorkingNoteLine(note: note)
                    } else if let update = messageNote {
                        LatestMessageNote(note: update, width: .narrow)
                    } else if AskCrumbs.showsCaseTitle(doc: askDoc?.doc) {
                        AskTitleView(heading: knockCase.roundHeading, title: knockCase.title, width: .narrow)
                    }

                    commentsSummaryLine

                    if let shared { TeamCountLine(model: shared) { onSelectTab(.comments) } }

                    if knockCase.workingNoteText != nil || messageNote?.staysLive == false {
                        EarlierDecisionFold(title: PreviousAnswer.foldTitle(knockCase, fallback: "Earlier round")) { roundBody }
                    } else {
                        roundBody
                    }
                }
                }
                .padding(EdgeInsets(
                    top: Theme.AskDoc.Column.scrollInset.top, leading: Theme.AskDoc.Column.scrollInset.leading,
                    bottom: 16, trailing: Theme.AskDoc.Column.scrollInset.trailing))
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { EvidenceLayoutLog.event("ask.contentHeight", "old=\(scrollContentHeight) new=\($0)"); scrollContentHeight = $0 }
            }
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { EvidenceLayoutLog.event("ask.viewportHeight", "old=\(scrollViewportHeight) new=\($0)"); scrollViewportHeight = $0 }
            .overlay(alignment: .bottom) {
                // Content runs under the dock: a soft fade says there is more (WAG-303, audit F3).
                if AskPanelLayout.showsBottomFade(contentHeight: scrollContentHeight, viewportHeight: scrollViewportHeight) {
                    LinearGradient(colors: [Theme.Colors.win.opacity(0), Theme.Colors.win], startPoint: .top, endPoint: .bottom)
                        .frame(height: AskPanelLayout.fadeHeight)
                        .allowsHitTesting(false)
                }
            }
    }

    /// The Decision tab already heads with the agent's newest message, so the latest-message box would repeat it.
    private var decisionHeadsWithLatest: Bool { knockCase.workingNoteText != nil || messageNote != nil }

    /// The answer area's side edge outside the prompt bar's own padding, so its content sits 14 in (`.ans`).
    private static let answerSideInset = max(0, Theme.AskDoc.Column.answerSideInset - PromptBarLogic.barPadding)

    /// A stepped ask shows its need on its first step, inside the questions branch.
    private var hidesNeedForSteps: Bool { askDoc?.doc?.isStepped == true && AskPanelLayout.showsQuestions(knockCase) }

    @State private var scrollContentHeight: CGFloat = 0
    @State private var scrollViewportHeight: CGFloat = 0
    @State private var columnHeight: CGFloat = 800

    /// `KNOCK_EVIDENCE_ASK_COLUMN_WIDTH=<points>` (HAIL-157 evidence only): pins the column to a width so
    /// a capture can show the plan track at several widths. Nil, so no effect, when unset.
    private static let evidenceColumnWidth: CGFloat? = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_ASK_COLUMN_WIDTH"]
        .flatMap(Double.init).map { CGFloat($0) }

    /// The unified composer card (docs/stories/HAIL-54.md) for an options
    /// ask, or the plain `ComposerFooterView` for a free-text one - the same
    /// split the case pane makes. `AskColumnView` only ever renders this
    /// editable; `AnsweredAskColumnView` covers the locked/answered display
    /// once `ReviewWorkspaceView.rightColumnKind` resolves to
    /// `.answeredRecap`, so `ComposerCardView` never needs `isLocked: true`
    /// here.
    @ViewBuilder
    private var composerFooter: some View {
        if let askDoc, AskPanelLayout.showsQuestions(knockCase) {
            AskColumnQuestionsDock(askDoc: askDoc, sendFlow: sendFlow, columnHeight: columnHeight)
        } else if knockCase.options.isEmpty || knockCase.earlierRoundIsReadOnly {
            ComposerFooterView(
                composer: composer,
                sendFlow: sendFlow,
                deliveryState: sendFlow.deliveryState,
                commentCount: commentCount,
                placeholder: PromptBarLogic.placeholder(for: .reply, hasRevision: revisionArrival != nil)
            )
        } else {
            optionsCard(part: .replyOnly)
        }
    }

    /// An options ask lists its options in the scroll and keeps its answer box pinned, as the case pane does (C9).
    private var showsOptionsInColumn: Bool {
        !(askDoc != nil && AskPanelLayout.showsQuestions(knockCase)) && !knockCase.options.isEmpty
            && !knockCase.earlierRoundIsReadOnly
    }

    /// The unified composer card, split as in the case pane: `.optionsOnly` in the scroll, `.replyOnly` pinned.
    private func optionsCard(part: ComposerCardView.Part) -> some View {
        ComposerCardView(
            composer: composer,
            sendFlow: sendFlow,
            deliveryState: sendFlow.deliveryState,
            recommendationId: knockCase.recommendation,
            commentCount: commentCount,
            placeholder: PromptBarLogic.placeholder(for: .decide, hasRevision: revisionArrival != nil),
            maxOptionsHeight: nil,
            showsFullOptions: true,
            fullLabelOnlyWhenSelected: knockCase.plan != nil,
            part: part
        )
    }

    /// docs/design/mvp-values.md §M9 `xAVpQ`: the agent's own message from
    /// the update that returned this revision, plus (when the prior revision
    /// has any) the link back to its comments.
    @ViewBuilder
    private func threadSection(_ arrival: RevisionArrival) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if thread == nil, let message = arrival.agentMessage {
                agentMessageBubble(message)
            }
            if arrival.priorCommentCount > 0 {
                priorRevisionLink(arrival)
            }
        }
    }

    private func agentMessageBubble(_ message: Message) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(Theme.Colors.side)
                .frame(width: 22, height: 22)
                .overlay(
                    Image(systemName: "cpu")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.Colors.ink2)
                )
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text("Claude Code")
                        .knockTextStyle(Theme.Typography.threadAuthor12_5w600)
                        .foregroundColor(Theme.Colors.ink)
                    Text(KnockDateFormat.relativeShort(from: message.createdAtDate ?? now, now: now))
                        .knockTextStyle(Theme.Typography.threadTimestamp11_5w400)
                        .foregroundColor(Theme.Colors.ink3)
                }
                Text(message.text)
                    .knockTextStyle(Theme.Typography.threadMessageBody13w400)
                    .foregroundColor(Theme.Colors.ink)
            }
        }
    }

    /// "`<k> comments on v<n-1>` · view v<n-1>" (docs/design/mvp-values.md
    /// §M9 `E0OSB`): switches the artifact viewer to that revision,
    /// read-only.
    private func priorRevisionLink(_ arrival: RevisionArrival) -> some View {
        PriorRevisionCommentsLink(arrival: arrival, action: onViewPriorRevision, leadingPadding: 32)
    }

    /// "N comments on M captures · Show" (HAIL-35 contract), only while
    /// there is anything to show - a case with no comments yet has nothing
    /// this line would usefully say.
    @ViewBuilder
    private var commentsSummaryLine: some View {
        if let prefix = Self.commentsSummaryPrefix(commentCount: commentCount, captureCount: captureCount) {
            HStack(spacing: 6) {
                Text(prefix)
                    .knockTextStyle(Theme.Typography.priorRevisionLink12w500)
                    .foregroundColor(Theme.Colors.ink2)
                Text("· Show")
                    .knockTextStyle(Theme.Typography.priorRevisionLink12w500)
                    .foregroundColor(Theme.Colors.accent)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: onShowComments).pointerCursor()
        }
    }

    /// Pure text for `commentsSummaryLine` - unit-tested without hosting the
    /// view (same pattern as `ReviewWorkspaceView.rightColumnKind`). `nil`
    /// hides the line entirely.
    static func commentsSummaryPrefix(commentCount: Int, captureCount: Int) -> String? {
        guard commentCount > 0 else { return nil }
        // Comments on the text of an explanation (HAIL-150) have no capture to count.
        if captureCount == 0 { return "\(commentCount) comment\(commentCount == 1 ? "" : "s")" }
        return "\(commentCount) comment\(commentCount == 1 ? "" : "s") on \(captureCount) capture\(captureCount == 1 ? "" : "s")"
    }
}

/// What the review panel's Decision tab holds (WAG-276). The options are not part of it: they sit once, as
/// the dock rows below the doc.
enum AskPanelLayout {
    enum Part: Equatable { case crumb, title, need, why, pickedPoints }

    /// The parts of the Decision tab's doc, top to bottom. There is no Context box, no Need and Why cards
    /// and no list of options: the options are the dock rows, shown once.
    static func parts(for knockCase: Case, picked: Option?, hasCrumb: Bool = true) -> [Part] {
        var parts: [Part] = []
        if knockCase.plan == nil {
            if hasCrumb { parts.append(.crumb) }
            parts.append(.title)
        }
        parts.append(.need)
        if let why = knockCase.currentWhy, !why.isEmpty { parts.append(.why) }
        if picked != nil { parts.append(.pickedPoints) }
        return parts
    }

    /// Where the panel shows the ask's options: the dock, and only there.
    static func optionsPlaces(for knockCase: Case) -> [AskOptionsPlace] { AskDocRules.optionsPlaces(for: knockCase) }

    /// The pick block shows for every ask with single-choice options, before a pick too (WAG-303, audit F1).
    /// An ask with questions shows its steps and the steps bar, not the free reply field (WAG-305).
    static func showsQuestions(_ knockCase: Case) -> Bool { AskBarMode.forCase(knockCase) == .answers }

    static func showsPickBlock(_ knockCase: Case) -> Bool {
        AskBarMode.forCase(knockCase) == .decide && knockCase.select != .many
    }

    /// The column is at most 430pt wide, so the lists stack in one column.
    static let blockColumns = false

    /// The tallest the option rows of the workspace dock get: 40% of the column, never under `DecisionDock.minCap`.
    /// Past it only the rows scroll, so they never cover the pick box (WAG-303, audit F3).
    static func dockCap(columnHeight: CGFloat) -> CGFloat { max(DecisionDock.minCap, columnHeight * DecisionDock.stepShare) }

    /// The soft fade at the bottom edge of the scroll area, only while content runs under the dock.
    static let fadeHeight: CGFloat = 28
    static func showsBottomFade(contentHeight: CGFloat, viewportHeight: CGFloat) -> Bool {
        viewportHeight > 0 && contentHeight > viewportHeight + 1
    }

    /// "YOUR PICK · 1 FLAGGED FIRST".
    static func pickLabel(_ option: Option, position: Int) -> String { CalmOption.pickLabel(option, position: position) }
}
