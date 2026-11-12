import SwiftUI

/// The compact row of every screen of the decision on show (decision record 2026-11-12): one size of thumbnail,
/// the variant badge ("A2") inside it, top left, a gap between variants, a line before the shared images, and
/// ‹ n / total › at the end. The caption of a screen shows on hover; the title of the screen on show sits in
/// the header. The box and full size use this one row.
struct ScreenRow: View {
    @ObservedObject var store: CommentsSessionStore
    /// The id of the screen on show.
    let current: String?
    let onSelect: (String) -> Void
    let onStep: (Int) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let thumbSize = CGSize(width: 46, height: 29)
    static let height: CGFloat = 49

    var body: some View {
        let screens = store.galleryScreens
        let labels = store.galleryLabels
        let index = screens.firstIndex { $0.id == current } ?? 0
        HStack(spacing: 10) {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(Array(screens.enumerated()), id: \.element.id) { position, screen in
                            if position > 0 { divider(before: labels[position], after: labels[position - 1]) }
                            thumbnail(screen, label: labels[position], position: position).id(screen.id)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .onChange(of: current) { _, id in
                    if let id { ReducedMotion.animate(reduceMotion: reduceMotion) { proxy.scrollTo(id) } }
                }
                // A row that opens on a later screen starts scrolled to it.
                .onAppear { if let current { proxy.scrollTo(current) } }
            }
            counter(index: index, total: screens.count)
        }
        .padding(.horizontal, 12)
        .frame(height: Self.height)
        .frame(maxWidth: .infinity)
        .background(Theme.Colors.side)
        .overlay(Rectangle().fill(Theme.Colors.line).frame(height: 1), alignment: .bottom)
    }

    /// A 6 pt gap where the variant changes; a 1 pt line before the first shared image.
    @ViewBuilder
    private func divider(before label: ScreenRowLabel, after previous: ScreenRowLabel) -> some View {
        if label.isShared && !previous.isShared {
            Rectangle().fill(Theme.Colors.line2).frame(width: 1, height: 26).padding(.horizontal, 6)
        } else if label.variant != previous.variant {
            Color.clear.frame(width: 6, height: 1)
        }
    }

    @ViewBuilder
    private func thumbnail(_ screen: CaptureRecord, label: ScreenRowLabel, position: Int) -> some View {
        let isCurrent = screen.id == current
        let count = store.model.comments(on: screen.id).count
        Button { onSelect(screen.id) } label: {
            ZStack(alignment: .topLeading) {
                Group {
                    if let image = store.imagesByCaptureId[screen.id] {
                        Image(nsImage: image).resizable().scaledToFill()
                    } else {
                        Theme.Colors.list
                    }
                }
                .frame(width: Self.thumbSize.width, height: Self.thumbSize.height, alignment: .top)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(isCurrent ? Theme.Colors.honey500 : Theme.Stroke.card.color,
                                lineWidth: isCurrent ? 2 : Theme.Stroke.card.width))
                .opacity(label.isShared && !isCurrent ? 0.85 : 1)
                if let badge = label.badge { badgeView(badge, isCurrent: isCurrent).padding(2) }
            }
            .overlay(alignment: .topTrailing) {
                if count > 0 {
                    Text("\(count)")
                        .knockTextStyle(Theme.Typography.pinNumber9_5w700)
                        .foregroundColor(Theme.Colors.win)
                        .frame(minWidth: 14, minHeight: 14)
                        .background(Capsule().fill(Theme.Colors.accent))
                        .offset(x: 4, y: -4)
                }
            }
            .padding(2)
            .background(RoundedRectangle(cornerRadius: 7).fill(isCurrent ? Theme.Colors.honeySoft : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
        .help(store.screenTitle(for: screen))
        .accessibilityLabel(Self.accessibilityLabel(
            badge: label.badge, position: position,
            title: label.badge == nil ? store.screenTitle(for: screen) : ScreenRowLabels.title(caption: store.captionsByCaptureId[screen.id])))
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }

    /// VoiceOver reads the badge and the title: "Screen A2, Conferma".
    static func accessibilityLabel(badge: String?, position: Int, title: String?) -> String {
        let name = "Screen \(badge ?? String(position + 1))"
        guard let title, !title.isEmpty, title != name else { return name }
        return "\(name), \(title)"
    }

    private func badgeView(_ text: String, isCurrent: Bool) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundColor(isCurrent ? Theme.Colors.win : Theme.Colors.ink)
            .padding(.horizontal, 3)
            .frame(minWidth: 13, minHeight: 13)
            .background(RoundedRectangle(cornerRadius: 3).fill(isCurrent ? Theme.Colors.ink : Theme.Colors.win.opacity(0.94)))
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(isCurrent ? .clear : Theme.Colors.line2, lineWidth: 1))
    }

    private func counter(index: Int, total: Int) -> some View {
        HStack(spacing: 6) {
            stepButton("chevron.left", label: "Previous screen", enabled: index > 0) { onStep(-1) }
            Text("\(index + 1) / \(total)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(Theme.AskDoc.Colors.quiet)
                .monospacedDigit()
                .fixedSize()
            stepButton("chevron.right", label: "Next screen", enabled: index < total - 1) { onStep(1) }
        }
    }

    private func stepButton(_ symbol: String, label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(enabled ? Theme.Colors.ink2 : Theme.Colors.line2)
                .frame(width: 16, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}

/// The title of the screen on show, for the header of the box and of full size: a 1 pt line, the variant badge in
/// bold, then the caption without its letter ("C2 Riepilogo dopo la sync…"). "Screen N" for a screen with no caption.
struct ScreenTitleLabel: View {
    @ObservedObject var store: CommentsSessionStore

    var body: some View {
        if store.isScreenshotsCase, let capture = store.currentCapture {
            let label = store.currentLabel
            let caption = label?.badge == nil ? store.screenTitle(for: capture)
                : ScreenRowLabels.title(caption: store.captionsByCaptureId[capture.id])
            HStack(spacing: 8) {
                Rectangle().fill(Theme.Colors.line2).frame(width: 1, height: 14)
                (Text(label?.badge.map { "\($0) " } ?? "").fontWeight(.bold).foregroundColor(Theme.Colors.ink)
                    + Text(caption ?? "").foregroundColor(Theme.Colors.ink2))
                    .font(.system(size: 12))
                    .lineLimit(1).truncationMode(.tail)
            }
            .layoutPriority(-1)
            .help(store.screenTitle(for: capture))
        }
    }
}
