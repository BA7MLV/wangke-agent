import { parseSkillMarkdown, type SkillFile } from './types';
import gongwenWriting from './builtin/gongwen-writing/SKILL.md?raw';
import gongwenFormat from './builtin/gongwen-format/SKILL.md?raw';
import gbt9704Style from './builtin/gongwen-format/references/gbt9704-style.md?raw';
import subjectMath from './builtin/subject-math/SKILL.md?raw';
import mathWriting from './builtin/subject-math/references/math-writing.md?raw';
import subjectCoding from './builtin/subject-coding/SKILL.md?raw';
import codingWriting from './builtin/subject-coding/references/coding-writing.md?raw';
import gongkaoXingce from './builtin/gongkao-xingce/SKILL.md?raw';
import gongkaoShenlun from './builtin/gongkao-shenlun/SKILL.md?raw';
import diagramming from './builtin/diagramming/SKILL.md?raw';

/** 内置 skill：标准 SKILL.md 文件（?raw 导入）+ 可选 references */
export interface BuiltinSkill extends SkillFile {
  refs?: { path: string; body: string }[];
}

const fromMd = (raw: string, refs?: BuiltinSkill['refs']): BuiltinSkill => {
  const s = parseSkillMarkdown('SKILL.md', raw);
  return refs?.length ? { ...s, refs } : s;
};

const ref = (path: string, body: string) => ({ path, body: body.trim() });

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  fromMd(gongwenWriting),
  fromMd(gongwenFormat, [ref('references/gbt9704-style.md', gbt9704Style)]),
  fromMd(subjectMath, [ref('references/math-writing.md', mathWriting)]),
  fromMd(subjectCoding, [ref('references/coding-writing.md', codingWriting)]),
  fromMd(gongkaoXingce),
  fromMd(gongkaoShenlun),
  // 出图规范：服务问答讲解与题目解析（讲义走公文 IR，不渲染图表围栏）
  fromMd(diagramming),
];
