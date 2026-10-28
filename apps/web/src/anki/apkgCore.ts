/**
 * 最小 .apkg 写入器核心：sql.js 建 collection.anki2（旧版格式，Anki 桌面/AnkiMobile/AnkiDroid
 * 全版本可导入并自动升级）+ fflate 打 zip。纯逻辑无浏览器依赖，Node 下可直接测试。
 */
// 注：本文件被 node 测试脚本直接 import（type stripping），相对导入必须带 .ts 扩展名
import { strToU8, zipSync } from 'fflate';
import type { SqlJsStatic } from 'sql.js';
import { fmtTime } from '../utils/vtt.ts';
import type { CardRow } from '../store/db.ts';

/** 字段文本转义为 HTML（flds 按 HTML 解析），换行转 <br> */
const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

/** 牌组/标签用的课程名：去扩展名、清洗非法字符 */
function safeName(videoName: string): string {
  const base = videoName
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/::/g, '：')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '-')
    .trim();
  return base.slice(0, 40) || '未命名课程';
}

/** Anki guid：base64url 随机串（getRandomValues 在非安全上下文也可用，不像 crypto.subtle） */
function guid(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * 首字段校验和。Anki 官方算法是 sha1 前 8 位，但 crypto.subtle 在局域网 http（iPad 主力场景）
 * 不可用；csum 仅用于导入时的重复检测，导入器会按 flds 重算，用 FNV-1a 足够。
 */
function csum(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SCHEMA = `
CREATE TABLE col (
  id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null,
  conf text not null, models text not null, decks text not null, dconf text not null, tags text not null
);
CREATE TABLE notes (
  id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld text not null,
  csum integer not null, flags integer not null, data text not null
);
CREATE TABLE cards (
  id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null,
  due integer not null, ivl integer not null, factor integer not null, reps integer not null,
  lapses integer not null, left integer not null, odue integer not null, odid integer not null,
  flags integer not null, data text not null
);
CREATE TABLE revlog (
  id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null,
  time integer not null, type integer not null
);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_notes_csum on notes (csum);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_revlog_usn on revlog (usn);
`;

const MODEL_CSS = `.card {
  font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  font-size: 20px;
  line-height: 1.7;
  text-align: center;
  color: #2d3436;
  background-color: #ffffff;
}
.q { font-weight: 600; }
.a { white-space: pre-wrap; }
.src { margin-top: 14px; font-size: 12px; color: #999999; }`;

/** 生成 .apkg 文件字节（zip：collection.anki2 + 空 media 清单） */
export function buildApkgBytes(SQL: SqlJsStatic, videoName: string, cards: CardRow[]): Uint8Array {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const base = nowMs; // 各表自增 id 的起点（表间独立，无需错开）
  const modelId = base;
  const deckId = base;
  const name = safeName(videoName);
  const deckName = `网课::${name}`;
  const tag = `网课::${name.replace(/\s+/g, '_')}`;

  const model = {
    id: modelId,
    name: '网课问答卡',
    type: 0,
    mod: nowSec,
    usn: 0,
    sortf: 0,
    did: deckId,
    tmpls: [
      {
        name: 'Card 1',
        ord: 0,
        qfmt: '<div class="q">{{Front}}</div>',
        afmt: '{{FrontSide}}<hr id="answer"><div class="a">{{Back}}</div>{{#Source}}<div class="src">{{Source}}</div>{{/Source}}',
        bqfmt: '',
        bafmt: '',
        did: null,
        bfont: '',
        bsize: 0,
      },
    ],
    flds: [
      { name: 'Front', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
      { name: 'Back', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
      { name: 'Source', ord: 2, sticky: false, rtl: false, font: 'Arial', size: 12, media: [] },
    ],
    css: MODEL_CSS,
    latexPre:
      '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n' +
      '\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}',
    latexPost: '\\end{document}',
    latexsvg: false,
    req: [[0, 'all', [0]]],
    tags: [],
    vers: [],
  };

  const deckCommon = {
    mod: nowSec,
    usn: 0,
    lrnToday: [0, 0],
    revToday: [0, 0],
    newToday: [0, 0],
    timeToday: [0, 0],
    collapsed: false,
    browserCollapsed: false,
    desc: '',
    dyn: 0,
    conf: 1,
    extendNew: 0,
    extendRev: 0,
  };
  const decks = {
    '1': { id: 1, name: 'Default', ...deckCommon },
    [deckId]: { id: deckId, name: deckName, ...deckCommon },
  };

  const conf = {
    activeDecks: [1],
    addToCur: true,
    collapseTime: 120000,
    curDeck: 1,
    curModel: String(modelId),
    dueCounts: true,
    estTimes: true,
    newBury: true,
    newSpread: 0,
    nextPos: 1,
    sortBackwards: false,
    sortType: 'noteFld',
    timeLim: 0,
  };
  const dconf = {
    '1': {
      id: 1,
      mod: 0,
      name: 'Default',
      usn: 0,
      maxTaken: 60,
      autoplay: true,
      timer: 0,
      replayq: true,
      new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
      lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
      rev: { bury: false, ease4: 1.3, fuzz: 0.05, hardFactor: 1.2, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 200 },
    },
  };

  const db = new SQL.Database();
  try {
    db.run(SCHEMA);
    db.run('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      1, nowSec, nowMs, nowMs, 11, 0, 0, 0,
      JSON.stringify(conf),
      JSON.stringify({ [modelId]: model }),
      JSON.stringify(decks),
      JSON.stringify(dconf),
      '{}',
    ]);

    const insNote = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const insCard = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    cards.forEach((c, i) => {
      const nid = base + i;
      const front = esc(c.q);
      insNote.run([
        nid,
        guid(),
        modelId,
        nowSec,
        -1,
        ` 网课 ${tag} `,
        [front, esc(c.a), esc(`视频 @${fmtTime(c.time)}`)].join('\x1f'),
        front,
        csum(front),
        0,
        '',
      ]);
      // 新卡 due 取值沿用 genanki 惯例（= note id），仅作新卡排序位次
      insCard.run([base + 1_000_000 + i, nid, deckId, 0, nowSec, -1, 0, 0, nid, 0, 0, 0, 0, 0, 0, 0, 0, '']);
    });
    insNote.free();
    insCard.free();

    const sqlite = db.export();
    return zipSync({ 'collection.anki2': sqlite, media: strToU8('{}') });
  } finally {
    db.close();
  }
}
