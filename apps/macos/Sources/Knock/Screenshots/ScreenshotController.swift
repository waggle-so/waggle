import AppKit
import Carbon.HIToolbox
import SwiftUI

/// A borderless floating panel that never activates the app. The Send panel can take keys (the note field); the
/// badge cannot.
final class ScreenshotPanel: NSPanel {
    var takesKeys = false
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { takesKeys }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

/// The two system-wide shortcuts (WAG-404): Control Option S and Control Shift W. Carbon's hot key API needs no
/// Accessibility or Input Monitoring permission.
enum HotKey: UInt32, CaseIterable {
    case sendScreenshot = 1
    case snip = 2

    var keyCode: UInt32 {
        switch self {
        case .sendScreenshot: UInt32(kVK_ANSI_S)
        case .snip: UInt32(kVK_ANSI_W)
        }
    }

    var modifiers: UInt32 {
        switch self {
        case .sendScreenshot: UInt32(controlKey | optionKey)
        case .snip: UInt32(controlKey | shiftKey)
        }
    }
}

/// Tests use a fake, so no test registers a real shortcut.
@MainActor
protocol HotKeyRegistering: AnyObject {
    func register(_ key: HotKey, action: @escaping () -> Void)
    func unregister(_ key: HotKey)
}

/// One Carbon event handler for both ids.
@MainActor
final class CarbonHotKeys: HotKeyRegistering {
    private var refs: [HotKey: EventHotKeyRef] = [:]
    private var actions: [UInt32: () -> Void] = [:]
    private var handler: EventHandlerRef?
    private static var current: CarbonHotKeys?

    func register(_ key: HotKey, action: @escaping () -> Void) {
        guard refs[key] == nil else { return }
        Self.current = self
        if handler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
                var id = EventHotKeyID()
                GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                  MemoryLayout<EventHotKeyID>.size, nil, &id)
                let which = id.id
                DispatchQueue.main.async { MainActor.assumeIsolated { CarbonHotKeys.current?.actions[which]?() } }
                return noErr
            }, 1, &spec, nil, &handler)
        }
        var ref: EventHotKeyRef?
        let id = EventHotKeyID(signature: OSType(0x57474C53), id: key.rawValue)  // 'WGLS'
        RegisterEventHotKey(key.keyCode, key.modifiers, id, GetApplicationEventTarget(), 0, &ref)
        if let ref {
            refs[key] = ref
            actions[key.rawValue] = action
        }
    }

    func unregister(_ key: HotKey) {
        if let ref = refs[key] { UnregisterEventHotKey(ref) }
        refs[key] = nil
        actions[key.rawValue] = nil
        if refs.isEmpty, let handler {
            RemoveEventHandler(handler)
            self.handler = nil
            if Self.current === self { Self.current = nil }
        }
    }
}

/// Owns the watch, the shortcuts, the badge and the panels (WAG-402, WAG-404). Off means none of them runs.
@MainActor
final class ScreenshotController {
    private let watcher: ScreenshotWatcher
    private let loadSessions: () async -> [SessionInfo]
    private let loadCases: () async -> [Case]
    private let sendPrompt: (String, String) async throws -> SendPromptResult
    private let defaults: UserDefaults
    private let hotKeys: HotKeyRegistering
    private let capturer: AreaCapturing
    private let frontmostApp: () -> String?
    private let hasScreenAccess: () -> Bool
    private let requestScreenAccess: () -> Void
    private let makeLauncher: () -> SessionStarting
    private let folderPicker: @MainActor (URL) -> URL?
    private let snipFolder: URL
    private let showsWindows: Bool
    private var modeObserver: NSObjectProtocol?
    private var badge: ScreenshotPanel?
    private var badgeTimer: Task<Void, Never>?
    private var panel: ScreenshotPanel?
    private var closeTimer: Task<Void, Never>?
    private var snipRunning = false
    /// The model of the panel on screen now. Tests read it.
    private(set) var panelModel: ScreenshotPanelModel?
    private(set) var noticeText: String?

    var mode: ScreenshotMode { watcher.mode }
    var snipIsOn: Bool { ScreenshotSettings.snipIsOn(defaults: defaults) }

    init(
        source: ScreenCaptureSource = MetadataScreenCaptureSource(),
        defaults: UserDefaults = .standard,
        hotKeys: HotKeyRegistering? = nil,
        capturer: AreaCapturing = ScreencaptureAreaCapturer(),
        frontmostApp: @escaping () -> String? = { NSWorkspace.shared.frontmostApplication?.localizedName },
        hasScreenAccess: @escaping () -> Bool = { CGPreflightScreenCaptureAccess() },
        requestScreenAccess: @escaping () -> Void = { _ = CGRequestScreenCaptureAccess() },
        makeLauncher: @escaping () -> SessionStarting = { SessionLauncher() },
        folderPicker: @escaping @MainActor (URL) -> URL? = SendHelpers.openFolderPanel,
        snipFolder: URL = SnipFiles.folder(),
        showsWindows: Bool = true,
        loadSessions: @escaping () async -> [SessionInfo],
        loadCases: @escaping () async -> [Case],
        sendPrompt: @escaping (String, String) async throws -> SendPromptResult
    ) {
        watcher = ScreenshotWatcher(source: source)
        self.defaults = defaults
        self.hotKeys = hotKeys ?? CarbonHotKeys()
        self.capturer = capturer
        self.frontmostApp = frontmostApp
        self.hasScreenAccess = hasScreenAccess
        self.requestScreenAccess = requestScreenAccess
        self.makeLauncher = makeLauncher
        self.folderPicker = folderPicker
        self.snipFolder = snipFolder
        self.showsWindows = showsWindows
        self.loadSessions = loadSessions
        self.loadCases = loadCases
        self.sendPrompt = sendPrompt
        watcher.onBadge = { [weak self] capture in Task { await self?.showBadge(for: capture) } }
        modeObserver = NotificationCenter.default.addObserver(
            forName: .knockScreenshotModeChanged, object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.refreshMode() } }
        refreshMode()
    }

    func refreshMode() {
        let mode = ScreenshotSettings.mode(defaults: defaults)
        watcher.apply(mode)
        if mode.isOn { hotKeys.register(.sendScreenshot) { [weak self] in self?.openShortcutPanel() } } else {
            hotKeys.unregister(.sendScreenshot)
            closeBadge(animated: false)
            if panelModel?.kind != .snip { closePanel() }
        }
        if snipIsOn { hotKeys.register(.snip) { [weak self] in self?.startSnip() } } else {
            hotKeys.unregister(.snip)
            if panelModel?.kind == .snip || noticeText != nil { closePanel() }
        }
    }

    // MARK: Badge

    private func showBadge(for capture: ScreenCapture) async {
        let sessions = await loadSessions()
        guard watcher.mode == .everyShot, sessions.contains(where: { $0.state == .live }) else { return }
        let rows = ScreenshotRows.rows(sessions: sessions, cases: await loadCases(), lastUsed: ScreenshotSettings.lastSession(defaults: defaults))
        presentBadge(capture: capture, subtitle: ScreenshotRows.badgeSubtitle(rows))
    }

    func presentBadge(capture: ScreenCapture, subtitle: String?) {
        closeBadge(animated: false)
        let view = ScreenshotBadgeView(
            subtitle: subtitle,
            onOpen: { [weak self] in
                self?.closeBadge(animated: false)
                Task { await self?.openPanel(kind: .badge, captures: [capture]) }
            },
            onTurnOff: { [weak self] in
                ScreenshotSettings.setMode(.off, defaults: self?.defaults ?? .standard)
            })
        let (host, size) = Self.fixedHost(view)
        let panel = makePanel(content: host, size: size)
        let screen = Self.screen()
        panel.setFrameOrigin(ScreenshotGeometry.badgeOrigin(screen: screen.visibleFrame, size: size))
        panel.orderFrontRegardless()
        badge = panel
        badgeTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            self?.closeBadge(animated: true)
        }
    }

    private func closeBadge(animated: Bool) {
        badgeTimer?.cancel()
        badgeTimer = nil
        guard let old = badge else { return }
        badge = nil
        if animated {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.15
                old.animator().alphaValue = 0
            }, completionHandler: { old.orderOut(nil) })
        } else {
            old.orderOut(nil)
        }
    }

    // MARK: Panels

    /// Control Option S and the menu bar item. Nothing happens with the mode Off.
    func openShortcutPanel() {
        guard watcher.mode.isOn else { return }
        closeBadge(animated: false)
        Task { await openPanel(kind: .shortcut, captures: watcher.latest(3)) }
    }

    private func openPanel(kind: ScreenshotPanelModel.Kind, captures: [ScreenCapture]) async {
        let sessions = await loadSessions()
        let rows = ScreenshotRows.rows(sessions: sessions, cases: await loadCases(), lastUsed: ScreenshotSettings.lastSession(defaults: defaults))
        present(kind: kind, captures: captures, rows: rows, newSession: newSessionConfig(sessions: sessions))
    }

    /// The New session row (WAG-404): the saved launch target and the folders to start in.
    func newSessionConfig(sessions: [SessionInfo]) -> NewSessionConfig {
        let target = UserDefaultsLaunchTargetStore(defaults: defaults).load() ?? .claudeTerminal
        let saved = NewSessionFolders.savedFolder(defaults: defaults)
        let makeLauncher = makeLauncher, picker = folderPicker
        return NewSessionConfig(
            subtitle: NewSessionFolders.launchTargetName(target),
            folders: NewSessionFolders.choices(sessions: sessions, saved: saved),
            defaultFolder: saved,
            start: { text, folder, topic in await makeLauncher().start(prompt: text, folder: folder, topic: topic) },
            chooseOther: { picker($0) })
    }

    @discardableResult
    func present(
        kind: ScreenshotPanelModel.Kind, captures: [ScreenCapture], rows: [ScreenshotSessionRow],
        snip: SnipInfo? = nil, box: CGRect? = nil, newSession: NewSessionConfig? = nil
    ) -> ScreenshotPanelModel {
        closePanel()
        let defaults = defaults
        let model = ScreenshotPanelModel(
            kind: kind, captures: captures, rows: rows, sendPrompt: sendPrompt,
            remember: { ScreenshotSettings.setLastSession($0, defaults: defaults) },
            copy: { text in
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            },
            finish: { [weak self] in
                // The panel is one line for 3 s, then it goes.
                self?.closeTimer = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(3))
                    guard !Task.isCancelled else { return }
                    self?.closePanel()
                }
            },
            snip: snip, newSession: newSession ?? newSessionConfig(sessions: []))
        panelModel = model
        guard showsWindows else { return model }
        let host = NSHostingView(rootView: ScreenshotPanelView(model: model, onClose: { [weak self] in self?.closePanel() }))
        host.sizingOptions = [.intrinsicContentSize]
        let size = host.fittingSize
        let panel = makePanel(content: host, size: size)
        panel.takesKeys = true
        panel.onEscape = { [weak self] in self?.closePanel() }
        let screen = Self.screen().visibleFrame
        switch kind {
        case .badge: panel.setFrameOrigin(ScreenshotGeometry.cornerPanelOrigin(screen: screen, size: size))
        case .shortcut: panel.setFrameOrigin(ScreenshotGeometry.shortcutPanelOrigin(screen: screen, size: size))
        case .snip:
            let box = box ?? CGRect(origin: NSEvent.mouseLocation, size: .zero)
            panel.setFrameOrigin(ScreenshotGeometry.snipPanelOrigin(box: box, screen: screen, size: size))
        }
        panel.makeKeyAndOrderFront(nil)
        self.panel = panel
        return model
    }

    func closePanel() {
        closeTimer?.cancel()
        closeTimer = nil
        panel?.orderOut(nil)
        panel = nil
        panelModel = nil
        noticeText = nil
    }

    // MARK: Snip an area (WAG-404)

    /// Control Shift W and the menu bar. Nothing happens with Snip Off.
    func startSnip() {
        guard snipIsOn, !snipRunning else { return }
        Task { await snip() }
    }

    /// The crosshair, then the panel. Esc shows nothing; a failed run shows one line.
    func snip() async {
        guard snipIsOn, !snipRunning else { return }
        snipRunning = true
        defer { snipRunning = false }
        closeBadge(animated: false)
        closePanel()
        let app = frontmostApp()
        let file = SnipFiles.newFile(in: snipFolder)
        let tracker = DragTracker()
        tracker.start()
        let outcome = await capturer.capture(to: file)
        let box = tracker.finish()
        switch outcome {
        case .cancelled:
            // A blocked capture also ends with no file. Without Screen Recording, say so instead of showing nothing (WAG-405).
            guard !hasScreenAccess() else { return }
            requestScreenAccess()
            showNotice(ScreenshotCopy.snipNeedsAccess)
        case .failed:
            showNotice(ScreenshotCopy.snipFailed)
        case .captured(let url):
            SnipFiles.prune(in: snipFolder)
            let size = SnipFiles.pixelSize(of: url) ?? (0, 0)
            let sessions = await loadSessions()
            let rows = ScreenshotRows.rows(sessions: sessions, cases: await loadCases(), lastUsed: ScreenshotSettings.lastSession(defaults: defaults))
            let capture = ScreenCapture(url: url, date: Date())
            present(
                kind: .snip, captures: [capture], rows: rows,
                snip: SnipInfo(width: size.0, height: size.1, app: app), box: box,
                newSession: newSessionConfig(sessions: sessions))
        }
    }

    private func showNotice(_ text: String) {
        closePanel()
        noticeText = text
        guard showsWindows else { return }
        let (host, size) = Self.fixedHost(ScreenshotNoticeView(text: text))
        let panel = makePanel(content: host, size: size)
        panel.setFrameOrigin(ScreenshotGeometry.shortcutPanelOrigin(screen: Self.screen().visibleFrame, size: size))
        panel.orderFrontRegardless()
        self.panel = panel
        closeTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            self?.closePanel()
        }
    }

    private func makePanel(content: NSView, size: CGSize) -> ScreenshotPanel {
        let panel = ScreenshotPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isReleasedWhenClosed = false
        panel.contentView = content
        return panel
    }

    /// The view of a panel whose size never changes: the badge and the one-line notice. It is measured once,
    /// rounded up to whole points, and put inside a plain container view. When an `NSHostingView` is the window's
    /// own content view, SwiftUI also sizes the window (`updateWindowContentSizeExtremaIfNecessary`) in every
    /// constraints pass, and turning its sizing options off did not stop that: 0.2.72 crashed twice and 0.2.73
    /// once (22 Nov) in a resize loop that AppKit ended with an exception. Inside a container, SwiftUI only lays
    /// out the badge and never touches the panel.
    static func fixedHost<Content: View>(_ view: Content) -> (NSView, CGSize) {
        let host = NSHostingView(rootView: view)
        let fit = host.fittingSize
        host.sizingOptions = []
        let size = CGSize(width: ceil(fit.width), height: ceil(fit.height))
        let container = NSView(frame: NSRect(origin: .zero, size: size))
        host.frame = container.bounds
        host.autoresizingMask = [.width, .height]
        container.addSubview(host)
        return (container, size)
    }

    private static func screen() -> NSScreen { NSScreen.main ?? NSScreen.screens[0] }

    // MARK: Evidence

    /// Evidence only (WAG-402): `KNOCK_EVIDENCE_SCREENSHOT=<output folder>` draws the badge and both panels with
    /// fake sessions and a drawn image, each window to its own PNG with `cacheDisplay`. It never reads the screen
    /// or another app's windows.
    func runEvidence(into folder: String) {
        let out = URL(fileURLWithPath: folder, isDirectory: true)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let shots = ScreenshotEvidence.makeImages(in: out.appendingPathComponent("fixtures", isDirectory: true))
        let rows = ScreenshotEvidence.rows
        let config = ScreenshotEvidence.newSession
        let snipInfo = SnipInfo(width: 960, height: 600, app: "Safari")
        Task { @MainActor in
            presentBadge(capture: shots[0], subtitle: ScreenshotRows.badgeSubtitle(rows))
            try? await Task.sleep(for: .seconds(1))
            ScreenshotEvidence.write(badge, to: out.appendingPathComponent("badge.png"))
            closeBadge(animated: false)
            present(kind: .badge, captures: [shots[0]], rows: rows, newSession: config)
            try? await Task.sleep(for: .seconds(1))
            ScreenshotEvidence.write(panel, to: out.appendingPathComponent("send-panel.png"))
            present(kind: .shortcut, captures: shots, rows: rows, newSession: config)
            try? await Task.sleep(for: .seconds(1))
            ScreenshotEvidence.write(panel, to: out.appendingPathComponent("shortcut-panel.png"))
            present(kind: .snip, captures: [shots[0]], rows: rows, snip: snipInfo, newSession: config)
            try? await Task.sleep(for: .seconds(1))
            ScreenshotEvidence.write(panel, to: out.appendingPathComponent("snip-panel-live-session.png"))
            panelModel?.pickNewSession()
            try? await Task.sleep(for: .seconds(1))
            ScreenshotEvidence.write(panel, to: out.appendingPathComponent("snip-panel-new-session.png"))
            present(kind: .badge, captures: [shots[0]], rows: rows, newSession: config)
            panelModel?.pickNewSession()
            try? await Task.sleep(for: .seconds(1))
            ScreenshotEvidence.write(panel, to: out.appendingPathComponent("send-panel-new-session.png"))
            closePanel()
            NSApp.terminate(nil)
        }
    }
}

enum ScreenshotEvidence {
    static let rows: [ScreenshotSessionRow] = [
        ScreenshotSessionRow(id: "a", name: "Fix the empty state", dot: .working, stateLine: "Working", canSend: true, place: "omea \u{00B7} Fragrant hospital", agent: "Claude Code"),
        ScreenshotSessionRow(id: "b", name: "Snip an area", dot: .waiting, stateLine: "Waiting for you", canSend: true, place: "waggle \u{00B7} Rumbling tray", agent: "Claude Code"),
        ScreenshotSessionRow(id: "c", name: "Landing page", dot: .idle, stateLine: "Idle", canSend: true, place: "waggle-site", agent: "Codex"),
        ScreenshotSessionRow(id: "d", name: "Claude app", dot: .idle, stateLine: ScreenshotCopy.notTypeable, canSend: false, agent: "Claude app"),
    ]

    @MainActor
    static var newSession: NewSessionConfig {
        NewSessionConfig(
            subtitle: "Claude Code in Terminal",
            folders: [
                FolderChoice(url: URL(fileURLWithPath: "/Users/demo/fragrant-hospital")),
                FolderChoice(url: URL(fileURLWithPath: "/Users/demo/waggle")),
                FolderChoice(url: URL(fileURLWithPath: "/Users/demo/Desktop")),
            ],
            defaultFolder: URL(fileURLWithPath: "/Users/demo/fragrant-hospital"),
            start: { _, _, _ in true }, chooseOther: { _ in nil })
    }

    @MainActor
    static func makeImages(in folder: URL) -> [ScreenCapture] {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let tints: [NSColor] = [.systemBlue, .systemOrange, .systemTeal]
        return tints.enumerated().map { index, tint in
            let image = NSImage(size: NSSize(width: 480, height: 300), flipped: false) { rect in
                tint.withAlphaComponent(0.25).setFill()
                rect.fill()
                NSColor.white.setFill()
                NSBezierPath(roundedRect: rect.insetBy(dx: 30, dy: 40), xRadius: 12, yRadius: 12).fill()
                tint.setFill()
                NSBezierPath(roundedRect: NSRect(x: 50, y: 200, width: 220, height: 24), xRadius: 6, yRadius: 6).fill()
                return true
            }
            let url = folder.appendingPathComponent("Screenshot \(index + 1).png")
            if let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: url)
            }
            return ScreenCapture(url: url, date: Date().addingTimeInterval(-Double(index) * 60))
        }
    }

    @MainActor
    static func write(_ window: NSWindow?, to url: URL) {
        guard let content = window?.contentView, let rep = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { return }
        content.cacheDisplay(in: content.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }
}

/// Records where the operator drags during the crosshair, from global mouse events. These need no permission.
@MainActor
final class DragTracker {
    private var monitor: Any?
    private var down: CGPoint?
    private var up: CGPoint?

    func start() {
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self] event in
            let point = NSEvent.mouseLocation
            let isDown = event.type == .leftMouseDown
            MainActor.assumeIsolated {
                if isDown { self?.down = point; self?.up = nil } else { self?.up = point }
            }
        }
    }

    /// The box between the press and the release, else the point where the pointer is now.
    func finish() -> CGRect {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        guard let down, let up else { return CGRect(origin: NSEvent.mouseLocation, size: .zero) }
        return CGRect(x: min(down.x, up.x), y: min(down.y, up.y), width: abs(down.x - up.x), height: abs(down.y - up.y))
    }
}
