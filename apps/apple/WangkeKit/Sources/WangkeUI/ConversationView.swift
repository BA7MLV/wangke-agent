#if canImport(SwiftUI)
import SwiftUI
import WangkeKit

/// 一个 Bot 线程的对话页。消息用 LazyVStack，长线程只渲染可见部分；默认停在底部。
public struct ConversationView: View {
    @Environment(AppModel.self) private var model
    let thread: ThreadSummary
    @State private var draft = ""

    public init(thread: ThreadSummary) {
        self.thread = thread
    }

    private var detail: ThreadDetail? { model.details[thread.id] }
    private var rows: [MessageRow] { MessageGrouping.rows(for: detail?.messages ?? []) }

    public var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(rows) { row in
                        MessageBubble(
                            row: row,
                            approval: detail?.approvals?.first { $0.messageId == row.message.id },
                            onResolve: { approval, approved in Task { await model.resolve(approval, approved: approved) } },
                            onReact: { message in Task { await model.react(to: message) } }
                        )
                        .id(row.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
                .animation(.spring(response: 0.3, dampingFraction: 0.85), value: rows.count)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: rows.last?.id) { _, last in
                guard let last else { return }
                withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(last, anchor: .bottom) }
            }
            .overlay {
                if detail == nil { ProgressView() }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerBar(text: $draft, isEnabled: detail != nil) {
                let text = draft
                draft = ""
                Task {
                    if !(await model.send(text, to: thread.id)) { draft = text }
                }
            }
        }
        .navigationTitle(thread.displayTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("停止当前任务", systemImage: "stop.fill") { Task { await model.stop(thread.id) } }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .task(id: thread.id) { await model.open(thread.id) }
        .onDisappear { model.close(thread.id) }
    }
}
#endif
