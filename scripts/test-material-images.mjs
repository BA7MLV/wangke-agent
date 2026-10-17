import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { zipSync, strToU8 } from 'fflate';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { db } = await server.ssrLoadModule('/src/store/db.ts');
  const refs = await server.ssrLoadModule('/src/materials/imageRefs.ts');
  const { docxImages, listMaterialImages, loadMaterialImage } = await server.ssrLoadModule('/src/materials/images.ts');
  const { createResourceExecutor } = await server.ssrLoadModule('/src/harness/resources.ts');
  const { extractChatSources } = await server.ssrLoadModule('/src/utils/chatSources.ts');
  const id = '课程 /?#%';
  assert.deepEqual(refs.parseMaterialImageHref(refs.materialImageHref(id, 'page-3')), { courseId: id, key: 'page-3' });
  for (const bad of ['#source-image/%XX/page-1', '#source-image/a/page-0', '#source-image/a/page-1/extra', '#source-image/a/image--1', '#source-image/a/page-99999999999999999', 'file:///tmp/image.png']) assert.equal(refs.parseMaterialImageHref(bad), undefined);
  for (const bad of ['javascript:alert(1)', 'file:///x.png', '/assets/a.png', './x.png', 'blob:test', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://user:pass@example.com/a.png']) assert.equal(refs.imageSourceKind(bad), 'unavailable');
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO2kAAAAASUVORK5CYII=';
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
