import Foundation

/// 事件流里 App 关心的部分：带 message 的事件（新消息、消息更新）。其他事件只推进游标。
public struct ServerEvent: Sendable, Equatable {
    public let id: Int
    public let type: String
    public let message: Message?
}

public enum SSEParser {
    /// 解析 `text/event-stream`：以空行分块，每块读 id / event / data。
    /// 坏掉的 data 跳过但不推进游标，下次重连会从最后一个有效事件重新拿。
    public static func parse(_ text: String) -> [ServerEvent] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        var events: [ServerEvent] = []
        for block in normalized.components(separatedBy: "\n\n") {
            var id: Int?
            var type = ""
            var data = ""
            for line in block.split(separator: "\n", omittingEmptySubsequences: true) {
                if line.hasPrefix("id:") {
                    id = Int(line.dropFirst(3).trimmingCharacters(in: .whitespaces))
                } else if line.hasPrefix("event:") {
                    type = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                } else if line.hasPrefix("data:") {
                    data += (data.isEmpty ? "" : "\n") + line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                }
            }
            guard let id, !type.isEmpty, !data.isEmpty, let json = data.data(using: .utf8) else { continue }
            guard (try? JSONSerialization.jsonObject(with: json)) != nil else { continue }
            let message = (try? JSONDecoder().decode(MessageEnvelope.self, from: json))?.message
            events.append(ServerEvent(id: id, type: type, message: message))
        }
        return events
    }
}

struct MessageEnvelope: Decodable { let message: Message? }
