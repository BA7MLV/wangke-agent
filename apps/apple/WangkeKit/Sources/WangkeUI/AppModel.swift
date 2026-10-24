#if canImport(SwiftUI) && canImport(Observation)
import Foundation
import Observation
import WangkeKit

/// 整个壳层的状态：登录凭据、线程列表、打开的线程。界面只读它、调它的方法，不直接碰网络。
@MainActor
@Observable
public final class AppModel {
    public private(set) var credential: StoredCredential?
    public private(set) var threads: [ThreadSummary] = []
    public private(set) var details: [String: ThreadDetail] = [:]
    public var errorMessage: String?

    private var client: APIClient?
    private let store: TokenStore
    private var streams: [String: Task<Void, Never>] = [:]
    private var cursors: [String: Int] = [:]

    public init(store: TokenStore) {
        self.store = store
        if let saved = store.load() {
            credential = saved
            client = APIClient(baseURL: saved.serverURL, token: saved.token)
        }
    }

    public var isSignedIn: Bool { credential != nil }

    // MARK: - 登录

    public func signIn(server: String, username: String, password: String, deviceName: String) async throws {
        guard let url = Self.normalizedServerURL(server) else {
            throw APIError(status: 0, code: "服务器地址不对")
        }
        let client = APIClient(baseURL: url)
        let grant = try await client.login(username: username, password: password, deviceName: deviceName)
        let credential = StoredCredential(serverURL: url, token: grant.token, user: grant.user)
        store.save(credential)
        self.client = client
        self.credential = credential
        await refreshThreads()
    }

    public func signOut() async {
        streams.values.forEach { $0.cancel() }
        streams = [:]
        await client?.logout()
        store.clear()
        client = nil
        credential = nil
        threads = []
        details = [:]
        cursors = [:]
    }

    /// 补全协议、去掉末尾斜杠。没写协议时默认 https。
    public nonisolated static func normalizedServerURL(_ input: String) -> URL? {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        if !value.contains("://") { value = "https://" + value }
        while value.hasSuffix("/") { value.removeLast() }
        guard let url = URL(string: value), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil else { return nil }
        return url
    }

    // MARK: - 数据

    public func refreshThreads() async {
        guard let client else { return }
        do {
            threads = try await client.threads()
        } catch let error as APIError where error.status == 401 {
            await expire()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func newThread() async -> ThreadSummary? {
        guard let client else { return nil }
        do {
            let thread = try await client.createThread(title: "新的 Bot 任务")
            threads.insert(thread, at: 0)
            details[thread.id] = ThreadDetail(id: thread.id, mode: thread.mode, title: thread.title, createdAt: thread.createdAt, updatedAt: thread.updatedAt, messages: [], approvals: [])
            return thread
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// 打开线程：拉详情，然后开事件流（服务端每次回放完就断开，这里循环重连）。
    public func open(_ threadId: String) async {
        guard let client else { return }
        if details[threadId] == nil {
            do {
                details[threadId] = try await client.thread(threadId)
            } catch {
                errorMessage = error.localizedDescription
                return
            }
        }
        guard streams[threadId] == nil else { return }
        streams[threadId] = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.pullEvents(threadId, client: client)
                try? await Task.sleep(nanoseconds: 800_000_000)
            }
        }
    }

    public func close(_ threadId: String) {
        streams[threadId]?.cancel()
        streams[threadId] = nil
    }

    private func pullEvents(_ threadId: String, client: APIClient) async {
        do {
            let events = try await client.events(threadId: threadId, after: cursors[threadId] ?? 0)
            for event in events {
                cursors[threadId] = max(cursors[threadId] ?? 0, event.id)
                if let message = event.message { apply(message, to: threadId) }
            }
        } catch let error as APIError where error.status == 401 {
            await expire()
        } catch {
            // 网络抖动：下一轮重连。
        }
    }

    private func apply(_ message: Message, to threadId: String) {
        guard var detail = details[threadId] else { return }
        detail.messages = MessageGrouping.merge(message, into: detail.messages)
        details[threadId] = detail
    }

    public func send(_ text: String, to threadId: String) async -> Bool {
        guard let client else { return false }
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return false }
        let nonce = UUID().uuidString
        // 先放一条本地气泡，服务端确认后按 clientNonce 替换。
        let pending = Message(id: "pending-\(nonce)", threadId: threadId, clientNonce: nonce, seq: Int.max, role: .user, kind: .text, content: content, createdAt: ISO8601DateFormatter().string(from: Date()), replyTo: nil)
        apply(pending, to: threadId)
        do {
            apply(try await client.sendText(content, to: threadId, nonce: nonce), to: threadId)
            return true
        } catch {
            details[threadId]?.messages.removeAll { $0.id == pending.id }
            errorMessage = "没发出去"
            return false
        }
    }

    public func resolve(_ approval: Approval, approved: Bool) async {
        guard let client else { return }
        do {
            let resolved = try await client.resolveApproval(approval.id, approved: approved)
            if var detail = details[approval.threadId] {
                detail.approvals = detail.approvals?.map { $0.id == resolved.id ? resolved : $0 }
                details[approval.threadId] = detail
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func react(to message: Message) async {
        try? await client?.react(messageId: message.id)
    }

    public func stop(_ threadId: String) async {
        try? await client?.stop(threadId: threadId)
    }

    private func expire() async {
        errorMessage = APIError(status: 401, code: "unauthorized").localizedDescription
        store.clear()
        streams.values.forEach { $0.cancel() }
        streams = [:]
        client = nil
        credential = nil
    }
}
#endif
