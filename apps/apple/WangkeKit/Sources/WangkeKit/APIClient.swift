import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct APIError: Error, LocalizedError, Equatable, Sendable {
    public let status: Int
    public let code: String

    public var errorDescription: String? {
        switch code {
        case "invalid_credentials": return "用户名或密码不对"
        case "unauthorized": return "登录已过期，请重新登录"
        case "token_login_unsupported": return "这个服务端版本还不支持 App 登录，请先升级服务端"
        case "network": return "连不上服务器"
        default: return code
        }
    }
}

/// 所有数据都从后端拿。鉴权一律用 `Authorization: Bearer`，不碰 Cookie。
public final class APIClient: @unchecked Sendable {
    public let baseURL: URL
    private let session: URLSession
    private let lock = NSLock()
    private var _token: String?

    public var token: String? {
        get { lock.lock(); defer { lock.unlock() }; return _token }
        set { lock.lock(); _token = newValue; lock.unlock() }
    }

    public init(baseURL: URL, token: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL
        self._token = token
        self.session = session
    }

    // MARK: - 请求

    func makeRequest(_ path: String, method: String = "GET", body: Encodable? = nil) throws -> URLRequest {
        guard let url = URL(string: "api/v1" + path, relativeTo: baseURL.appendingSlash) else {
            throw APIError(status: 0, code: "invalid_url")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        return request
    }

    func send<T: Decodable>(_ request: URLRequest, as type: T.Type = T.self) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError(status: 0, code: "network")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let code = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "http_\(status)"
            throw APIError(status: status, code: code)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - 鉴权

    public func health() async throws -> ServerHealth {
        try await send(makeRequest("/health"))
    }

    /// 用户名 + 密码换 token。成功后自动带在后续请求上。
    public func login(username: String, password: String, deviceName: String) async throws -> TokenGrant {
        let health = try await health()
        if let auth = health.auth, !auth.contains("token") {
            throw APIError(status: 0, code: "token_login_unsupported")
        }
        let grant: TokenGrant = try await send(makeRequest("/auth/token", method: "POST", body: [
            "username": username, "password": password, "deviceName": deviceName,
        ]))
        token = grant.token
        return grant
    }

    public func logout() async {
        _ = try? await send(makeRequest("/auth/logout", method: "POST"), as: OkBody.self)
        token = nil
    }

    public func currentUser() async throws -> WangkeUser? {
        let session: SessionBody = try await send(makeRequest("/auth/session"))
        return session.authenticated ? session.user : nil
    }

    // MARK: - 线程与消息

    public func threads() async throws -> [ThreadSummary] {
        let body: ThreadsBody = try await send(makeRequest("/threads"))
        return body.threads.filter { $0.mode == .bot }
    }

    public func thread(_ id: String) async throws -> ThreadDetail {
        try await send(makeRequest("/threads/\(id.urlPathEscaped)"))
    }

    public func createThread(title: String? = nil) async throws -> ThreadSummary {
        var body: [String: String] = ["mode": "bot"]
        if let title { body["title"] = title }
        return try await send(makeRequest("/threads", method: "POST", body: body))
    }

    public func sendText(_ content: String, to threadId: String, nonce: String = UUID().uuidString) async throws -> Message {
        try await send(makeRequest("/threads/\(threadId.urlPathEscaped)/messages", method: "POST", body: [
            "clientNonce": nonce, "role": "user", "kind": "text", "content": content,
        ]))
    }

    public func stop(threadId: String) async throws {
        _ = try await send(makeRequest("/threads/\(threadId.urlPathEscaped)/stop", method: "POST"), as: StopBody.self)
    }

    public func resolveApproval(_ id: String, approved: Bool) async throws -> Approval {
        try await send(makeRequest("/approvals/\(id.urlPathEscaped)/resolve", method: "POST", body: ApprovalBody(approved: approved)))
    }

    public func react(messageId: String, reaction: String = "👍") async throws {
        _ = try await send(makeRequest("/messages/\(messageId.urlPathEscaped)/reactions", method: "POST", body: ["reaction": reaction]), as: ReactionBody.self)
    }

    /// 事件流：服务端一次性回放 `after` 之后的事件然后关闭连接，调用方循环重连。
    public func events(threadId: String, after: Int) async throws -> [ServerEvent] {
        var request = try makeRequest("/threads/\(threadId.urlPathEscaped)/events?after=\(after)")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(String(after), forHTTPHeaderField: "Last-Event-ID")
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw APIError(status: status, code: "events_\(status)") }
        return SSEParser.parse(String(decoding: data, as: UTF8.self))
    }
}

// MARK: - 内部 DTO

struct ErrorBody: Decodable { let error: String }
struct OkBody: Decodable { let ok: Bool? }
struct StopBody: Decodable { let stopped: Int }
struct ReactionBody: Decodable { let active: Bool }
struct ThreadsBody: Decodable { let threads: [ThreadSummary] }
struct SessionBody: Decodable { let authenticated: Bool; let user: WangkeUser? }
struct ApprovalBody: Encodable { let approved: Bool }

struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ value: Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

extension URL {
    var appendingSlash: URL {
        absoluteString.hasSuffix("/") ? self : URL(string: absoluteString + "/") ?? self
    }
}

extension String {
    var urlPathEscaped: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? self
    }
}
