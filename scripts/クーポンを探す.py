"""楽天トラベル・福井県の「大きいクーポン」を探す（週1回）

2026-09-30 代表指示：
  「40％以上の割引がある場合は、そのホテルの紹介投稿をするようにするといい」
  「読みに行って OK。福井県だけなら週に1回でいい」
  「部屋限定の情報は本文の注釈に。見出しには入れなくてよい」

楽天トラベルの API にはクーポンの情報が無い（宿・空室・ランキングまで）。
なので、楽天トラベルのクーポン一覧ページ（福井県）を読む。
  - robots.txt は無い（404）。利用規約に機械の読み取りをはっきり禁じる条文は無い
  - 読むのは週1回・数ページだけ
ページの形が変わっても壊れにくいよう、Anthropic の web_fetch で Claude に読ませ、JSON で受け取る。

出力: neta/宿_大きいクーポン.jsonl（1行1クーポン。率 40%以上だけ）
投稿は yu・福井 の compose のあとで、それぞれのリポジトリが1日1本まで作る。
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
API = "https://api.anthropic.com/v1/messages"
置き場 = Path("neta/宿_大きいクーポン.jsonl")
一覧 = "https://coupon.travel.rakuten.co.jp/coupon/search/japan_7_hukui-0-0-0-1-1"
下限の率 = int(os.environ.get("COUPON_MIN_RATE") or 40)


def 止まる(文: str) -> None:
    print(f"::error::{文}")
    sys.exit(1)


def モデル(api_key: str) -> str:
    指定 = os.environ.get("ANTHROPIC_MODEL", "").strip()
    if 指定:
        return 指定
    req = urllib.request.Request("https://api.anthropic.com/v1/models?limit=100")
    req.add_header("x-api-key", api_key)
    req.add_header("anthropic-version", "2023-06-01")
    with urllib.request.urlopen(req, timeout=60) as res:
        ids = [m["id"] for m in json.loads(res.read().decode()).get("data", [])]
    for kw in ("sonnet", "opus"):
        for i in ids:
            if kw in i:
                return i
    return ids[0]


def 読みながら聞く(api_key: str, model: str, prompt: str) -> str:
    messages = [{"role": "user", "content": prompt}]
    tools = [{"type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 12,
              "allowed_domains": ["coupon.travel.rakuten.co.jp"], "max_content_tokens": 40000}]
    data: dict = {}
    for 回 in range(6):
        body = json.dumps({"model": model, "max_tokens": 8000, "tools": tools, "messages": messages}).encode()
        req = urllib.request.Request(API, data=body, method="POST")
        req.add_header("x-api-key", api_key)
        req.add_header("anthropic-version", "2023-06-01")
        req.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                data = json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            止まる(f"Anthropic API エラー ({e.code}): {e.read().decode(errors='replace')[:300]}")
        開いた = sum(1 for b in data.get("content", []) if b.get("type") == "server_tool_use")
        print(f"web_fetch: stop_reason={data.get('stop_reason')} ／ 開いたページ {開いた}（{回 + 1}回目）")
        if data.get("stop_reason") != "pause_turn":
            break
        messages.append({"role": "assistant", "content": data["content"]})
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")


def JSONを取る(text: str):
    m = re.search(r"```json\s*(.*?)```", text, re.S)
    素 = m.group(1) if m else text[text.find("["): text.rfind("]") + 1]
    return json.loads(素)


def アフィリのリンク(url: str) -> str:
    aid = os.environ.get("RAKUTEN_AFFILIATE_ID", "").strip()
    if not aid:
        return url
    return f"https://hb.afl.rakuten.co.jp/hgc/{aid}/?pc=" + urllib.parse.quote(url, safe="")


def main() -> None:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        止まる("ANTHROPIC_API_KEY がありません")
    きょう = datetime.now(JST).date().isoformat()
    prompt = f"""楽天トラベルの福井県のクーポン一覧を読み、割引の大きいクーポンを集めてください。

1. まず {一覧} を開く。ページ送り（2ページ目以降）があれば、最大3ページまで開く
2. 一覧のうち、**割引が「{下限の率}%」以上（率で書かれたもの）** のクーポンだけを選ぶ。金額OFF（◯円）は選ばない
3. 選んだクーポンの宿のクーポンページ（https://coupon.travel.rakuten.co.jp/coupon/hotel/数字）を開き、正確な条件を読む
4. **ページに書かれていることだけ** を書く。推測で埋めない。分からない欄は null

今日は {きょう} です。獲得期間がもう終わっているものは入れないでください。

返す形（JSONだけ）:
```json
[{{"宿番号": 141249, "宿名": "…", "クーポン名": "…", "率": 50,
   "対象": "ロイヤルスイートルーム（…）", "宿泊期間": "2026-09-01〜2026-10-31", "宿泊の最終日": "2026-10-31",
   "獲得期限": "2026-10-31", "使えない日": "土曜日、9/4-5、…", "先着": 40,
   "ページ": "https://coupon.travel.rakuten.co.jp/coupon/hotel/141249"}}]
```
1件も無ければ [] を返す。"""
    model = モデル(api_key)
    try:
        出 = JSONを取る(読みながら聞く(api_key, model, prompt))
    except (json.JSONDecodeError, ValueError) as e:
        止まる(f"返事が読めませんでした（{e}）")
    行 = []
    for x in 出 if isinstance(出, list) else []:
        try:
            率 = int(x.get("率") or 0)
        except (TypeError, ValueError):
            continue
        if 率 < 下限の率 or not x.get("宿名") or not str(x.get("ページ", "")).startswith("https://coupon.travel.rakuten.co.jp/"):
            continue
        if str(x.get("獲得期限") or "9999") < きょう:
            continue
        x["リンク"] = アフィリのリンク(x["ページ"])
        x["見つけた日"] = きょう
        x["鍵"] = f"{x.get('宿番号')}:{x.get('クーポン名')}"
        行.append(x)
        print(f"::warning::{率}%OFF … {x['宿名']}（{x.get('対象')}）獲得 {x.get('獲得期限')} まで")
    置き場.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in 行), encoding="utf-8")
    print(f"{下限の率}%以上のクーポン: {len(行)} 件 → {置き場}")


if __name__ == "__main__":
    main()
