/**
 * 紹介した商品の成績をつける
 * ------------------------------------------------------------------
 * X と yu の両方の「投稿キュー」と「計測」を突き合わせて、
 * どの商品を出した投稿がどれだけ読まれたかを neta/商品.jsonl に書き戻す。
 *
 * やり方:
 *   1. queue.jsonl から、投稿ID → 本文と連投に出てくる URL を作る
 *   2. metrics.jsonl から、投稿ID → 閲覧数・反応数を作る
 *   3. 同じ投稿IDで突き合わせて、商品の URL ごとに集計する
 *
 * yu のぶんは https で読む（リポジトリは公開なので鍵は要らない）。
 * 読めなくても止めない。X のぶんだけで成績をつける。
 *
 * 成績は compose.py の並べ替えに使う。
 * 反応がよかった商品は、また出てくるようになる。
 * ------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const 商品パス = 'neta/商品.jsonl';
const よそ = [
  {
    名前: 'yu',
    queue: 'https://raw.githubusercontent.com/yasu29fr/yasu29fr/claude/threads-auto-posting-uhiy6w/posts/queue.jsonl',
    metrics: 'https://raw.githubusercontent.com/yasu29fr/yasu29fr/claude/threads-auto-posting-uhiy6w/insights/metrics.jsonl',
  },
];

if (!existsSync(商品パス)) {
  console.log(`${商品パス} がありません。先に 商品を取る.mjs を走らせてください。`);
  process.exit(0);
}

const 商品 = readFileSync(商品パス, 'utf8').split('\n').filter((s) => s.trim())
  .map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

// url -> { 閲覧の合計, 反応の合計, 本数, 最終投稿日 }
const 集計 = new Map();

function 足す(queueText, metricsText, どこ) {
  const 行 = (t) => (t ?? '').split('\n').filter((s) => s.trim())
    .map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

  const URLたち = new Map();
  for (const e of 行(queueText)) {
    if (!e.id) continue;
    const 出 = new Set();
    for (const 文 of [e.text ?? '', ...(e.thread ?? [])]) {
      for (const m of String(文).matchAll(/https?:\/\/\S+/g)) 出.add(m[0]);
    }
    if (出.size) URLたち.set(String(e.id), { urls: [...出], 日: String(e.scheduled_at ?? '').slice(0, 10) });
  }

  let 当たり = 0;
  for (const r of 行(metricsText)) {
    const q = URLたち.get(String(r.id));
    if (!q) continue;
    const 閲覧 = typeof r.views === 'number' ? r.views : null;
    if (閲覧 === null) continue;
    const 反応 = typeof r.eng === 'number' ? r.eng : (r.likes ?? 0) + (r.replies ?? 0);
    for (const u of q.urls) {
      if (!集計.has(u)) 集計.set(u, { 閲覧: 0, 反応: 0, 本数: 0, 最終: '' });
      const a = 集計.get(u);
      a.閲覧 += 閲覧; a.反応 += 反応; a.本数 += 1;
      if (q.日 > a.最終) a.最終 = q.日;
      当たり += 1;
    }
  }
  console.log(`${どこ}: 計測と突き合わせできた投稿 ${当たり} 本`);
}

足す(
  existsSync('posts/queue.jsonl') ? readFileSync('posts/queue.jsonl', 'utf8') : '',
  existsSync('insights/metrics.jsonl') ? readFileSync('insights/metrics.jsonl', 'utf8') : '',
  'X'
);

for (const y of よそ) {
  try {
    const [q, m] = await Promise.all([取る(y.queue), 取る(y.metrics)]);
    足す(q, m, y.名前);
  } catch (e) {
    console.log(`::warning::${y.名前} のぶんを読めませんでした: ${String(e.message ?? e).slice(0, 160)}`);
  }
}

let ついた = 0;
for (const x of 商品) {
  const a = 集計.get(x.url);
  if (!a || !a.本数) { x.成績 = x.成績 ?? null; continue; }
  x.成績 = {
    本数: a.本数,
    平均閲覧: Math.round(a.閲覧 / a.本数),
    平均反応: Math.round((a.反応 / a.本数) * 10) / 10,
    最終投稿日: a.最終 || null,
  };
  ついた += 1;
}

console.log(`成績がついた商品 ${ついた} / ${商品.length} 件`);
for (const x of 商品.filter((v) => v.成績).sort((p, q) => q.成績.平均閲覧 - p.成績.平均閲覧)) {
  console.log(`  ${String(x.成績.平均閲覧).padStart(6)} 閲覧 ／ 反応 ${x.成績.平均反応} ／ ${x.成績.本数}本 ／ ${x.名}`);
}

if (process.env.DRY_RUN === '1') {
  console.log('DRY_RUN なので書きません。');
} else {
  writeFileSync(商品パス, 商品.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  console.log(`${商品パス} に書き戻しました。`);
}

async function 取る(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { headers: { accept: 'text/plain' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
