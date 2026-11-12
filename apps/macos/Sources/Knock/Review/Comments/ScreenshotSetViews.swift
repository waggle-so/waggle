import SwiftUI
import AppKit

/// The header controls of the screenshot stage (HAIL-73): Fit, 100%, − and +,
/// and (for a set) the One / Set toggle. Segment recipe of
/// `ReviewColumnTabsView`: `side` track, `win` active segment with a shadow.
struct StageHeaderControls: View {
    @ObservedObject var stage: ScreenshotStageModel
    let showsSetToggle: Bool
    let onShowSet: () -> Void
    /// WAG-413: the Compare switch, shown beside the zoom controls of One view.
    var compare: CompareModel?
    var compareAvailable = false

    var body: some View {
        HStack(spacing: 10) {
            if showsSetToggle {
                StageControl.track {
                    StageControl.segment("One", isActive: stage.arrangement == .one) { stage.showOne() }
                    StageControl.segment("Set", isActive: stage.arrangement == .set) { onShowSet() }
                }
            }
            if stage.arrangement == .one, let compare {
                CompareSwitch(compare: compare, isAvailable: compareAvailable)
            }
            if stage.arrangement == .one {
                StageControl.track {
                    StageControl.segment("Fit", isActive: stage.isFit) { stage.userFit() }
                    StageControl.segment("100%", isActive: stage.isActualSize) { stage.userActualSize() }
                    StageControl.iconSegment("minus", label: "Zoom out") { stage.userZoomOut() }
                    StageControl.iconSegment("plus", label: "Zoom in") { stage.userZoomIn() }
                }
            }
        }
    }
}

/// HAIL-127: the prototype's zoom controls, in the screenshot header's style:
/// Fit (100%), the readout, − and +. The same in Interact and Comment mode.
struct PrototypeZoomControls: View {
    @ObservedObject var zoom: PrototypeZoomModel

    var body: some View {
        StageControl.track {
            StageControl.segment("Fit", isActive: zoom.isActualSize) { zoom.fit() }
            Text(zoom.percentText)
                .knockTextStyle(Theme.Typography.monoMeta11w400)
                .foregroundColor(Theme.Colors.ink2)
                .frame(minWidth: 38)
                .accessibilityLabel("Zoom \(zoom.percentText)")
            StageControl.iconSegment("minus", label: "Zoom out") { zoom.zoomOut() }
            StageControl.iconSegment("plus", label: "Zoom in") { zoom.zoomIn() }
            StageControl.iconSegment("arrow.clockwise", label: PrototypeReload.tooltip) { zoom.reload() }
                .help(PrototypeReload.tooltip)
        }
    }
}

/// The segmented-track pieces the stage's zoom controls are made of, shared by
/// the screenshot header (`StageHeaderControls`) and the prototype's
/// (`PrototypeZoomControls`) so both look the same.
@MainActor
enum StageControl {
    static func track<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 2) { content() }
            .padding(2)
            .background(Theme.Colors.side)
            .cornerRadius(Theme.Radius.columnTabsTrack)
    }

    static func segment(_ label: String, isActive: Bool, isEnabled: Bool = true, action: @escaping () -> Void) -> some View {
        Text(label)
            .knockTextStyle(isActive ? Theme.Typography.buttonSm12_5w600 : Theme.Typography.buttonSm12_5w500)
            .foregroundColor(!isEnabled ? Theme.Colors.ink3 : (isActive ? Theme.Colors.ink : Theme.Colors.ink2))
            .padding(EdgeInsets(top: 3, leading: 9, bottom: 3, trailing: 9))
            .background(isActive ? Theme.Colors.win : Color.clear)
            .cornerRadius(Theme.Radius.columnTabsSegment)
            .shadow(
                color: isActive ? Theme.Shadow.columnTab.color : .clear,
                radius: Theme.Shadow.columnTab.blur / 2,
                x: Theme.Shadow.columnTab.offset.width, y: Theme.Shadow.columnTab.offset.height
            )
            .contentShape(Rectangle())
            .onTapGesture { if isEnabled { action() } }.pointerCursor()
            .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
            .accessibilityLabel(label)
            .accessibilityValue(isActive ? "On" : "Off")
    }

    static func iconSegment(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(Theme.Colors.ink2)
            .frame(width: 22)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .onTapGesture(perform: action).pointerCursor()
            .accessibilityLabel(label)
            .accessibilityAddTraits(.isButton)
    }
}

/// Numbered pins over an image shown at `frame`, read-only (Set view).
struct CapturePinsOverlay: View {
    let comments: [Comment]
    let frame: CGRect

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(comments) { comment in
                let rect = CommentCaptureStageView.pointRect(for: comment.rect, in: frame)
                RegionBoxView(style: .committed)
                    .frame(width: rect.width, height: rect.height)
                    .position(x: rect.midX, y: rect.midY)
                PinView(number: comment.n)
                    .position(x: rect.minX, y: rect.minY)
            }
        }
        .frame(width: frame.width, height: frame.height, alignment: .topLeading)
        .allowsHitTesting(false)
    }
}

/// Set view (HAIL-73): every screen side by side at the full stage height,
/// its title under it, the outlined one ringed, horizontal scroll when they
/// do not fit. Pins show read-only; new comments are made in One view.
struct ScreenshotSetView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var store: CommentsSessionStore
    let outlinedId: String?
    let onOpen: (String) -> Void

    private static let titleHeight: CGFloat = 30
    private static let gap: CGFloat = 20

    var body: some View {
        GeometryReader { proxy in
            let imageHeight = max(40, proxy.size.height - Self.titleHeight - 4)
            ScrollViewReader { scroll in
                ScrollView(.horizontal, showsIndicators: true) {
                    HStack(alignment: .top, spacing: Self.gap) {
                        ForEach(store.screens) { capture in
                            screen(capture, imageHeight: imageHeight).id(capture.id)
                        }
                    }
                    .padding(.horizontal, 4)
                    .frame(minWidth: proxy.size.width, alignment: .center)
                }
                .onAppear { if let outlinedId { scroll.scrollTo(outlinedId, anchor: .center) } }
                .onChange(of: outlinedId) { _, id in
                    if let id { ReducedMotion.animate(reduceMotion: reduceMotion) { scroll.scrollTo(id, anchor: .center) } }
                }
            }
        }
    }

    /// A screen at the full stage height, its width from the aspect ratio.
    static func imageFrame(image: CGSize, height: CGFloat) -> CGRect {
        guard image.width > 0, image.height > 0 else { return CGRect(x: 0, y: 0, width: height, height: height) }
        return CGRect(x: 0, y: 0, width: height * image.width / image.height, height: height)
    }

    @ViewBuilder
    private func screen(_ capture: CaptureRecord, imageHeight: CGFloat) -> some View {
        let isOutlined = capture.id == outlinedId
        VStack(spacing: 6) {
            if let image = store.imagesByCaptureId[capture.id] {
                let frame = Self.imageFrame(image: image.size, height: imageHeight)
                ZStack(alignment: .topLeading) {
                    Image(nsImage: image).resizable()
                    CapturePinsOverlay(
                        comments: store.model.comments(on: capture.id),
                        frame: CGRect(origin: .zero, size: frame.size)
                    )
                }
                .frame(width: frame.width, height: frame.height)
                .imageContextMenu(image)
                .overlay(
                    Rectangle().stroke(
                        isOutlined ? Theme.Colors.accent : Theme.Stroke.card.color,
                        lineWidth: isOutlined ? 3 : Theme.Stroke.card.width
                    )
                )
            }
            Text(store.screenTitle(for: capture))
                .knockTextStyle(Theme.Typography.monoMeta11w400)
                .foregroundColor(isOutlined ? Theme.Colors.ink : Theme.Colors.ink2)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(height: Self.titleHeight, alignment: .top)
        }
        .contentShape(Rectangle())
        .onTapGesture { onOpen(capture.id) }.pointerCursor()
        .accessibilityAddTraits(.isButton)
    }
}
