import AppKit
import Foundation

/// One pin being placed: a region has been drawn or clicked, and its note
/// popover is open, but it does not "count as a comment" (docs/stories/
/// KNOCK-11.md) until saved with a non-empty note.
struct DraftPin: Equatable {
    let captureId: String
    var rect: Rect
    var text: String
    /// `.point` for a click, `.region` for a drag (HAIL-83, reported once the
    /// comment is saved).
    var variant: UsageVariant = .region
    /// HAIL-240: the read of the page element under the pin, running in the background (live
    /// prototype only). Not part of `==`: a task has no value to compare.
    var element: Task<PageElementContext?, Never>? = nil

    static func == (lhs: DraftPin, rhs: DraftPin) -> Bool {
        lhs.captureId == rhs.captureId && lhs.rect == rhs.rect && lhs.text == rhs.text && lhs.variant == rhs.variant
    }
}

/// A capture that does not exist yet (HAIL-65): the operator has dragged a
/// region over the live prototype, and its image is being taken in the
/// background. It becomes a real capture only when its first comment is saved.
struct PendingCapture {
    let id: String
    let revision: Int
    let takenAt: Date
    let snapshot: Task<NSImage?, Never>
    let page: PageViewport?
    var view: Task<PageView?, Never>? = nil
}

/// Which side asked for a comment to be revealed (HAIL-75): a click in the
/// list scrolls the artifact to the pin; a click on a pin scrolls the list to
/// the card. `token` makes two requests for the same comment distinct.
struct CommentRevealRequest: Equatable {
    enum Origin: Equatable { case list, artifact }
    let commentId: String
    let origin: Origin
    let token: Int
}

/// Holds one case's Comment-mode state for the review workspace: the
/// captures taken so far (with their images — kept here, not in
/// `CommentsModel`, so that model stays a plain, AppKit-free value type),
/// their saved pins, and the one pin currently being drafted.
///
/// Scoped per case: `ReviewViewModel` owns one instance, created fresh each
/// time a case's review workspace is opened.
@MainActor
final class CommentsSessionStore: ObservableObject {
    @Published private(set) var model = CommentsModel()
    @Published private(set) var imagesByCaptureId: [String: NSImage] = [:]
    @Published private(set) var draftPin: DraftPin?
    /// Where a saved comment is reported (HAIL-83); set by the owner.
    var usage: UsageReporter?
    /// Which capture the stage and its new pins target (HAIL-35 contract:
    /// "Selecting a group ... shows that capture on the stage with its pins;
    /// new pins go on the capture shown"). `nil` means "the latest capture" -
    /// the default the instant a new capture is taken, so a plain "C" press
    /// never needs an explicit select to land on its own fresh capture.
    @Published private(set) var selectedCaptureId: String?
    /// True once `addScreenshotsCaptures` has run (HAIL-40): every capture
    /// in this session is one image of a `screenshots` artifact, so its
    /// group header and reply-payload note read "Screen N[ · caption]"
    /// instead of "Capture N". Kept here rather than passed around
    /// separately, since it is a property of *this session's* captures, the
    /// same way `imagesByCaptureId` is.
    @Published private(set) var isScreenshotsCase = false
    /// A `screenshots` artifact's per-image caption, keyed by capture id
    /// (HAIL-40). Kept out of `CommentsModel` the same way `imagesByCaptureId`
    /// is, so that model stays a plain, caption/platform-free value type.
    @Published private(set) var captionsByCaptureId: [String: String] = [:]
    /// A `screenshots` image's decision item id (the `item` of the image), keyed by capture id.
    private(set) var itemsByCaptureId: [String: String] = [:]
    /// The captures of the decision on screen. While set, the filmstrip, the dots and the arrows show only these
    /// (`galleryScreens`). `nil` shows every screen.
    @Published private(set) var decisionGroupIds: [String]?
    /// WAG-413: a gallery screen's position (0-based) in its set, so Compare can pair a screen with the
    /// same screen of the revision before. Set when a set's captures are made and kept with them.
    private(set) var screenIndexByCaptureId: [String: Int] = [:]
    /// WAG-413: the earlier revision's still while Compare is on. A click in the list on one of its
    /// comments does not switch the stage to it: it is already on screen.
    var activeCompareBeforeId: String?
    /// WAG-413: captures Compare made for an earlier revision. They are not screens of the gallery.
    private(set) var compareCaptureIds: Set<String> = []
    /// The revision whose images the gallery shows (HAIL-114). Captures of an
    /// earlier revision that still hold comments stay in `model`, but are not screens.
    @Published private(set) var screensRevision: Int?

    /// The one highlighted comment, on both the list and the artifact
    /// (HAIL-75). `nil` when nothing is highlighted.
    @Published private(set) var selectedCommentId: String?
    @Published private(set) var revealRequest: CommentRevealRequest?
    /// The comment whose card is being edited in place. While set, Esc belongs
    /// to that edit, not to clearing the highlight.
    @Published var editingCommentId: String?
    private var revealToken = 0

    /// The comment whose inline card is open on the artifact (HAIL-75). At most
    /// one; never set while a new note is being drafted.
    @Published private(set) var openCommentId: String?
    /// The comment whose pin the pointer is over right now.
    @Published private(set) var hoveredCommentId: String?
    /// The comment whose read-only preview is showing: `hoveredCommentId`
    /// once the pointer has stayed for `hoverPreviewDelay`.
    @Published private(set) var previewCommentId: String?
    var hoverPreviewDelay: Duration = .milliseconds(150)
    private var previewTask: Task<Void, Never>?

    /// The capture being drafted on, before it holds any comment (HAIL-65).
    @Published private(set) var pending: PendingCapture?
    /// Captures that are the artifact's own image (a screenshot or a
    /// `screenshots` screen). They exist before any comment and are never
    /// pruned when empty; they are still not listed or counted while empty.
    private(set) var baseCaptureIds: Set<String> = []
    /// Saved live captures whose snapshot has not arrived yet (HAIL-112).
    private var imageTasks: [String: Task<Void, Never>] = [:]
    /// A visible note when a saved comment's picture could not be taken.
    @Published private(set) var captureNotice: String?
    /// WAG-307: the one plain line Show leaves under a comment whose part of the page is not on screen.
    @Published private(set) var showNotice: (commentId: String, text: String)?

    func setShowNotice(_ text: String?, for commentId: String) {
        showNotice = text.map { (commentId: commentId, text: $0) }
    }

    /// The gallery's screens: a `screenshots` case's captures of the shown revision, in order.
    /// Any other case has no gallery, so every capture counts.
    var screens: [CaptureRecord] {
        guard isScreenshotsCase, let screensRevision else { return model.captures }
        return model.captures.filter { $0.revision == screensRevision && baseCaptureIds.contains($0.id) }
    }

    /// The screens the filmstrip, the dots and the arrows show: the decision's images while a decision is on
    /// screen, else every screen. A group that no longer matches the screens (a new revision) shows every screen.
    var galleryScreens: [CaptureRecord] {
        let all = screens
        guard let ids = decisionGroupIds else { return all }
        let group = all.filter { ids.contains($0.id) }
        return group.isEmpty ? all : group
    }

    /// The label of each screen in `galleryScreens`, in order: its variant badge ("A2") and whether it is shared.
    var galleryLabels: [ScreenRowLabel] {
        let gallery = galleryScreens
        return ScreenRowLabels.labels(
            captions: gallery.map { captionsByCaptureId[$0.id] },
            items: gallery.map { itemsByCaptureId[$0.id] },
            setCaptions: screens.map { captionsByCaptureId[$0.id] },
            setItems: screens.map { itemsByCaptureId[$0.id] })
    }

    /// The label of the screen on show, when it is in the gallery.
    var currentLabel: ScreenRowLabel? {
        guard let id = currentCapture?.id, let index = galleryScreens.firstIndex(where: { $0.id == id }) else { return nil }
        return galleryLabels[index]
    }

    /// The decision on screen shows only `indexes` (0-based, in `screens`); `nil` shows every screen.
    func showDecisionGroup(_ indexes: [Int]?) {
        let all = screens
        let ids = indexes.map { $0.compactMap { all.indices.contains($0) ? all[$0].id : nil } }
        let next = ids?.isEmpty == true ? nil : ids
        if next != decisionGroupIds { decisionGroupIds = next }
    }

    /// The `item` of each image of the set, in order, once the set is loaded. Skips a list of another length.
    func setScreenItems(_ items: [String?]) {
        let all = screens
        guard items.count == all.count else { return }
        for (capture, item) in zip(all, items) {
            let trimmed = item?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            itemsByCaptureId[capture.id] = trimmed.isEmpty ? nil : trimmed
        }
    }

    /// WAG-381: the `item` of the images of the set at `revision`, once all of them are loaded; `nil` otherwise.
    func items(ofSet revision: Int) -> [String?]? {
        let screens = screens
        guard !screens.isEmpty, screens.allSatisfy({ $0.revision == revision }) else { return nil }
        return screens.map { itemsByCaptureId[$0.id] }
    }

    /// WAG-381: the captions of the images of the set at `revision`, once all of them are loaded; `nil` otherwise.
    /// The box and full size read the same set, so both follow a decision with it.
    func captions(ofSet revision: Int) -> [String?]? {
        let screens = screens
        guard !screens.isEmpty, screens.allSatisfy({ $0.revision == revision }) else { return nil }
        return screens.map { captionsByCaptureId[$0.id] }
    }

    /// Captures with at least one comment: the only ones the UI lists.
    var commentedCaptures: [CaptureRecord] { model.commentedCaptures }

    /// The number the next pin gets: case-wide (HAIL-75).
    var nextPinNumber: Int { model.comments.count + 1 }

    /// Highlights a comment on both sides (HAIL-75). From the list, a comment
    /// on another screen of a screenshot set switches to that screen; on a
    /// live prototype it returns to the live page, where every pin is drawn.
    func selectComment(id: String, origin: CommentRevealRequest.Origin) {
        guard let comment = model.comments.first(where: { $0.id == id }) else { return }
        if origin == .list, currentCapture?.id != comment.captureId, comment.captureId != activeCompareBeforeId {
            if baseCaptureIds.contains(comment.captureId) {
                selectCapture(id: comment.captureId)
            } else {
                clearSelection()
            }
        }
        selectedCommentId = id
        openComment(id: id)
        revealToken += 1
        revealRequest = CommentRevealRequest(commentId: id, origin: origin, token: revealToken)
    }

    /// Esc, or a click on empty space.
    func clearCommentSelection() {
        selectedCommentId = nil
        openCommentId = nil
    }

    /// Opens a comment's inline card (HAIL-75), closing any other one. Not
    /// while a new note is being drafted: that card is the one open card.
    func openComment(id: String) {
        guard draftPin == nil, model.comments.contains(where: { $0.id == id }) else { return }
        openCommentId = id
        setHoveredComment(nil)
    }

    /// Esc or a click outside: closes the card. The highlight stays and the
    /// saved text is untouched.
    func closeComment() {
        openCommentId = nil
    }

    /// Saves an edit from the inline card and closes it. An empty note is
    /// refused (a comment always has text); returns whether it was saved.
    @discardableResult
    func saveComment(id: String, text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, model.comments.contains(where: { $0.id == id }) else { return false }
        model.updateCommentText(id: id, text: trimmed)
        if openCommentId == id { openCommentId = nil }
        return true
    }

    /// The pointer entered (`id`) or left (`nil`) a pin. The preview follows
    /// after `hoverPreviewDelay` and goes at once on leaving.
    func setHoveredComment(_ id: String?) {
        guard hoveredCommentId != id else { return }
        hoveredCommentId = id
        previewTask?.cancel()
        previewTask = nil
        previewCommentId = nil
        guard let id, openCommentId != id else { return }
        let delay = hoverPreviewDelay
        previewTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self, self.hoveredCommentId == id else { return }
            self.previewCommentId = id
        }
    }

    /// A pin's own hover callback: entering sets it, leaving clears it only if
    /// this pin still holds it (another pin may have taken over already).
    func pinHoverChanged(_ id: String, inside: Bool) {
        if inside { setHoveredComment(id) } else if hoveredCommentId == id { setHoveredComment(nil) }
    }

    /// Whether a comment's region box shows on the artifact: only while it is
    /// hovered, open or highlighted (HAIL-75).
    func showsRegion(of id: String) -> Bool {
        hoveredCommentId == id || openCommentId == id || selectedCommentId == id
    }

    /// WAG-307: the still the artifact box shows for `revision` (the picked screen, else the first),
    /// with its pins. `nil` when this session holds no capture of that revision.
    func shownStill(revision: Int) -> CaptureRecord? {
        let ofRevision = model.captures.filter { $0.revision == revision && imagesByCaptureId[$0.id] != nil }
        if let selectedCaptureId, let picked = ofRevision.first(where: { $0.id == selectedCaptureId }) { return picked }
        return ofRevision.first
    }

    var currentCapture: CaptureRecord? {
        if let selectedCaptureId, let selected = model.captures.first(where: { $0.id == selectedCaptureId }) {
            return selected
        }
        return model.captures.last
    }
    var currentImage: NSImage? { currentCapture.flatMap { imagesByCaptureId[$0.id] } }
    var currentComments: [Comment] { currentCapture.map { model.comments(on: $0.id) } ?? [] }

    @discardableResult
    func addCapture(image: NSImage, revision: Int, takenAt: Date = Date(), scrollFraction: Double = 0, isBase: Bool = false) -> CaptureRecord {
        let record = model.addCapture(revision: revision, takenAt: takenAt, scrollFraction: scrollFraction)
        imagesByCaptureId[record.id] = image
        if isBase { baseCaptureIds.insert(record.id) }
        clearDraft()
        selectedCaptureId = nil
        return record
    }

    /// The Comment column's capture-group header, or the Interact column's
    /// "· Show" line: switches the stage to `id`'s capture without freezing a
    /// new one. A no-op for an unknown id (nothing to switch to) - drops any
    /// open draft, since a draft mid-note belongs to the capture it was
    /// started on, not whichever one is shown next.
    func selectCapture(id: String) {
        guard model.captures.contains(where: { $0.id == id }) else { return }
        clearDraft()
        selectedCaptureId = id
    }

    /// Back to "the latest capture" as the shown one (HAIL-65: switching to
    /// the live prototype drops any explicit pick of an older still).
    func clearSelection() {
        selectedCaptureId = nil
    }

    /// Loads a `screenshots` artifact's images as N captures, all at once, in
    /// order (HAIL-40): unlike a live prototype there is no "take a capture"
    /// step for a pre-existing set of images, so `n` ends up 1..N matching
    /// screen index 1..N. Selects the first screen, not the last - `addCapture`'s
    /// "always jump to the newest" default is for a live capture stream, but a
    /// screenshots case should open on screen 1. A no-op past the first call
    /// (mirrors `restore(from:)`), so a second SwiftUI init of the same case
    /// never doubles the captures.
    @discardableResult
    func addScreenshotsCaptures(images: [(image: NSImage, caption: String?)], revision: Int) -> [CaptureRecord] {
        // WAG-323: a store that holds an older revision's screens takes the new revision's items. Before,
        // full size kept the first revision's screens while it said "v3 · latest".
        if isScreenshotsCase, !screens.isEmpty, screensRevision != revision {
            return replaceScreenshotsCaptures(images: images, revision: revision)
        }
        // An ask can hold single screenshots beside the set, each under its own name. Their stills are
        // in this store too and are not screens, so they must not stop the set from loading. Before, a
        // store that held one of them never took the set: the box and full size showed the old stills.
        guard !isScreenshotsCase || screens.isEmpty else { return [] }
        guard !model.captures.contains(where: { $0.revision == revision }) else { return [] }
        isScreenshotsCase = true
        screensRevision = revision
        var records: [CaptureRecord] = []
        for item in images {
            let record = model.addCapture(revision: revision)
            baseCaptureIds.insert(record.id)
            screenIndexByCaptureId[record.id] = records.count
            imagesByCaptureId[record.id] = item.image
            if let caption = item.caption, !caption.isEmpty {
                captionsByCaptureId[record.id] = caption
            }
            records.append(record)
        }
        clearDraft()
        selectedCaptureId = records.first?.id
        return records
    }

    /// A newer revision of a `screenshots` artifact replaces the gallery in place (HAIL-114).
    /// Screens of the old revision that hold no comment go. Commented ones stay with their pins
    /// (a pin stays on the revision it was made on) but leave the gallery. The screen the operator
    /// was on stays selected by index, clamped to the new count.
    @discardableResult
    func replaceScreenshotsCaptures(images: [(image: NSImage, caption: String?)], revision: Int) -> [CaptureRecord] {
        guard isScreenshotsCase, !screens.isEmpty else {
            return addScreenshotsCaptures(images: images, revision: revision)
        }
        guard screensRevision != revision else { return [] }
        let before = screens
        let index = currentCapture.flatMap { current in before.firstIndex { $0.id == current.id } } ?? 0
        clearDraft()
        let commented = Set(model.comments.map(\.captureId))
        for capture in before where !commented.contains(capture.id) {
            model.deleteCapture(id: capture.id)
            imagesByCaptureId[capture.id] = nil
            captionsByCaptureId[capture.id] = nil
            itemsByCaptureId[capture.id] = nil
            screenIndexByCaptureId[capture.id] = nil
            baseCaptureIds.remove(capture.id)
        }
        screensRevision = revision
        var records: [CaptureRecord] = []
        for item in images {
            let record = model.addCapture(revision: revision)
            baseCaptureIds.insert(record.id)
            screenIndexByCaptureId[record.id] = records.count
            imagesByCaptureId[record.id] = item.image
            if let caption = item.caption, !caption.isEmpty { captionsByCaptureId[record.id] = caption }
            records.append(record)
        }
        selectedCaptureId = records.isEmpty ? nil : records[min(index, records.count - 1)].id
        return records
    }

    /// A capture's number among the gallery's screens (HAIL-114), else its own `n`.
    /// A capture Compare made for an earlier revision takes its place in that revision's set (WAG-413).
    private func screenNumber(of capture: CaptureRecord) -> Int {
        if let index = screens.firstIndex(where: { $0.id == capture.id }) { return index + 1 }
        if compareCaptureIds.contains(capture.id), let index = screenIndexByCaptureId[capture.id] { return index + 1 }
        return capture.n
    }

    // MARK: - Compare (WAG-413)

    /// The still of screen `screenIndex` of `revision`, when this session holds it with its image: a
    /// gallery screen that kept its pins, or one Compare loaded before. A single screenshot is screen 0.
    func compareStill(revision: Int, screenIndex: Int) -> CaptureRecord? {
        model.captures.first {
            $0.revision == revision && baseCaptureIds.contains($0.id) && imagesByCaptureId[$0.id] != nil
                && (screenIndexByCaptureId[$0.id] ?? 0) == screenIndex
        }
    }

    /// Adds the earlier revision's still for Compare. It leaves the shown capture and any draft alone,
    /// and it is not a screen of the gallery: it is listed only once it holds a comment.
    @discardableResult
    func addCompareStill(image: NSImage, revision: Int, screenIndex: Int, caption: String?) -> CaptureRecord {
        let shown = selectedCaptureId ?? currentCapture?.id
        let record = model.addCapture(revision: revision)
        baseCaptureIds.insert(record.id)
        compareCaptureIds.insert(record.id)
        screenIndexByCaptureId[record.id] = screenIndex
        imagesByCaptureId[record.id] = image
        if let caption, !caption.isEmpty { captionsByCaptureId[record.id] = caption }
        selectedCaptureId = shown
        return record
    }

    /// What a comment on `captureId` is made on, for the usage log (WAG-413).
    func artifactKind(ofCapture captureId: String) -> ArtifactKind {
        guard baseCaptureIds.contains(captureId) else { return .htmlBundle }
        return isScreenshotsCase ? .screenshots : .screenshot
    }

    /// "Screen N" or "Screen N · caption" (docs/protocol-mvp.md reply
    /// payload label, HAIL-40) for a capture of this screenshots session, or
    /// `nil` outside a screenshots case - callers fall back to their own
    /// "Capture N" wording in that case.
    func screenLabel(for capture: CaptureRecord) -> String? {
        guard isScreenshotsCase else { return nil }
        let number = screenNumber(of: capture)
        let version = compareCaptureIds.contains(capture.id) ? " (v\(capture.revision))" : ""
        guard let caption = captionsByCaptureId[capture.id] else { return "Screen \(number)\(version)" }
        return "Screen \(number) · \(caption)\(version)"
    }

    /// A screen's own title (HAIL-73 filmstrip and Set view): its caption, or
    /// "Screen N" when it has none. Never cut short.
    func screenTitle(for capture: CaptureRecord) -> String {
        captionsByCaptureId[capture.id] ?? "Screen \(screenNumber(of: capture))"
    }

    /// Starts a draft pin at `rect` (normalized 0..1) on the current
    /// capture. A no-op without a current capture, or while another draft is
    /// still open (only one pin drafts at a time).
    func beginDraft(rect: Rect, on captureId: String? = nil, variant: UsageVariant = .region, element: Task<PageElementContext?, Never>? = nil) {
        guard draftPin == nil, let captureId = captureId ?? currentCapture?.id else { element?.cancel(); return }
        openCommentId = nil
        draftPin = DraftPin(captureId: captureId, rect: rect.clamped(), text: "", variant: variant, element: element)
    }

    /// Starts a draft on a capture that does not exist yet (HAIL-65: the live
    /// prototype's region was just dragged). `snapshot` is already running in
    /// the background; the capture is only created by
    /// `commitDraftAwaitingCapture` once the note is saved.
    func beginPendingDraft(
        rect: Rect, revision: Int, takenAt: Date = Date(), page: PageViewport? = nil,
        variant: UsageVariant = .region, snapshot: Task<NSImage?, Never>, view: Task<PageView?, Never>? = nil,
        element: Task<PageElementContext?, Never>? = nil
    ) {
        guard draftPin == nil else { snapshot.cancel(); element?.cancel(); return }
        let id = UUID().uuidString
        openCommentId = nil
        pending = PendingCapture(id: id, revision: revision, takenAt: takenAt, snapshot: snapshot, page: page, view: view)
        draftPin = DraftPin(captureId: id, rect: rect.clamped(), text: "", variant: variant, element: element)
    }

    func updateDraftText(_ text: String) {
        draftPin?.text = text
    }

    func cancelDraft() {
        clearDraft()
    }

    private func clearDraft() {
        draftPin?.element?.cancel()
        draftPin = nil
        pending?.snapshot.cancel()
        pending?.view?.cancel()
        pending = nil
    }

    /// ↵ on the note popover: saves the pin when its note is non-empty,
    /// otherwise discards it (docs/stories/KNOCK-11.md: "Require a note per
    /// pin before it counts as a comment" — an empty note never becomes one,
    /// and there is nothing useful to keep drafting with ↵ already pressed).
    @discardableResult
    func commitDraft() -> Comment? {
        guard let draft = draftPin, pending == nil || pending?.id != draft.captureId else { return nil }
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        draftPin = nil
        guard !text.isEmpty else { return nil }
        usage?.record(UsageRecord(.commentAdded, artifactKind: artifactKind(ofCapture: draft.captureId), variant: draft.variant))
        let comment = model.addComment(captureId: draft.captureId, rect: draft.rect, text: text)
        keepElement(draft.element, for: comment)
        return comment
    }

    /// Saves the draft at once, even when its capture is still pending
    /// (HAIL-112): the comment and its capture are in the model before this
    /// returns, so the count, the list and the Send button follow in the same
    /// frame. The background snapshot (and the page view) fill in later, see
    /// `finishCapture`. A capture still exists only once it has a comment
    /// (HAIL-65). Returns `nil` for an empty note or a draft dropped meanwhile.
    @discardableResult
    func commitDraftNow() -> Comment? {
        guard let draft = draftPin else { return nil }
        guard let pending, pending.id == draft.captureId else { return commitDraft() }
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { clearDraft(); return nil }
        self.pending = nil
        draftPin = nil
        let record = model.addCapture(revision: pending.revision, takenAt: pending.takenAt, id: pending.id, page: pending.page)
        selectedCaptureId = nil
        usage?.record(UsageRecord(.commentAdded, artifactKind: artifactKind(ofCapture: draft.captureId), variant: draft.variant))
        let comment = model.addComment(captureId: record.id, rect: draft.rect, text: text)
        keepElement(draft.element, for: comment)
        imageTasks[record.id] = Task { [weak self] in
            let image = await pending.snapshot.value
            let view = await pending.view?.value
            self?.finishCapture(id: record.id, image: image, view: view, page: pending.page)
        }
        return comment
    }

    /// `commitDraftNow`, then waits for the capture's image to arrive.
    @discardableResult
    func commitDraftAwaitingCapture() async -> Comment? {
        let comment = commitDraftNow()
        await settleCaptures()
        return comment
    }

    /// Waits until every capture saved by `commitDraftNow` has its image. Send
    /// calls this first, so a reply never leaves without a picture.
    func settleCaptures() async {
        for task in Array(imageTasks.values) { await task.value }
        for (id, task) in Array(elementTasks) {
            let context = await task.value
            elementTasks[id] = nil
            model.setElementContext(context, forComment: id)
        }
    }

    /// HAIL-240: element reads that were still running when their comment was saved.
    @Published private var elementTasks: [String: Task<PageElementContext?, Never>] = [:]

    /// WAG-280: true for a live prototype or diagram, where a pin points at a page element. The review
    /// sets it when it shows such a stage; a screenshot or a document has no element to find.
    @Published var showsPageElements = false

    private func keepElement(_ task: Task<PageElementContext?, Never>?, for comment: Comment) {
        guard let task else { return }
        elementTasks[comment.id] = task
        // The card shows the element as soon as it is read, not only at Send.
        Task { [weak self] in
            let context = await task.value
            guard let self, self.elementTasks[comment.id] != nil else { return }
            self.elementTasks[comment.id] = nil
            self.model.setElementContext(context, forComment: comment.id)
        }
    }

    /// The plain line a comment's card shows for the page element its pin points at: "On the button
    /// "Pay now"", or "No page element" when the pin sits on a capture the page no longer matches or on
    /// empty page. `nil` while the read runs, and for a comment that has no page behind it.
    func elementLabel(for comment: Comment) -> String? {
        guard showsPageElements, !comment.isText, elementTasks[comment.id] == nil else { return nil }
        if let context = model.elementContexts[comment.id] { return context.cardLabel }
        // A comment restored from a sent reply has no live page behind it.
        return model.captures.first(where: { $0.id == comment.captureId })?.page == nil ? nil : "No page element"
    }

    /// The snapshot of a capture saved before its image existed has arrived (or
    /// failed). A failed snapshot keeps the comment: it gets a blank stand-in
    /// image, so the reply still carries it, and `captureNotice` says so.
    private func finishCapture(id: String, image: NSImage?, view: PageView?, page: PageViewport?) {
        imageTasks[id] = nil
        guard model.captures.contains(where: { $0.id == id }) else { return }
        model.setView(view, onCapture: id)
        if let image {
            imagesByCaptureId[id] = image
        } else {
            imagesByCaptureId[id] = Self.placeholderImage(size: page?.size)
            captureNotice = "Your comment is saved, but Waggle could not take a picture of the page. It will send without one."
        }
    }

    private static func placeholderImage(size: CGSize?) -> NSImage {
        let size = size.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil } ?? CGSize(width: 800, height: 600)
        return NSImage(size: size, flipped: false) { rect in
            NSColor(Theme.Colors.list).setFill()
            rect.fill()
            return true
        }
    }

    func dismissCaptureNotice() {
        captureNotice = nil
    }

    /// Saves a comment on a range of the shown markdown revision (HAIL-150). An empty note is
    /// refused, like a pin's. Returns the comment, or `nil` when nothing was saved.
    @discardableResult
    func addTextComment(anchor: TextAnchor, text: String) -> Comment? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return model.addTextComment(anchor: anchor, text: trimmed)
    }

    /// Saves a comment on the text of a request (WAG-357). An empty note is refused. Returns the comment, or
    /// `nil` when nothing was saved.
    @discardableResult
    func addAskComment(anchor: AskTextAnchor, text: String) -> Comment? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return model.addAskComment(anchor: anchor, text: trimmed)
    }

    func updateComment(id: String, text: String) {
        model.updateCommentText(id: id, text: text)
    }

    /// Deletes one comment; a live capture left without comments goes with it
    /// (HAIL-65: an empty capture is never kept).
    func deleteComment(id: String) {
        let captureId = model.comments.first(where: { $0.id == id })?.captureId
        model.deleteComment(id: id)
        if selectedCommentId == id { selectedCommentId = nil }
        if openCommentId == id { openCommentId = nil }
        if hoveredCommentId == id { setHoveredComment(nil) }
        if let captureId, !captureId.isEmpty { removeIfEmpty(captureId: captureId) }
    }

    /// A deleted comment that Undo can still bring back, for `undoWindow`.
    struct CommentUndo: Equatable {
        let deleted: CommentsModel.DeletedComment
        let image: NSImage?
    }

    /// The last comment deleted from the UI; nil once Undo ran or the window ended.
    @Published private(set) var commentUndo: CommentUndo?
    /// How long "Comment deleted · Undo" stays (5 s). A test sets it short.
    var undoWindow: Duration = .seconds(5)
    private var commentUndoTask: Task<Void, Never>?

    /// A delete from the UI: the same delete, with an Undo for `undoWindow`. Only the last delete can be undone.
    func deleteCommentWithUndo(id: String) {
        guard let comment = model.comments.first(where: { $0.id == id }) else { return }
        let captureIndex = model.captures.firstIndex { $0.id == comment.captureId }
        let capture = captureIndex.map { model.captures[$0] }
        let image = imagesByCaptureId[comment.captureId]
        guard var deleted = model.deleteComment(id: id) else { return }
        if selectedCommentId == id { selectedCommentId = nil }
        if openCommentId == id { openCommentId = nil }
        if hoveredCommentId == id { setHoveredComment(nil) }
        if !comment.captureId.isEmpty { removeIfEmpty(captureId: comment.captureId) }
        // Keep the capture only when this delete removed it.
        if let capture, !model.captures.contains(where: { $0.id == capture.id }) {
            deleted.capture = capture
            deleted.captureIndex = captureIndex ?? 0
        }
        commentUndo = CommentUndo(deleted: deleted, image: image)
        commentUndoTask?.cancel()
        let window = undoWindow
        commentUndoTask = Task { [weak self] in
            try? await Task.sleep(for: window)
            guard !Task.isCancelled else { return }
            self?.commentUndo = nil
        }
    }

    /// Puts the last deleted comment back with its text and number. A no-op after the window ended.
    func undoDeleteComment() {
        guard let undo = commentUndo else { return }
        commentUndo = nil
        commentUndoTask?.cancel()
        commentUndoTask = nil
        if let capture = undo.deleted.capture, let image = undo.image { imagesByCaptureId[capture.id] = image }
        model.restoreComment(undo.deleted)
    }

    /// Deletes a capture and its comments (HAIL-65). A base capture (the
    /// artifact's own image) keeps existing, only its comments go.
    func deleteCapture(id: String) {
        if draftPin?.captureId == id { clearDraft() }
        if let selected = selectedCommentId, model.comments(on: id).contains(where: { $0.id == selected }) {
            selectedCommentId = nil
        }
        if let open = openCommentId, model.comments(on: id).contains(where: { $0.id == open }) {
            openCommentId = nil
        }
        if baseCaptureIds.contains(id) {
            for comment in model.comments(on: id) { model.deleteComment(id: comment.id) }
            return
        }
        guard model.deleteCapture(id: id) else { return }
        imagesByCaptureId[id] = nil
        captionsByCaptureId[id] = nil
        if selectedCaptureId == id { selectedCaptureId = nil }
    }

    /// A plan round sent another kind of artifact (HAIL-156): drops every capture, pin and gallery
    /// state, so the new stage starts clean. Earlier answers were sent already; their comments live
    /// on the daemon.
    func resetArtifactCaptures() {
        clearDraft()
        clearSelection()
        clearCommentSelection()
        for task in imageTasks.values { task.cancel() }
        imageTasks = [:]
        model = CommentsModel()
        imagesByCaptureId = [:]
        captionsByCaptureId = [:]
        itemsByCaptureId = [:]
        decisionGroupIds = nil
        baseCaptureIds = []
        isScreenshotsCase = false
        screensRevision = nil
        pending = nil
    }

    /// Drops every comment (HAIL-74): a sent reply's comments must not count
    /// toward the next round. The artifact's own base captures stay.
    func clearComments() {
        clearDraft()
        for comment in model.comments where comment.hasNoCapture { deleteComment(id: comment.id) }
        for id in model.captures.map(\.id) { deleteCapture(id: id) }
    }

    /// WAG-358: drops the comments that went out with a sent reply, and a capture left empty by that.
    /// A reply can land without the send flow knowing (a reconnect resubmit, a late answer), so the
    /// pins would stay and ride along with the next round. Comments added after the send stay.
    func dropSent(commentIds: Set<String>) {
        guard !commentIds.isEmpty else { return }
        for comment in model.comments where commentIds.contains(comment.id) { deleteComment(id: comment.id) }
    }

    private func removeIfEmpty(captureId: String) {
        guard !baseCaptureIds.contains(captureId), model.comments(on: captureId).isEmpty else { return }
        deleteCapture(id: captureId)
    }

    /// "Change answer" (docs/stories/HAIL-34.md, operator decision via Knock
    /// on case c_656dc5ce…, choice "restore"): puts a queued reply's own
    /// captures and pins back into this session, editable, instead of
    /// starting from a blank one. Reuses the reply's own capture/comment ids
    /// and `n` order, so a pin removed here and re-sent still leaves the rest
    /// exactly as they were (`ReplyPayloadBuilder` reads ids straight off
    /// `model`, not off the original reply). A no-op past the first call for
    /// this session - `beginChangingAnswer()` can run again (e.g. a second
    /// SwiftUI init of the same case) without doubling every capture.
    func restore(from reply: Reply) {
        guard model.captures.isEmpty, model.comments.isEmpty else { return }
        for capture in reply.captures {
            guard let bytes = Data(base64Encoded: capture.pngBase64), let image = NSImage(data: bytes) else { continue }
            let record = model.addCapture(
                revision: capture.revision,
                takenAt: KnockDateFormat.date(from: capture.takenAt) ?? Date(),
                id: capture.id
            )
            imagesByCaptureId[record.id] = image
        }
        // Capture order, then `n`: replies made before HAIL-75 numbered each
        // capture from 1, so `n` alone would interleave the captures.
        let captureOrder = Dictionary(uniqueKeysWithValues: model.captures.enumerated().map { ($1.id, $0) })
        let ordered = reply.comments.sorted {
            if reply.comments.contains(where: \.hasNoCapture) { return $0.n < $1.n }
            let (l, r) = (captureOrder[$0.captureId] ?? 0, captureOrder[$1.captureId] ?? 0)
            return l == r ? $0.n < $1.n : l < r
        }
        for comment in ordered {
            if let anchor = comment.anchor {
                model.addTextComment(anchor: anchor, text: comment.text, id: comment.id)
            } else if let askAnchor = comment.askAnchor {
                model.addAskComment(anchor: askAnchor, text: comment.text, id: comment.id)
            } else {
                model.addComment(captureId: comment.captureId, rect: comment.rect, text: comment.text, id: comment.id)
            }
        }
        // HAIL-65 cleanup: a reply stored before lazy captures may hold
        // captures with no comment. Drop them (and their images) on load.
        for id in model.pruneEmptyCaptures(keeping: baseCaptureIds) { imagesByCaptureId[id] = nil }
    }

    /// Whether `restore(from:)` needs a `capture.image` fetch first (PERF-2): a
    /// capture that holds a pin but came back without its image. A capture with no
    /// pin is dropped by the restore anyway, so its image is never fetched.
    static func restoreNeedsImages(for reply: Reply) -> Bool {
        let pinned = Set(reply.comments.compactMap { $0.hasNoCapture ? nil : $0.captureId })
        return reply.captures.contains { pinned.contains($0.id) && $0.needsImageFetch }
    }

    /// `restore(from:)` for a reply read from `cases.get`, which carries no capture
    /// images (PERF-2): loads the raw image of each pinned capture through `client`
    /// (cached per capture id there), then restores. Skips the restore when the
    /// session got captures or comments while the images loaded.
    func restore(from reply: Reply, loadingImagesWith client: KnockClient) async {
        let pinned = Set(reply.comments.compactMap { $0.hasNoCapture ? nil : $0.captureId })
        var captures: [Capture] = []
        for capture in reply.captures {
            guard pinned.contains(capture.id), capture.needsImageFetch,
                  let data = await client.captureImageData(captureId: capture.id, which: .raw) else {
                captures.append(capture)
                continue
            }
            captures.append(Capture(
                id: capture.id, revision: capture.revision, pngBase64: data.base64EncodedString(),
                annotatedPngBase64: capture.annotatedPngBase64, takenAt: capture.takenAt, note: capture.note))
        }
        let filled = Reply(
            id: reply.id, caseId: reply.caseId, idempotencyKey: reply.idempotencyKey, choice: reply.choice,
            message: reply.message, comments: reply.comments, captures: captures, intent: reply.intent,
            format: reply.format, source: reply.source, state: reply.state, createdAt: reply.createdAt,
            replacedAt: reply.replacedAt, deliveredAt: reply.deliveredAt, choices: reply.choices)
        restore(from: filled)
    }
}

/// WAG-280: the comment store of each case, made on first use and kept while the app runs.
@MainActor
final class CaseCommentStores {
    private var storesByCaseId: [String: CommentsSessionStore] = [:]

    func store(forCase id: String, usage: UsageReporter? = nil) -> CommentsSessionStore {
        if let store = storesByCaseId[id] { return store }
        let store = CommentsSessionStore()
        store.usage = usage
        storesByCaseId[id] = store
        return store
    }
}
