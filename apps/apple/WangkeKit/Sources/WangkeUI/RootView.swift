#if canImport(SwiftUI)
import SwiftUI
import WangkeKit

/// 壳层入口：没登录显示登录页，登录后是线程列表 → 对话。
/// iOS 上是 NavigationStack；macOS 壳层以后可以换成 NavigationSplitView，复用同一套子视图。
public struct RootView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        Group {
            if model.isSignedIn {
                ThreadListView()
                    .transition(.opacity)
            } else {
                LoginView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: model.isSignedIn)
    }
}

public struct ThreadListView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [ThreadSummary] = []

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            List(model.threads) { thread in
                NavigationLink(value: thread) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(thread.displayTitle).font(.body.weight(.semibold)).lineLimit(1)
                        if let date = WangkeDate.parse(thread.updatedAt) {
                            Text(MessageBubble.stamp(date)).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .listStyle(.plain)
            .overlay {
                if model.threads.isEmpty {
                    Button("新建线程", systemImage: "square.and.pencil", action: create)
                        .buttonStyle(.bordered)
                }
            }
            .refreshable { await model.refreshThreads() }
            .navigationTitle("Bot")
            .navigationDestination(for: ThreadSummary.self) { ConversationView(thread: $0) }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: create) { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("新建线程")
                }
                ToolbarItem(placement: .cancellationAction) {
                    Menu {
                        if let user = model.credential?.user {
                            Text(user.name)
                        }
                        Button("退出登录", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                            Task { await model.signOut() }
                        }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
            .task { await model.refreshThreads() }
        }
        .alert("出错了", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("好") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private func create() {
        Task {
            if let thread = await model.newThread() { path.append(thread) }
        }
    }
}
#endif
