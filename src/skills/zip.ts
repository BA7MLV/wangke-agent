import { unzipSync } from 'fflate';
import { parseSkillMarkdown, type SkillFile } from './types';

/** 解析结果：SKILL.md 正文 + references/ 下的文本参考文档 */
export interface ParsedSkillPackage {
  skill: SkillFile;
  refs: { path: string; body: string }[];
}

const TEXT_EXT = /\.(md|markdown|txt)$/i;

/**
 * 解析 skill zip 包（Agent Skills 目录结构的压缩形式）：
 * 定位 SKILL.md（根目录或单层目录下），收集同级 references/ 中的文本文件。
 * scripts/、assets/ 等在浏览器中无使用场景，忽略。
 */
export function parseSkillZip(bytes: Uint8Array, fallbackName: string): ParsedSkillPackage {
  const files = unzipSync(bytes);
  const decoder = new TextDecoder();
  const paths = Object.keys(files).filter((p) => !p.endsWith('/'));

  // 定位 SKILL.md：优先根目录，其次单层目录（如 my-skill/SKILL.md）
  const skillMdPath =
    paths.find((p) => /^SKILL\.md$/i.test(p)) ?? paths.find((p) => /^[^/]+\/SKILL\.md$/i.test(p));
  if (!skillMdPath) throw new Error('zip 中未找到 SKILL.md（应位于根目录或单层目录下）');

  const prefix = skillMdPath.slice(0, skillMdPath.length - 'SKILL.md'.length); // '' 或 'my-skill/'
  const skill = parseSkillMarkdown(fallbackName, decoder.decode(files[skillMdPath]));
  if (!skill.body) throw new Error('SKILL.md 正文为空');

  const refs = paths
    .filter((p) => p.startsWith(`${prefix}references/`) && TEXT_EXT.test(p))
    .map((p) => ({ path: p.slice(prefix.length), body: decoder.decode(files[p]).trim() }))
    .filter((r) => r.body);

  return { skill, refs };
}
