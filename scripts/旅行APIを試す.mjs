/**
 * 楽天トラベルAPIで、施設の設備情報がどこまで取れるかを確かめる
 * ------------------------------------------------------------------
 * 「ホテルに〇〇ある？」を書く企画が成立するかは、
 * roomFacilities（部屋設備）と hotelFacilities（館内設備）に
 * 何が入っているかで決まる。仕様書に値の一覧が無いので、実際に呼んで見る。
 *
 * 何も書かない。読むだけ。
 * ------------------------------------------------------------------
 */
import { writeFileSync, mkdirSync } from 'node:fs';

// 実行ログはこちらから読めないので、結果をファイルにも残す
const 記録 = [];
const もとのlog = console.log;
console.log = (...a) => { 記録.push(a.join(' ')); もとのlog(...a); };
process.on('exit', () => {
  try {
    mkdirSync('docs', { recursive: true });
    writeFileSync('docs/旅行API_調査.md',
      '# 楽天トラベルAPIで何が取れるか（自動生成）\n\n'
      + `調べた日時: ${new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')} JST\n\n`
      + '```\n' + 記録.join('\n') + '\n```\n', 'utf8');
  } catch {}
});

const アプリID = process.env.RAKUTEN_APP_ID;
const アクセスキー = process.env.RAKUTEN_ACCESS_KEY;
const アフィリエイトID = process.env.RAKUTEN_AFFILIATE_ID;
const リファラー = (process.env.RAKUTEN_REFERER ?? '').trim();
const オリジン = リファラー ? new URL(リファラー).origin : '';

if (!アプリID || !アクセスキー) {
  console.error('::error::RAKUTEN_APP_ID と RAKUTEN_ACCESS_KEY が要ります');
  process.exit(1);
}

const ヘッダ = { accept: 'application/json' };
if (リファラー) ヘッダ.referer = リファラー;
if (オリジン) ヘッダ.origin = オリジン;

async function 呼ぶ(名前, url) {
  const res = await fetch(url, { headers: ヘッダ });
  const 文 = await res.text();
  if (!res.ok) {
    console.log(`\n【${名前}】HTTP ${res.status}`);
    console.log('  ' + 文.replace(/\s+/g, ' ').slice(0, 300));
    return null;
  }
  console.log(`\n【${名前}】OK`);
  try { return JSON.parse(文); } catch { return null; }
}

// 福井県（largeClassCode=japan, middleClassCode=fukui）の施設を1件
const 共通 = `applicationId=${アプリID}&accessKey=${アクセスキー}`
  + (アフィリエイトID ? `&affiliateId=${アフィリエイトID}` : '')
  + '&format=json&formatVersion=2';

// 区分コードは大・中・小の3つが要る。小区分の綴りが分からないので、
// 緯度経度（福井駅）でも引けるようにして、通ったほうを使う。
const 試す = [
  ['区分コード（japan/fukui/fukui）', '&largeClassCode=japan&middleClassCode=fukui&smallClassCode=fukui&hits=3'],
  ['緯度経度（福井駅から3km）', '&latitude=36.0617&longitude=136.2236&searchRadius=3&datumType=1&hits=3'],
];
let 一覧 = null;
for (const [名, 条件] of 試す) {
  一覧 = await 呼ぶ(
    `施設検索 ${名}`,
    `https://openapi.rakuten.co.jp/engine/api/Travel/SimpleHotelSearch/20260731?${共通}${条件}`
  );
  if (一覧) break;
  await new Promise((r) => setTimeout(r, 1100));
}

if (!一覧) {
  console.log('\n施設検索が通りませんでした。');
  console.log('アプリの「APIアクセススコープ」で 楽天トラベルAPI にチェックが入っているか確認してください。');
  process.exit(0);
}

const 施設 = (一覧.hotels ?? []).map((h) => (Array.isArray(h) ? h[0] : h));
for (const x of 施設.slice(0, 3)) {
  const b = x.hotelBasicInfo ?? x;
  console.log(`  - ${b.hotelName}（${b.hotelNo}）`);
  console.log(`    アフィリエイトURL: ${b.hotelAffiliateUrl ? 'あり' : 'なし'}`);
  console.log(`    駐車場: ${String(b.parkingInformation ?? '—').replace(/\s+/g, ' ').slice(0, 80)}`);
}

const 一番 = 施設[0] && (施設[0].hotelBasicInfo ?? 施設[0]);
if (!一番) process.exit(0);

const 詳細 = await 呼ぶ(
  `施設情報（${一番.hotelName}）`,
  `https://openapi.rakuten.co.jp/engine/api/Travel/HotelDetailSearch/20260731?${共通}`
  + `&hotelNo=${一番.hotelNo}`
);
if (!詳細) process.exit(0);

const h = (詳細.hotels ?? [])[0];
const 束 = Array.isArray(h) ? Object.assign({}, ...h) : (h ?? {});
const d = 束.hotelDetailInfo ?? {};
const f = 束.hotelFacilitiesInfo ?? {};

console.log('\n--- 時刻まわり ---');
console.log(`  チェックイン: ${d.checkinTime ?? '—'} ／ 最終: ${d.lastCheckinTime ?? '—'}`);
console.log(`  チェックアウト: ${d.checkoutTime ?? '—'}`);

const 出す = (名, v) => {
  const 値 = Array.isArray(v) ? v.flat().filter(Boolean) : (v ? [v] : []);
  console.log(`\n--- ${名}（${値.length}件） ---`);
  console.log('  ' + (値.length ? 値.join('、') : '（空）'));
};
出す('部屋設備・備品 roomFacilities', f.roomFacilities);
出す('館内設備 hotelFacilities', f.hotelFacilities);
出す('風呂 bathInfo', f.bathInfo ?? f.hotelBathInfo);
出す('身障者設備 handicappedFacilities', f.handicappedFacilities);
出す('食事場所 aboutMeal', [f.aboutBreakfast, f.aboutDinner]);

console.log('\n--- 返ってきた項目名（全部） ---');
console.log('  hotelDetailInfo:', Object.keys(d).join('、') || '（なし）');
console.log('  hotelFacilitiesInfo:', Object.keys(f).join('、') || '（なし）');
