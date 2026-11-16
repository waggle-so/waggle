import SwiftUI

/// The full-size page row: the artifact stage on the left, the decision column on the right.
/// The column always keeps its width and stays inside the window. When the stage's content asks
/// for more room than is left (a wide toolbar in a narrow window), the stage is clipped, never the column.
struct StageAndColumnRow<Stage: View, Column: View>: View {
    let columnWidth: CGFloat?
    @ViewBuilder let stage: () -> Stage
    @ViewBuilder let column: () -> Column

    var body: some View {
        HStack(spacing: 0) {
            stage()
                .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .clipped()
            if let columnWidth {
                column()
                    .frame(width: columnWidth)
                    .layoutPriority(1)
            } else {
                column()
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(1)
            }
        }
    }
}
