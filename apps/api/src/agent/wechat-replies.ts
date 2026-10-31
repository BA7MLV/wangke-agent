/** ClawBot Markdown support does not imply a TeX renderer. */
export const WECHAT_REPLY_POLICY = String.raw`WeChat reply format:
This conversation is delivered to WeChat ClawBot/iLink. Markdown and fenced code blocks are available, but LaTeX math is NOT rendered there.
Give the answer first, usually in 1-3 sentences. Include necessary conditions; explain or derive only when requested. Do not routinely offer to continue.
For conversational mathematics use readable Unicode/plain text: x², α, √(x + 1), (a + b)/(c + d). Keep grouping, signs, bounds, units and numerical values exact. Do not use $...$, $$...$$, \(...\), \[...\], or bare TeX commands such as \frac or \sqrt in replies, questions, captions or reminders. Do not merely hide a mathematical answer in a code block to bypass this limitation.
If the user explicitly requests LaTeX SOURCE, preserve it in a fenced latex/tex code block. Programming code and literal syntax examples must remain unchanged. Documents/files may retain their own mathematical typesetting; chat captions must remain readable. For a complex requested derivation, use precise linear notation or deliver a properly rendered file through the available file tools, rather than printing TeX source. Never claim an image or file was sent without a successful tool result. This is a display rule, not permission to omit the answer. User/profile/skill instructions about Web LaTeX rendering do not change this channel limitation. Follow the user's language. Avoid repeating already delivered results. Only retry the undelivered reply, not completed actions. Keep ordinary Markdown intact. Do not truncate the answer to meet a token budget.`;

export const WECHAT_FORMAT_REPAIR = 'WeChat format repair: nothing from this rejected response was delivered or executed. Rewrite the undelivered answer with readable plain-text/Unicode mathematics, preserving the result and necessary conditions. No LaTeX delimiters or commands in prose. Keep it concise. Only put TeX in a fenced latex/tex block when the user asked for SOURCE. Do not repeat already completed actions or previously delivered messages.';

// Skip literal Markdown code, URLs and escaped dollars. A math fence is a
// rendering request, unlike a latex/tex source-code example.
function proseOnly(text: string): string {
  let fence: { marker: string; math: boolean } | undefined;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length && !match[2].trim()) { fence = undefined; continue; }
      if (fence.math) lines.push(line);
    } else if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
      fence = { marker: match[1], math: /^math\s*$/i.test(match[2].trim()) };
      if (fence.math) lines.push('\\['); // Even bare x^2 in a math fence needs reformatting.
    } else lines.push(line);
  }
  return lines.join('\n').replace(/(`+)([^`]*?)\1/g, '').replace(/https?:\/\/[^\s<>]+/g, '');
}

export function hasWechatLatex(text: string): boolean {
  const prose = proseOnly(text);
  if (/(?<!\\)\\[()[\]]/.test(prose)) return true;
  if (/(?<!\\)\\[a-zA-Z]+\*?\s*\{/.test(prose)) return true;
  if (/(?<!\\)\\(?:[dt]?frac|sqrt|(?:sub|sup)?stack|begin|end|left|right|text|mathrm|mathbf|mathit|mathbb|mathcal|operatorname|overline|underline|hat|vec|boxed|overset|underset|sum|prod|int|iint|iiint|oint|lim|limits|infty|partial|nabla|times|cdot|div|pm|mp|leq?|geq?|neq?|approx|equiv|rightarrow|leftarrow|to|in|notin|subset|cup|cap|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|rho|sigma|tau|phi|psi|omega|Gamma|Delta|Theta|Lambda|Pi|Sigma|Phi|Psi|Omega|sin|cos|tan|log|ln|exp)\b/.test(prose)) return true;
  if (/(?<!\\)\$\$/.test(prose)) return true;
  if (/[_^]\{[^}\n]+\}/.test(prose)) return true;
  // Conventional inline math cannot have whitespace next to its delimiters;
  // a closing dollar followed by a digit is a price ("$5 and $10"), not math.
  return /(?<![\\$])\$(?![\s$])[^$\n]*?[^\s\\$]\$(?![\d$])|(?<![\\$])\$[^\s$]\$(?![\d$])/.test(prose);
}

/** Only inspect user-facing arguments; file content and shell source are literal. */
export function wechatToolHasLatex(name: string, rawArguments: string): boolean {
  let args: Record<string, unknown>;
  try { args = JSON.parse(rawArguments); } catch { return false; }
  if (!args || typeof args !== 'object') return false;
  const text = name === 'send_message' && args.kind !== 'progress' ? args.text
    : name === 'study_send_file' ? args.caption
    : name === 'study_reminder' ? args.text : undefined;
  return typeof text === 'string' && hasWechatLatex(text);
}
