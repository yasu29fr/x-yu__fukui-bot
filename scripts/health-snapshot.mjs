// 状態をまとめる（2026-10-02 追加）
//
// 毎晩の定時確認（Cowork・WebFetch のみ）が「判定不能」になる項目を、
// Actions の中で先に調べて state/health.json に書いておく。
//
// - ワークフローの成否は Actions API で取る。Actions の中なら GITHUB_TOKEN が使えるので、
//   無認証で 403 になる問題（共有 IP のレート制限）を受けない。
// - 明日ぶんのキューは queue.jsonl から抜き出す。大きいファイルを丸ごと読ませないため。
//
// 取れなかったときこそ記録が要るので、失敗しても必ずファイルを書いてから終わる。
import fs from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN || "";
const EXPECTED = Number(process.env.EXPECTED_PER_DAY || 0);
const QUEUE = process.env.QUEUE_PATH || "posts/queue.jsonl";
const OUT = process.env.OUT_PATH || "state/health.json";
const SKIP_API = process.env.SKIP_API === "true"; // 手元で試すとき用

const HOUR = 3600 * 1000;
const toJST = (iso) =>
  iso ? new Date(new Date(iso).getTime() + 9 * HOUR).toISOString().replace("T", " ").slice(0, 16) + " JST" : null;
const dateJST = (d) => new Date(d.getTime() + 9 * HOUR).toISOString().slice(0, 10);

const now = new Date();
const today = dateJST(now);
const tomorrow = dateJST(new Date(now.getTime() + 24 * HOUR));

async function gh(path) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

// 失敗した回の「なぜ」を、ジョブのアノテーションから最大3件拾う
async function failureReasons(runId) {
  const out = [];
  try {
    const { jobs } = await gh(`/repos/${REPO}/actions/runs/${runId}/jobs?per_page=20`);
    for (const job of jobs || []) {
      if (job.conclusion !== "failure") continue;
      const anns = await gh(`/repos/${REPO}/check-runs/${job.id}/annotations?per_page=20`);
      for (const a of anns) {
        if (a.annotation_level === "notice") continue;
        out.push(`${job.name}: ${String(a.message || "").replace(/\s+/g, " ").slice(0, 200)}`);
        if (out.length >= 3) return out;
      }
      const step = (job.steps || []).find((s) => s.conclusion === "failure");
      if (step && out.length === 0) out.push(`${job.name}: 「${step.name}」で失敗（アノテーションなし）`);
    }
  } catch (e) {
    out.push(`理由を取れませんでした（${e.message}）`);
  }
  return out;
}

async function workflows() {
  const { workflows: list } = await gh(`/repos/${REPO}/actions/workflows?per_page=100`);
  const result = [];
  for (const wf of list) {
    const file = wf.path.split("/").pop();
    const item = { 名前: wf.name, ファイル: file, 有効: wf.state === "active" };
    try {
      const { workflow_runs: runs } = await gh(`/repos/${REPO}/actions/workflows/${wf.id}/runs?per_page=100`);
      const last = runs[0];
      if (!last) {
        result.push({ ...item, 判定: "一度も走っていない" });
        continue;
      }
      const done = runs.filter((r) => r.status === "completed");
      const lastOk = done.find((r) => r.conclusion === "success");
      const lastNg = done.find((r) => r.conclusion === "failure");
      const day = runs.filter((r) => now - new Date(r.created_at) < 24 * HOUR);
      item.最後の実行 = {
        時刻: toJST(last.created_at),
        結果: last.status === "completed" ? last.conclusion : last.status,
        きっかけ: last.event,
        URL: last.html_url,
      };
      item.最後の成功 = lastOk ? toJST(lastOk.created_at) : null;
      item.今日走ったか = dateJST(new Date(last.created_at)) === today;
      item["24時間の実行"] = day.length;
      item["24時間の失敗"] = day.filter((r) => r.conclusion === "failure").length;
      if (lastNg) {
        item.最後の失敗 = { 時刻: toJST(lastNg.created_at), URL: lastNg.html_url };
        // 理由は「最後の実行が失敗」のときだけ取りに行く（API 回数の節約）
        if (last.id === lastNg.id) item.最後の失敗.理由 = await failureReasons(lastNg.id);
      }
      item.判定 = last.status !== "completed" ? "実行中" : last.conclusion === "success" ? "成功" : "失敗";
    } catch (e) {
      item.判定 = "取得失敗";
      item.説明 = e.message;
    }
    result.push(item);
  }
  return result;
}

function tomorrowQueue() {
  if (!fs.existsSync(QUEUE)) return { 対象日: tomorrow, 説明: `${QUEUE} がありません` };
  const posts = [];
  const broken = [];
  fs.readFileSync(QUEUE, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const p = JSON.parse(line);
      if (String(p.scheduled_at || "").slice(0, 10) === tomorrow) posts.push(p);
    } catch {
      broken.push(i + 1);
    }
  });
  posts.sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
  const hasLink = (s) => /https?:\/\//.test(s || "");
  const items = posts.map((p) => {
    const thread = Array.isArray(p.thread) ? p.thread.join("\n") : "";
    return {
      id: p.id,
      時刻: String(p.scheduled_at).slice(11, 16),
      "1行目": String(p.text || "").split("\n")[0].slice(0, 40),
      文字数: String(p.text || "").length,
      本文にリンク: hasLink(p.text),
      続きにリンク: hasLink(thread),
      出典元あり: /出典元/.test(p.text + thread),
      PRあり: /PR/.test(p.text + thread),
    };
  });
  const times = items.map((x) => x.時刻);
  return {
    対象日: tomorrow,
    本数: items.length,
    予定本数: EXPECTED || null,
    足りない: EXPECTED ? Math.max(0, EXPECTED - items.length) : null,
    時刻: times,
    同じ時刻が2本以上: [...new Set(times.filter((t, i) => times.indexOf(t) !== i))],
    読めない行: broken,
    投稿: items,
  };
}

const snapshot = {
  リポジトリ: REPO,
  作成時刻: toJST(now.toISOString()),
  今日: today,
  状態: "ok",
};

try {
  snapshot.明日のキュー = tomorrowQueue();
} catch (e) {
  snapshot.状態 = "一部失敗";
  snapshot.明日のキュー = { 対象日: tomorrow, 説明: e.message };
}

if (SKIP_API) {
  snapshot.ワークフロー = "SKIP_API=true のため取得していません";
} else {
  try {
    snapshot.ワークフロー = await workflows();
  } catch (e) {
    snapshot.状態 = "一部失敗";
    snapshot.ワークフロー = { 説明: `一覧を取れませんでした（${e.message}）` };
  }
}

fs.mkdirSync(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`${OUT} を書きました（状態: ${snapshot.状態}）`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const q = snapshot.明日のキュー;
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## 状態のまとめ\n\n- 明日 ${q.対象日}: ${q.本数 ?? "?"} 本（予定 ${q.予定本数 ?? "未設定"}）\n- 状態: ${snapshot.状態}\n`
  );
}
