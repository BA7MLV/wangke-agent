#if canImport(SwiftUI)
import SwiftUI
import WangkeKit

/// 登录：图标、标题、一张分组表单、一个按钮。没有说明文字。
public struct LoginView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("wangke.server") private var server = ""
    @AppStorage("wangke.username") private var username = "Administrator"
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var shake = 0
    @FocusState private var field: Field?

    enum Field { case server, username, password }

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
                    .onSubmit { field = .username }
                    .padding(14)
                Divider().padding(.leading, 14)
                TextField("用户名", text: $username)
                    .textContentType(.username)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .autocorrectionDisabled()
                    .focused($field, equals: .username)
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
            .disabled(busy || server.isEmpty || username.isEmpty || password.isEmpty)

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
                try await model.signIn(server: server, username: username, password: password, deviceName: Self.deviceName)
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
