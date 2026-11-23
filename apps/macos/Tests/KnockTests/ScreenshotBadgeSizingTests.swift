import AppKit
import SwiftUI
import Testing
@testable import Knock

/// 0.2.72 crashed twice and 0.2.73 once (22 Nov): the screenshot badge's `NSHostingView` was the panel's content
/// view, so SwiftUI also sized the panel in every constraints pass, the size did not settle, and AppKit threw. The
/// badge and the notice now sit in a plain container, so SwiftUI never sizes their panel.
@MainActor
@Suite struct ScreenshotBadgeSizingTests {
    /// A panel at a size other than the measured one, as AppKit can leave it (the 22 Nov crash window had shrunk
    /// from about 283 x 73 to 257 x 71). SwiftUI must leave that size alone.
    private func settledPanel(_ view: some View, size: CGSize) -> NSPanel {
        let (content, _) = ScreenshotController.fixedHost(view)
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        panel.contentView = content
        panel.updateConstraintsIfNeeded()
        panel.layoutIfNeeded()
        return panel
    }

    private var badge: ScreenshotBadgeView {
        ScreenshotBadgeView(subtitle: "Simulator pool and test briefs", onOpen: {}, onTurnOff: {})
    }

    @Test func theBadgeIsMeasuredOnceInWholePoints() {
        FontRegistration.registerBundledFonts()
        let (content, size) = ScreenshotController.fixedHost(badge)
        #expect(size.width > 100 && size.height > 40)
        #expect(size.width == size.width.rounded(.up) && size.height == size.height.rounded(.up))
        #expect(content.frame.size == size)
        #expect(!(content is NSHostingView<ScreenshotBadgeView>))
    }

    @Test func swiftUINeverSizesTheBadgePanel() {
        FontRegistration.registerBundledFonts()
        let odd = CGSize(width: 283, height: 73)
        let panel = settledPanel(badge, size: odd)
        #expect(panel.frame.size == odd)
        #expect(panel.contentMinSize == .zero)
        #expect(panel.contentMaxSize.width > 10_000 && panel.contentMaxSize.height > 10_000)
    }

    @Test func swiftUINeverSizesTheNoticePanel() {
        FontRegistration.registerBundledFonts()
        let odd = CGSize(width: 401, height: 97)
        let panel = settledPanel(ScreenshotNoticeView(text: ScreenshotCopy.snipFailed), size: odd)
        #expect(panel.frame.size == odd)
        #expect(panel.contentMinSize == .zero)
    }
}
