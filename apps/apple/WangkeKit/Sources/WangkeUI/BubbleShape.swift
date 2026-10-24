#if canImport(SwiftUI)
import SwiftUI

/// iMessage 气泡：17pt 圆角，组内最后一条在底角带一条弯尾巴。
struct BubbleShape: Shape {
    var mine: Bool
    var tail: Bool

    func path(in rect: CGRect) -> Path {
        let radius: CGFloat = 17
        var path = Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
        guard tail else { return path }
        // 尾巴：从底边贴近角落的位置伸出，向外弯到气泡外 6pt，再弯回底边。
        var tailPath = Path()
        if mine {
            let x = rect.maxX
            let y = rect.maxY
            tailPath.move(to: CGPoint(x: x - 12, y: y))
            tailPath.addCurve(to: CGPoint(x: x + 6, y: y), control1: CGPoint(x: x - 2, y: y), control2: CGPoint(x: x + 2, y: y + 1))
            tailPath.addCurve(to: CGPoint(x: x, y: y - 14), control1: CGPoint(x: x + 1, y: y - 3), control2: CGPoint(x: x, y: y - 8))
            tailPath.closeSubpath()
        } else {
            let x = rect.minX
            let y = rect.maxY
            tailPath.move(to: CGPoint(x: x + 12, y: y))
            tailPath.addCurve(to: CGPoint(x: x - 6, y: y), control1: CGPoint(x: x + 2, y: y), control2: CGPoint(x: x - 2, y: y + 1))
            tailPath.addCurve(to: CGPoint(x: x, y: y - 14), control1: CGPoint(x: x - 1, y: y - 3), control2: CGPoint(x: x, y: y - 8))
            tailPath.closeSubpath()
        }
        path.addPath(tailPath)
        return path
    }
}
#endif
