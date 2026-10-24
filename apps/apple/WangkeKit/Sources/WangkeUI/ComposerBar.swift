#if canImport(SwiftUI)
import SwiftUI

/// iMessage 式输入栏：胶囊输入框，有字时发送键弹出。
/// 输入法的组字（拼音候选）由系统 TextField 处理，组字中的回车不会触发发送。
struct ComposerBar: View {
    @Binding var text: String
    var isEnabled: Bool
    var onSend: () -> Void
    @FocusState private var focused: Bool

    private var canSend: Bool { isEnabled && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("消息", text: $text, axis: .vertical)
                .lineLimit(1...8)
                .focused($focused)
                .padding(.leading, 14)
                .padding(.trailing, 38)
                .padding(.vertical, 8)
                .overlay(alignment: .bottomTrailing) {
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 28))
                            .symbolRenderingMode(.multicolor)
                    }
                    .buttonStyle(.plain)
                    .padding(3)
                    .scaleEffect(canSend ? 1 : 0.5)
                    .opacity(canSend ? 1 : 0)
                    .blur(radius: canSend ? 0 : 2)
                    .animation(.spring(response: 0.3, dampingFraction: 0.6), value: canSend)
                    .disabled(!canSend)
                    .accessibilityLabel("发送")
                }
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Color.secondary.opacity(0.35), lineWidth: 1)
                )
                .disabled(!isEnabled)
                #if os(macOS)
                .onSubmit(send)
                #endif
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        guard canSend else { return }
        onSend()
    }
}
#endif
