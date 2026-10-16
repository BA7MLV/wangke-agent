/* eslint-disable no-console */
// E2E：流式期间的输入 —— 排队 / 插入 / 模式切换 / 排队条 / 黑圆点尾巴 / 停止键。
//
// 背景：这一版之前，生成中输入框是禁用的、发送键被停止键顶掉，想补一句话只能先按停止，
// 而停止会把已经写了一半的回答作废。现在输入全程可用，投递分两条路（排队 / 插入），
// 对齐 Codex CLI 的 steer/queue 与 Claude Code 的排队语义。详见
// docs/plans/2026-10-16-流式期间输入-design.md。
//
// 模型流全部是页内假的（addInitScript 换掉 window.fetch，按队列逐请求喂步骤），
// 不依赖 SF_KEY、不花 API。「慢流」用 delayMs 拖出可操作的窗口。
//
// 覆盖点：
//   1. 生成中输入框**可打**、发送键**可用**、停止键与之并存（旧行为三者全反）
//   2. 流式尾巴是**黑色圆点**（不是默认 ▋）：圆形、深色、闪烁、写完即消失
//   3. Enter 排队：进排队条、本轮不发；本轮一结束自动续发（含落库）
//   4. Ctrl/⌘+Enter 插入：立刻打断本轮，旧回答标中断原因，新提问随即发出
//   5. 工具行「排队 / 插入」切换：切到插入后 Enter 即插入
//   6. 排队条四操作：编辑 / 删除 / 清空 / 立刻插入（闪电键）
//   7. 停止键：半截保留 + 「已停止生成」；**停止后队列照样续发**（Claude Code 语义）
//
// 用法：npm run preview &  然后 node scripts/e2e-chat-followup.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
/** 假 API 的地址：只要不是本页地址，`request()` 就会真的走 window.fetch（被我们换掉） */
const FAKE_API = 'https://fake.local/v1';

let failed = 0;
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  console.error(`❌ ${m}`);
  failed++;
};
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(`${name}\n   ${e.message}`);
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) =>
  fail(`页面异常：${e.message}\n${String(e.stack ?? '').split('\n').slice(1, 7).join('\n')}`),
);

// ── 设置 + 假模型流 ──────────────────────────────────────────────────────────
await page.addInitScript((baseUrl) => {
  localStorage.setItem(
    'wangke-settings',
    JSON.stringify({
      state: {
        providers: [
          { id: 'sf', name: '硅基流动', baseUrl, apiKey: 'test-key', serves: ['chat', 'vision', 'asr'], catalogId: 'siliconflow-cn' },
        ],
        llmModel: { providerId: 'sf', model: 'test-model' },
        visionModel: { providerId: 'sf', model: 'test-model' },
        asrModel: { providerId: 'sf', model: 'test-model' },
        contextWindow: 32768,
        agentRounds: 6,
      },
      version: 0,
    }),
  );

  const nativeFetch = window.fetch.bind(window);
  /** 每次 `/chat/completions` 从队列里取一步；取空了就回一句占位，免得挂住 */
  window.__LLM__ = { queue: [], calls: 0 };

  /**
   * ⚠️ **必须接 `init.signal`**：插入与停止都靠 abort 让读取端立刻收手。
   * 不接的话假流会自顾自吐完，那一轮既不会被打断、也不会标中断 ——
   * 症状是「按了插入，旧回答还在继续写」，被测代码明明是对的，红的却是测试。
   * 做法同 e2e-agent-guard.mjs 的同款注释：abort 时直接 error 掉这条流。
   */
  const abortError = () => new DOMException('The user aborted a request.', 'AbortError');

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/chat/completions')) return nativeFetch(input, init);
    const signal = init?.signal;
    if (signal?.aborted) throw abortError();
    window.__LLM__.calls++;
    const step = window.__LLM__.queue.shift() ?? { chunks: [{ content: '（队列空了）' }] };
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        const onAbort = () => {
          try {
            c.error(abortError());
          } catch {
            /* 已关闭 */
          }
        };
        signal?.addEventListener('abort', onAbort);
        try {
          for (const d of step.chunks) {
            if (signal?.aborted) return onAbort();
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`));
            if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
          }
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        } catch (e) {
          c.error(e);
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}, FAKE_API);

const pushSteps = (steps) =>
  page.evaluate((list) => {
    for (const step of list) window.__LLM__.queue.push(step);
  }, steps);

const dbHelper = (fn, arg) =>
  page.evaluate(
    async ([body, payload]) => {
      const run = new Function(`return (${body})`)();
      const req = indexedDB.open('wangke');
      const idb = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const out = await run(idb, payload);
      idb.close();
      return out;
    },
    [fn.toString(), arg ?? null],
  );

const waitForDbReady = async () => {
  const end = Date.now() + 20000;
  for (;;) {
    const ready = await page
      .evaluate(async () => {
        const req = indexedDB.open('wangke');
        const idb = await new Promise((res, rej) => {
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const names = [...idb.objectStoreNames];
        idb.close();
        return names.includes('chats') && names.includes('chatSessions');
      })
      .catch(() => false);
    if (ready) return;
    if (Date.now() > end) throw new Error('等待应用建库超时（chats / chatSessions 没有出现）');
    await new Promise((r) => setTimeout(r, 100));
  }
};

const reset = async () => {
  await page.goto(`${BASE}/#/chat`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
  await waitForDbReady();
  await dbHelper(async (idb) => {
    await new Promise((res, rej) => {
      const tx = idb.transaction(['chats', 'chatSessions'], 'readwrite');
      tx.objectStore('chats').clear();
      tx.objectStore('chatSessions').clear();
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    return true;
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
  await page.evaluate(() => {
    window.__LLM__.calls = 0;
    window.__LLM__.queue = [];
  });
};

/**
 * 主输入框。选择器四种形态都要收（HeroUI 把 className 落在 textarea 元素本身），
 * 同 e2e-chat-resume-fork.mjs / e2e-lazy-session.mjs 的踩坑注释。
 */
const composer = () =>
  page
    .locator(
      '.course-chat__input textarea, .course-chat__input input, textarea.course-chat__input, input.course-chat__input',
    )
    .first();

const typeInComposer = async (t) => {
  const field = composer();
  await field.click();
  await field.fill(t);
};

/** 打一句并按回车投递。`modifier` 传 'Control' 即 Ctrl+Enter（走另一种投递方式） */
const submit = async (t, modifier) => {
  await typeInComposer(t);
  await composer().press(modifier ? `${modifier}+Enter` : 'Enter');
};

const lastAssistantText = async () => {
  const els = page.locator('.course-chat__bubble--ai');
  if ((await els.count()) === 0) return '';
  return els.last().innerText();
};

const userMessageCount = async () => page.locator('.course-chat__message--user').count();

const llmCalls = async () => page.evaluate(() => window.__LLM__.calls);

/**
 * 等到**没有在生成**（停止键收起）。
 *
 * 每一轮新提问前都要等它：上一轮的收尾（finally → loading=false）与下一轮的发送
 * 之间有一个几百毫秒的缝，不等就发的话那句话会被当成「生成中投递」——
 * 排进队列而不是立刻发出，后面全场的步骤顺序都会错位。
 */
const waitIdle = async ({ timeout = 15000 } = {}) => {
  await waitFor(async () => (await page.locator('[data-testid="chat-stop"]').count()) === 0, {
    timeout,
    label: '空闲',
  });
};

const waitFor = async (fn, { timeout = 15000, step = 100, label = '' } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) {
      // 超时时打一份页面快照：这一族用例全是有状态流转的，光看「等待超时」
      // 分不清是卡在生成中、队列没续发、还是假流步骤被消费错了
      const snap = await page
        .evaluate(() => ({
          stop: !!document.querySelector('[data-testid="chat-stop"]'),
          queueItems: document.querySelectorAll('[data-testid="chat-queue-item"]').length,
          users: document.querySelectorAll('.course-chat__message--user').length,
          aiTails: [...document.querySelectorAll('.course-chat__bubble--ai')].map((e) => e.innerText.slice(-30)),
          calls: window.__LLM__.calls,
          pendingSteps: window.__LLM__.queue.length,
        }))
        .catch(() => '（快照失败）');
      throw new Error(`等待超时：${label}\n   页面快照：${JSON.stringify(snap)}`);
    }
    await new Promise((r) => setTimeout(r, step));
  }
};

/**
 * 这个颜色算「深色」吗（浅色主题下 --foreground 就是黑）。
 *
 * 两种形态都要收：HeroUI 的 token 是 oklch（`oklch(21.03% .0059 285.89)`），
 * Chrome 的 computed value 原样带回；万一日后换成 rgb 字面量也别瞎。
 * 解析不出来时返回 null —— 调用方决定是跳过还是报错，不在这里猜。
 */
const isDarkColor = (css) => {
  const oklch = css.match(/^oklch\(\s*([\d.]+)(%?)\s/);
  if (oklch) {
    const l = parseFloat(oklch[1]);
    const lightness = oklch[2] === '%' ? l / 100 : l;
    return lightness < 0.5;
  }
  const rgb = css.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 3 < 128;
  return null;
};

// ── ① 生成中的三件套：输入框可打 / 黑圆点 / 发送与停止并存 ──────────────────
await reset();
// 慢流：3 块 × 600ms ≈ 1.8s。这一轮必须**活过** ①②③ 三组断言
// （组内是十几次 DOM 往返，约几百毫秒到 1 秒）—— 提前结束的话，③ 的「排队」
// 就变成立刻发送，后面全场错位。
await pushSteps([{ chunks: [{ content: '正在' }, { content: '生成' }, { content: '中的回答' }], delayMs: 600 }]);
await submit('第一个问题');

await check('① 生成中输入框可打、发送键可用、停止键并存（旧行为三者全反）', async () => {
  const field = composer();
  await field.waitFor({ timeout: 10000 });
  // 等它真的开始吐字再断言（发送那一刻 loading 已置位，但内容可能还没到）
  await waitFor(async () => (await lastAssistantText()).includes('正在'), { label: '①首块上屏' });

  assert.equal(await field.isDisabled(), false, '生成中输入框不该被禁用（想补一句话只能先按停止是旧行为）');
  await typeInComposer('边生成边打');
  assert.equal(
    await page.locator('[data-testid="chat-send"]').isDisabled(),
    false,
    '有草稿时发送键在生成中也该可用（它按当前模式投递，不是坏按钮）',
  );
  assert.equal(await page.locator('[data-testid="chat-stop"]').count(), 1, '停止键该在');
  // 空草稿时发送键仍禁用（没话可发）
  await field.fill('');
  assert.equal(await page.locator('[data-testid="chat-send"]').isDisabled(), true, '空草稿发送键应当禁用');
  // 按键提示不再占用输入区底部
  assert.equal(await page.locator('[data-testid="chat-composer-note"]').count(), 0, '输入区底部不应显示提示行');
});

await check('② 流式尾巴是黑色圆点：圆形、深色、闪烁、跟着正文', async () => {
  const dot = page.locator('.course-chat__bubble--ai [data-testid="chat-stream-dot"]');
  await waitFor(async () => (await dot.count()) > 0, { timeout: 8000, label: '②黑圆点出现' });
  const style = await dot.last().evaluate((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return { bg: cs.backgroundColor, radius: cs.borderRadius, w: rect.width, h: rect.height, anim: cs.animationName };
  });
  assert.equal(style.radius, '50%', `圆点要是圆形，实际 border-radius=${style.radius}`);
  assert.ok(Math.abs(style.w - style.h) < 0.6 && style.w > 2, `圆点要正且别太小：${style.w}×${style.h}`);
  assert.equal(style.anim, 'course-chat-dot-blink', `圆点该有闪烁动画，实际 animation-name=${style.anim}`);
  // 「黑色」：与正文同色（--foreground），且确实是深色（浅色主题下即黑）
  const textColor = await page
    .locator('.course-chat__bubble--ai')
    .last()
    .evaluate((el) => getComputedStyle(el).color);
  assert.equal(style.bg, textColor, `圆点该与正文同色，实际 ${style.bg} vs ${textColor}`);
  const dark = isDarkColor(style.bg);
  assert.equal(dark, true, `圆点该是深色（浅色主题下的黑），实际 ${style.bg}`);
  // 位置：圆点落在正文流里（XMarkdown 把它插在最后一个文本 token 之后）
  assert.ok(
    await dot.last().evaluate((el) => !!el.closest('.course-chat__bubble--ai')),
    '圆点该挂在回答气泡里',
  );
});

// ── ③ Enter 排队 → 本轮答完自动续发 ────────────────────────────────────────
await check('③ Enter 排队：进排队条、本轮不发；答完自动续发', async () => {
  // 第二步现在就排进假流队列：等本轮一结束 drainQueue 就会请求它。
  // 必须赶在续发之前入队，否则那次请求会落到「（队列空了）」占位上，
  // 后面所有步骤的顺序都会被带偏。
  await pushSteps([{ chunks: [{ content: '排队句的回答' }] }]);
  const callsBefore = await llmCalls();

  await submit('排队第一句');
  // 排队条出现，内容就是刚打的那句
  await waitFor(async () => (await page.locator('[data-testid="chat-queue-item"]').count()) === 1, {
    label: '③排队条出现',
  });
  const queueInput = page.locator('[data-testid="chat-queue-input"]').first();
  assert.equal(await queueInput.inputValue(), '排队第一句', '排队条里该是刚投递的那句');
  // 主输入框草稿已清空（不清的话用户会以为没生效而再打一遍）
  assert.equal(await composer().inputValue(), '', '投递后主输入框该清空');

  // 关键：还没有发出第二次请求（这话要等这一轮答完）
  assert.equal(await llmCalls(), callsBefore, '排队不该立刻发起请求');

  // 本轮自己答完（没被排队影响）
  const first = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('中的回答') ? t : null;
  }, { label: '③本轮答完' });
  assert.ok(!first.includes('已停止生成'), '排队不该打断本轮');

  // 续发：第二条 user 消息出现，且真的打了一次请求。
  // ⚠️ 「user 消息上屏」与「请求发出」不是同一刻：send 先同步把两条消息插进视图，
  // 之后还有几次 await（建会话 / 读历史 / 拼 prompt）才轮到 fetch —— 中间有几十毫秒的缝。
  // 在这儿直接断言 calls 会撞上那道缝（实测红过一次），所以等它自己涨上来。
  await waitFor(async () => (await userMessageCount()) === 2, { timeout: 15000, label: '③第二条 user' });
  await waitFor(async () => (await llmCalls()) > callsBefore, { label: '③续发真的发出请求' });
  const second = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('排队句的回答') ? t : null;
  }, { label: '③排队句被回答' });
  assert.ok(second.includes('排队句的回答'), '排队的那句要被回答');
  // 队列已空、尾巴已消失
  assert.equal(await page.locator('[data-testid="chat-queue-item"]').count(), 0, '续发后队列该空');
  assert.equal(
    await page.locator('.course-chat__bubble--ai [data-testid="chat-stream-dot"]').count(),
    0,
    '写完后黑圆点该消失',
  );
  // 落库：排队那句成了真正的 user 行（队列只活在内存里，交出去这一刻才落库）
  const rows = await dbHelper(async (idb) => {
    const all = await new Promise((res, rej) => {
      const tx = idb.transaction('chats', 'readonly');
      const q = tx.objectStore('chats').getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    return all.map((r) => r.role + ':' + r.content);
  });
  assert.ok(rows.some((r) => r === 'user:排队第一句'), `库里该有排队那句，实际：${rows.join(' | ')}`);
});

// ── ④ Ctrl+Enter 插入：立刻打断本轮 ────────────────────────────────────────
await check('④ Ctrl+Enter 插入：打断本轮、旧回答标原因、新提问随即发出', async () => {
  await waitIdle();
  // 先给「插入后新开的那一轮」备好答案（插入是打断后立刻重发，请求马上就来）
  await pushSteps([
    { chunks: [{ content: '慢慢' }, { content: '说' }], delayMs: 500 },
    { chunks: [{ content: '插入后的新回答' }] },
  ]);
  await submit('第三个问题');
  await waitFor(async () => (await lastAssistantText()).includes('慢慢'), { label: '④慢流首块' });

  // 基准取在**插入前一刻**：这一轮自己的提问已经把计数 +1 了，再拿更早的基准
  // 等 +1，会在 steer 把计数推到 +2 之后永远等不到（时序竞态，实测红过）
  const usersBeforeSteer = await userMessageCount();
  await submit('插入这句', 'Control');

  // 新提问立刻上屏（不等本轮答完）
  await waitFor(async () => (await userMessageCount()) === usersBeforeSteer + 1, {
    timeout: 8000,
    label: '④插入后新 user',
  });
  // 旧回答被标中断，原因说的是「你发了一条新消息」而不是「已停止生成」
  const bar = page.locator('[data-testid="chat-interrupted"]');
  await waitFor(async () => (await bar.count()) > 0, { timeout: 8000, label: '④中断条出现' });
  const barText = await bar.first().innerText();
  assert.ok(barText.includes('你发了一条新消息'), `中断原因该说明是被新消息打断，实际：${barText}`);
  // 已流出的半截留着（这是插入与停止的共同底线：不白生成）。
  // ⚠️ 查**全部**回答气泡而不是最后一条：半截在被打断的那条里，它后面还跟着
  // 插入后新开的那条（最后一条是新回答，旧内容在倒数第二条）。
  const allAi = (await page.locator('.course-chat__bubble--ai').allInnerTexts()).join('\n');
  assert.ok(allAi.includes('慢慢'), `半截内容该保留，实际：${allAi.slice(-120)}`);
  // 新一轮正常开跑
  await waitFor(async () => (await lastAssistantText()).includes('插入后的新回答'), { label: '④新回答流入' });
});

// ── ⑤ 模式切换钮：切到插入后 Enter 即插入 ──────────────────────────────────
await check('⑤ 「排队 / 插入」切换：切到插入，Enter 就是插入', async () => {
  await waitIdle();
  await pushSteps([
    { chunks: [{ content: '切换' }, { content: '模式' }], delayMs: 500 },
    { chunks: [{ content: '插入模式下的回答' }] },
  ]);
  await submit('第四个问题');
  await waitFor(async () => (await lastAssistantText()).includes('切换'), { label: '⑤慢流首块' });

  // 默认是排队（选中态在排队那颗上）
  assert.equal(
    await page.locator('[data-testid="chat-send-mode-queue"]').getAttribute('data-selected'),
    'true',
    '默认模式该是排队',
  );
  await page.locator('[data-testid="chat-send-mode-steer"]').click();
  assert.equal(
    await page.locator('[data-testid="chat-send-mode-steer"]').getAttribute('data-selected'),
    'true',
    '点过之后选中该移到插入',
  );

  // 现在按 Enter = 插入（不再需要 Ctrl）：旧轮被打断、新提问立刻发出
  const usersBefore = await userMessageCount();
  await submit('按插入模式发送');
  await waitFor(async () => (await userMessageCount()) === usersBefore + 1, {
    timeout: 8000,
    label: '⑤插入后新 user',
  });
  await waitFor(async () => (await page.locator('[data-testid="chat-interrupted"]').count()) > 0, {
    timeout: 8000,
    label: '⑤中断条出现',
  });
  await waitFor(async () => (await lastAssistantText()).includes('插入模式下的回答'), { label: '⑤插入模式回答' });
});

// ── ⑥ 排队条四操作 ─────────────────────────────────────────────────────────
await check('⑥ 排队条：编辑 / 删除 / 清空 / 立刻插入', async () => {
  await waitIdle();
  await pushSteps([
    { chunks: [{ content: '队列' }, { content: '操作' }], delayMs: 500 },
    { chunks: [{ content: '立刻插入的回答' }] },
  ]);
  await submit('第五个问题');
  await waitFor(async () => (await lastAssistantText()).includes('队列'), { label: '⑥慢流首块' });
  // 把模式切回排队：⑤ 把它留在插入档上，而模式钮**只在生成中渲染** ——
  // 空闲时点不到（会干等 30s 超时），所以趁这一轮还在吐字时点。
  await page.locator('[data-testid="chat-send-mode-queue"]').click();
  assert.equal(
    await page.locator('[data-testid="chat-send-mode-queue"]').getAttribute('data-selected'),
    'true',
    '该切回排队模式',
  );

  // 编辑：改掉排队中的文字（改成空白 = 删掉，见 store 的 updateQueued）
  await submit('待编辑');
  await waitFor(async () => (await page.locator('[data-testid="chat-queue-item"]').count()) === 1, {
    label: '⑥待编辑入队',
  });
  await page.locator('[data-testid="chat-queue-input"]').first().fill('改过的文字');
  assert.equal(
    await page.locator('[data-testid="chat-queue-input"]').first().inputValue(),
    '改过的文字',
    '排队条该能编辑',
  );

  // 删除
  await page.locator('[data-testid="chat-queue-remove"]').first().click();
  await waitFor(async () => (await page.locator('[data-testid="chat-queue-item"]').count()) === 0, {
    label: '⑥删除后为空',
  });

  // 清空：排两条再一键清掉
  await submit('清空甲');
  await waitFor(async () => (await page.locator('[data-testid="chat-queue-item"]').count()) === 1, {
    label: '⑥清空甲入队',
  });
  await submit('清空乙');
  await waitFor(async () => (await page.locator('[data-testid="chat-queue-item"]').count()) === 2, {
    label: '⑥清空乙入队',
  });
  assert.ok(
    (await page.locator('[data-testid="chat-queue"]').innerText()).includes('排队中 · 2'),
    '条数该显示 2',
  );
  await page.locator('[data-testid="chat-queue-clear"]').click();
  await waitFor(async () => (await page.locator('[data-testid="chat-queue-item"]').count()) === 0, {
    label: '⑥清空后为空',
  });
  assert.equal(await page.locator('[data-testid="chat-queue"]').count(), 0, '清空后整条排队条该收起');

  // 立刻插入：排一条，点闪电键 → 出队 + 插入（本轮被打断，新提问立刻发出）
  const usersBefore = await userMessageCount();
  await submit('现在就发');
  await waitFor(async () => (await page.locator('[data-testid="chat-queue-item"]').count()) === 1, {
    label: '⑥现在就发入队',
  });
  await page.locator('[data-testid="chat-queue-send-now"]').first().click();
  await waitFor(async () => (await page.locator('[data-testid="chat-queue-item"]').count()) === 0, {
    timeout: 8000,
    label: '⑥立刻插入出队',
  });
  await waitFor(async () => (await userMessageCount()) === usersBefore + 1, {
    timeout: 8000,
    label: '⑥立刻插入新 user',
  });
  await waitFor(async () => (await page.locator('[data-testid="chat-interrupted"]').count()) > 0, {
    timeout: 8000,
    label: '⑥立刻插入中断条',
  });
  await waitFor(async () => (await lastAssistantText()).includes('立刻插入的回答'), { label: '⑥立刻插入回答' });
});

// ── ⑦ 停止键：半截保留；停止后队列照样续发 ─────────────────────────────────
await check('⑦ 停止生成：半截保留并标注；停止后排队自动续发', async () => {
  await waitIdle();
  await pushSteps([{ chunks: [{ content: '停止' }, { content: '测试' }, { content: '内容' }], delayMs: 500 }]);
  await submit('第六个问题');
  await waitFor(async () => (await lastAssistantText()).includes('停止'), { label: '⑦慢流首块' });

  await page.locator('[data-testid="chat-stop"]').click();
  const stopped = await waitFor(async () => {
    const t = await lastAssistantText();
    return t.includes('已停止生成') ? t : null;
  }, { label: '⑦已停止生成' });
  assert.ok(stopped.includes('停止'), '已流出的半截该保留');
  assert.doesNotMatch(stopped, /回答失败/, '停止不是错误');
  await waitFor(async () => (await page.locator('[data-testid="chat-stop"]').count()) === 0, {
    timeout: 8000,
    label: '⑦停止键消失',
  });

  // 排队 + 停止：停止也发队列（刻意的，与 Claude Code 一致 ——
  // 「取消一次运行不会把排在后面的补充说明一起丢掉」）。想全停用排队条上的「清空」。
  await pushSteps([
    { chunks: [{ content: '停二' }, { content: '止二' }], delayMs: 500 },
    { chunks: [{ content: '停止后续发的回答' }] },
  ]);
  await submit('第七个问题');
  await waitFor(async () => (await lastAssistantText()).includes('停二'), { label: '⑦停二首块' });
  // 基准取在「第七个问题」已经上屏之后：+1 才代表**排队那句被续发**，
  // 而不是这一轮自己的提问（取在更早会被它满足，白测）
  const usersBefore = await userMessageCount();
  await submit('停止后接着排的队');
  await waitFor(async () => (await page.locator('[data-testid="chat-queue-item"]').count()) === 1, {
    label: '⑦排队入队',
  });

  await page.locator('[data-testid="chat-stop"]').click();
  await waitFor(async () => (await userMessageCount()) === usersBefore + 1, {
    timeout: 10000,
    label: '⑦续发新 user',
  });
  await waitFor(async () => (await lastAssistantText()).includes('停止后续发的回答'), { label: '⑦续发回答' });
  assert.equal(await page.locator('[data-testid="chat-queue-item"]').count(), 0, '续发后队列该空');
});

// ── ⑧ 生成中切会话：可切走、后台继续、切回看到仍在流 ─────────────────────────
await check('⑧ 生成中切会话：不挡、切到空会话停止键收起、切回仍在流', async () => {
  await waitIdle();
  await pushSteps([{ chunks: [{ content: '后台' }, { content: '继续写' }], delayMs: 600 }]);
  await submit('第八个问题');
  await waitFor(async () => (await lastAssistantText()).includes('后台'), { label: '⑧慢流首块' });
  assert.equal(await page.locator('[data-testid="chat-stop"]').count(), 1, '生成中停止键该在');

  // 生成中切到「新会话」（草稿态）：旧实现是点了没反应（store 与 UI 两道闸）
  await page.locator('[data-testid="nav-rail-chat"]').click();
  await waitFor(async () => (await page.locator('.course-chat__message--user').count()) === 0, {
    label: '⑧切到空会话',
  });
  // 草稿态是空闲的：`loading` 是「这条会话的」而不是全局的，所以停止键该收起
  assert.equal(
    await page.locator('[data-testid="chat-stop"]').count(),
    0,
    '切到空闲会话后停止键该收起（loading 按会话走）',
  );

  // 切回原来那条：仍在流式的回答还在（切走时没从库里重读而丢），停止键回来
  await page
    .locator('[data-testid^="chat-recent-"]:not([data-testid*="-menu-"]):not([data-testid*="-delete-"])')
    .first()
    .click();
  await waitFor(async () => (await lastAssistantText()).includes('后台'), { label: '⑧切回仍在流' });
  assert.equal(
    await page.locator('[data-testid="chat-stop"]').count(),
    1,
    '切回生成中的会话，停止键该回来',
  );

  // 放它答完，落库
  await waitIdle({ timeout: 20000 });
  await waitFor(async () => (await lastAssistantText()).includes('继续写'), { label: '⑧后台轮答完' });
});

await browser.close();

if (failed > 0) {
  console.error(`\n${failed} 条失败`);
  process.exit(1);
}
console.log('\n全部通过');
