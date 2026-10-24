import XCTest
@testable import WangkeKit

final class MessageGroupingTests: XCTestCase {
    private func message(_ id: String, _ role: MessageRole, minutes: Double, seq: Int = 0) -> Message {
        let date = Date(timeIntervalSince1970: 1_800_000_000 + minutes * 60)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return Message(id: id, threadId: "t", clientNonce: id, seq: seq, role: role, kind: .text, content: id, createdAt: formatter.string(from: date), replyTo: nil)
    }

    func testConsecutiveMessagesFormOneGroupWithTailOnLast() {
        let rows = MessageGrouping.rows(for: [message("a", .user, minutes: 0), message("b", .user, minutes: 1), message("c", .assistant, minutes: 1)])
        XCTAssertEqual(rows.map(\.isFirstInGroup), [true, false, true])
        XCTAssertEqual(rows.map(\.isLastInGroup), [false, true, true])
    }

    func testTimestampAfterFifteenMinutesBreaksGroup() {
        let rows = MessageGrouping.rows(for: [message("a", .user, minutes: 0), message("b", .user, minutes: 5), message("c", .user, minutes: 30)])
        XCTAssertNotNil(rows[0].timestamp)
        XCTAssertNil(rows[1].timestamp)
        XCTAssertNotNil(rows[2].timestamp)
        XCTAssertTrue(rows[1].isLastInGroup)
        XCTAssertTrue(rows[2].isFirstInGroup)
    }

    func testMergeReplacesPendingByNonceAndSorts() {
        let pending = Message(id: "pending-x", threadId: "t", clientNonce: "x", seq: Int.max, role: .user, kind: .text, content: "hi", createdAt: "2026-10-24T10:00:00.000Z", replyTo: nil)
        let earlier = message("e", .assistant, minutes: 0, seq: 1)
        let accepted = Message(id: "real", threadId: "t", clientNonce: "x", seq: 2, role: .user, kind: .text, content: "hi", createdAt: "2026-10-24T10:00:00.000Z", replyTo: nil)
        let merged = MessageGrouping.merge(accepted, into: [pending, earlier])
        XCTAssertEqual(merged.map(\.id), ["e", "real"])
    }
}

final class DecodingTests: XCTestCase {
    func testDecodesThreadDetailFromServerShape() throws {
        let json = #"{"id":"t1","mode":"bot","title":null,"createdAt":"2026-10-24T10:00:00.000Z","updatedAt":"2026-10-24T10:00:00.000Z","participants":[],"approvals":[{"id":"a1","messageId":"m1","threadId":"t1","runId":null,"status":"pending","createdAt":"2026-10-24T10:00:00.000Z","resolvedAt":null,"resolution":null}],"messages":[{"id":"m1","threadId":"t1","clientNonce":null,"seq":1,"role":"assistant","kind":"approval","content":"可以删除临时文件吗？","replyTo":null,"createdAt":"2026-10-24T10:00:00.000Z"}]}"#
        let detail = try JSONDecoder().decode(ThreadDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.messages.first?.kind, .approval)
        XCTAssertEqual(detail.approvals?.first?.status, .pending)
        XCTAssertNotNil(detail.messages.first?.date)
    }

    func testDecodesTokenGrant() throws {
        let json = #"{"token":"abc","tokenId":"id","tokenType":"Bearer","expiresAt":"2027-01-22T00:00:00.000Z","user":{"id":"u","name":"Administrator"}}"#
        let grant = try JSONDecoder().decode(TokenGrant.self, from: Data(json.utf8))
        XCTAssertEqual(grant.user.name, "Administrator")
    }

    func testAttachmentInfo() {
        let info = AttachmentInfo.parse(#"{"fileId":"f","originalName":"讲义.pdf","sizeBytes":2048}"#)
        XCTAssertEqual(info?.originalName, "讲义.pdf")
    }
}

final class SSEParserTests: XCTestCase {
    func testParsesMessageEventsAndSkipsBrokenData() {
        let stream = """
        id: 3
        event: message.accepted
        data: {"message":{"id":"m","threadId":"t","clientNonce":null,"seq":1,"role":"assistant","kind":"text","content":"你好","replyTo":null,"createdAt":"2026-10-24T10:00:00.000Z"}}

        id: 4
        event: message.reaction
        data: {"messageId":"m","reaction":"👍","active":true}

        id: 5
        event: message.accepted
        data: {not json

        """
        let events = SSEParser.parse(stream)
        XCTAssertEqual(events.map(\.id), [3, 4])
        XCTAssertEqual(events.first?.message?.content, "你好")
        XCTAssertNil(events.last?.message)
    }
}

final class RequestTests: XCTestCase {
    func testBearerHeaderAndPath() throws {
        let client = APIClient(baseURL: URL(string: "https://agent.example.com/sub")!, token: "tok")
        let request = try client.makeRequest("/threads/a b", method: "POST", body: ["mode": "bot"])
        XCTAssertEqual(request.url?.absoluteString, "https://agent.example.com/sub/api/v1/threads/a%20b")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }
}
