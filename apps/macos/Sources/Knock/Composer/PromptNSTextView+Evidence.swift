import AppKit

extension PromptNSTextView {
    /// `KNOCK_EVIDENCE_PASTE=<png>` (evidence hook): puts that image on the clipboard as a screenshot does,
    /// then presses Cmd-V through the app's menu, the path a plain-text view had turned off. A capture has no
    /// keyboard. The clipboard's text comes back after. It replaces the system clipboard, so it works only in a
    /// process whose `KNOCK_BUNDLE_ID` starts with `dev.limone.knock.evidence`.
    private static var evidencePasted = false
    func runEvidencePaste() {
        let environment = ProcessInfo.processInfo.environment
        guard !Self.evidencePasted, window != nil, coordinator?.parent.onPaste != nil,
              environment["KNOCK_BUNDLE_ID"]?.hasPrefix("dev.limone.knock.evidence") == true,
              let path = environment["KNOCK_EVIDENCE_PASTE"],
              let png = FileManager.default.contents(atPath: path) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            // SwiftUI may have swapped this field for a new one by now: only a field still on screen pastes.
            guard let self, let window = self.window, !Self.evidencePasted else { return }
            Self.evidencePasted = true
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(self)
            let board = NSPasteboard.general
            let saved = board.string(forType: .string)
            board.clearContents()
            board.setData(png, forType: .png)
            let event = NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, characters: "v", charactersIgnoringModifiers: "v",
                isARepeat: false, keyCode: 9)
            let item = NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
            let enabled = self.validateUserInterfaceItem(item)
            // A window started from a script may never be key: then the menu has no one to send Paste to,
            // so send it here, and only when the field enabled it, as the menu does.
            let handled = window.isKeyWindow
                ? event.map { NSApp.mainMenu?.performKeyEquivalent(with: $0) ?? false } ?? false
                : enabled && NSApp.sendAction(#selector(NSText.paste(_:)), to: self, from: item)
            FileHandle.standardError.write(Data(
                "evidence paste: key=\(window.isKeyWindow) responder=\(window.firstResponder === self) paste enabled=\(enabled) Paste sent=\(handled)\n".utf8))
            board.clearContents()
            if let saved { board.setString(saved, forType: .string) }
        }
    }
}
