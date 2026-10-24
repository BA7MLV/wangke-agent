---
name: 原题题库
description: 从 PDF、Word 等资料逐页提取原题，保留原图、题号、答案来源，使用现有 read/grep/edit 保存为普通 Markdown 题库，再用 present_quiz 做题和自动批改。不是根据知识点重新编题。
---

# 原题整理与作答

## 边界

- 只组合本轮已有 read、grep、edit、present_quiz、show_widget，不创建数据库、解析服务、后台任务或独立题库页。
- 题库 Markdown 是唯一真相源；聊天题卡是某次作答的快照。原文件不改动，题目不能只存在 HTML 源码、聊天正文或组件状态里。
- 用户明确要求提取时才开始，不在导入普通阅读材料时擅自请求模型或产生费用。
- 支持单选、多选、判断、填空、排序、配对、主观题与含独立小题的组合题。不得把其他题型改成单选、不得凑四项。解答、计算、证明、作文、代码、作图及未专门列出的题型用 freeform，typeLabel 保留原题型；有独立小题用 composite。不能因题型不同而丢进待整理区；只有原文确实缺失、无法辨读或需要用户确认的内容才待整理。

## 提取与保存

1. read 来源课程 info，取得真实 courseId、正文路径、题库路径和总页数；单课程可用 /courses/current/info。题库路径是 /courses/{id}/questions.md，单课程可用 /courses/current/questions.md。
2. read 题库路径检查是否已存在；若存在先读原文，继续整理时保留用户修改、覆盖范围和未完成项目，不用 create 覆盖。若题库本身是当前资料，直接读 /courses/current/material，raw=true。
3. 按页顺序 read 正文，start/end 一次最多 20 页，结合返回的截断提示缩小到每次 1~3 页；读到下一页确认跨页题、共用材料和选项完整。全卷提取不能只靠 grep 的几个命中。grep 用于找答案页、题号和解析，之后 read 对应位置核对题号。卷末答案、解析页须与原题对应，不能把例题解答配到另一题。
4. 保留原题题号和题干，不改写、不重新编题。题号写入 stem 开头。每题 source 写真实 courseId、name、原文起始 page；PDF 原文页码从 1 起，不猜印刷页码。
5. PDF 默认尝试 read images、crop="questions"、start/end（每次1~3页）自动按题号与文字坐标裁题，工具返回原页像素的稳定区域引用；写入对应题目的 images，不能自己编造坐标或引用。自动裁图尚未视觉核验，共用材料、跨页题、页首承接内容须额外保留相关页面图，避免截断。扫描件、无题号或复杂布局会明确回退整页；称为页面图，不冒充单题图。用户或视觉输入指出错误时，可用同一路径的 regions=[{page,x,y,width,height}] 修正，坐标是旋转后页面左上角起的千分比整数0~1000；也可通过原文框选截图核对。其他材料 read images 目录。不能用生成的 SVG/HTML 重画原图。目录只给引用与文本定位，不表示看过像素；无法辨读的内容必须待确认，不凭文本猜图题答案。
6. 答案来源必须明确：original=原卷/配套解析明确给出的答案（解析注明答案页）；verified=用户明确核验的答案；ai=用户要求推导后给出的 AI 参考答案；missing=未找到答案，answer=-1。不能把 AI 推导写成 original/verified。缺原文解析时 explanation 明说“原文未附解析”；自行补充的讲解标“AI 补充解析”，不冒充原文。
7. 用 edit 创建或增量追加题库，创建时与来源资料同文件夹。普通 Markdown 标题与说明写在数据块外；每批题目使用一个 quiz JSON 围栏，正文只保存这一份题目数据。示例（ID 和图片引用必须换为工具实际返回的值）：

````markdown
# 某试卷 · 题库

来源：某试卷.pdf
覆盖：已读取第 1–3 页；答案核对至第 20 页。尚未覆盖：第 4–19 页。

```quiz
{"questions":[{"stem":"1. 下列哪项符合原文？","options":["选项一","选项二","选项三","选项四"],"answer":1,"answerSource":"original","explanation":"原文答案 B，见第 20 页；原文未附解析。","source":{"courseId":"真实ID","name":"某试卷.pdf","page":1},"images":["#source-image/真实ID/page-1"]}]}
```

## 待整理题目

仅保留缺失内容或无法辨读的原题与原文链接，不因题型跳过。
````

8. 每一批读完及时 edit 落盘，更新覆盖范围、题数与待确认数量；接近轮次/上下文预算时先保存已核对部分并明确剩余范围，不声称全卷完成、不自行建立新任务。保存成功后 read 回查（offset/limit 按行分页），提供工具返回的题库文件链接。失败时不声称已保存。

## 题型数据

所有题保留 stem、explanation、source、answerSource。每个小题也保留这些字段。options 不含字母前缀；非选项题省略 options 或 []。数据约定：

- single（省略 type 时默认）：2~26 个原文选项，answer 为 0 起下标。
- multiple：options，answer 为无重复下标数组；全部选对且无多选才正确，不做未约定的部分分。
- boolean：不需要 options，answer 为 true/false。
- fill：answer 为每空字符串数组；可用 acceptedAnswers 为每空登记原文/用户核验的别名。只做首尾空白清理后的精确匹配，不猜大小写、公式等价或单位换算。涉及开放表达、复杂计算时用 freeform。缺答案用 answer=-1、blanks=原文空数，不臆造占位答案。
- ordering：options 为原始条目，answer 为排序后的完整下标数组。
- matching：options 为左列、matches 为右列，answer 为每个左项对应的右列下标数组；保留重复配对规则，不擅自要求一一对应。
- freeform：answer 为参考答案文字，typeLabel 标明原题型；可录入多行推导、证明、代码、Markdown。没有标准输入组件的特殊交互可附 presentation.html（见下）。不自动把文本相似视为正确。
- composite：parts 为同结构的小题数组（最多3层、每组最多50小题）；answer 为与 parts 每个答案一致的数组，防止两份冲突答案。任何小题缺答案时父题也标 missing、answer=-1，各小题仍保留自己的来源与状态。共用材料放父 stem/images。默认按完整题判定，不虚构原卷各小题分值或部分分。

示例：多选 {"type":"multiple","options":["甲","乙","丙"],"answer":[0,2]}；证明题 {"type":"freeform","typeLabel":"证明题","answer":"原文参考证明……"}。示例省略的通用字段仍须完整填写。

## 做题、批改与 HTML

- 有题库时使用 present_quiz(path=题库路径, offset=0, limit=5)，宿主读取文件最新版，不复制题干/答案到 questions 参数、不擅自修正或换序。用户要求继续时按上次回执的下一 offset 展示；单轮只展示一批，不能连调覆盖前面的未答题卡。重做从 offset=0 开始。
- 在题库自己的资料问答中 path=/courses/current/material；在来源资料问答中 path=/courses/current/questions.md。若当前入口没有 present_quiz，提供题库文件链接，引导在其资料问答中开始，不能虚构工具。
- 已核验的客观题由宿主本地判分，答后显示解析，作答随现有聊天保存；本机错题继续写入 /wrongbook.md，原图和来源一起保留。主观题/含主观小题的组合题提交后显示参考答案，学生点击“我已核对”才可按自评记录错题，标注 grading=self，不混入自动成绩。学生可点击“请求 AI 参考批改”走现有聊天，明确是参考建议，不修改确定成绩、不擅自登记自评。AI 参考答案与 missing 允许作答，但不判对错、不计分、不进错题本。用户核验后 edit 更新原题库，再新开练习；旧作答不重算。
- HTML 可承接拖拽、连线、作图等特殊题型输入：将遵守现有 show_widget(format="html") 规范的片段保存为该题 presentation={html:"…"}。宿主复用相同沙箱与主题；点击/键盘事件中调用 window.__wbw.setAnswerDraft(答案)，返回 Promise 只表示草稿已接收。答案格式必须符合上述 type（freeform 可传文字化/JSON字符串化的作图结果）。宿主显示草稿，学生仍需点可信题卡的“提交答案”，HTML 不能静默作答、给自评分或写错题。通过 window.__wbw.answerInput.answer/submitted 及 wbw:answerchange 恢复已提交状态，禁止在 HTML 中内嵌正确答案、解析或确定判分。原图由题卡 images 显示，不能 fetch 材料或编造资源 API；不放宽网络/文件权限。无法加载或操作时“使用标准作答界面”降级。不生成独立 HTML 刷题系统，普通题优先标准控件，show_widget 仍可辅助讲解。
