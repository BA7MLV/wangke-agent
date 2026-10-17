import { memo, useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export default memo(function MathFormula({ source, display }: { source: string; display: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(source, {
        displayMode: display,
        output: 'htmlAndMathml',
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
        // Each expression gets isolated macros; \gdef cannot affect another message.
        macros: {},
      });
    } catch {
      return null;
    }
  }, [source, display]);
  return html === null
    ? <code className="md-math-error" title="公式语法暂不支持，显示原始 LaTeX">{source}</code>
    : <span dangerouslySetInnerHTML={{ __html: html }} />;
});
