"""運営事業部・yuアカウント — 商品リサーチ担当の「代表への提案」を書く

2026-09-27 代表指示「19:00 のタスクが動かなかった。PC接続していなくても動くように」
19:20 の窓口タスクは Mac のフォルダに頼っていたため、接続が無いと候補を出せなかった。
提案の中身はここ（GitHub Actions）で作って neta/美容の提案.md に置き、
窓口タスクはそれを WebFetch で読んで代表に見せるだけにする。

選び方は yu の「美容の投稿を作る.py」の自動選択と同じ決まり（1:00 の自動と食い違わないように）。
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
候補の置き場 = Path("neta/美容候補.jsonl")
提案の置き場 = Path("neta/美容の提案.md")
決定ログのURL = ("https://raw.githubusercontent.com/yu-fukui/threads_yu-fukui/main/neta/"
             + urllib.parse.quote("美容_決定ログ.jsonl"))
上限価格 = 30000
避ける語 = ("脱毛器", "脱毛", "永久")
空ける日数 = 14


def 決定ログ() -> list[dict]:
    try:
        with urllib.request.urlopen(決定ログのURL, timeout=60) as r:
            文 = r.read().decode("utf-8")
    except Exception as e:
        print(f"::warning::決定ログが読めません（{e}）。直近14日の重なりは見ずに出します")
        return []
    return [json.loads(l) for l in 文.splitlines() if l.strip()]


def 素のURL(c: dict) -> str:
    q = urllib.parse.parse_qs(urllib.parse.urlparse(c.get("商品ページ", "")).query)
    return (q.get("pc") or [c.get("商品ページ", "")])[0]


def 外す理由(c: dict, 最近: dict[str, str]) -> str:
    名 = c.get("名", "")
    if c.get("itemCode") in 最近:
        return f"直近{空ける日数}日に使った（{最近[c['itemCode']]}）"
    if any(w in 名 for w in 避ける語):
        return "家庭用脱毛器（「永久脱毛」と書けず、書ける幅が狭い）"
    if (c.get("価格") or 0) > 上限価格:
        return f"{上限価格:,}円を超える（Threads の流れで買われにくい）"
    if "美白" in 名 and not c.get("薬用"):
        return "「美白」とあるが薬用でない（効能を書けない）"
    return ""


def main() -> None:
    今 = datetime.now(JST)
    候補 = [json.loads(l) for l in 候補の置き場.read_text(encoding="utf-8").splitlines() if l.strip()]
    明日 = 今.date().toordinal() + 1
    最近 = {}
    for x in 決定ログ():
        try:
            d = datetime.strptime(x.get("埋めた日", ""), "%Y-%m-%d").date().toordinal()
        except ValueError:
            continue
        if 明日 - d < 空ける日数 and x.get("itemCode"):
            最近[x["itemCode"]] = f"{x['埋めた日'][5:]} {x.get('商品', '')}"
    for c in 候補:
        c["_外す"] = 外す理由(c, 最近)
    使える = sorted([c for c in 候補 if not c["_外す"]], key=lambda c: (not c.get("薬用"), c.get("番号", 99)))
    出した日 = {c.get("出した日") for c in 候補}

    書 = [f"# 美容の候補（{今:%Y-%m-%d %H:%M} JST 作成）", "",
         f"- 候補を出した日：{'、'.join(sorted(d for d in 出した日 if d)) or '不明'}",
         f"- 明日1:00までに代表の返信が無ければ、下の「第一候補」で自動で進みます", "",
         "| 番号 | 商品 | 価格 | 料率 | 1件の報酬 | レビュー | 薬用 | 帯 | 使えるか |",
         "|---|---|---|---|---|---|---|---|---|"]
    for c in 候補:
        書.append(f"| {c.get('番号')} | {c.get('名','')[:36]} | {c.get('価格',0):,}円 | {c.get('料率')}% | "
                 f"{c.get('見込み報酬',0):,}円 | {c.get('レビュー数',0):,}件・★{c.get('レビュー平均')} | "
                 f"{'薬用' if c.get('薬用') else '—'} | {c.get('帯','')} | {c['_外す'] or '○'} |")
    書.append("")
    if 使える:
        一 = 使える[0]
        書 += ["## 推す順（数字で1行ずつ）", ""]
        for n, c in enumerate(使える[:3], 1):
            書.append(f"{n}. 番号{c.get('番号')}：レビュー {c.get('レビュー数',0):,}件・★{c.get('レビュー平均')}、"
                     f"{c.get('価格',0):,}円 × {c.get('料率')}% ＝ 1件 {c.get('見込み報酬',0):,}円"
                     f"{'、薬用（効能を承認文言どおり書ける）' if c.get('薬用') else ''}")
        書 += ["", f"## 第一候補：番号{一.get('番号')}", "",
              f"- 商品：{一.get('名','')[:60]}",
              f"- 素の商品ページ（楽天アフィリエイトで短縮する元）：{素のURL(一)}", ""]
    else:
        書 += ["## 第一候補：なし", "",
              "**使える候補が0件です。** 1:00 の自動実行は「自動で選べる候補がありません」で止まり、",
              "予備で埋めます（予備も無ければ枠は空）。代表が番号を選べば、上の外す理由に関係なく進められます。", ""]
    書 += ["## 返信のしかた", "", "「番号」と「その商品の短縮リンク（https://a.r10.to/…）」を返信してください。"]
    提案の置き場.write_text("\n".join(書) + "\n", encoding="utf-8")
    print("\n".join(書))


if __name__ == "__main__":
    main()
