import AppKit
import Foundation
import Testing
@testable import Knock

/// WAG-345: files attached to a reply from the comment bar. The model (add, remove, limits, paste), the
/// reply payload, the old payload, and a send with files only.
@Suite(.serialized)
@MainActor
struct ComposerAttachmentsTests {
    // MARK: Fixtures

    private func tempDir(_ label: String = "att") -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("knock_\(label)_\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func file(_ name: String, in dir: URL, bytes: Int = 5) -> URL {
        let url = dir.appendingPathComponent(name)
        FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 0x61, count: bytes))
        return url
    }

    /// A file of `bytes` bytes without writing them (a sparse file).
    private func sparseFile(_ name: String, in dir: URL, bytes: Int) -> URL {
        let url = dir.appendingPathComponent(name)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try! FileHandle(forWritingTo: url)
        try! handle.truncate(atOffset: UInt64(bytes))
        try! handle.close()
        return url
    }

    private func model() -> (files: ComposerAttachments, incoming: URL, source: URL) {
        let incoming = tempDir("incoming")
        return (ComposerAttachments(incomingRoot: incoming), incoming, tempDir("source"))
    }

    private func png() -> Data {
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 4, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        return rep.representation(using: .png, properties: [:])!
    }

    // MARK: Add and remove

    @Test func addingFilesStagesACopyAndKeepsTheOriginal() {
        let (files, incoming, source) = model()
        let a = file("notes.md", in: source, bytes: 12)
        let b = file("brief.pdf", in: source, bytes: 2048)

        files.add(urls: [a, b])

        #expect(files.items.map(\.name) == ["notes.md", "brief.pdf"])
        #expect(files.items.map(\.size) == [12, 2048])
        #expect(files.items[0].type == "text/markdown")
        #expect(files.items[1].type == "application/pdf")
        #expect(files.notice == nil)
        for item in files.items {
            #expect(FileManager.default.fileExists(atPath: item.stagedURL.path))
            #expect(item.stagedURL.path.hasPrefix(incoming.path + "/"), "a copy goes under incoming/")
        }
        #expect(FileManager.default.fileExists(atPath: a.path), "the original stays")
    }

    @Test func theSameFileTwiceIsOneChip() {
        let (files, _, source) = model()
        let a = file("a.txt", in: source)
        files.add(urls: [a])
        files.add(urls: [a])
        #expect(files.count == 1)
    }

    @Test func removingAChipDeletesItsStagedCopy() {
        let (files, _, source) = model()
        files.add(urls: [file("a.txt", in: source), file("b.txt", in: source)])
        let first = files.items[0]

        files.remove(first.id)

        #expect(files.items.map(\.name) == ["b.txt"])
        #expect(!FileManager.default.fileExists(atPath: first.stagedURL.path))
    }

    @Test func clearEmptiesTheBarAndTheStagedCopies() {
        let (files, _, source) = model()
        files.add(urls: [file("a.txt", in: source)])
        let staged = files.items[0].stagedURL
        files.clear()
        #expect(files.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: staged.path))
    }

    // MARK: Limits

    @Test func theEleventhFileIsNotAddedAndTheMessageSaysWhy() {
        let (files, _, source) = model()
        let urls = (0..<11).map { file("f\($0).txt", in: source) }
        files.add(urls: urls)
        #expect(files.count == 10)
        #expect(files.notice == "You can attach up to 10 files to a reply.")
        #expect(files.isFull)
    }

    @Test func aFileOver25MBIsNotAddedAndTheMessageNamesIt() {
        let (files, _, source) = model()
        let big = sparseFile("recording.mov", in: source, bytes: ComposerAttachments.maxBytes + 1)
        let ok = file("small.txt", in: source)

        files.add(urls: [big, ok])

        #expect(files.items.map(\.name) == ["small.txt"], "the other files still attach")
        #expect(files.notice == "recording.mov is over 25 MB, so it was not added.")
    }

    @Test func aFileOf25MBExactlyIsAccepted() {
        let (files, _, source) = model()
        files.add(urls: [sparseFile("edge.bin", in: source, bytes: ComposerAttachments.maxBytes)])
        #expect(files.count == 1)
        #expect(files.notice == nil)
    }

    @Test func aFolderIsNotAddedAndTheMessageSaysSo() {
        let (files, _, source) = model()
        let folder = source.appendingPathComponent("assets")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        files.add(urls: [folder])
        #expect(files.isEmpty)
        #expect(files.notice == "A folder can't be attached. Zip it first.")
    }

    @Test func theNextAddClearsTheMessage() {
        let (files, _, source) = model()
        files.add(urls: [sparseFile("big.bin", in: source, bytes: ComposerAttachments.maxBytes + 1)])
        #expect(files.notice != nil)
        files.add(urls: [file("a.txt", in: source)])
        #expect(files.notice == nil)
    }

    @Test func theLimitsAreTheDaemonsLimits() {
        #expect(ComposerAttachments.maxCount == 10)
        #expect(ComposerAttachments.maxBytes == 25 * 1024 * 1024)
    }

    // MARK: Paste

    @Test func aPastedImageBecomesAChipWithAThumbnail() {
        let (files, _, _) = model()
        let board = NSPasteboard(name: NSPasteboard.Name("knock-test-\(UUID().uuidString)"))
        board.clearContents()
        board.setData(png(), forType: .png)

        let took = files.add(from: board)

        #expect(took)
        #expect(files.items.map(\.name) == ["Pasted image.png"])
        #expect(files.items[0].type == "image/png")
        #expect(files.items[0].thumbnail != nil)
        #expect(files.items[0].isImage)
    }

    @Test func twoPastedImagesGetTwoNames() {
        let (files, _, _) = model()
        files.add(data: png(), name: "Pasted image.png")
        let board = NSPasteboard(name: NSPasteboard.Name("knock-test-\(UUID().uuidString)"))
        board.clearContents()
        board.setData(png(), forType: .png)
        files.add(from: board)
        #expect(files.items.map(\.name) == ["Pasted image.png", "Pasted image 2.png"])
    }

    @Test func aPastedFileIsAttachedByItsPath() {
        let (files, _, source) = model()
        let a = file("budget.csv", in: source, bytes: 30)
        let board = NSPasteboard(name: NSPasteboard.Name("knock-test-\(UUID().uuidString)"))
        board.clearContents()
        board.writeObjects([a as NSURL])

        #expect(files.add(from: board))
        #expect(files.items.map(\.name) == ["budget.csv"])
        #expect(files.items[0].size == 30)
    }

    @Test func aScreenshotOnTheClipboardCanBePasted() {
        let board = NSPasteboard(name: NSPasteboard.Name("knock-test-\(UUID().uuidString)"))
        board.clearContents()
        board.setData(png(), forType: .png)
        #expect(ComposerAttachments.canAdd(from: board))
        board.clearContents()
        board.setString("just words", forType: .string)
        #expect(ComposerAttachments.canAdd(from: board) == false)
    }

    @Test func pastedTextIsLeftToTheTextField() {
        let (files, _, _) = model()
        let board = NSPasteboard(name: NSPasteboard.Name("knock-test-\(UUID().uuidString)"))
        board.clearContents()
        board.setString("just words", forType: .string)
        #expect(files.add(from: board) == false)
        #expect(files.isEmpty)
    }

    // MARK: Wire

    @Test func theWireInputsNameTheIncomingCopies() {
        let (files, incoming, source) = model()
        files.add(urls: [file("a.png", in: source)])
        let inputs = files.wireInputs()
        #expect(inputs?.count == 1)
        #expect(inputs?[0].name == "a.png")
        #expect(inputs?[0].type == "image/png")
        #expect(inputs?[0].path == nil)
        #expect(inputs?[0].incomingPath?.hasPrefix(incoming.path + "/") == true)
    }

    @Test func noFilesMeansNoField() {
        let (files, _, _) = model()
        #expect(files.wireInputs() == nil)
    }

    @Test func aHeldFileIsNamedByItsStoredPathAndIsNeverDeleted() throws {
        let (files, _, source) = model()
        let stored = file("kept.txt", in: source, bytes: 9)
        files.restore([ReplyAttachment(name: "kept.txt", path: stored.path, size: 9, type: "text/plain")])
        let inputs = files.wireInputs()
        #expect(inputs?[0].path == stored.path)
        #expect(inputs?[0].incomingPath == nil)

        files.remove(files.items[0].id)
        #expect(FileManager.default.fileExists(atPath: stored.path), "the daemon owns a held file")
        #expect(files.wireInputs() == nil)
    }

    @Test func theSubmitParamsCarryAttachmentsOnlyWhenThereAreSome() throws {
        func keys(_ params: ReplySubmitParams) throws -> [String] {
            let data = try JSONEncoder().encode(params)
            return Array((try JSONSerialization.jsonObject(with: data) as! [String: Any]).keys)
        }
        let bare = ReplySubmitParams(caseId: "c", idempotencyKey: "k", choice: "a", message: nil, comments: [], captures: [], intent: .decision)
        #expect(try !keys(bare).contains("attachments"), "an old daemon never sees the field")
        var withFiles = bare
        withFiles.attachments = [ReplyAttachmentInput(name: "a.png", incomingPath: "/x/incoming/u/a.png", type: "image/png")]
        let data = try JSONEncoder().encode(withFiles)
        let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let list = object["attachments"] as! [[String: Any]]
        #expect(list[0]["incoming_path"] as? String == "/x/incoming/u/a.png")
        #expect(list[0]["name"] as? String == "a.png")
    }

    @Test func aReplyDecodesWithAndWithoutAttachments() throws {
        func reply(_ extra: String) -> Data {
            Data(#"{"id":"r","case_id":"c","idempotency_key":"k","comments":[],"captures":[],"state":"queued","created_at":"2026-10-09T10:00:00Z"\#(extra)}"#.utf8)
        }
        let old = try JSONDecoder().decode(Reply.self, from: reply(""))
        #expect(old.attachments == nil)
        let new = try JSONDecoder().decode(
            Reply.self, from: reply(#","attachments":[{"name":"a.png","path":"/d/attachments/r/a.png","size":10,"type":"image/png"}]"#))
        #expect(new.attachments == [ReplyAttachment(name: "a.png", path: "/d/attachments/r/a.png", size: 10, type: "image/png")])
        #expect(new.attachments?[0].isImage == true)
    }

    @Test func aPendingReplyKeepsItsFilesAndAnOldOneStillDecodes() throws {
        var pending = PendingReply(caseId: "c", idempotencyKey: "k", choice: nil, message: nil, comments: [], captures: [])
        pending.attachments = [ReplyAttachmentInput(name: "a.txt", incomingPath: "/x/incoming/u/a.txt")]
        let round = try JSONDecoder().decode(PendingReply.self, from: JSONEncoder().encode(pending))
        #expect(round.attachments == pending.attachments)
        let old = try JSONDecoder().decode(
            PendingReply.self, from: Data(#"{"case_id":"c","idempotency_key":"k","comments":[],"captures":[]}"#.utf8))
        #expect(old.attachments == nil)
    }

    // MARK: Look

    @Test func chipsPickAnIconByType() {
        #expect(AttachmentLook.symbolName(type: "image/png", name: "a.png") == "photo")
        #expect(AttachmentLook.symbolName(type: "application/pdf", name: "a.pdf") == "doc.richtext")
        #expect(AttachmentLook.symbolName(type: "application/zip", name: "a.zip") == "doc.zipper")
        #expect(AttachmentLook.symbolName(type: "text/markdown", name: "a.md") == "doc.text")
        #expect(AttachmentLook.symbolName(type: "application/octet-stream", name: "a.bin") == "doc")
    }

    @Test func sizesReadLikeFinder() {
        // The decimal mark follows the Mac's language, so only the number and the unit are checked.
        #expect(AttachmentLook.sizeText(340_000) == "340 KB")
        #expect(AttachmentLook.sizeText(2_400_000).hasPrefix("2") && AttachmentLook.sizeText(2_400_000).hasSuffix("4 MB"))
    }

    // MARK: Composer rules

    private func caseWithOptions() -> Case {
        Case(
            id: "c1", taskId: "t1", kind: .question, title: "Layout", need: "Pick one", why: "A product call",
            recommendation: "a", recommendationWhy: "Faster",
            options: [Option(id: "a", label: "A · Compact"), Option(id: "b", label: "B · Detailed")],
            status: .needsYou, hasArtifact: false, createdAt: "2026-10-09T10:00:00Z", updatedAt: "2026-10-09T10:00:00Z")
    }

    private func composer(_ files: ComposerAttachments) -> ComposerViewModel {
        ComposerViewModel(knockCase: caseWithOptions(), files: files)
    }

    @Test func filesAloneCountAsSomethingToSend() {
        #expect(!PromptBarLogic.canSend(hasChoice: false, hasMessage: false, commentCount: 0))
        #expect(PromptBarLogic.canSend(hasChoice: false, hasMessage: false, commentCount: 0, hasFiles: true))
    }

    @Test func filesWithNoPickKeepTheTalkGoing() {
        let (files, _, source) = model()
        let composer = composer(files)
        #expect(!composer.sendsDiscuss)
        files.add(urls: [file("a.txt", in: source)])
        #expect(composer.hasFiles)
        #expect(composer.sendsDiscuss, "WAG-328: attachments alone, with no pick, send as Keep talking")
        composer.selectOption("b")
        #expect(!composer.sendsDiscuss, "with a pick the files go with the decision")
    }

    @Test func resetEmptiesTheFilesToo() {
        let (files, _, source) = model()
        let composer = composer(files)
        files.add(urls: [file("a.txt", in: source)])
        composer.reset()
        #expect(files.isEmpty)
    }

    @Test func theDraftStoreGivesBothComposersOfACaseTheSameFiles() {
        let incoming = tempDir("incoming")
        let store = ComposerDraftStore(makeFiles: { ComposerAttachments(incomingRoot: incoming) })
        let pane = ComposerViewModel(knockCase: caseWithOptions(), draftStore: store)
        let workspace = ComposerViewModel(knockCase: caseWithOptions(), draftStore: store)
        pane.files.add(urls: [file("a.txt", in: tempDir("source"))])
        #expect(workspace.files.count == 1)
        #expect(store.files(caseId: "other").isEmpty)
    }

    // MARK: Sending

    private final class Captured: @unchecked Sendable {
        private let lock = NSLock()
        private var lines: [Data] = []
        func add(_ line: Data) { lock.lock(); lines.append(line); lock.unlock() }
        var all: [Data] { lock.lock(); defer { lock.unlock() }; return lines }
    }

    private struct Envelope: Decodable {
        struct Params: Decodable {
            let intent: String
            let choice: String?
            let message: String?
            let attachments: [ReplyAttachmentInput]?
        }
        let params: Params
    }

    private func startServer() async throws -> (FakeKnockServer, KnockClient, Captured) {
        let socketPath = makeTempSocketPath()
        let server = FakeKnockServer(socketPath: socketPath)
        let captured = Captured()
        server.onRequest = { method, id, line in
            guard method == "reply.submit", let id else { return nil }
            captured.add(line)
            return jsonRPCOK(
                id: id,
                result: #"{"id":"r_1","case_id":"c1","idempotency_key":"k","comments":[],"captures":[],"state":"queued","created_at":"2026-10-09T10:00:00Z"}"#)
        }
        try server.start()
        let client = KnockClient(socketPath: socketPath, backoffSchedule: [0.02])
        await client.start()
        try await waitForState(client, .connected)
        return (server, client, captured)
    }

    private func flow(_ client: KnockClient, files: ComposerAttachments, sent: @escaping () -> Void) -> SendFlowController {
        let home = tempDir("home")
        let coordinator = SendCoordinator(client: client, store: PendingReplyStore(environment: ["KNOCK_HOME": home.path]))
        let store = ComposerDraftStore(makeFiles: { files })
        return SendFlowController(
            knockCase: caseWithOptions(), commentsStore: CommentsSessionStore(), coordinator: coordinator,
            draftStore: store, onSent: sent)
    }

    private func waitFor(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(30)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
    }

    @Test func keepTalkingWithFilesOnlySendsADiscussReplyWithThePaths() async throws {
        let (server, client, captured) = try await startServer()
        defer { server.stop() }
        let (files, incoming, source) = model()
        var sent = 0
        let flow = flow(client, files: files, sent: { sent += 1 })
        files.add(urls: [file("shot.png", in: source), file("brief.pdf", in: source)])

        flow.send()
        try await waitFor { sent == 1 }

        let params = try JSONDecoder().decode(Envelope.self, from: captured.all[0]).params
        #expect(params.intent == "discuss")
        #expect(params.choice == nil)
        #expect(params.message == nil)
        #expect(params.attachments?.map(\.name) == ["shot.png", "brief.pdf"])
        #expect(params.attachments?.allSatisfy { $0.incomingPath?.hasPrefix(incoming.path + "/") == true } == true)
        #expect(files.isEmpty, "the bar empties after a send")
        await client.stop()
    }

    @Test func aDecisionSendsTheFilesWithThePick() async throws {
        let (server, client, captured) = try await startServer()
        defer { server.stop() }
        let (files, _, source) = model()
        var sent = 0
        let flow = flow(client, files: files, sent: { sent += 1 })
        files.add(urls: [file("spec.md", in: source)])
        flow.composer.selectOption("b")
        flow.composer.draftText = "Use B, see the spec"

        flow.send()
        try await waitFor { sent == 1 }

        let params = try JSONDecoder().decode(Envelope.self, from: captured.all[0]).params
        #expect(params.intent == "decision")
        #expect(params.choice == "b")
        #expect(params.message == "Use B, see the spec")
        #expect(params.attachments?.map(\.name) == ["spec.md"])
        await client.stop()
    }

    @Test func anEmptySendSendsNothing() async throws {
        let (server, client, captured) = try await startServer()
        defer { server.stop() }
        let (files, _, _) = model()
        var sent = 0
        let flow = flow(client, files: files, sent: { sent += 1 })

        flow.send()
        try await Task.sleep(for: .milliseconds(200))

        #expect(sent == 0)
        #expect(captured.all.isEmpty)
        await client.stop()
    }

    @Test func aReplyWithNoFilesCarriesNoAttachmentsField() async throws {
        let (server, client, captured) = try await startServer()
        defer { server.stop() }
        let (files, _, _) = model()
        var sent = 0
        let flow = flow(client, files: files, sent: { sent += 1 })
        flow.composer.selectOption("a")

        flow.send()
        try await waitFor { sent == 1 }

        let text = String(decoding: captured.all[0], as: UTF8.self)
        #expect(!text.contains("attachments"), "an old daemon gets the same payload as before")
        await client.stop()
    }
}
