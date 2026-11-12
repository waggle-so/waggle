import AppKit
import SwiftUI
import Testing
@testable import Knock

/// The reply field and files (WAG-345 follow-up): with a screenshot on the clipboard Cmd-V attaches it
/// (a plain-text view had turned Paste off), and a file dropped on the text attaches instead of typing its path.
@MainActor
@Suite struct PromptFieldPasteTests {
    private func field(takesFiles: Bool) -> (PromptNSTextView, PromptTextView.Coordinator) {
        let parent = PromptTextView(
            text: .constant(""), isFocused: .constant(false), canSend: true, onSend: {},
            onPaste: takesFiles ? { _ in true } : nil)
        let coordinator = PromptTextView.Coordinator(parent)
        let view = PromptNSTextView(frame: .zero)
        PromptTextView.configure(view)
        view.coordinator = coordinator
        return (view, coordinator)
    }

    private func board(_ fill: (NSPasteboard) -> Void) -> NSPasteboard {
        let board = NSPasteboard(name: NSPasteboard.Name("knock-test-\(UUID().uuidString)"))
        board.clearContents()
        fill(board)
        return board
    }

    private func png() -> Data {
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        return rep.representation(using: .png, properties: [:])!
    }

    @Test func aScreenshotOnTheClipboardKeepsPasteOn() {
        let (view, keep) = field(takesFiles: true)
        let image = board { $0.setData(png(), forType: .png) }
        #expect(view.pastesFiles(from: image))
        // The text view alone turns Paste off for an image: that is the bug this covers.
        let plain = NSTextView(frame: .zero)
        PromptTextView.configure(plain)
        #expect(plain.readablePasteboardTypes.contains(.png) == false)
        withExtendedLifetime(keep) {}
    }

    @Test func textOnTheClipboardIsLeftToTheTextView() {
        let (view, keep) = field(takesFiles: true)
        #expect(view.pastesFiles(from: board { $0.setString("words", forType: .string) }) == false)
        withExtendedLifetime(keep) {}
    }

    @Test func aFieldWithoutFilesNeverTakesThePaste() {
        let (view, keep) = field(takesFiles: false)
        #expect(view.pastesFiles(from: board { $0.setData(png(), forType: .png) }) == false)
        withExtendedLifetime(keep) {}
    }

    @Test func aDroppedFileAttachesOnlyWhereTheFieldTakesFiles() {
        let file = board { $0.writeObjects([URL(fileURLWithPath: "/tmp/shot.png") as NSURL]) }
        let (takes, keepA) = field(takesFiles: true)
        let (plain, keepB) = field(takesFiles: false)
        #expect(takes.attachesDrop(of: file))
        #expect(plain.attachesDrop(of: file) == false)
        #expect(takes.attachesDrop(of: board { $0.setString("words", forType: .string) }) == false)
        withExtendedLifetime((keepA, keepB)) {}
    }
}
