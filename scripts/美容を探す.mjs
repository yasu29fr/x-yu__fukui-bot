/**
 * 運営事業部・商品リサーチ担当 — 美容の候補を5つ出す
 * ------------------------------------------------------------------
 * 毎日19:00。条件に合う楽天の商品を5つ出し、上位3本を推して代表に提案する。
 * 決めるのは代表。ここは材料を揃えるところまで。
 *
 * 手順書: SNS運用サポート会社/部署/07_運営事業部/yuアカウント/01_商品リサーチ担当.md
 *
 * 2026-09-27 代表指示：「3,000〜5,000円台が最も買われる。その中で売れている・人気のあるものを。
 *   高額商品は提案に1つくらいあれば十分」
 *   → 売れ筋の帯（3,000〜5,999円）から4件、高い帯からは最大1件。
 *     売れ筋の帯は報酬ではなく「売れている・人気」（レビュー数・平均・ランキング）で並べる。
 *
 * 価格帯を2つに分けている理由（最初の考え方）:
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
const ランキング = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Ranking/20220601';

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

// 同じ日に2回走らせないための見張り。
// GitHub の schedule は落ちることがあるので、19:17 と 19:47 の2回仕掛けている。
// 1回目が成功していれば2回目は何もしない（番号が入れ替わると代表の選定とずれるため）。
if (process.env.SKIP_IF_FRESH === '1' && existsSync(置き場)) {
  const 行 = readFileSync(置き場, 'utf8').split('\n').filter((l) => l.trim());
  const きょう = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  if (行.length && JSON.parse(行[0]).出した日 === きょう) {
    console.log(`今日（${きょう}）の候補はもうあります（${行.length}件）。何もしません。`);
    process.exit(0);
  }
}

const 設定 = existsSync(設定パス) ? JSON.parse(readFileSync(設定パス, 'utf8')) : {};
const 決め = 設定['美容の探しかた'] ?? {};
const 何件出す = 決め['何件出す'] ?? 5;
const 最低レビュー数 = 決め['最低レビュー数'] ?? 500;
const 最低レビュー平均 = 決め['最低レビュー平均'] ?? 4.0;
const 上限報酬 = 決め['1件あたりの上限報酬'] ?? 1000;
const 帯ごとに最低 = 決め['帯ごとに最低いくつ'] ?? 2;
const 帯たち = 決め['価格帯'] ?? [
  // 並べかた: 人気＝売れている・レビューが多い順 ／ 点＝報酬も入れた順
  { 名: '売れ筋の帯', 下: 3000, 上: 5999, 最低: 4, 並べかた: '人気' },
  { 名: '高い帯', 下: 20000, 上: 30000, 最低: 1, 最大: 1, 並べかた: '点' },
];
const キーワード = 決め['キーワード'] ?? [
  '化粧水', '美容液', 'シャンプー', 'トリートメント', '日焼け止め', 'クレンジング',
  'オールインワン', 'ヘアオイル', 'ヘアマスク', '洗顔', 'ボディクリーム', 'まつげ美容液',
  '美顔器', 'ドライヤー 美容',
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
  // 美容・コスメ・香水（100939）に絞る。絞らないと「シャンプー」で浴室ラックが出た（2026-09-27）。
  // 美顔器・ドライヤーは家電のジャンルにあるので絞らない。
  if (!/美顔器|ドライヤー/.test(語)) q.set('genreId', 決め['検索のジャンル'] ?? '100939');
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
      // ランキングは新しいゲートウェイ側を使う。app.rakuten.co.jp の旧エンドポイントは
      // この鍵では applicationId が通らない（2026-09-26 確認）。
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
// 売れ筋の帯は「売れている・人気」で並べる。報酬で並べると帯の上のほう（5,000円台）ばかりになる
const 人気点 = (x) => 人気(x) * (x.順位 ? 1.5 : 1) * (x.薬用 ? 1.1 : 1);
const 並べる = (帯) => (a, b) => (帯.並べかた === '人気' ? 人気点(b) - 人気点(a) : 点(b) - 点(a));

// 出しても使えない候補を最初から外す（2026-09-27）。
// 同じ5件（脱毛器2・使用済み2）が毎日並び、実質1件しか選べなかった。
// 外す決まりは yu の「美容の投稿を作る.py」の自動選択と同じ。
const 上限価格 = 決め['自動で選べる上限価格'] ?? 30000;
const 空ける日数 = 14;
const 最近使った = new Set();
try {
  const url = 'https://raw.githubusercontent.com/yasu29fr/yasu29fr/claude/threads-auto-posting-uhiy6w/neta/'
    + encodeURIComponent('美容_決定ログ.jsonl');
  const 文 = await (await fetch(url)).text();
  const 今日 = Date.now() + 9 * 3600 * 1000;
  for (const l of 文.split('\n')) {
    if (!l.trim()) continue;
    const x = JSON.parse(l);
    if (x.itemCode && x.埋めた日 && (今日 - Date.parse(x.埋めた日)) / 86400000 < 空ける日数 + 1) 最近使った.add(x.itemCode);
  }
  console.log(`直近${空ける日数}日に使った商品: ${最近使った.size}件（外す）`);
} catch (e) { 見せる(`決定ログが読めませんでした（${String(e.message ?? e).slice(0, 80)}）`); }
const 使えない = (x) => {
  const 名 = String(x.itemName ?? '');
  if (最近使った.has(x.itemCode)) return true;
  if (/脱毛/.test(名)) return true;                 // 「永久脱毛」と書けず、書ける幅が狭い
  if ((x.itemPrice ?? 0) > 上限価格) return true;   // Threads の流れで買われにくい
  if (/美白/.test(名) && !/薬用|医薬部外品/.test(名)) return true; // 効能を書けない
  if (/\d{1,2}\/\d{1,2}\s*[\(（]/.test(名)) return true; // クーポンの日付入りは数日で嘘になる
  if (/[〜~]\s*\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}/.test(名)) return true; // 「〜9月25日23:59」の形も（2026-09-27）
  return false;
};

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
        if (使えない(x)) continue;
        // 「薬用」「医薬部外品」と書いてあるものは、承認された効能を書ける幅が広い。
        // 化粧品は56項目しか書けない（2026-09-26 確認）。
        const 薬用 = /薬用|医薬部外品/.test(String(x.itemName ?? '')) ? true : false;
        集.set(x.itemCode, { ...x, キーワード: 語, 帯: 帯.名, 順位: 順位表.get(x.itemCode) ?? null, 薬用 });
      }
    } catch (e) { 見せる(`「${語}」（${帯.名}）で取れませんでした: ${String(e.message ?? e).slice(0, 120)}`); }
    await 眠る(1100);
  }
  帯ごと.set(帯.名, [...集.values()].sort(並べる(帯)));
  console.log(`${帯.名}（${帯.下.toLocaleString()}〜${帯.上.toLocaleString()}円）… ${集.size}件`);
}

// 帯ごとに枠を分ける。
// 点だけで並べると高い帯が全部を取る（2026-09-26、5件とも高い帯になった）。
// 高い帯は価格がちがっても全部1,000円の上限に張りつくので、点が横並びで高くなる。
// 安い帯（1件140〜320円）とは比べられない。だから帯ごとに最低ぶんを確保する。
const 選ぶ = [];
const 入った = new Set();
for (const 帯 of 帯たち) {
  const たち = 帯ごと.get(帯.名) ?? [];
  const 枠 = 帯.最低 ?? 帯ごとに最低;
  // 同じ店から2件出さない（2026-09-27、アテニアの化粧水が2件並んだ）
  let 取った = 0;
  for (const x of たち) {
    if (取った >= 枠 || 選ぶ.length >= 何件出す) break;
    if (入った.has(x.itemCode) || 選ぶ.some((y) => y.shopName === x.shopName)) continue;
    選ぶ.push(x); 入った.add(x.itemCode); 取った++;
  }
  console.log(`  ${帯.名}: ${たち.length}件から ${Math.min(枠, たち.length)}件`);
}
// 足りないぶんは、上限（最大）のある帯を除いて帯の順に埋める（高い帯は最大1件まで）
for (const 帯 of 帯たち) {
  if (帯.最大 != null) continue;
  for (const x of 帯ごと.get(帯.名) ?? []) {
    if (選ぶ.length >= 何件出す) break;
    if (入った.has(x.itemCode) || 選ぶ.some((y) => y.shopName === x.shopName)) continue;
    選ぶ.push(x); 入った.add(x.itemCode);
  }
}
// 並びは帯の順（売れ筋が先、高い帯は最後）。番号1が第一候補になる
const 帯の順 = new Map(帯たち.map((b, i) => [b.名, i]));
選ぶ.sort((a, b) => (帯の順.get(a.帯) - 帯の順.get(b.帯))
  || 並べる(帯たち[帯の順.get(a.帯)])(a, b));

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
