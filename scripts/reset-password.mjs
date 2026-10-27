import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import argon2 from 'argon2';

async function readPasswords() {
  if (process.argv.slice(2).some(arg => arg !== '--stdin')) throw new Error('仅支持 --stdin 参数；请勿将密码放在命令行中。');
  if (process.argv.includes('--stdin')) {
    if (process.stdin.isTTY) throw new Error('--stdin 仅用于从标准输入安全传入两行密码。');
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 4096) throw new Error('输入过长。');
    }
    const lines = input.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length !== 2) throw new Error('标准输入必须为两行：新密码及确认密码。');
    return lines;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在交互终端运行；自动化时使用 --stdin 从标准输入传入两行密码。');
  // Readline still handles editing, but its output (including pasted passwords)
  // is suppressed. Prompts are written separately; secrets never reach stdout.
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  rl.on('SIGINT', cancel);
  try {
    process.stdout.write('新密码（12–256 位，输入不显示）：');
    const password = await rl.question('', { signal: controller.signal });
    process.stdout.write('\n再次输入新密码：');
    const confirmation = await rl.question('', { signal: controller.signal });
    return [password, confirmation];
  } finally {
    rl.close(); output.end(); process.stdout.write('\n');
  }
}

try {
  const [password, confirmation] = await readPasswords();
  if (password !== confirmation) throw new Error('两次密码不一致，未修改密码。');
  if (password.length < 12 || password.length > 256) throw new Error('密码必须为 12–256 位，未修改密码。');
  const dbPath = process.env.DB_PATH ?? path.join(process.env.DATA_DIR ?? path.resolve('data'), 'db/wangke.sqlite');
  // Never create an empty database or reopen bootstrap as part of recovery.
  const db = new Database(dbPath, { fileMustExist: true, timeout: 5000 });
  try {
    if (!db.prepare("SELECT 1 FROM app_state WHERE key='initialized'").get()) throw new Error('服务尚未初始化，请使用安装链接设置密码。');
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    db.transaction(() => {
      const users = db.prepare('SELECT u.id FROM users u JOIN password_credentials p ON p.user_id=u.id LIMIT 2').all();
      if (users.length !== 1) throw new Error('无法确定唯一管理员，未修改密码；请联系维护人员。');
      const id = users[0].id;
      const timestamp = new Date().toISOString();
      db.prepare('UPDATE password_credentials SET password_hash=? WHERE user_id=?').run(hash, id);
      db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(timestamp, id);
      db.prepare('UPDATE api_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(timestamp, id);
      db.prepare('DELETE FROM device_pairings WHERE owner_id=?').run(id);
      db.prepare('DELETE FROM webauthn_challenges WHERE user_id=? OR user_id IS NULL').run(id);
    }).immediate();
    console.log('密码已重设，所有旧会话、设备令牌及配对码已撤销。课程、文件和 Passkey 保持不变，请使用新密码登录。');
  } finally { db.close(); }
} catch (error) {
  console.error(error?.name === 'AbortError' ? '已取消，未修改密码。' : `重设失败：${error.message}`);
  process.exitCode = 1;
}
