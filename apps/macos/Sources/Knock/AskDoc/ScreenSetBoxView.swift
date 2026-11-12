import SwiftUI

/// WAG-323: a `screenshots` set in the artifact box, flipped through where it sits. Prev and next arrows on the
/// image edges (on hover, always with keyboard focus) and the compact screen row above the image (decision
/// record 2026-11-12). The title of the screen on show sits in the box header. Full size is for zoom and Set mode.
struct ScreenSetBoxView: View {
    @ObservedObject var store: CommentsSessionStore
    let capture: CaptureRecord
    var fillsHeight = false
    /// The box has keyboard focus: the arrows stay on show.
    var hasFocus = false
    /// Space under the image for the floating toolbar, so it never covers the image (WAG-374).
    var imageBottomInset: CGFloat = 0
    let onStep: (Int) -> Void
    let onSelect: (String) -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var screens: [CaptureRecord] { store.galleryScreens }

    private var index: ScreenSetIndex {
        ScreenSetIndex(count: screens.count, current: screens.firstIndex { $0.id == capture.id } ?? 0)
    }

    var body: some View {
        VStack(spacing: 0) {
            if screens.count > 1 {
                ScreenRow(store: store, current: capture.id, onSelect: onSelect, onStep: onStep)
            }
            PinnedStillView(store: store, capture: capture, fillsHeight: fillsHeight)
                .frame(maxHeight: fillsHeight ? .infinity : nil)
                .overlay { arrows }
                .padding(.bottom, imageBottomInset)
                .onHover { isHovering = $0 }
        }
    }

    // MARK: Arrows

    private var arrows: some View {
        let visible = isHovering || hasFocus
        return HStack {
            arrow("chevron.left", label: "Previous screen", enabled: index.canGoPrevious) { onStep(-1) }
            Spacer(minLength: 0)
            arrow("chevron.right", label: "Next screen", enabled: index.canGoNext) { onStep(1) }
        }
        .padding(.horizontal, 10)
        .opacity(visible ? 1 : 0)
        .allowsHitTesting(visible)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: visible)
    }

    private func arrow(_ symbol: String, label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(enabled ? Theme.Colors.ink : Theme.Colors.ink3)
                .frame(width: 30, height: 30)
                .background(Theme.Colors.win.opacity(enabled ? 0.95 : 0.7))
                .clipShape(Circle())
                .overlay(Circle().stroke(Theme.Colors.line2, lineWidth: 1))
                .shadow(color: Theme.Colors.shadowBlack.opacity(0.10), radius: 4, y: 1)
                .contentShape(Circle())
        }
        .buttonStyle(.plain).pointerCursor()
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}
