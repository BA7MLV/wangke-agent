import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Keep installed-app icons identical to the SVG favicon without image dependencies.
const publicDir = new URL('../apps/web/public/', import.meta.url);
const svg = await readFile(new URL('icon.svg', publicDir), 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    const data = await page.evaluate(async ({ svg, size }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, size, size);
      context.drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { svg, size });
    await writeFile(new URL(name, publicDir), Buffer.from(data, 'base64'));
    console.log(`Generated ${name} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
