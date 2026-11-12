import AppKit
import WebKit

/// `KNOCK_EVIDENCE_SNAPSHOT=<png path>` (HAIL-73 evidence hook, same style as
/// the other `KNOCK_EVIDENCE_*` ones): a few seconds after the review stage
/// shows, writes the app's own largest window to that path. It draws the
/// app's own view tree, so it needs no Screen Recording permission and can
/// never record another app. A live prototype's pixels come from the web
/// view's own snapshot (`cacheDisplay` leaves a `WKWebView` blank), drawn under
/// the AppKit layers (HAIL-84).
@MainActor
enum EvidenceWindowSnapshot {
    private static var scheduled = false

    static func scheduleIfRequested(delay: TimeInterval = 4) {
        let environment = ProcessInfo.processInfo.environment
        guard !scheduled,
              let path = environment["KNOCK_EVIDENCE_WINDOW_SHOT"] ?? environment["KNOCK_EVIDENCE_SNAPSHOT"]
        else { return }
        scheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            Task { @MainActor in await write(to: path) }
        }
        // `KNOCK_EVIDENCE_WINDOW_SHOT_2=<png>,<seconds from now>` (HAIL-114): a second shot of the
        // same window, after the harness sent a new revision to the open ask.
        if let second = environment["KNOCK_EVIDENCE_WINDOW_SHOT_2"] {
            let parts = second.split(separator: ",", maxSplits: 1).map(String.init)
            if parts.count == 2, let seconds = Double(parts[1]) {
                DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                    Task { @MainActor in await write(to: parts[0]) }
                }
            }
        }
    }

    private static func log(_ message: String) {
        FileHandle.standardError.write(Data("evidence-shot: \(message)\n".utf8))
    }

    private static func write(to path: String) async {
        log("start")
        let window = NSApp.windows
            .filter { $0.isVisible && $0.contentView != nil }
            .max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
        guard let view = window?.contentView, let rep = EvidenceComposite.render(view) else { return }
        var pages: [(NSImage, NSRect)] = []
        var shotWebs: [WKWebView] = []
        for web in webViews(in: view) where !web.isHidden && web.bounds.width > 1 {
            let config = WKSnapshotConfiguration()
            let length = await withTimeout(seconds: 3) {
                try? await web.evaluateJavaScript("document.body ? document.body.innerText.length : -1") as? Int
            }
            log("web view \(web.bounds.size) loading=\(web.isLoading) text=\(String(describing: length))")
            // The first snapshot of a web view that was just resized can come back blank (seen on
            // the folded layouts); a second one after a pause is painted.
            _ = await withTimeout(seconds: 5) { try? await web.takeSnapshot(configuration: config) }
            try? await Task.sleep(nanoseconds: 800_000_000)
            let taken = await withTimeout(seconds: 5) { try? await web.takeSnapshot(configuration: config) }
            log("snapshot \(String(describing: taken??.size))")
            if let shot = taken ?? nil {
                pages.append((shot, view.convert(web.bounds, from: web)))
                shotWebs.append(web)
            }
        }
        let keys = EvidenceComposite.keyedRenders(of: view, covering: shotWebs)
        guard let png = EvidenceComposite.png(content: view, cached: rep, pages: pages, keys: keys) else { return }
        try? png.write(to: URL(fileURLWithPath: path))
    }

    private static func webViews(in view: NSView) -> [WKWebView] {
        (view as? WKWebView).map { [$0] } ?? view.subviews.flatMap { webViews(in: $0) }
    }
}

/// Draws a window's cached AppKit tree and the web views' own snapshots into
/// one PNG (HAIL-141c). `cacheDisplay` cannot be trusted with a WKWebView's
/// pixels (older macOS paints an opaque dark rectangle), so each web view's own
/// snapshot fills its frame. A snapshot's frame comes from `convert(_:from:)`
/// in the content view's own coordinates, which are top-down when the view is
/// flipped (SwiftUI's hosting view is); `unflipped` maps that frame into the
/// bottom-up drawing space the snapshot is drawn in.
///
/// What SwiftUI lays over the page (the Interact | Comment bar, the comment
/// layer, pins, the still of Comment mode) must stay on top of the snapshot.
/// Two more renders of the tree, with the page covered by a key colour each
/// (`keyedRenders`), tell them apart: where both renders agree, the app draws
/// over the page; where they differ, the page shows through, and by how much
/// gives the overlay's coverage at its soft edges.
@MainActor
enum EvidenceComposite {
    /// The two key colours. Far apart in every channel, so the coverage reads clean.
    static let keyA = NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1)
    static let keyB = NSColor(srgbRed: 0, green: 1, blue: 0, alpha: 1)

    /// `view`'s tree as `cacheDisplay` draws it, with each layer shadow on the side the screen shows it.
    /// `cacheDisplay` ignores a flipped geometry when it offsets a layer's shadow, so a SwiftUI shadow
    /// (a `CALayer` shadow in the hosting view's top-down space) lands on the wrong side: the canvas
    /// toolbar's `y: 6` shadow came out above the bar. The offsets are mirrored for the render only.
    static func render(_ view: NSView) -> NSBitmapImageRep? {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        let mirrored = view.layer.map { flippedShadowLayers(in: $0) } ?? []
        func mirror() {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            mirrored.forEach { $0.shadowOffset.height = -$0.shadowOffset.height }
            CATransaction.commit()
        }
        // Keep this synchronous: no `await` between the two `mirror()` calls, or the screen could
        // draw a frame with the shadows mirrored.
        mirror()
        defer { mirror() }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep
    }

    /// The layers under `layer` that cast a shadow inside a flipped geometry.
    static func flippedShadowLayers(in layer: CALayer, flipped: Bool = false) -> [CALayer] {
        let own = flipped && layer.shadowOpacity > 0 && layer.shadowOffset.height != 0 ? [layer] : []
        let inner = flipped != layer.isGeometryFlipped
        return own + (layer.sublayers ?? []).flatMap { flippedShadowLayers(in: $0, flipped: inner) }
    }

    /// Two renders of `view` with each web view covered by `keyA`, then `keyB`. Nil when there is no web view.
    static func keyedRenders(of view: NSView, covering webs: [WKWebView]) -> (a: NSBitmapImageRep, b: NSBitmapImageRep)? {
        guard !webs.isEmpty else { return nil }
        func render(_ color: NSColor) -> NSBitmapImageRep? {
            let covers = webs.map { web -> NSView in
                let cover = NSView(frame: web.bounds)
                cover.wantsLayer = true
                cover.layer?.backgroundColor = color.cgColor
                cover.autoresizingMask = [.width, .height]
                web.addSubview(cover)
                return cover
            }
            defer { covers.forEach { $0.removeFromSuperview() } }
            return Self.render(view)
        }
        guard let a = render(keyA), let b = render(keyB) else { return nil }
        return (a, b)
    }

    static func png(
        content: NSView, cached: NSBitmapImageRep, pages: [(NSImage, NSRect)],
        keys: (a: NSBitmapImageRep, b: NSBitmapImageRep)? = nil
    ) -> Data? {
        let size = content.bounds.size
        // The output has the cached tree's own pixel format, so the keyed renders read the same way.
        if let keys, let out = cached.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)),
           Self.readable(out), Self.readable(keys.a), Self.readable(keys.b), Self.sameShape(out, keys.a), Self.sameShape(out, keys.b),
           let context = NSGraphicsContext(bitmapImageRep: out) {
            out.size = size
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            for (shot, frame) in pages {
                shot.draw(in: unflipped(frame, in: content), from: .zero, operation: .copy, fraction: 1)
            }
            context.flushGraphics()
            NSGraphicsContext.restoreGraphicsState()
            let space = keys.a.colorSpace
            if let ka = keyA.usingColorSpace(space), let kb = keyB.usingColorSpace(space) {
                let regions = pages.map { unflipped($0.1, in: content) }
                putOverlaysBack(in: out, a: keys.a, b: keys.b, keyA: ka, keyB: kb, pages: regions, contentSize: size, flipped: content.isFlipped)
                return out.representation(using: .png, properties: [:])
            }
        }
        if let keys {
            FileHandle.standardError.write(Data((
                "evidence-shot: keyed renders unused, overlays other than pins are lost " +
                "(cached \(Self.layout(cached)), a \(Self.layout(keys.a)), b \(Self.layout(keys.b)))\n"
            ).utf8))
        }
        // No keyed renders: the snapshots go over the whole frame, and only the pins come back (WAG-307).
        let out = NSImage(size: size)
        out.lockFocus()
        let full = NSRect(origin: .zero, size: size)
        cached.draw(in: full, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        for (shot, frame) in pages {
            shot.draw(in: unflipped(frame, in: content), from: .zero, operation: .sourceOver, fraction: 1)
        }
        out.unlockFocus()
        guard let tiff = out.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        restoreOverlays(in: rep, from: cached, pages: pages.map { unflipped($0.1, in: content) }, contentSize: size, flipped: content.isFlipped)
        return rep.representation(using: .png, properties: [:])
    }

    /// 8-bit samples, colour first, at least RGB: the only layout `putOverlaysBack` reads.
    private static func readable(_ rep: NSBitmapImageRep) -> Bool {
        rep.bitsPerSample == 8 && rep.samplesPerPixel >= 3 && !rep.isPlanar && rep.bitmapData != nil
            && !rep.bitmapFormat.contains(.alphaFirst) && !rep.bitmapFormat.contains(.floatingPointSamples)
            && !rep.bitmapFormat.contains(.thirtyTwoBitLittleEndian) && !rep.bitmapFormat.contains(.sixteenBitLittleEndian)
    }

    private static func layout(_ rep: NSBitmapImageRep) -> String {
        "\(rep.pixelsWide)x\(rep.pixelsHigh) \(rep.bitsPerSample)b/\(rep.samplesPerPixel)s format \(rep.bitmapFormat.rawValue)"
    }

    private static func sameShape(_ x: NSBitmapImageRep, _ y: NSBitmapImageRep) -> Bool {
        x.pixelsWide == y.pixelsWide && x.pixelsHigh == y.pixelsHigh && x.bitsPerPixel == y.bitsPerPixel
    }

    /// In each page's frame: `t`, how much of the page shows, is the keyed renders' difference over the keys'
    /// difference. The overlay's own (premultiplied) colour is the `keyA` render less `t` of `keyA`, and the page
    /// snapshot already in `out` adds its `t`.
    private static func putOverlaysBack(
        in out: NSBitmapImageRep, a: NSBitmapImageRep, b: NSBitmapImageRep, keyA: NSColor, keyB: NSColor,
        pages: [NSRect], contentSize: NSSize, flipped: Bool
    ) {
        guard let dst = out.bitmapData, let pa = a.bitmapData, let pb = b.bitmapData else { return }
        let ka = [keyA.redComponent, keyA.greenComponent, keyA.blueComponent].map { Double($0) * 255 }
        let kb = [keyB.redComponent, keyB.greenComponent, keyB.blueComponent].map { Double($0) * 255 }
        let kd = (0..<3).map { ka[$0] - kb[$0] }
        let kdd = kd.reduce(0) { $0 + $1 * $1 }
        guard kdd > 1 else { return }
        let sx = Double(out.pixelsWide) / contentSize.width, sy = Double(out.pixelsHigh) / contentSize.height
        let step = out.bitsPerPixel / 8
        for frame in pages {
            // Bitmap rows run top-down; `frame` is bottom-up.
            let top = contentSize.height - frame.maxY
            let x0 = max(0, Int(frame.minX * sx)), x1 = min(out.pixelsWide, Int((frame.maxX * sx).rounded(.up)))
            let y0 = max(0, Int(top * sy)), y1 = min(out.pixelsHigh, Int(((top + frame.height) * sy).rounded(.up)))
            guard x1 > x0, y1 > y0 else { continue }
            for y in y0..<y1 {
                for x in x0..<x1 {
                    let o = y * out.bytesPerRow + x * step
                    var dot = 0.0
                    for c in 0..<3 { dot += (Double(pa[o + c]) - Double(pb[o + c])) * kd[c] }
                    let t = min(1, max(0, dot / kdd))
                    if t > 0.98 { continue }
                    for c in 0..<3 {
                        let overlay = Double(pa[o + c]) - t * ka[c]
                        dst[o + c] = UInt8(min(255, max(0, (overlay + t * Double(dst[o + c])).rounded())))
                    }
                }
            }
        }
    }

    /// WAG-307, the fallback with no keyed renders: a snapshot drawn over the whole of its frame hides the SwiftUI pins laid over
    /// the page vanish. The cached tree has the pins on a flat stand-in for the page. A pin is a small
    /// cluster of accent red pixels: each one is found, and its round footprint (number included) goes
    /// back on top of the snapshot.
    private static func restoreOverlays(
        in out: NSBitmapImageRep, from cached: NSBitmapImageRep, pages: [NSRect], contentSize: NSSize, flipped: Bool
    ) {
        guard cached.pixelsWide > 0, out.pixelsWide > 0, let src = cached.bitmapData,
              cached.samplesPerPixel >= 3, out.samplesPerPixel >= 3 else { return }
        let sx = Double(cached.pixelsWide) / contentSize.width, sy = Double(cached.pixelsHigh) / contentSize.height
        let ox = Double(out.pixelsWide) / contentSize.width, oy = Double(out.pixelsHigh) / contentSize.height
        func px(_ rep: NSBitmapImageRep, _ data: UnsafeMutablePointer<UInt8>, _ x: Int, _ y: Int) -> UnsafeMutablePointer<UInt8> {
            data + y * rep.bytesPerRow + x * rep.bitsPerPixel / 8
        }
        func isRed(_ p: UnsafeMutablePointer<UInt8>) -> Bool { Int(p[0]) > Int(p[1]) + 90 && Int(p[0]) > Int(p[2]) + 90 }
        var circles: [(x: Double, y: Double, r: Double)] = []
        for frame in pages {
            let top = contentSize.height - frame.maxY
            let x0 = Int(frame.minX * sx), x1 = min(cached.pixelsWide, Int(frame.maxX * sx))
            let y0 = Int(top * sy), y1 = min(cached.pixelsHigh, Int((top + frame.height) * sy))
            guard x1 > x0 + 4, y1 > y0 + 4 else { continue }
            let width = x1 - x0
            var seen = [Bool](repeating: false, count: width * (y1 - y0))
            for y in y0..<y1 {
                for x in x0..<x1 where !seen[(y - y0) * width + (x - x0)] && isRed(px(cached, src, x, y)) {
                    var stack = [(x, y)], minX = x, maxX = x, minY = y, maxY = y
                    seen[(y - y0) * width + (x - x0)] = true
                    while let (cx, cy) = stack.popLast() {
                        minX = min(minX, cx); maxX = max(maxX, cx); minY = min(minY, cy); maxY = max(maxY, cy)
                        for (nx, ny) in [(cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)]
                        where nx >= x0 && nx < x1 && ny >= y0 && ny < y1 && !seen[(ny - y0) * width + (nx - x0)] && isRed(px(cached, src, nx, ny)) {
                            seen[(ny - y0) * width + (nx - x0)] = true
                            stack.append((nx, ny))
                        }
                    }
                    let w = maxX - minX + 1, h = maxY - minY + 1
                    guard w >= 14, h >= 14, w <= 90, h <= 90 else { continue }
                    let cx = Double(minX + maxX) / 2, cy = Double(minY + maxY) / 2, r = Double(max(w, h)) / 2 + 1
                    circles.append((cx / sx, cy / sy, r / sx))
                }
            }
        }
        guard !circles.isEmpty, let context = NSGraphicsContext(bitmapImageRep: out) else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        for c in circles {
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(ovalIn: NSRect(x: c.x - c.r, y: contentSize.height - c.y - c.r, width: c.r * 2, height: c.r * 2)).addClip()
            cached.draw(in: NSRect(origin: .zero, size: contentSize), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            NSGraphicsContext.restoreGraphicsState()
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    /// A frame in the content view's coordinates, as a rect in the bottom-up drawing space.
    static func unflipped(_ frame: NSRect, in content: NSView) -> NSRect {
        guard content.isFlipped else { return frame }
        return NSRect(x: frame.minX, y: content.bounds.height - frame.maxY, width: frame.width, height: frame.height)
    }
}
