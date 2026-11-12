import Testing
import Foundation
import AppKit
@testable import Knock

/// HAIL-73: fit frame maths, zoom clamps, the filmstrip text, Set view
/// selection and the pin round trip.
@MainActor
struct ScreenshotViewportTests {
    private static let stages = [CGSize(width: 940, height: 620), CGSize(width: 640, height: 500)]
    private let phone = CGSize(width: 390, height: 844)
    private let desktop = CGSize(width: 1440, height: 900)
    private let tallPage = CGSize(width: 1440, height: 2400)

    private func expectInside(_ frame: CGRect, _ stage: CGSize) {
        #expect(frame.minX >= 0 && frame.minY >= 0)
        #expect(frame.maxX <= stage.width + 0.001 && frame.maxY <= stage.height + 0.001)
    }

    @Test func fitShowsAPhoneCaptureWholeAndCentredInBothStageSizes() {
        for stage in Self.stages {
            let frame = ScreenshotViewport.frame(container: stage, image: phone, zoom: .fit)
            expectInside(frame, stage)
            #expect(abs(frame.height - stage.height) < 0.001, "a phone is height-bound")
            #expect(abs(frame.width / frame.height - phone.width / phone.height) < 0.0001, "aspect kept")
            #expect(abs(frame.midX - stage.width / 2) < 0.001)
        }
    }

    @Test func fitOfADesktopCaptureIsNoSmallerThanFitToWidth() {
        for stage in Self.stages {
            let frame = ScreenshotViewport.frame(container: stage, image: desktop, zoom: .fit)
            let old = CommentCaptureStageView.fitWidthFrame(containerWidth: stage.width, image: desktop)
            expectInside(frame, stage)
            if old.height <= stage.height {
                #expect(abs(frame.width - old.width) <= 1)
                #expect(abs(frame.height - old.height) <= 1)
            } else {
                #expect(frame.height <= stage.height + 0.001, "a tall fit-to-width overflowed; contain shows it whole")
            }
        }
    }

    @Test func fitOfATallPageShowsTheWholePage() {
        for stage in Self.stages {
            let frame = ScreenshotViewport.frame(container: stage, image: tallPage, zoom: .fit)
            expectInside(frame, stage)
            #expect(abs(frame.height - stage.height) < 0.001)
            #expect(abs(frame.width / frame.height - 0.6) < 0.0001)
        }
    }

    @Test func actualSizeUsesThePointSizeAndScrollsWhenLargerThanTheStage() {
        let stage = Self.stages[0]
        let frame = ScreenshotViewport.frame(container: stage, image: phone, zoom: .scale(1))
        #expect(frame.size == phone)
        #expect(frame.minY == 0, "taller than the stage: origin at the top, the ScrollView scrolls")
        #expect(abs(frame.midX - stage.width / 2) < 0.001, "narrower than the stage: centred")
    }

    @Test func zoomClampsBetweenFitAndTheMaximum() {
        let stage = Self.stages[0]
        let fit = ScreenshotViewport.fitScale(container: stage, image: desktop)
        #expect(ScreenshotViewport.scale(for: .scale(0.001), container: stage, image: desktop) == fit)
        #expect(ScreenshotViewport.scale(for: .scale(99), container: stage, image: desktop) == ScreenshotViewport.maxScale)
        #expect(ScreenshotViewport.stepped(.fit, by: 0.8, container: stage, image: desktop) == .fit, "minus at Fit stays at Fit")
        let zoomedIn = ScreenshotViewport.stepped(.fit, by: 1.25, container: stage, image: desktop)
        #expect(zoomedIn == .scale(fit * 1.25))
        #expect(ScreenshotViewport.stepped(zoomedIn, by: 0.8, container: stage, image: desktop) == .fit)
    }

    @Test func modelZoomKeysStepFromTheScaleOnScreen() {
        let model = ScreenshotStageModel()
        model.updateViewport(container: Self.stages[0], image: phone)
        #expect(model.isFit)
        model.zoomIn()
        #expect(!model.isFit)
        model.actualSize()
        #expect(model.isActualSize)
        #expect(model.percentText == "100%")
        model.fit()
        #expect(model.isFit && !model.isActualSize)
    }

    @Test func screenTitleIsTheCaptionOrScreenN() {
        let store = CommentsSessionStore()
        let image = NSImage(size: NSSize(width: 10, height: 10))
        let records = store.addScreenshotsCaptures(
            images: [(image: image, caption: "A · More room for the trend"), (image: image, caption: nil)], revision: 1
        )
        #expect(store.screenTitle(for: records[0]) == "A · More room for the trend")
        #expect(store.screenTitle(for: records[1]) == "Screen 2")
    }

    @Test func setSelectionMovesTheOutlineAndClamps() {
        let ids = ["a", "b", "c"]
        #expect(SetSelection.step(ids: ids, from: "a", by: 1) == "b")
        #expect(SetSelection.step(ids: ids, from: "a", by: -1) == "a")
        #expect(SetSelection.step(ids: ids, from: "c", by: 1) == "c")
        #expect(SetSelection.step(ids: ids, from: nil, by: 1) == "a")
        #expect(SetSelection.step(ids: [], from: "a", by: 1) == nil)
    }

    @Test func openingAScreenFromSetReturnsToOneAtFit() {
        let model = ScreenshotStageModel()
        model.updateViewport(container: Self.stages[0], image: phone)
        model.zoom = .scale(2)
        model.showSet(current: "b")
        #expect(model.arrangement == .set)
        #expect(model.setFocusId == "b")
        model.moveSetFocus(ids: ["a", "b", "c"], by: 1)
        #expect(model.setFocusId == "c")
        model.showOne()
        #expect(model.arrangement == .one)
        #expect(model.zoom == .fit)
    }

    @Test func aPinKeepsItsFractionAtFitAndAtTwiceFit() {
        let stage = Self.stages[0]
        let pin = Rect(x: 0.25, y: 0.6, w: 0.3, h: 0.1)
        let fit = ScreenshotViewport.fitScale(container: stage, image: phone)
        for zoom in [StageZoom.fit, .scale(fit * 2), .scale(1)] {
            // Content area: as large as the stage, or the image when it is larger.
            let frame = ScreenshotViewport.frame(container: stage, image: phone, zoom: zoom)
            let point = CommentCaptureStageView.pointRect(for: pin, in: frame)
            let back = Rect(
                x: (point.minX - frame.minX) / frame.width, y: (point.minY - frame.minY) / frame.height,
                w: point.width / frame.width, h: point.height / frame.height
            )
            #expect(abs(back.x - pin.x) < 1e-9 && abs(back.y - pin.y) < 1e-9)
            #expect(abs(back.w - pin.w) < 1e-9 && abs(back.h - pin.h) < 1e-9)
        }
        let atFit = ScreenshotViewport.frame(container: stage, image: phone, zoom: .fit)
        let atTwo = ScreenshotViewport.frame(container: stage, image: phone, zoom: .scale(fit * 2))
        #expect(abs(atTwo.width / atFit.width - 2) < 1e-9, "2x is twice the frame")
        let p1 = CommentCaptureStageView.pointRect(for: pin, in: atFit)
        let p2 = CommentCaptureStageView.pointRect(for: pin, in: atTwo)
        #expect(abs((p2.minX - atTwo.minX) / (p1.minX - atFit.minX) - 2) < 1e-9, "the pin sits on the same spot of the image")
    }

    // MARK: - HAIL-93 pinch zoom

    @Test func pinchClampsAtFitAndAtTheMaximum() {
        let stage = Self.stages[0]
        let model = ScreenshotStageModel()
        model.updateViewport(container: stage, image: desktop)
        let anchor = ScreenshotViewport.Anchor(fraction: CGPoint(x: 0.5, y: 0.5), viewport: CGPoint(x: 470, y: 310))
        model.pinch(by: 0.5, anchor: anchor)
        #expect(model.isFit, "pinching out at Fit stays at Fit")
        #expect(model.takePendingAnchor() == nil, "no change, no anchor left behind")
        model.pinch(by: 100, anchor: anchor)
        #expect(model.scale == ScreenshotViewport.maxScale)
        model.pinch(by: 1.2, anchor: anchor)
        #expect(model.scale == ScreenshotViewport.maxScale)
        model.pinch(by: 0.001, anchor: anchor)
        #expect(model.isFit)
    }

    @Test func pinchSharesTheStateOfTheButtons() {
        let model = ScreenshotStageModel()
        model.updateViewport(container: Self.stages[0], image: desktop)
        let fit = model.scale
        let anchor = ScreenshotViewport.Anchor(fraction: CGPoint(x: 0.3, y: 0.3), viewport: CGPoint(x: 100, y: 100))
        model.pinch(by: 2, anchor: anchor)
        #expect(abs(model.scale - fit * 2) < 1e-9)
        #expect(model.percentText == "\(Int((fit * 2 * 100).rounded()))%")
        model.zoomIn()
        #expect(abs(model.scale - fit * 2 * ScreenshotViewport.zoomStep) < 1e-9, "+ continues from the pinched level")
        #expect(model.takePendingAnchor() == anchor)
        #expect(model.takePendingAnchor() == nil)
    }

    @Test func theImagePointUnderThePointerStaysPut() {
        let stage = Self.stages[0]
        let fit = ScreenshotViewport.fitScale(container: stage, image: desktop)
        let start = StageZoom.scale(fit * 2)
        let origin = CGPoint(x: 120, y: 40)
        let pointer = CGPoint(x: 300, y: 400)
        let anchor = ScreenshotViewport.anchor(pointer: pointer, scrollOrigin: origin, container: stage, image: desktop, zoom: start)
        for next in [StageZoom.scale(fit * 3), .scale(fit * 5), .scale(fit * 8)] {
            let newOrigin = ScreenshotViewport.scrollOrigin(for: anchor, container: stage, image: desktop, zoom: next)
            let frame = ScreenshotViewport.frame(container: stage, image: desktop, zoom: next)
            let under = CGPoint(x: (pointer.x + newOrigin.x - frame.minX) / frame.width, y: (pointer.y + newOrigin.y - frame.minY) / frame.height)
            #expect(abs(under.x - anchor.fraction.x) < 1e-9 && abs(under.y - anchor.fraction.y) < 1e-9)
        }
    }

    @Test func theAnchorOriginStaysInsideTheScrollableRange() {
        let stage = Self.stages[0]
        let corner = ScreenshotViewport.Anchor(fraction: CGPoint(x: 1, y: 1), viewport: CGPoint(x: 0, y: 0))
        let far = ScreenshotViewport.scrollOrigin(for: corner, container: stage, image: desktop, zoom: .scale(2))
        let frame = ScreenshotViewport.frame(container: stage, image: desktop, zoom: .scale(2))
        #expect(far.x == frame.width - stage.width && far.y == frame.height - stage.height)
        let none = ScreenshotViewport.scrollOrigin(for: corner, container: stage, image: desktop, zoom: .fit)
        #expect(none == .zero, "at Fit there is nothing to scroll")
        let before = ScreenshotViewport.Anchor(fraction: .zero, viewport: CGPoint(x: 500, y: 500))
        #expect(ScreenshotViewport.scrollOrigin(for: before, container: stage, image: desktop, zoom: .scale(2)) == .zero)
    }

    @Test func aSmallImageAnchorUsesItsCentredFrame() {
        let stage = Self.stages[0]
        let frame = ScreenshotViewport.frame(container: stage, image: phone, zoom: .scale(0.5))
        let pointer = CGPoint(x: frame.midX, y: frame.midY)
        let anchor = ScreenshotViewport.anchor(pointer: pointer, scrollOrigin: .zero, container: stage, image: phone, zoom: .scale(0.5))
        #expect(abs(anchor.fraction.x - 0.5) < 1e-9 && abs(anchor.fraction.y - 0.5) < 1e-9)
        let outside = ScreenshotViewport.anchor(pointer: .zero, scrollOrigin: .zero, container: stage, image: phone, zoom: .scale(0.5))
        #expect(outside.fraction == .zero, "a pointer beside the image clamps to its edge")
    }

    @Test func smartZoomTogglesBetweenFitAndActualSize() {
        #expect(ScreenshotViewport.smartToggled(.fit) == .scale(1))
        #expect(ScreenshotViewport.smartToggled(.scale(1)) == .fit)
        #expect(ScreenshotViewport.smartToggled(.scale(3)) == .fit)
        let model = ScreenshotStageModel()
        model.updateViewport(container: Self.stages[0], image: desktop)
        let anchor = ScreenshotViewport.Anchor(fraction: CGPoint(x: 0.2, y: 0.8), viewport: CGPoint(x: 10, y: 10))
        model.userSmartZoom(anchor: anchor)
        #expect(model.isActualSize)
        model.userSmartZoom(anchor: anchor)
        #expect(model.isFit)
    }

    @Test func pinchLeavesFitAndDoesNotTouchTheSelectedScreen() {
        let model = ScreenshotStageModel()
        model.updateViewport(container: Self.stages[0], image: phone)
        model.showSet(current: "b")
        model.showOne()
        model.pinch(by: 1.5, anchor: ScreenshotViewport.Anchor(fraction: .zero, viewport: .zero))
        #expect(!model.isFit)
        model.userFit()
        #expect(model.isFit)
    }
}
