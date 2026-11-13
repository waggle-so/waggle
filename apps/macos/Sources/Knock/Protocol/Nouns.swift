import Foundation

/// One pro or con of an option (task 11a): the agent's full sentence (`detail`) and, from a newer agent, a short gist
/// of it (≤ 40 chars) for the card. On the wire a point is a plain string (an older agent: `detail` only) or an object
/// `{ "gist": "...", "detail": "..." }`. Both decode into this one type; nothing the agent sent is dropped.
struct OptionPoint: Codable, Equatable, Hashable, Sendable, ExpressibleByStringLiteral {
    var gist: String?
    var detail: String

    init(gist: String? = nil, detail: String) {
        let trimmed = gist?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.gist = (trimmed?.isEmpty ?? true) ? nil : trimmed
        self.detail = detail
    }

    init(stringLiteral value: String) { self.init(detail: value) }

    /// What the open card shows: the gist, else the full point (never a cut one).
    var shown: String { gist ?? detail }
    /// True when the card shows less than the full point: there is a gist and it is not the detail.
    var hasMore: Bool { gist.map { $0 != detail.trimmingCharacters(in: .whitespacesAndNewlines) } ?? false }

    private enum CodingKeys: String, CodingKey { case gist, detail }

    init(from decoder: Decoder) throws {
        if let plain = try? decoder.singleValueContainer().decode(String.self) {
            self.init(detail: plain)
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let gist = (try? c.decodeIfPresent(String.self, forKey: .gist)) ?? nil
        let detail = (try? c.decodeIfPresent(String.self, forKey: .detail)) ?? nil
        // Tolerant: an object with only a gist still shows that gist, as its full text.
        guard let text = detail ?? gist else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "A point needs a gist or a detail"))
        }
        self.init(gist: detail == nil ? nil : gist, detail: text)
    }

    /// A point with no gist goes back out as a plain string, so an older ask encodes as before.
    func encode(to encoder: Encoder) throws {
        guard let gist else {
            var single = encoder.singleValueContainer()
            try single.encode(detail)
            return
        }
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(gist, forKey: .gist)
        try c.encode(detail, forKey: .detail)
    }

    /// Decodes a pros or cons list: each entry a string or a `{ gist, detail }` object. An entry of another shape is
    /// skipped, so one bad entry does not drop the ask.
    static func decodeList<K: CodingKey>(_ c: KeyedDecodingContainer<K>, forKey key: K) -> [OptionPoint] {
        guard c.contains(key), (try? c.decodeNil(forKey: key)) != true, var list = try? c.nestedUnkeyedContainer(forKey: key) else {
            return []
        }
        var out: [OptionPoint] = []
        while !list.isAtEnd {
            if let point = try? list.decode(OptionPoint.self) {
                out.append(point)
            } else if (try? list.decode(SkippedValue.self)) == nil {
                break
            }
        }
        return out
    }

    /// Decodes an option's facts: strings only, blank ones left out. Anything else reads as no facts.
    static func decodeFacts<K: CodingKey>(_ c: KeyedDecodingContainer<K>, forKey key: K) -> [String] {
        let raw = (try? c.decodeIfPresent([String].self, forKey: key)) ?? nil
        return (raw ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}

/// Reads past one value of any shape in an unkeyed container.
private struct SkippedValue: Decodable {
    init(from decoder: Decoder) throws {}
}

// One choice the human can pick in reply to a case.
// docs/protocol-mvp.md "MCP tools", knock_ask options.
struct Option: Codable, Equatable, Sendable, Identifiable {
    let id: String
    /// The full option text, shown in full in the ask's Decision section.
    let label: String
    /// The agent's short title (1 to 6 words) for the answer box row (HAIL-85).
    /// `nil` from an older agent: `displayTitle` derives one from `label`.
    var title: String? = nil
    /// The good and the bad of this answer (WAG-276): each a full point and, from a newer agent, its gist (task 11a).
    var proPoints: [OptionPoint] = []
    var conPoints: [OptionPoint] = []
    /// Up to 3 short facts (cost, time, size) the card shows as chips under the title (task 11a). Empty from an older agent.
    var facts: [String] = []
    /// What picking this option causes: what it touches, closes or needs next (WAG-360). Neutral lines.
    var effects: [String] = []
    /// The `name` of the artifact this option is about, and an anchor inside it (WAG-276). Selecting the
    /// option shows that artifact and scrolls to the anchor.
    var artifactRef: String? = nil
    var anchor: String? = nil
    /// This option's own reason, shown in the calm card's grey note when the agent sent one (WAG-281).
    var why: String? = nil

    /// The full text of each pro and con, as every older view reads them.
    var pros: [String] {
        get { proPoints.map(\.detail) }
        set { proPoints = newValue.map { OptionPoint(detail: $0) } }
    }
    var cons: [String] {
        get { conPoints.map(\.detail) }
        set { conPoints = newValue.map { OptionPoint(detail: $0) } }
    }

    var hasPoints: Bool { !proPoints.isEmpty || !conPoints.isEmpty }

    private enum CodingKeys: String, CodingKey {
        case id, label, title, pros, cons, facts, effects, anchor, why
        case artifactRef = "artifact_ref"
    }

    init(
        id: String, label: String, title: String? = nil, pros: [String] = [], cons: [String] = [],
        effects: [String] = [], artifactRef: String? = nil, anchor: String? = nil, why: String? = nil,
        facts: [String] = [], proPoints: [OptionPoint]? = nil, conPoints: [OptionPoint]? = nil
    ) {
        // `pros` and `cons` are the plain-string shorthand for points with no gist; given with `proPoints` and
        // `conPoints`, they come after them, so nothing passed in is dropped.
        self.id = id
        self.label = label
        self.title = title
        self.proPoints = (proPoints ?? []) + pros.map { OptionPoint(detail: $0) }
        self.conPoints = (conPoints ?? []) + cons.map { OptionPoint(detail: $0) }
        self.facts = facts
        self.effects = effects
        self.artifactRef = artifactRef
        self.anchor = anchor
        self.why = why
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        proPoints = OptionPoint.decodeList(c, forKey: .pros)
        conPoints = OptionPoint.decodeList(c, forKey: .cons)
        facts = OptionPoint.decodeFacts(c, forKey: .facts)
        effects = try c.decodeIfPresent([String].self, forKey: .effects) ?? []
        artifactRef = try c.decodeIfPresent(String.self, forKey: .artifactRef)
        anchor = try c.decodeIfPresent(String.self, forKey: .anchor)
        why = try c.decodeIfPresent(String.self, forKey: .why)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(label, forKey: .label)
        try c.encodeIfPresent(title, forKey: .title)
        if !proPoints.isEmpty { try c.encode(proPoints, forKey: .pros) }
        if !conPoints.isEmpty { try c.encode(conPoints, forKey: .cons) }
        if !facts.isEmpty { try c.encode(facts, forKey: .facts) }
        if !effects.isEmpty { try c.encode(effects, forKey: .effects) }
        try c.encodeIfPresent(artifactRef, forKey: .artifactRef)
        try c.encodeIfPresent(anchor, forKey: .anchor)
        try c.encodeIfPresent(why, forKey: .why)
    }
}

// One image of a `screenshots` artifact (HAIL-40): a path staged the same
// way as a single screenshot, plus an optional caption shown beside its
// thumbnail. Reused by `ArtifactPathResult.items` for the staged, absolute
// blob path form of the same shape (daemon/src/protocol/nouns.ts).
struct ScreenshotItem: Codable, Equatable, Sendable {
    let path: String
    let caption: String?
    /// The decision item this image belongs to, in a request with several decisions. `nil`: every decision.
    var item: String? = nil
}

// An artifact the agent submits with a case. A screenshot is one image path.
// An html_bundle is a directory plus its entry file. A markdown artifact
// (HAIL-33) is one text file path, staged the same way as a screenshot. A
// screenshots artifact (HAIL-40) is 2 to 12 images, each staged the same way
// as a single screenshot, that the operator flips through and comments on
// one at a time.
enum Artifact: Codable, Equatable, Sendable {
    case screenshot(path: String)
    case htmlBundle(dir: String, entry: String)
    case markdown(path: String)
    case screenshots(items: [ScreenshotItem])
    case diagram(path: String)

    private enum CodingKeys: String, CodingKey {
        case type, path, dir, entry, items
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "screenshot":
            self = .screenshot(path: try container.decode(String.self, forKey: .path))
        case "html_bundle":
            self = .htmlBundle(
                dir: try container.decode(String.self, forKey: .dir),
                entry: try container.decode(String.self, forKey: .entry)
            )
        case "markdown":
            self = .markdown(path: try container.decode(String.self, forKey: .path))
        case "screenshots":
            self = .screenshots(items: try container.decode([ScreenshotItem].self, forKey: .items))
        case "diagram":
            self = .diagram(path: try container.decode(String.self, forKey: .path))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container,
                debugDescription: "unknown artifact type \(type)"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .screenshot(let path):
            try container.encode("screenshot", forKey: .type)
            try container.encode(path, forKey: .path)
        case .htmlBundle(let dir, let entry):
            try container.encode("html_bundle", forKey: .type)
            try container.encode(dir, forKey: .dir)
            try container.encode(entry, forKey: .entry)
        case .markdown(let path):
            try container.encode("markdown", forKey: .type)
            try container.encode(path, forKey: .path)
        case .screenshots(let items):
            try container.encode("screenshots", forKey: .type)
            try container.encode(items, forKey: .items)
        case .diagram(let path):
            try container.encode("diagram", forKey: .type)
            try container.encode(path, forKey: .path)
        }
    }
}

// A rectangle in 0..1 coordinates of a capture.
struct Rect: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double

    /// The same rect held inside 0..1 with x + w <= 1 and y + h <= 1 (WAG-349). The daemon rejects a
    /// value outside 0..1, and float math makes `1.0000000000000002`. Not a number becomes 0.
    func clamped() -> Rect {
        func unit(_ v: Double) -> Double { v.isFinite ? min(1, max(0, v)) : 0 }
        let cx = unit(x), cy = unit(y)
        return Rect(x: cx, y: cy, w: min(unit(w), 1 - cx), h: min(unit(h), 1 - cy))
    }
}

// A text anchor (HAIL-150): a range of a markdown revision's SOURCE. `start`/`end` are
// character offsets (UTF-16 code units, end exclusive) into that revision's markdown;
// `quote` is the exact source text between them.
struct TextAnchor: Codable, Equatable, Sendable {
    let kind: String
    let revision: Int
    let quote: String
    let start: Int
    let end: Int

    init(revision: Int, quote: String, start: Int, end: Int) {
        self.kind = "text"
        self.revision = revision
        self.quote = quote
        self.start = start
        self.end = end
    }
}

// WAG-357: where the words of a comment on the text of a request are. The part says which text.
enum AskTextPart: String, Codable, CaseIterable, Sendable {
    case title, need, why, question, recommendation, pro, con, effect, source
}

// WAG-357: an anchor in the text of the request itself (the second `anchor` kind, "ask_text"). `quote` is the
// plain text shown, with markdown marks and [[s:id]] markers removed. `start`/`end` are UTF-16 offsets into
// that plain text, end exclusive.
struct AskTextAnchor: Codable, Equatable, Sendable {
    let kind: String
    let part: AskTextPart
    let itemId: String?
    let optionId: String?
    let sourceId: String?
    let quote: String
    let start: Int
    let end: Int

    static let kindName = "ask_text"

    init(part: AskTextPart, itemId: String? = nil, optionId: String? = nil, sourceId: String? = nil, quote: String, start: Int, end: Int) {
        self.kind = Self.kindName
        self.part = part
        self.itemId = itemId
        self.optionId = optionId
        self.sourceId = sourceId
        self.quote = quote
        self.start = start
        self.end = end
    }

    private enum CodingKeys: String, CodingKey {
        case kind, part, quote, start, end
        case itemId = "item_id"
        case optionId = "option_id"
        case sourceId = "source_id"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(part, forKey: .part)
        try c.encodeIfPresent(itemId, forKey: .itemId)
        try c.encodeIfPresent(optionId, forKey: .optionId)
        try c.encodeIfPresent(sourceId, forKey: .sourceId)
        try c.encode(quote, forKey: .quote)
        try c.encode(start, forKey: .start)
        try c.encode(end, forKey: .end)
    }
}

// A comment anchored to a capture ("captureId" + "rect") or, since HAIL-150, to a text range of a
// markdown revision ("anchor"). "n" counts from 1 in order, across both kinds.
//
// A text comment has no capture or rect on the wire. In memory it keeps `captureId == ""` and a
// zero `rect`, so every capture lookup (which compares ids) skips it without a special case.
struct Comment: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let captureId: String
    let n: Int
    let rect: Rect
    let text: String
    let anchor: TextAnchor?
    /// WAG-357: the second anchor kind, on the text of the request. On the wire it is the `anchor` field with
    /// `kind: "ask_text"`; a comment has at most one of `anchor` and `askAnchor`.
    let askAnchor: AskTextAnchor?

    init(id: String, captureId: String, n: Int, rect: Rect, text: String, anchor: TextAnchor? = nil, askAnchor: AskTextAnchor? = nil) {
        self.id = id
        self.captureId = captureId
        self.n = n
        self.rect = rect
        self.text = text
        self.anchor = anchor
        self.askAnchor = askAnchor
    }

    /// A comment on the text of a request (WAG-357).
    init(id: String, n: Int, askAnchor: AskTextAnchor, text: String) {
        self.init(id: id, captureId: "", n: n, rect: Rect(x: 0, y: 0, w: 0, h: 0), text: text, askAnchor: askAnchor)
    }

    /// A text comment (HAIL-150).
    init(id: String, n: Int, anchor: TextAnchor, text: String) {
        self.init(id: id, captureId: "", n: n, rect: Rect(x: 0, y: 0, w: 0, h: 0), text: text, anchor: anchor)
    }

    var isText: Bool { anchor != nil }
    /// WAG-357: a comment on the text of a request.
    var isAsk: Bool { askAnchor != nil }
    /// True for any comment with no capture: a markdown range or request text.
    var hasNoCapture: Bool { anchor != nil || askAnchor != nil }

    func withRect(_ rect: Rect) -> Comment {
        Comment(id: id, captureId: captureId, n: n, rect: rect, text: text, anchor: anchor, askAnchor: askAnchor)
    }

    func with(n: Int, text: String) -> Comment {
        Comment(id: id, captureId: captureId, n: n, rect: rect, text: text, anchor: anchor, askAnchor: askAnchor)
    }

    private enum CodingKeys: String, CodingKey {
        case id, captureId = "capture_id", n, rect, text, anchor
    }

    /// Reads only the `kind` of an anchor object, to choose the type that decodes it.
    private struct AnchorKind: Decodable { let kind: String }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // The `anchor` field holds either kind; `kind` says which (WAG-357). An old comment has "text".
        var anchor: TextAnchor?
        var askAnchor: AskTextAnchor?
        if c.contains(.anchor) {
            let kind = try c.decode(AnchorKind.self, forKey: .anchor).kind
            if kind == AskTextAnchor.kindName {
                askAnchor = try c.decode(AskTextAnchor.self, forKey: .anchor)
            } else {
                anchor = try c.decode(TextAnchor.self, forKey: .anchor)
            }
        }
        self.init(
            id: try c.decode(String.self, forKey: .id),
            captureId: try c.decodeIfPresent(String.self, forKey: .captureId) ?? "",
            n: try c.decode(Int.self, forKey: .n),
            rect: try c.decodeIfPresent(Rect.self, forKey: .rect) ?? Rect(x: 0, y: 0, w: 0, h: 0),
            text: try c.decode(String.self, forKey: .text),
            anchor: anchor,
            askAnchor: askAnchor
        )
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(n, forKey: .n)
        try c.encode(text, forKey: .text)
        if let anchor {
            try c.encode(anchor, forKey: .anchor)
        } else if let askAnchor {
            try c.encode(askAnchor, forKey: .anchor)
        } else {
            try c.encode(captureId, forKey: .captureId)
            try c.encode(rect, forKey: .rect)
        }
    }
}

// A frozen image of one revision, taken in Comment mode.
struct Capture: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let revision: Int
    let pngBase64: String
    let annotatedPngBase64: String
    let takenAt: String
    let note: String?

    private enum CodingKeys: String, CodingKey {
        case id, revision
        case pngBase64 = "png_base64"
        case annotatedPngBase64 = "annotated_png_base64"
        case takenAt = "taken_at"
        case note
    }
}

extension Capture {
    /// `cases.get` and the reply echoes carry no image data (PERF-2), so both
    /// image fields decode to "" when the daemon leaves them out. The app asks
    /// for an image with `KnockClient.captureImageData` when it shows one.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        revision = try c.decode(Int.self, forKey: .revision)
        pngBase64 = try c.decodeIfPresent(String.self, forKey: .pngBase64) ?? ""
        annotatedPngBase64 = try c.decodeIfPresent(String.self, forKey: .annotatedPngBase64) ?? ""
        takenAt = try c.decode(String.self, forKey: .takenAt)
        note = try c.decodeIfPresent(String.self, forKey: .note)
    }

    /// True when this capture came back without its images and needs a `capture.image` fetch.
    var needsImageFetch: Bool { pngBase64.isEmpty && annotatedPngBase64.isEmpty }
}

// A project is a tag: the git root folder name of a task's cwd.
typealias Project = String

// One agent run (in the MVP, one Claude Code session). Named "KnockTask" in
// Swift to avoid colliding with Swift Concurrency's `Task`; the wire shape
// (id, name, project) matches docs/protocol-mvp.md's "task" noun exactly.
struct KnockTask: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let name: String
    let project: Project
}

// One immutable copy of a case's artifact. "n" starts at 1.
struct Revision: Codable, Equatable, Sendable, Identifiable {
    /// Who made a revision (HAIL-168): the agent, or the person from an in-place edit.
    enum Author: String, Codable, Sendable {
        case agent
        case you
    }

    let id: String
    let caseId: String
    let n: Int
    let createdAt: String
    /// `.agent` when the daemon predates the field.
    var author: Author = .agent
    /// Only for a revision by `.you`: the revision the person started from, and how many
    /// passages (groups of changed lines) the edit changed against it.
    var baseRevision: Int? = nil
    var passagesChanged: Int? = nil
    /// The artifact's own name (WAG-276), and its kind; both absent from an older daemon.
    var name: String? = nil
    var kind: ArtifactKind? = nil
    /// WAG-351: the seq of the round this revision belongs to; `nil` from a daemon that does not send it.
    var round: Int? = nil

    private enum CodingKeys: String, CodingKey {
        case id, caseId = "case_id", n, createdAt = "created_at", author, name, kind, round
        case baseRevision = "base_revision", passagesChanged = "passages_changed"
    }

    init(
        id: String, caseId: String, n: Int, createdAt: String, author: Author = .agent,
        baseRevision: Int? = nil, passagesChanged: Int? = nil, name: String? = nil, kind: ArtifactKind? = nil,
        round: Int? = nil
    ) {
        self.round = round
        self.name = name
        self.kind = kind
        self.id = id
        self.caseId = caseId
        self.n = n
        self.createdAt = createdAt
        self.author = author
        self.baseRevision = baseRevision
        self.passagesChanged = passagesChanged
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        caseId = try c.decode(String.self, forKey: .caseId)
        n = try c.decode(Int.self, forKey: .n)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        author = (try? c.decodeIfPresent(Author.self, forKey: .author)) ?? .agent
        baseRevision = try c.decodeIfPresent(Int.self, forKey: .baseRevision)
        passagesChanged = try c.decodeIfPresent(Int.self, forKey: .passagesChanged)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        kind = (try? c.decodeIfPresent(ArtifactKind.self, forKey: .kind)) ?? nil
        round = (try? c.decodeIfPresent(Int.self, forKey: .round)) ?? nil
    }
}

// An agent or human message in a case conversation.
struct Message: Codable, Equatable, Sendable, Identifiable {
    enum Role: String, Codable, Sendable {
        case agent
        case human
    }

    let id: String
    let caseId: String
    let role: Role
    let text: String
    let createdAt: String
    /// A progress note (waggle_update with `working: true`). Optional: a daemon that does not send it leaves it nil,
    /// and the thread then knows a working note only by the case's `working_note`.
    var working: Bool? = nil

    private enum CodingKeys: String, CodingKey {
        case id, caseId = "case_id", role, text, createdAt = "created_at", working
    }
}

// A live shim session. The daemon marks it "live" while connected.
struct Session: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let cwd: String
    let branch: String?
    let pid: Int
    let state: SessionState
    let connectedAt: String

    private enum CodingKeys: String, CodingKey {
        case id, cwd, branch, pid, state, connectedAt = "connected_at"
    }
}

// What the Claude Code mod reports about its session (HAIL-134), present in
// `SessionContext.live` only while the mod keeps polling. HAIL-138 reads it to
// learn that the plugin reached a session.
struct LiveState: Codable, Equatable, Sendable {
    let phase: String
    let lastEventAt: String

    private enum CodingKeys: String, CodingKey {
        case phase
        case lastEventAt = "last_event_at"
    }
}

// What a live Claude Code session is working on (HAIL-72), read by the daemon
// from the transcript and from git (daemon/src/protocol/nouns.ts). Every field
// can be missing. Text is already plain and one line.
struct SessionContext: Codable, Equatable, Sendable {
    struct Plan: Codable, Equatable, Sendable {
        let done: Int
        let total: Int
        let current: String?
    }

    struct Changes: Codable, Equatable, Sendable {
        let files: Int
        let added: Int
        let removed: Int
        let clean: Bool
        let lastCommit: String?

        private enum CodingKeys: String, CodingKey {
            case files, added, removed, clean
            case lastCommit = "last_commit"
        }
    }

    /// Claude's own session title (the transcript's `ai-title`).
    let title: String?
    /// The first real user prompt, cleaned.
    let goal: String?
    /// The first sentence of the agent's last message.
    let said: String?
    /// The last action in plain words, and when it happened.
    let lastAction: String?
    let lastActionAt: String?
    /// The last 3 actions, oldest first.
    let recent: [String]
    let plan: Plan?
    let changes: Changes?
    /// The transcript is still being written (HAIL-124). Nil from an older daemon.
    let growing: Bool?
    /// The mod's own state, while it is attached (HAIL-134). Nil without the plugin.
    let live: LiveState?

    private enum CodingKeys: String, CodingKey {
        case title, goal, said, recent, plan, changes, growing, live
        case lastAction = "last_action"
        case lastActionAt = "last_action_at"
    }

    init(
        title: String? = nil, goal: String? = nil, said: String? = nil, lastAction: String? = nil,
        lastActionAt: String? = nil, recent: [String] = [], plan: Plan? = nil, changes: Changes? = nil,
        growing: Bool? = nil, live: LiveState? = nil
    ) {
        self.live = live
        self.title = title
        self.goal = goal
        self.said = said
        self.lastAction = lastAction
        self.lastActionAt = lastActionAt
        self.recent = recent
        self.plan = plan
        self.changes = changes
        self.growing = growing
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        goal = try c.decodeIfPresent(String.self, forKey: .goal)
        said = try c.decodeIfPresent(String.self, forKey: .said)
        lastAction = try c.decodeIfPresent(String.self, forKey: .lastAction)
        lastActionAt = try c.decodeIfPresent(String.self, forKey: .lastActionAt)
        recent = try c.decodeIfPresent([String].self, forKey: .recent) ?? []
        plan = try c.decodeIfPresent(Plan.self, forKey: .plan)
        changes = try c.decodeIfPresent(Changes.self, forKey: .changes)
        growing = try c.decodeIfPresent(Bool.self, forKey: .growing)
        live = try? c.decodeIfPresent(LiveState.self, forKey: .live)
    }
}

// One session as shown to a human (`sessions.list`, HAIL-46): the daemon's
// live-session projection for `knock doctor`'s "sessions" section and the
// app's Connection screen. `taskName`/`project` are the owning task's, the
// same denormalization `Case` already carries. `lastSeenAt` is bumped on
// every state transition and on every session RPC call from an already-live
// session (daemon/src/protocol/nouns.ts).
struct SessionInfo: Codable, Equatable, Sendable, Identifiable {
    let id: String
    /// The owning task (HAIL-59): equals `Case.taskId` for that session's
    /// asks. Empty when an older daemon does not send it.
    let taskId: String
    let runtime: Runtime
    let taskName: String
    let project: Project
    let branch: String?
    /// The folder the session runs in (HAIL-59). Empty when an older daemon
    /// does not send it.
    let cwd: String
    /// The shim's parent pid, for "Show the terminal" (HAIL-76). Nil when an
    /// older daemon does not send it.
    let pid: Int?
    /// The shim can wake its session with a nudge (HAIL-76). False when an
    /// older daemon does not send it.
    let canNudge: Bool
    /// The MCP client that started the session (HAIL-173). Nil from an older shim or daemon.
    let clientName: String?
    let state: SessionState
    let connectedAt: String
    let lastSeenAt: String
    /// What the session is working on (HAIL-72). Nil for Codex, when no
    /// transcript is found, or from an older daemon.
    let context: SessionContext?
    /// The title the agent sent with waggle_ask or waggle_update (WAG-279). Nil from an older daemon.
    let sessionTitle: String?

    private enum CodingKeys: String, CodingKey {
        case id, runtime, context
        case sessionTitle = "session_title"
        case taskId = "task_id"
        case taskName = "task_name"
        case project, branch, cwd, pid, state
        case canNudge = "can_nudge"
        case clientName = "client_name"
        case connectedAt = "connected_at"
        case lastSeenAt = "last_seen_at"
    }

    init(
        id: String, taskId: String = "", runtime: Runtime, taskName: String, project: Project,
        branch: String?, cwd: String = "", pid: Int? = nil, canNudge: Bool = false, clientName: String? = nil, state: SessionState,
        connectedAt: String, lastSeenAt: String, context: SessionContext? = nil, sessionTitle: String? = nil
    ) {
        self.context = context
        self.sessionTitle = sessionTitle
        self.id = id
        self.taskId = taskId
        self.runtime = runtime
        self.taskName = taskName
        self.project = project
        self.branch = branch
        self.cwd = cwd
        self.pid = pid
        self.canNudge = canNudge
        self.clientName = clientName
        self.state = state
        self.connectedAt = connectedAt
        self.lastSeenAt = lastSeenAt
    }

    // `task_id` and `cwd` decode with defaults: the new app can talk to an
    // older daemon right after an update, and the footer must not break.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId) ?? ""
        runtime = try c.decode(Runtime.self, forKey: .runtime)
        taskName = try c.decode(String.self, forKey: .taskName)
        project = try c.decode(Project.self, forKey: .project)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        pid = try c.decodeIfPresent(Int.self, forKey: .pid)
        canNudge = try c.decodeIfPresent(Bool.self, forKey: .canNudge) ?? false
        clientName = try c.decodeIfPresent(String.self, forKey: .clientName)
        state = try c.decode(SessionState.self, forKey: .state)
        connectedAt = try c.decode(String.self, forKey: .connectedAt)
        lastSeenAt = try c.decode(String.self, forKey: .lastSeenAt)
        // A context this app cannot read must never hide the session itself.
        context = try? c.decodeIfPresent(SessionContext.self, forKey: .context)
        sessionTitle = try? c.decodeIfPresent(String.self, forKey: .sessionTitle)
    }
}

// A plan ask (HAIL-151): one case that walks the brainstorming stages. `kind` stays "question" on
// the wire, so an app that does not know plans shows the case as a question; a plan case also carries
// `plan` (Case) and `plan_rounds` (CaseDetail).
enum PlanStageName: String, Codable, Sendable, CaseIterable {
    case questions
    case approaches
    case design
    case spec
}

/// Where one round sits: `step` counts from 1 inside the stage, `total` is how many the stage has.
struct PlanStage: Codable, Equatable, Sendable {
    let name: PlanStageName
    let step: Int?
    let total: Int?
    let totalIsEstimate: Bool?

    init(name: PlanStageName, step: Int? = nil, total: Int? = nil, totalIsEstimate: Bool? = nil) {
        self.name = name
        self.step = step
        self.total = total
        self.totalIsEstimate = totalIsEstimate
    }

    private enum CodingKeys: String, CodingKey {
        case name, step, total
        case totalIsEstimate = "total_is_estimate"
    }
}

/// What a plan `Case` carries: the newest round's stage, the rounds so far and how many were answered.
struct PlanInfo: Codable, Equatable, Sendable {
    let stage: PlanStage
    let rounds: Int
    let answered: Int
    /// The kind of artifact the newest round itself sent (HAIL-156); `nil` when it sent none.
    let artifactKind: ArtifactKind?

    init(stage: PlanStage, rounds: Int, answered: Int, artifactKind: ArtifactKind? = nil) {
        self.stage = stage
        self.rounds = rounds
        self.answered = answered
        self.artifactKind = artifactKind
    }

    private enum CodingKeys: String, CodingKey {
        case stage, rounds, answered
        case artifactKind = "artifact_kind"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stage = try c.decode(PlanStage.self, forKey: .stage)
        rounds = try c.decode(Int.self, forKey: .rounds)
        answered = try c.decode(Int.self, forKey: .answered)
        artifactKind = try? c.decodeIfPresent(ArtifactKind.self, forKey: .artifactKind)
    }
}

/// The human's decision for one round.
struct PlanAnswer: Codable, Equatable, Sendable {
    let choice: String?
    let choices: [String]?
    let message: String?
    let createdAt: String

    init(choice: String? = nil, choices: [String]? = nil, message: String? = nil, createdAt: String) {
        self.choice = choice
        self.choices = choices
        self.message = message
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case choice, choices, message
        case createdAt = "created_at"
    }
}

/// One round of a plan ask. `question` is the agent message that opened it.
struct PlanRound: Codable, Equatable, Sendable, Identifiable {
    var id: Int { seq }
    let seq: Int
    let stage: PlanStage
    let question: String
    let options: [Option]
    let recommendation: String
    let recommendationWhy: String
    let createdAt: String
    /// The revision this round shows (HAIL-156): the one the round sent, else the newest one before
    /// it. `nil` when the plan had no artifact yet.
    let revision: Int?
    /// True when the round itself sent an artifact.
    let ownArtifact: Bool
    /// The kind of the revision this round shows.
    let artifactKind: ArtifactKind?
    let answer: PlanAnswer?

    init(
        seq: Int, stage: PlanStage, question: String, options: [Option], recommendation: String,
        recommendationWhy: String = "", createdAt: String, revision: Int? = nil, ownArtifact: Bool = false,
        artifactKind: ArtifactKind? = nil, answer: PlanAnswer? = nil
    ) {
        self.seq = seq
        self.stage = stage
        self.question = question
        self.options = options
        self.recommendation = recommendation
        self.recommendationWhy = recommendationWhy
        self.createdAt = createdAt
        self.revision = revision
        self.ownArtifact = ownArtifact
        self.artifactKind = artifactKind
        self.answer = answer
    }

    // Older daemons send no artifact fields: a round then shows no artifact of its own.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        stage = try c.decode(PlanStage.self, forKey: .stage)
        question = try c.decode(String.self, forKey: .question)
        options = try c.decode([Option].self, forKey: .options)
        recommendation = try c.decode(String.self, forKey: .recommendation)
        recommendationWhy = try c.decode(String.self, forKey: .recommendationWhy)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        revision = try c.decodeIfPresent(Int.self, forKey: .revision)
        ownArtifact = try c.decodeIfPresent(Bool.self, forKey: .ownArtifact) ?? false
        artifactKind = try? c.decodeIfPresent(ArtifactKind.self, forKey: .artifactKind)
        answer = try c.decodeIfPresent(PlanAnswer.self, forKey: .answer)
    }

    private enum CodingKeys: String, CodingKey {
        case seq, stage, question, options, recommendation, answer, revision
        case recommendationWhy = "recommendation_why"
        case createdAt = "created_at"
        case ownArtifact = "own_artifact"
        case artifactKind = "artifact_kind"
    }
}

// One blocking question or review from a task (UI: "ask"). `runtime` is
// denormalized from the creating session (KNOCK-20): the connector the case's
// ask came from. The explicit init below defaults it to `.claude` (a `let`
// stored property's own default value is NOT enough: Swift drops a defaulted
// `let` from the synthesized memberwise init entirely, verified locally) so
// the 28 existing test fixtures that build a `Case` literal without naming a
// runtime keep compiling; the wire decoder always receives the daemon's own
// value via `Codable`'s separately synthesized `init(from:)`.
/// One answer of a point: a plain string, or an object with a label and its pros and cons (WAG-257).
/// The answer sent back is always the label.
struct PointOption: Codable, Equatable, Sendable, Identifiable, ExpressibleByStringLiteral {
    let label: String
    let proPoints: [OptionPoint]
    let conPoints: [OptionPoint]
    let effects: [String]
    /// The option's fact chips (task 11a).
    var facts: [String] = []
    /// The item option's full text under its title, and its own reason (task 11b: nothing the agent sent is dropped).
    /// Not on the wire.
    var detail: String? = nil
    var why: String? = nil
    /// The item option's anchor (not on the wire): the image of a screenshots set it names, for «On screen».
    var anchor: String? = nil
    /// The id of the item option this answer stands for (WAG-315); `nil` on an answer of the old questions
    /// shape, which goes back as its label. Not on the wire.
    var optionId: String? = nil
    var id: String { label }
    var pros: [String] { proPoints.map(\.detail) }
    var cons: [String] { conPoints.map(\.detail) }
    var hasPoints: Bool { !proPoints.isEmpty || !conPoints.isEmpty || !effects.isEmpty }

    init(stringLiteral value: String) { self.init(label: value) }

    init(
        label: String, pros: [String] = [], cons: [String] = [], effects: [String] = [], optionId: String? = nil,
        proPoints: [OptionPoint]? = nil, conPoints: [OptionPoint]? = nil, facts: [String] = [],
        detail: String? = nil, why: String? = nil, anchor: String? = nil
    ) {
        self.anchor = anchor
        self.label = label
        self.proPoints = (proPoints ?? []) + pros.map { OptionPoint(detail: $0) }
        self.conPoints = (conPoints ?? []) + cons.map { OptionPoint(detail: $0) }
        self.effects = effects
        self.optionId = optionId
        self.facts = facts
        self.detail = detail
        self.why = why
    }

    private enum CodingKeys: String, CodingKey { case label, pros, cons, effects, facts }

    init(from decoder: Decoder) throws {
        if let plain = try? decoder.singleValueContainer().decode(String.self) {
            self.init(label: plain)
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            label: try c.decode(String.self, forKey: .label),
            effects: try c.decodeIfPresent([String].self, forKey: .effects) ?? [],
            proPoints: OptionPoint.decodeList(c, forKey: .pros), conPoints: OptionPoint.decodeList(c, forKey: .cons),
            facts: OptionPoint.decodeFacts(c, forKey: .facts))
    }

    /// A plain option goes back out as a string, an option with points as an object.
    func encode(to encoder: Encoder) throws {
        if !hasPoints && facts.isEmpty {
            var single = encoder.singleValueContainer()
            try single.encode(label)
            return
        }
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(label, forKey: .label)
        if !proPoints.isEmpty { try c.encode(proPoints, forKey: .pros) }
        if !conPoints.isEmpty { try c.encode(conPoints, forKey: .cons) }
        if !effects.isEmpty { try c.encode(effects, forKey: .effects) }
        if !facts.isEmpty { try c.encode(facts, forKey: .facts) }
    }
}

/// One point of a question: the answers are `options`, or Yes / No / Talk with the team when it has none.
struct QuestionPoint: Codable, Equatable, Sendable, Identifiable {
    static let defaultChoices = ["Yes", "No", "Talk with the team"]
    let id: String
    let text: String
    let options: [PointOption]?
    /// The next fields come from an item (WAG-315) and are not on the wire. A point of the old shape keeps
    /// the defaults: pick one, no recommendation.
    var itemId: String? = nil
    var select: ItemSelect = .one
    var max: Int? = nil
    /// The labels of the recommended options; the suggested reply text with `.reply`.
    var recommended: [String] = []
    var recommendationWhy: String? = nil
    /// True when the question above already says this text (a lone item with no group): the point does not repeat it.
    var hidesText = false

    private enum CodingKeys: String, CodingKey { case id, text, options }

    /// What the person can pick. Nothing for a reply item: they write.
    var choices: [PointOption] {
        if select == .reply { return [] }
        return options ?? Self.defaultChoices.map { PointOption(label: $0) }
    }
    /// The labels of `choices`.
    var choiceLabels: [String] { choices.map(\.label) }
}

struct QuestionVariant: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let label: String
}

/// A question of a decision request (daemon `Question`).
struct Question: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let title: String
    let now: [String]?
    let points: [QuestionPoint]
    let artifactRef: String?
    let variants: [QuestionVariant]?
    let variantLabel: String?
    /// WAG-364: the title of the group an item step belongs to. Not on the wire: the step shows it as a heading.
    var groupTitle: String? = nil
    /// WAG-364: the id of that group. A variant pick belongs to the group, so every step of it shows the same pick.
    var groupId: String? = nil

    private enum CodingKeys: String, CodingKey {
        case id, title, now, points, variants
        case artifactRef = "artifact_ref"
        case variantLabel = "variant_label"
    }
}

/// One answered point.
struct PointAnswer: Codable, Equatable, Sendable {
    let questionId: String
    let pointId: String
    let choice: String
    let note: String?

    private enum CodingKeys: String, CodingKey { case questionId = "question_id", pointId = "point_id", choice, note }
}

/// How an "Ask less" rule decided a case (WAG-412). `choice` is the option id the rule picked, `answer` its short title.
struct AutoDecided: Codable, Equatable, Sendable {
    let category: AskCategory
    let rule: String
    let choice: String
    let answer: String
    let at: String
}

struct Case: Codable, Equatable, Sendable, Identifiable {
    enum Kind: String, Codable, Sendable {
        case question
        case review
    }

    /// How many options the human may pick (HAIL-123).
    enum Select: String, Codable, Sendable {
        case one
        case many
    }

    let id: String
    let taskId: String
    let kind: Kind
    let title: String
    let need: String
    let why: String
    let recommendation: String
    let recommendationWhy: String
    /// Multi-select (HAIL-123), of the newest option set: `.many` lets the human tick several
    /// options. `max` caps the ticks (`nil`: no limit); `recommendations` is the recommended list
    /// (`recommendation` is its first id). An older daemon omits all three.
    let select: Select
    let max: Int?
    let recommendations: [String]
    let options: [Option]
    /// The ask's own option set and recommendation (HAIL-108). `options` and
    /// `recommendation` are the newest set; these equal them until a
    /// `knock_update` sends options. An older daemon omits them.
    let firstOptions: [Option]
    let firstRecommendation: String
    /// When the newest option set arrived with a `knock_update`; `nil` while the
    /// ask's own set is the newest.
    let optionsUpdatedAt: String?
    /// The newest option set's seq (0 = the ask's own) and, when seq > 0, the agent message that
    /// brought it (HAIL-174). An older daemon omits both.
    let optionsSeq: Int
    let roundQuestion: String?
    /// True when the latest reply's choice is an id of the first set.
    let latestReplyFromFirstOptions: Bool
    let status: CaseStatus
    let hasArtifact: Bool
    /// The case's most recent reply, denormalized (docs/protocol-mvp.md
    /// "Case fields", KNOCK-13 fold Amendment 1): `nil` when the case has no
    /// reply yet. `latestReplyId` is what a relaunched app's Retry needs -
    /// `AppModel.deliveryStatusByCaseId`'s `.failed(replyId:)` never has an
    /// event to read it from otherwise.
    let latestReplyId: String?
    let latestReplyState: ReplyStatus?
    let latestReplyAt: String?
    /// When the latest reply was picked up (marked delivered), `nil` while it
    /// is queued, failed or absent (HAIL-64). The queue moves an answered ask
    /// to "Answered" 10 minutes after this, so it comes from the daemon and
    /// survives a relaunch.
    let latestReplyDeliveredAt: String?
    /// WAG-267: the apply step of a delivered latest reply; `nil` for any other state or an older daemon.
    let latestReplyApplyState: ReplyApplyState?
    /// The chosen option id and free-text message of the case's most recent
    /// reply, denormalized the same way `latestReplyId`/`State`/`At` are
    /// (HAIL-34, daemon/src/protocol/nouns.ts "Case fields"): the queue
    /// row's "you -> <label>" line reads these without a per-row
    /// `cases.get`. Both `nil` when the case has no reply yet, or when that
    /// reply carries no choice/message.
    let latestReplyChoice: String?
    /// The ids ticked in the latest reply to a select "many" ask (HAIL-123); empty otherwise.
    let latestReplyChoices: [String]
    /// The answers of the latest reply to a multi-question request. Empty otherwise.
    var latestReplyAnswers: [PointAnswer] = []
    /// WAG-295: the answer body `waggle_check` hands the agent for the latest decision reply, set by the
    /// daemon while that reply is queued or failed. The standalone paste is built from it; `nil` otherwise.
    var latestReplyAnswerText: String?
    /// The questions of a multi-question decision request (up to 12). Empty on any other case.
    var questions: [Question] = []
    let latestReplyMessage: String?
    /// The intent (`"decision"` | `"more_detail"`) of the case's most recent
    /// reply (HAIL-33), denormalized the same way `latestReplyChoice`/
    /// `Message` are. `nil` only when the case has no reply yet.
    let latestReplyIntent: ReplyIntent?
    /// The format (`"eli5"` | `"diagram"` | `"page"`) of the case's most
    /// recent reply (HAIL-139), denormalized the same way `latestReplyIntent`
    /// is. `nil` when the case has no reply yet, or that reply carried no
    /// format.
    let latestReplyFormat: ReplyFormat?
    /// Where the latest reply came from (HAIL-144): the queue row says "Answered from Telegram".
    /// `nil` when the case has no reply yet.
    let latestReplySource: ReplySource?
    /// The earliest reply's `created_at` across every round of this case
    /// (HAIL-34): "took" = this minus `createdAt`. `nil` until the case has
    /// a first reply.
    let firstReplySubmittedAt: String?
    /// What the agent sent with `knock_update` after the first reply
    /// (HAIL-67, docs/protocol-mvp.md "Case fields"). All optional: an older
    /// daemon omits them and they decode as nil.
    let updateCount: Int?
    let latestUpdateAt: String?
    /// The first ~140 characters of the newest agent message after a reply.
    let latestUpdateMessage: String?
    let revisionCount: Int?
    /// When the newest revision was made (HAIL-68); `nil` on an older daemon.
    let latestRevisionAt: String?
    let runtime: Runtime
    /// The state of the case's owning session, denormalized the same way
    /// `runtime` is (docs/protocol-mvp.md "Case fields", HAIL-32): `nil` only
    /// for a case seeded without a session row. Used to gate Dismiss's
    /// confirmation - a `.live` session may be blocked in `knock_ask`/
    /// `knock_check` right now.
    let sessionState: SessionState?
    /// Set by `case.dismiss`, cleared by `case.restore` (HAIL-32). `nil` for
    /// a case that was never dismissed.
    let dismissedAt: String?
    /// The `case_id` of the earlier ask this one follows up on (HAIL-33
    /// amendment), or `nil`. Set only at creation by `knock_ask`'s
    /// `follows`.
    let followsCaseId: String?
    /// The `case_id` of the earlier ask this one replaces (HAIL-44), or
    /// `nil`. Set only at creation by `knock_ask`'s `replaces`.
    let replacesCaseId: String?
    /// Set when this case was withdrawn because a later `knock_ask`
    /// replaced it (HAIL-44), the same way `dismissedAt` is set by
    /// `case.dismiss` - `nil` for a case that was never replaced. There is
    /// no restore for a withdrawn case.
    let withdrawnAt: String?
    /// Set when the agent closed the case with a done update (HAIL-152): it finished and no answer
    /// will come. The row shows "Done" with a Got it button until the human taps it (`case.dismiss`).
    /// `nil` for every other case, and for a daemon that predates the field.
    let doneAt: String?
    /// The text of the agent's progress note (waggle_update working: true, WAG-377) while it is the newest
    /// message and no reply followed. `nil` otherwise, and for a daemon that predates the field.
    let workingNote: String?
    /// When the owning session last called knock_check for this case (HAIL-170). `nil` before the
    /// first check, and for a daemon that predates the field.
    let lastCheckAt: String?
    /// The owning session's `can_nudge` (HAIL-170). `nil` when unknown (no session row, or an older
    /// daemon): "Claude is not checking" never shows for `nil`.
    let sessionCanNudge: Bool?
    /// The MCP client name of the owning session (HAIL-173). `nil` when unknown (an older shim or daemon).
    let sessionClientName: String?
    /// When the owning session ended (WAG-258), only while it is `ended`. `nil` otherwise, and for an
    /// older daemon. Compared with `latestReplyAt` to say which came first.
    let sessionEndedAt: String?
    /// How a rule decided this case (WAG-412, "Ask less"). `nil` for a case a person decided, and for an older daemon.
    var autoDecided: AutoDecided? = nil
    /// WAG-418: the past decided cases that fit this ask when it was created. `nil` when the key is absent (no match, or
    /// an older daemon).
    var matchedCaseIds: [String]? = nil
    /// The owning task's name/project, denormalized directly onto `Case`
    /// (daemon/src/protocol/nouns.ts: "so `cases.list` alone can render a
    /// queue row ... without a per-row `cases.get`") - this has been true of
    /// the wire protocol since HAIL-16, but the app never read it until
    /// HAIL-28, instead resolving the queue row's session label through a
    /// per-task `cases.get` (`AppModel.enrichMetadata`/`taskById`) that could
    /// leave a row's meta line blank until that fetch completed, or forever
    /// if it never did. `QueueListView` now reads `sessionLabel` (below)
    /// straight off the row's own `Case`.
    let taskName: String
    let project: String
    /// The kind of the latest revision (docs/protocol-mvp.md "Case fields"), `nil` when the case
    /// has no artifact or the kind is one this app cannot read. The queue row's icon reads it
    /// without a `cases.get` (PERF-4).
    let artifactKind: ArtifactKind?
    /// The owning task as the notification builder wants it, from the row's own fields.
    var knockTask: KnockTask { KnockTask(id: taskId, name: taskName, project: project) }
    let createdAt: String
    let updatedAt: String
    /// Set on a plan ask (HAIL-151); `nil` on every other case, and for a plan this app cannot read.
    let plan: PlanInfo?
    /// The items of the newest Round (WAG-312). Empty from a daemon that sends none: the request then
    /// shows from `options` and `questions` exactly as before.
    let items: [Item]

    private enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case plan, items
        case kind, title, need, why, recommendation
        case recommendationWhy = "recommendation_why"
        case options, status, select, max, recommendations
        case latestReplyChoices = "latest_reply_choices"
        case latestReplyAnswers = "latest_reply_answers"
        case latestReplyAnswerText = "latest_reply_answer_text"
        case questions
        case firstOptions = "first_options"
        case firstRecommendation = "first_recommendation"
        case optionsUpdatedAt = "options_updated_at"
        case optionsSeq = "options_seq"
        case roundQuestion = "round_question"
        case latestReplyFromFirstOptions = "latest_reply_from_first_options"
        case hasArtifact = "has_artifact"
        case artifactKind = "artifact_kind"
        case latestReplyId = "latest_reply_id"
        case latestReplyState = "latest_reply_state"
        case latestReplyAt = "latest_reply_at"
        case latestReplyDeliveredAt = "latest_reply_delivered_at"
        case latestReplyApplyState = "latest_reply_apply_state"
        case latestReplyChoice = "latest_reply_choice"
        case latestReplyMessage = "latest_reply_message"
        case latestReplyIntent = "latest_reply_intent"
        case latestReplyFormat = "latest_reply_format"
        case latestReplySource = "latest_reply_source"
        case firstReplySubmittedAt = "first_reply_submitted_at"
        case updateCount = "update_count"
        case latestUpdateAt = "latest_update_at"
        case latestUpdateMessage = "latest_update_message"
        case revisionCount = "revision_count"
        case latestRevisionAt = "latest_revision_at"
        case runtime
        case sessionState = "session_state"
        case dismissedAt = "dismissed_at"
        case followsCaseId = "follows_case_id"
        case replacesCaseId = "replaces_case_id"
        case withdrawnAt = "withdrawn_at"
        case doneAt = "done_at"
        case workingNote = "working_note"
        case lastCheckAt = "last_check_at"
        case sessionCanNudge = "session_can_nudge"
        case sessionClientName = "session_client_name"
        case sessionEndedAt = "session_ended_at"
        case autoDecided = "auto_decided"
        case matchedCaseIds = "matched_case_ids"
        case taskName = "task_name"
        case project
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    // `runtime`, `latest_reply_*`, `task_name` and `project` decode with
    // defaults when absent: right after an update the new app can talk to an
    // older daemon (KNOCK-21 handoff) that predates these fields, and an
    // older daemon's asks all came from Claude Code.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        taskId = try c.decode(String.self, forKey: .taskId)
        kind = try c.decode(Kind.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title)
        need = try c.decode(String.self, forKey: .need)
        why = try c.decode(String.self, forKey: .why)
        let rawRecommendation = try c.decode(String.self, forKey: .recommendation)
        let rawRecommendationWhy = try c.decode(String.self, forKey: .recommendationWhy)
        select = try c.decodeIfPresent(Select.self, forKey: .select) ?? .one
        max = try c.decodeIfPresent(Int.self, forKey: .max)
        let rawRecommendations = try c.decodeIfPresent([String].self, forKey: .recommendations) ?? [rawRecommendation]
        let rawOptions = try c.decode([Option].self, forKey: .options)
        questions = try c.decodeIfPresent([Question].self, forKey: .questions) ?? []
        // A review shows Approve and Request changes as rows (WAG-316). Free text is not a pick.
        let review = ReviewRows.normalized(
            kind: kind, options: rawOptions, recommendation: rawRecommendation, recommendationWhy: rawRecommendationWhy,
            recommendations: rawRecommendations, hasQuestions: !questions.isEmpty)
        recommendation = review.recommendation
        recommendationWhy = review.recommendationWhy
        recommendations = review.recommendations
        options = review.options
        firstOptions = try c.decodeIfPresent([Option].self, forKey: .firstOptions) ?? review.options
        firstRecommendation = try c.decodeIfPresent(String.self, forKey: .firstRecommendation) ?? review.recommendation
        optionsUpdatedAt = try c.decodeIfPresent(String.self, forKey: .optionsUpdatedAt)
        optionsSeq = try c.decodeIfPresent(Int.self, forKey: .optionsSeq) ?? 0
        roundQuestion = try c.decodeIfPresent(String.self, forKey: .roundQuestion)
        latestReplyFromFirstOptions = try c.decodeIfPresent(Bool.self, forKey: .latestReplyFromFirstOptions) ?? false
        status = try c.decode(CaseStatus.self, forKey: .status)
        hasArtifact = try c.decode(Bool.self, forKey: .hasArtifact)
        artifactKind = (try? c.decodeIfPresent(ArtifactKind.self, forKey: .artifactKind)) ?? nil
        latestReplyId = try c.decodeIfPresent(String.self, forKey: .latestReplyId)
        latestReplyState = try c.decodeIfPresent(ReplyStatus.self, forKey: .latestReplyState)
        latestReplyAt = try c.decodeIfPresent(String.self, forKey: .latestReplyAt)
        latestReplyDeliveredAt = try c.decodeIfPresent(String.self, forKey: .latestReplyDeliveredAt)
        latestReplyApplyState = (try? c.decodeIfPresent(ReplyApplyState.self, forKey: .latestReplyApplyState)) ?? nil
        latestReplyChoice = try c.decodeIfPresent(String.self, forKey: .latestReplyChoice)
        latestReplyChoices = try c.decodeIfPresent([String].self, forKey: .latestReplyChoices) ?? []
        latestReplyAnswers = try c.decodeIfPresent([PointAnswer].self, forKey: .latestReplyAnswers) ?? []
        latestReplyAnswerText = try c.decodeIfPresent(String.self, forKey: .latestReplyAnswerText)
        latestReplyMessage = try c.decodeIfPresent(String.self, forKey: .latestReplyMessage)
        latestReplyIntent = try c.decodeIfPresent(ReplyIntent.self, forKey: .latestReplyIntent)
        latestReplyFormat = try c.decodeIfPresent(ReplyFormat.self, forKey: .latestReplyFormat)
        latestReplySource = (try? c.decodeIfPresent(ReplySource.self, forKey: .latestReplySource)) ?? nil
        firstReplySubmittedAt = try c.decodeIfPresent(String.self, forKey: .firstReplySubmittedAt)
        updateCount = try c.decodeIfPresent(Int.self, forKey: .updateCount)
        latestUpdateAt = try c.decodeIfPresent(String.self, forKey: .latestUpdateAt)
        latestUpdateMessage = try c.decodeIfPresent(String.self, forKey: .latestUpdateMessage)
        revisionCount = try c.decodeIfPresent(Int.self, forKey: .revisionCount)
        latestRevisionAt = try c.decodeIfPresent(String.self, forKey: .latestRevisionAt)
        runtime = try c.decodeIfPresent(Runtime.self, forKey: .runtime) ?? .claude
        sessionState = try c.decodeIfPresent(SessionState.self, forKey: .sessionState)
        dismissedAt = try c.decodeIfPresent(String.self, forKey: .dismissedAt)
        followsCaseId = try c.decodeIfPresent(String.self, forKey: .followsCaseId)
        replacesCaseId = try c.decodeIfPresent(String.self, forKey: .replacesCaseId)
        withdrawnAt = try c.decodeIfPresent(String.self, forKey: .withdrawnAt)
        doneAt = try c.decodeIfPresent(String.self, forKey: .doneAt)
        workingNote = try c.decodeIfPresent(String.self, forKey: .workingNote)
        lastCheckAt = try c.decodeIfPresent(String.self, forKey: .lastCheckAt)
        sessionCanNudge = try c.decodeIfPresent(Bool.self, forKey: .sessionCanNudge)
        sessionClientName = try c.decodeIfPresent(String.self, forKey: .sessionClientName)
        sessionEndedAt = try c.decodeIfPresent(String.self, forKey: .sessionEndedAt)
        autoDecided = try? c.decodeIfPresent(AutoDecided.self, forKey: .autoDecided)
        matchedCaseIds = try? c.decodeIfPresent([String].self, forKey: .matchedCaseIds)
        taskName = try c.decodeIfPresent(String.self, forKey: .taskName) ?? ""
        project = try c.decodeIfPresent(String.self, forKey: .project) ?? ""
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        // A plan this app cannot read (a newer stage name) falls back to a plain question.
        plan = (try? c.decodeIfPresent(PlanInfo.self, forKey: .plan)) ?? nil
        let served = (try? c.decodeIfPresent([Item].self, forKey: .items)) ?? []
        items = served.isEmpty ? EvidenceItems.items(forTitle: title) : served
    }

    // One custom init (KNOCK-13 + KNOCK-20 merged; rather than property defaults) so `latestReply*` and `runtime`
    // decodes normally from the wire: a stored-property default on an
    // Optional silently short-circuits synthesized Decodable for that
    // property (verified empirically - it never calls decodeIfPresent at
    // all, always assigning the default). This init exists only so call
    // sites written before this field existed (test fixtures) never have to
    // name it.
    init(
        id: String, taskId: String, kind: Kind, title: String, need: String, why: String,
        recommendation: String, recommendationWhy: String, options: [Option], status: CaseStatus,
        hasArtifact: Bool, latestReplyId: String? = nil, latestReplyState: ReplyStatus? = nil,
        latestReplyAt: String? = nil, latestReplyDeliveredAt: String? = nil, latestReplyChoice: String? = nil, latestReplyMessage: String? = nil,
        latestReplyIntent: ReplyIntent? = nil,
        latestReplyFormat: ReplyFormat? = nil,
        latestReplySource: ReplySource? = nil,
        latestReplyApplyState: ReplyApplyState? = nil,
        latestReplyChoices: [String] = [],
        select: Select = .one, max: Int? = nil, recommendations: [String]? = nil,
        firstReplySubmittedAt: String? = nil,
        updateCount: Int? = nil, latestUpdateAt: String? = nil, latestUpdateMessage: String? = nil,
        revisionCount: Int? = nil,
        latestRevisionAt: String? = nil,
        runtime: Runtime = .claude, sessionState: SessionState? = nil,
        dismissedAt: String? = nil, followsCaseId: String? = nil, replacesCaseId: String? = nil,
        withdrawnAt: String? = nil, doneAt: String? = nil, workingNote: String? = nil, lastCheckAt: String? = nil, sessionCanNudge: Bool? = nil, sessionClientName: String? = nil, sessionEndedAt: String? = nil, taskName: String = "", project: String = "",
        createdAt: String, updatedAt: String, autoDecided: AutoDecided? = nil, matchedCaseIds: [String]? = nil,
        firstOptions: [Option]? = nil, firstRecommendation: String? = nil, optionsUpdatedAt: String? = nil,
        latestReplyFromFirstOptions: Bool = false,
        plan: PlanInfo? = nil, artifactKind: ArtifactKind? = nil,
        optionsSeq: Int = 0, roundQuestion: String? = nil,
        questions: [Question] = [], latestReplyAnswers: [PointAnswer] = [], latestReplyAnswerText: String? = nil,
        items: [Item] = []
    ) {
        self.items = items
        self.questions = questions
        self.latestReplyAnswerText = latestReplyAnswerText
        self.latestReplyAnswers = latestReplyAnswers
        self.optionsSeq = optionsSeq
        self.roundQuestion = roundQuestion
        self.artifactKind = artifactKind
        self.plan = plan
        self.id = id
        self.taskId = taskId
        self.kind = kind
        self.title = title
        self.need = need
        self.why = why
        self.recommendation = recommendation
        self.recommendationWhy = recommendationWhy
        self.select = select
        self.max = max
        self.recommendations = recommendations ?? [recommendation]
        self.options = options
        self.firstOptions = firstOptions ?? options
        self.firstRecommendation = firstRecommendation ?? recommendation
        self.optionsUpdatedAt = optionsUpdatedAt
        self.latestReplyFromFirstOptions = latestReplyFromFirstOptions
        self.status = status
        self.hasArtifact = hasArtifact
        self.latestReplyId = latestReplyId
        self.latestReplyState = latestReplyState
        self.latestReplyAt = latestReplyAt
        self.latestReplyDeliveredAt = latestReplyDeliveredAt
        self.latestReplyApplyState = latestReplyApplyState
        self.latestReplyChoice = latestReplyChoice
        self.latestReplyChoices = latestReplyChoices
        self.latestReplyMessage = latestReplyMessage
        self.latestReplyIntent = latestReplyIntent
        self.latestReplyFormat = latestReplyFormat
        self.latestReplySource = latestReplySource
        self.firstReplySubmittedAt = firstReplySubmittedAt
        self.updateCount = updateCount
        self.latestUpdateAt = latestUpdateAt
        self.latestUpdateMessage = latestUpdateMessage
        self.revisionCount = revisionCount
        self.latestRevisionAt = latestRevisionAt
        self.runtime = runtime
        self.sessionState = sessionState
        self.dismissedAt = dismissedAt
        self.followsCaseId = followsCaseId
        self.replacesCaseId = replacesCaseId
        self.withdrawnAt = withdrawnAt
        self.doneAt = doneAt
        self.workingNote = workingNote
        self.lastCheckAt = lastCheckAt
        self.sessionCanNudge = sessionCanNudge
        self.sessionClientName = sessionClientName
        self.sessionEndedAt = sessionEndedAt
        self.autoDecided = autoDecided
        self.matchedCaseIds = matchedCaseIds
        self.taskName = taskName
        self.project = project
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

// The human's answer to a case. It carries an idempotency key so a retry
// never creates a second reply.
/// A file the person attached to a reply (WAG-345). `path` is absolute, read-only, in the daemon's data folder.
struct ReplyAttachment: Codable, Equatable, Sendable, Identifiable {
    let name: String
    let path: String
    let size: Int
    /// A MIME type, "application/octet-stream" when unknown.
    let type: String
    var id: String { path }

    var isImage: Bool { type.hasPrefix("image/") && type != "image/svg+xml" }
}

struct Reply: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let caseId: String
    let idempotencyKey: String
    let choice: String?
    /// The ids ticked in a reply to a select "many" ask (HAIL-123); `nil` for a single choice.
    let choices: [String]?
    /// The answers to the points of a multi-question request; `nil` for any other reply.
    var answers: [PointAnswer]? = nil
    let message: String?
    let comments: [Comment]
    let captures: [Capture]
    /// "decision" (default) or "more_detail" (HAIL-33): what this reply is
    /// answering. Decodes to `.decision` when the daemon predates the field.
    let intent: ReplyIntent
    /// A discuss reply (WAG-301): the option ids the human leans to and rules out; `nil` for any other reply.
    var leaning: [String]? = nil
    var ruledOut: [String]? = nil
    /// The format a `more_detail` reply asks for (HAIL-139): `"eli5"` |
    /// `"diagram"` | `"page"`. `nil` for a decision reply, or a detail
    /// request that did not name one.
    let format: ReplyFormat?
    /// Where the reply came from (HAIL-144). `.mac` when the daemon predates the field.
    let source: ReplySource
    let state: ReplyStatus
    let createdAt: String
    /// Set by `reply.replace` (HAIL-34), on every replace while the reply is
    /// still queued. `createdAt` is never touched by a replace, so it keeps
    /// meaning "first submitted at" for the "took" duration; this is when
    /// the answer was last changed, shown as "changed HH:MM" beside it.
    /// `nil` for a reply that has never been changed.
    let replacedAt: String?
    /// When the agent picked the reply up (HAIL-68); `nil` until then.
    let deliveredAt: String?
    /// WAG-267: set only on a delivered reply; `nil` otherwise and from an older daemon.
    let applyState: ReplyApplyState?
    /// The person's in-place edit of the document, when the reply carries one (HAIL-168).
    var edit: Edit? = nil
    /// The answers by item id of a Decide reply (WAG-312); `nil` for an older reply.
    var itemAnswers: [ItemAnswer]? = nil
    /// Decide or keep talking, set by the daemon on read (WAG-312); `nil` from an older daemon.
    var outcome: ReplyOutcome? = nil
    /// The files the person attached (WAG-345); `nil` when there are none and from an older daemon.
    var attachments: [ReplyAttachment]? = nil

    struct Edit: Codable, Equatable, Sendable {
        let revision: Int
        let baseRevision: Int
        let passagesChanged: Int

        private enum CodingKeys: String, CodingKey {
            case revision, baseRevision = "base_revision", passagesChanged = "passages_changed"
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case caseId = "case_id"
        case idempotencyKey = "idempotency_key"
        case choice, choices, answers, message, comments, captures, intent, format, source, state, edit, leaning, outcome, attachments
        case itemAnswers = "item_answers"
        case ruledOut = "ruled_out"
        case createdAt = "created_at"
        case replacedAt = "replaced_at"
        case deliveredAt = "delivered_at"
        case applyState = "apply_state"
    }

    init(
        id: String, caseId: String, idempotencyKey: String, choice: String? = nil, message: String? = nil,
        comments: [Comment], captures: [Capture], intent: ReplyIntent = .decision, format: ReplyFormat? = nil,
        source: ReplySource = .mac,
        state: ReplyStatus,
        createdAt: String, replacedAt: String? = nil, deliveredAt: String? = nil, choices: [String]? = nil,
        edit: Edit? = nil, applyState: ReplyApplyState? = nil, leaning: [String]? = nil, ruledOut: [String]? = nil
    ) {
        self.leaning = leaning
        self.ruledOut = ruledOut
        self.applyState = applyState
        self.edit = edit
        self.choices = choices
        self.id = id
        self.caseId = caseId
        self.idempotencyKey = idempotencyKey
        self.choice = choice
        self.message = message
        self.comments = comments
        self.captures = captures
        self.intent = intent
        self.format = format
        self.source = source
        self.state = state
        self.createdAt = createdAt
        self.replacedAt = replacedAt
        self.deliveredAt = deliveredAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        caseId = try c.decode(String.self, forKey: .caseId)
        idempotencyKey = try c.decode(String.self, forKey: .idempotencyKey)
        choice = try c.decodeIfPresent(String.self, forKey: .choice)
        choices = try c.decodeIfPresent([String].self, forKey: .choices)
        answers = try c.decodeIfPresent([PointAnswer].self, forKey: .answers)
        message = try c.decodeIfPresent(String.self, forKey: .message)
        comments = try c.decode([Comment].self, forKey: .comments)
        captures = try c.decode([Capture].self, forKey: .captures)
        intent = try c.decodeIfPresent(ReplyIntent.self, forKey: .intent) ?? .decision
        leaning = try c.decodeIfPresent([String].self, forKey: .leaning)
        ruledOut = try c.decodeIfPresent([String].self, forKey: .ruledOut)
        format = try c.decodeIfPresent(ReplyFormat.self, forKey: .format)
        source = (try? c.decodeIfPresent(ReplySource.self, forKey: .source)) ?? .mac
        state = try c.decode(ReplyStatus.self, forKey: .state)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        replacedAt = try c.decodeIfPresent(String.self, forKey: .replacedAt)
        deliveredAt = try c.decodeIfPresent(String.self, forKey: .deliveredAt)
        applyState = (try? c.decodeIfPresent(ReplyApplyState.self, forKey: .applyState)) ?? nil
        edit = try c.decodeIfPresent(Edit.self, forKey: .edit)
        itemAnswers = (try? c.decodeIfPresent([ItemAnswer].self, forKey: .itemAnswers)) ?? nil
        outcome = (try? c.decodeIfPresent(ReplyOutcome.self, forKey: .outcome)) ?? nil
        attachments = (try? c.decodeIfPresent([ReplyAttachment].self, forKey: .attachments)) ?? nil
    }
}

// Full case view: the case, its task, messages, revisions, comments and
// replies. The property named `case` shadows the Swift keyword; that is
// fine, Codable synthesis matches it to the JSON key "case" directly.
struct CaseDetail: Codable, Equatable, Sendable {
    let `case`: Case
    let task: KnockTask
    let messages: [Message]
    let revisions: [Revision]
    let comments: [Comment]
    let replies: [Reply]
    /// Every round of a plan ask, oldest first (HAIL-151); `nil` on every other case.
    var planRounds: [PlanRound]? = nil
    /// Every Round that carries items, oldest first (WAG-312); `nil` from a daemon that sends none.
    var rounds: [Round]? = nil

    private enum CodingKeys: String, CodingKey {
        case `case`, task, messages, revisions, comments, replies, rounds
        case planRounds = "plan_rounds"
    }

    init(
        case: Case, task: KnockTask, messages: [Message], revisions: [Revision], comments: [Comment],
        replies: [Reply], planRounds: [PlanRound]? = nil, rounds: [Round]? = nil
    ) {
        self.rounds = rounds
        self.case = `case`
        self.task = task
        self.messages = messages
        self.revisions = revisions
        self.comments = comments
        self.replies = replies
        self.planRounds = planRounds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.case = try c.decode(Case.self, forKey: .case)
        task = try c.decode(KnockTask.self, forKey: .task)
        messages = try c.decode([Message].self, forKey: .messages)
        revisions = try c.decode([Revision].self, forKey: .revisions)
        comments = try c.decode([Comment].self, forKey: .comments)
        replies = try c.decode([Reply].self, forKey: .replies)
        planRounds = (try? c.decodeIfPresent([PlanRound].self, forKey: .planRounds)) ?? nil
        rounds = (try? c.decodeIfPresent([Round].self, forKey: .rounds)) ?? nil
    }
}

// The size Knock renders an html_bundle at when the agent declares one
// (HAIL-49), on `Artifact.htmlBundle` and echoed back on
// `ArtifactPathResult`. Only meaningful without a preview - see
// `ArtifactPreviewPlan`.
struct ViewportSize: Codable, Equatable, Sendable {
    let width: Int
    let height: Int
}

// Which kind of file an html_bundle's `preview` names (HAIL-49): `html`
// renders like `entry` (at a fixed size); `image` is shown as is.
enum PreviewKind: String, Codable, Equatable, Sendable {
    case html
    case image
}

// The absolute staged path of an html_bundle's preview file (HAIL-49), from
// `ArtifactPathResult.preview`.
struct ArtifactPreviewInfo: Codable, Equatable, Sendable {
    let kind: PreviewKind
    let path: String
}

// Result of the artifact.path RPC: absolute staged path of one revision. For
// a `screenshots` kind (HAIL-40), `root`/`entry` are empty and `items`
// carries the ordered, absolute blob paths and captions instead - there is
// no single path to return. For an `html_bundle`, `viewport`/`preview`
// (HAIL-49) carry the revision's own declared render size and card preview,
// when it declared one - see `ArtifactPreviewPlan`.
struct ArtifactPathResult: Codable, Equatable, Sendable {
    let kind: ArtifactKind
    let root: String
    let entry: String
    let items: [ScreenshotItem]?
    let viewport: ViewportSize?
    let preview: ArtifactPreviewInfo?
}

// Result of the service.status RPC. `execPath` is the realpath of the running
// daemon's own binary (HAIL-27). It is nil when the daemon predates the field,
// which the app treats as "not my daemon" and restarts.
struct ServiceStatus: Codable, Equatable, Sendable {
    let version: String
    let dataRoot: String
    let sessionsLive: Int
    let casesOpen: Int
    let execPath: String?

    private enum CodingKeys: String, CodingKey {
        case version
        case dataRoot = "data_root"
        case sessionsLive = "sessions_live"
        case casesOpen = "cases_open"
        case execPath = "exec_path"
    }
}

// One event notification. docs/protocol-mvp.md "Events".
struct Event: Codable, Equatable, Sendable {
    let type: EventType
    let caseId: String?
    let replyId: String?
    let sessionId: String?
    let at: String

    private enum CodingKeys: String, CodingKey {
        case type
        case caseId = "case_id"
        case replyId = "reply_id"
        case sessionId = "session_id"
        case at
    }
}
