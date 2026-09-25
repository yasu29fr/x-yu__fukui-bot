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
const 眠る = (ms) => new Promise((r) => setTimeout(r, ms));

for (const k of 言葉たち) {
  const q = new URLSearchParams({
    applicationId: アプリID, accessKey: アクセスキー, affiliateId: アフィリエイトID,
    keyword: k.trim(), hits: '10', format: 'json', sort: '-affiliateRate',
  });
  if (最低料率) q.set('minAffiliateRate', 最低料率);
  try {
    const res = await fetch(`${エンドポイント}?${q}`, { headers: ヘッダ });
    const 文 = await res.text();
    if (!res.ok) { console.log(`::warning::「${k}」HTTP ${res.status} ${文.replace(/\s+/g, ' ').slice(0, 180)}`); await 眠る(1200); continue; }
    const items = (JSON.parse(文).Items ?? []).map((w) => w.Item ?? w);
    console.log(`::warning::【${k}】${最低料率 ? `料率${最低料率}%以上 ` : ''}${items.length}件（料率の高い順）`);
    for (const x of items.slice(0, 5)) {
      console.log(`::warning::  ${x.affiliateRate}% ／ ${(x.itemPrice ?? 0).toLocaleString()}円 ／ ${(x.shopName ?? '').slice(0, 14)} ／ ${(x.itemName ?? '').slice(0, 40)}`);
    }
  } catch (e) { console.log(`::warning::「${k}」で失敗: ${String(e.message ?? e).slice(0, 160)}`); }
  await 眠る(1200);
}
