import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// One file waiting in the bar (WAG-345). `stagedURL` is the copy the app made in the data folder's
/// `incoming/`; the original file is never touched.
struct DraftAttachment: Identifiable, Equatable {
    let id: UUID
    let name: String
    let size: Int
    /// A MIME type: from the file's type, "application/octet-stream" when unknown.
    let type: String
    let stagedURL: URL
    /// The path the person picked or dropped. `nil` for pasted data. Only used to ignore the same file twice.
    let sourcePath: String?
    let thumbnail: NSImage?
    /// True for a file a queued reply already holds ("Change answer"): `stagedURL` is its stored path.
    var isHeld = false

    static func == (lhs: DraftAttachment, rhs: DraftAttachment) -> Bool { lhs.id == rhs.id }

    var isImage: Bool { type.hasPrefix("image/") && type != "image/svg+xml" }

    /// The symbol of the chip when there is no thumbnail.
    var symbolName: String { AttachmentLook.symbolName(type: type, name: name) }
    var sizeText: String { AttachmentLook.sizeText(size) }
}

/// How a file looks in a chip, in the bar and in the answered reply. Pure, so it is unit-tested.
enum AttachmentLook {
    static func symbolName(type: String, name: String) -> String {
        if type.hasPrefix("image/") { return "photo" }
        if type == "application/pdf" { return "doc.richtext" }
        if type.hasPrefix("video/") { return "film" }
        if type.hasPrefix("audio/") { return "waveform" }
        if type == "application/zip" || name.lowercased().hasSuffix(".zip") { return "doc.zipper" }
        if type.hasPrefix("text/") || type == "application/json" { return "doc.text" }
        return "doc"
    }

    /// "340 KB", "2.4 MB": decimal units, as Finder shows them.
    static func sizeText(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    static func mimeType(forFileNamed name: String) -> String {
        let ext = (name as NSString).pathExtension
        return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
    }
}

/// The files a person attaches to the next reply of one case (WAG-345): add by picker, drop or paste, remove,
/// and the limits. One object per case, shared by the case pane and the review workspace through
/// `ComposerDraftStore`, so every composer of the case shows the same chips.
///
/// Each file is copied at once to `<data folder>/incoming/<uuid>/<name>`; the daemon then copies it to its own
/// folder when the reply is stored and removes the incoming copy. The limits are the daemon's own
/// (docs/protocol-mvp.md "Attached files"): 10 files, 25 MB each.
@MainActor
final class ComposerAttachments: ObservableObject {
    static let maxCount = 10
    static let maxBytes = 25 * 1024 * 1024

    @Published private(set) var items: [DraftAttachment] = []
    /// A short, plain message about the last add that did not fully work; cleared by the next add, a remove or a send.
    @Published private(set) var notice: String?

    private let incomingRoot: URL
    private let fileManager: FileManager

    init(
        incomingRoot: URL = URL(fileURLWithPath: KnockClient.defaultDataRoot()).appendingPathComponent("incoming", isDirectory: true),
        fileManager: FileManager = .default
    ) {
        self.incomingRoot = incomingRoot
        self.fileManager = fileManager
    }

    var isEmpty: Bool { items.isEmpty }
    var count: Int { items.count }
    var isFull: Bool { items.count >= Self.maxCount }

    // MARK: Add

    /// Files from the picker or a drop. A folder, an unreadable file, a file over the limit and a file past the
    /// tenth are skipped, and `notice` says so. The same file twice is one chip.
    func add(urls: [URL]) {
        notice = nil
        var tooBig: [String] = []
        var folders = 0
        var skippedForCount = 0
        var failed = 0
        for url in urls where url.isFileURL {
            if items.contains(where: { $0.sourcePath == url.path }) { continue }
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
            if values?.isDirectory == true { folders += 1; continue }
            guard let size = values?.fileSize else { failed += 1; continue }
            if size > Self.maxBytes { tooBig.append(url.lastPathComponent); continue }
            if isFull { skippedForCount += 1; continue }
            guard let staged = stage(name: url.lastPathComponent, write: { try fileManager.copyItem(at: url, to: $0) }) else {
                failed += 1
                continue
            }
            items.append(makeItem(name: url.lastPathComponent, size: size, staged: staged, sourcePath: url.path))
        }
        notice = Self.noticeText(tooBig: tooBig, folders: folders, overCount: skippedForCount, failed: failed)
    }

    /// An image or a file pasted from the clipboard. `name` is what the chip shows ("Pasted image.png").
    func add(data: Data, name: String) {
        notice = nil
        if data.count > Self.maxBytes {
            notice = Self.noticeText(tooBig: [name], folders: 0, overCount: 0, failed: 0)
            return
        }
        if isFull {
            notice = Self.noticeText(tooBig: [], folders: 0, overCount: 1, failed: 0)
            return
        }
        guard let staged = stage(name: name, write: { try data.write(to: $0) }) else {
            notice = Self.noticeText(tooBig: [], folders: 0, overCount: 0, failed: 1)
            return
        }
        items.append(makeItem(name: name, size: data.count, staged: staged, sourcePath: nil))
    }

    /// The clipboard of a Cmd-V: files first (Finder copies), else an image. Returns false when it holds neither,
    /// so the text view pastes text as usual.
    @discardableResult
    func add(from pasteboard: NSPasteboard) -> Bool {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           !urls.isEmpty {
            add(urls: urls)
            return true
        }
        guard let image = (pasteboard.readObjects(forClasses: [NSImage.self]) as? [NSImage])?.first,
              let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return false }
        add(data: png, name: pastedImageName())
        return true
    }

    /// True when `add(from:)` would take something from this clipboard: a file or an image.
    static func canAdd(from pasteboard: NSPasteboard) -> Bool {
        pasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
            || pasteboard.canReadObject(forClasses: [NSImage.self], options: nil)
    }

    /// "Pasted image.png", then "Pasted image 2.png".
    private func pastedImageName() -> String {
        var n = 1
        var name = "Pasted image.png"
        while items.contains(where: { $0.name == name }) {
            n += 1
            name = "Pasted image \(n).png"
        }
        return name
    }

    // MARK: Remove

    func remove(_ id: UUID) {
        notice = nil
        guard let item = items.first(where: { $0.id == id }) else { return }
        items.removeAll { $0.id == id }
        discard(item)
    }

    /// Empties the bar. `deleteStaged` removes the incoming copies; leave it false after the daemon took them.
    func clear(deleteStaged: Bool = true) {
        let old = items
        items = []
        notice = nil
        if deleteStaged { old.forEach(discard) }
    }

    func clearNotice() { notice = nil }

    /// "Change answer": shows the files the queued reply already holds, so the person can keep or drop them.
    func restore(_ held: [ReplyAttachment]) {
        items = held.map { file in
            let url = URL(fileURLWithPath: file.path)
            var item = DraftAttachment(
                id: UUID(), name: file.name, size: file.size, type: file.type, stagedURL: url, sourcePath: nil,
                thumbnail: file.isImage ? Self.thumbnail(of: url) : nil)
            item.isHeld = true
            return item
        }
        notice = nil
    }

    // MARK: Send

    /// What `reply.submit` and `reply.replace` take. `nil` when the bar holds no file.
    func wireInputs() -> [ReplyAttachmentInput]? {
        items.isEmpty ? nil : items.map {
            $0.isHeld
                ? ReplyAttachmentInput(name: $0.name, path: $0.stagedURL.path)
                : ReplyAttachmentInput(name: $0.name, incomingPath: $0.stagedURL.path, type: $0.type)
        }
    }

    // MARK: Words

    /// One short sentence for what was skipped, most useful first. `nil` when nothing was.
    static func noticeText(tooBig: [String], folders: Int, overCount: Int, failed: Int) -> String? {
        let limit = maxBytes / (1024 * 1024)
        if let first = tooBig.first {
            return tooBig.count == 1
                ? "\(first) is over \(limit) MB, so it was not added."
                : "\(tooBig.count) files are over \(limit) MB, so they were not added."
        }
        if overCount > 0 { return "You can attach up to \(maxCount) files to a reply." }
        if folders > 0 { return folders == 1 ? "A folder can't be attached. Zip it first." : "Folders can't be attached. Zip them first." }
        if failed > 0 { return "Waggle could not read that file." }
        return nil
    }

    // MARK: Staging

    private func stage(name: String, write: (URL) throws -> Void) -> URL? {
        let folder = incomingRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let target = folder.appendingPathComponent(Self.safeFileName(name))
        do {
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
            try write(target)
            return target
        } catch {
            try? fileManager.removeItem(at: folder)
            return nil
        }
    }

    private func discard(_ item: DraftAttachment) {
        guard !item.isHeld else { return }
        try? fileManager.removeItem(at: item.stagedURL.deletingLastPathComponent())
    }

    private func makeItem(name: String, size: Int, staged: URL, sourcePath: String?) -> DraftAttachment {
        let type = AttachmentLook.mimeType(forFileNamed: name)
        return DraftAttachment(
            id: UUID(), name: name, size: size, type: type, stagedURL: staged, sourcePath: sourcePath,
            thumbnail: type.hasPrefix("image/") && type != "image/svg+xml" ? Self.thumbnail(of: staged) : nil)
    }

    /// A file name with no folder part.
    static func safeFileName(_ name: String) -> String {
        let last = name.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? ""
        let cleaned = last.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.map(String.init).joined()
            .trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "file" : cleaned
    }

    /// A small preview for a chip: 64 pt on the long side, at 2x.
    static func thumbnail(of url: URL, maxPixel: Int = 128) -> NSImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width / 2, height: cg.height / 2))
    }
}
