/**
 * 福井県のふるさと納税の返礼品を集めて neta/ふるさと納税.jsonl を作る
 * ------------------------------------------------------------------
 * 楽天ふるさと納税は楽天市場の中にあるので、市場の商品検索APIで拾える。
 *
 * 2026-09-25、集め方を「レビュー数順」から「料率順」に変えた。
 *   楽天アフィリエイトでは、ふるさと納税は料率アップの対象で、
 *   通常商品の「1商品1個1,000円」の上限が外れる。
 *   代表が福井県の一覧を料率順で見たところ 10.0% の返礼品が実在した。
 *   宿（1%）とくらべて1件あたりの報酬が桁で違うので、集める順番を料率にした。
 *
 * 商品検索APIは affiliateId を渡すと affiliateRate を返し、
 * minAffiliateRate / maxAffiliateRate で絞り込み、sort=-affiliateRate で
 * 並べ替えができる。 https://webservice.rakuten.co.jp/documentation/ichiba-item-search
 *
 * 決めていること:
 *   - **福井県のものだけ入れる。** 店名か商品名に福井県の自治体名が
 *     入っていないものは捨てる（「ふるさと納税」で検索すると全国が返るため）
 *   - 料率の高いものを先に拾う。ただし料率だけで並べると同じ自治体・同じ
 *     金額帯で埋まるので、自治体ごと・金額帯ごとに枠を分ける
 *     （投稿の切り口が「1万円まで／1万円台／ちょっと奮発」で分かれているため）
 *   - affiliateUrl をそのまま使う
 *   - 料率は投稿には書かない。こちらの取り分の話で、読む人には関係がない
 * ------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const 置き場 = 'neta/ふるさと納税.jsonl';
const 設定パス = 'neta/設定.json';
const エンドポイント = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';

const アプリID = process.env.RAKUTEN_APP_ID;
const アクセスキー = process.env.RAKUTEN_ACCESS_KEY;
const アフィリエイトID = process.env.RAKUTEN_AFFILIATE_ID;
const リファラー = (process.env.RAKUTEN_REFERER ?? '').trim();
const 書かない = process.env.DRY_RUN === '1';
if (!アプリID || !アクセスキー || !アフィリエイトID) { console.error('::error::鍵が要ります'); process.exit(1); }

const ヘッダ = { accept: 'application/json' };
if (リファラー) { ヘッダ.referer = リファラー; ヘッダ.origin = new URL(リファラー).origin; }

// DRY_RUN のときは GitHub のログが落とせないので、注記として出して読めるようにする
const 見せる = (文) => console.log(書かない ? `::warning::${文}` : 文);

const 設定 = existsSync(設定パス) ? JSON.parse(readFileSync(設定パス, 'utf8')) : {};
const 決め = 設定['ふるさと納税の集めかた'] ?? {};
const 上限 = 決め['上位いくつ'] ?? 30;
const 自治体ごとに最大 = 決め['自治体ごとに最大'] ?? 3;
const 最低レビュー数 = 決め['最低レビュー数'] ?? 3;
const 最低価格 = 決め['最低価格'] ?? 5000;
const 最高価格 = 決め['最高価格'] ?? 50000;
const 最低料率 = 決め['最低料率'] ?? 5.0;
// 料率アップ中の自治体。APIには料率アップが乗らないので、
// 楽天アフィリエイトの一覧を代表が見て分かったものをここに書く。
// この自治体の品は 1商品1,000円の上限が外れる。
const 料率アップの自治体 = 決め['料率アップの自治体'] ?? {};

// 設定では「上限なし」を null で書く（JSONに Infinity が無いため）
const 金額帯 = (決め['金額帯'] ?? [
  { 名: '1万円まで', 下: 0, 上: 10000 },
  { 名: '1万円台', 下: 10000, 上: 20000 },
  { 名: 'ちょっと奮発', 下: 20000, 上: null },
]).map((b) => ({ ...b, 下: b.下 ?? 0, 上: b.上 ?? Infinity }));
const キーワード = 決め['キーワード'] ?? [
  'ふるさと納税 福井県', 'ふるさと納税 福井', 'ふるさと納税 越前がに', 'ふるさと納税 福井 米',
  'ふるさと納税 若狭牛', 'ふるさと納税 福井 羽二重', 'ふるさと納税 越前市', 'ふるさと納税 鯖江',
  'ふるさと納税 敦賀', 'ふるさと納税 小浜 鯖', 'ふるさと納税 あわら', 'ふるさと納税 勝山',
  'ふるさと納税 坂井市', 'ふるさと納税 大野市',
];

// 福井県の自治体。店名か商品名にこれが入っていないものは福井のものではない。
const 市町 = ['福井市', '敦賀市', '小浜市', '大野市', '勝山市', '鯖江市', 'あわら市', '越前市',
  '坂井市', '永平寺町', '池田町', '南越前町', '越前町', '美浜町', '高浜町', 'おおい町', '若狭町', '福井県'];

const 眠る = (ms) => new Promise((r) => setTimeout(r, ms));

async function 叩く(q) {
  for (let 回 = 1; 回 <= 3; 回 += 1) {
    const res = await fetch(`${エンドポイント}?${q}`, { headers: ヘッダ });
    if (res.ok) return ((await res.json()).Items ?? []).map((w) => w.Item ?? w).filter(Boolean);
    const 文 = await res.text();
    if (res.status === 400) { const e = new Error(`HTTP 400 ${文.replace(/\s+/g, ' ').slice(0, 200)}`); e.入力が悪い = true; throw e; }
    if (res.status !== 429) throw new Error(`HTTP ${res.status} ${文.replace(/\s+/g, ' ').slice(0, 200)}`);
    await 眠る(2000 * 回);
  }
  throw new Error('レート制限');
}

let 料率で絞れる = true;

/** 料率の高い順に拾う。楽天が料率の条件を受け付けなければレビュー数順に戻す。 */
async function 探す(キーワード, 料率順) {
  const q = new URLSearchParams({
    applicationId: アプリID, accessKey: アクセスキー, affiliateId: アフィリエイトID,
    keyword: キーワード, hits: '30', imageFlag: '1', format: 'json',
    minPrice: String(最低価格), maxPrice: String(最高価格),
    sort: 料率順 ? '-affiliateRate' : '-reviewCount',
  });
  if (料率順) q.set('minAffiliateRate', String(最低料率));
  try {
    return await 叩く(q);
  } catch (e) {
    if (料率順 && e.入力が悪い) {
      console.log(`::warning::楽天が料率の条件を受け付けませんでした（${String(e.message).slice(0, 120)}）。レビュー数順に切り替えます。`);
      料率で絞れる = false;
      return [];
    }
    throw e;
  }
}

const 料率を読む = (x) => {
  const v = Number(x.affiliateRate);
  return Number.isFinite(v) && v > 0 ? v : null;
};

// 手で選んだ品（料率アップ対象など）。APIでは料率アップが分からないので、
// 楽天アフィリエイトの一覧を料率順で見て見つけたものをここに書く。
// 形: {"itemCode","名","url","自治体","寄付額","料率","料率アップ":true,"メモ"}
const 手動の置き場 = 'neta/ふるさと納税_手動.jsonl';
const 手動 = existsSync(手動の置き場)
  ? readFileSync(手動の置き場, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];

const 集まり = new Map();
function 入れる(x, k, 経路) {
  const 名 = x.itemName ?? '', 店 = x.shopName ?? '';
  // 「大野市」は大分県の豊後大野市にも含まれる（2026-09-25、椎茸が3件まぎれた）。
  // 自治体名だけで判じると他県が入るので、まず福井のものかを見る。
  // 楽天ふるさと納税の店名は「福井県○○市」の形になっている。
  if (!/福井/.test(店) && !/福井県/.test(名)) return false;
  const 自治体 = 市町.find((m) => 店.includes(m)) ?? 市町.find((m) => 名.includes(m));
  if (!自治体) return false;
  if (!/ふるさと納税/.test(名)) return false;
  if ((x.reviewCount ?? 0) < 最低レビュー数) return false;
  const 前 = 集まり.get(x.itemCode);
  if (前) { if (経路 === '料率順') 前.経路 = '料率順'; return false; }
  const 上がる = 料率アップの自治体[自治体];
  集まり.set(x.itemCode, {
    ...x, 自治体, キーワード: k, 経路,
    料率: 上がる ?? 料率を読む(x),
    料率アップ: 上がる != null,
  });
  return true;
}

for (const h of 手動) {
  const コード = h.itemCode ?? h.url;
  集まり.set(コード, {
    itemCode: コード, itemName: h.名, affiliateUrl: h.url, shopName: h.店 ?? h.自治体,
    itemPrice: h.寄付額, reviewCount: h.レビュー数 ?? 30, reviewAverage: h.レビュー平均 ?? 4.3,
    自治体: h.自治体, キーワード: '手で選んだ', 経路: '手動', 料率: h.料率 ?? null,
    料率アップ: h.料率アップ === true, 手で選んだ: true, メモ: h.メモ ?? '',
  });
}
if (手動.length) 見せる(`手で選んだ品を ${手動.length}件 入れました`);

for (const k of キーワード) {
  for (const 料率順 of (料率で絞れる ? [true, false] : [false])) {
    if (料率順 && !料率で絞れる) continue;
    try {
      const items = await 探す(k, 料率順);
      let 通した = 0;
      for (const x of items) if (入れる(x, k, 料率順 ? '料率順' : 'レビュー順')) 通した += 1;
      if (items.length) console.log(`「${k}」${料率順 ? `（料率${最低料率}%以上）` : '（レビュー順）'}… ${items.length}件中 ${通した}件が福井`);
    } catch (e) { console.log(`::warning::「${k}」で取れませんでした: ${String(e.message ?? e).slice(0, 160)}`); }
    await 眠る(1100);
  }
}
見せる(`重複を除いて ${集まり.size}件`);

const 料率あり = [...集まり.values()].filter((x) => x.料率 != null && !x.料率アップ);
if (料率あり.length === 0) {
  console.log('::warning::料率が1件も取れませんでした。affiliateId が渡っているか確認してください。');
} else {
  const 並 = 料率あり.map((x) => x.料率).sort((a, b) => b - a);
  見せる(`料率が取れたのは ${料率あり.length}件。最高 ${並[0]}% ／ 中央 ${並[Math.floor(並.length / 2)]}% ／ 最低 ${並[並.length - 1]}%`);
}

// 点＝見込み報酬 × 人気。
// 上限の話: 楽天アフィリエイトは通常「1商品1個につき1,000円」までしか付かない。
// 料率アップ対象の商品だけ、この上限が外れる。
// APIが返す affiliateRate は通常料率で、料率アップぶんは入っていない
// （2026-09-25 確認。福井のふるさと納税はAPIでは最高4%だが、
//  アフィリエイトの一覧では10.0%の返礼品があった）。
// なので、手で選んだ料率アップの品だけ上限を外す。
const 上限報酬 = 決め['1件あたりの上限報酬'] ?? 1000;
const 中央料率 = 料率あり.length
  ? 料率あり.map((x) => x.料率).sort((a, b) => a - b)[Math.floor(料率あり.length / 2)] : 3.0;
const 人気 = (x) => Math.log10((x.reviewCount ?? 1) + 10) * ((x.reviewAverage ?? 3.5) / 5);
const 見込み = (x) => {
  const 生 = Math.round((x.itemPrice ?? 0) * ((x.料率 ?? 中央料率) / 100));
  return x.料率アップ ? 生 : Math.min(生, 上限報酬);
};
// 売れ筋の帯に重みを付ける。1件あたりの報酬だけで並べると高額品が上に来るが、
// レビュー数で見るかぎり、実際に数が出るのは1万円前後（2026-09-25 実測）。
const 売れ筋 = 決め['売れ筋の寄付額'] ?? { 下: 6000, 上: 15000, 重み: 1.6 };
const 売れ筋か = (x) => (x.itemPrice ?? 0) >= (売れ筋.下 ?? 0) && (x.itemPrice ?? 0) <= (売れ筋.上 ?? 1e12);
// 並べ方は2つに分ける（2026-09-25 代表判断）。
//   > 鯖江市の狙うのは2、3割で残りは鉄板商品で。
//   > 売れ筋を大量に販売するほうが、商売の本質だと思います。
//
//   鉄板（大多数）… レビュー数が多く、売れ筋の寄付額のもの。
//                    1件あたりの報酬は主役にしない。数が出ることを優先する
//   料率アップ（2〜3割）… 鯖江市の10%の品。1件あたりが大きいぶんを乗せる
const 鉄板の点 = (x) => 人気(x)
  * (売れ筋か(x) ? (売れ筋.重み ?? 1.6) : 1)
  * (1 + 見込み(x) / 2000)          // 報酬は効かせるが、主役にはしない
  * (x.手で選んだ ? 1.5 : 1);
const 点 = 鉄板の点;
const アップの割合 = 決め['料率アップの割合'] ?? 0.25;

const 手で = [...集まり.values()].filter((x) => x.手で選んだ);
const アップ勢 = [...集まり.values()].filter((x) => !x.手で選んだ && x.料率アップ);
const 鉄板勢 = [...集まり.values()].filter((x) => !x.手で選んだ && !x.料率アップ);

// 鉄板は自治体ごとに上位を取る（返礼品が偏らないように）
const 自治体ごと = new Map();
for (const x of 鉄板勢) {
  if (!自治体ごと.has(x.自治体)) 自治体ごと.set(x.自治体, []);
  自治体ごと.get(x.自治体).push(x);
}
const 鉄板の候補 = [];
for (const [名, たち] of [...自治体ごと].sort((a, b) => a[0].localeCompare(b[0], 'ja'))) {
  たち.sort((a, b) => 鉄板の点(b) - 鉄板の点(a));
  鉄板の候補.push(...たち.slice(0, 自治体ごとに最大));
  console.log(`  ${名}: ${たち.length}件 → 上位${Math.min(自治体ごとに最大, たち.length)}件`);
}

// 料率アップは全体の2〜3割まで
const アップの枠 = Math.max(0, Math.round((上限 - 手で.length) * アップの割合));
アップ勢.sort((a, b) => 鉄板の点(b) - 鉄板の点(a));
const アップ採用 = アップ勢.slice(0, アップの枠);
if (アップ勢.length) {
  見せる(`料率アップ（${Object.keys(料率アップの自治体).join('・')}）… ${アップ勢.length}件から ${アップ採用.length}件（全体の${Math.round(アップの割合 * 100)}%まで）`);
}

const 選ぶ = [...手で, ...アップ採用];
const 入った = new Set(選ぶ.map((x) => x.itemCode));

// 鉄板は金額帯ごとに枠を分ける。切り口ごとに件数をそろえるため。
const 鉄板の枠 = 上限 - 選ぶ.length;
const 帯の枠 = Math.ceil(鉄板の枠 / 金額帯.length);
for (const 帯 of 金額帯) {
  const たち = 鉄板の候補
    .filter((x) => !入った.has(x.itemCode) && (x.itemPrice ?? 0) >= 帯.下 && (x.itemPrice ?? 0) < 帯.上)
    .sort((a, b) => 鉄板の点(b) - 鉄板の点(a)).slice(0, 帯の枠);
  for (const x of たち) { 選ぶ.push(x); 入った.add(x.itemCode); }
  console.log(`  ${帯.名}: ${たち.length}件`);
}
for (const x of 鉄板の候補.sort((a, b) => 鉄板の点(b) - 鉄板の点(a))) {
  if (選ぶ.length >= 上限) break;
  if (入った.has(x.itemCode)) continue;
  選ぶ.push(x); 入った.add(x.itemCode);
}

function 名前を整える(生) {
  let s = String(生);
  s = s.replace(/[【［\[][^】］\]]{0,30}[】］\]]/g, ' ').replace(/[＼\\][^／\/]{0,30}[／\/]/g, ' ');
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ').replace(/[♪★☆◆■◎※]/g, ' ');
  s = s.replace(/[|｜\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= 36) return s;
  const 切 = s.slice(0, 36);
  const 区 = Math.max(切.lastIndexOf(' '), 切.lastIndexOf('/'), 切.lastIndexOf('、'));
  return (区 > 12 ? 切.slice(0, 区) : 切).replace(/[\/／・,、\s]+$/, '').trim();
}

const きょう = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const 出 = 選ぶ.sort((a, b) => 鉄板の点(b) - 鉄板の点(a)).slice(0, 上限).map((x) => ({
  itemCode: x.itemCode, 名: 名前を整える(x.itemName), url: x.affiliateUrl,
  自治体: x.自治体, 寄付額: x.itemPrice, 料率: x.料率, 料率アップ: x.料率アップ === true,
  見込み報酬: 見込み(x), 手で選んだ: x.手で選んだ === true,
  レビュー数: x.reviewCount, レビュー平均: x.reviewAverage,
  店: (x.shopName ?? '').slice(0, 30), キーワード: x.キーワード, 追加日: きょう,
}));

見せる('--- 入れるもの ---');
for (const x of 出) {
  見せる(`  ${x.自治体}／${(x.寄付額 ?? 0).toLocaleString()}円／料率${x.料率 ?? '?'}%（見込み${x.見込み報酬.toLocaleString()}円）／レビュー${x.レビュー数}　${x.名}`);
}
const 合計 = 出.reduce((a, x) => a + (x.料率 ?? 0), 0);
if (出.length) 見せる(`料率の平均 ${(合計 / 出.length).toFixed(1)}%（前は料率を見ずに集めていた）`);

// 集めそこねた日に、前のリストを消してしまわないようにする。
// このスクリプトは毎回ゼロから作り直すので、楽天が返さなかった日は 0 件になる。
// 「集まらなかった」と「返礼品が無い」は違う（2026-09-23、宿で同じ穴を踏んだ）。
if (出.length === 0) {
  console.error('::error::1件も集まりませんでした。'
    + 'これまでのリストを消さないため、今回は書き込みません。');
  process.exit(1);
}
if (existsSync(置き場)) {
  const 前の数 = readFileSync(置き場, 'utf8').split('\n').filter((l) => l.trim()).length;
  if (前の数 >= 5 && 出.length < 前の数 / 2) {
    console.error(`::error::今回 ${出.length}件。前回は ${前の数}件でした。`
      + '半分以下に減ったので、取りこぼしとみなして書き込みません。');
    process.exit(1);
  }
}

if (書かない) { console.log('DRY_RUN なので書きません。'); process.exit(0); }
mkdirSync('neta', { recursive: true });
writeFileSync(置き場, 出.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
console.log(`${置き場} に ${出.length}件を書きました。`);
