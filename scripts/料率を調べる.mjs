/**
 * 楽天市場の商品検索APIが返す affiliateRate を、そのまま見るためだけの道具
 * ------------------------------------------------------------------
 * 2026-09-25、代表が楽天アフィリエイトの福井県一覧を「料率が高い順」で見ると
 * 10.0% の返礼品があった。一方、こちらが商品検索APIで集めると最高 4% だった。
 * どちらが本当か（APIが返すのは通常料率で、料率アップは別に乗るのか）を確かめる。
 *
 * 使い方: KEYWORDS に調べたい言葉を入れて dispatch する。書き込みはしない。
 * 結果は注記(::warning::)で出す。GitHub のログが落とせないため。
 * ------------------------------------------------------------------
 */
const エンドポイント = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
const アプリID = process.env.RAKUTEN_APP_ID;
const アクセスキー = process.env.RAKUTEN_ACCESS_KEY;
const アフィリエイトID = process.env.RAKUTEN_AFFILIATE_ID;
const リファラー = (process.env.RAKUTEN_REFERER ?? '').trim();
if (!アプリID || !アクセスキー || !アフィリエイトID) { console.error('::error::鍵が要ります'); process.exit(1); }
const ヘッダ = { accept: 'application/json' };
if (リファラー) { ヘッダ.referer = リファラー; ヘッダ.origin = new URL(リファラー).origin; }

const 言葉たち = (process.env.KEYWORDS ?? 'ふるさと納税 鯖江市|ふるさと納税 福井県|ふるさと納税 越前がに').split('|');
const 最低料率 = process.env.MIN_RATE ?? '';
const 並べ方 = process.env.SORT ?? '-affiliateRate';
const 店コード = (process.env.SHOP_CODE ?? '').trim();
const 眠る = (ms) => new Promise((r) => setTimeout(r, ms));

for (const k of 言葉たち) {
  const q = new URLSearchParams({
    applicationId: アプリID, accessKey: アクセスキー, affiliateId: アフィリエイトID,
    keyword: k.trim(), hits: '30', format: 'json', sort: 並べ方,
  });
  if (最低料率) q.set('minAffiliateRate', 最低料率);
  if (店コード) q.set('shopCode', 店コード);
  try {
    const res = await fetch(`${エンドポイント}?${q}`, { headers: ヘッダ });
    const 文 = await res.text();
    if (!res.ok) { console.log(`::warning::「${k}」HTTP ${res.status} ${文.replace(/\s+/g, ' ').slice(0, 180)}`); await 眠る(1200); continue; }
    const items = (JSON.parse(文).Items ?? []).map((w) => w.Item ?? w);
    const ある = items.filter((x) => (x.reviewCount ?? 0) > 0);
    const 多い = items.filter((x) => (x.reviewCount ?? 0) >= 10);
    console.log(`::warning::【${k}】${最低料率 ? `料率${最低料率}%以上 ` : ''}${items.length}件（${並べ方}）／レビュー1件以上 ${ある.length}件、10件以上 ${多い.length}件`);
    // 価格帯の分布。レビュー数で並べたときの上位が、どの寄付額に寄っているか。
    const 帯 = [[0,5000,'5千円未満'],[5000,10000,'5千〜1万'],[10000,15000,'1万〜1.5万'],
      [15000,20000,'1.5万〜2万'],[20000,30000,'2万〜3万'],[30000,50000,'3万〜5万'],[50000,1e12,'5万以上']];
    const 数 = 帯.map(([下,上,名]) => {
      const な = items.filter((x) => (x.itemPrice ?? 0) >= 下 && (x.itemPrice ?? 0) < 上);
      const レ = な.reduce((a, x) => a + (x.reviewCount ?? 0), 0);
      return `${名} ${な.length}件(レビュー計${レ.toLocaleString()})`;
    });
    console.log(`::warning::  寄付額の散らばり… ${数.join('／')}`);
    const 価 = items.map((x) => x.itemPrice ?? 0).sort((a, b) => a - b);
    if (価.length) console.log(`::warning::  中央 ${価[Math.floor(価.length/2)].toLocaleString()}円／最小 ${価[0].toLocaleString()}円／最大 ${価[価.length-1].toLocaleString()}円`);
    for (const x of items.slice(0, 4)) {
      console.log(`::warning::  ${x.affiliateRate}% ／ ${(x.itemPrice ?? 0).toLocaleString()}円 ／ ★${x.reviewAverage ?? '-'}(${x.reviewCount ?? 0}件) ／ ${(x.shopName ?? '').slice(0, 12)} ／ ${(x.itemName ?? '').slice(0, 30)}`);
      if (process.env.SHOW_REVIEW_URL) console.log(`::warning::    review: ${x.reviewUrl ?? '(無し)'}`);
    }
  } catch (e) { console.log(`::warning::「${k}」で失敗: ${String(e.message ?? e).slice(0, 160)}`); }
  await 眠る(1200);
}
