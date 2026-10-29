/* eslint-disable no-console */
// E2E：流式失败后的**断点续传**、消息 hover 的重试 / 分支、侧栏 Recent 的分支与标题省略。
//
// 为什么模型流是页内假的：这一整轮要验的是「失败之后会发生什么」，而真实的失败
// （网关中途断流）没法按需触发。`addInitScript` 换掉 `window.fetch`，让假流在吐完
// 指定内容之后**主动 error**，那条路径才可复现、可回归。
//
// 覆盖点：
//   1. 流式中途失败 → 已流出的内容**留在界面上**（不是只剩一句「回答失败」）
//   2. 同一轮**落库** → 刷新之后内容还在（这正是旧实现丢掉的那一段）
//   3. 中断提示条 + 「继续」按钮出现
//   4. 点「继续」→ 接着写：新内容**追加到同一条消息**上（消息条数不变）
//   5. 续写完成 → 提示条消失、内容干净（正文里没有「回答中断」这类污染）
//   6. 消息 hover → 操作行显形，且重试 / 分支两颗图标都在
//   7. **提问**的操作行在气泡**外面**（下方、右对齐），并且带重试 —— 点它 = 重新回答这句话
//   8. 对话内「分支」→ Recent 多一条 `… · 分支`，原会话原样不动
//   9. 侧栏 Recent 菜单 → 分支（整条复制）
//  10. Recent 长标题始终省略，不在 hover 时改变布局或播放动画
//
// 用法：npm run preview &  然后 node scripts/e2e-chat-resume-fork.mjs
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
  fail(`页面异常：${e.message}\n${String(e.stack ?? '').split('\n').slice(0, 6).join('\n')}`),
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
  window.__LLM__ = { queue: [], calls: 0, requests: [] };

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/chat/completions')) return nativeFetch(input, init);
    window.__LLM__.calls++;
    try {
      window.__LLM__.requests.push(JSON.parse(init?.body ?? '{}'));
    } catch {
      /* 忽略 */
    }
    const step = window.__LLM__.queue.shift() ?? { chunks: [{ content: '（队列空了）' }] };
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        try {
          for (const d of step.chunks) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`));
            if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
          }
          if (step.failAfter) {
            /**
             * 网关中途断流：这是真实世界里最常见的那种失败（连接被掐、上游超时）。
             *
             * ⚠️ **断之前必须先让读取端把上面那些 chunk 消费掉。**
             * `controller.error()` 会执行 Streams 规范里的 `ResetQueue` ——
             * 已入队但还没被读走的 chunk 会被**一次性丢弃**，读取端只拿到一个 error。
             * 紧接着 enqueue 后面直接 error 的话，测到的不是「流了一半断掉」，
             * 而是「一个字节都没流出来」—— 那走的是 `send` 里另一条分支
             * （`error: true`，不落库），于是 ①②③ 全红，而根因根本不在被测代码里。
             * 实测踩过：界面上只剩一句「回答失败：boom: connection reset」。
             */
            await new Promise((r) => setTimeout(r, 50));
            c.error(new Error(step.failAfter));
            return;
          }
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        } catch (e) {
          c.error(e);
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

/**
 * 等应用把库建起来。
 *
 * 两个坑叠在这里，缺一不可：
 * 1. **必须先落到应用页**。在 `about:blank` 上 `indexedDB.open` 会被浏览器直接拒
 *    （`SecurityError: access to the Indexed Database API is denied in this context`）——
 *    第一次跑这个脚本就是死在这里。
 * 2. **库要由应用自己建**。对一个还不存在的库裸 `open('wangke')`，拿到的是一个
 *    **没有任何 object store** 的空库，紧接着 `tx.objectStore('chats')` 就抛
 *    （Dexie 的 stores 只会在建库/升级时创建）。所以顺序只能是「先让应用跑起来 → 再清」。
 *
 * 判据取 `chats` + `chatSessions` 两张表都在：只判库存在是不够的，
 * 空库同样「存在」。
 */
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
  // 先落页（理由见 `waitForDbReady`），再清库，再刷新回干净状态
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
    window.__LLM__.requests = [];
  });
};

const typeAndSend = async (t) => {
  /**
   * ⚠️ 两种形态都要收：HeroUI 的 `TextArea` 把 `className` 落在 **textarea 元素本身**
   * （`<textarea class="… course-chat__input">`），只写后代选择器
   * `.course-chat__input textarea` 一条都匹配不到 —— 表现是 `waitFor` 超时、
   * 报成「输入框不可见」，看着像页面挂了。实测踩过，
   * 见 e2e-lazy-session.mjs / e2e-course-chat-cards.mjs 的同款注释。
   */
  const field = page
    .locator(
      '.course-chat__input textarea, .course-chat__input input, textarea.course-chat__input, input.course-chat__input',
    )
    .first();
  await field.waitFor({ timeout: 10000 });
  await field.click();
  await field.fill(t);
  await field.press('Enter');
};

/** 库里某条会话的消息（按 createdAt 升序），返回 `{ role, content, interrupted }[]` */
const dbMessages = (sessionId) =>
  dbHelper(
    async (idb, sid) => {
      const rows = await new Promise((res, rej) => {
        const tx = idb.transaction(['chats'], 'readonly');
        const r = tx.objectStore('chats').getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return rows
        .filter((row) => row.sessionId === sid)
        .sort((a, b) => a.createdAt - b.createdAt)
        /**
         * `interrupted` **原样返回，不要 `!!` 收成布尔**。
         *
         * 续写完成的判据是「字段被**删掉**」（`delete row.interrupted`），而 `!!undefined`
         * 与 `!!false` 都是 `false` —— 一收就把「已清干净」和「还标着未中断」变成同一个值，
         * ⑥ 那条断言就永远测不出东西（实测：`assert.equal(false, undefined)` 必红，
         * 且红的原因与被测代码无关）。
         */
        .map((row) => ({ role: row.role, content: row.content, interrupted: row.interrupted }));
    },
    sessionId,
  );

const dbSessions = () =>
  dbHelper(async (idb) => {
    const rows = await new Promise((res, rej) => {
      const tx = idb.transaction(['chatSessions'], 'readonly');
      const r = tx.objectStore('chatSessions').getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return rows.map((row) => ({ id: row.id, title: row.title })).sort((a, b) => a.id - b.id);
  });

/** 等条件成立（轮询 DOM / 库，不用固定 sleep） */
const waitFor = async (fn, { timeout = 15000, step = 100 } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, step));
  }
};

const PART1 = '这段回答写到一半的时候';
const PART2 = '，网关把连接掐断了';
const PART3 = '。这是续写接上的后半段。';
/** 提问上「重试」重新生成的回答：用来证明旧的那条回答被**换掉**而不是接在后面 */
const RETRY_PART = '；重试之后这一轮重新生成的回答。';

// ── 第 1 组：中断 → 落库 → 续写 ────────────────────────────────────────────
await reset();
await pushSteps([{ chunks: [{ content: PART1 }, { content: PART2 }], failAfter: 'boom: connection reset' }]);
await typeAndSend('问题一');

await check('① 流式中途失败：已流出的内容留在界面上', async () => {
  await waitFor(async () => (await page.locator('.course-chat__bubble--ai').count()) > 0);
  const text = await waitFor(async () => {
    const t = await page.locator('.course-chat__bubble--ai').last().innerText();
    return t.includes(PART1) && t.includes(PART2) ? t : null;
  });
  assert.ok(!text.includes('回答失败'), `不该只剩一句失败提示：${text}`);
});

await check('② 中断提示条 + 「继续」按钮出现，且正文里没有污染文案', async () => {
  await page.waitForSelector('[data-testid="chat-interrupted"]', { timeout: 10000 });
  const text = await page.locator('.course-chat__bubble--ai').last().innerText();
  // 正文必须是**干净**的半截回答：那句「回答中断：xxx」要能当 assistant 前缀发给模型，
  // 嵌进正文会污染它（模型会接着那句话往下写）
  assert.ok(!text.includes('回答中断'), `正文里不该嵌「回答中断」：${text}`);
  assert.equal(await page.locator('[data-testid="chat-continue"]').count(), 1, '提示条里应当有一个「继续」');
});

let sessionId = null;
await check('③ 这一轮**落库**了：库里有一条 interrupted 的 assistant 消息', async () => {
  const sessions = await dbSessions();
  assert.equal(sessions.length, 1, `应当只有一条会话，实际 ${sessions.length}`);
  sessionId = sessions[0].id;
  const rows = await dbMessages(sessionId);
  const ai = rows.filter((r) => r.role === 'assistant');
  assert.equal(ai.length, 1, `助手消息应当只有一条，实际 ${ai.length}`);
  assert.equal(ai[0].interrupted, true, '这条应当带 interrupted 标记');
  assert.ok(ai[0].content.includes(PART1), `库里应当留着已流出的内容：${ai[0].content}`);
});

await check('④ 刷新之后内容还在（这正是旧实现丢掉的那一段）', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
  const text = await waitFor(async () => {
    const t = await page.locator('.course-chat__bubble--ai').last().innerText();
    return t.includes(PART1) ? t : null;
  });
  assert.ok(text.includes(PART2));
  await page.waitForSelector('[data-testid="chat-interrupted"]', { timeout: 10000 });
});

await check('⑤ 点「继续」→ 接着写，新内容追加到**同一条**消息上', async () => {
  // Some providers restart from the beginning despite the continuation hint.
  // Split the replay across chunks to test incremental (not only EOF) dedup.
  await pushSteps([{ chunks: [{ content: PART1 }, { content: PART2 }, { content: PART3 }] }]);
  await page.locator('[data-testid="chat-interrupted"] button').first().click();

  const text = await waitFor(async () => {
    const t = await page.locator('.course-chat__bubble--ai').last().innerText();
    return t.includes(PART3) ? t : null;
  });
  assert.ok(text.includes(PART1) && text.includes(PART2), `续写不该丢掉前半截：${text}`);
  // 仍然只有一条助手消息（不是新开一个气泡）
  assert.equal(await page.locator('.course-chat__bubble--ai').count(), 1, '续写应当原地拼接，不新开气泡');
});

await check('⑥ 续写完成：提示条消失，库里这条不再是 interrupted', async () => {
  await waitFor(async () => (await page.locator('[data-testid="chat-interrupted"]').count()) === 0);
  const rows = await dbMessages(sessionId);
  const ai = rows.filter((r) => r.role === 'assistant');
  assert.equal(ai.length, 1, `续写应当更新原行而不是新增，实际 ${ai.length} 条`);
  assert.equal(ai[0].interrupted, undefined, '续写完成后 interrupted 必须被清掉');
  assert.ok(ai[0].content.includes(PART3), `库里应当是拼好的完整回答：${ai[0].content}`);
  assert.equal(ai[0].content, PART1 + PART2 + PART3, 'provider replay must not duplicate the saved prefix');
});

// ── 第 2 组：hover 出操作行 ────────────────────────────────────────────────
await check('⑦ 消息 hover → 操作行显形，重试 / 分支两颗图标都在', async () => {
  const message = page.locator('.course-chat__message--ai').last();
  const actions = message.locator('.course-chat__actions');
  assert.equal(
    await actions.evaluate((el) => getComputedStyle(el).opacity),
    '0',
    '默认应当是透明的（长回答里每行都挂四颗图标会把正文切碎）',
  );
  await message.hover();
  await waitFor(async () => (await actions.evaluate((el) => getComputedStyle(el).opacity)) === '1');
  assert.equal(await message.locator('[data-testid="chat-retry-message"]').count(), 1, '缺「重试」');
  assert.equal(await message.locator('[data-testid="chat-fork-message"]').count(), 1, '缺「分支」');
});

await check('⑧ 提问的操作行在气泡**外面**（下方右对齐），三颗图标齐全', async () => {
  const user = page.locator('.course-chat__message--user').last();
  await user.hover();
  const actions = user.locator('.course-chat__actions');
  await waitFor(async () => (await actions.evaluate((el) => getComputedStyle(el).opacity)) === '1');

  // ① 必须在框外：操作行是气泡的**兄弟**，不是子节点
  assert.equal(
    await user.locator('.course-chat__bubble--user .course-chat__actions').count(),
    0,
    '操作行不该挂在气泡里面（悬停时会把气泡底色拉出一条图标行）',
  );
  for (const id of ['chat-copy-message', 'chat-retry-message', 'chat-fork-message']) {
    assert.equal(await user.locator(`[data-testid="${id}"]`).count(), 1, `提问上缺 ${id}`);
  }

  // ② 位置真的在框外：落在气泡矩形下方，且右缘与气泡对齐
  const geo = await user.evaluate((el) => {
    const bubble = el.querySelector('.course-chat__bubble--user').getBoundingClientRect();
    const act = el.querySelector('.course-chat__actions').getBoundingClientRect();
    return { bubbleBottom: bubble.bottom, bubbleRight: bubble.right, actionTop: act.top, actionRight: act.right };
  });
  assert.ok(
    geo.actionTop >= geo.bubbleBottom - 1,
    `操作行应当在气泡下方（actionTop=${geo.actionTop} vs bubbleBottom=${geo.bubbleBottom}）`,
  );
  assert.ok(
    Math.abs(geo.actionRight - geo.bubbleRight) <= 8,
    `操作行右缘应与气泡对齐（${geo.actionRight} vs ${geo.bubbleRight}）`,
  );
});

await check('⑨ 点提问上的「重试」→ 用同一句话重新回答，历史里不会多出第二条提问', async () => {
  const user = page.locator('.course-chat__message--user').last();
  await user.hover();
  const retry = user.locator('[data-testid="chat-retry-message"]');
  assert.equal(await retry.isDisabled(), false, '答复就在末尾时，重试应当可用');

  const before = await dbMessages(sessionId);
  assert.equal(before.filter((r) => r.role === 'user').length, 1, '重试前应当只有一条提问');

  await pushSteps([{ chunks: [{ content: RETRY_PART }] }]);
  await retry.click();

  const text = await waitFor(async () => {
    const t = await page.locator('.course-chat__bubble--ai').last().innerText();
    return t.includes(RETRY_PART) ? t : null;
  });
  assert.ok(!text.includes(PART3), '重新生成的回答应当整条换掉，而不是把旧内容接在后面');

  // 库里仍然只有「一问一答」两行 —— 重试不该把提问复制成两条
  const after = await waitFor(async () => {
    const rows = await dbMessages(sessionId);
    return rows.length === 2 && rows[1].content.includes(RETRY_PART) ? rows : null;
  });
  assert.equal(after.filter((r) => r.role === 'user').length, 1, '重试后提问仍应只有一条');
  assert.equal(after[0].content, '问题一', '重试要用原来那句话');
  // 视图同样只剩一问一答（旧的那半截没有留在界面上）
  assert.equal(await page.locator('.course-chat__bubble--user').count(), 1, '视图上不该多出第二条提问');
});

// ── 第 3 组：对话内分支 ────────────────────────────────────────────────────
await check('⑩ 对话内「分支」→ Recent 多一条「… · 分支」，原会话不动', async () => {
  const before = await dbSessions();
  const ai = page.locator('.course-chat__message--ai').last();
  await ai.hover();
  await ai.locator('[data-testid="chat-fork-message"]').click();

  const after = await waitFor(async () => {
    const list = await dbSessions();
    return list.length === before.length + 1 ? list : null;
  });
  const forked = after.find((s) => !before.some((b) => b.id === s.id));
  assert.ok(forked.title.endsWith('· 分支'), `分支会话标题该带来源：${forked.title}`);

  // 原会话一个字都没少
  const original = await dbMessages(before[0].id);
  assert.equal(original.filter((r) => r.role === 'assistant').length, 1);
  assert.ok(original[1].content.includes(RETRY_PART));

  // 分支会话拿到了同一条消息
  const copied = await dbMessages(forked.id);
  assert.equal(copied.length, original.length, `分支应当复制到分叉点为止：${copied.length} vs ${original.length}`);

  // 视图也切过去了
  await waitFor(async () => (await page.locator('.course-chat__bubble--ai').count()) === 1);
  const title = await page.locator('[data-testid="page-title"]').innerText();
  assert.ok(title.includes('分支'), `顶栏标题该是分支会话：${title}`);
});

// ── 第 4 组：侧栏 Recent 的分支 ────────────────────────────────────────────
await check('⑪ Recent 行尾菜单里有「分支出新会话」，点了就多一条', async () => {
  const rowsBefore = await dbSessions();
  const trigger = page.locator('[data-testid^="chat-recent-"][data-testid$="-menu-trigger"]').first();
  await trigger.click();
  await page.waitForSelector('.dropdown__menu', { timeout: 10000 });
  await page.locator('[data-testid$="-menu-fork"]').first().click();

  const after = await waitFor(async () => {
    const list = await dbSessions();
    return list.length === rowsBefore.length + 1 ? list : null;
  });
  assert.equal(after.length, rowsBefore.length + 1);
});

// ── 第 5 组：Recent 标题 hover 跑马灯 ──────────────────────────────────────
await check('⑫ Recent 长标题始终省略，hover 不播放动画', async () => {
  const longTitle = '这是一个特别特别长的会话标题用来验证悬停之后能不能跑马灯滚开看全内容';
  await dbHelper(
    async (idb, title) => {
      await new Promise((res, rej) => {
        const tx = idb.transaction(['chatSessions', 'chats'], 'readwrite');
        const sid = tx.objectStore('chatSessions').add({ videoId: '__library_assistant__', title, createdAt: Date.now() });
        sid.onsuccess = () => {
          tx.objectStore('chats').add({
            videoId: '__library_assistant__',
            sessionId: sid.result,
            role: 'user',
            content: '夹具',
            createdAt: Date.now(),
          });
        };
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      return true;
    },
    longTitle,
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.recent-title', { timeout: 20000 });

  const titleEl = page.locator('.recent-title').filter({ hasText: '特别特别长' }).first();
  await titleEl.waitFor({ timeout: 10000 });
  const inner = titleEl.locator('span').first();

  // 平时：裁剪 + 省略号，且没有任何动画
  const before = await titleEl.evaluate((el) => getComputedStyle(el).overflowX);
  assert.equal(before, 'hidden', `平时该是截断的，实际 overflow-x=${before}`);
  assert.equal(await inner.evaluate((el) => getComputedStyle(el).animationName), 'none', '平时不该有动画');

  // 内容真的比容器宽（否则这条断言等于没测：一个不溢出的标题本来就不需要滚）
  const scrollable = await titleEl.evaluate((el) => el.scrollWidth > el.clientWidth);
  assert.ok(scrollable, '夹具标题应当真的溢出容器');

  await titleEl.hover();
  assert.equal(await inner.evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await titleEl.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
  await page.mouse.move(0, 0);
  assert.equal(await titleEl.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
});

await browser.close();

if (failed > 0) {
  console.error(`\n${failed} 条失败`);
  process.exit(1);
}
console.log('\n全部通过');
