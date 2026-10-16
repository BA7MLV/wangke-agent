import { useMemo } from 'react';
import { Button, Input, Switch } from '@heroui/react';
import { useSettings } from '../../store/settings';
import { useLiveLink } from '../../livelink/store';
import { Field, SectionCard, toast } from '../../ui';
import { copyText } from '../../utils/clipboard';

/**
 * 「实时」模块：让别的设备实时读这台设备上的内容。
 *
 * 整块只服务于一件事（把链接发出去看），所以从「填地址 → 开开关 → 复制链接」按操作顺序排列，
 * 而不是按配置项的抽象层次排列 —— 用户是照着这三步走的。
 */
export default function LiveModule() {
  const settings = useSettings();
  /** 实时链路 host 侧状态（开关 / 配对码 / 已连设备）。整 store 订阅即可：
      设置不是热更新界面，guest 进出带来的重渲染成本可忽略。 */
  const live = useLiveLink();

  /**
   * 复制 guest 链接。失败时把链接原文 toast 出来让人手抄。
   *
   * 走 utils/clipboard 而不是裸 navigator.clipboard：guest 链路的主场景就是
   * iPad 经局域网 http://IP 打开（非安全上下文里 navigator.clipboard 根本不存在），
   * 那里只有 execCommand 兜底能复制。
   *
   * 入口地址默认当前页面，但主机经常不是「来宾打得开的那一页」（数据在
   * localhost:5173 上，链接从那里复制出来 iPad 打不开）——所以留了 guestBase
   * 覆盖位，填一次部署好的应用地址，之后主机跑在哪链接都有效。
   */
  const liveGuestEntry = useMemo(() => {
    const base = live.guestBase.trim().replace(/\/+$/, '');
    return base || `${location.origin}${location.pathname}`;
  }, [live.guestBase]);
  const liveLink = useMemo(
    () => `${liveGuestEntry}#/live?relay=${encodeURIComponent(settings.liveRelay)}&pair=${live.code}`,
    [liveGuestEntry, settings.liveRelay, live.code],
  );

  const copyLiveLink = async () => {
    if (await copyText(liveLink)) toast.success('链接已复制，发给要实时观看的设备');
    else toast.warning(`复制失败，请手动复制：${liveLink}`);
  };

  /** 实时链路状态文案。error 优先于「未开启」：onerror 之后 onclose 会紧跟而来，
      那时 status 已被改写成 off，只有 error 还记着「为什么没连上」。 */
  const liveStatusText =
    live.status === 'online'
      ? `在线 · ${live.guests.length} 台设备已连接`
      : live.status === 'connecting'
        ? '连接中…'
        : live.error || (live.enabled ? '连接已断开' : '未开启');

  return (
    <SectionCard
      title="实时链路"
      subtitle="其他设备打开链接实时读你这台设备的内容（主机下线即断，不是云备份）"
      testId="card-livelink"
    >
      <Field
        label="中继地址"
        layout="row"
        hint="部署 cloudflare-worker/live-relay 后得到；只配对转发，不存任何数据"
        testId="field-live-relay"
      >
        <Input
          data-testid="live-relay"
          aria-label="实时链路中继地址"
          className="w-[22rem] max-w-full"
          value={settings.liveRelay}
          placeholder="wss://wangke-live-relay.xxx.workers.dev"
          onChange={(e) =>
            settings.update({
              liveRelay: e.target.value.trim(),
            })
          }
        />
      </Field>
      <Field label="开启共享" layout="row" testId="field-live-enable">
        <div className="flex flex-nowrap items-center gap-2">
          {/* 受控开关：enable() 被拒绝（没填中继地址）时 store 里 enabled 仍是 false，
              React 会把开关拨回「关」 */}
          <Switch
            data-testid="live-enable"
            aria-label="开启实时链路共享"
            isSelected={live.enabled}
            onChange={(on) => {
              if (on) live.enable();
              else live.disable();
            }}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
          <span className="text-muted" data-testid="live-status">
            {liveStatusText}
          </span>
        </div>
      </Field>
      {live.enabled && (
        <Field label="配对码" layout="row" hint="轮换后旧连接全部断开，需要重新配对" testId="field-live-code">
          <div className="flex flex-nowrap items-center gap-2">
            <Input
              data-testid="live-code"
              aria-label="配对码"
              className="w-[10rem]"
              value={live.code}
              readOnly
            />
            <Button
              variant="secondary"
              data-testid="live-copy-link"
              onPress={() => void copyLiveLink()}
            >
              复制链接
            </Button>
            <Button variant="tertiary" data-testid="live-rotate" onPress={() => live.rotate()}>
              轮换
            </Button>
          </div>
        </Field>
      )}
      {live.enabled && (
        <Field
          label="来宾入口地址"
          layout="row"
          hint="复制出来的链接用哪个地址打开。平时就在这个部署上开着共享，留空即可；主机跑在 localhost 或内网地址时，填一个来宾能访问的应用地址（比如你部署在 Cloudflare 上的那个）"
          testId="field-live-guest-base"
        >
          <Input
            data-testid="live-guest-base"
            aria-label="来宾入口地址"
            className="w-[22rem] max-w-full"
            value={live.guestBase}
            placeholder={`留空 = 当前地址（${location.origin}）`}
            onChange={(e) => live.setGuestBase(e.target.value.trim())}
          />
        </Field>
      )}
      {live.enabled && live.code && (
        <div
          className="py-2 text-xs break-all text-muted"
          data-testid="live-link-preview"
        >
          将复制：{liveLink}
        </div>
      )}
    </SectionCard>
  );
}
