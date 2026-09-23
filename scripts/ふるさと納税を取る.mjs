/**
 * 福井県のふるさと納税の返礼品を集めて neta/ふるさと納税.jsonl を作る
 * ------------------------------------------------------------------
 * 楽天ふるさと納税は楽天市場の中にあるので、市場の商品検索APIで拾える。
 * 楽天アフィリエイト公式によると、ふるさと納税は料率アップの対象で、
 * 通常商品の1,000円上限を超える。需要は秋から冬に伸びる。
 *
 * 決めていること:
 *   - **福井県のものだけ入れる。** 店名か商品名に福井県の自治体名が
 *     入っていないものは捨てる（「ふるさと納税」で検索すると全国が返るため）
 *   - 同じ自治体から何件も入れない（返礼品が偏るため）
 *   - affiliateUrl をそのまま使う
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

const 設定 = existsSync(設定パス) ? JSON.parse(readFileSync(設定パス, 'utf8')) : {};
const 決め = 設定['ふるさと納税の集めかた'] ?? {};
const 上限 = 決め['上位いくつ'] ?? 12;
const 自治体ごとに最大 = 決め['自治体ごとに最大'] ?? 2;
const 最低レビュー数 = 決め['最低レビュー数'] ?? 5;
const 最低価格 = 決め['最低価格'] ?? 5000;
const 最高価格 = 決め['最高価格'] ?? 50000;
const キーワード = 決め['キーワード'] ?? [
  'ふるさと納税 越前がに', 'ふるさと納税 福井 米', 'ふるさと納税 若狭牛',
  'ふるさと納税 福井 羽二重餅', 'ふるさと納税 越前市', 'ふるさと納税 鯖江 めがね',
  'ふるさと納税 敦賀 昆布', 'ふるさと納税 小浜 鯖', 'ふるさと納税 あわら', 'ふるさと納税 勝山',
];

// 福井県の自治体。店名か商品名にこれが入っていないものは福井のものではない。
const 市町 = ['福井市', '敦賀市', '小浜市', '大野市', '勝山市', '鯖江市', 'あわら市', '越前市',
  '坂井市', '永平寺町', '池田町', '南越前町', '越前町', '美浜町', '高浜町', 'おおい町', '若狭町', '福井県'];

async function 探す(キーワード) {
  const q = new URLSearchParams({
    applicationId: アプリID, accessKey: アクセスキー, affiliateId: アフィリエイトID,
    keyword: キーワード, hits: '20', sort: '-reviewCount', imageFlag: '1', format: 'json',
    minPrice: String(最低価格), maxPrice: String(最高価格),
  });
  for (let 回 = 1; 回 <= 3; 回 += 1) {
    const res = await fetch(`${エンドポイント}?${q}`, { headers: ヘッダ });
    if (res.ok) return ((await res.json()).Items ?? []).map((w) => w.Item ?? w).filter(Boolean);
    const 文 = await res.text();
    if (res.status !== 429) throw new Error(`HTTP ${res.status} ${文.replace(/\s+/g, ' ').slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 2000 * 回));
  }
  throw new Error('レート制限');
}

const 集まり = new Map();
for (const k of キーワード) {
  try {
    const items = await 探す(k);
    let 通した = 0;
    for (const x of items) {
      const 名 = x.itemName ?? '', 店 = x.shopName ?? '';
      // 福井のものかを確かめる。全国のふるさと納税が返ってくるため。
      const 自治体 = 市町.find((m) => 名.includes(m) || 店.includes(m));
      if (!自治体) continue;
      if (!/ふるさと納税/.test(名)) continue;
      if ((x.reviewCount ?? 0) < 最低レビュー数) continue;
      if (集まり.has(x.itemCode)) continue;
      集まり.set(x.itemCode, { ...x, 自治体, キーワード: k });
      通した += 1;
    }
    console.log(`「${k}」… ${items.length}件中 ${通した}件が福井`);
  } catch (e) { console.log(`::warning::「${k}」で取れませんでした: ${String(e.message ?? e).slice(0, 160)}`); }
  await new Promise((r) => setTimeout(r, 1100));
}
console.log(`\n重複を除いて ${集まり.size}件`);

// 自治体ごとに上位を取ってから全体で並べる（返礼品が偏らないように）
const 点 = (x) => (x.reviewAverage ?? 0) * Math.log10((x.reviewCount ?? 1) + 10);
const 自治体ごと = new Map();
for (const x of 集まり.values()) {
  if (!自治体ごと.has(x.自治体)) 自治体ごと.set(x.自治体, []);
  自治体ごと.get(x.自治体).push(x);
}
const 候補 = [];
for (const [名, たち] of 自治体ごと) {
  たち.sort((a, b) => 点(b) - 点(a));
  候補.push(...たち.slice(0, 自治体ごとに最大));
  console.log(`  ${名}: ${たち.length}件 → 上位${Math.min(自治体ごとに最大, たち.length)}件`);
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
const 出 = 候補.sort((a, b) => 点(b) - 点(a)).slice(0, 上限).map((x) => ({
  itemCode: x.itemCode, 名: 名前を整える(x.itemName), url: x.affiliateUrl,
  自治体: x.自治体, 寄付額: x.itemPrice, レビュー数: x.reviewCount, レビュー平均: x.reviewAverage,
  店: (x.shopName ?? '').slice(0, 30), キーワード: x.キーワード, 追加日: きょう,
}));

console.log('\n--- 入れるもの ---');
for (const x of 出) console.log(`  ${x.自治体}／${x.寄付額.toLocaleString()}円／レビュー${x.レビュー数}　${x.名}`);

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

if (書かない) { console.log('\nDRY_RUN なので書きません。'); process.exit(0); }
mkdirSync('neta', { recursive: true });
writeFileSync(置き場, 出.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
console.log(`\n${置き場} に ${出.length}件を書きました。`);
