import SwiftUI

/// The grey line above the ask title: where the ask comes from, in one line. It replaces the old boxed
/// Context card.
enum AskCrumbs {
    /// "Gym OS / Share link settings": the project and the session title. The folder or worktree name
    /// ("shaded-town-51fbc404") shows only in a tooltip (`folderHelp`), never in the line (WAG-290).
    /// With no session title the line is the project alone.
    static func breadcrumb(task: KnockTask, sessionTitle: String?, separator: String = " / ") -> String {
        let project = projectName(task)
        guard let rest = titlePart(task: task, sessionTitle: sessionTitle) else { return project }
        return "\(project)\(separator)\(rest)"
    }

    /// The project in plain words (WAG-302): a worktree-like project ("fragrant-hospital-fc8f1973") reads
    /// "Fragrant hospital". A topic with spaces ("Gym OS") shows as written.
    static func projectName(_ task: KnockTask) -> String {
        let plain = ProjectName.display(project: task.project)
        return plain.isEmpty ? task.project : plain
    }

    /// The part after the project: the session title, or nothing. A task name is an internal slug
    /// ("brainstorm", "app"), so it never shows in the line (WAG-324). The ask title sits right below.
    static func titlePart(task: KnockTask, sessionTitle: String?) -> String? {
        guard let sessionTitle, !sessionTitle.isEmpty else { return nil }
        return sessionTitle
    }

    /// The folder name for the tooltip, when it is not the project name.
    static func folderHelp(_ task: KnockTask) -> String { task.name == task.project ? task.project : task.name }

    /// "Gym OS / app · Claude Code · 3rd ask in this session".
    static func line(breadcrumb: String, runtime: String, askNumber: Int?, step: String? = nil) -> String {
        var parts = [breadcrumb, runtime]
        if let askNumber, askNumber > 1 { parts.append("\(SessionContextBlock.ordinal(askNumber)) decision in this session") }
        if let step { parts.append(step) }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

extension AskCrumbs {
    /// The one crumb of every screen (WAG-333): the case page and the full size column build it here.
    /// A stepped ask drops the ask number and names the step instead.
    static func screenLine(
        task: KnockTask, sessionTitle: String?, runtime: String, askNumber: Int?, doc: QuestionsDocModel?
    ) -> String {
        let stepped = doc?.isStepped == true
        return line(
            breadcrumb: breadcrumb(task: task, sessionTitle: sessionTitle), runtime: runtime,
            askNumber: stepped ? nil : askNumber, step: stepped ? doc?.stepCrumb : nil)
    }

    /// The case title shows once per screen (WAG-333). A stepped ask shows each question as the title.
    static func showsCaseTitle(doc: QuestionsDocModel?) -> Bool { doc?.isStepped != true }
}

/// The need as the case map mockup's `.need` box (decision 2026-11-10): the need fill, radius 10, padding 11/13,
/// text 13/1.5 ink; the lead sentence (`.q`) 600 13.5; "Why you: …" 12 ink3 (plain, no bold lead-in) under a 1 pt
/// line; a long details part folds behind "▸ Show …" (`.more`). The same box in the pane and in full size.
struct NeedCalloutView: View {
    let need: String
    let why: String?
    /// Kept for callers; the box has one size in every column now (the mockup's).
    var isCompact = false
    /// What the stage track or the step above the box already says ("Design · section 3 of 3"). A leading
    /// "Section 3 of 3:" in the need that says the same is dropped (WAG-294).
    var labelAbove: String?
    @Environment(\.sourcesHub) private var sourcesHub
    @Environment(\.askComments) private var askHub
    @State private var showsDetails = false
    @State private var showsFullWhy = false

    private typealias Column = Theme.AskDoc.Column

    var body: some View {
        // WAG-359: a source no text cites shows as a pill at the end of the why text, else of the need.
        let uncited = sourcesHub?.book.uncited ?? []
        let whyHasText = why.map { !$0.isEmpty } ?? false
        let need = whyHasText ? need : SourceMarkers.appending(uncited: uncited, to: need)
        // An empty need (it repeated the title) leaves out the box; "Why you" stays, alone.
        if !need.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                let parts = NeedText.split(need, labelAbove: labelAbove)
                let folds = parts.details.map { NeedText.foldsDetails(question: parts.question, details: $0) } ?? false
                VStack(alignment: .leading, spacing: Column.needParagraphGap) {
                    if !parts.question.isEmpty {
                        AgentMarkdownText(
                            text: parts.question, style: Column.needQuestion, color: Theme.Colors.ink, showsSources: true,
                            target: AskCommentTarget(.need, slot: "question"), weight: .semibold)
                    }
                    if let details = parts.details, !folds || showsDetails {
                        // The details start after the question in the plain text of the need.
                        let base = parts.question.isEmpty ? 0 : AskTextContent.plainLength(of: parts.question, mode: .blocks) + 1
                        AgentMarkdownText(
                            text: details, style: Column.need, color: Theme.Colors.ink, showsSources: true,
                            target: AskCommentTarget(.need, slot: "details", baseOffset: base))
                    }
                    if folds, let details = parts.details {
                        moreLink(details)
                    }
                }
                .textSelection(.enabled)
                if whyHasText {
                    // `.why`: border-top 1 #efe2b8, padding-top 7, margin-top 8.
                    whyLine(uncited)
                        .padding(.top, 7)
                        .overlay(alignment: .top) { Rectangle().fill(Theme.Colors.needDivider).frame(height: 1) }
                        .padding(.top, 8)
                }
            }
            .environment(\.askParagraphGap, Column.needParagraphGap)
            .environment(\.askNumberColor, Theme.Colors.ink)
            .padding(Column.needPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Colors.needFill)
            .clipShape(RoundedRectangle(cornerRadius: Theme.AskDoc.Radius.need))
        } else if whyHasText {
            whyLine(uncited)
        }
    }

    /// "▸ Show the table and 2 more paragraphs" / "Hide": 12, the need label colour, underlined.
    private func moreLink(_ details: String) -> some View {
        Button {
            showsDetails.toggle()
        } label: {
            Text(showsDetails ? "▾ Hide the details" : "▸ " + NeedText.showLabel(details))
                .knockTextStyle(Column.needMore)
                .foregroundColor(Theme.AskDoc.Colors.needLabel)
                .underline()
                .fixedSize(horizontal: false, vertical: true)
        }
        .buttonStyle(.plain).pointerCursor()
        .accessibilityLabel(showsDetails ? "Hide the details of the need" : "Show the details of the need")
    }

    /// "Why you:" is a lead-in Waggle writes, outside the text a comment counts in. The commentable path draws it in
    /// the line's own weight; without a comment hub it is plain text in the line (the SwiftUI path bolds a prefix).
    /// Task 11c: one plain line, cut at its end; a click shows the full text (commentable). A line with a saved comment
    /// shows in full, so its pin stays in view.
    @ViewBuilder
    private func whyLine(_ uncited: [String]) -> some View {
        let text = SourceMarkers.appending(uncited: uncited, to: why ?? "")
        let hasComment = askHub.map { !$0.comments(for: AskCommentTarget(.why), length: Int.max / 2).isEmpty } ?? false
        Group {
            if showsFullWhy || hasComment {
                SourcedText(
                    text: askHub == nil ? "Why you: " + text : text, prefix: askHub == nil ? nil : "Why you:",
                    style: Column.needWhy, color: Theme.Colors.ink3, target: AskCommentTarget(.why))
                    .textSelection(.enabled)
            } else {
                let line = "Why you: " + AgentMarkdown.singleLine(text)
                Button { showsFullWhy = true } label: {
                    Text(line)
                        .font(Column.needWhy.font)
                        .monospacedDigit()
                        .foregroundColor(Theme.Colors.ink3)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(AgentMarkdown.singleLine(text))
                .accessibilityLabel(line)
                .accessibilityHint("Shows the full text")
            }
        }
        .environment(\.askNumberColor, Theme.Colors.ink2)
    }
}

/// The need box reads as a question plus details (WAG-294): the first paragraph is the question in
/// semibold ink, the other paragraphs and lists are details in ink2 regular, a little smaller.
enum NeedText {
    struct Parts: Equatable {
        var question: String
        var details: String?
    }

    /// Splits at the first blank line. A text that opens with a list or a table has no question. A leading
    /// "Section n of N:" or "Question n of N:" goes when `labelAbove` already says it.
    static func split(_ need: String, labelAbove: String? = nil) -> Parts {
        let text = dropSectionPrefix(need.trimmingCharacters(in: .whitespacesAndNewlines), labelAbove: labelAbove)
        let paragraphs = RoundHeading.paragraphs(text)
        guard let first = paragraphs.first else { return Parts(question: "", details: nil) }
        let opensWithList = first.components(separatedBy: "\n").first.map {
            AgentMarkdown.listMarker($0.trimmingCharacters(in: .whitespaces)) != nil
        } ?? false
        if opensWithList { return Parts(question: "", details: text) }
        // A table or a list is never part of the question: the question stops at the line where one starts.
        let firstLines = first.components(separatedBy: "\n")
        if let start = firstLines.indices.first(where: {
            (firstLines[$0].contains("|") && $0 + 1 < firstLines.count && AgentMarkdown.isTableSeparator(firstLines[$0 + 1]))
                || AgentMarkdown.listMarker(firstLines[$0].trimmingCharacters(in: .whitespaces)) != nil
        }) {
            let question = firstLines[..<start].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            let details = ([firstLines[start...].joined(separator: "\n")] + paragraphs.dropFirst()).joined(separator: "\n\n")
            return Parts(question: question, details: details)
        }
        let rest = paragraphs.dropFirst().joined(separator: "\n\n")
        return Parts(question: first, details: rest.isEmpty ? nil : rest)
    }

    /// True when `need` says no more than `title`: the same words, whatever the markers, case or final dot.
    static func repeats(_ need: String, title: String) -> Bool {
        let a = normalized(need), b = normalized(title)
        return !a.isEmpty && a == b
    }

    private static func normalized(_ text: String) -> String {
        AgentMarkdown.singleLine(text).lowercased()
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
    }

    private static let prefix = try! NSRegularExpression(
        pattern: #"^(\*\*)?((?:Section|Question) \d+ of ~?\d+)\s*[:.\-\u2013\u2014]\s*(\*\*)?\s*"#,
        options: [.caseInsensitive])

    static func dropSectionPrefix(_ text: String, labelAbove: String?) -> String {
        guard let labelAbove, !labelAbove.isEmpty else { return text }
        let ns = text as NSString
        guard let m = prefix.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
            labelAbove.lowercased().contains(ns.substring(with: m.range(at: 2)).lowercased())
        else { return text }
        var rest = ns.substring(from: m.range.upperBound)
        // "**Section 3 of 3: Today**": keep the bold that still has its closing marker.
        if m.range(at: 1).location != NSNotFound, m.range(at: 3).location == NSNotFound { rest = "**" + rest }
        return rest.isEmpty ? text : rest
    }

    static func questionStyle(_ base: Theme.TextStyle) -> Theme.TextStyle {
        Theme.TextStyle(font: base.font.weight(.semibold), size: base.size, lineHeight: base.lineHeight, letterSpacing: base.letterSpacing)
    }

    /// The details fold behind "▸ Show …" when there is a lead sentence and they are long (mockup `.need .more`,
    /// decision 2026-11-10): more than `foldLength` characters of plain text, or a table.
    static func foldsDetails(question: String, details: String) -> Bool {
        guard !question.isEmpty, !details.isEmpty else { return false }
        let blocks = AgentMarkdown.blocks(details, keepingSources: false)
        if blocks.contains(where: { if case .table = $0 { true } else { false } }) { return true }
        return AgentMarkdown.plainText(details).count > foldLength
    }

    static let foldLength = 200

    /// "Show 2 more paragraphs and a table": what the fold holds, in words.
    static func showLabel(_ details: String) -> String {
        var paragraphs = 0, lists = 0, tables = 0
        var inList = false
        for block in AgentMarkdown.blocks(details, keepingSources: false) {
            switch block {
            case .paragraph, .heading: paragraphs += 1; inList = false
            case .bullet, .numbered: if !inList { lists += 1 }; inList = true
            case .table: tables += 1; inList = false
            }
        }
        var parts: [String] = []
        if paragraphs > 0 { parts.append(paragraphs == 1 ? "1 more paragraph" : "\(paragraphs) more paragraphs") }
        if lists > 0 { parts.append(lists == 1 ? "a list" : "\(lists) lists") }
        if tables > 0 { parts.append(tables == 1 ? "a table" : "\(tables) tables") }
        guard !parts.isEmpty else { return "Show the details" }
        let words = parts.count == 1 ? parts[0] : parts.dropLast().joined(separator: ", ") + " and " + parts.last!
        return "Show " + words
    }

    /// One point smaller than the question, regular weight.
    static func detailStyle(_ base: Theme.TextStyle) -> Theme.TextStyle {
        let size = max(base.size - 2, 12)
        return Theme.TextStyle(
            font: .custom(Theme.FontFamily.sans, size: size), size: size, lineHeight: base.lineHeight, letterSpacing: base.letterSpacing)
    }
}

/// How wide the column that holds an ask header is (WAG-302). The title size follows this class, never
/// the screen: the same column gets the same size in the pane and in the workspace.
enum AskHeaderWidth: Equatable {
    /// The full pane page. Waggle title scale: 28/600.
    case wide
    /// A side column: the decision column in the pane and in full size. The mockup's `h1`: 600 19/1.25, −0.02 em.
    case narrow

    var titleStyle: Theme.TextStyle {
        switch self {
        case .wide: Theme.AskDoc.Chrome.pageTitle
        case .narrow: Theme.AskDoc.Column.title
        }
    }
}

/// The project crumb of the top bar (C2, spec section 2 line 1): "Project  /  session title", in the pane and in
/// full size. The project name is short and keeps its full width; the session title gives way first, cut at its end.
/// `onOpenProject` makes the project name a button (the pane opens the project page, WAG-260).
struct TopBarCrumb: View {
    let task: KnockTask
    let sessionTitle: String?
    var onOpenProject: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 0) {
            if let onOpenProject {
                Button(action: onOpenProject) { project.contentShape(Rectangle()) }
                    .buttonStyle(.plain).pointerCursor()
                    .help("Open the project page")
            } else {
                project.help(AskCrumbs.folderHelp(task))
            }
            if let rest = AskCrumbs.titlePart(task: task, sessionTitle: sessionTitle) {
                // Case map `.top`: " / " in mono 11.5, ink3.
                Text(" / \(rest)")
                    .knockTextStyle(Theme.AskDoc.Chrome.crumb)
                    .foregroundColor(Theme.Colors.ink3)
                    .lineLimit(1).truncationMode(.tail)
                    .help(AskCrumbs.folderHelp(task))
            }
        }
    }

    /// `.top b`: the project in ink, same mono 400.
    private var project: some View {
        Text(AskCrumbs.projectName(task))
            .knockTextStyle(Theme.AskDoc.Chrome.crumb)
            .foregroundColor(Theme.Colors.ink)
            .lineLimit(1)
            .fixedSize()
    }
}

/// The grey crumb line over an ask title, with the menu of earlier asks beside it. One view for the
/// case pane page and the workspace column (WAG-302). `crumb` is nil in the workspace, where the
/// titlebar already shows it.
struct AskCrumbLine: View {
    var crumb: String?
    var help: String? = nil
    var earlierAsks: EarlierAsksModel?
    var onOpenCase: (String) -> Void
    var onOpenHistory: (() -> Void)?

    var body: some View {
        if crumb != nil || earlierAsks?.linkLabel != nil {
            HStack(spacing: 6) {
                if let crumb {
                    Text(crumb)
                        .knockTextStyle(Theme.AskDoc.Typography.crumbs12)
                        .foregroundColor(Theme.AskDoc.Colors.quiet)
                        .lineLimit(1).truncationMode(.tail)
                        .help(help ?? "")
                }
                if let earlierAsks {
                    EarlierAsksLink(model: earlierAsks, onOpenCase: onOpenCase, onOpenHistory: onOpenHistory)
                        .layoutPriority(1)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The ask title: the round heading when the ask is in a later round, else the title with its
/// description. The size follows the column width class.
struct AskTitleView: View {
    let heading: RoundHeading?
    let title: String
    let width: AskHeaderWidth

    var body: some View {
        if let heading {
            RoundHeadingView(heading: heading, titleStyle: width.titleStyle)
        } else {
            SplitTitleView(text: title, style: width.titleStyle, spacing: 6)
        }
    }
}

/// A title that `TitleSplit` keeps short, with its description under it. When the 80-character cut ends
/// the title with "…", a "Show all" link shows the whole sentence as the title.
struct SplitTitleView: View {
    let text: String
    let style: Theme.TextStyle
    var spacing: CGFloat = 4
    @State private var showsAll = ProcessInfo.processInfo.environment["KNOCK_EVIDENCE_SHOW_ALL"] == "1"

    var body: some View {
        let split = TitleSplit.make(text)
        let isCut = split.fullTitle != nil
        let title = showsAll ? (split.fullTitle ?? split.title) : split.title
        let description = showsAll && isCut ? split.fullDescription : split.description
        VStack(alignment: .leading, spacing: spacing) {
            TitleText(text: title, style: style)
            if let description {
                TitleDescriptionView(text: description)
            }
            if isCut {
                Button(showsAll ? "Show less" : "Show all") { showsAll.toggle() }
                    .buttonStyle(.plain).pointerCursor()
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .foregroundColor(Theme.Colors.ink2)
                    .underline()
                    .accessibilityIdentifier("title-show-all")
            }
        }
    }
}

/// The title text of an ask. The person can comment on its words (WAG-357); outside a request page it is plain text.
struct TitleText: View {
    let text: String
    let style: Theme.TextStyle
    @Environment(\.askComments) private var askHub

    var body: some View {
        if askHub != nil {
            SourcedText(text: text, style: style, color: Theme.Colors.ink, target: AskCommentTarget(.title), weight: .semibold)
        } else {
            Text(text)
                .knockTextStyle(style)
                .foregroundColor(Theme.Colors.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
