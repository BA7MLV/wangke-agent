import Foundation

/// iMessage 的分组规则，与网页端 `src/pages/botMessages.ts` 保持一致：
/// 同一方 2 分钟内的连续消息算一组，只有每组最后一条带尾巴；
/// 相隔超过 15 分钟插一行居中时间。
public struct MessageRow: Identifiable, Hashable, Sendable {
    public var id: String { message.id }
    public let message: Message
    public let isFirstInGroup: Bool
    public let isLastInGroup: Bool
    /// 这一条前面要不要显示时间分隔
    public let timestamp: Date?
}

public enum MessageGrouping {
    public static let groupGap: TimeInterval = 2 * 60
    public static let timeGap: TimeInterval = 15 * 60

    public static func rows(for messages: [Message]) -> [MessageRow] {
        messages.indices.map { index in
            let message = messages[index]
            let previous = index > 0 ? messages[index - 1] : nil
            let next = index + 1 < messages.count ? messages[index + 1] : nil
            let time = message.date
            let stamped = previous.map { time.timeIntervalSince($0.date) > timeGap } ?? true
            let joinsPrevious = previous.map { !stamped && $0.role == message.role && time.timeIntervalSince($0.date) <= groupGap } ?? false
            let joinsNext = next.map { n in
                let gap = n.date.timeIntervalSince(time)
                return gap <= timeGap && n.role == message.role && gap <= groupGap
            } ?? false
            return MessageRow(message: message, isFirstInGroup: !joinsPrevious, isLastInGroup: !joinsNext, timestamp: stamped ? time : nil)
        }
    }

    /// 合并一条新到 / 更新的消息，按 seq 排序并去重。
    public static func merge(_ incoming: Message, into messages: [Message]) -> [Message] {
        var result = messages
        if let index = result.firstIndex(where: { $0.id == incoming.id || ($0.clientNonce != nil && $0.clientNonce == incoming.clientNonce) }) {
            result[index] = incoming
        } else {
            result.append(incoming)
        }
        return result.sorted { $0.seq < $1.seq }
    }
}
