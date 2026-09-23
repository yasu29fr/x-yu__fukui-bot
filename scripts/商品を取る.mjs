/**
 * 楽天ウェブサービスで商品を探し、ネタ帳の「紹介する商品」に書き足す
 * ------------------------------------------------------------------
 * 何をするか:
 *   neta/設定.json の「商品の探しかた」にあるキーワードで楽天市場を検索し、
 *   アフィリエイトリンク付きの商品を neta/ネタ帳.md の
 *   「## 紹介する商品」に  - 商品名 | URL | 一言メモ  の形で追記する。
 *   投稿文は書かない。書くのは compose.py の仕事。
 *
 * 動かし方:
 *   RAKUTEN_APP_ID=xxx RAKUTEN_ACCESS_KEY=xxx RAKUTEN_AFFILIATE_ID=xxx \
 *   node scripts/商品を取る.mjs
 *   DRY_RUN=1 でファイルを書かずに結果だけ出す。
 *
 * 決めていること:
 *   - affiliateId を渡して、返ってきた affiliateUrl をそのまま使う。
 *     リンクを自分で組み立てない（楽天が返すものが正）
 *   - メモの先頭に「[未使用]」を付ける。検索で見つけただけの商品なので、
 *     compose.py 側でこの印を見て「使った感想」を書かせないようにする
 *   - メモに「使っている」と書かない。事実（レビュー数・価格）だけを書く
 *   - すでにネタ帳にある商品URLは入れない
 *   - 1秒に1回までにする（楽天は短時間の連続アクセスで応答しなくなる）
 *
 * 依存なし（Node 20 以上の fetch をそのまま使う）。
 * ------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const 設定パス = 'neta/設定.json';
const ネタ帳パス = 'neta/ネタ帳.md';
const 商品見出し = '## 紹介する商品';
const エンドポイント = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';

const アプリID = process.env.RAKUTEN_APP_ID;
const アクセスキー = process.env.RAKUTEN_ACCESS_KEY;
const アフィリエイトID = process.env.RAKUTEN_AFFILIATE_ID;
const 書かない = process.env.DRY_RUN === '1';

function 止まる(文) {
  console.error(`::error::${文}`);
  process.exit(1);
}

if (!アプリID || !アクセスキー) 止まる('RAKUTEN_APP_ID と RAKUTEN_ACCESS_KEY が要ります');
if (!アフィリエイトID) 止まる('RAKUTEN_AFFILIATE_ID が要ります。無いとアフィリエイトリンクになりません');
if (!existsSync(設定パス)) 止まる(`${設定パス} がありません`);

const 設定 = JSON.parse(readFileSync(設定パス, 'utf8'));
const 探しかた = 設定['商品の探しかた'];
if (!探しかた || !(探しかた['キーワード'] ?? []).length) {
  console.log('設定.json に「商品の探しかた」がありません。何もしません。');
  process.exit(0);
}

const ネタ帳 = existsSync(ネタ帳パス) ? readFileSync(ネタ帳パス, 'utf8') : '';
const 既存URL = new Set([...ネタ帳.matchAll(/https?:\/\/[^\s|)）]+/g)].map((m) => m[0]));

const 入れる件数 = 探しかた['1回に入れる件数'] ?? 3;
const 最低レビュー数 = 探しかた['最低レビュー数'] ?? 0;
const 最低価格 = 探しかた['最低価格'] ?? null;
const 最高価格 = 探しかた['最高価格'] ?? null;

const 候補 = [];
for (const キーワード of 探しかた['キーワード']) {
  try {
    const items = await 探す(キーワード);
    console.log(`「${キーワード}」… ${items.length}件`);
    候補.push(...items.map((x) => ({ ...x, キーワード })));
  } catch (e) {
    console.log(`::warning::「${キーワード}」で取れませんでした: ${String(e.message ?? e).slice(0, 120)}`);
  }
  await new Promise((r) => setTimeout(r, 1100)); // 楽天は連続アクセスに弱い
}

// レビューが多い順。同じ商品は1つに。
const 見た = new Set();
const 並べた = 候補
  .filter((x) => {
    if (!x.affiliateUrl || 既存URL.has(x.affiliateUrl)) return false;
    if (x.reviewCount < 最低レビュー数) return false;
    if (最低価格 && x.itemPrice < 最低価格) return false;
    if (最高価格 && x.itemPrice > 最高価格) return false;
    if (見た.has(x.itemCode)) return false;
    見た.add(x.itemCode);
    return true;
  })
  .sort((a, b) => b.reviewCount - a.reviewCount)
  .slice(0, 入れる件数);

if (!並べた.length) {
  console.log('入れられる商品がありませんでした。ファイルは変えません。');
  出力('added', '0');
  process.exit(0);
}

const 行 = 並べた.map((x) => {
  const 名 = x.itemName.replace(/[|｜\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  // 「[未使用]」は compose.py が読む印。
  // これが付いている商品は、本人がまだ使っていない＝使った感想を書かせない。
  const メモ = `[未使用] 楽天の「${x.キーワード}」の検索結果から。${x.itemPrice.toLocaleString()}円・レビュー${x.reviewCount}件（${x.shopName}）`;
  return `- ${名} | ${x.affiliateUrl} | ${メモ}`;
});

console.log('--- 入れるもの ---');
for (const l of 行) console.log(l);

if (書かない) {
  console.log('DRY_RUN なので書きません。');
} else {
  writeFileSync(ネタ帳パス, 節の終わりに入れる(ネタ帳, 商品見出し, 行.join('\n')), 'utf8');
  console.log(`${ネタ帳パス} に ${行.length}件を追記しました。`);
}
出力('added', String(行.length));

// ------------------------------------------------------------------

async function 探す(キーワード) {
  const q = new URLSearchParams({
    applicationId: アプリID,
    accessKey: アクセスキー,
    affiliateId: アフィリエイトID,
    keyword: キーワード,
    hits: '10',
    sort: '-reviewCount',
    imageFlag: '1',
    format: 'json'
  });
  if (最低価格) q.set('minPrice', String(最低価格));
  if (最高価格) q.set('maxPrice', String(最高価格));

  let 最後;
  for (let 回 = 1; 回 <= 3; 回 += 1) {
    const res = await fetch(`${エンドポイント}?${q}`, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      return (data.Items ?? []).map((w) => w.Item ?? w).filter(Boolean);
    }
    最後 = `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`;
    if (res.status === 429) await new Promise((r) => setTimeout(r, 2000 * 回));
    else break;
  }
  throw new Error(最後);
}

// 節のいちばん下に足す。
// 見出しのすぐ下に入れると、節の説明文より上に商品が並んでしまう。
// 下に足すと、古いものから順に紹介される（compose.py は未紹介の先頭を取る）。
function 節の終わりに入れる(md, 見出し文字, 塊) {
  const i = md.indexOf(見出し文字);
  if (i === -1) return `${md.trimEnd()}\n\n${見出し文字}\n\n${塊}\n`;
  const 次の見出し = md.slice(i + 見出し文字.length).search(/\n## /);
  const 節の終わり = 次の見出し === -1 ? md.length : i + 見出し文字.length + 次の見出し;
  const 前 = md.slice(0, 節の終わり).trimEnd();
  return `${前}\n${塊}\n${md.slice(節の終わり)}`;
}

function 出力(key, value) {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    try {
      writeFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, { flag: 'a' });
    } catch {}
  }
}
