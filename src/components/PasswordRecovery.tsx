export default function PasswordRecovery() {
  return <details className="password-recovery">
    <summary>忘记密码？</summary>
    <div className="password-recovery__body">
      <p>如果已绑定 Passkey，可使用下方的 Passkey 入口登录。</p>
      <p>没有可用的 Passkey？请让服务器管理员在部署目录运行：</p>
      <pre><code>docker compose exec app node scripts/reset-password.mjs</code></pre>
      <p>使用额外 Compose 配置文件部署时，命令中需带上原来的 -f 参数；前后端分离部署将 app 替换为 api。</p>
      <p>非 Docker 部署，在项目目录运行：</p>
      <pre><code>npm run reset:password</code></pre>
      <p>需使用与服务相同的 DATA_DIR / DB_PATH 环境变量（脚本不自动读取 .env）。</p>
      <p>按提示输入两次新密码（12–256 位，输入时不显示）。重设会退出所有已登录设备并撤销设备令牌，课程、文件和已绑定的 Passkey 会保留。之后使用新密码重新登录即可。</p>
      <p>密码仅以不可逆哈希保存，无法查看原密码。请勿删除数据库或重新初始化。</p>
    </div>
  </details>;
}
