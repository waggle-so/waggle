import SwiftUI

/// The Settings window's sidebar (HAIL-50 contract: "sidebar 210 pt wide,
/// Theme.Colors.list fill, right hairline Theme.Colors.line, padding
/// 14/10" - vertical/horizontal throughout this file, matching the shorthand
/// the contract uses for every other padding pair). One row per
/// `SettingsPage`, plus the Appearance switch and "Waggle <version>" pinned to the bottom.
struct SettingsSidebarView: View {
    @ObservedObject var navigation: SettingsNavigationModel
    @StateObject private var appearance = AppearanceModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(navigation.visiblePages) { page in
                row(page)
            }
            Spacer(minLength: 0)
            appearanceSwitch
            Text("Waggle \(Updater.appVersion)")
                .knockTextStyle(Theme.Typography.monoMeta11w400)
                .foregroundColor(Theme.Colors.ink3)
                .padding(.leading, 10)
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 10)
        .frame(width: 210, alignment: .leading)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.Colors.list)
        .overlay(Rectangle().fill(Theme.Colors.line).frame(width: 1), alignment: .trailing)
    }

    /// One control for the look (decision 2026-11-11): System follows macOS. It sits here, not on a page, so
    /// the change shows on whatever page is open.
    private var appearanceSwitch: some View {
        VStack(alignment: .leading, spacing: 6) {
            SettingsSectionLabel("Appearance")
            StageControl.track {
                ForEach(AppearanceSetting.allCases) { choice in
                    appearanceSegment(choice)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Appearance")
    }

    /// Three equal segments that fill the sidebar width. `StageControl.segment` hugs its label, so it cannot.
    private func appearanceSegment(_ choice: AppearanceSetting) -> some View {
        let isActive = appearance.setting == choice
        return Button(action: { appearance.choose(choice) }) {
            Text(choice.label)
                .knockTextStyle(isActive ? Theme.Typography.buttonSm12_5w600 : Theme.Typography.buttonSm12_5w500)
                .foregroundColor(isActive ? Theme.Colors.ink : Theme.Colors.ink2)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
                .background(isActive ? Theme.Colors.win : Color.clear)
                .cornerRadius(Theme.Radius.columnTabsSegment)
                .shadow(
                    color: isActive ? Theme.Shadow.columnTab.color : .clear,
                    radius: Theme.Shadow.columnTab.blur / 2,
                    x: Theme.Shadow.columnTab.offset.width, y: Theme.Shadow.columnTab.offset.height
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerCursor()
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
    }

    private func row(_ page: SettingsPage) -> some View {
        let isSelected = navigation.selected == page
        return Button(action: { navigation.selected = page }) {
            HStack(spacing: 8) {
                Image(systemName: page.symbolName)
                    .font(.system(size: 15))
                    .frame(width: 16)
                Text(page.title)
                    .knockTextStyle(isSelected ? Theme.Typography.sidebarRow13w600 : Theme.Typography.sidebarRow13w400)
                Spacer(minLength: 0)
            }
            .foregroundColor(isSelected ? Theme.Colors.ink : Theme.Colors.ink2)
            .padding(.vertical, 7)
            .padding(.horizontal, 10)
            .background(isSelected ? Theme.Colors.sel : Color.clear)
            .cornerRadius(7)
        }
        .buttonStyle(.plain).pointerCursor()
    }
}

/// One page's chrome: title, subtitle, and its own content in a scroll view
/// (contract: "Content padding 24/28, gap 18; page title 19 pt semibold,
/// subtitle 12.5 pt ink-2").
struct SettingsPageChrome<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var content: () -> Content

    @ObservedObject private var router = SettingsRouter.shared

    var body: some View {
        ScrollViewReader { proxy in
            scroll
                .onAppear { scrollToRequestedCard(proxy) }
                .onChange(of: router.card) { _, _ in scrollToRequestedCard(proxy) }
        }
    }

    /// WAG-278: a "Set up" link in the Start menu names a card; scroll to it, then forget it.
    private func scrollToRequestedCard(_ proxy: ScrollViewProxy) {
        guard let card = router.card else { return }
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(card, anchor: .top) }
            router.card = nil
        }
    }

    private var scroll: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .knockTextStyle(Theme.Typography.dialogTitle19w650)
                        .foregroundColor(Theme.Colors.ink)
                    Text(subtitle)
                        .knockTextStyle(Theme.Typography.body12_5w400)
                        .foregroundColor(Theme.Colors.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                content()
            }
            .padding(.vertical, 24)
            .padding(.horizontal, 28)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A small-caps section label above a card (contract: "small caps section
/// labels 10.5 pt semibold ink-3").
struct SettingsSectionLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .knockTextStyle(Theme.Typography.labelCaps10_5w600)
            .foregroundColor(Theme.Colors.ink3)
    }
}

/// One grouped card (contract: "grouped rows in a card, radius 10, 1 pt
/// Theme.Colors.line"). Rows supply their own hairline via
/// `SettingsCardRow.showsDivider`, so the card itself only draws the outer
/// shape.
struct SettingsCard<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content()
        }
        .background(Theme.Colors.win)
        .cornerRadius(10)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.Colors.line, lineWidth: 1))
    }
}

/// One row inside a `SettingsCard`: title + optional subtitle on the left, a
/// trailing control on the right (contract: "each row padding 12/14,
/// hairline between rows").
struct SettingsCardRow<Trailing: View>: View {
    let title: String
    var subtitle: String?
    /// `nil` wraps to as many lines as the text needs; `1` truncates - used
    /// by a row whose subtitle is a long snippet (the Agents page's copy
    /// rows) rather than a short description.
    var subtitleLineLimit: Int?
    var showsDivider: Bool = true
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .knockTextStyle(Theme.Typography.rowTitle13_5w600)
                        .foregroundColor(Theme.Colors.ink)
                    if let subtitle {
                        Text(subtitle)
                            .knockTextStyle(Theme.Typography.body12_5w400)
                            .foregroundColor(Theme.Colors.ink3)
                            .lineLimit(subtitleLineLimit)
                            .truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: subtitleLineLimit == nil)
                    }
                }
                Spacer(minLength: 12)
                trailing()
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            if showsDivider {
                Rectangle().fill(Theme.Colors.line).frame(height: 1)
            }
        }
    }
}

/// A whole-row link (contract: Help's "Run setup again" row): title +
/// subtitle on the left, a chevron on the right, the entire row tappable.
struct SettingsCardLinkRow: View {
    let title: String
    var subtitle: String?
    var showsDivider: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            SettingsCardRow(title: title, subtitle: subtitle, showsDivider: showsDivider) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(Theme.Colors.ink3)
            }
        }
        .buttonStyle(.plain).pointerCursor()
    }
}

/// A status chip (contract: "status chips (ok: Theme.Colors.ok on
/// ok-soft)"). The non-ok case reuses the same neutral ink-2/side pairing
/// `OnboardingRuntimeRowView`'s own chips already use for "not connected" -
/// no fail-soft colour token exists for this to be an alarming red instead.
struct SettingsStatusChip: View {
    let text: String
    var ok = true

    var body: some View {
        Text(text)
            .knockTextStyle(Theme.Typography.buttonSm12_5w600)
            .foregroundColor(ok ? Theme.Colors.ok : Theme.Colors.ink2)
            .padding(.vertical, 3)
            .padding(.horizontal, 8)
            .background(ok ? Theme.Colors.okSoft : Theme.Colors.side)
            .cornerRadius(Theme.Radius.chip)
    }
}

/// Hover fill, a short press and a dimmed look when disabled, for the Settings buttons and the Share sheet (WAG-389).
struct SettingsButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary }
    let kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        StyleBody(kind: kind, configuration: configuration)
    }

    private struct StyleBody: View {
        let kind: Kind
        let configuration: Configuration
        @State private var isHovered = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .background(fill)
                .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.buttonSmall))
                .opacity(isEnabled ? 1 : 0.4)
                .pressFeel(isPressed: configuration.isPressed)
                .animation(.easeOut(duration: 0.12), value: isHovered)
                .onHover { isHovered = $0 }
                .pointerCursor()
        }

        @ViewBuilder private var fill: some View {
            let active = isEnabled && (isHovered || configuration.isPressed)
            switch kind {
            case .primary: RoundedRectangle(cornerRadius: Theme.Radius.buttonSmall).fill(Theme.Colors.ink.opacity(active ? 0.85 : 1))
            case .secondary: RoundedRectangle(cornerRadius: Theme.Radius.buttonSmall).fill(active ? Theme.Colors.hover : Color.clear)
            }
        }
    }
}

/// An outlined secondary button (contract: "secondary buttons outlined
/// (Theme.Colors.line2)").
struct SettingsSecondaryButton: View {
    var icon: String?
    let title: String
    var shortcut: KeyboardShortcut?
    let action: () -> Void

    init(icon: String? = nil, title: String, shortcut: KeyboardShortcut? = nil, action: @escaping () -> Void) {
        self.icon = icon
        self.title = title
        self.shortcut = shortcut
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon {
                    Image(systemName: icon).font(.system(size: 11))
                }
                Text(title)
                    .knockTextStyle(Theme.Typography.buttonSm12_5w600)
            }
            .foregroundColor(Theme.Colors.ink)
            .padding(.vertical, 7)
            .padding(.horizontal, 12)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.buttonSmall).strokeBorder(Theme.Colors.line2, lineWidth: 1))
        }
        .buttonStyle(SettingsButtonStyle(kind: .secondary))
        .keyboardShortcut(shortcut)
    }
}

/// A filled primary button (contract: "primary filled ink"). `minWidth` keeps the size when the title changes.
struct SettingsPrimaryButton: View {
    var icon: String?
    let title: String
    var minWidth: CGFloat?
    var shortcut: KeyboardShortcut?
    let action: () -> Void

    init(icon: String? = nil, title: String, minWidth: CGFloat? = nil, shortcut: KeyboardShortcut? = nil, action: @escaping () -> Void) {
        self.icon = icon
        self.title = title
        self.minWidth = minWidth
        self.shortcut = shortcut
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon {
                    Image(systemName: icon).font(.system(size: 11))
                }
                Text(title)
                    .knockTextStyle(Theme.Typography.buttonSm12_5w600)
            }
            .foregroundColor(Theme.Colors.win)
            .padding(.vertical, 7)
            .padding(.horizontal, 12)
            .frame(minWidth: minWidth)
        }
        .buttonStyle(SettingsButtonStyle(kind: .primary))
        .keyboardShortcut(shortcut)
    }
}
