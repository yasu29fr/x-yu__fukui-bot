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
    # 本人が名指しで選んだ商品。レビュー数が入らないぶん不利になるので、
    # 検索で入ってきたものと同じ土俵に乗せる。
    if x.get("手で入れた"):
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
    """重みのぶんだけ繰り返した並びを作る。重い商品ほど何度も現れる。

    ただの繰り返しだと同じ商品が続いてしまうので、重みつきの総当たり
    （nginx の smooth weighted round-robin と同じ考え方）で散らす。
    重い商品は間隔が短くなるだけで、隣り合わない。
    """
    # 売り切れの印が付いたものは選ばない（リンクが死んでいるため）
    products = [x for x in products if not x.get("売り切れ")]
    # 名前が入っていないものも選ばない。
    # 手で足した直後は名前が空のことがあり、その状態で【PR】を出すと
    # 「（名前未設定）」を紹介することになるため。
    products = [x for x in products if (x.get("名") or "").strip()]
    if not products:
        return []

    閲覧たち = [
        (x.get("成績") or {}).get("平均閲覧")
        for x in products
        if (x.get("成績") or {}).get("平均閲覧")
    ]
    閲覧の目安 = sorted(閲覧たち)[len(閲覧たち) // 2] if 閲覧たち else 0

    # 並びは毎回まったく同じでなければならない。url で順番を確定させる。
    候補 = sorted(products, key=lambda x: x.get("url", ""))
    重みたち = [重み(x, 閲覧の目安) for x in 候補]
    合計 = sum(重みたち)
    if 合計 <= 0:
        return list(候補)

    持ち点 = [0] * len(候補)
    出: list[dict] = []
    for _ in range(合計):
        for i, w in enumerate(重みたち):
            持ち点[i] += w
        # 同点のときは必ず若い番号を取る（毎回同じ並びにするため）
        選 = max(range(len(候補)), key=lambda i: (持ち点[i], -i))
        持ち点[選] -= 合計
        出.append(候補[選])

    return _隣をほどく(出)


def _隣をほどく(出: list[dict]) -> list[dict]:
    """同じ商品が 2 日続く箇所をなくす。並びは輪なので、最後と最初もつなげて見る。

    重い商品が 1 つだけ飛び抜けているときは、どう並べても続いてしまう。
    そういうときは、ほどけるところまでほどいて諦める（止めはしない）。
    """
    n = len(出)
    if n < 3:
        return 出

    def url(i: int) -> str:
        return 出[i % n].get("url", "")

    for _ in range(n):
        続く = [i for i in range(n) if url(i) == url(i + 1)]
        if not 続く:
            break
        直った = False
        for i in 続く:
            a = (i + 1) % n
            for j in range(n):
                if j == a or j == i:
                    continue
                # j のものを a に持ってきても、a の両隣とかぶらないか
                if url(j) == url(a - 1) or url(j) == url(a + 1):
                    continue
                # a のものを j に置いても、j の両隣とかぶらないか
                if url(a) == url(j - 1) or url(a) == url(j + 1):
                    continue
                出[a], 出[j] = 出[j], 出[a]
                直った = True
                break
            if 直った:
                break
        if not 直った:
            break
    return 出

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
    倍 = x.get("ポイント倍") or 1
    if 倍 > 1:
        かけら.append(f"いまポイント{倍}倍")
    if x.get("値下げ") and x.get("前の価格"):
        かけら.append(f"先週は{int(x['前の価格']):,}円")
    if x.get("店"):
        かけら.append(f"{x['店']}")

    # 手で選んだ商品は、価格やレビューが入っていないことがある。
    # その場合は本人のメモだけを渡す（無い数字をでっち上げない）。
    if x.get("手で入れた") and not かけら:
        かけら.append(x.get("メモ") or "本人が選んだもの")

    印 = "" if x.get("使ったことがある") else f"{未使用の印} "
    return {
        "name": x.get("名", ""),
        "url": x.get("url", ""),
        "memo": f"{印}" + ("" if x.get("手で入れた") else f"楽天の「{x.get('キーワード', '')}」から。") + "・".join(かけら),
        "raw": x,
    }
