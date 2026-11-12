import AppKit
import SwiftUI

/// The reply field of the prompt bar: an `NSTextView` in a scroll view. Edits text, scrolls once the
/// text passes its cap, and turns Return into the decision `PromptBarLogic.returnKeyAction` makes.
///
/// With `maxHeight` set (the answer box, request page C6) the field sizes itself from its own text
/// view's layout, at the width it is given, up to `maxHeight`; past that it scrolls and its scroller
/// stays on screen. After each edit and width change it reports what it measured through `onMeasure`.
/// Without `maxHeight` the host sets its height and the scroller is the system's overlay one.
struct PromptTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    let canSend: Bool
    let onSend: () -> Void
    /// Called on every edit the person makes (never for text the app sets).
    var onEdit: () -> Void = {}
    /// Cmd-V: offered the clipboard first. True when it took a file or an image, so no text is pasted (WAG-345).
    var onPaste: ((NSPasteboard) -> Bool)? = nil
    /// Tallest the field grows before it scrolls; `nil` leaves the height to the host.
    var maxHeight: CGFloat? = nil
    /// What the text view measured, after each edit and width change (only with `maxHeight`).
    var onMeasure: ((PromptBarLogic.FieldMetrics) -> Void)? = nil
    /// The text's font: 13.5 for the reply items and the panel's own field; the answer box passes 12.5.
    var font: NSFont = PromptBarLogic.font

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.hasHorizontalScroller = false

        let view = PromptNSTextView()
        Self.configure(view, font: font)
        view.coordinator = context.coordinator
        view.delegate = context.coordinator
        view.string = text
        scroll.documentView = view
        if maxHeight != nil { context.coordinator.measure(view) }
        return scroll
    }

    /// The field's text setup, shared with the tests that measure it.
    static func configure(_ view: NSTextView, font: NSFont = PromptBarLogic.font) {
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.drawsBackground = false
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.font = font
        view.textColor = NSColor(Theme.Colors.ink)
        view.insertionPointColor = NSColor(Theme.Colors.ink)
        view.defaultParagraphStyle = PromptBarLogic.paragraphStyle
        view.typingAttributes = [
            .font: font,
            .foregroundColor: NSColor(Theme.Colors.ink),
            .paragraphStyle: PromptBarLogic.paragraphStyle,
        ]
        view.textContainerInset = PromptBarLogic.textInset
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? PromptNSTextView else { return }
        // Skipped while IME text is being composed, so the composition is not lost.
        if view.string != text, !view.hasMarkedText() {
            view.string = text
            // Text the app sets ("Use this reply", evidence hooks) leaves the caret at its end.
            let end = NSRange(location: (text as NSString).length, length: 0)
            view.setSelectedRange(end)
            view.scrollRangeToVisible(end)
        }
        if maxHeight != nil { context.coordinator.measure(view) }
        context.coordinator.syncFocus(view)
    }

    /// The answer box's height: its own text view laid out at the offered width, capped at `maxHeight`.
    /// This also sizes the first frame, before any measure has been reported, so nothing is clipped.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        guard let maxHeight, let view = scroll.documentView as? PromptNSTextView else { return nil }
        let current = scroll.frame.width
        // An unspecified or unbounded offer (SwiftUI probing) is answered at the current width.
        let offered = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let width = offered ?? (current > 0 ? current : PromptBarLogic.minFieldWidth)
        let content = abs(width - current) > 0.5 ? view.contentHeight(fieldWidth: width) : view.measure().contentHeight
        return CGSize(
            width: proposal.width ?? width, height: PromptBarLogic.fieldHeight(contentHeight: content, maxHeight: maxHeight))
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: PromptTextView
        private var lastReported: PromptBarLogic.FieldMetrics?
        init(_ parent: PromptTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            if parent.text != view.string { parent.text = view.string }
            parent.onEdit()
            if let view = view as? PromptNSTextView, parent.maxHeight != nil { measure(view) }
        }

        /// Measures the text view, shows the scroller when text is hidden, and reports a new measure.
        func measure(_ view: PromptNSTextView) {
            guard let maxHeight = parent.maxHeight else { return }
            let metrics = view.measure()
            if let scroll = view.enclosingScrollView {
                Self.showScroller(scroll, PromptBarLogic.scrolls(contentHeight: metrics.contentHeight, maxHeight: maxHeight))
            }
            guard metrics != lastReported else { return }
            lastReported = metrics
            view.enclosingScrollView?.invalidateIntrinsicContentSize()
            guard let onMeasure = parent.onMeasure else { return }
            // Never during SwiftUI's own update or layout pass.
            DispatchQueue.main.async { onMeasure(metrics) }
        }

        /// A legacy scroller that does not hide itself while text is out of view; none while all of it shows.
        /// The scroller narrows the text, which only makes it taller, so the state never flips back on its own.
        static func showScroller(_ scroll: NSScrollView, _ shows: Bool) {
            if scroll.autohidesScrollers { scroll.autohidesScrollers = false }
            if scroll.scrollerStyle != .legacy { scroll.scrollerStyle = .legacy }
            if scroll.hasVerticalScroller != shows { scroll.hasVerticalScroller = shows }
        }

        /// Follows the host's `isFocused` (set by a click on the row, or by
        /// "Open review" asking for the caret).
        func syncFocus(_ view: NSTextView) {
            guard parent.isFocused, let window = view.window, window.firstResponder !== view else { return }
            Task { @MainActor in window.makeFirstResponder(view) }
        }

        func focusChanged(_ focused: Bool) {
            Task { @MainActor in
                if self.parent.isFocused != focused { self.parent.isFocused = focused }
            }
        }
    }
}

final class PromptNSTextView: NSTextView {
    weak var coordinator: PromptTextView.Coordinator?

    override var acceptsFirstResponder: Bool { true }

    // MARK: Measuring (request page C6)

    /// The text's height and one-line width from this view's own layout manager, at its current width.
    func measure() -> PromptBarLogic.FieldMetrics {
        var used: CGFloat = 0
        if let layoutManager, let textContainer {
            layoutManager.ensureLayout(for: textContainer)
            used = layoutManager.usedRect(for: textContainer).height
        }
        return PromptBarLogic.FieldMetrics(
            contentHeight: PromptBarLogic.contentHeight(usedTextHeight: used), naturalWidth: naturalTextWidth, width: frame.width)
    }

    /// The content height at another field width, from this view's own layout manager. The container
    /// gets its width back afterwards; the view's frame takes the new width on the next layout anyway.
    func contentHeight(fieldWidth: CGFloat) -> CGFloat {
        guard let layoutManager, let textContainer else { return PromptBarLogic.contentHeight(usedTextHeight: 0) }
        let old = textContainer.size
        let target = CGSize(width: max(fieldWidth - textContainerInset.width * 2, 1), height: old.height)
        guard target != old else { return measure().contentHeight }
        // A container that tracks the view's width keeps the view's width; let go of it while measuring.
        let tracks = textContainer.widthTracksTextView
        textContainer.widthTracksTextView = false
        textContainer.size = target
        layoutManager.ensureLayout(for: textContainer)
        let used = layoutManager.usedRect(for: textContainer).height
        textContainer.size = old
        textContainer.widthTracksTextView = tracks
        return PromptBarLogic.contentHeight(usedTextHeight: used)
    }

    /// The widest paragraph of this view's own text, set on one line.
    var naturalTextWidth: CGFloat {
        guard let textStorage, textStorage.length > 0 else { return 0 }
        let rect = textStorage.boundingRect(
            with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin])
        return ceil(rect.width)
    }

    /// A new width (the bar resized, the field changed rows, the scroller came or went): measure again.
    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = abs(newSize.width - frame.width) > 0.5
        super.setFrameSize(newSize)
        guard widthChanged, coordinator?.parent.maxHeight != nil else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.coordinator?.measure(self)
        }
    }

    override func paste(_ sender: Any?) {
        if let onPaste = coordinator?.parent.onPaste, onPaste(.general) { return }
        super.paste(sender)
    }

    /// A plain-text view turns Paste off when the clipboard holds only an image (a screenshot), so Cmd-V
    /// never reached `paste(_:)`. Where the field takes files, a file or an image keeps Paste on.
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), pastesFiles(from: .general) { return true }
        return super.validateUserInterfaceItem(item)
    }

    /// True when Cmd-V attaches what `pasteboard` holds: this field takes files and it holds a file or an image.
    func pastesFiles(from pasteboard: NSPasteboard) -> Bool {
        coordinator?.parent.onPaste != nil && ComposerAttachments.canAdd(from: pasteboard)
    }

    // MARK: Dropped files (WAG-345)

    /// Where the field takes files, a file dropped on the text attaches like a paste; the text view
    /// itself would type the file's path.
    private func attachesDrop(_ sender: NSDraggingInfo) -> Bool { attachesDrop(of: sender.draggingPasteboard) }

    /// True when this field attaches what is dropped from `pasteboard`: it takes files and the drag holds a file.
    func attachesDrop(of pasteboard: NSPasteboard) -> Bool {
        coordinator?.parent.onPaste != nil
            && pasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        attachesDrop(sender) ? .copy : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        attachesDrop(sender) ? .copy : super.draggingUpdated(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if attachesDrop(sender), let onPaste = coordinator?.parent.onPaste { return onPaste(sender.draggingPasteboard) }
        return super.performDragOperation(sender)
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { coordinator?.focusChanged(true) }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { coordinator?.focusChanged(false) }
        return ok
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        runEvidencePaste()
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.coordinator?.syncFocus(self)
        }
    }

    override func keyDown(with event: NSEvent) {
        // 36 = Return, 76 = keypad Enter.
        guard event.keyCode == 36 || event.keyCode == 76, let coordinator else {
            super.keyDown(with: event)
            return
        }
        let flags = event.modifierFlags
        let action = PromptBarLogic.returnKeyAction(
            shift: flags.contains(.shift),
            command: flags.contains(.command),
            hasMarkedText: hasMarkedText(),
            canSend: coordinator.parent.canSend
        )
        switch action {
        case .send: coordinator.parent.onSend()
        case .newline: insertText("\n", replacementRange: selectedRange())
        case .ignore: break
        case .passThrough: super.keyDown(with: event)
        }
    }
}

/// The one prompt bar (WAG-305): the growing field on its own row, and under it the tools on the left ("+",
/// "Let's discuss", "Show me more", "Ask for…") and the quiet buttons and Send on the right (request page
/// mockups, 2026-11-10: `.ans`, `.note`, `.ans .tools`, `.send`). Every composer builds it: the options dock, the
/// reply-only footer, the steps bar and the workspace column. It knows nothing of a composer or a doc: the host
/// gives it text, labels and actions.
struct PromptBarCore: View {
    @Binding var text: String
    let placeholder: String
    var quietLabels: [String] = []
    /// The primary label's forms, longest first; `[nil]` is the plain arrow.
    var pillLabels: [String?] = [nil]
    let canSend: Bool
    /// Whether Return sends; `nil` follows `canSend`. False when the button alone may decide (WAG-328).
    var returnSends: Bool? = nil
    /// The arrow stays beside the label when comments or an edit go with the reply.
    var keepsArrow = false
    var quietHelp: (String) -> String? = { _ in nil }
    var onQuiet: (String) -> Void = { _ in }
    let onSend: () -> Void
    var onEdit: () -> Void = {}
    /// The files of the next reply (WAG-345). `nil` keeps a plain "+" that does nothing.
    var files: ComposerAttachments? = nil
    /// "Ask for…" at the left of the send row, after "+" (C5). `nil` where the host offers no detail panel.
    var askFor: AskForButton? = nil
    /// The quick replies at the left of the tools row, before "Ask for…" (mockup B `.side-tools`): the same
    /// replies as the top of the "Ask for…" panel. Empty where the host has none.
    var quickReplies: [QuickReply] = []
    var onQuickReply: (QuickReply) -> Void = { _ in }
    @Binding var isFocused: Bool

    /// The "Ask for…" button: it opens the ask-for-detail panel and, while the panel is open, shows as on and closes it.
    struct AskForButton {
        var isOpen: Bool
        var toggle: () -> Void
    }

    /// Height of the column or pane the bar sits in; the field grows to 40 % of it (C6).
    @Environment(\.answerBoxAvailableHeight) private var availableHeight
    /// Set while the service is paused: the bar is off and this line says why.
    @Environment(\.pausedAnswerLine) private var pausedLine
    @State private var barWidth: CGFloat = 0
    /// What the field's own text view last measured; `nil` before its first measure.
    @State private var fieldMetrics: PromptBarLogic.FieldMetrics?
    /// The labels' widths in their real text styles, so the plan never leaves a button short (C7).
    @State private var quietLabelWidths: [String: CGFloat] = [:]
    @State private var pillLabelWidths: [String: CGFloat] = [:]

    /// The measured widths; Send counts its arrow only when the arrow shows beside the label.
    private var controlWidths: PromptBarLogic.ControlWidths {
        let measured = PromptBarLogic.ControlWidths.measured(quiet: quietLabelWidths, pill: pillLabelWidths)
        let arrow: CGFloat = keepsArrow ? 0 : 6 + 12
        return PromptBarLogic.ControlWidths(
            quiet: measured.quiet, send: { label in label == nil ? measured.send(nil) : measured.send(label) - arrow })
    }

    private var leadingWidth: CGFloat {
        PromptBarLogic.leadingWidth(
            askForLabelWidth: askFor == nil ? nil
                : quietLabelWidths[PromptBarLogic.askForLabel] ?? PromptBarLogic.quietButtonWidth(PromptBarLogic.askForLabel))
    }

    private var controlsPlan: PromptBarLogic.ControlsPlan {
        PromptBarLogic.controlsPlan(
            rowWidth: barWidth > 0 ? barWidth - PromptBarLogic.barPadding * 2 : nil,
            quietLabels: quietLabels,
            pillLabels: pillLabels,
            widths: controlWidths,
            leadingWidth: leadingWidth,
            leadingLabels: quickReplies.map(\.label)
        )
    }

    var body: some View {
        let plan = controlsPlan
        // The width is read from a zero-height sibling that only ever sees the
        // width offered to the bar, never the width the content asks for.
        // Measuring the content itself feeds the field's own width back into
        // the layout and never settles.
        VStack(spacing: 0) {
            Color.clear
                .frame(height: 0)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { barWidth = $0 }
            if let pausedLine {
                Text(pausedLine)
                    .knockTextStyle(PromptBarStyle.note)
                    .foregroundColor(Theme.Colors.ink3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(EdgeInsets(top: PromptBarLogic.barTopPadding, leading: PromptBarLogic.barPadding, bottom: 0, trailing: PromptBarLogic.barPadding))
            }
            if let files { AttachmentChipsRow(files: files) }
            barContent(plan).disabled(pausedLine != nil)
        }
        .background(alignment: .topLeading) { labelProbe }
        .modifier(OptionalAttachDrop(files: files))
    }

    /// The field always has its own row, with the tools and Send under it: the bar keeps one shape while Send
    /// names the pick, and the placeholder never wraps beside the controls (request page, 2026-11-10; decision
    /// 2026-11-10 "Field on its own row").
    private func barContent(_ plan: PromptBarLogic.ControlsPlan) -> some View {
        PromptBarRowLayout {
            HStack(spacing: PromptBarLogic.controlGap) {
                attachButton
                ForEach(quickReplies.filter { plan.leadingLabels.contains($0.label) }) { reply in
                    PromptQuietButton(label: reply.label, help: nil, action: { onQuickReply(reply) })
                }
                if let askFor {
                    PromptQuietButton(
                        label: PromptBarLogic.askForLabel, help: askFor.isOpen ? "Back to options (Esc)" : "Ask for more detail (?)",
                        isOn: askFor.isOpen, action: askFor.toggle)
                }
                if !plan.overflowLabels.isEmpty {
                    PromptOverflowMenu(labels: plan.overflowLabels, action: overflowAction)
                }
            }
            .frame(height: PromptBarLogic.sendHeight)
            .fixedSize()
            field
            HStack(spacing: PromptBarLogic.controlGap) {
                ForEach(plan.quietLabels, id: \.self) { label in
                    PromptQuietButton(label: label, help: quietHelp(label), action: { onQuiet(label) })
                }
                sendButton(plan)
            }
            .fixedSize()
        }
        .padding(EdgeInsets(
            top: PromptBarLogic.barTopPadding, leading: PromptBarLogic.barPadding,
            bottom: PromptBarLogic.barBottomPadding, trailing: PromptBarLogic.barPadding))
        .frame(maxWidth: .infinity)
    }

    /// A tool in the "⋯" menu: a quick reply sends its words, any other label is the host's quiet button.
    private func overflowAction(_ label: String) {
        if let reply = quickReplies.first(where: { $0.label == label }) { onQuickReply(reply) } else { onQuiet(label) }
    }

    /// Every tool label and every form of the primary label, laid out unseen in the buttons' text styles: the
    /// plan reads their real widths, not an estimate.
    private var labelProbe: some View {
        ZStack(alignment: .topLeading) {
            ForEach(quietLabels + quickReplies.map(\.label) + (askFor == nil ? [] : [PromptBarLogic.askForLabel]), id: \.self) { label in
                Text(label)
                    .knockTextStyle(PromptBarStyle.tool)
                    .fixedSize()
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { quietLabelWidths[label] = $0 }
            }
            ForEach(pillLabels.compactMap { $0 }, id: \.self) { label in
                Text(label)
                    .knockTextStyle(PromptBarStyle.send)
                    .fixedSize()
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { pillLabelWidths[label] = $0 }
            }
        }
        .frame(width: 0, height: 0, alignment: .topLeading)
        .hidden()
        .accessibilityHidden(true)
    }

    // MARK: - Field

    /// The bordered field (mockup `.note`): 1 pt `line2`, radius 9, text 12.5 `ink`, placeholder 12.5 `quiet`,
    /// 9 / 12 from the border to the text. The text view inside grows with its text and scrolls past its cap (C6).
    /// The text view sets each line 18 tall with the extra above the glyphs; the placeholder's own line is
    /// 12.5 × 1.21, so it moves down by the difference to sit on the same line as typed text.
    private static let placeholderLeading = max(0, PromptBarLogic.lineHeight - PromptBarLogic.answerFontSize * Theme.Typography.sansNaturalLineHeight)

    private var field: some View {
        ZStack(alignment: .topLeading) {
            if ComposerPlaceholder.isVisible(draftText: text) {
                // Wraps, never cut with "…" (C6): the field grows to hold it.
                Text(placeholder)
                    .font(PromptBarStyle.note.font)
                    .foregroundColor(Theme.AskDoc.Colors.quiet)
                    .lineSpacing(Self.placeholderLeading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(EdgeInsets(
                        top: PromptBarLogic.textInset.height + Self.placeholderLeading, leading: PromptBarLogic.textInset.width,
                        bottom: PromptBarLogic.textInset.height, trailing: PromptBarLogic.textInset.width
                    ))
                    .allowsHitTesting(false)
            }
            PromptTextView(
                text: $text,
                isFocused: $isFocused,
                canSend: returnSends ?? canSend,
                onSend: onSend,
                onEdit: onEdit,
                onPaste: files.map { files in { files.add(from: $0) } },
                maxHeight: PromptBarLogic.maxFieldHeight(availableHeight: availableHeight),
                onMeasure: { if fieldMetrics != $0 { fieldMetrics = $0 } },
                font: PromptBarLogic.answerFont
            )
        }
        .padding(EdgeInsets(
            top: PromptBarLogic.fieldBoxPadding.height, leading: PromptBarLogic.fieldBoxPadding.width,
            bottom: PromptBarLogic.fieldBoxPadding.height, trailing: PromptBarLogic.fieldBoxPadding.width))
        .overlay(
            RoundedRectangle(cornerRadius: PromptBarLogic.fieldRadius)
                .strokeBorder(Theme.Colors.line2, lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture { isFocused = true }
    }

    // MARK: - Controls

    /// The "+" (WAG-345): a click opens the file picker. Where a host gives no files it stays a plain icon.
    @ViewBuilder
    private var attachButton: some View {
        if let files {
            PromptAttachMenu(files: files)
        } else {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .regular))
                .foregroundColor(Theme.AskDoc.Colors.quiet)
                .frame(width: PromptBarLogic.attachWidth, height: PromptBarLogic.sendHeight)
        }
    }

    /// Send (mockup `.send`): `ink` fill, white 12.5 / 600, radius 8, 34 tall with 12 pt sides; off (`.send.off`):
    /// `line2` fill, white text.
    private func sendButton(_ plan: PromptBarLogic.ControlsPlan) -> some View {
        let pill = plan.sendPillLabel
        // The full words stay in the tooltip and for VoiceOver when the row shows the short form.
        let fullLabel = pillLabels.first.flatMap { $0 } ?? "Send"
        return Button(action: onSend) {
            HStack(spacing: 6) {
                if let pill {
                    Text(pill)
                        .knockTextStyle(PromptBarStyle.send)
                        .lineLimit(1)
                        .fixedSize()
                }
                if pill == nil || keepsArrow {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 12, weight: .bold))
                }
            }
            .foregroundColor(Theme.Colors.win)
            .padding(.horizontal, pill == nil ? 0 : PromptBarLogic.sendHorizontalPadding)
            .frame(minWidth: PromptBarLogic.sendHeight)
            .frame(height: PromptBarLogic.sendHeight)
            .background(canSend && pausedLine == nil ? Theme.Colors.ink : Theme.Colors.line2)
            .cornerRadius(Theme.Radius.promptButton)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable).pointerCursor()
        // Its natural width, always: the row gives way around it, never through it.
        .fixedSize()
        .layoutPriority(1)
        .accessibilityLabel(fullLabel)
        .help(canSend ? (fullLabel == pill || pill == nil ? "Send ⌘↵" : "\(fullLabel) ⌘↵") : "")
    }
}

/// The answer area's text styles (request page mockups, 2026-11-10). Private to the bar: no other view uses them.
enum PromptBarStyle {
    /// Tools row (`.ans .tools`): Inter Tight 400 12.
    static let tool = Theme.TextStyle(font: .custom(Theme.FontFamily.sans, size: 12), size: 12, lineHeight: nil, letterSpacing: nil)
    /// Send (`.send`): Inter Tight 600 12.5.
    static let send = Theme.TextStyle(
        font: .custom(Theme.FontFamily.sans, size: 12.5).weight(.semibold), size: 12.5, lineHeight: nil, letterSpacing: nil)
    /// The field's placeholder (`.note`): Inter Tight 400 12.5.
    static let note = Theme.TextStyle(
        font: .custom(Theme.FontFamily.sans, size: PromptBarLogic.answerFontSize), size: PromptBarLogic.answerFontSize,
        lineHeight: nil, letterSpacing: nil)
}

/// The prompt bar of a composer (HAIL-77): the shared bar, fed by the composer's draft, picks and labels.
struct PromptBarView: View {
    @ObservedObject var composer: ComposerViewModel
    /// Observed so the bar follows every keystroke; the column above does not (HAIL-220).
    @ObservedObject var draft: ComposerDraftText
    @ObservedObject var sendFlow: SendFlowController
    /// The files of the next reply, observed so a chip appears at once and the button wakes (WAG-345).
    @ObservedObject var files: ComposerAttachments
    let commentCount: Int
    let placeholder: String
    /// True for the options card, which accepts the recommendation for a
    /// comments-only reply (its old "Accept recommendation + N comments").
    var acceptsRecommendationWithComments: Bool = false
    /// The "Ask for…" button at the left of the send row (C5); it opens the ask-for-detail panel. The old quiet
    /// "Ask for more detail" button is the same action, so it is gone.
    var showsDetailButton: Bool = true
    var onOpenReview: (() -> Void)? = nil
    /// A reply-only ask's suggested reply (WAG-336): "Use this reply" sits in the send row while the field is empty
    /// (spec section 9) and puts the text in the field, caret at its end.
    var suggestedReply: String? = nil
    /// The simple ask's bar (WAG-257): the button reads "Decide: <option>" once an option is chosen.
    var decides = false
    @Binding var isFocused: Bool
    /// "Change" / "Request changes" was pressed with no note: the field asks what should change until a note exists.
    @State private var asksWhatChanges = false

    private var canSend: Bool {
        PromptBarLogic.canSend(
            hasChoice: composer.hasPick || composer.isDiscussing || composer.hasPrePick,
            hasMessage: composer.currentMessage != nil,
            commentCount: commentCount,
            hasEdit: hasEdit,
            hasFiles: composer.hasFiles
        )
    }

    /// Nothing but the plan round's pre-pick: the button then names it, and only a press on that button decides
    /// (WAG-328). Return and ⌘↵ do nothing.
    private var prePickOnly: Bool { composer.isPrePickOnly(commentCount: commentCount, hasEdit: hasEdit) }

    /// The person's in-place edit travels with this reply (HAIL-168).
    private var hasEdit: Bool { sendFlow.attachedEdit != nil }

    /// Several ticks go out together; the button says how many (HAIL-123).
    private var pickCount: Int { composer.isMultiSelect ? composer.selectedOptionIds.count : 0 }

    private var quietLabels: [String] {
        PromptBarLogic.quietLabels(
            hasOpenReview: onOpenReview != nil, hasDetail: false, planSecondary: composer.planSecondaryLabel,
            suggestsReply: suggestedReply != nil)
    }

    /// The short title of the one option chosen, for "Decide: <title>".
    private var decideTitle: String? {
        guard composer.isOptionsCase, !composer.isMultiSelect, let id = composer.selectedOptionId else { return nil }
        let pool = composer.selectedFromFirstOptions ? composer.firstOptions : composer.options
        return pool.first { $0.id == id }?.displayTitle
    }

    /// The primary label's forms, longest first ("Approve section + 1 comment", "Approve + 1 comment", "Approve").
    private var pillLabels: [String?] {
        if prePickOnly {
            return PromptBarLogic.prePickPillLabels(title: decideTitle)
        }
        // A plan round with nothing picked and nothing to send shows the plain arrow, as any request does (WAG-336).
        if PromptBarLogic.plansBareArrow(isPlanRound: composer.planStage != nil, hasOptions: composer.isOptionsCase, canSend: canSend) {
            return [nil]
        }
        if composer.talksOnMany, commentCount == 0, composer.currentMessage == nil, !hasEdit {
            return [PromptBarLogic.sendLabel]
        }
        // Files alone, with no pick, keep the talk going (WAG-345).
        if composer.sendsDiscuss, !composer.isDiscussing, composer.currentMessage == nil, composer.hasFiles,
           commentCount == 0, !hasEdit {
            return [PromptBarLogic.keepTalkingLabel]
        }
        return PromptBarLogic.sendPillLabels(
            commentCount: commentCount, pickCount: pickCount,
            planLabel: composer.planPrimaryLabel, shortPlanLabel: composer.planShortPrimaryLabel, hasEdit: hasEdit,
            decideTitle: decides ? decideTitle : nil,
            isFeedback: !composer.options.isEmpty && !composer.isMultiSelect && !composer.hasPick && composer.currentMessage != nil && !composer.supportsDiscuss,
            discuss: PromptBarLogic.discussLabels(leaning: composer.leaningPositions, ruledOut: composer.ruledOutPositions),
            asks: (composer.sendsDiscuss && !composer.isDiscussing) || (composer.talksOnMany && composer.currentMessage != nil),
            sendsComments: sendFlow.sendsReviewComments || composer.talksOnMany,
            isMany: composer.isMultiSelect,
            withChanges: composer.withChangesKind,
            // The plain decision names the pick, "Send: <option> ↵" (mockups, 2026-11-10); a review keeps "Decide".
            sendTitle: decides && !composer.isReview ? decideTitle : nil)
    }

    /// "Let's discuss" and "Show me more" in the tools row: the quick replies of the "Ask for…" panel, wherever
    /// the bar shows "Ask for…".
    private var quickReplies: [QuickReply] { showsDetailButton ? QuickReply.inSendRow : [] }

    var body: some View {
        VStack(spacing: 0) {
            if let edit = sendFlow.attachedEdit {
                editChip(edit)
            }
            PromptBarCore(
                text: Binding(get: { composer.draftText }, set: { composer.draftText = $0 }),
                placeholder: composer.currentMessage == nil && asksWhatChanges ? PlanText.whatShouldChange : placeholder,
                quietLabels: quietLabels,
                pillLabels: pillLabels,
                canSend: canSend,
                returnSends: canSend && !prePickOnly,
                keepsArrow: commentCount > 0 || hasEdit,
                quietHelp: quietHelp,
                onQuiet: quietAction,
                onSend: { performSend() },
                onEdit: composer.replyEdited,
                files: files,
                askFor: showsDetailButton
                    ? .init(isOpen: composer.isAskingForDetail, toggle: {
                        if composer.isAskingForDetail { composer.cancelAskingForDetail() } else { composer.beginAskingForDetail(fromDots: true) }
                    })
                    : nil,
                quickReplies: quickReplies,
                onQuickReply: { sendFlow.quickReply($0) },
                isFocused: $isFocused
            )
        }
        .onAppear {
            applyEvidenceDraft()
            applyEvidenceAttachments()
            EvidenceWindowSnapshot.scheduleIfRequested(delay: 5)
        }
    }

    /// `KNOCK_EVIDENCE_ATTACH=<path>,<path>` (WAG-345 evidence hook): attaches those files on appear, and
    /// `KNOCK_EVIDENCE_ATTACH_SEND=<seconds>` presses Send after that long, since a capture cannot drop or
    /// pick a file. Never set outside evidence runs.
    private func applyEvidenceAttachments() {
        let environment = ProcessInfo.processInfo.environment
        guard files.isEmpty, let list = environment["KNOCK_EVIDENCE_ATTACH"], !list.isEmpty else { return }
        files.add(urls: list.split(separator: ",").map { URL(fileURLWithPath: String($0)) })
        if let raw = environment["KNOCK_EVIDENCE_ATTACH_SEND"], let seconds = Double(raw) {
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { performSend() }
        }
    }

    /// "Your edit · v2 · 2 passages changed" with Remove (HAIL-168). Remove drops the edit from the
    /// reply; the revision stays in the case's history.
    private func editChip(_ edit: SendFlowController.AttachedEdit) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "pencil.line")
                .font(.system(size: 11))
                .foregroundColor(Theme.Colors.ds)
            Text(Self.editChipLabel(revision: edit.revision, passages: edit.passagesChanged))
                .knockTextStyle(Theme.Typography.versionChipLabel11w600)
                .foregroundColor(Theme.Colors.ds)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button(action: sendFlow.removeEdit) {
                Text("Remove")
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .foregroundColor(Theme.Colors.ink3)
            }
            .buttonStyle(.plain).pointerCursor()
            .help("Send the reply without your edit. v\(edit.revision) stays in history.")
        }
        .padding(EdgeInsets(top: 5, leading: 10, bottom: 5, trailing: 10))
        .background(Theme.Colors.dsSoft)
        .cornerRadius(Theme.Radius.chip)
        .padding(EdgeInsets(top: 8, leading: 8, bottom: 0, trailing: 8))
    }

    static func editChipLabel(revision: Int, passages: Int) -> String {
        "Your edit · v\(revision) · \(passages) \(passages == 1 ? "passage" : "passages") changed"
    }

    /// `KNOCK_EVIDENCE_DRAFT_TEXT=<text>` (HAIL-77 evidence hook): fills an
    /// empty draft on appear so a capture can show a long reply. `\n` in the
    /// value becomes a newline. Never set outside evidence runs.
    private func applyEvidenceDraft() {
        guard composer.draftText.isEmpty,
              let text = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_DRAFT_TEXT"], !text.isEmpty
        else { return }
        composer.draftText = text.replacingOccurrences(of: "\\n", with: "\n")
    }

    private func quietHelp(_ label: String) -> String? {
        guard label == composer.planSecondaryLabel else { return nil }
        return "Write what should change, then press \(label)"
    }

    private func quietAction(_ label: String) {
        switch label {
        case PromptBarLogic.askForDetailLabel:
            composer.beginAskingForDetail()
        case PromptBarLogic.openReviewLabel:
            onOpenReview?()
        case ComposerFooterView.useSuggestedReply:
            // Filling the field is the person's act; nothing sends until they press the button (WAG-328).
            if let suggestedReply { composer.draftText = suggestedReply; isFocused = true }
        case composer.planSecondaryLabel:
            // "Change" / "Request changes" on a design or spec round (HAIL-151): sends the note as a
            // change request; with no note yet it puts the cursor in the field and the field asks what should change.
            if composer.currentMessage == nil { asksWhatChanges = true; isFocused = true } else { sendFlow.sendPlanChange() }
        default:
            break
        }
    }

    /// The button. Every state sends what its title says: a pick, comments or a note go through `send()`, which
    /// never swaps in the recommendation (WAG-328). With only the pre-pick, the title names it ("Decide: X"),
    /// so pressing it makes the pick.
    private func performSend() {
        guard canSend else { return }
        if prePickOnly { composer.confirmPrePick() }
        sendFlow.send()
    }
}

/// A tool of the answer row (mockup `.ans .tools span`): plain text, Inter Tight 400 12, `ink3`, no box; `ink`
/// on hover and while on.
private struct PromptQuietButton: View {
    let label: String
    let help: String?
    /// A toggle that is on ("Ask for…" while its panel is open): it stays `ink`.
    var isOn = false
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .knockTextStyle(PromptBarStyle.tool)
                .foregroundColor(hovered || isOn ? Theme.Colors.ink : Theme.Colors.ink3)
                // Never cut with "…" (C7): a button that does not fit goes into the "More" menu instead.
                .lineLimit(1)
                .fixedSize()
                .frame(height: PromptBarLogic.sendHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
        .onHover { hovered = $0 }
        .help(help ?? "")
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// A quiet "⋯" menu holding the tools a narrow row cannot fit: plain, `ink3`, no box.
private struct PromptOverflowMenu: View {
    let labels: [String]
    let action: (String) -> Void
    @State private var hovered = false

    var body: some View {
        Menu {
            ForEach(labels, id: \.self) { label in
                Button(label) { action(label) }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .regular))
                .foregroundColor(hovered ? Theme.Colors.ink : Theme.Colors.ink3)
                .frame(width: PromptBarLogic.overflowWidth, height: PromptBarLogic.sendHeight)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .onHover { hovered = $0 }
        .help("More: \(labels.joined(separator: ", "))")
        .accessibilityLabel("More")
    }
}

/// The bar's rows: the field full width on top, then "+" and the tools left and the controls right, centred
/// on the row. Subviews: "+" and tools, field, controls.
struct PromptBarRowLayout: Layout {
    private struct Parts {
        var attach: CGSize
        var controls: CGSize
        var fieldWidth: CGFloat
        var field: CGSize
    }

    private func parts(width: CGFloat?, _ subviews: Subviews) -> Parts? {
        guard subviews.count == 3 else { return nil }
        let attach = subviews[0].sizeThatFits(.unspecified)
        let controls = subviews[2].sizeThatFits(.unspecified)
        let field = subviews[1].sizeThatFits(ProposedViewSize(width: width, height: nil))
        return Parts(attach: attach, controls: controls, fieldWidth: width ?? field.width, field: field)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil }
        guard let p = parts(width: width, subviews) else { return .zero }
        let controlsRow = max(p.attach.height, p.controls.height)
        let rowWidth = p.attach.width + PromptBarLogic.controlGap + p.controls.width
        return CGSize(width: width ?? max(p.fieldWidth, rowWidth), height: p.field.height + PromptBarLogic.rowGap + controlsRow)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let p = parts(width: bounds.width, subviews) else { return }
        subviews[1].place(
            at: CGPoint(x: bounds.minX, y: bounds.minY), proposal: ProposedViewSize(width: p.fieldWidth, height: p.field.height))
        let rowY = bounds.minY + p.field.height + PromptBarLogic.rowGap
        let rowHeight = max(p.attach.height, p.controls.height)
        subviews[0].place(at: CGPoint(x: bounds.minX, y: rowY + (rowHeight - p.attach.height) / 2), proposal: .init(p.attach))
        subviews[2].place(
            at: CGPoint(x: bounds.maxX - p.controls.width, y: rowY + (rowHeight - p.controls.height) / 2),
            proposal: .init(p.controls))
    }
}

/// Applies the drop target only where a host gave files.
private struct OptionalAttachDrop: ViewModifier {
    let files: ComposerAttachments?

    func body(content: Content) -> some View {
        if let files { content.attachesDroppedFiles(to: files) } else { content }
    }
}

/// The "+" of the bar (WAG-345): quiet, no box, as tall as the tools row (not in the mockups, kept). A click
/// opens the file picker at once; "Attach files" is its tooltip (WAG-346). A plain button: a `Menu` adds its own
/// inset.
private struct PromptAttachMenu: View {
    @ObservedObject var files: ComposerAttachments
    @State private var hovered = false

    var body: some View {
        Button { files.add(urls: AttachPicker.pick()) } label: {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .regular))
                .foregroundColor(hovered ? Theme.Colors.ink : Theme.AskDoc.Colors.quiet)
                .frame(width: PromptBarLogic.attachWidth, height: PromptBarLogic.sendHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
        .frame(width: PromptBarLogic.attachWidth, height: PromptBarLogic.sendHeight)
        .onHover { hovered = $0 }
        .help("Attach files")
        .accessibilityLabel("Attach files")
    }
}

/// Height of the column or pane that holds an answer box (C6); `nil` where the host does not say.
private struct AnswerBoxAvailableHeightKey: EnvironmentKey {
    static let defaultValue: CGFloat? = nil
}

extension EnvironmentValues {
    var answerBoxAvailableHeight: CGFloat? {
        get { self[AnswerBoxAvailableHeightKey.self] }
        set { self[AnswerBoxAvailableHeightKey.self] = newValue }
    }
}
