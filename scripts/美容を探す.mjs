/**
 * 運営事業部・商品リサーチ担当 — 美容の候補を5つ出す
 * ------------------------------------------------------------------
 * 毎日19:00。条件に合う楽天の商品を5つ出し、上位3本を推して代表に提案する。
 * 決めるのは代表。ここは材料を揃えるところまで。
 *
 * 手順書: SNS運用サポート会社/部署/07_運営事業部/yuアカウント/01_商品リサーチ担当.md
 *
 * 価格帯を2つに分けている理由:
 *   楽天アフィリエイトは通常「1商品1個につき1,000円」まで。4%だと25,000円で上限に当たる。
 *     3,500円 × 4% =   140円
 *     8,000円 × 4% =   320円
 *    25,000円 × 4% = 1,000円（上限）
 *   安いものは数が出るが1件140円、高いものは数が出ないが1件1,000円。
 *   どちらが効くかまだ分かっていないので、両方出して数字の担当に判定させる。
 * ------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const 置き場 = 'neta/美容候補.jsonl';
const 設定パス = 'neta/設定.json';
const 検索 = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
const ランキング = 'https://app.rakuten.co.jp/services/api/IchibaItem/Ranking/20220601';

const アプリID = process.env.RAKUTEN_APP_ID;
const アクセスキー = process.env.RAKUTEN_ACCESS_KEY;
const アフィリエイトID = process.env.RAKUTEN_AFFILIATE_ID;
const リファラー = (process.env.RAKUTEN_REFERER ?? '').trim();
const 書かない = process.env.DRY_RUN === '1';
if (!アプリID || !アクセスキー || !アフィリエイトID) { console.error('::error::鍵が要ります'); process.exit(1); }
const ヘッダ = { accept: 'application/json' };
if (リファラー) { ヘッダ.referer = リファラー; ヘッダ.origin = new URL(リファラー).origin; }

// GitHub のログは落とせないので、読ませたい行は注記で出す
const 見せる = (文) => console.log(`::warning::${文}`);
const 眠る = (ms) => new Promise((r) => setTimeout(r, ms));

const 設定 = existsSync(設定パス) ? JSON.parse(readFileSync(設定パス, 'utf8')) : {};
const 決め = 設定['美容の探しかた'] ?? {};
const 何件出す = 決め['何件出す'] ?? 5;
const 最低レビュー数 = 決め['最低レビュー数'] ?? 500;
const 最低レビュー平均 = 決め['最低レビュー平均'] ?? 4.0;
const 上限報酬 = 決め['1件あたりの上限報酬'] ?? 1000;
const 高い帯を最低 = 決め['高い帯を最低いくつ'] ?? 1;
const 帯たち = 決め['価格帯'] ?? [
  { 名: '数が出る帯', 下: 2000, 上: 8000 },
  { 名: '上限に届く帯', 下: 25000, 上: 200000 },
];
const キーワード = 決め['キーワード'] ?? [
  '化粧水', '美容液', 'シャンプー', '日焼け止め', '美顔器', 'クレンジング',
  'オールインワン', 'ヘアオイル', '脱毛器', 'ドライヤー 美容',
];

async function 叩く(url, q) {
  for (let 回 = 1; 回 <= 3; 回 += 1) {
    const res = await fetch(`${url}?${q}`, { headers: ヘッダ });
    if (res.ok) return await res.json();
    const 文 = await res.text();
    if (res.status !== 429) throw new Error(`HTTP ${res.status} ${文.replace(/\s+/g, ' ').slice(0, 160)}`);
    await 眠る(2000 * 回);
  }
  throw new Error('レート制限');
}

async function 探す(語, 帯) {
  const q = new URLSearchParams({
    applicationId: アプリID, accessKey: アクセスキー, affiliateId: アフィリエイトID,
    keyword: 語, hits: '30', format: 'json', imageFlag: '1', sort: '-reviewCount',
    minPrice: String(帯.下), maxPrice: String(帯.上),
  });
  return ((await 叩く(検索, q)).Items ?? []).map((w) => w.Item ?? w).filter(Boolean);
}

/** 美容のランキング上位のitemCodeを集める。入っていれば候補に印を付ける。 */
async function ランキングを取る() {
  const 出 = new Map();
  for (const genreId of (決め['ランキングのジャンル'] ?? ['100939'])) {
    try {
      const q = new URLSearchParams({
        applicationId: アプリID, accessKey: アクセスキー, affiliateId: アフィリエイトID,
        genreId: String(genreId), format: 'json',
      });
      const items = ((await 叩く(ランキング, q)).Items ?? []).map((w) => w.Item ?? w);
      for (const x of items) if (x.itemCode) 出.set(x.itemCode, x.rank);
      console.log(`ランキング ${genreId}: ${items.length}件`);
    } catch (e) { 見せる(`ランキングが取れませんでした（${String(e.message ?? e).slice(0, 120)}）。順位なしで進めます`); }
    await 眠る(1100);
  }
  return 出;
}

const 報酬 = (x) => Math.min(Math.round((x.itemPrice ?? 0) * ((Number(x.affiliateRate) || 0) / 100)), 上限報酬);
const 人気 = (x) => Math.log10((x.reviewCount ?? 1) + 10) * ((x.reviewAverage ?? 4) / 5);
// 「薬用（医薬部外品）」は承認された効能を書けるぶん、投稿が作りやすい。少し上に置く。
const 点 = (x) => (報酬(x) / 100) * 人気(x) * (x.順位 ? 1.3 : 1) * (x.薬用 ? 1.2 : 1);

const 順位表 = await ランキングを取る();
const 帯ごと = new Map();
for (const 帯 of 帯たち) {
  const 集 = new Map();
  for (const 語 of キーワード) {
    try {
      for (const x of await 探す(語, 帯)) {
        if ((x.reviewCount ?? 0) < 最低レビュー数) continue;
        if ((x.reviewAverage ?? 0) < 最低レビュー平均) continue;
        if (集.has(x.itemCode)) continue;
        // 「薬用」「医薬部外品」と書いてあるものは、承認された効能を書ける幅が広い。
        // 化粧品は56項目しか書けない（2026-09-26 確認）。
        const 薬用 = /薬用|医薬部外品/.test(String(x.itemName ?? '')) ? true : false;
        集.set(x.itemCode, { ...x, キーワード: 語, 帯: 帯.名, 順位: 順位表.get(x.itemCode) ?? null, 薬用 });
      }
    } catch (e) { 見せる(`「${語}」（${帯.名}）で取れませんでした: ${String(e.message ?? e).slice(0, 120)}`); }
    await 眠る(1100);
  }
  帯ごと.set(帯.名, [...集.values()].sort((a, b) => 点(b) - 点(a)));
  console.log(`${帯.名}（${帯.下.toLocaleString()}〜${帯.上.toLocaleString()}円）… ${集.size}件`);
}

// 高い帯から最低ぶんを先に取り、残りを点の順で埋める
const 選ぶ = [];
const 入った = new Set();
const 高い = 帯ごと.get(帯たち[帯たち.length - 1].名) ?? [];
for (const x of 高い.slice(0, 高い帯を最低)) { 選ぶ.push(x); 入った.add(x.itemCode); }
const 全部 = [...帯ごと.values()].flat().sort((a, b) => 点(b) - 点(a));
for (const x of 全部) {
  if (選ぶ.length >= 何件出す) break;
  if (入った.has(x.itemCode)) continue;
  選ぶ.push(x); 入った.add(x.itemCode);
}
選ぶ.sort((a, b) => 点(b) - 点(a));

const きょう = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const 出 = 選ぶ.map((x, i) => ({
  番号: i + 1, itemCode: x.itemCode, 名: String(x.itemName ?? ''),
  価格: x.itemPrice, 料率: Number(x.affiliateRate) || null, 見込み報酬: 報酬(x),
  レビュー数: x.reviewCount, レビュー平均: x.reviewAverage, 順位: x.順位,
  薬用: x.薬用 === true,
  店: String(x.shopName ?? ''), 帯: x.帯, キーワード: x.キーワード,
  商品ページ: x.itemUrl, 出した日: きょう,
}));

if (出.length === 0) {
  console.error('::error::条件に合う商品が1件もありませんでした。条件.md を見直してください。');
  process.exit(1);
}

見せる(`【${きょう} 美容の候補 ${出.length}件】`);
for (const x of 出) {
  見せる(`${x.番号}. ${(x.価格 ?? 0).toLocaleString()}円 ／ 料率${x.料率 ?? '?'}% ／ 1件${x.見込み報酬.toLocaleString()}円 ／ ★${x.レビュー平均}(${(x.レビュー数 ?? 0).toLocaleString()}件)${x.順位 ? ` ／ ランキング${x.順位}位` : ''} ／ ${x.帯}${x.薬用 ? ' ／ 薬用' : ''}`);
  見せる(`   ${x.名.slice(0, 60)}`);
  見せる(`   ${x.商品ページ}`);
}
if (出.length < 何件出す) 見せる(`※ ${何件出す}件そろいませんでした（${出.length}件）。条件がきつすぎます`);

if (書かない) { console.log('DRY_RUN なので書きません。'); process.exit(0); }
mkdirSync('neta', { recursive: true });
writeFileSync(置き場, 出.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
console.log(`${置き場} に ${出.length}件を書きました。`);
