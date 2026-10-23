import { lazy, Suspense, useState } from 'react';
import { Button } from '@heroui/react';
import { startAuthentication } from '@simplewebauthn/browser';
import { serverClient } from '../api/serverClient';
import { startCloud } from './sync';
import CloudSettings from './Settings';
import { FeedbackHost } from '../ui';
import LanguageSelect from '../components/LanguageSelect';

const App = lazy(() => import('../App'));
export default function CloudGate({ initialized, authenticated, error: initialError = '' }: { initialized: boolean; authenticated: boolean; error?: string }) {
  const [ready, setReady] = useState(authenticated);
  const [setup, setSetup] = useState(!initialized || location.hash.startsWith('#/setup'));
  const [name, setName] = useState('Administrator');
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [created, setCreated] = useState(initialized);
  async function authenticate(passkey = false) {
    setBusy(true); setError('');
    try {
      if (!created) { await serverClient.bootstrapInitialize(password, secret, name); setCreated(true); }
      const response = passkey
        ? await serverClient.passkeyLoginVerify(await startAuthentication({ optionsJSON: await serverClient.passkeyLoginOptions() }))
        : await serverClient.login(name, password);
      await startCloud(response.user!.id);
      setPassword(''); setSecret(''); setReady(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (ready && !setup) return <Suspense fallback={<p role="status">正在载入课程…</p>}><App /></Suspense>;
  return <main className="min-h-dvh overflow-auto bg-background p-6 text-foreground">
    <FeedbackHost />
    <section className="mx-auto flex max-w-2xl flex-col gap-5 rounded-2xl bg-surface p-6 shadow-surface">
      <div className="flex justify-end"><LanguageSelect /></div>
      <h1 className="text-2xl font-semibold">{ready ? '配置个人云端' : created ? '登录网课云端' : '初始化个人云端'}</h1>
      {ready ? <><CloudSettings /><Button onPress={() => { location.hash = '/'; setSetup(false); }}>进入课程</Button></> :
        <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void authenticate(); }}>
          {!created && <label className="flex flex-col gap-2">一次性初始化密钥<input aria-label="一次性初始化密钥" className="input" type="password" value={secret} onChange={e => setSecret(e.target.value)} required autoComplete="off" /><span className="text-sm text-muted">从安装输出的 bootstrap-secret 文件读取。</span></label>}
          <label className="flex flex-col gap-2">账号<input className="input" value={name} onChange={e => setName(e.target.value)} required autoComplete="username" /></label>
          <label className="flex flex-col gap-2">密码<input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={created ? 1 : 12} autoComplete={created ? 'current-password' : 'new-password'} /></label>
          <Button type="submit" isDisabled={busy}>{busy ? '正在连接…' : created ? '登录' : '创建管理员'}</Button>
          {created && <Button variant="secondary" isDisabled={busy} onPress={() => void authenticate(true)}>使用 Passkey 登录</Button>}
        </form>}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </section>
  </main>;
}
