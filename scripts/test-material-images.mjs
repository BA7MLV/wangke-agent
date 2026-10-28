import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { zipSync, strToU8 } from 'fflate';
import { createServer } from 'vite';

const server = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { db } = await server.ssrLoadModule('/src/store/db.ts');
  const refs = await server.ssrLoadModule('/src/materials/imageRefs.ts');
  const { docxImages, listMaterialImages, loadMaterialImage } = await server.ssrLoadModule('/src/materials/images.ts');
  const { createResourceExecutor } = await server.ssrLoadModule('/src/harness/resources.ts');
  const { extractChatSources } = await server.ssrLoadModule('/src/utils/chatSources.ts');
  const id = '课程 /?#%';
  assert.deepEqual(refs.parseMaterialImageHref(refs.materialImageHref(id, 'page-3')), { courseId: id, key: 'page-3' });
  assert.deepEqual(refs.parseMaterialImageHref(refs.materialImageHref(id, refs.videoFrameKey(25.125))), { courseId: id, key: 'frame-25125' });
  assert.deepEqual(refs.parseMaterialImageHref(refs.materialImageHref(id, refs.videoFrameKey(0))), { courseId: id, key: 'frame-0' });
  for (const key of ['frame--1', 'frame-01', 'frame-1.5', 'frame-99999999999999999']) assert.equal(refs.parseMaterialImageHref(refs.materialImageHref(id, key)), undefined);
  for (const bad of ['#source-image/%XX/page-1', '#source-image/a/page-0', '#source-image/a/page-1/extra', '#source-image/a/image--1', '#source-image/a/page-99999999999999999', 'file:///tmp/image.png']) assert.equal(refs.parseMaterialImageHref(bad), undefined);
  for (const bad of ['javascript:alert(1)', 'file:///x.png', '/assets/a.png', './x.png', 'blob:test', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://user:pass@example.com/a.png']) assert.equal(refs.imageSourceKind(bad), 'unavailable');
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO2kAAAAASUVORK5CYII=';
  const frameBlob = new Blob([Uint8Array.from(Buffer.from(pixel.split(',')[1], 'base64'))], { type: 'image/png' });
  await db.videos.put({ id: 'video', name: '视频课程', fileDeleted: 1, createdAt: 1 });
  const oldFrameId = await db.frames.add({ videoId: 'video', ts: 25.125, kind: 'slide', caption: '例题板书', blob: frameBlob });
  await db.frames.add({ videoId: 'other-video', ts: 0, kind: 'slide', blob: frameBlob });
  const frameExecutor = createResourceExecutor({ courseId: 'video', hasFrames: true });
  const frameCatalog = await frameExecutor('read', { path: '/courses/current/frames' });
  assert.match(frameCatalog, /!\[课程画面 0:25\]\(#source-image\/video\/frame-25125\)/);
  assert.match(frameCatalog, /不代表已看过像素/);
  const frame = await loadMaterialImage('video', 'frame-25125');
  assert.equal(frame.blob.type, 'image/png');
  assert.equal(frame.image.ts, 25.125);
  assert.equal(frame.image.unit, undefined, 'video seconds must not be treated as a material paragraph');
  assert.equal(frame.courseName, '视频课程');
  assert.equal(frame.image.label, '例题板书');
  await db.frames.delete(oldFrameId);
  await db.frames.add({ videoId: 'video', ts: 25.125, kind: 'slide', blob: frameBlob });
  assert.equal((await loadMaterialImage('video', 'frame-25125')).image.ts, 25.125, 'references survive frame row replacement');
  await assert.rejects(loadMaterialImage('video', 'frame-0'), /画面不存在/, 'cannot resolve another course\'s frame');
  await assert.rejects(loadMaterialImage('video', 'frame--1'), /无效/);
  await db.videos.delete('video');
  await assert.rejects(loadMaterialImage('video', 'frame-25125'), /来源视频已删除/);
  assert.equal(refs.imageSourceKind(pixel), 'inline');
  assert.equal(refs.imageSourceKind('https://example.com/a.png'), 'remote');
  const md = { id, name: '笔记', kind: 'material', materialFormat: 'md' };
  const text = `# 图片\n\n![第一张](${pixel})\n\n![引用式][photo]\n\n\`![不是图片](x.png)\`\n\n\`\`\`md\n![也不是图片](x.png)\n\`\`\`\n\n[photo]: https://example.com/second.png`;
  await db.videos.put(md);
  await db.files.put({ id, blob: new Blob([text]) });
  const images = await listMaterialImages(md, new Blob([text]));
  assert.equal(images.length, 2);
  assert.equal(images[0].unit, 1);
  assert.equal(images[1].src, 'https://example.com/second.png');
  assert.match(images[0].key, /^image-1-[a-f0-9]{16}$/);
  const loaded = await loadMaterialImage(id, images[0].key);
  assert.equal(loaded.blob.type, 'image/png');
  assert.equal((await loadMaterialImage(id, images[1].key)).remoteUrl, 'https://example.com/second.png');
  const executor = createResourceExecutor({ courseId: id, kind: 'para' });
  const catalog = await executor('read', { path: '/courses/current/images', limit: 1 });
  assert.match(catalog, /共 2 张/);
  assert.match(catalog, /#source-image\//);
  assert.match(catalog, /offset=1/);
  assert.doesNotMatch(catalog, /data:image|base64,iVBOR/);
  assert.match(await executor('read', { path: '/courses/current/images', range: { unit: 'pages', start: 1, end: 1 } }), /必须是 paragraphs/);
  assert.match(await executor('read', { path: '/courses/another/images' }), /只能访问当前课程/);
  const ranged = await executor('read', { path: '/courses/current/images', range: { unit: 'paragraphs', start: 2, end: 2 } });
  assert.match(ranged, /共 1 张/);
  assert.doesNotMatch(ranged, /image-1-/);
  await db.files.put({ id, blob: new Blob([text.replace(pixel, 'https://example.com/changed.png')]) });
  await assert.rejects(loadMaterialImage(id, images[0].key), /材料可能已修改/);
  await db.files.delete(id);
  assert.match(await executor('read', { path: '/courses/current/images' }), /原文件已删除/);

  const docx = new Blob([zipSync({
    'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r><a:blip r:embed="r1"/></w:p><w:p><a:blip r:embed="r2"/></w:p><w:p><w:r><w:t>第二段</w:t></w:r><a:blip r:embed="r3"/></w:p></w:body></w:document>'),
    'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Id="r1" Type="http://example/image" Target="media/one.png"/><Relationship Id="r2" Type="http://example/image" Target="media/two.png"/><Relationship Id="r3" Type="http://example/image" Target="https://example.com/remote.png" TargetMode="External"/></Relationships>'),
    'word/media/one.png': Uint8Array.from(Buffer.from(pixel.split(',')[1], 'base64')),
    'word/media/two.png': Uint8Array.from(Buffer.from(pixel.split(',')[1], 'base64')),
  })]);
  const wordImages = await docxImages(docx);
  assert.equal(wordImages.length, 2);
  assert.equal(wordImages[0].unit, 1);
  assert.equal(wordImages[1].unit, undefined, 'Image-only blocks must not pretend to have a text anchor');
  await db.videos.put({ id: 'word', kind: 'material', materialFormat: 'docx', name: 'Word' });
  await db.files.put({ id: 'word', blob: docx });
  assert.equal((await loadMaterialImage('word', wordImages[0].key)).blob.type, 'image/png');
  const source = extractChatSources(`[《笔记》](${refs.materialSourceHref(id, 3)}) 第3页`);
  assert.equal(source[0].courseId, id);
  await db.delete();
  console.log('PASS material image refs, URL safety, Markdown/ref-links, pagination/ranges, permissions, file lifecycle, revision safety, Word images and source queries');
} finally { await server.close(); }
