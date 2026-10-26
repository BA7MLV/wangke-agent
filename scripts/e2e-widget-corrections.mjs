// Focused review regressions only. Isolated storage, no model requests.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=MacAppCodeSignClone'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:5192');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).waitFor();
  await page.evaluate(async () => {
    window.__reviewImport = path => {
      const entry = performance.getEntriesByType('resource').findLast(entry => {
        const pathname = new URL(entry.name).pathname;
        return pathname === path || path.startsWith('/node_modules/.vite/deps/') && pathname.endsWith(`/deps/${path.split('/').pop()}`);
      });
      return import(entry?.name ?? path);
    };
    const React = (await window.__reviewImport('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await window.__reviewImport('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { default: AskCard } = await window.__reviewImport('/src/components/AskCard.tsx');
    const host = document.createElement('div'); host.id = 'review-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:100;background:var(--background);overflow:auto;padding:20px';
    document.body.append(host);
    const root = createRoot(host);
    window.__renderAsk = type => {
      const visual = type === 'text' ? '<label>视觉填写<input id="text"></label>' : '<label><input type="checkbox" value="a">视觉甲</label><label><input type="checkbox" value="b">视觉乙</label><label><input type="checkbox" value="c">视觉丙</label>';
      const html = `<section>${visual}<button id="submit">视觉提交</button><button id="invalid">非法ID</button><output></output><script>(()=>{
        const api=window.__wbw, output=document.querySelector('output');
        const answer=()=>({status:'answered',mode:'${type === 'text' ? 'text' : 'selection'}',selectedIds:[...document.querySelectorAll(':checked')].map(el=>el.value),selectedLabels:['FORGED'],text:document.querySelector('#text')?.value||'',note:''});
        const restore=()=>{const input=api.answerInput;document.querySelectorAll('[type="checkbox"]').forEach(el=>el.checked=input.answer.selectedIds.includes(el.value));if(document.querySelector('#text'))document.querySelector('#text').value=input.answer.text;};
        const draft=()=>api.setAnswerDraft(answer()).then(()=>output.textContent='草稿同步').catch(e=>output.textContent=e.message);
        document.querySelectorAll('input').forEach(el=>el.addEventListener('${type === 'text' ? 'input' : 'change'}',draft));
        document.querySelector('#submit').onclick=()=>api.submitAnswer(answer()).catch(e=>output.textContent=e.message);
        document.querySelector('#invalid').onclick=()=>api.setAnswerDraft({...answer(),selectedIds:['fake']}).catch(e=>output.textContent=e.message);
        restore();window.addEventListener('wbw:answerchange',restore);
      })();</script></section>`;
      window.__picked = [];
      root.render(React.createElement(AskCard, { key: type, active: true, messageKey: `review-${type}`, ask: { question: '复核草稿', type,
        options: type === 'text' ? [] : [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }, { id: 'c', label: '丙' }], minSelections: 2, maxSelections: 2,
        presentation: { html } }, onPick: async answer => window.__picked.push(answer) }));
    };
    window.__reviewRoot = root; window.__renderAsk('multiple');
  });
  const host = page.locator('#review-host');
  const frame = () => host.getByTestId('widget-frame').contentFrame();
  const visual = name => frame().getByRole('checkbox', { name });
  const native = name => host.getByRole('checkbox', { name, exact: true });
  async function nativeToggle(name) { await native(name).focus(); await native(name).press('Space'); }
  async function verify(ids) {
    await page.waitForFunction(ids => {
      const checked = [...document.querySelectorAll('#review-host .ask-card__options input:checked')];
      return checked.length === ids.length;
    }, ids);
    for (const [id, name] of [['a', '甲'], ['b', '乙'], ['c', '丙']]) {
      assert.equal(await native(name).isChecked(), ids.includes(id));
      assert.equal(await visual(`视觉${name}`).isChecked(), ids.includes(id));
    }
  }
  await visual('视觉甲').waitFor(); await verify([]);
  await visual('视觉甲').check(); await verify(['a']);
  await frame().getByRole('button', { name: '视觉提交' }).click();
  await frame().locator('output').filter({ hasText: '请选择 2 项' }).waitFor();
  assert.equal(await page.getByTestId('ask-visual-confirm').count(), 0);
  await nativeToggle('乙'); await verify(['a', 'b']);
  await visual('视觉丙').check();
  await frame().locator('output').filter({ hasText: '超过数量上限' }).waitFor();
  assert.equal(await native('丙').isChecked(), false);
  // Invalid draft was rejected; remove its local checkbox before continuing.
  await visual('视觉丙').uncheck();
  await visual('视觉甲').uncheck(); await verify(['b']);
  await nativeToggle('乙'); await verify([]);
  await frame().getByRole('button', { name: '非法ID' }).click();
  await frame().locator('output').filter({ hasText: '选项 ID 无效' }).waitFor();
  await verify([]);
  await frame().getByRole('button', { name: '视觉提交' }).click();
  await frame().locator('output').filter({ hasText: '请选择 2 项' }).waitFor();
  assert.equal(await page.evaluate(() => window.__picked.length), 0);
  await page.evaluate(() => window.__renderAsk('text'));
  await frame().getByRole('textbox', { name: '视觉填写' }).fill('视觉填写内容');
  await page.waitForFunction(() => document.querySelector('#review-host textarea')?.value === '视觉填写内容');
  await frame().getByRole('textbox', { name: '视觉填写' }).fill('');
  await page.waitForFunction(() => document.querySelector('#review-host textarea')?.value === '');
  await host.getByRole('textbox', { name: '你的回答' }).fill('原生填写内容');
  await frame().getByRole('textbox', { name: '视觉填写' }).evaluate(async el => {
    await new Promise(resolve => { const poll = () => el.value === '原生填写内容' ? resolve() : setTimeout(poll, 20); poll(); });
  });
  await host.getByRole('textbox', { name: '你的回答' }).fill('');
  await frame().getByRole('button', { name: '视觉提交' }).click();
  await frame().locator('output').filter({ hasText: '请填写你的回答' }).waitFor();
  assert.equal(await frame().getByRole('textbox', { name: '视觉填写' }).inputValue(), '');
  assert.equal(await page.getByTestId('ask-visual-confirm').count(), 0);

  // Exercise actual injected report(), not a mirror of its measurement algorithm.
  await page.evaluate(async () => {
    window.__reviewRoot.unmount();
    const { buildWidgetDocument } = await window.__reviewImport('/src/harness/widgetRuntime.ts');
    window.__heightCase = async html => {
      document.querySelector('#height-review')?.remove(); window.__heightReports = [];
      const iframe = document.createElement('iframe'); iframe.id = 'height-review'; iframe.sandbox = 'allow-scripts';
      iframe.style.cssText = 'width:500px;height:80px;border:0';
      document.querySelector('#review-host').append(iframe);
      window.onmessage = event => {
        if (event.source !== iframe.contentWindow || event.origin !== 'null' || event.data?.__wbw !== 'wbw:height') return;
        window.__heightReports.push(event.data.payload); iframe.style.height = `${Math.min(2000, event.data.payload)}px`;
      };
      iframe.srcdoc = await buildWidgetDocument({ html });
    };
  });
  async function sizeCase(html, min, max) {
    await page.evaluate(html => window.__heightCase(html), html);
    await page.waitForFunction(() => window.__heightReports.length > 1);
    await page.waitForTimeout(200);
    const reports = await page.evaluate(() => window.__heightReports);
    assert.ok(reports.at(-1) >= min && reports.at(-1) <= max, `height ${reports.at(-1)}, expected ${min}..${max}`);
    assert.ok(reports.length < 20, `size feedback loop: ${reports.length}`);
  }
  await sizeCase('<section style="height:160px"><div style="height:260px">正常溢出的教学内容</div></section>', 264, 280);
  await sizeCase('<section style="height:160px;position:relative"><div style="position:absolute;top:150px;height:110px">边缘 absolute 提示</div></section>', 264, 280);
  for (const overflow of ['hidden', 'auto']) await sizeCase(`<section style="height:160px;overflow:${overflow}"><div style="height:260px">有意裁切</div></section>`, 168, 180);
  await sizeCase('<section style="height:160px"><div style="position:fixed;top:1500px;height:110px">固定提示</div></section>', 168, 180);
  await sizeCase('<section style="height:160px;overflow:hidden;position:relative"><div style="position:absolute;top:150px;height:110px">裁切的 absolute 提示</div></section>', 168, 180);
  await sizeCase('<section style="height:160px;overflow:auto"><div style="width:900px;height:40px">横向滚动条</div></section>', 168, 185);
  await sizeCase('<section style="height:160px" id="size"><button>收起</button></section><script>document.querySelector("button").onclick=()=>document.querySelector("#size").style.height="600px";</script>', 168, 180);
  const sizing = page.locator('#height-review').contentFrame();
  await sizing.getByRole('button', { name: '收起' }).click();
  await page.waitForFunction(() => window.__heightReports.at(-1) >= 608);
  await sizing.locator('#size').evaluate(el => el.style.height = '160px');
  await page.waitForFunction(() => window.__heightReports.at(-1) === 168);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__heightReports.at(-1)), 168);
  assert.ok(await page.evaluate(() => window.__heightReports.length < 20));
  console.log('PASS: partial min=2 drafts 0→1→2→1→0 and bidirectional sync, clearable text, illegal/over-limit/final empty rejection; actual runtime visible/absolute overflow, clipped auto/hidden, fixed overlays and stable expand/shrink.');
} finally { await browser.close(); }
