import SwiftUI
import AppKit

/// HAIL-73: the pure maths behind the screenshot stage. Fit shows the whole
/// image (contain), 100% shows it at its own point size, and zoom lies between.
/// Only the displayed frame changes; pins are fractions of the image, so
/// `CommentCaptureStageView.pointRect(for:in:)` keeps them on the same spot.
enum StageZoom: Equatable {
    case fit
    /// An absolute scale: 1 is the image at its own point size (100%).
    case scale(CGFloat)
}

enum ScreenshotViewport {
    static let maxScale: CGFloat = 8
    static let zoomStep: CGFloat = 1.25

    /// The scale that shows the whole image inside `container` (contain fit).
    static func fitScale(container: CGSize, image: CGSize) -> CGFloat {
        guard image.width > 0, image.height > 0, container.width > 0, container.height > 0 else { return 1 }
        return min(container.width / image.width, container.height / image.height)
    }

    static func scale(for zoom: StageZoom, container: CGSize, image: CGSize) -> CGFloat {
        switch zoom {
        case .fit: return fitScale(container: container, image: image)
        case .scale(let value): return clamp(value, container: container, image: image)
        }
    }

    /// Zoom never goes below Fit (the whole image) or above `maxScale`.
    static func clamp(_ scale: CGFloat, container: CGSize, image: CGSize) -> CGFloat {
        let lower = min(fitScale(container: container, image: image), maxScale)
        return min(max(scale, lower), maxScale)
    }

    /// The image's displayed frame in a content area of at least `container`:
    /// centred on an axis where it is smaller than the container, at the
    /// origin (scrolling) where it is larger.
    static func frame(container: CGSize, image: CGSize, zoom: StageZoom) -> CGRect {
        let scale = scale(for: zoom, container: container, image: image)
        let size = CGSize(width: image.width * scale, height: image.height * scale)
        return CGRect(
            x: max(0, (container.width - size.width) / 2),
            y: max(0, (container.height - size.height) / 2),
            width: size.width, height: size.height
        )
    }

    /// The zoom after a + or − press: one step from the scale on screen.
    static func stepped(_ zoom: StageZoom, by factor: CGFloat, container: CGSize, image: CGSize) -> StageZoom {
        let current = scale(for: zoom, container: container, image: image)
        let target = clamp(current * factor, container: container, image: image)
        return abs(target - fitScale(container: container, image: image)) < 0.0001 ? .fit : .scale(target)
    }

    /// Smart zoom (two-finger double-tap): Fit goes to 100%, anything else to Fit.
    static func smartToggled(_ zoom: StageZoom) -> StageZoom {
        zoom == .fit ? .scale(1) : .fit
    }

    /// The point of the image under a viewport point, kept across a zoom change.
    /// `fraction` is 0...1 of the image; `viewport` is where it sits in the visible area.
    struct Anchor: Equatable {
        var fraction: CGPoint
        var viewport: CGPoint
    }

    /// The anchor for a pointer at `pointer` (in the visible area) while the
    /// scroll view is at `scrollOrigin` and the stage shows `zoom`.
    static func anchor(pointer: CGPoint, scrollOrigin: CGPoint, container: CGSize, image: CGSize, zoom: StageZoom) -> Anchor {
        let frame = frame(container: container, image: image, zoom: zoom)
        guard frame.width > 0, frame.height > 0 else { return Anchor(fraction: CGPoint(x: 0.5, y: 0.5), viewport: pointer) }
        let fraction = CGPoint(
            x: min(max((pointer.x + scrollOrigin.x - frame.minX) / frame.width, 0), 1),
            y: min(max((pointer.y + scrollOrigin.y - frame.minY) / frame.height, 0), 1)
        )
        return Anchor(fraction: fraction, viewport: pointer)
    }

    /// The scroll origin that puts the anchor's image point back under the
    /// pointer once the stage shows `zoom`. Clamped to the scrollable range.
    static func scrollOrigin(for anchor: Anchor, container: CGSize, image: CGSize, zoom: StageZoom) -> CGPoint {
        let frame = frame(container: container, image: image, zoom: zoom)
        let content = CGSize(width: max(container.width, frame.width), height: max(container.height, frame.height))
        let x = frame.minX + anchor.fraction.x * frame.width - anchor.viewport.x
        let y = frame.minY + anchor.fraction.y * frame.height - anchor.viewport.y
        return CGPoint(
            x: min(max(0, x), max(0, content.width - container.width)),
            y: min(max(0, y), max(0, content.height - container.height))
        )
    }
}

/// The two views of a screenshot set.
enum StageArrangement: Equatable {
    case one
    case set
}


/// Moving the outline in Set view: clamped at both ends.
enum SetSelection {
    static func step(ids: [String], from current: String?, by delta: Int) -> String? {
        guard !ids.isEmpty else { return nil }
        guard let current, let index = ids.firstIndex(of: current) else { return ids.first }
        return ids[max(0, min(ids.count - 1, index + delta))]
    }
}

/// The screenshot stage's state (zoom, One or Set, the outlined screen in
/// Set). Owned by `ArtifactViewerView`, driven by the header, the keys and
/// the stage itself.
@MainActor
final class ScreenshotStageModel: ObservableObject {
    init(usage: UsageReporter? = nil) { self.usage = usage }

    @Published var zoom: StageZoom = .fit
    @Published private(set) var arrangement: StageArrangement = .one
    /// The outlined screen in Set view (a capture id).
    @Published private(set) var setFocusId: String?
    /// Where the next zoom change keeps its image point (a pinch or smart zoom),
    /// read once by the stage after the zoom lands. Nil means centre.
    private(set) var pendingAnchor: ScreenshotViewport.Anchor?
    /// Reported by the stage, so a key press can step from the scale on screen.
    private(set) var container: CGSize = .zero
    private(set) var image: CGSize = .zero

    func updateViewport(container: CGSize, image: CGSize) {
        self.container = container
        self.image = image
    }

    var scale: CGFloat { ScreenshotViewport.scale(for: zoom, container: container, image: image) }
    var isFit: Bool { zoom == .fit }
    var isActualSize: Bool { !isFit && abs(scale - 1) < 0.001 }
    var percentText: String { "\(Int((scale * 100).rounded()))%" }

    private var evidenceApplied = false

    /// `KNOCK_EVIDENCE_STAGE=actual|fit2x|set` (HAIL-73 evidence hook, same
    /// style as the other `KNOCK_EVIDENCE_*` ones): puts the stage in that
    /// state once, right after its first layout, since the harness cannot
    /// click or press keys.
    func applyEvidenceOnce(_ value: String?, current: String?) {
        guard !evidenceApplied, let value, container.width > 0 else { return }
        evidenceApplied = true
        switch value {
        case "actual": actualSize()
        case "fit2x": zoom = .scale(ScreenshotViewport.fitScale(container: container, image: image) * 2)
        case "set": showSet(current: current)
        default: break
        }
    }

    /// Where a person's zoom and Set-view choices are reported (HAIL-83).
    var usage: UsageReporter?

    // The `user…` methods are the ones a person's click or key reaches; the
    // plain ones also run by themselves (a new screen resets to Fit) and
    // never report.
    func userFit() { fit(); usage?.record(.screenshotZoomChanged, variant: .fit) }
    func userActualSize() { actualSize(); usage?.record(.screenshotZoomChanged, variant: .hundred) }
    func userZoomIn() { zoomIn(); usage?.record(.screenshotZoomChanged, variant: .zoom) }
    func userZoomOut() { zoomOut(); usage?.record(.screenshotZoomChanged, variant: .zoom) }
    /// A trackpad pinch: `factor` is 1 + the event's magnification.
    func pinch(by factor: CGFloat, anchor: ScreenshotViewport.Anchor) {
        setZoom(ScreenshotViewport.stepped(zoom, by: factor, container: container, image: image), anchor: anchor)
    }

    /// Reported once when the fingers lift, so a pinch counts as one zoom.
    func userPinchEnded() { usage?.record(.screenshotZoomChanged, variant: .zoom) }

    /// Two-finger double-tap: Fit and 100% at the pointer.
    func userSmartZoom(anchor: ScreenshotViewport.Anchor) {
        let target = ScreenshotViewport.smartToggled(zoom)
        setZoom(target, anchor: anchor)
        usage?.record(.screenshotZoomChanged, variant: target == .fit ? .fit : .hundred)
    }

    private func setZoom(_ target: StageZoom, anchor: ScreenshotViewport.Anchor) {
        guard target != zoom else { return }
        pendingAnchor = anchor
        zoom = target
    }

    func takePendingAnchor() -> ScreenshotViewport.Anchor? {
        defer { pendingAnchor = nil }
        return pendingAnchor
    }

    /// `KNOCK_EVIDENCE_ZOOM=<n>` (HAIL-93 evidence hook): zooms to n times Fit
    /// once, keeping the image point `KNOCK_EVIDENCE_ZOOM_AT=<x>,<y>` (0...1,
    /// default the middle) under the middle of the stage, as a pinch there would.
    func applyEvidenceZoomOnce(_ value: String?, at: String?) {
        guard !evidenceZoomApplied, let value, let times = Double(value), container.width > 0 else { return }
        evidenceZoomApplied = true
        let parts = (at ?? "").split(separator: ",").compactMap { Double($0) }
        let fraction = parts.count == 2 ? CGPoint(x: parts[0], y: parts[1]) : CGPoint(x: 0.5, y: 0.5)
        let fit = ScreenshotViewport.fitScale(container: container, image: image)
        setZoom(
            .scale(fit * CGFloat(times)),
            anchor: ScreenshotViewport.Anchor(fraction: fraction, viewport: CGPoint(x: container.width / 2, y: container.height / 2))
        )
    }
    private var evidenceZoomApplied = false

    func userShowSet(current: String?) {
        showSet(current: current)
        usage?.record(.screenshotSetViewOpened)
    }

    func fit() { zoom = .fit }
    func actualSize() { zoom = .scale(1) }
    func zoomIn() { zoom = ScreenshotViewport.stepped(zoom, by: ScreenshotViewport.zoomStep, container: container, image: image) }
    func zoomOut() { zoom = ScreenshotViewport.stepped(zoom, by: 1 / ScreenshotViewport.zoomStep, container: container, image: image) }

    /// Shows every screen; the outline starts on the current one.
    func showSet(current: String?) {
        setFocusId = current
        arrangement = .set
    }

    /// Back to One view at Fit (a click in Set, Return, or the toggle).
    func showOne() {
        zoom = .fit
        arrangement = .one
    }

    func moveSetFocus(ids: [String], by delta: Int) {
        setFocusId = SetSelection.step(ids: ids, from: setFocusId, by: delta)
    }
}

/// Finds the `NSScrollView` a SwiftUI `ScrollView` is built on, so the stage
/// can centre after a zoom and pan on an Option-drag.
@MainActor
final class ScrollViewHandle {
    private weak var resolved: NSScrollView?
    /// The probe view inside the scroll content. The scroll view is looked up
    /// from it on demand: the probe may not be in a window yet when SwiftUI first
    /// updates it, and a lookup done only then would stay empty for good (HAIL-155).
    weak var probe: NSView?

    var scrollView: NSScrollView? {
        get {
            if let resolved { return resolved }
            guard let probe, probe.window != nil else { return nil }
            resolved = ScrollViewFinder.scrollView(for: probe)
            return resolved
        }
        set { resolved = newValue }
    }

    func centerContent() {
        guard let scrollView, let document = scrollView.documentView else { return }
        let visible = scrollView.contentView.bounds.size
        let origin = CGPoint(
            x: max(0, (document.frame.width - visible.width) / 2),
            y: max(0, (document.frame.height - visible.height) / 2)
        )
        scrollView.contentView.scroll(to: origin)
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    /// The pointer in the visible area (top-left origin), or nil when the
    /// window point is outside the scroll view.
    func viewportPoint(forWindowPoint point: CGPoint) -> CGPoint? {
        guard let scrollView else { return nil }
        let local = scrollView.convert(point, from: nil)
        guard scrollView.bounds.contains(local) else { return nil }
        let inClip = scrollView.contentView.convert(point, from: nil)
        let origin = scrollView.contentView.bounds.origin
        return CGPoint(x: inClip.x - origin.x, y: inClip.y - origin.y)
    }

    var scrollOrigin: CGPoint { scrollView?.contentView.bounds.origin ?? .zero }

    /// Scrolls once the document has grown to `contentSize`: SwiftUI lays the
    /// zoomed content out a beat after the zoom lands, and a scroll before that
    /// would be clamped to the old, smaller range. Gives up after about 0.5 s.
    func scroll(to origin: CGPoint, whenContentIs contentSize: CGSize, attempt: Int = 0) {
        let size = scrollView?.documentView?.frame.size ?? .zero
        let ready = abs(size.width - contentSize.width) < 1.5 && abs(size.height - contentSize.height) < 1.5
        if ready || attempt >= 16 {
            scroll(to: origin)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
                self?.scroll(to: origin, whenContentIs: contentSize, attempt: attempt + 1)
            }
        }
    }

    func scroll(to origin: CGPoint) {
        pan(by: CGSize(width: origin.x - scrollOrigin.x, height: origin.y - scrollOrigin.y))
    }

    func scrollToBottom() {
        guard let scrollView, let document = scrollView.documentView else { return }
        let clip = scrollView.contentView
        clip.scroll(to: CGPoint(x: clip.bounds.origin.x, y: max(0, document.frame.height - clip.bounds.height)))
        scrollView.reflectScrolledClipView(clip)
    }

    func pan(by delta: CGSize) {
        guard let scrollView, let document = scrollView.documentView else { return }
        let clip = scrollView.contentView
        let maxX = max(0, document.frame.width - clip.bounds.width)
        let maxY = max(0, document.frame.height - clip.bounds.height)
        let origin = CGPoint(
            x: min(max(0, clip.bounds.origin.x + delta.width), maxX),
            y: min(max(0, clip.bounds.origin.y + delta.height), maxY)
        )
        clip.scroll(to: origin)
        scrollView.reflectScrolledClipView(clip)
    }
}

struct ScrollViewFinder: NSViewRepresentable {
    let handle: ScrollViewHandle

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { [weak nsView] in
            guard let nsView else { return }
            handle.probe = nsView
            if handle.scrollView == nil { PinchZoomMonitor.log("no scroll view found for the stage yet") }
        }
    }

    /// The enclosing scroll view, or else the scroll view in the window that
    /// holds the middle of `view` (a SwiftUI release may host the content
    /// outside the scroll view's own subtree).
    @MainActor
    static func scrollView(for view: NSView) -> NSScrollView? {
        if let found = view.enclosingScrollView { return found }
        guard let root = view.window?.contentView else { return nil }
        let middle = view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
        var best: NSScrollView?
        func walk(_ node: NSView) {
            if let scroll = node as? NSScrollView {
                let local = scroll.convert(middle, from: nil)
                if scroll.bounds.contains(local) { best = scroll }
            }
            node.subviews.forEach(walk)
        }
        walk(root)
        return best
    }
}

/// One magnify or smart-magnify event, reduced to what the stage needs (HAIL-155),
/// so a unit test or the evidence hook can drive the same path as a real event.
struct PinchInput {
    enum Kind { case pinch, smart }
    var kind: Kind
    /// 1 + the event's magnification.
    var factor: CGFloat
    var windowPoint: CGPoint
    var window: NSWindow?
    var ended: Bool

    init(kind: Kind = .pinch, factor: CGFloat, windowPoint: CGPoint, window: NSWindow?, ended: Bool = false) {
        self.kind = kind
        self.factor = factor
        self.windowPoint = windowPoint
        self.window = window
        self.ended = ended
    }

    init(event: NSEvent) {
        self.init(
            kind: event.type == .smartMagnify ? .smart : .pinch,
            factor: max(0.05, 1 + event.magnification),
            windowPoint: event.locationInWindow, window: event.window,
            ended: event.phase == .ended || event.phase == .cancelled
        )
    }
}

enum PinchRoute: Equatable {
    case handled
    case noViewport
    case otherWindow
    case outsideStage
}

/// Catches the trackpad's pinch (`magnify`) and two-finger double-tap
/// (`smartMagnify`) over the stage. SwiftUI's `ScrollView` does not magnify, so
/// a local monitor reads them and the stage keeps one zoom state. The monitor's
/// view sits behind the whole stage (not inside the scrolling content), so its
/// bounds are the visible area and it does not depend on finding the scroll view.
struct PinchZoomMonitor: NSViewRepresentable {
    let handle: ScrollViewHandle
    /// Factor (1 + magnification), the pointer in the visible area, and whether the fingers lifted.
    let onPinch: (CGFloat, CGPoint, Bool) -> Void
    let onSmartZoom: (CGPoint) -> Void

    final class Coordinator {
        var parent: PinchZoomMonitor
        var token: Any?
        weak var view: NSView?
        init(_ parent: PinchZoomMonitor) { self.parent = parent }
        deinit { if let token { NSEvent.removeMonitor(token) } }
    }

    /// Where the one-line pinch log goes (the queue log); a test swaps it.
    @MainActor static var log: (String) -> Void = { QueueLog.write($0) }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSView {
        let coordinator = context.coordinator
        let view = NSView()
        coordinator.view = view
        Self.log("pinch monitor installed")
        PinchEvidence.scheduleIfRequested(view: view) { [weak coordinator] input in
            guard let coordinator else { return }
            coordinator.parent.route(input, in: coordinator.view)
        }
        coordinator.token = NSEvent.addLocalMonitorForEvents(matching: [.magnify, .smartMagnify]) { [weak coordinator] event in
            let input = PinchInput(event: event)
            let consumed = MainActor.assumeIsolated { () -> Bool in
                guard let coordinator else { return false }
                return coordinator.parent.route(input, in: coordinator.view) == .handled
            }
            return consumed ? nil : event
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.view = nsView
    }

    /// The visible-area point (top-left origin) of a window point, or nil when
    /// the window point is outside `view`.
    @MainActor
    static func viewportPoint(forWindowPoint point: CGPoint, in view: NSView) -> CGPoint? {
        let local = view.convert(point, from: nil)
        guard view.bounds.contains(local) else { return nil }
        return CGPoint(x: local.x - view.bounds.minX, y: view.isFlipped ? local.y - view.bounds.minY : view.bounds.maxY - local.y)
    }

    @MainActor
    @discardableResult
    func route(_ input: PinchInput, in view: NSView?) -> PinchRoute {
        let kind = input.kind == .smart ? "smart" : "pinch"
        let at = "x=\(Int(input.windowPoint.x)) y=\(Int(input.windowPoint.y))"
        guard let view, let window = view.window else {
            Self.log("\(kind) ignored: no stage view in a window")
            return .noViewport
        }
        guard input.window === window else {
            Self.log("\(kind) ignored: event window is not the stage window")
            return .otherWindow
        }
        guard let point = Self.viewportPoint(forWindowPoint: input.windowPoint, in: view) else {
            Self.log("\(kind) ignored: pointer outside the stage \(at)")
            return .outsideStage
        }
        Self.log("\(kind) received factor=\(String(format: "%.3f", Double(input.factor))) \(at) ended=\(input.ended)")
        switch input.kind {
        case .smart: onSmartZoom(point)
        case .pinch: onPinch(input.factor, point, input.ended)
        }
        return .handled
    }
}

/// `KNOCK_EVIDENCE_PINCH=<factor>,<x>,<y>[,<repeat>][;<next>...]` (HAIL-155):
/// feeds pinches of that factor, at a point of the stage (x and y are 0...1 of
/// its width and height), through the same route as a real event, `repeat`
/// times each (default 1). Real magnify events cannot be made by a script.
enum PinchEvidence {
    struct Spec: Equatable {
        var factor: CGFloat
        var x: CGFloat
        var y: CGFloat
        var repeats: Int
    }

    static func parse(_ value: String?) -> [Spec] {
        (value ?? "").split(separator: ";").compactMap { part in
            let nums = part.split(separator: ",").compactMap { Double($0) }
            guard let factor = nums.first, factor > 0 else { return nil }
            return Spec(
                factor: CGFloat(factor),
                x: nums.count > 2 ? CGFloat(nums[1]) : 0.5, y: nums.count > 2 ? CGFloat(nums[2]) : 0.5,
                repeats: nums.count > 3 ? max(1, Int(nums[3])) : 1
            )
        }
    }

    /// The window point of a stage fraction (top-left origin).
    @MainActor
    static func windowPoint(x: CGFloat, y: CGFloat, in view: NSView) -> CGPoint {
        let b = view.bounds
        let local = CGPoint(x: b.minX + b.width * x, y: view.isFlipped ? b.minY + b.height * y : b.maxY - b.height * y)
        return view.convert(local, to: nil)
    }

    @MainActor private static var started = false

    /// Runs once per launch, a couple of seconds after the stage appears.
    @MainActor
    static func scheduleIfRequested(
        view: NSView, environment: [String: String] = ProcessInfo.processInfo.environment,
        deliver: @escaping @MainActor (PinchInput) -> Void
    ) {
        let specs = parse(environment["KNOCK_EVIDENCE_PINCH"])
        guard !specs.isEmpty, !started else { return }
        started = true
        Task { @MainActor [weak view] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            for spec in specs {
                for _ in 0..<spec.repeats {
                    guard let view, let window = view.window else { return }
                    let point = windowPoint(x: spec.x, y: spec.y, in: view)
                    deliver(PinchInput(factor: spec.factor, windowPoint: point, window: window))
                    try? await Task.sleep(nanoseconds: 60_000_000)
                }
                try? await Task.sleep(nanoseconds: 600_000_000)
            }
        }
    }
}
