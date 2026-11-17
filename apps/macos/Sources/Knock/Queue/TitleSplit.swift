import SwiftUI

/// WAG-249: a request's title stays short. A title over 80 characters, or with more than one
/// sentence, keeps its first sentence (cut at 80 characters on a word boundary, with "…") and the rest
/// moves to a description. One pure function, used by the ask column, queue rows, Home lines and
/// notifications.
struct TitleSplit: Equatable {
    static let maxTitleLength = 80

    let title: String
    /// What the title left out, or nil when the title is short and one sentence.
    let description: String?
    /// The whole first sentence when the 80-character cut ended it with "…", else nil. "Show all" shows it.
    var fullTitle: String? = nil
    /// The text after that whole sentence, for "Show all". Nil when there is none.
    var fullDescription: String? = nil

    static func make(_ text: String) -> TitleSplit {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let (sentence, rest) = firstSentence(of: trimmed)
        guard sentence.count > maxTitleLength else {
            return TitleSplit(title: sentence, description: rest.isEmpty ? nil : rest)
        }
        let cut = wordCut(sentence)
        let tail = [cut.tail, rest].filter { !$0.isEmpty }.joined(separator: " ")
        return TitleSplit(
            title: cut.head + "…", description: tail.isEmpty ? nil : tail,
            fullTitle: sentence, fullDescription: rest.isEmpty ? nil : rest)
    }

    /// The text up to the first sentence end (a ".", "!" or "?" before a space) or the first new line.
    private static func firstSentence(of text: String) -> (String, String) {
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(after: index)
            let character = text[index]
            if character.isNewline {
                return (trim(text[..<index]), trim(text[next...]))
            }
            if ".!?".contains(character), next < text.endIndex, text[next].isWhitespace {
                return (trim(text[...index]), trim(text[next...]))
            }
            index = next
        }
        return (text, "")
    }

    /// Cuts a long sentence at 80 characters, back to the last space unless the 80th character ends a word.
    private static func wordCut(_ text: String) -> (head: String, tail: String) {
        let limit = text.index(text.startIndex, offsetBy: maxTitleLength)
        var cut = limit
        if !text[limit].isWhitespace, let space = text[..<limit].lastIndex(where: \.isWhitespace) {
            cut = space
        }
        let head = text[..<cut].trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: ",;:")))
        return (head, trim(text[cut...]))
    }

    private static func trim(_ text: Substring) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The description under a split title: body style, Theme ink2, regular weight, four lines, then "Show more".
struct TitleDescriptionView: View {
    let text: String
    @State private var isExpanded = false
    @State private var shownHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0

    private var plain: String { AgentMarkdown.plainText(text) }
    private var isCut: Bool { fullHeight > shownHeight + 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isExpanded {
                AgentMarkdownText(text: text, style: Theme.Typography.body13w400, color: Theme.Colors.ink2)
            } else {
                Text(plain)
                    .knockTextStyle(Theme.Typography.body13w400)
                    .foregroundColor(Theme.Colors.ink2)
                    .lineLimit(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { shownHeight = $0 }
                    .background(
                        Text(plain).knockTextStyle(Theme.Typography.body13w400)
                            .fixedSize(horizontal: false, vertical: true).hidden()
                            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { fullHeight = $0 }
                    )
            }
            if isCut || isExpanded {
                Button(isExpanded ? "Show less" : "Show more") { isExpanded.toggle() }
                    .buttonStyle(.plain).pointerCursor()
                    .knockTextStyle(Theme.Typography.caption11_5w400)
                    .foregroundColor(Theme.Colors.ink2)
                    .underline()
            }
        }
    }
}
