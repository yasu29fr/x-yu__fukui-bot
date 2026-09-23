/**
 * 楽天トラベルで宿を名前から引き、投稿の材料になる形にして書き出す
 * ------------------------------------------------------------------
 * 使い方:
 *   node scripts/宿を調べる.mjs "グランディア芳泉" "コートヤード福井"
 *
 * 出すもの: docs/宿_調査.md（人が読む用）と docs/宿.json（後で使う用）
 *
 * 決めていること:
 *   - **「ある」は書けるが「ない」は書けない。** 項目に無いのは「設備が無い」ではなく
 *     「宿が登録していない」かもしれないため。だから取れなかった項目は
 *     「載っていない」と書き、「ありません」とは書かない
 *   - リンクは affiliateId を渡して返ってきたものをそのまま使う
 * ------------------------------------------------------------------
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const アプリID = process.env.RAKUTEN_APP_ID;
const アクセスキー = process.env.RAKUTEN_ACCESS_KEY;
const アフィリエイトID = process.env.RAKUTEN_AFFILIATE_ID;
const リファラー = (process.env.RAKUTEN_REFERER ?? '').trim();
const 宿たち = process.argv.slice(2).filter(Boolean);

if (!アプリID || !アクセスキー) { console.error('::error::鍵が要ります'); process.exit(1); }
if (!宿たち.length) { console.error('::error::宿の名前を渡してください'); process.exit(1); }

const ヘッダ = { accept: 'application/json' };
if (リファラー) { ヘッダ.referer = リファラー; ヘッダ.origin = new URL(リファラー).origin; }
const 鍵 = `applicationId=${アプリID}&accessKey=${アクセスキー}&format=json`;
const アフィ = アフィリエイトID ? `&affiliateId=${アフィリエイトID}` : '';

async function 呼ぶ(url) {
  for (let 回 = 1; 回 <= 4; 回 += 1) {
    const res = await fetch(url, { headers: ヘッダ });
    const 文 = await res.text();
    if (res.ok) { try { return JSON.parse(文); } catch { return null; } }
    if (res.status !== 429) throw new Error(`HTTP ${res.status} ${文.replace(/\s+/g, ' ').slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, 1600 * 回));
  }
  throw new Error('レート制限で取れませんでした');
}
const 待つ = () => new Promise((r) => setTimeout(r, 1600));
const 束ねる = (h) => Object.assign({}, ...(Array.isArray(h.hotel) ? h.hotel : [h.hotel ?? h]));
const 並び = (x) => (Array.isArray(x) ? x : []).map((v) => (typeof v === 'object' ? Object.values(v)[0] : v)).filter(Boolean);

const 結果 = [];
for (const 名 of 宿たち) {
  console.log(`\n=== ${名} ===`);
  let 見つけた;
  try {
    const r = await 呼ぶ(`https://openapi.rakuten.co.jp/engine/api/Travel/KeywordHotelSearch/20260731?${鍵}&keyword=${encodeURIComponent(名)}&hits=5`);
    見つけた = (r.hotels ?? []).map(束ねる).map((x) => x.hotelBasicInfo).filter(Boolean);
  } catch (e) { console.log(`  ::warning::探せませんでした: ${e.message}`); continue; }
  await 待つ();
  if (!見つけた.length) { console.log('  見つかりませんでした'); continue; }
  for (const c of 見つけた) console.log(`  候補: ${c.hotelName}（${c.hotelNo}）${c.address1}${c.address2}`);
  const 本命 = 見つけた[0];

  let 詳;
  try {
    詳 = 束ねる((await 呼ぶ(`https://openapi.rakuten.co.jp/engine/api/Travel/HotelDetailSearch/20260731?${鍵}${アフィ}&responseType=large&hotelNo=${本命.hotelNo}`)).hotels[0]);
  } catch (e) { console.log(`  ::warning::詳しく取れませんでした: ${e.message}`); continue; }
  await 待つ();

  const b = 詳.hotelBasicInfo ?? {}, d = 詳.hotelDetailInfo ?? {}, f = 詳.hotelFacilitiesInfo ?? {}, r = 詳.hotelRatingInfo ?? {};
  結果.push({
    名: b.hotelName, 番号: b.hotelNo, 住所: `${b.address1 ?? ''}${b.address2 ?? ''}`,
    リンク: b.hotelInformationUrl, 予約: b.planListUrl,
    特色: b.hotelSpecial, 最安: b.hotelMinCharge,
    アクセス: b.access, 最寄駅: b.nearestStation, 駐車場: b.parkingInformation,
    チェックイン: d.checkinTime, 最終チェックイン: d.lastCheckinTime, チェックアウト: d.checkoutTime,
    部屋数: f.hotelRoomNum,
    部屋の備品: 並び(f.roomFacilities), 館内設備: 並び(f.hotelFacilities),
    朝食の場所: 並び(f.aboutMealPlace), 風呂: 並び(f.aboutBath),
    評価: { 全体: b.reviewAverage, 件数: b.reviewCount, 風呂: r.bathAverage, 朝食: r.breakfastAverage, 設備: r.equipmentAverage, 清潔感: r.cleanlinessAverage, 立地: r.locationAverage },
  });
  console.log(`  → ${b.hotelName}／部屋の備品 ${並び(f.roomFacilities).length}件／館内設備 ${並び(f.hotelFacilities).length}件`);
}

mkdirSync('docs', { recursive: true });
writeFileSync('docs/宿.json', JSON.stringify(結果, null, 2), 'utf8');
const 頁 = ['# 宿の調査（自動生成）', '',
  `調べた日時: ${new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')} JST`, '',
  '**「ある」は書けるが「ない」は書けない。** 載っていない項目は「設備が無い」ではなく「宿が登録していない」かもしれない。', ''];
for (const x of 結果) {
  頁.push(`## ${x.名}（${x.番号}）`, '', `- 住所: ${x.住所}`, `- 最寄駅: ${x.最寄駅 ?? '—'}`,
    `- アクセス: ${x.アクセス ?? '—'}`, `- 駐車場: ${x.駐車場 ?? '（載っていない）'}`,
    `- チェックイン ${x.チェックイン ?? '—'}（最終 ${x.最終チェックイン ?? '—'}）／ チェックアウト ${x.チェックアウト ?? '—'}`,
    `- 部屋数: ${x.部屋数 ?? '—'}　最安: ${x.最安 ? x.最安.toLocaleString() + '円' : '—'}`,
    `- 評価: 全体${x.評価.全体}（${x.評価.件数}件）／風呂${x.評価.風呂}／朝食${x.評価.朝食}／設備${x.評価.設備}／清潔感${x.評価.清潔感}／立地${x.評価.立地}`,
    `- 特色: ${x.特色 ?? '—'}`, '',
    `**部屋の備品（${x.部屋の備品.length}）** ${x.部屋の備品.join('、') || '（載っていない）'}`, '',
    `**館内設備（${x.館内設備.length}）** ${x.館内設備.join('、') || '（載っていない）'}`, '',
    `**朝食の場所** ${x.朝食の場所.join('、') || '（載っていない）'}`, '',
    `**風呂** ${x.風呂.join('、') || '（載っていない）'}`, '',
    `- リンク: ${x.リンク}`, '');
}
writeFileSync('docs/宿_調査.md', 頁.join('\n'), 'utf8');
console.log(`\ndocs/宿_調査.md に ${結果.length} 軒を書き出しました。`);
