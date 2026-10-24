import Foundation

/// 与 `packages/contracts/src/index.ts` 一一对应的数据结构。字段名保持一致，直接用 JSONDecoder 解码。
public struct WangkeUser: Codable, Hashable, Sendable {
    public let id: String
    public let name: String
}

public enum ConversationMode: String, Codable, Sendable {
    case chat, bot
}

public struct ThreadSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let mode: ConversationMode
    public let title: String?
    public let createdAt: String
    public let updatedAt: String

    public var displayTitle: String { (title?.isEmpty == false ? title : nil) ?? "未命名任务" }
}

public enum MessageRole: String, Codable, Sendable {
    case user, assistant, system, tool
}

public enum MessageKind: String, Codable, Sendable {
    case text, progress, attachment, widget, question, approval
}

public struct Message: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let threadId: String
    public let clientNonce: String?
    public let seq: Int
    public let role: MessageRole
    public let kind: MessageKind
    public let content: String
    public let createdAt: String
    public let replyTo: String?

    public init(id: String, threadId: String, clientNonce: String?, seq: Int, role: MessageRole, kind: MessageKind, content: String, createdAt: String, replyTo: String?) {
        self.id = id
        self.threadId = threadId
        self.clientNonce = clientNonce
        self.seq = seq
        self.role = role
        self.kind = kind
        self.content = content
        self.createdAt = createdAt
        self.replyTo = replyTo
    }

    public var isMine: Bool { role == .user }
    public var date: Date { WangkeDate.parse(createdAt) ?? .distantPast }
}

public enum ApprovalStatus: String, Codable, Sendable {
    case pending, approved, rejected
}

public struct Approval: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let messageId: String
    public let threadId: String
    public let runId: String?
    public let status: ApprovalStatus
    public let createdAt: String
    public let resolvedAt: String?
    public let resolution: String?
}

public struct ThreadDetail: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let mode: ConversationMode
    public let title: String?
    public let createdAt: String
    public let updatedAt: String
    public var messages: [Message]
    public var approvals: [Approval]?
}

/// 附件消息的 content 是 JSON 字符串。
public struct AttachmentInfo: Codable, Hashable, Sendable {
    public let fileId: String?
    public let originalName: String?
    public let mimeType: String?
    public let sizeBytes: Int?

    public static func parse(_ content: String) -> AttachmentInfo? {
        guard let data = content.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(AttachmentInfo.self, from: data)
    }
}

public struct TokenGrant: Codable, Sendable {
    public let token: String
    public let tokenId: String
    public let tokenType: String
    public let expiresAt: String
    public let user: WangkeUser
}

public struct ServerHealth: Codable, Sendable {
    public let status: String
    public let version: String
    public let auth: [String]?
}

public enum WangkeDate {
    /// 服务端用 `new Date().toISOString()`，带毫秒。两种格式都试一下。
    public static func parse(_ value: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }
}
