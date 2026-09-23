/**
 * 福井県の宿を集めて neta/宿.jsonl を作る
 * ------------------------------------------------------------------
 * このファイルは X のリポジトリにだけ置く。
 * できた neta/宿.jsonl は、福井・yu・X の3アカウントが同じものを読む。
 *
 * 決めていること:
 *   - **「ある」は書けるが「ない」は書けない。** 項目に無いのは
 *     「設備が無い」ではなく「宿が登録していない」かもしれないため
 *   - 並べる順は「レビュー数 × 評価」。よく泊まられていて、評価も高い宿が上
 *   - リンクは affiliateId を渡して返ってきたものをそのまま使う
 *   - 福井県の中区分コードは hukui（fukui ではない）
 * ------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const 宿パス = 'neta/宿.jsonl';
// 手で選んだ宿。施設番号（hotelNo）だけ書けばよい。
//   {"番号":16207,"エリア":"あわら・三国","メモ":"…"}
// ここに書いた宿は、上位10軒に入らなくても必ずリストに入る。
const 手動パス = 'neta/宿_手動.jsonl';
const 設定パス = 'neta/設定.json';
const アプリID = process.env.RAKUTEN_APP_ID;
const アクセスキー = process.env.RAKUTEN_ACCESS_KEY;
const アフィリエイトID = process.env.RAKUTEN_AFFILIATE_ID;
const リファラー = (process.env.RAKUTEN_REFERER ?? '').trim();
const 書かない = process.env.DRY_RUN === '1';

if (!アプリID || !アクセスキー) { console.error('::error::鍵が要ります'); process.exit(1); }
const ヘッダ = { accept: 'application/json' };
if (リファラー) { ヘッダ.referer = リファラー; ヘッダ.origin = new URL(リファラー).origin; }
const 鍵 = `applicationId=${アプリID}&accessKey=${アクセスキー}&format=json`;
const アフィ = アフィリエイトID ? `&affiliateId=${アフィリエイトID}` : '';
const 元 = 'https://openapi.rakuten.co.jp/engine/api/Travel';

const 設定 = existsSync(設定パス) ? JSON.parse(readFileSync(設定パス, 'utf8')) : {};
const 宿の設定 = 設定['宿の集めかた'] ?? {};
const 上限 = 宿の設定['上位いくつ'] ?? 10;
const 最低レビュー数 = 宿の設定['最低レビュー数'] ?? 50;

async function 呼ぶ(url) {
  for (let 回 = 1; 回 <= 4; 回 += 1) {
    const res = await fetch(url, { headers: ヘッダ });
    const 文 = await res.text();
    if (res.ok) { try { return JSON.parse(文); } catch { return null; } }
    if (res.status !== 429) throw new Error(`HTTP ${res.status} ${文.replace(/\s+/g, ' ').slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, 1600 * 回));
  }
  throw new Error('レート制限');
}
const 待つ = () => new Promise((r) => setTimeout(r, 1600));
const 束 = (h) => Object.assign({}, ...(Array.isArray(h.hotel) ? h.hotel : [h.hotel ?? h]));
const 並び = (x) => (Array.isArray(x) ? x : []).map((v) => (typeof v === 'object' ? Object.values(v)[0] : v)).filter(Boolean);

// 福井県を地点で拾う。
// 区分コードの一覧は形が読み取りにくく、1エリアに潰れてしまった。
// 主要な地点の緯度経度から半径で探すほうが確実で、
// 「どのエリアの宿か」も確実に分かる（催しのエリアと突き合わせるのに要る）。
const 地点 = 宿の設定['エリア'] ?? [
  { 名: '福井市', 緯度: 36.0617, 経度: 136.2236, 半径: 3 },
  { 名: 'あわら・三国', 緯度: 36.2170, 経度: 136.2290, 半径: 3 },
  { 名: '勝山・大野', 緯度: 36.0606, 経度: 136.5000, 半径: 3 },
  { 名: '鯖江・越前市', 緯度: 35.9036, 経度: 136.1857, 半径: 3 },
  { 名: '敦賀', 緯度: 35.6453, 経度: 136.0555, 半径: 3 },
  { 名: '小浜・若狭', 緯度: 35.4956, 経度: 135.7470, 半径: 3 },
];

const みな = new Map();
for (const p of 地点) {
  try {
    const r = await 呼ぶ(`${元}/SimpleHotelSearch/20260731?${鍵}`
      + `&latitude=${p.緯度}&longitude=${p.経度}&searchRadius=${p.半径}&datumType=1&hits=30`);
    let n = 0;
    for (const h of (r.hotels ?? [])) {
      const b = 束(h).hotelBasicInfo;
      if (!b || みな.has(b.hotelNo)) continue;
      みな.set(b.hotelNo, { ...b, エリア: p.名 });
      n += 1;
    }
    console.log(`  ${p.名}… ${n}軒`);
  } catch (e) { console.log(`::warning::${p.名} で取れませんでした: ${e.message}`); }
  await 待つ();
}
console.log(`重複を除いて ${みな.size}軒`);

// レビュー数 × 評価 で並べて上位だけ
// 並べ方。レビュー数だけで並べると福井市のビジネスホテルで埋まるので、
// まずエリアごとに上位を取り、そのあと全体で並べる。
// 「福井に泊まる人」に見せる以上、土地がばらけているほうがよい。
const エリアごと = 宿の設定['エリアごとに最大'] ?? 2;
const 点 = (b) => (b.reviewAverage ?? 0) * Math.log10((b.reviewCount ?? 1) + 10);
const 束ごと = new Map();
for (const b of みな.values()) {
  if ((b.reviewCount ?? 0) < 最低レビュー数) continue;
  if (!束ごと.has(b.エリア)) 束ごと.set(b.エリア, []);
  束ごと.get(b.エリア).push(b);
}
const 候補 = [];
for (const [名, たち] of 束ごと) {
  たち.sort((a, b) => 点(b) - 点(a));
  候補.push(...たち.slice(0, エリアごと));
  console.log(`  ${名}: ${たち.length}軒 → 上位${Math.min(エリアごと, たち.length)}軒`);
}
const 順 = 候補.sort((a, b) => 点(b) - 点(a)).slice(0, 上限);
console.log(`\n上位 ${順.length}軒を詳しく調べます`);

const 出 = [];
for (const b of 順) {
  let 詳;
  try {
    詳 = 束((await 呼ぶ(`${元}/HotelDetailSearch/20260731?${鍵}${アフィ}&responseType=large&hotelNo=${b.hotelNo}`)).hotels[0]);
  } catch (e) { console.log(`::warning::${b.hotelName}: ${e.message}`); continue; }
  await 待つ();
  const bb = 詳.hotelBasicInfo ?? {}, d = 詳.hotelDetailInfo ?? {}, f = 詳.hotelFacilitiesInfo ?? {}, r = 詳.hotelRatingInfo ?? {};
  出.push({
    番号: bb.hotelNo, 名: bb.hotelName, エリア: b.エリア, エリアコード: b.エリアコード,
    住所: `${bb.address1 ?? ''}${bb.address2 ?? ''}`, url: bb.hotelInformationUrl,
    最寄駅: bb.nearestStation, アクセス: bb.access, 駐車場: bb.parkingInformation,
    チェックイン: d.checkinTime, 最終チェックイン: d.lastCheckinTime, チェックアウト: d.checkoutTime,
    部屋数: f.hotelRoomNum, 最安: bb.hotelMinCharge, 特色: bb.hotelSpecial,
    部屋の備品: 並び(f.roomFacilities), 館内設備: 並び(f.hotelFacilities),
    朝食の場所: 並び(f.aboutMealPlace), 風呂: 並び(f.aboutBath),
    評価: bb.reviewAverage, レビュー数: bb.reviewCount,
    評価の内訳: { 風呂: r.bathAverage, 朝食: r.breakfastAverage, 設備: r.equipmentAverage, 清潔感: r.cleanlinessAverage, 立地: r.locationAverage, 部屋: r.roomAverage, サービス: r.serviceAverage },
    調べた日: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
  });
  console.log(`  ✓ ${bb.hotelName}（${b.エリア}）評価${bb.reviewAverage}・${bb.reviewCount}件`);
}

// 手で選んだ宿を足す。上位に入らなくても必ず入れる。
const 手で選んだ = existsSync(手動パス)
  ? readFileSync(手動パス, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter((x) => x && x.番号)
  : [];
for (const m of 手で選んだ) {
  if (出.some((x) => x.番号 === m.番号)) {
    出.find((x) => x.番号 === m.番号).手で選んだ = true;
    continue;
  }
  try {
    const 詳 = 束((await 呼ぶ(`${元}/HotelDetailSearch/20260731?${鍵}${アフィ}&responseType=large&hotelNo=${m.番号}`)).hotels[0]);
    await 待つ();
    const bb = 詳.hotelBasicInfo ?? {}, d = 詳.hotelDetailInfo ?? {}, f = 詳.hotelFacilitiesInfo ?? {}, r = 詳.hotelRatingInfo ?? {};
    出.push({
      番号: bb.hotelNo, 名: bb.hotelName, エリア: m.エリア ?? d.areaName ?? '—', エリアコード: d.smallClassCode,
      住所: `${bb.address1 ?? ''}${bb.address2 ?? ''}`, url: bb.hotelInformationUrl,
      最寄駅: bb.nearestStation, アクセス: bb.access, 駐車場: bb.parkingInformation,
      チェックイン: d.checkinTime, 最終チェックイン: d.lastCheckinTime, チェックアウト: d.checkoutTime,
      部屋数: f.hotelRoomNum, 最安: bb.hotelMinCharge, 特色: bb.hotelSpecial,
      部屋の備品: 並び(f.roomFacilities), 館内設備: 並び(f.hotelFacilities),
      朝食の場所: 並び(f.aboutMealPlace), 風呂: 並び(f.aboutBath),
      評価: bb.reviewAverage, レビュー数: bb.reviewCount,
      評価の内訳: { 風呂: r.bathAverage, 朝食: r.breakfastAverage, 設備: r.equipmentAverage, 清潔感: r.cleanlinessAverage, 立地: r.locationAverage, 部屋: r.roomAverage, サービス: r.serviceAverage },
      調べた日: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
      手で選んだ: true,
    });
    console.log(`  ★ ${bb.hotelName}（手で選んだ宿）`);
  } catch (e) { console.log(`::warning::手で選んだ宿 ${m.番号}: ${e.message}`); }
}

if (書かない) { console.log('\nDRY_RUN なので書きません。'); process.exit(0); }
mkdirSync('neta', { recursive: true });
writeFileSync(宿パス, 出.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
console.log(`\n${宿パス} に ${出.length}軒を書きました。`);
