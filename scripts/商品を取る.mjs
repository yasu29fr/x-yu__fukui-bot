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
const 控えパス = 'neta/商品_はずした.jsonl';
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
if (!探しかた || !(初心者の言葉.length + プロの言葉.length)) {
  console.log('設定.json に「商品の探しかた」がありません。何もしません。');
  process.exit(0);
}

// キーワードは「初心者向け」と「プロ向け」に分ける。
// 表向きの読者は SNS で発信している人なので、初心者向けを多めに入れる。
// 昔の書き方（ただの配列）も通す。その場合は全部を初心者向けとして扱う。
const 生キーワード = 探しかた['キーワード'] ?? [];
const 初心者の言葉 = Array.isArray(生キーワード)
  ? 生キーワード
  : (生キーワード['初心者向け'] ?? []);
const プロの言葉 = Array.isArray(生キーワード) ? [] : (生キーワード['プロ向け'] ?? []);
const 初心者の割合 = 探しかた['初心者の割合'] ?? 0.75;
const 価格帯 = {
  初心者: 探しかた['初心者の価格帯'] ?? {},
  プロ: 探しかた['プロの価格帯'] ?? {},
};
// キーワード → どちら向きか。商品は「どの言葉で見つけたか」を覚えているので、
// あとからでも向きが分かる。
const 向きの表 = new Map([
  ...初心者の言葉.map((k) => [k, '初心者']),
  ...プロの言葉.map((k) => [k, 'プロ']),
]);
const 向き = (x) => 向きの表.get(x.キーワード) ?? null;

const 在庫の上限 = 探しかた['在庫の上限'] ?? 10;
const 一度に足す上限 = 探しかた['1回に入れる件数'] ?? 10;
const 入れ替えの上限 = 探しかた['1回に入れ替える上限'] ?? 5;
const 何日で古い = 探しかた['何日で古いとみなすか'] ?? 60;
const 見限る本数 = 探しかた['伸びを見限る本数'] ?? 3;
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
for (const [むき, 言葉たち] of [['初心者', 初心者の言葉], ['プロ', プロの言葉]]) {
  for (const キーワード of 言葉たち) {
    try {
      const items = await 探す(キーワード, null, 価格帯[むき]);
      console.log(`［${むき}］「${キーワード}」… ${items.length}件`);
      候補.push(...items.map((x) => ({ ...x, キーワード, むき })));
    } catch (e) {
      console.log(`::warning::「${キーワード}」で取れませんでした: ${String(e.message ?? e).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
}

// すでにある商品を1件ずつ引き直す。検索結果に出てくるかどうかではなく、
// その商品そのものを itemCode で見にいく。検索の上位から落ちただけなのか、
// 本当に売り切れ・削除されたのかを、ここで分ける。
let 更新数 = 0;
const 消えた = [];
for (const 古い of [...URLで引く.values()]) {
  // itemCode が分かっている商品だけを名指しで引く。
  // URL から itemCode を組み立てるのは無理（店の URL 名と商品番号は別物）。
  // itemCode が無い商品は、下の検索結果から拾って入れる。
  const コード = 古い.itemCode;
  if (!コード) continue;
  let 出;
  try {
    出 = await 探す(null, コード);
  } catch (e) {
    console.log(`::warning::「${古い.名}」を引き直せませんでした: ${String(e.message ?? e).slice(0, 120)}`);
    continue;
  }
  await new Promise((r) => setTimeout(r, 1100));

  if (!出.length) {
    消えた.push(古い);
    continue;
  }
  const x = 出[0];
  if ((x.availability ?? 1) === 0) {
    消えた.push(古い);
    continue;
  }
  const 新 = 商品にする({ ...x, キーワード: 古い.キーワード }, 古い.追加日, 古い);
  新.使ったことがある = 古い.使ったことがある ?? false;
  新.成績 = 古い.成績 ?? null;
  if (JSON.stringify(古い) !== JSON.stringify(新)) 更新数 += 1;
  URLで引く.delete(古い.url);
  URLで引く.set(新.url, 新);
}
// itemCode をまだ持っていない商品は、キーワード検索の結果に出てきたときだけ更新する。
// 出てこなくても「消えた」とは決めない（検索の上位から落ちただけかもしれない）。
let 番号を入れた = 0;
for (const x of 候補) {
  const 古い = URLで引く.get(x.affiliateUrl);
  if (!古い || 古い.itemCode) continue;
  const 新 = 商品にする(x, 古い.追加日, 古い);
  新.使ったことがある = 古い.使ったことがある ?? false;
  新.成績 = 古い.成績 ?? null;
  URLで引く.set(新.url, 新);
  番号を入れた += 1;
}
const 番号なし = [...URLで引く.values()].filter((x) => !x.itemCode).length;
console.log(
  `引き直し: 更新 ${更新数} 件、売り切れ・消えた ${消えた.length} 件、` +
  `商品番号を入れた ${番号を入れた} 件（まだ番号なし ${番号なし} 件）`
);

// はずすものを決める。売り切れ・消えたものは上限に関係なく必ず外す
// （リンク切れを残すほうがまずい）。伸びない・古いは上限の中で。
const はずす = 選び出す(消えた);
for (const x of はずす) URLで引く.delete(x.url);
if (はずす.length) {
  console.log('--- はずすもの ---');
  for (const x of はずす) console.log(`- ${x.名}（${x.はずす理由}）`);
  控えに残す(はずす);
} else {
  console.log('はずすものはありません。');
}

// 足りない分だけ新しく入れる
const 空き = Math.max(0, 在庫の上限 - URLで引く.size);
const 足せる数 = Math.min(一度に足す上限, 空き);
console.log(`空き ${空き} 件。今回足すのは最大 ${足せる数} 件。`);

const 見た = new Set();
const 通ったもの = 候補
  .filter((x) => {
    if (!x.affiliateUrl || URLで引く.has(x.affiliateUrl)) return false;
    if ((x.reviewCount ?? 0) < 最低レビュー数) return false;
    if (見た.has(x.itemCode)) return false;
    見た.add(x.itemCode);
    return true;
  })
  .sort((a, b) => 並び順(b) - 並び順(a));

// 初心者向けとプロ向けの取り合わせを、決めた割合に近づける。
// いま残っている商品の内訳を見て、足りないほうから埋める。
const 残り = [...URLで引く.values()];
const いまの初心者 = 残り.filter((x) => 向き(x) === '初心者').length;
const 仕上がり = Math.min(在庫の上限, 残り.length + 足せる数);
const 初心者の目標 = Math.round(仕上がり * 初心者の割合);
let 初心者を入れる = Math.max(0, Math.min(足せる数, 初心者の目標 - いまの初心者));
let プロを入れる = 足せる数 - 初心者を入れる;

const 足すもの = [];
for (const x of 通ったもの) {
  if (足すもの.length >= 足せる数) break;
  if (x.むき === '初心者' && 初心者を入れる > 0) { 足すもの.push(x); 初心者を入れる -= 1; continue; }
  if (x.むき === 'プロ' && プロを入れる > 0) { 足すもの.push(x); プロを入れる -= 1; continue; }
}
// 片方が尽きたら、残りは向きを問わず埋める（枠を空けたままにしない）
for (const x of 通ったもの) {
  if (足すもの.length >= 足せる数) break;
  if (!足すもの.includes(x)) 足すもの.push(x);
}
const 入れるもの = 足すもの.map((x) => 商品にする(x, 今, null));
console.log(
  `いまの内訳: 初心者 ${いまの初心者} / ${残り.length} 件。` +
  `仕上がり ${仕上がり} 件なら初心者は ${初心者の目標} 件が目標。`
);

for (const x of 入れるもの) URLで引く.set(x.url, x);

if (入れるもの.length) {
  console.log('--- 足すもの ---');
  for (const x of 入れるもの) {
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
出力('added', String(入れるもの.length + 更新数));

// ------------------------------------------------------------------


// はずす候補を決める。
// - 売り切れ・消えた → 必ず外す（リンク切れを残さない）
// - 伸びなかった → 何本か出したうえで、平均閲覧が全体の中央値の6割に届かないもの
// - 古くなった → 追加から日数が経ったもの。ただし成績が中央値以上なら残す
// 「使ったことがある」商品は、本人の持ち物なので伸び・古さでは外さない。
function 選び出す(消えた) {
  const 全部 = [...URLで引く.values()];
  const 閲覧たち = 全部
    .map((x) => x.成績 && x.成績.平均閲覧)
    .filter((v) => typeof v === 'number')
    .sort((a, b) => a - b);
  const 中央 = 閲覧たち.length ? 閲覧たち[Math.floor(閲覧たち.length / 2)] : 0;

  const 出 = [];
  const 入った = new Set();
  const 入れる = (x, 理由) => {
    if (入った.has(x.url)) return;
    入った.add(x.url);
    出.push({ ...x, はずす理由: 理由 });
  };

  for (const x of 消えた) 入れる(x, '楽天から消えた、または売り切れ');

  const 上限つき = [];
  const 足す = (x, 理由) => {
    if (x.使ったことがある || 入った.has(x.url)) return;
    上限つき.push({ ...x, はずす理由: 理由 });
    入った.add(x.url);
  };

  for (const x of 全部) {
    const g = x.成績;
    if (!g || (g.本数 ?? 0) < 見限る本数 || !中央) continue;
    if (g.平均閲覧 < 中央 * 0.6) {
      足す(x, `${g.本数}本出して平均閲覧${g.平均閲覧}（全体の中央値${中央}の6割未満）`);
    }
  }
  // 探すのをやめたキーワードで入った商品。方針を変えたときに、
  // 古い方針のものが残り続けないようにする。
  for (const x of 全部) {
    if (向きの表.has(x.キーワード)) continue;
    足す(x, `「${x.キーワード}」はもう探していない`);
  }

  for (const x of 全部) {
    const 日数 = 経過日数(x.追加日);
    if (日数 < 何日で古い) continue;
    if (x.成績 && 中央 && x.成績.平均閲覧 >= 中央) continue;
    足す(x, `追加から${日数}日たった`);
  }

  return [...出, ...上限つき.slice(0, 入れ替えの上限)];
}

function 経過日数(追加日) {
  const t = Date.parse(`${追加日}T00:00:00+09:00`);
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86400000);
}

// はずした商品は消さずに控えへ移す。あとで「なぜ消えたか」を追えるようにするため。
function 控えに残す(はずす) {
  if (書かない) return;
  const 今日 = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const 行 = はずす.map((x) => JSON.stringify({ ...x, はずした日: 今日 })).join('\n') + '\n';
  try {
    writeFileSync(控えパス, 行, { flag: 'a' });
    console.log(`はずした ${はずす.length} 件を ${控えパス} に移しました。`);
  } catch (e) {
    console.log(`::warning::控えに残せませんでした: ${e.message}`);
  }
}

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
    itemCode: x.itemCode ?? null,
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

async function 探す(キーワード, itemCode, 帯) {
  const q = new URLSearchParams({
    applicationId: アプリID,
    accessKey: アクセスキー,
    affiliateId: アフィリエイトID,
    hits: '10',
    format: 'json',
  });
  if (itemCode) {
    // 1 件を名指しで引く。売り切れ・削除の判定に使う。
    q.set('itemCode', itemCode);
  } else {
    q.set('keyword', キーワード);
    q.set('sort', '-reviewCount');
    q.set('imageFlag', '1');
    const 下 = (帯 && 帯['最低価格']) ?? 最低価格;
    const 上 = (帯 && 帯['最高価格']) ?? 最高価格;
    if (下) q.set('minPrice', String(下));
    if (上) q.set('maxPrice', String(上));
  }

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
