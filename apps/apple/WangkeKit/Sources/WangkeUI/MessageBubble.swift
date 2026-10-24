#if canImport(SwiftUI)
import SwiftUI
import WangkeKit

/// 一条消息。不同类型是同一个气泡的变体，没有标题、图标或类型标签。
struct MessageBubble: View {
    let row: MessageRow
    let approval: Approval?
    var onResolve: (Approval, Bool) -> Void = { _, _ in }
    var onReact: (Message) -> Void = { _ in }

    private var message: Message { row.message }
    private var mine: Bool { message.isMine }
    private var pending: Bool { message.id.hasPrefix("pending-") }

    var body: some View {
        VStack(spacing: 0) {
            if let timestamp = row.timestamp {
                Text(Self.stamp(timestamp))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.top, 14)
                    .padding(.bottom, 6)
                    .frame(maxWidth: .infinity)
            }
            HStack {
                if mine { Spacer(minLength: 56) }
                content
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .foregroundStyle(mine ? Color.white : Color.primary)
                    .background(BubbleShape(mine: mine, tail: row.isLastInGroup).fill(mine ? Color.accentColor : Color.bubbleGray))
                    .opacity(pending ? 0.7 : 1)
                    .onTapGesture(count: 2) { if !mine && !pending { onReact(message) } }
                if !mine { Spacer(minLength: 56) }
            }
            .padding(.top, row.isFirstInGroup ? 10 : 2)
        }
        .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
    }

    /// 今天只显示时分，昨天显示「昨天 时分」，更早显示日期。
    static func stamp(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "昨天 \(time)"
        }
        return "\(date.formatted(.dateTime.month().day())) \(time)"
    }

    @ViewBuilder
    private var content: some View {
        switch message.kind {
        case .progress:
            HStack(spacing: 8) {
                TypingDots()
                if !message.content.isEmpty {
                    Text(message.content).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        case .attachment:
            let info = AttachmentInfo.parse(message.content)
            HStack(spacing: 10) {
                Image(systemName: "doc.fill").font(.title3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(info?.originalName ?? "附件").font(.body.weight(.medium)).lineLimit(1)
                    if let size = info?.sizeBytes {
                        Text(Int64(size), format: .byteCount(style: .file)).font(.caption).opacity(0.7)
                    }
                }
            }
        case .approval, .question:
            VStack(alignment: .trailing, spacing: 10) {
                Text(message.content).frame(maxWidth: .infinity, alignment: .leading)
                if let approval {
                    switch approval.status {
                    case .pending:
                        HStack {
                            Button("拒绝", role: .destructive) { onResolve(approval, false) }
                                .buttonStyle(.bordered)
                            Button("批准") { onResolve(approval, true) }
                                .buttonStyle(.borderedProminent)
                        }
                        .controlSize(.small)
                    case .approved:
                        Label("已批准", systemImage: "checkmark").font(.caption).foregroundStyle(.secondary)
                    case .rejected:
                        Label("已拒绝", systemImage: "xmark").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        case .widget:
            // 和网页端一样不执行 widget，只当代码展示。
            ScrollView(.horizontal) {
                Text(String(message.content.prefix(1000))).font(.system(.footnote, design: .monospaced))
            }
            .frame(maxHeight: 200)
        case .text:
            Text(message.content).textSelection(.enabled)
        }
    }
}

/// 「正在输入」的三个点。
struct TypingDots: View {
    @State private var phase = 0.0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { index in
                Circle()
                    .frame(width: 7, height: 7)
                    .opacity(0.35 + 0.55 * max(0, sin((phase - Double(index) * 0.15) * .pi * 2)))
            }
        }
        .foregroundStyle(.secondary)
        .onAppear {
            withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) { phase = 1 }
        }
        .accessibilityLabel("正在处理")
    }
}

extension Color {
    /// iMessage 对方气泡的灰：浅色模式偏浅，深色模式偏深，跟系统一致。
    static var bubbleGray: Color {
        #if os(iOS)
        Color(uiColor: .systemGray5)
        #else
        Color(nsColor: .quaternaryLabelColor)
        #endif
    }
}
#endif
