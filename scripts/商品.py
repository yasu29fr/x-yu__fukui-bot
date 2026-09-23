"""紹介する商品を選ぶ。X と yu で同じ結果になるように作ってある。

なぜ同じ結果になるのか
----------------------
  - 商品リストは 1 つだけ（X のリポジトリの neta/商品.jsonl）。
    X は手元のファイルを読み、yu は同じファイルを https で読む。
  - 選び方は「日付から計算する」。乱数も、どこまで使ったかの記録も使わない。
    同じリスト・同じ日なら、どちらのアカウントでも同じ商品になる。

再投稿について
--------------
  同じ商品が何度も出るのは、こわれているのではなく、そう作ってある。
  セール中・レビューが多い・実際に反応がよかった商品ほど、
  並びの中に何度も現れるので、出る回数が増える。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

# X のリポジトリにある本体。yu はここを読む。
商品の置き場 = Path("neta/商品.jsonl")
商品のURL = (
    "https://raw.githubusercontent.com/yasu29fr/x-yu__fukui-bot/main/"
    "neta/%E5%95%86%E5%93%81.jsonl"
)

# 並びの起点。ここを動かすと、その日から出る商品がずれる。
起点 = date(2026, 1, 1)

# 「使った感想」を書かせない商品につける印（compose.py が見る）
未使用の印 = "[未使用]"


def 読む() -> list[dict]:
    """商品リストを読む。手元に無ければ https で取りに行く。"""
    if 商品の置き場.exists():
        text = 商品の置き場.read_text(encoding="utf-8")
    else:
        try:
            req = urllib.request.Request(商品のURL, headers={"User-Agent": "compose"})
            with urllib.request.urlopen(req, timeout=30) as res:
                text = res.read().decode("utf-8")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"::warning::商品リストを読めませんでした（{exc}）。今日は紹介しません。")
            return []

    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def 重み(x: dict, 閲覧の目安: float) -> int:
    """その商品が並びの中に何回現れるか。1〜4。

    1 は「ひととおり回ってきたら出る」。4 は「4 倍の頻度で出る」。
    """
    w = 1
    レビュー = x.get("レビュー数") or 0
    if レビュー >= 3000:
        w += 1
    if レビュー >= 8000:
        w += 1
    if x.get("セール"):
        w += 1
    if x.get("使ったことがある"):
        w += 1

    成績 = x.get("成績") or {}
    閲覧 = 成績.get("平均閲覧")
    if 閲覧 and 閲覧の目安:
        if 閲覧 >= 閲覧の目安 * 1.5:
            w += 2
        elif 閲覧 >= 閲覧の目安:
            w += 1
    return max(1, min(4, w))


def 並び(products: list[dict]) -> list[dict]:
    """重みのぶんだけ繰り返した並びを作る。重い商品ほど何度も現れる。"""
    if not products:
        return []

    閲覧たち = [
        (x.get("成績") or {}).get("平均閲覧")
        for x in products
        if (x.get("成績") or {}).get("平均閲覧")
    ]
    閲覧の目安 = sorted(閲覧たち)[len(閲覧たち) // 2] if 閲覧たち else 0

    重みつき = [(x, 重み(x, 閲覧の目安)) for x in products]
    # 並びは毎回同じでなければならないので、url で確定させる
    重みつき.sort(key=lambda t: (-t[1], t[0].get("追加日", ""), t[0].get("url", "")))

    最大 = max(w for _, w in 重みつき)
    出: list[dict] = []
    for 周 in range(最大):
        # 周が進むほど、重い商品だけが残る
        この周 = [x for x, w in 重みつき if w > 周]
        if 周 % 2 == 1:
            この周 = list(reversed(この周))  # 同じ並びが続かないように向きを変える
        出.extend(この周)

    # 同じ商品が 2 日続かないようにする（1 件しか無いときを除く）
    if len({id(x) for x in 出}) > 1:
        for i in range(len(出)):
            j = (i + 1) % len(出)
            if 出[i].get("url") == 出[j].get("url"):
                k = next(
                    (m for m in range(len(出))
                     if 出[m].get("url") not in (出[i].get("url"), 出[(j + 1) % len(出)].get("url"))),
                    None,
                )
                if k is not None:
                    出[j], 出[k] = 出[k], 出[j]
    return 出


def 今日の商品(対象日: date, products: list[dict] | None = None) -> dict | None:
    """その日に紹介する商品を 1 つ返す。無ければ None。"""
    products = 読む() if products is None else products
    列 = 並び(products)
    if not 列:
        return None
    return 列[(対象日 - 起点).days % len(列)]


def 投稿用にする(x: dict) -> dict:
    """compose.py が扱う形（name / url / memo）に直す。"""
    かけら = []
    if x.get("価格"):
        かけら.append(f"{int(x['価格']):,}円")
    if x.get("レビュー数"):
        かけら.append(f"レビュー{x['レビュー数']}件")
    if x.get("レビュー平均"):
        かけら.append(f"評価{x['レビュー平均']}")
    if x.get("セール"):
        倍 = x.get("ポイント倍") or 1
        かけら.append(f"いまセール中（ポイント{倍}倍）" if 倍 > 1 else "いま値引き中")
    if x.get("店"):
        かけら.append(f"{x['店']}")

    印 = "" if x.get("使ったことがある") else f"{未使用の印} "
    return {
        "name": x.get("名", ""),
        "url": x.get("url", ""),
        "memo": f"{印}楽天の「{x.get('キーワード', '')}」から。" + "・".join(かけら),
        "raw": x,
    }
