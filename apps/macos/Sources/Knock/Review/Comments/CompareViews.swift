import SwiftUI
import AppKit

/// WAG-413: the views of Compare. The switch sits in the screenshot header; the panel under it holds
/// the Side by side / Slider control and "Show what changed"; the stage shows the two revisions.

/// What a Compare side tells the shared stage view.
struct CompareSideOptions {
    let sync: ComparePanSync
    /// 0 is Before, 1 is After.
    let side: Int
    /// The "what changed" boxes (After only).
    var boxes: [Rect] = []
    /// Only one side reads the pinch anchor; the other follows by the pan mirror.
    var takesAnchor = true
}

/// A box over a part of the After image that differs from the Before image. Honey, dashed, so it never
/// reads as a comment pin (which is red).
struct ChangeBoxView: View {
    var body: some View {
        RoundedRectangle(cornerRadius: Theme.Radius.regionBox)
            .fill(Theme.Colors.honey300.opacity(0.16))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.regionBox)
                    .stroke(Theme.Colors.honey600, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
            )
    }
}

/// Keeps the scroll position of the two sides in step: when one pans, the other moves to the same
/// fraction of its own range (two images of different sizes still line up).
@MainActor
final class ComparePanSync {
    private struct Entry { weak var handle: ScrollViewHandle? }
    private var entries: [Int: Entry] = [:]
    private var applying = false

    func register(side: Int, handle: ScrollViewHandle) { entries[side] = Entry(handle: handle) }

    func panned(from side: Int) {
        guard !applying, let source = entries[side]?.handle?.scrollView else { return }
        let content = source.documentView?.frame.size ?? .zero
        let visible = source.contentView.bounds.size
        let origin = source.contentView.bounds.origin
        applying = true
        defer { applying = false }
        for (other, entry) in entries where other != side {
            guard let handle = entry.handle, let target = handle.scrollView else { continue }
            let otherContent = target.documentView?.frame.size ?? .zero
            let otherVisible = target.contentView.bounds.size
            let mirrored = CompareSync.mirroredOrigin(
                origin: origin, content: content, visible: visible, otherContent: otherContent, otherVisible: otherVisible
            )
            handle.scroll(to: mirrored)
        }
    }
}

/// Registers a side's scroll view with the sync and reports its scrolling.
struct PanMirror: NSViewRepresentable {
    let sync: ComparePanSync
    let side: Int
    let handle: ScrollViewHandle

    final class Coordinator {
        weak var observed: NSClipView?
        var token: NSObjectProtocol?
        deinit { if let token { NotificationCenter.default.removeObserver(token) } }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ nsView: NSView, context: Context) {
        sync.register(side: side, handle: handle)
        let coordinator = context.coordinator
        DispatchQueue.main.async { [sync, side, handle, weak coordinator] in
            guard let coordinator, let clip = handle.scrollView?.contentView, coordinator.observed !== clip else { return }
            if let token = coordinator.token { NotificationCenter.default.removeObserver(token) }
            coordinator.observed = clip
            clip.postsBoundsChangedNotifications = true
            coordinator.token = NotificationCenter.default.addObserver(
                forName: NSView.boundsDidChangeNotification, object: clip, queue: .main
            ) { _ in
                MainActor.assumeIsolated { sync.panned(from: side) }
            }
        }
    }
}

/// The Compare switch of the screenshot header (C9): one segmented switch, Off · Side by side · Slider. With no
/// earlier revision it stays on Off, disabled, and says why (beside it when there is room, else in the tooltip).
struct CompareSwitch: View {
    @ObservedObject var compare: CompareModel
    let isAvailable: Bool
    var density: StageControlsDensity = .full

    var body: some View {
        Group {
            if density.comparesInMenu {
                menu
            } else {
                HStack(spacing: 8) {
                    if !isAvailable, density.showsNoEarlierHint {
                        Text(CompareCopy.noEarlier)
                            .knockTextStyle(Theme.Typography.monoMeta11w400)
                            .foregroundColor(Theme.Colors.ink3)
                            .lineLimit(1)
                    }
                    segments
                }
            }
        }
        .fixedSize()
    }

    /// Narrowest step: one small "Compare: Off" menu with the same three choices.
    private var menu: some View {
        let current = isAvailable ? compare.choice : .off
        return Menu {
            ForEach(CompareChoice.allCases, id: \.self) { choice in
                Button {
                    compare.choose(choice)
                } label: {
                    if choice == current { Label(choice.label, systemImage: "checkmark") } else { Text(choice.label) }
                }
            }
        } label: {
            Text("\(CompareCopy.switchLabel): \(current.label)")
                .knockTextStyle(Theme.Typography.buttonSm12_5w500)
                .foregroundColor(isAvailable ? Theme.Colors.ink2 : Theme.Colors.ink3)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.visible)
        .disabled(!isAvailable)
        .pointerCursor()
        .help(isAvailable ? "Show this revision next to the one before it" : CompareCopy.noEarlier)
        .accessibilityLabel(CompareCopy.switchLabel)
        .accessibilityValue(current.label)
    }

    private var segments: some View {
        HStack(spacing: 6) {
            Text(CompareCopy.switchLabel)
                .knockTextStyle(Theme.Typography.buttonSm12_5w500)
                .foregroundColor(isAvailable ? Theme.Colors.ink2 : Theme.Colors.ink3)
            StageControl.track {
                ForEach(CompareChoice.allCases, id: \.self) { choice in
                    StageControl.segment(
                        choice.label, isActive: (isAvailable ? compare.choice : .off) == choice, isEnabled: isAvailable
                    ) { compare.choose(choice) }
                }
            }
        }
        .help(isAvailable ? "Show this revision next to the one before it" : CompareCopy.noEarlier)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(CompareCopy.switchLabel)
    }
}

/// The row under the header while Compare is on: "Show what changed". Side by side and Slider are in the switch.
struct ComparePanel: View {
    @ObservedObject var compare: CompareModel

    var body: some View {
        HStack(spacing: 14) {
            Toggle(isOn: $compare.showsChanges) {
                Text(CompareCopy.showChanges)
                    .knockTextStyle(Theme.Typography.buttonSm12_5w500)
                    .foregroundColor(Theme.Colors.ink2)
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            .pointerCursor()
            Spacer(minLength: 0)
        }
        .padding(EdgeInsets(top: 6, leading: 24, bottom: 6, trailing: 24))
        .background(Theme.Colors.list)
        .overlay(Rectangle().fill(Theme.Colors.line).frame(height: 1), alignment: .bottom)
    }
}

/// The two revisions on the stage: side by side (stacked when narrow) or under a slider.
struct CompareStageView: View {
    @ObservedObject var store: CommentsSessionStore
    @ObservedObject var compare: CompareModel
    @ObservedObject var stage: ScreenshotStageModel
    let after: CaptureRecord
    let afterImage: NSImage
    let beforeRevision: Int
    /// Reports the After side's stage size and image size, for the zoom keys.
    let onAfterViewport: (CGSize, CGSize) -> Void

    @State private var sync = ComparePanSync()

    private var before: (capture: CaptureRecord, image: NSImage)? {
        guard let id = compare.beforeCaptureId, let capture = store.model.captures.first(where: { $0.id == id }),
              let image = store.imagesByCaptureId[id] else { return nil }
        return (capture, image)
    }

    var body: some View {
        GeometryReader { proxy in
            switch compare.layout {
            case .sideBySide:
                if CompareSync.stacks(stageWidth: proxy.size.width) {
                    VStack(spacing: 10) { beforePane; afterPane }
                } else {
                    HStack(spacing: 16) { beforePane; afterPane }
                }
            case .slider:
                sliderStage(size: proxy.size)
            }
        }
    }

    // MARK: - Side by side

    private var beforePane: some View {
        pane(caption: CompareCopy.before(beforeRevision)) { beforeStage }
    }

    private var afterPane: some View {
        pane(caption: CompareCopy.after(after.revision)) { afterStage }
    }

    private func pane<Content: View>(caption: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 6) {
            Text(caption)
                .knockTextStyle(Theme.Typography.monoMeta11w400)
                .foregroundColor(Theme.Colors.ink2)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            content().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var beforeStage: some View {
        if let before {
            CommentCaptureStageView(
                image: before.image, store: store, captureId: before.capture.id, initialScrollFraction: 0,
                zoom: stage.zoom, stageModel: stage,
                compareSide: CompareSideOptions(sync: sync, side: 0, takesAnchor: false)
            )
        } else {
            VStack { Spacer(); Text(CompareCopy.noMatch).knockTextStyle(Theme.Typography.body13w400).foregroundColor(Theme.Colors.ink3); Spacer() }
                .frame(maxWidth: .infinity)
        }
    }

    private var afterStage: some View {
        CommentCaptureStageView(
            image: afterImage, store: store, captureId: after.id, initialScrollFraction: after.scrollFraction,
            zoom: stage.zoom, onViewport: onAfterViewport, stageModel: stage,
            compareSide: CompareSideOptions(sync: sync, side: 1, boxes: compare.showsChanges ? compare.changeBoxes : [])
        )
    }

    // MARK: - Slider

    private func sliderStage(size: CGSize) -> some View {
        let line = CompareSlider.beforeWidth(position: compare.sliderPosition, width: size.width)
        return ZStack(alignment: .topLeading) {
            afterStage
            beforeStage
                .background(Theme.Colors.list)
                .clipShape(LeftClip(width: line))
            sliderCaptions(line: line, width: size.width)
            sliderHandle(line: line, height: size.height, width: size.width)
        }
        .coordinateSpace(name: "compare-slider")
    }

    private func sliderCaptions(line: CGFloat, width: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            sliderLabel(CompareCopy.before(beforeRevision)).padding(8).frame(maxWidth: max(0, line), alignment: .leading)
            sliderLabel(CompareCopy.after(after.revision)).padding(8).frame(width: width, alignment: .trailing)
        }
        .allowsHitTesting(false)
    }

    private func sliderLabel(_ text: String) -> some View {
        Text(text)
            .knockTextStyle(Theme.Typography.monoMeta11w400)
            .foregroundColor(Theme.Colors.ink)
            .padding(EdgeInsets(top: 3, leading: 8, bottom: 3, trailing: 8))
            .background(Theme.Colors.win.opacity(0.92))
            .cornerRadius(Theme.Radius.chip)
            .lineLimit(1)
    }

    private func sliderHandle(line: CGFloat, height: CGFloat, width: CGFloat) -> some View {
        ZStack {
            Rectangle().fill(Theme.Colors.win).frame(width: 2)
                .overlay(Rectangle().stroke(Theme.Colors.ink.opacity(0.25), lineWidth: 0.5))
            Circle().fill(Theme.Colors.win)
                .frame(width: 26, height: 26)
                .overlay(Circle().stroke(Theme.Colors.ink.opacity(0.25), lineWidth: 1))
                .overlay(Image(systemName: "arrow.left.and.right").font(.system(size: 10, weight: .semibold)).foregroundColor(Theme.Colors.ink))
        }
        .frame(width: 28, height: height)
        .contentShape(Rectangle())
        .position(x: line, y: height / 2)
        .gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .named("compare-slider"))
                .onChanged { compare.sliderPosition = CompareSlider.position(x: $0.location.x, width: width) }
        )
        .pointerCursor()
        .accessibilityLabel("Slider")
        .accessibilityValue("\(Int((compare.sliderPosition * 100).rounded())) percent")
        .accessibilityAdjustableAction { direction in
            let step: CGFloat = 0.05
            switch direction {
            case .increment: compare.sliderPosition = min(1, compare.sliderPosition + step)
            case .decrement: compare.sliderPosition = max(0, compare.sliderPosition - step)
            @unknown default: break
            }
        }
    }
}

/// The part of a view left of `width`.
struct LeftClip: Shape {
    var width: CGFloat
    var animatableData: CGFloat {
        get { width }
        set { width = newValue }
    }

    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX, y: rect.minY, width: max(0, min(width, rect.width)), height: rect.height))
    }
}
