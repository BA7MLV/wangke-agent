import AssistantContent from '../components/AssistantContent';
import { Markdown } from '../components/markdown/Markdown';
import { MarkdownCode, MarkdownPre } from '../components/mermaid/markdown';
import { MarkdownTable } from '../components/MdTable';

/*
 * Bot 回复里的富内容：Markdown（标题、列表、链接、公式）、代码块与 mermaid 图、可排序表格，
 * 以及 ```html 围栏生成的可预览 artifact。全部复用课程问答已经在用的那一套渲染器，
 * 这里只是把它们接到气泡里。单独成文件是为了懒加载：纯文字聊天用不到这些代码。
 */
const components = { code: MarkdownCode, pre: MarkdownPre, table: MarkdownTable };

export default function BotRich({ content }: { content: string }) {
  return (
    <div className="imsg-rich">
      <AssistantContent content={content}>
        {(markdown) => <Markdown content={markdown} components={components} />}
      </AssistantContent>
    </div>
  );
}
