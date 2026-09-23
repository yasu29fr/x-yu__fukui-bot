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
// 手で選んだ商品。キーワード検索では当てられないもの（DJI や Ulanzi の
// 特定の型番など）をここに書く。1行1件で、最低限 itemCode か url があればよい。
//   {"itemCode":"店:番号","url":"https://item.rakuten.co.jp/…/","むき":"プロ"}
// 商品名・価格・レビューは itemCode から毎週の実行で自動で入る。
// ここに書いた商品は、成績や古さでは外れない。
const 手動の置き場 = 'neta/商品_手動.jsonl';
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
// キーワードは「初心者向け」と「プロ向け」に分ける。
// 表向きの読者は SNS で発信している人なので、初心者向けを多めに入れる。
// 昔の書き方（ただの配列）も通す。その場合は全部を初心者向けとして扱う。
const 生キーワード = 探しかた['キーワード'] ?? [];
const 初心者の言葉 = Array.isArray(生キーワード)
  ? 生キーワード
  : (生キーワード['初心者向け'] ?? []);
const プロの言葉 = Array.isArray(生キーワード) ? [] : (生キーワード['プロ向け'] ?? []);
const 初心者の割合 = 探しかた['初心者の割合'] ?? 0.75;
// 同じ言葉から何件も入れると、自撮り棒だけが並ぶ。1つの言葉から入れる数を絞る。
const 言葉ごとの上限 = 探しかた['1つのキーワードから入れる上限'] ?? 1;
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
const 向き = (x) => 向きの表.get(x.キーワード) ?? x.むき ?? null;

// 「DJI Mic」「Ulanzi 三脚」のように、決まったブランドを狙った言葉かどうか。
// 設定の「ブランド名」に挙げた語が含まれていれば、その語を返す。
const ブランドたち = (探しかた['ブランド名'] ?? []).map((b) => String(b).toLowerCase());
function ブランド名(キーワード) {
  const k = String(キーワード).toLowerCase();
  return ブランドたち.find((b) => k.includes(b)) ?? null;
}

if (!探しかた || !(初心者の言葉.length + プロの言葉.length)) {
  console.log('設定.json に「商品の探しかた」がありません。何もしません。');
  process.exit(0);
}

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
const 手で入れた = existsSync(手動の置き場)
  ? readFileSync(手動の置き場, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter((x) => x && x.url)
  : [];

const 既存 = existsSync(商品パス)
  ? readFileSync(商品パス, 'utf8').split('\n').filter((s) => s.trim()).map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean)
  : [];
const URLで引く = new Map(既存.map((x) => [x.url, x]));

// 手で入れた商品を、リストに無ければ足す。あれば印だけ付け直す。
let 手動を足した = 0;
const コードで引く = new Map(
  [...URLで引く.values()].filter((v) => v.itemCode).map((v) => [v.itemCode, v])
);
for (const x of 手で入れた) {
  // url ではなく itemCode で見る。取り込んだあと url はアフィリエイトのものに
  // 変わるので、url で見ると毎回「新しい商品」として二重に入ってしまう。
  const 前 = (x.itemCode && コードで引く.get(x.itemCode)) || URLで引く.get(x.url);
  if (前) {
    URLで引く.set(前.url, {
      ...前, 手で入れた: true, むき: x.むき ?? 前.むき ?? 'プロ',
      名: x.名 || 前.名, メモ: x.メモ ?? 前.メモ ?? '',
    });
    continue;
  }
  URLで引く.set(x.url, {
    itemCode: null,
    名: x.名 ?? '（名前未設定）',
    url: x.url,
    価格: x.価格 ?? 0,
    前の価格: null,
    値下げ: false,
    レビュー数: x.レビュー数 ?? 0,
    レビュー平均: x.レビュー平均 ?? 0,
    ポイント倍: 1,
    セール: false,
    店: x.店 ?? '',
    キーワード: x.キーワード ?? '手で選んだもの',
    追加日: x.追加日 ?? 今,
    使ったことがある: x.使ったことがある ?? false,
    成績: null,
    手で入れた: true,
    むき: x.むき ?? 'プロ',
    メモ: x.メモ ?? '',
    店コード: x.店コード ?? null,
    探す語: x.探す語 ?? null,
    含む: x.含む ?? null,
    含まない: x.含まない ?? null,
  });
  手動を足した += 1;
}
if (手で入れた.length) {
  console.log(`手で入れた商品 ${手で入れた.length} 件（うち新しく入ったのは ${手動を足した} 件）`);
}

console.log(`いまの商品リスト ${URLで引く.size} 件（上限 ${在庫の上限}）`);
console.log(リファラー ? `リファラー: 設定あり（オリジン ${オリジン ? 'あり' : 'なし'}）` : 'リファラー: 未設定');

// 楽天に聞く
const 候補 = [];
for (const [むき, 言葉たち] of [['初心者', 初心者の言葉], ['プロ', プロの言葉]]) {
  for (const キーワード of 言葉たち) {
    try {
      const items = await 探す(キーワード, null, 価格帯[むき]);
      // 楽天の検索は語をバラして当てるので、「DJI Mic」で Lexar の SD カードが
      // 返ってくることがある。ブランド名を指定した言葉では、商品名に
      // そのブランド名が入っているものだけを通す。
      const 通す = ブランド名(キーワード)
        ? items.filter((x) => (x.itemName ?? '').toLowerCase().includes(ブランド名(キーワード)))
        : items;
      const 落ちた = items.length - 通す.length;
      console.log(`［${むき}］「${キーワード}」… ${通す.length}件${落ちた ? `（ブランド名が入っていない ${落ちた} 件は捨てた）` : ''}`);
      候補.push(...通す.map((x) => ({ ...x, キーワード, むき })));
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
  // 手で選んだ商品で「店コード」と「探す語」が書いてあるものは、
  // その店の中だけを語で検索して引き当てる。当たれば価格・レビュー・
  // 売り切れが自動で入るようになる。
  // 当たらなければ、書いてあるリンクをそのまま使う（紹介はできる）。
  if (古い.手で入れた && !古い.itemCode && 古い.店コード && 古い.探す語) {
    let 出 = [];
    try {
      出 = await 探す(古い.探す語, null, null, { shopCode: 古い.店コード });
      await new Promise((r) => setTimeout(r, 1100));
    } catch (e) {
      console.log(`::warning::「${古い.名}」を店から探せませんでした: ${String(e.message ?? e).slice(0, 140)}`);
    }
    const 合う = 出.filter((x) => {
      const 名 = (x.itemName ?? '').toLowerCase().replace(/[\s　-]/g, '');
      const 要る = (古い.含む ?? []).every((w) => 名.includes(String(w).toLowerCase().replace(/[\s　-]/g, '')));
      const 除く = (古い.含まない ?? []).some((w) => 名.includes(String(w).toLowerCase().replace(/[\s　-]/g, '')));
      return 要る && !除く;
    });
    if (合う.length) {
      const 新 = 商品にする({ ...合う[0], キーワード: '手で選んだもの' }, 古い.追加日, null);
      新.名 = 古い.名;          // 楽天の商品名は読めないので、こちらで整えた名前を使う
      新.メモ = 古い.メモ ?? '';
      新.手で入れた = true;
      新.むき = 古い.むき ?? 'プロ';
      新.店コード = 古い.店コード;
      新.探す語 = 古い.探す語;
      新.含む = 古い.含む;
      新.含まない = 古い.含まない;
      新.売り切れ = false;
      新.使ったことがある = 古い.使ったことがある ?? false;
      新.成績 = 古い.成績 ?? null;
      URLで引く.delete(古い.url);
      URLで引く.set(新.url, 新);
      更新数 += 1;
      console.log(`手で選んだ商品を引き当てました: ${新.名} → ${新.価格.toLocaleString()}円・レビュー${新.レビュー数}件`);
      continue;
    }
    console.log(`::warning::「${古い.名}」は店「${古い.店コード}」の中に見つかりませんでした。`
      + `書いてあるリンクをそのまま使います（価格とレビューは入りません）。`);
  }

  // それ以外の手で選んだ商品は、そのまま使う。
  // 商品ページの URL から itemCode は作れず（itemCode はページの HTML にしか無い）、
  // 店の一覧を総当たりしても当たらなかったため。
  // 価格やレビューは入らないが、リンクと名前があれば紹介はできる。
  if (古い.手で入れた) continue;

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

  const 見つからない = !出.length || (出[0].availability ?? 1) === 0;
  if (見つからない) {
    if (古い.手で入れた) {
      // 手で選んだ商品は勝手に外さない。ただし死んだリンクは貼らせない。
      // 売り切れの印を付けておくと、compose.py が選ばなくなる。
      console.log(`::warning::「${古い.名}」が楽天に見つかりません（手で選んだ商品）。`
        + `紹介からは外しますが、リストには残します。`
        + `戻らないようなら neta/商品_手動.jsonl から消してください。`);
      URLで引く.set(古い.url, { ...古い, 売り切れ: true });
    } else {
      消えた.push(古い);
    }
    continue;
  }
  const x = 出[0];
  const 新 = 商品にする({ ...x, キーワード: 古い.キーワード }, 古い.追加日, 古い);
  新.使ったことがある = 古い.使ったことがある ?? false;
  新.成績 = 古い.成績 ?? null;
  // 手で選んだ印と向きは、引き直しても残す
  if (古い.手で入れた) 新.手で入れた = true;
  新.売り切れ = false;
  if (古い.むき) 新.むき = 古い.むき;
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

// いま残っている商品が、その言葉で何件入っているか
const 言葉の数 = new Map();
for (const x of 残り) 言葉の数.set(x.キーワード, (言葉の数.get(x.キーワード) ?? 0) + 1);
const 言葉に空きがある = (x) => (言葉の数.get(x.キーワード) ?? 0) < 言葉ごとの上限;
const 言葉を使う = (x) => 言葉の数.set(x.キーワード, (言葉の数.get(x.キーワード) ?? 0) + 1);

const 足すもの = [];
for (const x of 通ったもの) {
  if (足すもの.length >= 足せる数) break;
  if (!言葉に空きがある(x)) continue;
  if (x.むき === '初心者' && 初心者を入れる > 0) { 足すもの.push(x); 言葉を使う(x); 初心者を入れる -= 1; continue; }
  if (x.むき === 'プロ' && プロを入れる > 0) { 足すもの.push(x); 言葉を使う(x); プロを入れる -= 1; continue; }
}
// 片方が尽きたら、残りは向きを問わず埋める（枠を空けたままにしない）。
// ただし「1つの言葉から1件」は守る。
for (const x of 通ったもの) {
  if (足すもの.length >= 足せる数) break;
  if (足すもの.includes(x) || !言葉に空きがある(x)) continue;
  足すもの.push(x); 言葉を使う(x);
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
} else if (出す.length === 0 && 既存.length > 0) {
  // ここに来るのは、読めていた既存が途中で全部消えたとき。
  // 空で上書きすると商品枠が止まるので、書かずに落とす（2026-09-23）。
  console.error(`::error::書き出しが 0 件になりました（既存は ${既存.length} 件）。`
    + 'これまでのリストを消さないため、今回は書き込みません。');
  process.exit(1);
} else {
  writeFileSync(商品パス, 出す.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  console.log(`${商品パス} は ${出す.length} 件になりました。`);
}
出力('added', String(入れるもの.length + 更新数 + 手動を足した + はずす.length));

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
    if (x.使ったことがある || x.手で入れた || 入った.has(x.url)) return;
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

  const 決まり = [...出, ...上限つき.slice(0, 入れ替えの上限)];

  // 同じ言葉から何件も残っていたら、いちばん良いもの以外を落とす。
  // （自撮り棒が4件、SDカードが4件、のような偏りを消すため）
  // これも設定の反映なので、毎週の入れ替え上限には縛られない。
  const 言葉ごと = new Map();
  for (const x of 全部) {
    if (決まり.some((y) => y.url === x.url)) continue;
    if (!言葉ごと.has(x.キーワード)) 言葉ごと.set(x.キーワード, []);
    言葉ごと.get(x.キーワード).push(x);
  }
  for (const [ことば, たち] of 言葉ごと) {
    if (たち.length <= 言葉ごとの上限) continue;
    // 成績がよいもの、次にレビューが多いものを残す
    const 並べた = [...たち].sort((a, b) => {
      const av = (a.成績 && a.成績.平均閲覧) ?? -1;
      const bv = (b.成績 && b.成績.平均閲覧) ?? -1;
      if (av !== bv) return bv - av;
      return (b.レビュー数 ?? 0) - (a.レビュー数 ?? 0);
    });
    for (const x of 並べた.slice(言葉ごとの上限)) {
      if (x.使ったことがある || x.手で入れた) continue;
      決まり.push({ ...x, はずす理由: `「${ことば}」から${たち.length}件も入っていた` });
    }
  }

  // 在庫の上限を下げたときは、はみ出したぶんをここで落とす。
  // これは「毎週の入れ替え」ではなく設定変更の反映なので、上限に縛られない。
  // 落とす順番は、まず探すのをやめた言葉のもの、次に成績が無いもの、次に古いもの。
  const 残る = 全部.filter((x) => !決まり.some((y) => y.url === x.url));
  const はみ出し = 残る.length - 在庫の上限;
  if (はみ出し > 0) {
    const 順 = [...残る].sort((a, b) => 落とす順(a) - 落とす順(b));
    for (const x of 順.slice(0, はみ出し)) {
      決まり.push({ ...x, はずす理由: `在庫の上限が${在庫の上限}件になったため` });
    }
  }
  return 決まり;
}

// 数が小さいほど先に落とす。
function 落とす順(x) {
  if (x.使ったことがある || x.手で入れた) return 100;  // 本人の持ち物・手で選んだものは残す
  if (!向きの表.has(x.キーワード)) return 0;          // もう探していない言葉
  if (!x.成績) return 1;                              // まだ一度も出していない
  return 2 + (x.成績.平均閲覧 ?? 0) / 100000;         // 成績がよいほど後ろ
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

async function 探す(キーワード, itemCode, 帯, 絞り) {
  const q = new URLSearchParams({
    applicationId: アプリID,
    accessKey: アクセスキー,
    affiliateId: アフィリエイトID,
    hits: '10',
    format: 'json',
  });
  if (絞り) for (const [k, v] of Object.entries(絞り)) q.set(k, v);
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
