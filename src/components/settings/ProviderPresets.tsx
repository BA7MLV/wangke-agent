import { Button, ComboBox, Input, Label, ListBox } from '@heroui/react';
import { Fragment, type ReactNode } from 'react';
import type { Provider } from '../../store/settings';
import { getProviderPresets, matchesProviderPreset, PROVIDER_PRESETS, type ProviderPreset } from '../../store/providerPresets';
import { useModelMetaRevision } from '../../utils/useModelMeta';
import { Sym } from '../../ui';

/** 本地单色标识，跟随深浅主题，不依赖打开设置时的外网请求。 */
const BUNDLED_PROVIDER_LOGOS = new Set(['openai', 'deepseek', 'openrouter', 'anthropic', 'siliconflow-cn', 'google', 'vercel']);
const FEATURED_PROVIDER_IDS = ['siliconflow-cn', 'typesafe'];

export function ProviderLogo({ id }: { id: string }) {
  if (id === 'typesafe') return <Sym name="account_tree" className="size-8" />;
  // models.dev 会动态带来远多于项目内置 SVG 的供应商；动态项用稳定的本地图标兜底，
  // 不让一个缺失的 mask 图片把整块供应商卡片渲染成空白。
  if (!BUNDLED_PROVIDER_LOGOS.has(id)) return <Sym name="dns" />;
  const image = `url(/provider-logos/${id}.svg)`;
  return <span
    aria-hidden="true"
    className="block size-8 bg-current"
    style={{ mask: `${image} center / contain no-repeat`, WebkitMask: `${image} center / contain no-repeat` }}
  />;
}

export default function ProviderPresets({ providers, onSelect, onCustom, renderProvider }: {
  providers: readonly Provider[];
  onSelect: (preset: ProviderPreset) => void;
  onCustom: () => void;
  renderProvider: (provider: Provider) => ReactNode;
}) {
  useModelMetaRevision();
  const presets = getProviderPresets();
  const featured = FEATURED_PROVIDER_IDS.map(id => {
    const fallback = PROVIDER_PRESETS.find(item => item.id === id)!;
    const preset = presets.find(item => item.id === id) ?? presets.find(item => matchesProviderPreset(item, fallback)) ?? fallback;
    return { preset, provider: providers.find(item => matchesProviderPreset(item, preset)) };
  });
  const featuredProviderIds = new Set(featured.map(item => item.provider?.id));
  return (
    <div className="flex flex-col gap-5" data-testid="provider-presets">
      <div className="grid grid-cols-3 gap-4 max-[640px]:gap-1.5" data-testid="provider-overview-grid">
        <Button
          variant="ghost"
          className="h-auto min-h-[218px] w-full flex-col items-center justify-center gap-4 whitespace-normal rounded-2xl border border-dashed border-border bg-transparent p-5 text-center text-muted hover:bg-background-secondary max-[640px]:min-h-[150px] max-[640px]:gap-2 max-[640px]:p-2"
          data-testid="provider-add-card"
          aria-label="自定义添加"
          onPress={onCustom}
        >
          <span className="grid size-16 place-items-center rounded-2xl bg-background-secondary text-3xl text-foreground shadow-sm max-[640px]:size-9 max-[640px]:rounded-xl max-[640px]:text-lg" aria-hidden="true"><Sym name="add" /></span>
          <span className="text-lg font-semibold text-foreground max-[640px]:text-xs">自定义</span>
          <span className="text-sm font-normal leading-relaxed text-pretty max-[640px]:text-[10px]">填写 API 地址与密钥</span>
        </Button>
        {featured.map(({ preset, provider }) => (
          <Fragment key={preset.id}>
            {provider ? renderProvider(provider) : (
              <Button
                variant="ghost"
                className="h-auto min-h-[218px] w-full flex-col items-stretch justify-start gap-5 whitespace-normal rounded-2xl border border-border/80 bg-background-secondary p-5 text-left text-foreground hover:bg-foreground/5 max-[640px]:min-h-[150px] max-[640px]:gap-2.5 max-[640px]:p-2.5"
                data-testid={`provider-preset-${preset.id}`}
                aria-label={`连接 ${preset.name}`}
                onPress={() => onSelect(preset)}
              >
                <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-background shadow-sm max-[640px]:size-9 max-[640px]:rounded-xl">
                  <ProviderLogo id={preset.id} />
                </span>
                <span className="flex flex-1 flex-col justify-end gap-1">
                  <span className="text-lg font-semibold text-balance max-[640px]:text-xs">{preset.name}</span>
                  <span className="text-sm font-normal leading-relaxed text-pretty text-muted max-[640px]:text-[10px]">{preset.description}</span>
                </span>
              </Button>
            )}
          </Fragment>
        ))}
        {providers.filter(provider => !featuredProviderIds.has(provider.id)).map(provider => <Fragment key={provider.id}>{renderProvider(provider)}</Fragment>)}
      </div>
      <ComboBox fullWidth menuTrigger="focus" defaultItems={presets} defaultFilter={(text, query) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())}
        onSelectionChange={key => { const preset = presets.find(item => item.id === key); if (preset) onSelect(preset); }}>
        <Label>常用端点</Label>
        <ComboBox.InputGroup>
          <Input placeholder="搜索名称或 API 地址…" data-testid="provider-preset-search"
            onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }} />
          <ComboBox.Trigger aria-label="展开常用端点" />
        </ComboBox.InputGroup>
        <ComboBox.Popover>
          <ListBox<ProviderPreset> className="max-h-72 overflow-y-auto" renderEmptyState={() => <p className="p-3 text-sm text-muted">没有匹配的端点，可使用上方自定义添加。</p>}>
            {preset => <ListBox.Item id={preset.id} textValue={`${preset.name} ${preset.id} ${preset.baseUrl}`}>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span>{preset.name}</span>
                <span className="truncate text-xs text-muted">{preset.baseUrl}</span>
              </span>
              {providers.some(provider => matchesProviderPreset(provider, preset)) && <span className="text-xs text-muted">已添加</span>}
              <ListBox.ItemIndicator />
            </ListBox.Item>}
          </ListBox>
        </ComboBox.Popover>
      </ComboBox>
    </div>
  );
}
