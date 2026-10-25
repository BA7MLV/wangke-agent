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
import interactiveExplainer from './builtin/interactive-explainer/SKILL.md?raw';
import interactiveApi from './builtin/interactive-explainer/references/runtime.md?raw';
import interactiveExamples from './builtin/interactive-explainer/references/examples.md?raw';
import libraryOrganizer from './builtin/library-organizer/SKILL.md?raw';
import courseHandout from './builtin/course-handout/SKILL.md?raw';
import handoutWriting from './builtin/course-handout/references/writing.md?raw';
import handoutMath from './builtin/course-handout/references/math-writing.md?raw';
import handoutCoding from './builtin/course-handout/references/coding-writing.md?raw';
import handoutXingce from './builtin/course-handout/references/gongkao-xingce.md?raw';
import handoutShenlun from './builtin/course-handout/references/gongkao-shenlun.md?raw';
import questionBank from './builtin/question-bank/SKILL.md?raw';

/** 内置 skill：标准 SKILL.md 文件（?raw 导入）+ 可选 references */
export interface BuiltinSkill extends SkillFile {
  refs?: { path: string; body: string }[];
}

const fromMd = (raw: string, refs?: BuiltinSkill['refs']): BuiltinSkill => {
  const s = parseSkillMarkdown('SKILL.md', raw);
  return refs?.length ? { ...s, refs } : s;
};

const ref = (path: string, body: string) => ({ path, body: body.trim() });

/** 仅旧 IR 流水线使用；保留原名称/数据库 ID，避免破坏启停与 pin/drop。 */
export const LEGACY_HANDOUT_SKILLS: BuiltinSkill[] = [
  fromMd(gongwenWriting),
  fromMd(gongwenFormat, [ref('references/gbt9704-style.md', gbt9704Style)]),
  fromMd(subjectMath, [ref('references/math-writing.md', mathWriting)]),
  fromMd(subjectCoding, [ref('references/coding-writing.md', codingWriting)]),
  fromMd(gongkaoXingce),
  fromMd(gongkaoShenlun),
];

/** 日常可选的五个任务入口；讲义专题通过参考文档按需加载。 */
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  // 会话可视化与文件导出是不同交付通道。
  fromMd(diagramming),
  fromMd(interactiveExplainer, [ref('references/runtime.md', interactiveApi), ref('references/examples.md', interactiveExamples)]),
  // 资料目录整理：方法与命名规范；真正的写入仍由 propose_folder_plan 的确认闸门把关
  fromMd(libraryOrganizer),
  fromMd(courseHandout, [
    ref('references/writing.md', handoutWriting),
    ref('references/math-writing.md', handoutMath),
    ref('references/coding-writing.md', handoutCoding),
    ref('references/gongkao-xingce.md', handoutXingce),
    ref('references/gongkao-shenlun.md', handoutShenlun),
  ]),
  fromMd(questionBank),
];
