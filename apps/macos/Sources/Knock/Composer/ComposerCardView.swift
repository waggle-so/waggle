import SwiftUI

/// The unified answer box (docs/stories/HAIL-54.md, Pen V1 "Unified composer"
/// + V3 "Keyboard-first" key badges), docked to the bottom edge of its pane
/// (HAIL-107): full width, a top hairline and a soft upward shadow, no rounded
/// card. It holds the numbered options, "Ask for more detail" as their last row
/// (HAIL-111), the reply field, and the prompt bar, in place of the old separate
/// options dock and `ComposerFooterView`. Shared by the case pane's answer dock and the review
/// workspace's `AskColumnView` (its only caller while the ask is editable -
/// `AnsweredAskColumnView` covers the review workspace's own locked/answered
/// display and never reaches this view).
struct ComposerCardView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var composer: ComposerViewModel
    @ObservedObject var sendFlow: SendFlowController
    @ObservedObject var deliveryState: DeliveryStateViewModel
    let recommendationId: String?
    let commentCount: Int
    let placeholder: String
    /// The answer-lock state (docs/stories/HAIL-34.md operator report 21:11):
    /// true once a reply exists for this round and "Change answer" has not
    /// re-opened it. Locked, the prompt bar disappears entirely (there is
    /// nothing left to send), every row but the sent one dims, and the reply
    /// field shows `lockedMessage` read-only instead of the live draft.
    /// Always `false` for `AskColumnView` - the review workspace's own
    /// `AnsweredAskColumnView` takes over the whole column once locked, so
    /// this view never needs to render that state there.
    var isLocked: Bool = false
    /// The reply's own chosen option id (docs/stories/HAIL-34.md operator
    /// report 21:11): read off the case, not `composer.selectedOptionId`, so
    /// a locked row's badge/tag reflects what was actually sent even if the
    /// composer's own selection has since drifted (or the reply carried no
    /// choice at all - `OptionChipView.isSelected` then marks no row).
    var yourAnswerOptionId: String? = nil
    /// The sent reply's ticked ids for a select "many" ask (HAIL-123), read off the case like
    /// `yourAnswerOptionId`.
    var yourAnswerOptionIds: Set<String> = []
    /// The sent reply's own message (docs/stories/HAIL-34.md): shown
    /// read-only in the reply field's place while `isLocked`, instead of
    /// `composer.draftText`, for the same reason `yourAnswerOptionId` reads
    /// off the case rather than the live composer.
    var lockedMessage: String? = nil
    /// The files sent with the answer, read-only beside `lockedMessage` (WAG-345).
    var lockedAttachments: [ReplyAttachment] = []
    /// "Open review ↵" (HAIL-41): shown in the prompt bar beside "Ask for more
    /// detail" only for the case pane's review-kind asks - the pane's own
    /// escape hatch to the full review workspace, which never needs a link
    /// back to itself (`nil` there).
    var onOpenReview: (() -> Void)? = nil
    /// Caps the options section's height and scrolls the rest internally
    /// (Preservation: "answer dock stays fixed at the bottom with its max
    /// height and inner scroll for long option lists") - the case pane passes
    /// its `maxOptionsHeight`; `nil` (no cap, no inner scroll) for
    /// `AskColumnView`, which already scrolls its whole column.
    var maxOptionsHeight: CGFloat? = nil
    /// The decision doc's one place for options (WAG-257): each row shows the option in full, and the
    /// button reads "Decide: <option>". The page has no separate Decision card.
    var showsFullOptions = false
    /// With `showsFullOptions`, show the full text of the selected row only (WAG-276): the answers are
    /// described elsewhere on the page (the plan question), or the selected one opens in the panel.
    var fullLabelOnlyWhenSelected = false
    /// False in the case pane: its context line holds the status line (C10), so the card draws none.
    var showsStatus: Bool = true
    /// Which part of the box shows. The pane's decision column (C1) uses the box twice: its option rows scroll
    /// with the question (`.optionsOnly`), and only the answer box and the send row are pinned at the bottom
    /// (`.replyOnly`), so the options show once and Send is always on screen.
    var part: Part = .whole

    enum Part: Equatable {
        case whole
        /// Only the option rows, with no dock chrome: they scroll with the page.
        case optionsOnly
        /// Only the note field and the Decide button: the sticky bottom.
        case replyOnly
    }

    @State private var isDraftFocused = false
    @State private var optionsContentHeight: CGFloat = 0
    @State private var firstOptionsContentHeight: CGFloat = 0
    /// The "First options" link (update with options) reveals the dimmed first set (HAIL-108).
    /// `KNOCK_EVIDENCE_SHOW_FIRST_OPTIONS=1` opens it for a capture (evidence only).
    @State private var showsFirstOptions = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_SHOW_FIRST_OPTIONS"] == "1"

    /// Locked or changing an answer that came from the first set: that set is the main list.
    private var firstSetIsMain: Bool {
        composer.knockCase.latestReplyFromFirstOptions && (isLocked || sendFlow.isEditingLockedAnswer)
    }
    private var options: [Option] { firstSetIsMain ? composer.firstOptions : composer.options }
    private var mainRecommendationId: String? {
        firstSetIsMain ? composer.knockCase.firstRecommendation : recommendationId
    }
    /// The list shows check boxes: a select "many" set that is not the folded first set (HAIL-123).
    private var multiMode: Bool { composer.isMultiSelect && !firstSetIsMain }
    /// Once a reply is in flight or sent the rows stay, read-only (WAG-306, F10).
    private var rowsLocked: Bool { Self.answeredRows(isLocked: isLocked, deliveryIdle: deliveryState.state == .idle, yourAnswerOptionId: yourAnswerOptionId, selectedOptionId: composer.selectedOptionId).locked }
    /// The pick of a reply that is on its way, before the case carries it.
    private var pickedId: String? { Self.answeredRows(isLocked: isLocked, deliveryIdle: deliveryState.state == .idle, yourAnswerOptionId: yourAnswerOptionId, selectedOptionId: composer.selectedOptionId).pickedId }

    /// The answered state keeps its option rows, dimmed and locked, with the picked row marked (WAG-306).
    static func answeredRows(
        isLocked: Bool, deliveryIdle: Bool, yourAnswerOptionId: String?, selectedOptionId: String?
    ) -> (locked: Bool, pickedId: String?) {
        (isLocked || !deliveryIdle, isLocked ? yourAnswerOptionId : (yourAnswerOptionId ?? selectedOptionId))
    }
    private var answerBox: AnswerBoxState { isLocked || sendFlow.isEditingLockedAnswer ? .original : composer.answerBox }

    /// The variant of the screen on show (decision record 2026-11-12): its option gets «On screen».
    @Environment(\.onScreenVariant) private var onScreenVariant

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if deliveryState.state == .idle {
                if composer.isAskingForDetail {
                    // The panel takes the options' place (C5). In the pane's column it scrolls with the page and
                    // the send row stays pinned; in a dock (`.whole`) it scrolls inside the dock's cap. The send
                    // row stays under it, with "Ask for…" on, so Send never leaves the screen.
                    switch part {
                    case .optionsOnly: detailPanel
                    case .replyOnly: replyField
                    case .whole:
                        scrolled(detailPanel, height: $optionsContentHeight)
                        replyField
                    }
                } else {
                    switch answerBox {
                    case .original:
                        if part != .replyOnly { optionsSection }
                        if part != .optionsOnly { replyField }
                    case .updateWithOptions(let updatedAt, let firstAt):
                        if part != .replyOnly {
                            updateHeader(updatedAt).padding(.bottom, OptionCardStyle.updateHeaderGap)
                            optionsSection(withFirst: true, firstAt: firstAt)
                        }
                        if part != .optionsOnly { replyField }
                    }
                }
            } else {
                // The answered state keeps the options, locked, above the delivery line (WAG-306, F10).
                if part != .replyOnly { optionsSection }
                if part != .optionsOnly, showsStatus,
                   let line = RequestStatus.localLine(deliveryState.state, item: composer.knockCase) {
                    RequestStatusLineView(line: line, onAction: { if $0 == .retry { Task { await sendFlow.retryDelivery() } } })
                        .padding(14)
                }
            }
        }
        .boundedIdealWidth()
        // The answer area (mockup `.ans`): white, one plain 1 pt `line` on top, no shadow.
        .background { if part != .optionsOnly { Theme.Colors.win } }
        .overlay(Rectangle().fill(Theme.Colors.line).frame(height: part == .optionsOnly ? 0 : 1), alignment: .top)
        .background { if !isLocked && part != .optionsOnly { hiddenShortcuts } }
        .onAppear(perform: consumeFocusRequestIfNeeded)
        .onChange(of: composer.focusDraftOnOpen) { _, requested in
            if requested { consumeFocusRequestIfNeeded() }
        }
    }

    // MARK: - Options

    @ViewBuilder
    private var optionsSection: some View { optionsSection(withFirst: false, firstAt: nil) }

    /// The options, scrolling inside past the dock's cap. With `firstAt` set
    /// (`withFirst`, an update with options) the first set follows, dimmed, in its own fold under
    /// its own divider once "First options" is open: never inside the current options' capped scroll, so
    /// opening it never pushes the current options out of view (C3, request page spec section 3 item 4).
    @ViewBuilder
    private func optionsSection(withFirst: Bool, firstAt: Date?) -> some View {
        if !options.isEmpty {
            currentOptions
            if withFirst, showsFirstOptions {
                firstOptionsFold(firstAt: firstAt)
            }
        }
    }

    /// The first set of an update with options, in its own fold (and its own capped scroll in a dock).
    private func firstOptionsFold(firstAt: Date?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(AnswerBoxState.firstOptionsDivider(at: firstAt))
                .knockTextStyle(Theme.Typography.labelCaps10_5w600)
                .foregroundColor(Theme.Colors.ink3)
                .padding(EdgeInsets(top: 8, leading: part == .optionsOnly ? 0 : 14, bottom: 6, trailing: 14))
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(Rectangle().fill(Theme.Colors.line).frame(height: 1), alignment: .top)
            scrolled(
                optionRowList(composer.firstOptions, recommendationId: composer.knockCase.firstRecommendation, isFirstSet: true),
                height: $firstOptionsContentHeight)
        }
        .padding(.top, part == .optionsOnly ? 10 : 0)
        .transition(.opacity)
    }

    @ViewBuilder
    private var currentOptions: some View {
        let rows = VStack(alignment: .leading, spacing: 0) {
            if let why = Self.freeTextWhy(composer.knockCase, recommendationId: mainRecommendationId), part != .replyOnly {
                AgentMarkdownText(text: why, style: Theme.Typography.recommendLine12w400)
                    .foregroundColor(Theme.Colors.ink2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(EdgeInsets(top: 12, leading: 14, bottom: 10, trailing: 14))
            }
            optionRowList(options, recommendationId: mainRecommendationId, isFirstSet: false)
            if showsReviewHint {
                Text(PromptBarLogic.reviewPickHint)
                    .knockTextStyle(Theme.Typography.recommendLine12w400)
                    .foregroundColor(Theme.Colors.ink3)
                    .padding(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14))
            }
        }
        scrolled(rows, height: $optionsContentHeight)
    }

    /// A review shows its pick hint while no row is picked and the answer is open (WAG-316).
    private var showsReviewHint: Bool {
        composer.isReview && !rowsLocked && !composer.hasPick && !composer.isDiscussing && part != .replyOnly
    }

    /// The why of a recommendation that names no row (Q2): shown on its own, as no row carries it.
    static func freeTextWhy(_ item: Case, recommendationId: String?) -> String? {
        guard item.kind == .review, recommendationId.map(\.isEmpty) ?? true else { return nil }
        let why = item.recommendationWhy.trimmingCharacters(in: .whitespacesAndNewlines)
        return why.isEmpty ? nil : why
    }

    /// The "Ask for…" panel (C5): quick replies, the ask rows, the formats and "Something else".
    private var detailPanel: some View {
        AskForDetailPanelView(
            composer: composer,
            onSend: { sendFlow.askForMoreDetail() },
            onSendFormat: { sendFlow.askForMoreDetail(format: $0) },
            onQuickReply: { sendFlow.quickReply($0) },
            hasComments: sendFlow.pinnedCommentCount > 0
        )
        .modifier(AskForPanelCard(isCard: part == .optionsOnly))
    }

    /// Wraps rows in the dock's capped scroll area when the caller gave a cap.
    @ViewBuilder
    private func scrolled<Content: View>(_ rows: Content, height: Binding<CGFloat>) -> some View {
        if let maxOptionsHeight {
            ScrollView {
                rows.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { height.wrappedValue = $0 }
            }
            .frame(height: min(max(height.wrappedValue, 1), maxOptionsHeight))
            .scrollBounceBehavior(.basedOnSize)
            // Evidence only: lets the drawn tooltip of `KNOCK_EVIDENCE_OPTION_TIP` rise above the list.
            .scrollClipDisabled(ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_OPTION_TIP"] != nil)
        } else {
            rows
        }
    }

    /// The folded list of an update without options (same rows as the original box).
    private func optionRows(_ list: [Option], recommendationId: String?) -> some View {
        scrolled(optionRowList(list, recommendationId: recommendationId, isFirstSet: false), height: $optionsContentHeight)
    }

    private func optionRowList(_ list: [Option], recommendationId: String?, isFirstSet: Bool) -> some View {
        let checks = multiMode && !isFirstSet
        let calm = true
        func picked(_ option: Option) -> Bool {
            checks
                ? (rowsLocked ? yourAnswerOptionIds.contains(option.id) : composer.isTicked(option.id))
                : OptionChipView.isSelected(
                    optionId: option.id, isLocked: rowsLocked,
                    yourAnswerOptionId: pickedId,
                    selectedOptionId: composer.selectedFromFirstOptions == isFirstSet ? composer.selectedOptionId : nil
                )
        }
        // The pick opens in place, else the recommendation (mockup `.choice.on .x`). The older set stays closed.
        let onScreen = isFirstSet ? nil : onScreenVariant?.option(anchors: list.map(\.anchor), item: nil)
        let open = isFirstSet ? nil : CalmOption.openPosition(
            selected: list.firstIndex(where: picked).map { $0 + 1 },
            recommended: list.firstIndex(where: { $0.id == recommendationId }).map { $0 + 1 }, isCheckbox: checks)
        return VStack(alignment: .leading, spacing: calm ? CalmOption.rowGap : 0) {
            if checks && !rowsLocked {
                multiHeader.padding(.bottom, OptionCardStyle.labelGap - CalmOption.rowGap)
            } else if !isFirstSet {
                OptionListLabel().padding(.bottom, OptionCardStyle.labelGap - CalmOption.rowGap)
            }
            ForEach(Array(list.enumerated()), id: \.element.id) { index, option in
                OptionChipView(
                    option: option,
                    position: index + 1,
                    isRecommended: checks
                        ? composer.knockCase.recommendations.contains(option.id) : option.id == recommendationId,
                    isSelected: picked(option),
                    isLocked: rowsLocked,
                    isFirstSetRow: isFirstSet,
                    // A tick list says "Recommended" on each row; the one reason sits in the ask, not on every row.
                    recommendationWhy: isFirstSet || firstSetIsMain || checks ? nil : composer.knockCase.recommendationWhy,
                    isCheckbox: checks,
                    isLimitDimmed: checks && !rowsLocked && composer.isAtLimit,
                    showsFullLabel: showsFullOptions,
                    fullLabelOnlyWhenSelected: fullLabelOnlyWhenSelected,
                    showsPoints: showsFullOptions && !fullLabelOnlyWhenSelected,
                    isLeaning: !isFirstSet && composer.isLeaning(option.id),
                    isRuledOut: !isFirstSet && composer.isRuledOut(option.id),
                    onLean: !isFirstSet && composer.supportsDiscuss ? { composer.toggleLean(option.id) } : nil,
                    onRuleOut: !isFirstSet && composer.supportsDiscuss ? { composer.toggleRuleOut(option.id) } : nil,
                    isOpen: open == index + 1,
                    isOnScreen: onScreen == index,
                    onSelect: {
                        // A click opens the row with a short height change. Number keys and Cmd+D call the
                        // composer directly, so they never animate.
                        ReducedMotion.animate(reduceMotion: reduceMotion, .easeOut(duration: CalmOption.openDuration)) {
                            if isFirstSet { composer.selectFirstOption(option.id) } else { composer.selectOption(option.id) }
                        }
                    }
                )
                if index < list.count - 1 && !calm {
                    Rectangle().fill(Theme.Colors.line).frame(height: 1)
                }
            }
        }
        .padding(calm && part != .optionsOnly ? EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14) : EdgeInsets())
    }

    /// The pick-several header, shared with the items of a step (WAG-334).
    private var multiHeader: some View {
        PickSeveralHeaderView(
            count: composer.selectedOptionIds.count, max: composer.maxChoices, isAtLimit: composer.isAtLimit,
            canTickRecommended: composer.canTickRecommended, onTickRecommended: composer.tickRecommended,
            onClear: composer.clearPicks)
    }

    // MARK: - Update framing (HAIL-108)

    /// The blue header of an update with options, with the "First options" link on the right.
    private func updateHeader(_ updatedAt: Date?) -> some View {
        HStack(spacing: 6) {
            Text(AnswerBoxState.header(at: updatedAt))
                .knockTextStyle(Theme.Typography.caption11_5w400)
                .foregroundColor(Theme.Colors.ds)
            Spacer(minLength: 8)
            Button(AnswerBoxState.firstOptionsLink(isOpen: showsFirstOptions)) { showsFirstOptions.toggle() }
                .buttonStyle(.plain).pointerCursor()
                .knockTextStyle(Theme.Typography.caption11_5w400)
                .foregroundColor(Theme.Colors.ds)
                .underline()
        }
        .padding(EdgeInsets(top: 7, leading: 14, bottom: 7, trailing: 14))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.dsUpdateFill)
        .overlay(Rectangle().fill(Theme.Colors.line).frame(height: 1), alignment: .bottom)
    }

    // MARK: - Reply field (no border of its own - the card supplies it)

    @ViewBuilder
    private var replyField: some View {
        if !options.isEmpty, part == .whole {
            Rectangle().fill(Theme.Colors.line).frame(height: 1)
        }
        if isLocked {
            lockedReplyField
        } else {
            editableReplyField
        }
    }

    /// The prompt bar (HAIL-77): attach, the growing reply field, "Ask for
    /// more detail" and Send in the card's bottom section. The card supplies
    /// the one outline.
    private var editableReplyField: some View {
        PromptBarView(
            composer: composer,
            draft: composer.draft,
            sendFlow: sendFlow,
            files: composer.files,
            commentCount: commentCount,
            placeholder: placeholder,
            acceptsRecommendationWithComments: true,
            onOpenReview: onOpenReview,
            decides: showsFullOptions,
            isFocused: $isDraftFocused
        )
    }

    /// The sent note, read-only (Preservation: "the reply field shows the
    /// sent note read-only") - the same slot the editable field occupies, but
    /// with no cursor and no placeholder, since there is nothing left to type.
    @ViewBuilder
    private var lockedReplyField: some View {
        if (lockedMessage ?? "").isEmpty == false || !lockedAttachments.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if let lockedMessage, !lockedMessage.isEmpty {
                    Text(lockedMessage)
                        .knockTextStyle(Theme.Typography.body13_5w400)
                        .foregroundColor(Theme.Colors.ink2)
                }
                SentAttachmentsView(files: lockedAttachments)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(EdgeInsets(top: 11, leading: 14, bottom: 11, trailing: 14))
        }
    }

    private func consumeFocusRequestIfNeeded() {
        guard composer.focusDraftOnOpen else { return }
        composer.focusDraftOnOpen = false
        isDraftFocused = true
    }

    // MARK: - Keyboard shortcuts

    /// The keys of the dock: the same view the steps dock uses (WAG-334).
    private var hiddenShortcuts: some View {
        DockShortcutsView(
            isAskingForDetail: composer.isAskingForDetail, isTextFocused: isDraftFocused,
            // Return sends the ticks while the reply field is not focused (HAIL-123).
            returnActs: multiMode,
            onAccept: { sendFlow.acceptRecommendation(via: .shortcut) },
            onSend: sendFlow.send,
            onPick: { composer.selectOption(atPosition: $0) },
            onReturn: { if composer.hasPick { sendFlow.send() } },
            onAskForDetail: { composer.beginAskingForDetail() })
    }
}
