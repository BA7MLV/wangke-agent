/**
 * 「初始化个人云端」的步骤与出错回退规则。纯函数，不碰 DOM，单测见 scripts/test-onboarding.mjs。
 *
 * 首次部署：welcome → key → account → name → models（可跳过）
 * 已初始化：login →（登录后带 #/setup 才进）models
 */
export type OnboardingStep = 'welcome' | 'key' | 'account' | 'name' | 'login' | 'models';

/** 首次部署的五步，用来画页码点。login 不在里面：它是单页。 */
export const SETUP_STEPS = ['welcome', 'key', 'account', 'name', 'models'] as const satisfies readonly OnboardingStep[];

/** 每一步配哪个 hairline 图形：拼好的云 → 保险库 → 挂锁 → 连起来的节点。 */
export const STEP_FIGURE = {
  welcome: 'settle',
  key: 'vault',
  account: 'padlock',
  name: 'phone',
  login: 'padlock',
  models: 'hub',
} as const satisfies Record<OnboardingStep, string>;

export type FigureName = (typeof STEP_FIGURE)[OnboardingStep];

/** 已登录的人来到这里只可能是 #/setup，直接进选模型。 */
export function initialStep({ initialized, authenticated }: { initialized: boolean; authenticated: boolean }): OnboardingStep {
  if (authenticated) return 'models';
  return initialized ? 'login' : 'welcome';
}

/** 返回键回到哪一步；没有上一步时为 null。 */
export function previousStep(step: OnboardingStep): OnboardingStep | null {
  if (step === 'key') return 'welcome';
  if (step === 'account') return 'key';
  // 账号已经建好，名字页不能退回去重建；选模型页可以回去改名字。
  if (step === 'models') return 'name';
  return null;
}

/** 创建失败时跳回能改正它的那一步：密钥错就回密钥页，已经被别人初始化了就去登录。 */
export function stepForError(step: OnboardingStep, code: string): OnboardingStep {
  if (code === 'invalid_or_expired_bootstrap_secret') return 'key';
  if (code === 'bootstrap_closed') return 'login';
  return step;
}

/** 已知错误码对应的文案 key（common:onboarding.errors.*）；未知的原样显示。 */
export const KNOWN_ERRORS = [
  'invalid_credentials',
  'invalid_or_expired_bootstrap_secret',
  'admin_password_must_be_12_to_256_characters',
  'bootstrap_closed',
  'passkey_verification_failed',
  'passkey_unavailable',
  'passkey_cancelled',
] as const;

export type KnownError = (typeof KNOWN_ERRORS)[number];

export function errorKey(code: string): KnownError | null {
  return (KNOWN_ERRORS as readonly string[]).includes(code) ? (code as KnownError) : null;
}

/** 页码点：第几步（从 1 开始），login 返回 0 表示不画。 */
export function stepIndex(step: OnboardingStep): number {
  return (SETUP_STEPS as readonly OnboardingStep[]).indexOf(step) + 1;
}
