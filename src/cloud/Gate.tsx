import { lazy, Suspense, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, Input, Label, Spinner, TextField } from '@heroui/react';
import { startAuthentication } from '@simplewebauthn/browser';
import { useTranslation } from 'react-i18next';
import { serverClient, ServerApiError } from '../api/serverClient';
import { startCloud } from './sync';
import { useSettings } from '../store/settings';
import { FeedbackHost, Sym } from '../ui';
import LanguageSelect from '../components/LanguageSelect';
import { consumeBootstrapLink } from './bootstrapLink';
import OnboardingFigure, { loadFigures } from './onboarding/OnboardingFigure';
const ModelSetup = lazy(() => import('./onboarding/ModelSetup'));
import { errorKey, initialStep, previousStep, SETUP_STEPS, STEP_FIGURE, stepForError, stepIndex, type OnboardingStep } from './onboarding/flow';
import './onboarding/onboarding.css';

const App = lazy(() => import('../App'));

const TITLE = {
  welcome: 'onboarding.welcomeTitle',
  key: 'onboarding.keyTitle',
  account: 'onboarding.accountTitle',
  name: 'onboarding.nameTitle',
  login: 'onboarding.loginTitle',
  models: 'onboarding.models.title',
} as const satisfies Record<OnboardingStep, string>;

const ACTION = {
  welcome: 'onboarding.start',
  key: 'onboarding.continue',
  account: 'onboarding.create',
  name: 'onboarding.continue',
  login: 'onboarding.login',
} as const;

/**
 * 云端入口：首次部署走五步引导（欢迎 → 密钥 → 管理员 → 称呼 → 选模型），之后是单页登录。
 * 每一步只有一个标题、一张 2.5D 线稿和必要的输入框；说明交给布局和图形。
 */
export default function CloudGate({ initialized, authenticated, initialSecret = '', error: initialError = '' }: { initialized: boolean; authenticated: boolean; initialSecret?: string; error?: string }) {
  const { t } = useTranslation('common');
  const [ready, setReady] = useState(authenticated);
  const [setup, setSetup] = useState(!initialized || location.hash.startsWith('#/setup'));
  const [step, setStep] = useState<OnboardingStep>(() => initialStep({ initialized, authenticated }));
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState(() => useSettings.getState().userName);
  const [secret, setSecret] = useState(initialSecret);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [attempt, setAttempt] = useState(0);
  const [created, setCreated] = useState(initialized);
  const secretFile = useRef<HTMLInputElement>(null);

  // 欢迎页一出现就开始拉图形 chunk，下一步不用等。
  useEffect(() => { void loadFigures(); }, []);

  useEffect(() => {
    // Opening a fresh setup link in the same tab can be a hash-only navigation.
    const consume = () => {
      const nextSecret = consumeBootstrapLink(location, history);
      if (!created && nextSecret) { setSecret(nextSecret); setError(''); }
    };
    consume();
    window.addEventListener('hashchange', consume);
    return () => window.removeEventListener('hashchange', consume);
  }, [created]);

  const go = (next: OnboardingStep, dir: 'forward' | 'back' = 'forward') => {
    setDirection(dir);
    setError('');
    setStep(next);
  };

  const fail = (code: string) => {
    const key = errorKey(code);
    setError(key ? t(`onboarding.errors.${key}`) : code);
    setAttempt((n) => n + 1);
  };

  async function signIn(passkey = false) {
    setBusy(true); setError('');
    try {
      if (step === 'account') {
        await serverClient.bootstrapInitialize(password, secret);
        setCreated(true);
      }
      const response = passkey
        ? await serverClient.passkeyLoginVerify(await startAuthentication({ optionsJSON: await serverClient.passkeyLoginOptions() }))
        : await serverClient.login(password);
      await startCloud(response.user!.id);
      setPassword(''); setSecret(''); setReady(true);
      if (setup) go(step === 'account' ? 'name' : 'models');
    } catch (e) {
      const code = e instanceof ServerApiError ? (e.code === 'webauthn_not_configured' ? 'passkey_unavailable' : e.code)
        : passkey && (e as Error).name === 'NotAllowedError' ? 'passkey_cancelled'
          : (e as Error).message;
      const target = stepForError(step, code);
      if (target !== step) go(target, 'back');
      fail(code);
    } finally { setBusy(false); }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (step === 'welcome') go('key');
    else if (step === 'key') go('account');
    else if (step === 'name') {
      // 账号偏好：登录后 preferences 会把它同步到服务器，Bot 用它称呼你。
      useSettings.getState().update({ userName: nickname });
      go('models');
    } else void signIn();
  };

  const readSecret = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setSecret((await file.text()).trim());
    event.target.value = '';
  };

  if (ready && !setup) return <Suspense fallback={<div className="ob-loading" role="status"><Spinner aria-label={t('onboarding.loading')} /></div>}><App /></Suspense>;

  const back = previousStep(step);
  const index = stepIndex(step);
  const configure = step === 'models';
  const enter = () => { location.hash = '/'; setSetup(false); };
  const title = t(TITLE[step]);
  const figure = STEP_FIGURE[step];

  return <main className="ob" data-step={step}>
    <FeedbackHost />
    <header className="ob__bar">
      <div className="ob__bar-start">
        {back && <Button isIconOnly variant="ghost" aria-label={t('onboarding.back')} isDisabled={busy} onPress={() => go(back, 'back')}><Sym name="chevron_left" /></Button>}
      </div>
      {index > 0 && <div className="ob__dots" role="img" aria-label={t('onboarding.progress', { current: index, total: SETUP_STEPS.length })}>
        {SETUP_STEPS.map((s, i) => <span key={s} className="ob__dot" data-active={i + 1 === index || undefined} data-done={i + 1 < index || undefined} />)}
      </div>}
      <div className="ob__bar-end"><LanguageSelect /></div>
    </header>

    <div className="ob__scene" key={step} data-direction={direction}>
      <div className="ob__figure" data-compact={configure || undefined}>
        <div className="ob__floor" aria-hidden="true" />
        <OnboardingFigure name={figure} label={t(`onboarding.figure.${figure}`)} intensity={busy ? 0.9 : 0.5} />
      </div>
      <h1 className="ob__title">{title}</h1>

      {configure ? <section className="ob__configure">
        <Suspense fallback={<div className="ob-models__loading" role="status"><Spinner aria-label={t('onboarding.loading')} /></div>}>
          <ModelSetup onDone={enter} />
        </Suspense>
      </section> :
        <form className="ob__form" onSubmit={submit} noValidate={step === 'welcome'}>
          {step === 'key' && <div className="ob__group" data-shake={attempt || undefined} key={`key-${attempt}`}>
            <TextField fullWidth isRequired>
              <Label className="sr-only">{t('onboarding.keyLabel')}</Label>
              <div className="ob__field-row">
                <Input className="ob__input" type="password" placeholder="bootstrap-secret" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" autoFocus spellCheck={false} />
                <Button type="button" isIconOnly size="sm" variant="ghost" aria-label={t('onboarding.keyFromFile')} onPress={() => secretFile.current?.click()}>
                  <Sym name={secret ? 'check' : 'upload'} />
                </Button>
              </div>
            </TextField>
            <input ref={secretFile} hidden type="file" accept=".txt,.env,text/plain" tabIndex={-1} aria-hidden="true" onChange={readSecret} />
          </div>}

          {(step === 'account' || step === 'login') && <div className="ob__group" data-shake={attempt || undefined} key={`${step}-${attempt}`}>
            <TextField fullWidth isRequired>
              <Label className="sr-only">{t('onboarding.password')}</Label>
              <Input className="ob__input" type="password" placeholder={step === 'account' ? t('onboarding.newPasswordPlaceholder') : t('onboarding.password')} value={password} onChange={(e) => setPassword(e.target.value)} minLength={step === 'account' ? 12 : 1} autoComplete={step === 'account' ? 'new-password' : 'current-password'} autoFocus />
            </TextField>
          </div>}

          {step === 'name' && <div className="ob__group">
            <TextField fullWidth>
              <Label className="sr-only">{t('onboarding.nameLabel')}</Label>
              <Input className="ob__input" placeholder={t('onboarding.namePlaceholder')} value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={40} autoComplete="nickname" autoFocus enterKeyHint="next" />
            </TextField>
          </div>}

          <p className="ob__error" role="alert">{error}</p>

          <div className="ob__actions">
            <Button className="ob__primary" type="submit" size="lg" isDisabled={busy || (step === 'key' && !secret.trim()) || (step === 'account' && password.length < 12) || (step === 'login' && !password)}>
              {busy ? <><Spinner size="sm" color="current" />{t(step === 'account' ? 'onboarding.creating' : 'onboarding.signingIn')}</>
                : t(ACTION[step as keyof typeof ACTION])}
            </Button>
            {step === 'login' && <Button className="ob__secondary" variant="ghost" size="lg" isDisabled={busy} onPress={() => void signIn(true)}>{t('onboarding.passkey')}</Button>}
          </div>
        </form>}
    </div>
  </main>;
}
