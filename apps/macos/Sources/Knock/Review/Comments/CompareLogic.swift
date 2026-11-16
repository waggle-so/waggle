import SwiftUI
import AppKit

/// WAG-413: Compare shows two revisions of one screenshot, side by side or under a slider. The pure
/// pieces live here (the pair, the shared zoom, the slider, the pixel diff) so a unit test reaches them.

/// Which two revisions, and which two screens, Compare shows.
enum ComparePair {
    /// The revision before `shown` in the same artifact, or nil when `shown` is the first.
    /// `revisions` are the revision numbers of the artifact (its tab), in any order.
    static func previous(of shown: Int, in revisions: [Int]) -> Int? {
        revisions.filter { $0 < shown }.max()
    }

    /// The screen of the earlier set that goes with the shown screen: the one with the same caption
    /// when that is unique, else the one at the same position. Nil when the earlier set has neither.
    static func screenIndex(shownIndex: Int, shownCaption: String?, beforeCaptions: [String?]) -> Int? {
        let caption = shownCaption?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !caption.isEmpty {
            let matches = beforeCaptions.indices.filter {
                beforeCaptions[$0]?.trimmingCharacters(in: .whitespacesAndNewlines) == caption
            }
            if matches.count == 1 { return matches[0] }
        }
        return beforeCaptions.indices.contains(shownIndex) ? shownIndex : nil
    }
}

enum CompareLayout: Equatable {
    case sideBySide
    case slider
}

/// The one Compare control of the full-size toolbar (C9): a segmented switch, Off · Side by side · Slider.
enum CompareChoice: CaseIterable, Equatable {
    case off
    case sideBySide
    case slider

    var label: String {
        switch self {
        case .off: "Off"
        case .sideBySide: "Side by side"
        case .slider: "Slider"
        }
    }
}

/// How much room the stage controls take (narrow-window fix). The toolbar tries each step in order and
/// keeps the first that fits: the "No earlier revision yet" hint goes first, then Compare folds into a menu.
enum StageControlsDensity: CaseIterable, Equatable {
    case full
    case noHint
    case compareMenu

    var showsNoEarlierHint: Bool { self == .full }
    var comparesInMenu: Bool { self == .compareMenu }
}

enum CompareCopy {
    static let switchLabel = "Compare"
    static let noEarlier = "No earlier revision yet"
    static let showChanges = "Show what changed"
    static let noMatch = "This screen is new in this revision."
    static func before(_ revision: Int) -> String { "Before · revision \(revision)" }
    static func after(_ revision: Int) -> String { "After · revision \(revision)" }
}

/// Where the slider's line sits, as a fraction (0...1) of the stage width.
enum CompareSlider {
    static let start: CGFloat = 0.5

    static func position(x: CGFloat, width: CGFloat) -> CGFloat {
        guard width > 0 else { return start }
        return min(max(x / width, 0), 1)
    }

    /// The width of the Before side for a line at `position`.
    static func beforeWidth(position: CGFloat, width: CGFloat) -> CGFloat {
        width * min(max(position, 0), 1)
    }
}

/// Zoom and pan are one state for both sides.
enum CompareSync {
    /// At or below this stage width the two sides stack instead of sitting side by side.
    static let stackBelow: CGFloat = 760

    static func stacks(stageWidth: CGFloat) -> Bool { stageWidth < stackBelow }

    /// The scale each side shows for one zoom state. A number zoom is the same scale on both sides.
    /// Fit fits each image to its own side, so two sizes of image both show whole.
    static func scales(zoom: StageZoom, container: CGSize, before: CGSize, after: CGSize) -> (before: CGFloat, after: CGFloat) {
        (ScreenshotViewport.scale(for: zoom, container: container, image: before),
         ScreenshotViewport.scale(for: zoom, container: container, image: after))
    }

    /// The scroll origin on the other side that sits at the same fraction of its scroll range.
    static func mirroredOrigin(origin: CGPoint, content: CGSize, visible: CGSize, otherContent: CGSize, otherVisible: CGSize) -> CGPoint {
        func map(_ value: CGFloat, _ range: CGFloat, _ otherRange: CGFloat) -> CGFloat {
            guard range > 0.5 else { return 0 }
            return min(max(value / range, 0), 1) * max(0, otherRange)
        }
        return CGPoint(
            x: map(origin.x, content.width - visible.width, otherContent.width - otherVisible.width),
            y: map(origin.y, content.height - visible.height, otherContent.height - otherVisible.height)
        )
    }
}

/// The state of the Compare switch and its panel. Off by default. The zoom is not here: Compare reads
/// the one `ScreenshotStageModel.zoom`, so it is the same when the switch goes off and on.
@MainActor
final class CompareModel: ObservableObject {
    init(usage: UsageReporter? = nil) { self.usage = usage }

    @Published private(set) var isOn = false
    @Published var layout: CompareLayout = .sideBySide
    @Published var showsChanges = false
    @Published var sliderPosition: CGFloat = CompareSlider.start
    /// The earlier revision's still, once it is loaded; and the boxes where the two images differ.
    @Published var beforeCaptureId: String?
    @Published var changeBoxes: [Rect] = []
    var usage: UsageReporter?

    /// A person turned the switch. Reports one coded event.
    func userSet(_ on: Bool) {
        guard on != isOn else { return }
        isOn = on
        usage?.record(.compareToggled, variant: on ? .on : .off)
    }

    /// The switch goes off by itself (no earlier revision any more): nothing is reported.
    func reset() {
        isOn = false
        beforeCaptureId = nil
        changeBoxes = []
    }

    private var evidenceApplied = false

    /// `KNOCK_EVIDENCE_COMPARE=side|slider|changes|stack` (WAG-413 evidence hook): puts Compare in that
    /// state once, since the harness cannot click. `changes` is Side by side with "Show what changed".
    func applyEvidenceOnce(_ value: String?) {
        guard !evidenceApplied, let value else { return }
        evidenceApplied = true
        switch value {
        case "slider": isOn = true; setLayout(.slider)
        case "changes": isOn = true; showsChanges = true
        case "side", "stack": isOn = true
        default: break
        }
    }

    /// What the segmented switch shows.
    var choice: CompareChoice {
        guard isOn else { return .off }
        return layout == .slider ? .slider : .sideBySide
    }

    /// A person picked a segment: Off turns Compare off; the other two turn it on in that layout.
    func choose(_ choice: CompareChoice) {
        switch choice {
        case .off:
            userSet(false)
        case .sideBySide, .slider:
            let wanted: CompareLayout = choice == .slider ? .slider : .sideBySide
            if layout != wanted { setLayout(wanted) }
            userSet(true)
        }
    }

    func setLayout(_ new: CompareLayout) {
        layout = new
        if new == .slider { sliderPosition = CompareSlider.start }
    }
}

/// "Show what changed": a coarse pixel diff. Both images are drawn into one small grid; a cell that
/// differs is marked; neighbouring cells join into one box. Cheap and good enough to point at a change.
enum CompareDiff {
    static let work = 320
    static let cells = 32
    /// A pixel differs when a colour channel moves by more than this (of 255).
    static let pixelThreshold = 28
    /// A cell differs when this share of its pixels differ.
    static let cellShare = 0.06
    static let maxBoxes = 12

    static func boxes(before: CGImage, after: CGImage) -> [Rect] {
        guard let a = pixels(before), let b = pixels(after) else { return [] }
        return boxes(beforePixels: a, afterPixels: b)
    }

    static func boxes(beforePixels a: [UInt8], afterPixels b: [UInt8]) -> [Rect] {
        let cell = work / cells
        var changed = [Bool](repeating: false, count: cells * cells)
        for cy in 0..<cells {
            for cx in 0..<cells {
                var differing = 0
                for y in (cy * cell)..<((cy + 1) * cell) {
                    for x in (cx * cell)..<((cx + 1) * cell) {
                        let i = (y * work + x) * 4
                        let delta = max(abs(Int(a[i]) - Int(b[i])), abs(Int(a[i + 1]) - Int(b[i + 1])), abs(Int(a[i + 2]) - Int(b[i + 2])))
                        if delta > pixelThreshold { differing += 1 }
                    }
                }
                changed[cy * cells + cx] = Double(differing) / Double(cell * cell) >= cellShare
            }
        }
        // Join touching cells (8 neighbours) into boxes.
        var seen = [Bool](repeating: false, count: cells * cells)
        var result: [(box: CGRect, size: Int)] = []
        for start in 0..<(cells * cells) where changed[start] && !seen[start] {
            var stack = [start]
            seen[start] = true
            var minX = cells, minY = cells, maxX = 0, maxY = 0, size = 0
            while let index = stack.popLast() {
                let x = index % cells, y = index / cells
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y); size += 1
                for dy in -1...1 {
                    for dx in -1...1 {
                        let nx = x + dx, ny = y + dy
                        guard nx >= 0, ny >= 0, nx < cells, ny < cells else { continue }
                        let n = ny * cells + nx
                        if changed[n], !seen[n] { seen[n] = true; stack.append(n) }
                    }
                }
            }
            result.append((CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1), size))
        }
        let unit = 1 / Double(cells)
        return result.sorted { $0.size > $1.size }.prefix(maxBoxes).map {
            Rect(x: Double($0.box.minX) * unit, y: Double($0.box.minY) * unit, w: Double($0.box.width) * unit, h: Double($0.box.height) * unit)
        }
    }

    /// The image stretched into `work` x `work` RGBA pixels.
    static func pixels(_ image: CGImage) -> [UInt8]? {
        var data = [UInt8](repeating: 0, count: work * work * 4)
        let drawn = data.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: work, height: work, bitsPerComponent: 8, bytesPerRow: work * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: work, height: work))
            return true
        }
        return drawn ? data : nil
    }

    static func cgImage(_ image: NSImage) -> CGImage? {
        image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    }
}
