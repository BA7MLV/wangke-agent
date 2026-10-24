import XCTest
@testable import WangkeKit

/// 对真实后端跑一遍：登录 → 建线程 → 发消息 → 事件流里收到它 → 退出后 token 失效。
/// 默认跳过；设置 WANGKE_E2E_URL 和 WANGKE_E2E_PASSWORD 后运行：
///   WANGKE_E2E_URL=http://127.0.0.1:3000 WANGKE_E2E_PASSWORD=… swift test --filter LiveServerTests
final class LiveServerTests: XCTestCase {
    func testLoginThreadMessageEventsLogout() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["WANGKE_E2E_URL"], let url = URL(string: raw), let password = env["WANGKE_E2E_PASSWORD"] else {
            throw XCTSkip("WANGKE_E2E_URL / WANGKE_E2E_PASSWORD not set")
        }
        let client = APIClient(baseURL: url)
        do {
            _ = try await client.login(username: "Administrator", password: "wrong-password", deviceName: "tests")
            XCTFail("wrong password should fail")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "invalid_credentials")
        }
        let grant = try await client.login(username: env["WANGKE_E2E_USER"] ?? "Administrator", password: password, deviceName: "WangkeKit tests")
        XCTAssertFalse(grant.token.isEmpty)
        let me = try await client.currentUser()
        XCTAssertEqual(me?.id, grant.user.id)

        let thread = try await client.createThread(title: "Swift E2E")
        let threads = try await client.threads()
        XCTAssertTrue(threads.contains { $0.id == thread.id })
        let sent = try await client.sendText("你好，来自 Swift", to: thread.id)
        XCTAssertEqual(sent.role, .user)
        let events = try await client.events(threadId: thread.id, after: 0)
        XCTAssertTrue(events.contains { $0.message?.id == sent.id })
        let detail = try await client.thread(thread.id)
        XCTAssertTrue(detail.messages.contains { $0.id == sent.id })

        await client.logout()
        let stale = APIClient(baseURL: url, token: grant.token)
        do {
            _ = try await stale.threads()
            XCTFail("revoked token should be rejected")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 401)
        }
    }
}
