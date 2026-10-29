import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:4173';
const out = process.env.SHOTS || 'test-results/sidebar-brand';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.5, `${message}: ${actual} ≠ ${expected}`);

async function checkSidebar(page) {
  await page.getByTestId('app-brand').waitFor();
  await page.mouse.move(0, 0);
  const brand = page.getByTestId('app-brand');
  assert.equal((await brand.textContent()).trim(), '', '品牌区不应再显示标题文字');
  assert.equal(await brand.locator('svg > path').count(), 5, '使用提供的完整 Logo 图形');
  assert.equal(await brand.locator('linearGradient stop').first().getAttribute('stop-color'), '#676767');

  const logo = await brand.locator('svg').boundingBox();
  near(logo.width, 24, 'Logo 缩小为 24px');
  near(logo.height, 24, 'Logo 保持正方形');
  const chat = await page.getByTestId('nav-rail-chat').boundingBox();
  const resource = await page.getByTestId('nav-rail-home').boundingBox();
  near(chat.x, resource.x, '两行左缘一致');
  near(chat.width, resource.width, '两行宽度一致');
  near(chat.height, 44, '新会话行保持 44px 触控高度');
  near(resource.height, chat.height, '两行高度一致');
  const bot = await page.getByTestId('nav-rail-bot').boundingBox();
  near(resource.y - chat.y - chat.height, bot.y - resource.y - resource.height, '新会话与其他导航项的间距一致');
  const chatStyle = await page.getByTestId('nav-rail-chat').evaluate((el) => {
    const style = getComputedStyle(el);
    return { shadow: style.boxShadow, border: style.borderColor, background: style.backgroundColor, color: style.color };
  });
  assert.equal(chatStyle.shadow, 'none', '新会话不应有阴影');
  assert.equal(chatStyle.border, 'rgba(0, 0, 0, 0)', '新会话不应有可见边框');
  assert.equal(chatStyle.background, 'rgba(0, 0, 0, 0)', '新会话不应有常驻底色');
  const botColor = await page.getByTestId('nav-rail-bot').evaluate((el) => getComputedStyle(el).color);
  assert.equal(chatStyle.color, botColor, '新会话与普通导航项使用相同文字颜色');
  const palette = await page.evaluate(() => {
    const shell = document.querySelector('.page-shell');
    const surface = document.querySelector('.page-shell__surface');
    const edge = document.querySelector('.page-shell__top-edge');
    return {
      dark: document.documentElement.classList.contains('dark'),
      wide: matchMedia('(min-width: 901px)').matches,
      sidebar: getComputedStyle(shell).backgroundColor,
      content: getComputedStyle(surface).backgroundColor,
      border: getComputedStyle(surface).borderLeftColor,
      edge: getComputedStyle(edge).backgroundColor,
      meta: document.querySelector('meta[name="theme-color"]').content,
    };
  });
  if (!palette.dark) {
    assert.equal(palette.sidebar, 'rgb(240, 240, 240)', '侧栏使用中性浅灰');
    assert.equal(palette.edge, palette.sidebar, '顶部实色与侧栏衔接');
    assert.equal(palette.meta, '#f0f0f0', '浏览器染色跟随新的浅色画布');
    if (palette.wide) {
      assert.equal(palette.content, 'rgb(248, 248, 248)', '正文使用更亮的近白色');
      assert.equal(palette.border, 'rgb(222, 222, 222)', '使用淡中性分隔线');
    }
  } else {
    assert.notEqual(palette.sidebar, 'rgb(240, 240, 240)', '深色侧栏不受浅色覆盖影响');
    assert.notEqual(palette.content, 'rgb(248, 248, 248)', '深色正文不受浅色覆盖影响');
  }
  for (const id of ['nav-rail-chat', 'nav-rail-home', 'nav-rail-bot']) {
    const icon = await page.getByTestId(id).locator('svg').boundingBox();
    near(icon.x, logo.x, `${id} 与 Logo 左对齐`);
    near(icon.width, 20, `${id} 图标宽度一致`);
    near(icon.height, 20, `${id} 图标高度一致`);
  }
  const chatLabel = await page.getByTestId('nav-rail-chat').locator('span').last().boundingBox();
  const resourceLabel = await page.getByTestId('nav-rail-home').locator('span').last().boundingBox();
  near(chatLabel.x, resourceLabel.x, '两行文字左对齐');
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  desktop.on('pageerror', (error) => errors.push(error.message));
  await desktop.goto(base);
  await checkSidebar(desktop);
  await desktop.screenshot({ path: `${out}/desktop-light.png` });

  await desktop.emulateMedia({ colorScheme: 'dark' });
  await desktop.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await checkSidebar(desktop);
  await desktop.screenshot({ path: `${out}/desktop-dark.png` });

  await desktop.getByTestId('nav-rail-home').click();
  await desktop.waitForURL('**/#/library');
  await desktop.locator('[data-testid="nav-rail-home"][aria-selected="true"]').waitFor();
  await checkSidebar(desktop);
  await desktop.getByTestId('nav-rail-chat').click();
  await desktop.getByTestId('course-chat-page').waitFor();

  await desktop.getByTestId('nav-rail-toggle').click();
  await desktop.getByTestId('nav-rail-compact').waitFor();
  assert.equal(await desktop.getByTestId('nav-rail-toggle').getAttribute('aria-label'), '展开侧边栏');
  near((await desktop.getByTestId('nav-rail-toggle').locator('svg').boundingBox()).width, 24, '折叠后也使用较小 Logo');
  await desktop.mouse.move(0, 0);
  assert.equal(await desktop.getByTestId('nav-rail-chat').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', '折叠后新会话也不突出显示');
  for (const id of ['nav-rail-chat', 'nav-rail-home']) {
    const box = await desktop.getByTestId(id).boundingBox();
    near(box.width, 44, '折叠后的按钮宽度一致');
    near(box.height, 44, '折叠后的按钮高度一致');
  }
  await desktop.getByTestId('nav-rail-toggle').click();
  await checkSidebar(desktop);

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  phone.on('pageerror', (error) => errors.push(error.message));
  await phone.goto(base);
  await phone.getByTestId('nav-rail-open').click();
  await checkSidebar(phone);
  await phone.screenshot({ path: `${out}/phone-navigation.png` });
  await phone.getByTestId('nav-rail-home').click();
  await phone.waitForURL('**/#/library');
  await phone.getByRole('dialog', { name: 'DeepStudent Go', exact: true }).waitFor({ state: 'hidden' });

  assert.deepEqual(errors, []);
  console.log(`Sidebar branding passed (desktop light/dark, library, collapsed, mobile). Screenshots: ${out}`);
} finally {
  await browser.close();
}
