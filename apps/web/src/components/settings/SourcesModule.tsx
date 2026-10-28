import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { useSettings } from '../../store/settings';
import { Field, LoadingButton, SectionCard, Sym, toast } from '../../ui';
import { IconSwap } from '../motion';
import {
  getBiliBridgeVersion,
  isBiliBridgeAvailable,
  isBridgePostCapable,
  readBiliCookie,
} from '../../bilibili/transport';
import { probeBiliLogin } from '../../bilibili/api';

/**
 * 「内容源」模块：B 站导入的出口配置。
 *
 * 主路径（油猴桥）与备用出口（代理 + Cookie）分层：装了桥还能正常登录时，
 * 代理地址与 Cookie 都是纯噪音（请求自带浏览器 Cookie），所以收进折叠项里，
 * 常驻只留「桥的状态 + 登录态」这一行真正需要盯的信息。
 */
export default function SourcesModule() {
  const settings = useSettings();
  const [bridgeTick, setBridgeTick] = useState(0);
  /** 读取本机 Cookie 的进行中标记 */
  const [cookieReading, setCookieReading] = useState(false);
  /** 上一次「读取本机 Cookie」的结果说明（失败时写清是哪一种失败） */
  const [cookieNote, setCookieNote] = useState('');
  /** 说明是「问题」（红）还是「只是没法读明细，不影响用」（灰） */
  const [cookieNoteLevel, setCookieNoteLevel] = useState<'info' | 'warn'>('info');
  /** 「备用出口」的展开态：null = 跟着主路径（没桥就展开，有桥就收起） */
  const [advOverride, setAdvOverride] = useState<boolean | null>(null);
  /** 油猴桥视角的登录态（进设置探测一次；null = 探不到） */
  const [biliLogin, setBiliLogin] = useState<{ isLogin: boolean; uname?: string } | null>(null);

  const bridgeOk = isBiliBridgeAvailable();
  const advOpen = advOverride ?? !bridgeOk;

  // 装/卸脚本后「备用出口」回到自动态（有桥就收起）
  useEffect(() => {
    setAdvOverride(null);
  }, [bridgeTick]);

  // 探测一次 B 站登录态：只做展示，失败静默。
  // 依赖只跟 bridgeTick 走 —— 带 cookie 进依赖会在输框里每敲一个字发一次请求。
  const biliProbeRef = useRef({ proxy: '', cookie: '' });
  biliProbeRef.current = { proxy: settings.bilibiliProxy, cookie: settings.bilibiliCookie };
  useEffect(() => {
    if (!bridgeOk) {
      setBiliLogin(null);
      return;
    }
    let alive = true;
    void probeBiliLogin(biliProbeRef.current).then((r) => {
      if (alive) setBiliLogin(r);
    });
    return () => {
      alive = false;
    };
  }, [bridgeTick]);

  /**
   * 「读取本机 Cookie」：经油猴桥的 GM_cookie 读 .bilibili.com 全量 Cookie 并填入。
   * 失败的四种情况分开提示（否则「没读到」这一句话会把「脚本太旧」和「没登录」混在一起，无法对症）。
   */
  const readCookieFromBrowser = async () => {
    setCookieReading(true);
    try {
      const result = await readBiliCookie();
      if (result.status !== 'ok') {
        if (result.status === 'empty') {
          // 「读到 0 项」有两种截然不同的含义，靠桥出口自己问一次登录态来分辨：
          //   已登录 → 只是扩展不给 GM_cookie 明细，不影响任何功能，别吓唬用户；
          //   未登录 → 那确实该先去登录。
          const login = await probeBiliLogin({
            proxy: settings.bilibiliProxy,
            cookie: settings.bilibiliCookie,
          });
          setBiliLogin(login);
          const note = login?.isLogin
            ? `读到 0 项 Cookie，但油猴桥出口已登录${login.uname ? `（${login.uname}）` : ''}：说明扩展没提供 GM_cookie 明细。这不影响导入 —— 桥的请求本来就会带上浏览器自己的 Cookie，这个输入框留空即可`
            : '能读 Cookie，但本机没有 bilibili.com 的：先在浏览器里登录 B 站（无痕窗口、容器标签页读不到）';
          setCookieNoteLevel(login?.isLogin ? 'info' : 'warn');
          setCookieNote(note);
          if (login?.isLogin) toast.info(note);
          else toast.warning(note);
          return;
        }
        const note =
          result.status === 'no-bridge'
            ? '没检测到油猴桥：先点上面的「安装脚本」装好脚本（装完刷新本页），再点这个按钮'
            : result.status === 'old-bridge'
              ? `当前脚本是 ${result.version} 版，没有读 Cookie 的能力：浏览器里的脚本副本不会自动更新，请在左侧重新安装一次`
              : '脚本读不到 Cookie（浏览器/扩展不支持或未授权 GM_cookie：Safari 的 Userscripts 属于这种）。手动粘贴即可，或者直接留空 —— 装了油猴桥时请求会自动带上浏览器自己的 Cookie';
        setCookieNoteLevel('warn');
        setCookieNote(note);
        toast.warning(note);
        return;
      }
      settings.update({ bilibiliCookie: result.cookie });
      const hasSess = /(^|;\s*)SESSDATA=/.test(result.cookie);
      const note = hasSess
        ? `已读取 ${result.cookie.split(';').length} 项 Cookie（含 SESSDATA）`
        : '已读取本机 Cookie，但没发现 SESSDATA（可能未登录 B 站）';
      setCookieNoteLevel(hasSess ? 'info' : 'warn');
      setCookieNote(note);
      toast.success(note);
      const state = await probeBiliLogin({ proxy: settings.bilibiliProxy, cookie: result.cookie });
      setBiliLogin(state);
    } finally {
      setCookieReading(false);
    }
  };

  return (
    <SectionCard title="哔哩哔哩导入" testId="card-bilibili">
      {/* 常驻只有这一行：主路径（油猴桥）状态 + 登录态。备用出口收进下面的折叠项 */}
      <Field
        label="油猴桥（推荐）"
        layout="row"
        testId="field-bili-bridge"
      >
        <div
          className="flex flex-nowrap items-center gap-2"
          data-bridge-tick={bridgeTick}
          data-testid="bili-bridge-status"
        >
          <span className="min-w-0 flex-1 text-muted">
            {!bridgeOk ? (
              '未检测到油猴脚本'
            ) : (
              <>
                已连接 v{getBiliBridgeVersion()}
                {isBridgePostCapable() ? '' : '（版本过旧，读不到自带字幕）'} ·{' '}
                <span data-testid="bili-login-state">
                  {biliLogin == null
                    ? '登录态未确认'
                    : biliLogin.isLogin
                      ? `已登录${biliLogin.uname ? `：${biliLogin.uname}` : ''}`
                      : '未登录（B 站只给低清晰度）'}
                </span>
              </>
            )}
          </span>
          <Button
            variant={bridgeOk ? 'tertiary' : 'secondary'}
            data-testid="bili-bridge-install"
            onPress={() => window.open('/wangke-bili-bridge.user.js', '_blank')}
          >
            {bridgeOk ? '重装脚本' : '安装脚本'}
          </Button>
        </div>
      </Field>

      {/* 备用出口：收起时整块**不渲染**（不是 CSS 隐藏）—— 免得一屏文字都在说「不用填」，
          也避免键盘 Tab 进隐藏输入框（`e2e-bili-cookie` 按 DOM 里有没有 `bili-adv` 断言这条）。
          所以这里没有用 HeroUI 的 `Disclosure`：它的面板要挂载着才能量高度做展开动画，
          收起时内容仍在 DOM 里 —— 与上面这条不变量冲突。触发器用 HeroUI 的 `Button`。 */}
      <Button
        variant="ghost"
        className="h-auto min-h-12 w-full justify-start gap-1.5 px-0 text-sm font-normal text-muted"
        data-testid="bili-adv-toggle"
        aria-expanded={advOpen}
        aria-controls="bili-advanced-settings"
        onPress={() => setAdvOverride(!advOpen)}
      >
        <span className="min-w-0 flex-1 text-left text-sm">备用出口：代理地址 / B 站 Cookie</span>
        {/* icon-swap：折叠 / 展开两个箭头叠在同一格交叉淡入淡出 */}
        <IconSwap
          active={advOpen ? 'b' : 'a'}
          a={<Sym name="chevron_right" />}
          b={<Sym name="keyboard_arrow_down" />}
        />
      </Button>
      {advOpen && (
        <div data-testid="bili-adv" id="bili-advanced-settings">
          <Field
            label="代理地址"
            layout="row"
            testId="field-bili-proxy"
          >
            <Input
              data-testid="bili-proxy"
              aria-label="代理地址"
              className="w-[22rem] max-w-full"
              value={settings.bilibiliProxy}
              placeholder="https://bili-proxy.yourname.workers.dev"
              onChange={(e) =>
                settings.update({
                  bilibiliProxy: e.target.value.trim(),
                })
              }
            />
          </Field>
          <Field
            label="B 站 Cookie"
            testId="field-bili-cookie"
          >
            <div>
              <div className="flex flex-nowrap items-center gap-2">
                <Input
                  data-testid="bili-cookie"
                  aria-label="B 站 Cookie"
                  type="password"
                  placeholder="SESSDATA=...; bili_jct=..."
                  className="min-w-0 flex-1"
                  value={settings.bilibiliCookie}
                  onChange={(e) =>
                    settings.update({
                      bilibiliCookie: e.target.value.trim(),
                    })
                  }
                />
                <LoadingButton
                  variant="secondary"
                  data-testid="bili-cookie-read"
                  loading={cookieReading}
                  onPress={() => void readCookieFromBrowser()}
                >
                  读取本机 Cookie
                </LoadingButton>
              </div>
              {cookieNote && (
                <div
                  className={`mt-1.5 text-xs ${cookieNoteLevel === 'warn' ? 'text-danger' : 'text-muted'}`}
                  data-testid="bili-cookie-note"
                >
                  {cookieNote}
                </div>
              )}
            </div>
          </Field>
        </div>
      )}
    </SectionCard>
  );
}
