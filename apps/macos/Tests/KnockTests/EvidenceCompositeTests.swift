import AppKit
import SwiftUI
import Testing
@testable import Knock

/// HAIL-141c: the window-shot composite's frame flip maps a flipped content
/// view's top-down coordinates into the bottom-up drawing space the web view
/// snapshot is drawn in. A non-flipped view is left unchanged.
struct EvidenceCompositeTests {
    private final class Flipped: NSView { override var isFlipped: Bool { true } }
    private final class Plain: NSView { }

    @MainActor
    @Test func unflippedMapsATopDownFrameIntoBottomUpSpace() {
        let flipped = Flipped(frame: NSRect(x: 0, y: 0, width: 1000, height: 872))
        let plain = Plain(frame: NSRect(x: 0, y: 0, width: 1000, height: 872))
        let frame = NSRect(x: 385.5, y: 177, width: 281.5, height: 667)
        let expected = NSRect(x: 385.5, y: 872 - 177 - 667, width: 281.5, height: 667)
        #expect(EvidenceComposite.unflipped(frame, in: flipped) == expected)
        #expect(EvidenceComposite.unflipped(frame, in: plain) == frame)
    }

    /// A 4x1 strip: pixel 0 is under an opaque overlay (both keyed renders black), pixel 1 is half covered by a black
    /// overlay, pixels 2 and 3 show the page. The page snapshot is yellow; the cached tree is grey everywhere.
    @MainActor
    @Test func keyedRendersKeepWhatTheAppDrawsOverThePage() throws {
        func strip(_ pixels: [[UInt8]]) -> NSBitmapImageRep {
            let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: pixels.count, pixelsHigh: 1, bitsPerSample: 8, samplesPerPixel: 4,
                hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 32)!
            for (i, p) in pixels.enumerated() { for c in 0..<4 { rep.bitmapData![i * 4 + c] = p[c] } }
            return rep
        }
        let content = Plain(frame: NSRect(x: 0, y: 0, width: 4, height: 1))
        let cached = strip(Array(repeating: [128, 128, 128, 255], count: 4))
        // The keys as the bitmap's colour space holds them, the way a real render converts them.
        func key(_ color: NSColor, _ share: Double) -> [UInt8] {
            let c = color.usingColorSpace(.deviceRGB)!
            return [c.redComponent, c.greenComponent, c.blueComponent].map { UInt8(($0 * 255 * share).rounded()) } + [255]
        }
        let ka = EvidenceComposite.keyA, kb = EvidenceComposite.keyB
        let a = strip([[0, 0, 0, 255], key(ka, 0.5), key(ka, 1), key(ka, 1)])
        let b = strip([[0, 0, 0, 255], key(kb, 0.5), key(kb, 1), key(kb, 1)])
        let page = NSImage(size: NSSize(width: 4, height: 1))
        page.lockFocus(); NSColor(deviceRed: 1, green: 1, blue: 0, alpha: 1).setFill(); NSRect(x: 0, y: 0, width: 4, height: 1).fill(); page.unlockFocus()
        let png = try #require(EvidenceComposite.png(content: content, cached: cached, pages: [(page, content.bounds)], keys: (a, b)))
        let out = try #require(NSBitmapImageRep(data: png))
        // The stored samples, not `colorAt`: that converts through the PNG's profile, which is not linear.
        func rgb(_ x: Int) -> [Int] { (0..<3).map { Int(out.bitmapData![x * out.bitsPerPixel / 8 + $0]) } }
        let pageColor = rgb(3)
        #expect(pageColor[0] > 240 && pageColor[1] > 240 && pageColor[2] < 10)
        #expect(rgb(2) == pageColor)
        #expect(rgb(0) == [0, 0, 0])
        // Half covered by black: half of the page.
        #expect(zip(rgb(1), pageColor).allSatisfy { abs($0 - $1 / 2) <= 3 })
    }
}

/// The evidence render puts a SwiftUI shadow on the side the screen shows it: `cacheDisplay` alone mirrors it.
struct EvidenceShadowTests {
    @MainActor
    @Test func evidenceRenderKeepsAShadowBelowItsShape() throws {
        let root = ZStack {
            Color.white
            Rectangle().fill(Color.black).frame(width: 40, height: 20)
                .shadow(color: .black.opacity(0.5), radius: 6, x: 0, y: 12)
        }
        .frame(width: 100, height: 100)
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(x: 0, y: 0, width: 100, height: 100)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        let rep = try #require(EvidenceComposite.render(host))
        // Rows are top-down; the shape spans 40...60.
        func brightness(_ row: Int) -> CGFloat {
            rep.colorAt(x: rep.pixelsWide / 2, y: row * rep.pixelsHigh / 100)?.brightnessComponent ?? -1
        }
        #expect(brightness(68) < brightness(32))
        #expect(brightness(32) > 0.95)
        // The render leaves the live layers as they were.
        let layer = try #require(host.layer)
        let shadowed = try #require(EvidenceComposite.flippedShadowLayers(in: layer).first)
        #expect(shadowed.shadowOffset.height == 12)
    }
}
