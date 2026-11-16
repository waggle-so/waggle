import AppKit
import SwiftUI
import XCTest
@testable import Knock

/// Narrow-window fix: the decision column stays inside the window, and the stage controls give way.
@MainActor
final class NarrowWindowColumnTests: XCTestCase {
    private final class Box { var frame: CGRect = .zero }

    private func columnFrame(window: CGFloat, column: CGFloat?, stageIdeal: CGFloat) -> CGRect {
        let box = Box()
        let row = StageAndColumnRow(columnWidth: column) {
            // A stage whose toolbar refuses to shrink, like the full-size header in a narrow window.
            Color.clear.frame(width: stageIdeal, height: 40).fixedSize()
        } column: {
            // Folded: a fixed 40 pt strip, like AskFoldedStripView.
            Color.clear.frame(width: column == nil ? AskFoldedStripView.width : nil).frame(maxWidth: column == nil ? nil : .infinity, maxHeight: .infinity)
                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { box.frame = $0 }
        }
        let host = NSHostingView(rootView: row.frame(width: window, height: 600))
        host.frame = NSRect(x: 0, y: 0, width: window, height: 600)
        host.layoutSubtreeIfNeeded()
        return box.frame
    }

    func testTheColumnStaysInsideTheWindowWhenTheStageIsTooWide() {
        let frame = columnFrame(window: 1000, column: 400, stageIdeal: 1300)
        XCTAssertEqual(frame.width, 400, accuracy: 0.5)
        XCTAssertEqual(frame.maxX, 1000, accuracy: 0.5, "the column runs past the window: \(frame)")
    }

    func testTheColumnKeepsItsPlaceWhenTheStageFits() {
        let frame = columnFrame(window: 1400, column: 440, stageIdeal: 600)
        XCTAssertEqual(frame.width, 440, accuracy: 0.5)
        XCTAssertEqual(frame.maxX, 1400, accuracy: 0.5)
    }

    func testTheFoldedStripStaysInsideTheWindowToo() {
        let frame = columnFrame(window: 900, column: nil, stageIdeal: 1300)
        XCTAssertEqual(frame.width, 40, accuracy: 0.5)
        XCTAssertEqual(frame.maxX, 900, accuracy: 0.5)
    }

    func testTheDensityStepsDropTheHintFirstThenFoldCompare() {
        XCTAssertEqual(StageControlsDensity.allCases, [.full, .noHint, .compareMenu])
        XCTAssertTrue(StageControlsDensity.full.showsNoEarlierHint)
        XCTAssertFalse(StageControlsDensity.noHint.showsNoEarlierHint)
        XCTAssertFalse(StageControlsDensity.noHint.comparesInMenu)
        XCTAssertTrue(StageControlsDensity.compareMenu.comparesInMenu)
    }

    private func controlsWidth(_ density: StageControlsDensity, available: Bool) -> CGFloat {
        let controls = StageHeaderControls(
            stage: ScreenshotStageModel(), showsSetToggle: true, onShowSet: {},
            compare: CompareModel(), compareAvailable: available, density: density
        ).fixedSize()
        let host = NSHostingView(rootView: controls)
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.width
    }

    func testEachStepIsNarrowerThanTheOneBefore() {
        let full = controlsWidth(.full, available: false)
        let noHint = controlsWidth(.noHint, available: false)
        let menu = controlsWidth(.compareMenu, available: false)
        XCTAssertGreaterThan(full, noHint + 60, "the hint did not go: \(full) vs \(noHint)")
        XCTAssertGreaterThan(noHint, menu + 40, "Compare did not fold: \(noHint) vs \(menu)")
    }

    func testWithAnEarlierRevisionOnlyTheMenuStepIsNarrower() {
        let full = controlsWidth(.full, available: true)
        let noHint = controlsWidth(.noHint, available: true)
        let menu = controlsWidth(.compareMenu, available: true)
        XCTAssertEqual(full, noHint, accuracy: 0.5)
        XCTAssertGreaterThan(noHint, menu + 40)
    }
}
