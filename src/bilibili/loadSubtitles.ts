import type { BiliApiOptions } from './api';
import { fetchBiliSubtitleList, fetchSubtitleCues } from './dmview';
import type { BiliVideoSource } from './source';
import { buildBundle, defaultSelectedLangs, pickPrimary, type SubtitleBundle } from './subtitle';

/** 每次重新获取签名直链；不传语言时按当前视频默认选择中英字幕。失败与无字幕分开。 */
export async function loadBiliSubtitles(
  opts: BiliApiOptions,
  source: Pick<BiliVideoSource, 'aid' | 'cid'>,
  langs?: string[],
  onProgress?: (ratio: number) => void,
): Promise<SubtitleBundle> {
  if (langs?.length === 0) return { primary: null, tracks: [] };
  const available = await fetchBiliSubtitleList(opts, source.aid, source.cid);
  const wanted = langs ?? defaultSelectedLangs(available);
  const picked = available.filter((item) => wanted.includes(item.lan));
  const fetched: Parameters<typeof buildBundle>[0] = [];
  let firstError: unknown;
  for (let i = 0; i < picked.length; i++) {
    try {
      const cues = await fetchSubtitleCues(opts, picked[i].url);
      if (cues.length === 0) throw new Error('字幕文件没有可用内容');
      fetched.push({ item: picked[i], cues });
    } catch (error) {
      firstError ??= error;
    }
    onProgress?.((i + 1) / picked.length);
  }
  if (fetched.length === 0 && firstError) throw firstError;
  return buildBundle(fetched, pickPrimary(fetched.map(({ item }) => item)));
}
