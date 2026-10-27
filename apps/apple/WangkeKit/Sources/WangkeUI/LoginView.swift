#if canImport(SwiftUI)
import SwiftUI
import WangkeKit

/// 单管理员密码登录，恢复帮助按需展开。
public struct LoginView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("wangke.server") private var server = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var shake = 0
    @FocusState private var field: Field?

    enum Field { case server, password }

    public init() {}

    public var body: some View {
        VStack(spacing: 20) {
            Spacer(minLength: 40)
            Image(systemName: "bubble.left.and.text.bubble.right.fill")
                .font(.system(size: 34))
                .foregroundStyle(.white)
                .frame(width: 72, height: 72)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text("登录").font(.title2.weight(.semibold))

            VStack(spacing: 0) {
                TextField("服务器地址", text: $server)
                    #if os(iOS)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    #endif
                    .autocorrectionDisabled()
                    .focused($field, equals: .server)
                    .submitLabel(.next)
                    .onSubmit { field = .password }
                    .padding(14)
                Divider().padding(.leading, 14)
                SecureField("密码", text: $password)
                    .textContentType(.password)
                    .focused($field, equals: .password)
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .padding(14)
            }
            .background(Color.groupedField, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .modifier(ShakeEffect(shakes: CGFloat(shake)))
            .animation(.default, value: shake)

            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
                    .transition(.opacity)
            }

            Button(action: submit) {
                Group {
                    if busy { ProgressView() } else { Text("登录").fontWeight(.semibold) }
                }
                .frame(maxWidth: .infinity, minHeight: 28)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(busy || server.isEmpty || password.isEmpty)

            DisclosureGroup("忘记密码？") {
                Text("可在浏览器打开服务器地址，使用已绑定的 Passkey 登录。没有可用的 Passkey 时，请联系服务器管理员，按照网页登录页的恢复说明在服务器终端重设密码。课程和文件会保留，旧设备登录会失效。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
            }
            .font(.footnote)

            Spacer()
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: 380)
        .frame(maxWidth: .infinity)
        .onAppear { field = server.isEmpty ? .server : .password }
    }

    private func submit() {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                try await model.signIn(server: server, password: password, deviceName: Self.deviceName)
                password = ""
            } catch {
                withAnimation { self.error = error.localizedDescription }
                shake += 1
            }
            busy = false
        }
    }

    private static var deviceName: String {
        #if os(iOS)
        UIDevice.current.name
        #else
        Host.current().localizedName ?? "Mac"
        #endif
    }
}

/// 出错时表单左右抖一下。
struct ShakeEffect: GeometryEffect {
    var shakes: CGFloat
    var animatableData: CGFloat {
        get { shakes }
        set { shakes = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 6 * sin(shakes * .pi * 4), y: 0))
    }
}

extension Color {
    static var groupedField: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemGroupedBackground)
        #else
        Color(nsColor: .controlBackgroundColor)
        #endif
    }
}
#endif
