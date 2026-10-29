/**
 * Shared safe math expression parser for diagram plot curves.
 *
 * 为什么不用 `new Function` / eval：表达式字符串来自 LLM，而 LLM 的输入里混着
 * 课程字幕、用户提问、PDF 材料 —— 全是第三方可写入的文本。`new Function('x',
 * 'return ' + src)` 等于把一段可控代码塞进页面上下文，一句 `(()=>{fetch(...)})()`
 * 就够把用户的 Cookie 带出去。这里只认「数字 / x / 常量 / 运算符 / 白名单函数」，
 * 词法阶段就把其余标识符全部拒掉，语法阶段不收赋值、不收调用链、不收逗号表达式。
 *
 * 设计取向：
 * 1. **报错带字符位置**。`fn` 写错是模型最高频的失败（漏右括号、拼错函数名），
 *    回执里必须能指出「第几个字符附近出了什么问题」，模型才能一次改对。
 * 2. **隐式乘法**（`2x`、`2sin(x)`、`x(x+1)`）。教材里就这么写，模型也会照着写；
 *    不支持的话这是最高频的「明明对却报错」。
 * 3. **右结合 `^`**。数学惯例 2^3^2 = 2^9，与 JS 的 `**` 一致。
 */

/** 支持的函数表：名字 → 求值实现（参数个数在校验阶段查） */
const FUNCS: Record<string, { arity: number | [number, number]; fn: (...a: number[]) => number }> = {
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  sinh: { arity: 1, fn: Math.sinh },
  cosh: { arity: 1, fn: Math.cosh },
  tanh: { arity: 1, fn: Math.tanh },
  exp: { arity: 1, fn: Math.exp },
  ln: { arity: 1, fn: Math.log },
  log: { arity: [1, 2], fn: (a, b) => (b === undefined ? Math.log10(a) : Math.log(b) / Math.log(a)) },
  log2: { arity: 1, fn: Math.log2 },
  log10: { arity: 1, fn: Math.log10 },
  sqrt: { arity: 1, fn: Math.sqrt },
  cbrt: { arity: 1, fn: Math.cbrt },
  abs: { arity: 1, fn: Math.abs },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  round: { arity: 1, fn: Math.round },
  sign: { arity: 1, fn: Math.sign },
  min: { arity: [1, 8], fn: (...a) => Math.min(...a) },
  max: { arity: [1, 8], fn: (...a) => Math.max(...a) },
  pow: { arity: 2, fn: Math.pow },
  atan2: { arity: 2, fn: Math.atan2 },
  hypot: { arity: [1, 8], fn: (...a) => Math.hypot(...a) },
};

/** 常量表（大小写不敏感命中，但按惯例写小写） */
const CONSTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

export type CompiledExpr = (x: number) => number;

/** 词法 token：数字 / 标识符 / 运算符 / 括号 / 逗号 */
type Tok =
  | { t: 'num'; v: number; at: number }
  | { t: 'id'; v: string; at: number }
  | { t: 'op'; v: string; at: number }
  | { t: '('; at: number }
  | { t: ')'; at: number }
  | { t: ','; at: number };

const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '^', '%']);

/** 报错时给出「第几个字符附近」+ 源码片段，模型不用数字处补 */
function fail(src: string, at: number, msg: string): never {
  const from = Math.max(0, at - 12);
  const snippet = src.slice(from, at + 12).replace(/\s+/g, ' ');
  throw new Error(`表达式第 ${at + 1} 字符附近出错：${msg}（…${snippet}…）`);
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // 数字：整数 / 小数 / 科学计数法（1e-3）。前导点（.5）也收。
    if ((c >= '0' && c <= '9') || c === '.') {
      const m = /^\d*\.?\d*(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      const text = m && m[0] ? m[0] : '';
      if (!text || text === '.') fail(src, i, '数字写法不完整');
      const v = Number(text);
      if (!Number.isFinite(v)) fail(src, i, `数字超出范围：${text}`);
      toks.push({ t: 'num', v, at: i });
      i += text.length;
      continue;
    }
    // 标识符：字母 / 下划线开头，函数名与常量都走这里
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    if (OPERATOR_CHARS.has(c)) {
      toks.push({ t: 'op', v: c, at: i });
      i++;
      continue;
    }
    if (c === '(') {
      toks.push({ t: '(', at: i });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ t: ')', at: i });
      i++;
      continue;
    }
    if (c === ',') {
      toks.push({ t: ',', at: i });
      i++;
      continue;
    }
    fail(src, i, `不认识的字符「${c}」（只支持数字、x、+ - * / ^ %、括号与常用函数）`);
  }
  return toks;
}

/** AST 节点 */
type Node =
  | { k: 'num'; v: number }
  | { k: 'var' }
  | { k: 'unary'; op: string; a: Node }
  | { k: 'binary'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

/**
 * precedence climbing 解析。优先级（数值越大绑得越紧）：
 *   + -  <  * / %  <  一元负号  <  ^（右结合）  <  调用 / 括号
 *
 * `^` 高过一元负号是数学惯例：-x^2 = -(x^2)、2^-3 合法（右侧再放一个一元）。
 * 隐式乘法（2x、2sin(x)、(x+1)(x-1)）按乘除层级插入。
 */
const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t: Tok['t']) => {
    const tk = toks[p];
    if (!tk || tk.t !== t) return null;
    p++;
    return tk;
  };

  function parseExpr(minPrec: number): Node {
    let left = parseUnary();
    for (;;) {
      const tk = peek();
      if (!tk) break;
      if (tk.t === 'op') {
        const prec = PREC[tk.v];
        if (prec === undefined || prec < minPrec) break;
        p++;
        // ^ 右结合：右侧用同优先级递归；其余左结合（ prec+1 ）
        const right = parseExpr(tk.v === '^' ? prec : prec + 1);
        left = { k: 'binary', op: tk.v, a: left, b: right };
        continue;
      }
      // 隐式乘法：token 流里「值 × 值」相邻（2x、2sin(x)、x pi、2(x+1)）。
      // 只在乘除层级生效，且 ^ 的右侧不插（2^x y 有歧义，留给报错）。
      if ((tk.t === 'num' || tk.t === 'id' || tk.t === '(') && minPrec <= 2) {
        const right = parseUnary();
        left = { k: 'binary', op: '*', a: left, b: right };
        continue;
      }
      break;
    }
    return left;
  }

  function parseUnary(): Node {
    const tk = peek();
    if (tk && tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
      p++;
      // 负号的 operand 是**幂表达式**：-x^2 必须是 -(x^2)
      return { k: 'unary', op: tk.v, a: parsePower() };
    }
    return parsePower();
  }

  /** 幂表达式：primary 后面可跟一个右结合的 ^（右侧允许再带正负号：2^-3） */
  function parsePower(): Node {
    const base = parsePrimary();
    const tk = peek();
    if (tk && tk.t === 'op' && tk.v === '^') {
      p++;
      return { k: 'binary', op: '^', a: base, b: parseUnary() };
    }
    return base;
  }

  function parsePrimary(): Node {
    const tk = peek();
    if (!tk) fail(src, src.length, '表达式在这里断了（缺少内容）');
    if (tk.t === 'num') {
      p++;
      return { k: 'num', v: tk.v };
    }
    if (tk.t === '(') {
      p++;
      const inner = parseExpr(0);
      if (!eat(')')) fail(src, peek()?.at ?? src.length, '括号没有闭合（缺少 ））');
      return inner;
    }
    if (tk.t === 'id') {
      p++;
      const name = tk.v.toLowerCase();
      // 变量与常量优先：`x(x-1)` 是隐式乘法（x·(x-1)），不是「调用函数 x」。
      // 常数后跟括号同理（`pi(2)` 当 pi·2 收，虽然没人这么写）。
      if (name === 'x') return { k: 'var' };
      if (name in CONSTS) return { k: 'num', v: CONSTS[name] };
      // 函数调用：标识符紧跟 '('
      if (peek()?.t === '(') {
        const spec = FUNCS[name];
        if (!spec)
          fail(
            src,
            tk.at,
            `不认识的函数「${tk.v}」。可用：${Object.keys(FUNCS).join(' / ')}`,
          );
        p++;
        const args: Node[] = [];
        if (peek()?.t !== ')') {
          for (;;) {
            args.push(parseExpr(0));
            if (eat(',')) continue;
            break;
          }
        }
        if (!eat(')')) fail(src, peek()?.at ?? src.length, `函数 ${tk.v}( 的参数表缺少 ）`);
        const [lo, hi] = Array.isArray(spec.arity) ? spec.arity : [spec.arity, spec.arity];
        if (args.length < lo || args.length > hi)
          fail(src, tk.at, `${tk.v} 需要 ${lo === hi ? `${lo}` : `${lo}~${hi}`} 个参数（实得 ${args.length}）`);
        return { k: 'call', name, args };
      }
      fail(
        src,
        tk.at,
        `不认识的标识符「${tk.v}」。曲线里只能用 x、pi、e、tau 与函数（${Object.keys(FUNCS).slice(0, 8).join(' / ')} 等）`,
      );
    }
    fail(src, tk.at, '这里应该是一个数字、x 或函数');
  }

  const ast = parseExpr(0);
  if (p < toks.length) {
    const tk = toks[p];
    fail(src, tk.at, `表达式末尾多了内容（${tk.t === 'op' ? `运算符 ${tk.v}` : tk.t === 'id' ? tk.v : tk.t}）`);
  }
  return ast;
}

function evalNode(n: Node, x: number): number {
  switch (n.k) {
    case 'num':
      return n.v;
    case 'var':
      return x;
    case 'unary':
      return n.op === '-' ? -evalNode(n.a, x) : evalNode(n.a, x);
    case 'binary': {
      const a = evalNode(n.a, x);
      const b = evalNode(n.b, x);
      switch (n.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '%':
          return a % b;
        case '^':
          return a ** b;
      }
      return NaN;
    }
    case 'call':
      return FUNCS[n.name].fn(...n.args.map((a) => evalNode(a, x)));
  }
}

/**
 * 把一段表达式源码编译成 `x => y`。
 *
 * @throws 词法 / 语法 / 函数名 / 参数个数不合法 —— 错误信息带字符位置与源码片段
 */
export function compileExpression(src: string): CompiledExpr {
  const trimmed = src.trim();
  if (!trimmed) throw new Error('曲线 fn 不能为空：写 "x^2"、"sin(x)" 这样的表达式');
  const ast = parse(trimmed);
  // 位置信息在编译期用完即弃；运行期只做纯算术，没有任何动态求值入口
  return (x: number) => evalNode(ast, x);
}
