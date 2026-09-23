/**
 * 楽天ウェブサービスで商品を探し、neta/商品.jsonl を育てる
 * ------------------------------------------------------------------
 * このファイルは X のリポジトリにだけ置く。
 * ここで作る neta/商品.jsonl が、X と yu の両方が読む「1つの商品リスト」。
 * yu は https でこのファイルを読む（同じ商品を同じ日に出すため）。
 *
 * 1行1商品の JSON。中身:
 *   名 / url / 価格 / レビュー数 / レビュー平均 / ポイント倍 / セール / 店 /
 *   キーワード / 追加日 / 使ったことがある
 *
 * 決めていること:
 *   - affiliateId を渡して、返ってきた affiliateUrl をそのまま使う
 *     （リンクを自分で組み立てない。楽天が返すものが正）
 *   - 同じ商品は上書きして更新する。価格・レビュー・ポイント倍は動くので、
 *     毎回取り直したほうが「いまセール中か」が正しくなる
 *   - 「使ったことがある」は既定で false。実際に買って使ったら手で true にする。
 *     false のあいだ、compose.py は「使った感想」を書かせない
 *   - 在庫の上限まで。上限に達していたら、更新だけして新しいものは足さない
 *   - 1秒に1回まで（楽天は短時間の連続アクセスで応答しなくなる）
 *
 * 動かし方:
 *   RAKUTEN_APP_ID=… RAKUTEN_ACCESS_KEY=… RAKUTEN_AFFILIATE_ID=… \
 *   RAKUTEN_REFERER=https://… node scripts/商品を取る.mjs
 *   DRY_RUN=1 でファイルを書かずに結果だけ出す。
 * ------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const 設定パス = 'neta/設定.json';
const 商品パス = 'neta/商品.jsonl';
const エンドポイント = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';

const アプリID = process.env.RAKUTEN_APP_ID;
const アクセスキー = process.env.RAKUTEN_ACCESS_KEY;
const アフィリエイトID = process.env.RAKUTEN_AFFILIATE_ID;
const リファラー = (process.env.RAKUTEN_REFERER ?? '').trim();
const 書かない = process.env.DRY_RUN === '1';

// 楽天は Referer と Origin の両方を見る。片方だけだと
// REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING で 403 になる。
const オリジン = (() => {
  if (!リファラー) return '';
  try { return new URL(リファラー).origin; } catch {
    console.log('::warning::RAKUTEN_REFERER が URL の形になっていません');
    return '';
  }
})();

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

const 在庫の上限 = 探しかた['在庫の上限'] ?? 10;
const 一度に足す上限 = 探しかた['1回に入れる件数'] ?? 10;
const 最低レビュー数 = 探しかた['最低レビュー数'] ?? 0;
const 最低価格 = 探しかた['最低価格'] ?? null;
const 最高価格 = 探しかた['最高価格'] ?? null;

const 今 = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// いまの商品リストを読む（無ければ空）
const 既存 = existsSync(商品パス)
  ? readFileSync(商品パス, 'utf8').split('\n').filter((s) => s.trim()).map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean)
  : [];
const URLで引く = new Map(既存.map((x) => [x.url, x]));

console.log(`いまの商品リスト ${既存.length} 件（上限 ${在庫の上限}）`);
console.log(リファラー ? `リファラー: 設定あり（オリジン ${オリジン ? 'あり' : 'なし'}）` : 'リファラー: 未設定');

// 楽天に聞く
const 候補 = [];
for (const キーワード of 探しかた['キーワード']) {
  try {
    const items = await 探す(キーワード);
    console.log(`「${キーワード}」… ${items.length}件`);
    候補.push(...items.map((x) => ({ ...x, キーワード })));
  } catch (e) {
    console.log(`::warning::「${キーワード}」で取れませんでした: ${String(e.message ?? e).slice(0, 200)}`);
  }
  await new Promise((r) => setTimeout(r, 1100));
}

// すでにある商品は、価格とレビューとセールを更新する
let 更新数 = 0;
for (const x of 候補) {
  const 古い = URLで引く.get(x.affiliateUrl);
  if (!古い) continue;
  const 新 = 商品にする(x, 古い.追加日, 古い);
  新.使ったことがある = 古い.使ったことがある ?? false;
  新.成績 = 古い.成績 ?? null;
  if (JSON.stringify(古い) !== JSON.stringify(新)) 更新数 += 1;
  URLで引く.set(x.affiliateUrl, 新);
}

// 足りない分だけ新しく入れる
const 空き = Math.max(0, 在庫の上限 - URLで引く.size);
const 足せる数 = Math.min(一度に足す上限, 空き);
console.log(`更新 ${更新数} 件。空き ${空き} 件。今回足すのは最大 ${足せる数} 件。`);

const 見た = new Set();
const 足すもの = 足せる数 === 0 ? [] : 候補
  .filter((x) => {
    if (!x.affiliateUrl || URLで引く.has(x.affiliateUrl)) return false;
    if ((x.reviewCount ?? 0) < 最低レビュー数) return false;
    if (最低価格 && x.itemPrice < 最低価格) return false;
    if (最高価格 && x.itemPrice > 最高価格) return false;
    if (見た.has(x.itemCode)) return false;
    見た.add(x.itemCode);
    return true;
  })
  .sort((a, b) => 並び順(b) - 並び順(a))
  .slice(0, 足せる数)
  .map((x) => 商品にする(x, 今, null));

for (const x of 足すもの) URLで引く.set(x.url, x);

if (足すもの.length) {
  console.log('--- 足すもの ---');
  for (const x of 足すもの) {
    console.log(`+ ${x.名} ／ ${x.価格.toLocaleString()}円・レビュー${x.レビュー数}件${x.セール ? '・セール中' : ''}`);
  }
} else {
  console.log('新しく足すものはありません。');
}

const 出す = [...URLで引く.values()];
if (書かない) {
  console.log(`DRY_RUN なので書きません（書けば ${出す.length} 件になります）。`);
} else {
  writeFileSync(商品パス, 出す.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  console.log(`${商品パス} は ${出す.length} 件になりました。`);
}
出力('added', String(足すもの.length + 更新数));

// ------------------------------------------------------------------

function 商品にする(x, 追加日, 古い) {
  const ポイント倍 = Number(x.pointRate ?? 1) || 1;
  const 価格 = x.itemPrice ?? 0;
  // 「セール中」は投稿本文に書く事実になるので、確かめられるものだけを見る。
  // 商品名に「OFF」「クーポン」と書いてあるかは当てにならない（常時書いてある店がある）。
  // 見るのは2つだけ: 楽天が返すポイント倍率と、前回取ったときより安くなったか。
  const 前の価格 = 古い?.価格 ?? null;
  const 値下げ = Boolean(前の価格 && 価格 && 価格 < 前の価格);
  const セール = ポイント倍 > 1 || 値下げ;
  return {
    前の価格,
    値下げ,
    名: 名前を整える(x.itemName ?? ''),
    url: x.affiliateUrl,
    価格,
    レビュー数: x.reviewCount ?? 0,
    レビュー平均: x.reviewAverage ?? 0,
    ポイント倍,
    セール,
    店: (x.shopName ?? '').slice(0, 30),
    キーワード: x.キーワード ?? '',
    追加日: 追加日 ?? 今,
    使ったことがある: false,
    成績: null,
  };
}

// 新しく足すときの優先順。レビューが多く、セール中のものを先に。
function 並び順(x) {
  const ポイント倍 = Number(x.pointRate ?? 1) || 1;
  return (x.reviewCount ?? 0) * (ポイント倍 > 1 ? 1.5 : 1);
}

// 楽天の商品名は「【期間限定 P10倍】」「＼⭐8%OFFクーポン✨／」のような
// 煽り文句が前に付く。そのまま投稿に出すと読めないので、ここで落とす。
function 名前を整える(生) {
  let s = 生;
  s = s.replace(/[【［\[][^】］\]]{0,30}[】］\]]/g, ' ');
  s = s.replace(/[＼\\][^／\/]{0,30}[／\/]/g, ' ');
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, ' ');
  s = s.replace(/[♪★☆◆■◎※]/g, ' ');
  s = s.replace(/[|｜\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[\/／・,、\-–—]+|[\/／・,、\-–—]+$/g, '').trim();
  if (s.length <= 30) return s;
  const 切る = s.slice(0, 30);
  const 区切り = Math.max(
    切る.lastIndexOf(' '), 切る.lastIndexOf('/'), 切る.lastIndexOf('／'), 切る.lastIndexOf('、')
  );
  return (区切り > 10 ? 切る.slice(0, 区切り) : 切る).replace(/[\/／・,、\s]+$/, '').trim();
}

async function 探す(キーワード) {
  const q = new URLSearchParams({
    applicationId: アプリID,
    accessKey: アクセスキー,
    affiliateId: アフィリエイトID,
    keyword: キーワード,
    hits: '10',
    sort: '-reviewCount',
    imageFlag: '1',
    format: 'json',
  });
  if (最低価格) q.set('minPrice', String(最低価格));
  if (最高価格) q.set('maxPrice', String(最高価格));

  const ヘッダ = { accept: 'application/json' };
  if (リファラー) ヘッダ.referer = リファラー;
  if (オリジン) ヘッダ.origin = オリジン;

  let 最後;
  for (let 回 = 1; 回 <= 3; 回 += 1) {
    const res = await fetch(`${エンドポイント}?${q}`, { headers: ヘッダ });
    if (res.ok) {
      const data = await res.json();
      return (data.Items ?? []).map((w) => w.Item ?? w).filter(Boolean);
    }
    最後 = `HTTP ${res.status} ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`;
    if (res.status === 429) await new Promise((r) => setTimeout(r, 2000 * 回));
    else break;
  }
  throw new Error(最後);
}

function 出力(key, value) {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    try { writeFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, { flag: 'a' }); } catch {}
  }
}
