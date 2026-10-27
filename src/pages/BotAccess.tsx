import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, Input, Label, Spinner, TextField } from '@heroui/react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { Sym } from '../ui';
import { serverClient, ServerApiError } from '../api/serverClient';

/* 登录 / 初始化表单：从 BotWorkspace.tsx 原样搬出（云端模式下由 cloud/Gate 先挡住，这里只在本机 /bot 路由用到）。 */

export function passkeyError(error: unknown, action: '登录' | '注册') {
  if (error instanceof ServerApiError && error.code === 'webauthn_not_configured') return 'Passkey 当前不可用';
  if ((error instanceof DOMException || error instanceof Error) && error.name === 'NotAllowedError') return `Passkey ${action}已取消`;
  return `Passkey ${action}失败，请稍后重试`;
}

const errorText: Record<string, string> = {
  invalid_credentials: '密码不对',
  invalid_or_expired_bootstrap_secret: '安装 secret 无效或已过期',
  admin_password_must_be_12_to_256_characters: '密码至少 12 位',
  bootstrap_closed: '已经初始化过了，请直接登录',
};

export default function AccessForm({ initialized, onDone }: { initialized: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const secretFileRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
       if (!initialized) await serverClient.bootstrapInitialize(password, secret);
       else await serverClient.login(password);
      onDone();
    } catch (e) {
      setError(e instanceof ServerApiError ? errorText[e.code] ?? e.code : '连不上服务');
    } finally {
      setBusy(false);
    }
  };

  const passkeyLogin = async () => {
    if (!browserSupportsWebAuthn()) {
      setError('这个浏览器不支持 Passkey');
      return;
    }
    setPasskeyBusy(true);
    setError('');
    try {
      const optionsJSON = await serverClient.passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON });
      await serverClient.passkeyLoginVerify(response);
      onDone();
    } catch (e) {
      setError(passkeyError(e, '登录'));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const readSecret = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setSecret((await file.text()).trim());
    event.target.value = '';
  };

  return (
    <div className="bot-access">
      <form className="bot-access__form" onSubmit={submit} data-shake={error ? 'true' : undefined} key={error}>
        <div className="bot-access__icon" aria-hidden="true"><Sym name="smart_toy" /></div>
        <h2 className="bot-access__title">{initialized ? '登录' : '创建管理员'}</h2>

        <div className="bot-access__group">
           {!initialized ? (
             <>
               <TextField fullWidth>
                <Label className="sr-only">安装 secret</Label>
                <div className="bot-access__secret">
                  <Input type="password" placeholder="安装 secret" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" required />
                  <Button type="button" isIconOnly size="sm" variant="tertiary" aria-label="从文件读取 secret" onPress={() => secretFileRef.current?.click()}>
                    <Sym name={secret ? 'check' : 'upload'} />
                  </Button>
                </div>
              </TextField>
              <input ref={secretFileRef} className="bot-hidden-file" type="file" accept=".txt,.env" aria-label="从文件读取 secret" onChange={readSecret} />
            </>
           ) : null}
          <TextField fullWidth>
            <Label className="sr-only">密码</Label>
            <Input
              type="password"
              placeholder={initialized ? '密码' : '密码（至少 12 位）'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={initialized ? 'current-password' : 'new-password'}
              required
            />
          </TextField>
        </div>

        {error && <p className="bot-access__error" role="alert">{error}</p>}

        <Button type="submit" variant="primary" fullWidth isDisabled={busy || passkeyBusy}>
          {busy ? <Spinner size="sm" color="current" /> : initialized ? '登录' : '继续'}
        </Button>
        {initialized && (
          <Button type="button" variant="tertiary" fullWidth onPress={() => void passkeyLogin()} isDisabled={busy || passkeyBusy}>
            {passkeyBusy ? <Spinner size="sm" color="current" /> : <Sym name="key" />}
            使用 Passkey
          </Button>
        )}
      </form>
    </div>
  );
}
