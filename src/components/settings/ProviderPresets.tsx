import { Button } from '@heroui/react';
import type { Provider } from '../../store/settings';
import { matchesProviderPreset, PROVIDER_PRESETS, type ProviderPreset } from '../../store/providerPresets';
import { Sym } from '../../ui';

/** 本地单色标识，跟随深浅主题，不依赖打开设置时的外网请求。 */
export function ProviderLogo({ id }: { id: string }) {
  const image = `url(/provider-logos/${id}.svg)`;
  return <span
    aria-hidden="true"
    className="block size-8 bg-current"
    style={{ mask: `${image} center / contain no-repeat`, WebkitMask: `${image} center / contain no-repeat` }}
  />;
}

export default function ProviderPresets({ providers, onSelect, onCustom, onBack }: {
  providers: readonly Provider[];
  onSelect: (preset: ProviderPreset) => void;
  onCustom: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-5" data-testid="provider-presets">
      <Button variant="tertiary" className="self-start" data-testid="provider-presets-back" onPress={onBack}>
        <Sym name="arrow_back" />返回供应商列表
      </Button>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-balance">常用端点</h3>
        <span className="text-xs text-muted">预填地址与协议，填写密钥即可</span>
      </div>
      <div className="grid grid-cols-2 gap-3 min-[1100px]:grid-cols-3 max-[360px]:grid-cols-1">
        {PROVIDER_PRESETS.map((preset) => {
          const existing = providers.some((p) => matchesProviderPreset(p, preset));
          return (
            <Button
              key={preset.id}
              variant="ghost"
              className="h-auto min-h-52 w-full flex-col items-stretch justify-start gap-5 whitespace-normal rounded-2xl border border-border bg-background-secondary p-5 text-left text-foreground hover:bg-foreground/5 max-[640px]:min-h-44 max-[640px]:gap-4 max-[640px]:p-4"
              data-testid={`provider-preset-${preset.id}`}
              aria-label={`连接 ${preset.name}`}
              onPress={() => onSelect(preset)}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-background">
                  <ProviderLogo id={preset.id} />
                </span>
                {existing ? <span className="rounded-full bg-background px-2 py-1 text-xs font-medium text-muted">已添加</span>
                  : preset.recommended ? <span className="rounded-full bg-background px-2 py-1 text-xs font-medium text-muted">推荐</span> : null}
              </span>
              <span className="flex flex-col gap-2">
                <span className="text-base font-semibold text-balance max-[640px]:text-sm">{preset.name}</span>
                <span className="text-sm font-normal leading-relaxed text-pretty text-muted max-[640px]:text-xs">{preset.description}</span>
              </span>
            </Button>
          );
        })}
        <Button
          variant="ghost"
          className="h-auto min-h-52 w-full flex-col items-center justify-center gap-4 whitespace-normal rounded-2xl border border-dashed border-border bg-transparent p-5 text-center text-muted hover:bg-background-secondary max-[640px]:min-h-44 max-[640px]:p-4"
          data-testid="provider-preset-custom"
          onPress={onCustom}
        >
          <span className="grid size-12 place-items-center rounded-xl bg-background-secondary text-2xl text-foreground" aria-hidden="true"><Sym name="add" /></span>
          <span className="text-base font-semibold text-balance max-[640px]:text-sm">自定义提供商</span>
          <span className="text-sm font-normal leading-relaxed text-pretty max-[640px]:text-xs">任何兼容 OpenAI 或 Anthropic 的端点</span>
        </Button>
      </div>
    </div>
  );
}
