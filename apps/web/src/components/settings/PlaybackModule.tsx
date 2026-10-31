import { useState } from 'react';
import { Button, Chip, Input } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../store/settings';
import { MAX_RATE, MIN_RATE, PRESET_RATES, formatRate, normalizeRate, sameRate } from '../../utils/rate';
import { Field, SectionCard, Sym, toast } from '../../ui';

/** 自定义倍速的一个档位：可删除 chip */
function RateChip({ rate, onDelete, removeLabel }: { rate: number; onDelete: () => void; removeLabel: string }) {
  const label = formatRate(rate);
  return (
    <Chip data-testid={`rate-chip-${label}`}>
      <Chip.Label>{label}</Chip.Label>
      <Button
        isIconOnly
        variant="tertiary"
        size="sm"
        aria-label={removeLabel}
        onPress={onDelete}
      >
        <Sym name="close" />
      </Button>
    </Chip>
  );
}

/**
 * 「播放」模块：播放器倍速档位。
 *
 * 单独成模块而不是塞进「外观」：倍速是播放行为，外观是显示偏好，
 * 两者改动频率与影响面都不同，混在一张卡里会让「改配色的人」顺手动到播放设置。
 */
export default function PlaybackModule() {
  const settings = useSettings();
  const { t } = useTranslation('settings');
  /** 自定义倍速的输入草稿（null = 输入框为空，「添加」按钮置灰） */
  const [rateDraft, setRateDraft] = useState<number | null>(null);

  /** 播放器倍速：内置档位之外再补几个常用档（0.25–4，存 settings.customRates） */
  const addCustomRate = () => {
    if (rateDraft == null || !Number.isFinite(rateDraft)) return;
    const next = normalizeRate(rateDraft);
    if ([...PRESET_RATES, ...settings.customRates].some((r) => sameRate(r, next))) {
      toast.info(t('playback.exists', { rate: formatRate(next) }));
    } else {
      settings.update({ customRates: [...settings.customRates, next].sort((a, b) => a - b) });
    }
    setRateDraft(null);
  };

  const removeCustomRate = (r: number) => {
    settings.update({ customRates: settings.customRates.filter((x) => !sameRate(x, r)) });
  };

  return (
    <SectionCard
      title={t('modules.playback')}
      testId="card-rates"
    >
      <Field label={t('playback.customRates')} testId="field-custom-rates">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2" data-testid="rate-chips">
            {settings.customRates.length === 0 ? (
              <span className="text-muted">{t('playback.empty')}</span>
            ) : (
              settings.customRates.map((r) => (
                <RateChip key={r} rate={r} onDelete={() => removeCustomRate(r)} removeLabel={t('playback.remove', { rate: formatRate(r) })} />
              ))
            )}
          </div>
          <div className="flex flex-nowrap items-center gap-2">
            <Input
              data-testid="rate-input"
              aria-label={t('playback.inputLabel')}
              type="number"
              min={MIN_RATE}
              max={MAX_RATE}
              step={0.25}
              placeholder="1.25"
              className="w-[140px] shrink"
              onChange={(e) => {
                const n = Number(e.target.value);
                setRateDraft(e.target.value.trim() === '' || !Number.isFinite(n) ? null : n);
              }}
            />
            <Button variant="secondary" data-testid="rate-add" isDisabled={rateDraft == null} onPress={addCustomRate}>
              {t('playback.add')}
            </Button>
          </div>
        </div>
      </Field>
    </SectionCard>
  );
}
