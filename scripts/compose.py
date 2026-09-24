"""翌日ぶんの X 投稿 3 本を作成し、投稿キューに追加する。

発信の中心は撮影機材とガジェット。実際に使ってみて分かったことだけを書く。

外部 cron から毎日 20:00 JST に起動される想定。

材料:
  - 運用ボード（Google ドキュメント / リンクを知っている全員が閲覧可）
  - ネタ帳（同上）
  - posts/queue.jsonl の直近の投稿（重複回避のため）

必要な環境変数:
  ANTHROPIC_API_KEY  必須。Anthropic の API キー
  BOARD_DOC_ID       任意。運用ボードの Google ドキュメント ID
  NETA_DOC_ID        任意。ネタ帳の Google ドキュメント ID
                     （neta/ネタ帳.md があるときは、そちらが優先される）
  ANTHROPIC_MODEL    任意。使うモデル。未指定なら利用可能なものから自動で選ぶ
  DRY_RUN            任意。"true" なら生成結果を表示するだけでファイルを書き換えない
"""

from __future__ import annotations

import json
import os
import re
import random
import string
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import お得日
import 商品
import 宿

# 文字数の数え方は投稿側と同じものを使う（URL は一律 23）。
# ここで数え方がずれると、投稿できるものを弾いたり、上限超えを見逃したりする。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from x_bot.client import weighted_length  # noqa: E402

JST = ZoneInfo("Asia/Tokyo")
QUEUE_PATH = Path("posts/queue.jsonl")
API_BASE = "https://api.anthropic.com/v1"
API_VERSION = "2023-06-01"

# 予約する時刻と、その枠の役割
#
# 発信の中心は撮影機材とガジェット。朝と昼は道具の話に固定し、夜だけ幅を
# 持たせる。毎日同じ話題が並ぶと読み飽きるので、逃げ場を 1 枠だけ置いてある。
POLICY_CORE = """## 発信方針（2026-09-13 確定。ここが最優先の考え方）

読まれるかどうかは、書き出しが「外の話」か「自分たちの話」かで決まる。
同じアカウント・同じ書き手で、外の出来事から入った投稿は表示 2,820、
自社の作業手順から入った投稿は表示 6 だった。470 倍の差がある。

だから、投稿は次の順で組み立てる。

① 世の中・身近な出来事        ← 1行目。ここで読まれるかが決まる
② それによって起こる変化
③ 読者に発生する悩み・欲求     ← ここを飛ばすと「なんで？」になる
④ 必要になる行動
⑤ 商品・サービスにつながる解決策

**どこで止めるかは枠ごとに指定する（深さ A〜C）。指定より深く着地しないこと。**
- A: ①だけ。出来事の共有で終える
- B: ③まで。問題提起で止める（主力）
- C: ⑤まで。ただし商品名・サービス名・URLは書かない

すべての投稿を ⑤ まで着地させてはいけない。毎回着地させると ① が
売り込みの前振りに見え、① ごと読まれなくなる。

### 1行目の決まり
- 自分・自社・自社の商品の話で始めない
- 「〜しています」で始めない。断言か数字で始める
- 主語を「わたし」「うち」「当社」にしない
- 「作りました」「できました」で始めない（実測で平均の3分の1しか読まれない）

### つなげない話題
災害、事件、病気など、人の被害が絡む出来事は、商品にも自分たちのテーマにも
つなげない。論理が通っても感情が通らない。
"""

POLICY_ACCOUNT = """### この出来事を見るときに通す質問

**「この出来事は、撮る人・編集する人に何が起きる？」**

機材のスペック解説はしない。書くのは「で、撮る人に何が起きるか」だけ。

### 読者に起きている「瞬間」（③④の材料。ここから1つ選ぶ）

- インタビューの当日、聞いていた服装と襟の形が違った
- 現場で音が回って、録り直しになった
- 屋外で風の音が入って使えなかった
- 出演者が緊張して、声が小さくなった
- 一人で撮っていて、カメラと音の両方を見られない
- 機材を増やしたら、現場で出す順番が決まらなくなった
- 撤収のとき、小さいものが行方不明になった
- バッテリーが撮影の途中で切れた
- 編集で音のレベルがバラバラになっていた
- 移動が多くて、荷物を減らしたい
- 予算が限られていて、何から買うか決められない
- 買ったものを使わないまま置いている
"""

DEPTH = {7: "B", 12: "C", 21: "A"}

SLOTS = [
    (
        7,
        "撮影機材・ガジェットの使いどころ",
        "B（ノウハウ型）またはA（気づき型）",
        "通勤前に読んで、その日の撮影や編集にすぐ使える",
    ),
    (
        12,
        "実際に使っている道具の話",
        "C（裏側型）またはB（ノウハウ型）",
        "手を動かしている人だと伝わる。具体が見える",
    ),
    (
        15,
        "楽天トラベルの紹介（PR）",
        "F（紹介型）",
        "3アカウント共通の枠。同じ日は同じ内容を出し、アカウントごとの効き方を比べる。5と0のつく日はクーポン1本の短文、それ以外は宿のまとめ",
    ),
    (
        18,
        "楽天のお得日のお知らせ",
        "F（紹介型）",
        "お得日（1日・5と0のつく日・18日）だけ出る枠。該当しない日はこの枠を作らない",
    ),
    (
        21,
        "機材まわりの気づき・問いかけ",
        "E（問いかけ型）またはA（気づき型）",
        "人柄が伝わり、返信・会話が生まれる",
    ),
]

# 紹介（アフィリエイト）を入れてよい枠。1 日 1 本まで。
# 朝と夜は紹介を入れない。宣伝ばかりのアカウントに見せないため。
PR_HOUR = 12

# 未指定のときに上から順に探すモデル
MODEL_PREFERENCE = ("opus", "sonnet", "haiku")


LEARNINGS_PATH = Path("insights/learnings.md")


def learning_section() -> list[str]:
    """検証チーム（scripts/review.py）が毎日更新する指示を読む。無ければ何も足さない。"""
    if not LEARNINGS_PATH.exists():
        return []
    text = LEARNINGS_PATH.read_text(encoding="utf-8").strip()
    if not text:
        return []
    return [
        "## 検証チームからの指示（直近 7 日の数字に基づく）",
        "以下は実際の閲覧・反応の数字から決めた指示です。切り口・長さ・連投・話題の比重はこれに従ってください。",
        "ただし、運用ボードの文体・禁止事項・事実の扱いを超えることはできません。食い違えば運用ボードを優先します。",
        text,
        "",
    ]


def fail(message: str) -> None:
    print(f"::error::{message}")
    sys.exit(1)


def fetch_doc(doc_id: str, label: str) -> str:
    """Google ドキュメントをプレーンテキストで取得する。

    「リンクを知っている全員が閲覧可」になっていれば認証なしで読める。
    読めなくても処理は止めず、その材料なしで続ける。
    """
    if not doc_id:
        print(f"{label}: ID が未設定のため読み込みません。")
        return ""
    url = f"https://docs.google.com/document/d/{doc_id}/export?format=txt"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            if response.status != 200:
                print(f"::warning::{label}: 取得できませんでした (HTTP {response.status})")
                return ""
            text = response.read().decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001 - 材料が欠けても続行する
        print(f"::warning::{label}: 取得に失敗しました ({exc})")
        return ""
    print(f"{label}: {len(text)} 文字を読み込みました。")
    return text


NETA_PATH = Path("neta/ネタ帳.md")


def read_neta() -> str:
    """ネタ帳を読む。リポジトリの中にあれば、それを使う。

    2026-09-14 に置き場所を Google ドキュメントからこのリポジトリへ移した。
    毎朝の自動収集（.github/workflows/neta-collect.yml）がここに追記する。
    ファイルが無いときだけ、従来どおり NETA_DOC_ID のドキュメントを読む。
    移行の途中でも、どちらか読めたほうで動く。
    """
    if NETA_PATH.exists():
        text = NETA_PATH.read_text(encoding="utf-8")
        print(f"ネタ帳: {NETA_PATH} から {len(text)} 文字を読み込みました。")
        return text
    return fetch_doc(os.environ.get("NETA_DOC_ID", "").strip(), "ネタ帳")


def api_request(method: str, path: str, api_key: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(API_BASE + path, data=data, method=method)
    request.add_header("x-api-key", api_key)
    request.add_header("anthropic-version", API_VERSION)
    request.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        fail(f"Anthropic API エラー ({exc.code}): {detail}")
    except Exception as exc:  # noqa: BLE001
        fail(f"Anthropic API に接続できませんでした: {exc}")
    return {}


def pick_model(api_key: str) -> str:
    """使うモデルを決める。指定がなければ利用可能なものから選ぶ。"""
    explicit = os.environ.get("ANTHROPIC_MODEL", "").strip()
    if explicit:
        return explicit
    payload = api_request("GET", "/models?limit=100", api_key)
    ids = [m["id"] for m in payload.get("data", [])]
    if not ids:
        fail("利用できるモデルが見つかりませんでした。ANTHROPIC_MODEL を指定してください。")
    for keyword in MODEL_PREFERENCE:
        for model_id in ids:
            if keyword in model_id:
                print(f"モデル: {model_id}")
                return model_id
    print(f"モデル: {ids[0]}")
    return ids[0]


def read_queue_lines() -> list[str]:
    if not QUEUE_PATH.exists():
        fail(f"キューが見つかりません: {QUEUE_PATH}")
    return QUEUE_PATH.read_text(encoding="utf-8").splitlines()


def parse_entries(lines: list[str]) -> list[dict]:
    entries = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            entries.append(json.loads(stripped))
        except json.JSONDecodeError:
            continue
    return entries


def recent_texts(entries: list[dict], count: int | None = None) -> str:
    """直近の投稿を「日時・1 行目・使ったネタ」の形で返す。

    重複を避けるのが目的なので、本文全部ではなく 1 行目と note だけを渡す。
    件数は 1 日の枠数 × 7 日（2026-09-18 変更。固定件数だと本数の多い
    アカウントで 2 日ぶんしか見えず、同じネタが何度も出ていた）。
    """
    if count is None:
        count = max(len(SLOTS) * 7, 20)
    # キューはファイル順が時系列とは限らない（あとから別の枠を足すことがある）。
    # 予約時刻で並べ直し、まだ出ていないものは除いてから直近を取る。
    now = datetime.now(JST).isoformat()
    dated = [e for e in entries if isinstance(e.get("scheduled_at"), str)]
    past = sorted((e for e in dated if e["scheduled_at"] <= now), key=lambda e: e["scheduled_at"])
    parts = []
    for entry in past[-count:]:
        first = (entry.get("text", "") or "").split("\n")[0].strip()
        when = (entry.get("scheduled_at") or "")[5:16].replace("T", " ")
        note = (entry.get("note") or "").strip()
        line = f"- {when} ｜ {first}"
        if note:
            line += f"  〔{note}〕"
        parts.append(line)
    return "\n".join(parts)


def find_filled(entries: list[dict], target_date) -> dict[int, dict]:
    """対象日にすでに予約が入っている枠を、時 -> 投稿 の形で返す。"""
    prefix = target_date.isoformat()
    filled: dict[int, dict] = {}
    for entry in entries:
        scheduled = entry.get("scheduled_at")
        if not isinstance(scheduled, str) or not scheduled.startswith(prefix):
            continue
        # 12:30 のような枠外の予約が 12:00 の枠を埋めたことにならないよう、
        # 分が 00 のものだけを「枠が埋まっている」とみなす
        if scheduled[14:16] != "00":
            continue
        try:
            hour = int(scheduled[11:13])
        except (ValueError, IndexError):
            continue
        filled[hour] = entry
    return filled


def describe_filled(filled: dict[int, dict]) -> str:
    if not filled:
        return ""
    parts = []
    for hour in sorted(filled):
        entry = filled[hour]
        thread = " ".join(entry.get("thread") or [])
        parts.append(f"- {hour}:00 ｜ {entry.get('text','')} {thread}".strip())
    return "\n".join(parts)


def build_prompt(board: str, neta: str, recent: str, target_date, needed, filled, product=None, pr_hour=None, hotel=None, hotel_hour=None, mugi=None, deal=None, deal_hour=None) -> str:
    def _枠の行(hour, pillar, form, aim):
        行 = f"- {hour}:00 ｜ 深さ: {DEPTH.get(hour, 'B')} ｜ 柱: {pillar} ｜ 型: {form} ｜ ねらい: {aim}"
        # PR の枠は、9枠ぶんの指示に埋もれて読み飛ばされることがある。
        # 枠の一覧そのものに印を出して、見落としを防ぐ（2026-09-25）。
        if hotel_hour is not None and hour == hotel_hour:
            行 += ("\n  ★★ この枠は下の「PR」の節の指示だけに従ってください。"
                   "**本文を必ず【PR】で始めること。** 上の柱・型の指示は当てはめません ★★")
        return 行

    slot_lines = "\n".join(_枠の行(*x) for x in needed)
    weekday = "月火水木金土日"[target_date.weekday()]
    hours = "、".join(f"{hour}:00" for hour, *_ in needed)
    already = describe_filled(filled)
    sections = [
        "あなたは YU さん（福井市のフリーランス Web クリエイター／SNS コンテンツ制作者）の",
        "X 発信チームの編集担当です。",
        f"{target_date.isoformat()}（{weekday}）の {hours} に投稿する {len(needed)} 本を書いてください。",
        "",
        "## 枠と役割",
        slot_lines,
        "",
        "## 話題の方針（運用ボードより優先）",
        "この発信は、撮影機材とガジェットを実際に使っている人の話にします。",
        "カメラ・レンズ・マイク・照明・編集まわりの道具、その使いどころと失敗。",
        "",
        "",
        "書くのは、実際に使ってみて分かったことに限ります。",
        "使っていない道具のスペックを並べた紹介は書かないこと。",
        "",
    ]
    if already:
        sections += [
            "## 同じ日にすでに入っている投稿（YU さん本人が用意したもの）",
            "これらとネタ・切り口・書き出しが重ならないようにしてください。",
            "文体もこれらに寄せてください。",
            already,
            "",
        ]
    if product and pr_hour is not None:
        sections += [
            f"## {pr_hour}:00 の枠だけ、商品の紹介です",
            "",
            f"紹介する商品: {product['name']}",
            f"本人のメモ: {product['memo'] or '（なし）'}",
            "",
            "この枠の書き方には、守っていただく決まりがあります。",
            "",
            "1. **本文の冒頭を必ず「【PR】」で始める。** 末尾ではなく先頭です（ステマ規制）",
            "2. **URL は絶対に書かない。** リンクはこちらで別に付けます。",
            "   「詳細はこちら」のような誘導文も本文に入れないこと",
            "3. 本人のメモに書かれている範囲のことだけを書く。",
            "   使っていない機能や、確かめていない良さを足さないこと",
            *product_rules(product),
            "5. 「買うべき」「おすすめです」と言い切らない。判断は読む人に任せる",
            "6. 合わない人・向かない場面にも一言触れる。良いことだけ並べない",
            "",
            "本文は【PR】を含めて日本語 60〜120 字。thread は付けないでください。",
            "",
        ]
    if not product:
        sections += [
            "## 今日は商品の紹介をしません",
            "",
            "紹介できる商品が用意されていません。**どの枠でも商品紹介を書かないでください。**",
            "",
            "- 本文を「【PR】」「#PR」「[PR]」で始めない",
            "- 特定の商品名を出して、良さを伝える書き方をしない",
            "- 購入をすすめる書き方をしない",
            "",
            "材料に商品の情報があっても、今日は使いません。",
            "道具の話をする場合は、**商品名を出さずに**、やり方や気づきとして書いてください。",
            "",
        ]
    sections += [
        *learning_section(),
        "## 運用ボード（文体・書かないこと・品質基準の最優先ルール）",
        "上の「話題の方針」と食い違うときだけ、話題の方針を優先してください。",
        "それ以外（文体・禁止事項・型・プロフィール）は、すべてボードに従います。",
        board or "（読み込めませんでした。以下の要点だけで書いてください）",
        "",
        "## ネタ帳（YU さん本人が書いた生の材料。最優先で使う）",
        neta or "（空です）",
        "",
        "## 同じネタ・同じ投稿の使い回し（2026-09-18 代表指示）",
        "",
        "同じネタを何度使ってもかまいません。**同じ日に重ねないことだけ守ってください。**",
        "",
        "- **同じ出来事（催し・店・記事）は、1 日に 1 本まで（2026-09-23 代表指示）。**",
        "  **同じかどうかは「出典元：」の URL で見ます。**",
        "  同じ URL を 1 日に 2 本以上使わないこと。時間を空ければよい、ではありません",
        "  （これまでの「1 日 2 本まで・4 時間以上あける」は廃止しました）",
        "- **2 日続けて同じ出来事を出さない。** 1 日あける",
        "  ただし **開催日まで 3 日以内の催しは、毎日 1 本まで出してよい**（直前の告知は効くため）",
        "- **同じ書き出し（1 行目）を同じ日に 2 回使わない。** 角度を変える",
        "- **本文をそのまま出し直すのは、前回から 7 日以上あいていれば可。**",
        "  伸びた投稿の再掲は歓迎します。ネタが薄い日は、新しく薄いものを作るより再掲のほうがよい",
        "",
        "## 直近 7 日の投稿（日時・1 行目・使ったネタ）",
        "",
        "**ここに出ている出来事・記事・切り口は、上のルールに照らして使えるかを必ず確認すること。**",
        recent or "（なし）",
        "",
        POLICY_CORE,
        "",
        POLICY_ACCOUNT,
        "",
        "## 連投の 1 本目（本文）について（2026-09-18 代表指示）",
        "",
        "**本文だけを読んで、何の話か分かるように書いてください。**",
        "thread を読まなくても「何について」「誰に関係するか」が伝わること。",
        "",
        "これまで「80 字に入りきらない分は thread に回す」と指示していたため、",
        "本文が言いかけで終わり、何の話か分からない投稿が出ていました。**その指示は取り消します。**",
        "",
        "  × 9月に入って、夏の記憶がすこし遠くなりました。（何の話か分からない）",
        "  ○ 福井のシンガーソングライターが、夏を1枚のアルバムにしています。",
        "",
        "80 字以内は続けます。ただし **「入りきらない分を thread に回す」のではなく、",
        "「本文で言い切れる大きさまで話を絞る」** と考えてください。",
        "**thread は補足であって、本文の続きではありません。**",
        "",
        "## 文体の要点",
        "- 丁寧で落ち着いた敬語。です・ます調",
        "- 一文は短く。3〜4 行ごとに空行",
        "- 冒頭 1 行（長くても 2 行）に、その投稿の中身を表すキーワードを 2 つ入れる",
        "  例:「ClaudeでThreads投稿アプリできました。」→ Claude ／ Threads投稿アプリ",
        "  キーワードは、ツール名・機能名・作業名など、検索で引っかかる具体的な語にする",
        "  「効率化」「工夫」「大切なこと」のような抽象語はキーワードに数えない",
        "  そのうえで、冒頭 1 行で読み進めたくなる形にする",
        "- 絵文字は使わない。ハッシュタグは 0〜1 個",
        "- リンクは貼らない",
        "- 1 投稿につき伝えたいことは 1 つだけ",
        "- クライアント実名は出さない（「福井の解体業の会社さん」のように業種で表現する）",
        "- 金額・社内事情・未公開情報は書かない",
        "- 誇張しない、盛らない。自慢に読めないよう、学び・失敗・裏側の形で語る",
        "",
        "## 絶対に書かないこと",
        "- 金額・料金・プラン名・単価。「月◯万円」「◯円から」「初期費用」なども一切書かない。",
        "  営業資料に価格が載っていても、投稿には持ち込まない。料金の話題自体を避ける。",
        "- 電話番号・住所・担当者名などの連絡先",
        "- 契約期間、見積り、値引き、キャンペーンの条件",
        "",
        "## 事実について（最重要）",
        "確認できない事実を創作しないこと。ネタ帳・運用ボード・直近の投稿に根拠がある内容だけを書く。",
        "成果や反響（「問い合わせが増えました」など）は、根拠がない限り絶対に書かない。",
        "運用ボードやネタ帳に書かれている数字（再生数・フォロワー数など）は、",
        "そこにある値のまま使ってかまいません。丸めたり盛ったりしないこと。",
        "材料にない数字は、たとえもっともらしくても作らないこと。",
        "材料が足りなければ、材料のある範囲で小さく書く。",
        "ネタ帳の「使ってほしくないネタ」に書かれた話題は絶対に使わない。",
        "",
        "## 長さと形（X は Threads と違います）",
        "- **X は日本語を 1 文字 2 として数えます。上限 280 = 日本語 140 字です**",
        "- text は日本語 60〜130 字。ここを超えたら投稿できません",
        "- 続きは thread に回す。thread も 1 件あたり日本語 130 字まで",
        "- thread は 1〜2 件。長い話は無理に 1 本に詰めない",
        "- 短いぶん、1 投稿で言うことは 1 つだけに絞る",
        "",
        "## 出力形式",
        "JSON では返さないでください。次の形式のテキストだけを返します。",
        "前後に説明や ``` を付けないこと。",
        "",
        "@@@POST",
        "HOUR: 7",
        "NOTE: 使った柱と型とネタ",
        "TEXT:",
        "本文をここに書く。改行や空行はそのまま書いてよい。",
        "THREAD:",
        "連投の 1 件目。改行や空行はそのまま書いてよい。",
        "THREAD:",
        "連投の 2 件目。無ければこの 2 行ごと省く。",
        "@@@END",
        "",
        f"{hours} のぶんを、この順に @@@POST 〜 @@@END の組で並べてください。",
        "HOUR には 7 / 12 / 21 のいずれかの数字だけを書きます。",
    ]
    if mugi and hotel_hour is not None:
        sections += [
            f"## {hotel_hour}:00 の枠は、クーポンのお知らせです（楽天トラベル・PR）",
            "",
            f"今日は楽天トラベルの「{mugi['お得日']['名']}」。{mugi['お得日']['何が']}。",
            f"{mugi['お得日']['条件']}",
            *([f"うたい文句: {mugi['うたい文句']}"] if mugi["うたい文句"] else []),
            "",
            "**この枠は、宿を並べません。クーポンの話だけを短く書きます。**",
            "代表共有のnote記事で、2日で66,102円になった型です。",
            "型は「誰向け ＋ どんなお得 ＋ 期限」。",
            "",
            *むぎの決まり(mugi),
            "",
        ]
    if hotel and hotel_hour is not None:
        # 5と0のつく日は、楽天トラベルのクーポンが出る（エントリー不要）。
        旅の得 = お得日.旅(target_date)
        sections += [
            f"## {hotel_hour}:00 の枠は、宿のまとめです（楽天トラベル・PR）",
            "",
            *(
                [
                    f"今日は楽天トラベルの「{旅の得['名']}」（{旅の得['何が']}）。",
                    "クーポンの案内は返信にこちらで付けるので、見出しには書かないでください。",
                    "",
                ]
                if 旅の得
                else []
            ),
            "今日並べる宿（こちらで組み立てます。あなたは見出しだけ書いてください）:",
            *[f"- {行}" for 行 in hotel["一覧"]],
            "",
            *宿の決まり(hotel),
            "",
        ]
    if not hotel and hotel_hour is None:
        sections += [
            "## 今日は宿の紹介をしません",
            "",
            "紹介できる宿が用意されていません。**どの枠でも宿の紹介を書かないでください。**",
            "宿の名前を出して良さを伝える書き方をしない。予約をすすめる書き方をしない。",
            "",
        ]
    if deal and deal_hour is not None:
        sections += [
            f"## {deal_hour}:00 の枠だけ、今日のお得日の話です（楽天市場・PR）",
            "",
            f"今日は「{deal['お得日']['名']}」（{deal['お得日']['いつ']}）。{deal['お得日']['何が']}。",
            f"条件: {deal['お得日']['条件']}",
            "",
            "この枠で並べる商品（渡したものだけ。足さないこと）:",
            *[
                f"- {x['name']}｜"
                + "・".join(
                    かけら
                    for かけら in x["memo"].split("・")
                    if "ポイント" not in かけら
                )
                for x in deal["商品"]
            ],
            "",
            "この枠の書き方には、守っていただく決まりがあります。",
            "",
            "1. **本文の冒頭を必ず「【PR】」で始める。** 末尾ではなく先頭です（ステマ規制）",
            "2. **1行目で「誰に向けた話か」をはっきり書く。**",
            "   例：「スマホで撮っている人へ」。全員に向けて書かないこと",
            "3. **倍率・割引率などの数字は書かない。** 楽天のキャンペーンは予告なく変わります。",
            "   変わった日に嘘になるので、「ポイントが増える日」までにとどめて、",
            "   くわしい条件はリンク先で見てもらってください",
            "4. **エントリーが要ることを必ず書く。**",
            "   忘れると1円も得をしません。書かないと読む人に損をさせます",
            *(
                ["5. **ゴールド会員以上が対象だと必ず書く。**",
                 "   誰でも得をする日ではありません。書かないと嘘になります"]
                if not deal["お得日"].get("誰でも", True)
                else ["5. 会員ランクの条件はありません。誰でも参加できる日です"]
            ),
            f"6. **いつまでかを書く（{deal['お得日']['期限']}）。** いま見る理由になります",
            "7. **URL は絶対に書かない。** リンクは連投（コメント欄）にこちらで付けます",
            "8. 「買うべき」と言い切らない。得なのは値段ではなくポイントです",
            "",
            "本文は【PR】を含めて日本語 60〜120 字。短いほうが読まれます。",
            "連投（リンク）はこちらで付けるので、thread は空のままにしてください。",
            "",
        ]
    return "\n".join(sections)


def parse_posts(text: str) -> list[dict]:
    """@@@POST 〜 @@@END の組を読み取る。

    JSON をやめたのは、本文に改行と空行が入るため。モデルが改行をそのまま書くと
    JSON として壊れ、投稿が 1 本も作られない日が出た。区切り記号なら改行は素通りする。
    """
    posts = []
    for body in re.findall(r"@@@POST[ \t]*\n(.*?)\n?@@@END", text, re.S):
        item = {"hour": None, "note": "", "text": "", "thread": []}
        tokens = re.split(r"^(HOUR:|NOTE:|TEXT:|THREAD:)", body, flags=re.M)
        for key, value in zip(tokens[1::2], tokens[2::2]):
            value = value.strip()
            if key == "HOUR:":
                digits = re.sub(r"\D", "", value)
                item["hour"] = int(digits) if digits else None
            elif key == "NOTE:":
                item["note"] = value
            elif key == "TEXT:":
                item["text"] = value
            elif key == "THREAD:" and value:
                item["thread"].append(value)
        if item["hour"] is not None and item["text"]:
            posts.append(item)
    return posts


def ask(api_key: str, model: str, prompt: str) -> str:
    payload = api_request(
        "POST",
        "/messages",
        api_key,
        {
            "model": model,
            "max_tokens": 8000,
            "messages": [{"role": "user", "content": prompt}],
        },
    )
    return "".join(
        block.get("text", "") for block in payload.get("content", []) if block.get("type") == "text"
    ).strip()


def generate(api_key: str, model: str, prompt: str, expected: int) -> list[dict]:
    """1 度目で本数が揃わなければ、形式を念押しして 1 度だけやり直す。"""
    reminder = (
        "\n\n---\n直前の返答は形式が守られていませんでした。"
        "説明や ``` を付けず、@@@POST 〜 @@@END の組だけを返してください。"
    )
    for attempt in (1, 2):
        text = ask(api_key, model, prompt if attempt == 1 else prompt + reminder)
        posts = parse_posts(text)
        if len(posts) == expected:
            return posts
        print(f"::warning::{attempt} 回目: {expected} 本のはずが {len(posts)} 本でした。")
        if attempt == 2:
            fail(
                f"{expected} 本を作れませんでした（2 回試行）。\n--- 生の出力 ---\n{text[:1200]}"
            )
    return []


# 紹介する商品は scripts/商品.py が選ぶ。リストは X のリポジトリの
# neta/商品.jsonl ただ 1 つで、X も yu も同じものを読む。
# 選び方は日付から計算するので、同じ日なら両方のアカウントで同じ商品になる。
# URL は AI に渡さず、リストにある文字列をそのまま投稿に入れる。
# AI に URL を書かせると、1 文字変わっただけで別の場所へ飛ぶため。

PR_MARKERS = ("【PR】", "#PR", "＃PR", "[PR]")

# 楽天の検索で入れた商品には、メモの先頭に「[未使用]」が付く
# （scripts/商品を取る.mjs）。本人が使ったことのある商品との書き分けに使う。
UNUSED_MARK = 商品.未使用の印

# 未使用の商品でこれが出たら止める。検索で見つけただけの道具に
# 「使っている」と書かせると、それはただの嘘になる。
USED_VOICE = re.compile(
    r"使って(み|い)|使った|使ってる|愛用|買ってよかった|買って良かった|"
    r"届いた|試した|試してみ|導入して|乗り換え(た|て)|手放せ|使い始め"
)


def is_unused(product: dict | None) -> bool:
    """本人がまだ使っていない商品か。"""
    return bool(product) and UNUSED_MARK in (product.get("memo") or "")


def product_rules(product: dict) -> list[str]:
    """商品の出どころで 4 番目の決まりを差し替える。"""
    if is_unused(product):
        return [
            "4. **この商品を、本人はまだ使っていません。**",
            "   「使っている」「使ってみた」「買ってよかった」「愛用」は書かないこと。",
            "   書けるのは、何をする道具か・どんな場面で要るか・どんな人に向くか、",
            "   そして **自分はまだ試していない** ということだけです。",
            "   「気になっています」「まだ試していません」のように、"
            "未使用だと分かる形で書いてください",
        ]
    return ["4. スペックの列挙にしない。実際に使ってどうだったかを書く"]


URL_IN_TEXT = re.compile(r"https?://\S+")


# 「出典元：」に書かれた URL を取り出す。
# 同じ催しを 1 日に 2 本出していないかは、この URL で見る（2026-09-23 代表指示）。
# 本文の言い回しは変えられても、出典は変えられないので、これがいちばん確かな鍵になる。
SOURCE_URL = re.compile(r"出典元[：:]\s*(https?://\S+)")


def source_urls(text: str, thread: list[str]) -> set[str]:
    found = set()
    for part in [text or "", *(thread or [])]:
        for url in SOURCE_URL.findall(part):
            found.add(url.rstrip("）)、。,. "))
    return found



# 宿の紹介枠（2026-09-23 代表指示）。楽天トラベルのアフィリエイト。
# どの宿をどの切り口で出すかは scripts/宿.py が日付から決める。
# 3アカウントとも同じリスト・同じ計算なので、同じ日には同じ内容になる。
DEAL_HOUR = 18

# 1本のまとめに何軒並べるか。
宿の軒数 = 5

HOTEL_HOUR = 15

# 【PR】の印。本文の先頭に無ければ止める（ステマ規制）。
if "PR_MARKERS" not in dir():
    PR_MARKERS = ("【PR】", "#PR", "＃PR", "[PR]")
if "URL_IN_TEXT" not in dir():
    URL_IN_TEXT = re.compile(r"https?://\S+")

# 泊まっていない宿を「泊まった」と書かせない。
# 楽天トラベルに載っている情報を読んで書くだけなので、体験として書くと嘘になる。
STAYED_VOICE = re.compile(
    r"泊まっ(た|て)|宿泊した|行ってき|訪れた|使ってみ|入ってみ|食べてき"
)


# 宿の枠の2つの型（2026-09-24 代表判断）。どちらが稼ぐかを数字で比べる。
#
#   むぎ型 … クーポン1本だけ。40〜90字。代表共有のnote記事で
#             2日66,102円になった型（誰向け ＋ どんなお得 ＋ 期限）。
#   9選型 … 宿を7軒並べて、返信に1軒ずつリンク。到達は取れている型
#            （代表が見つけた投稿は表示1.5万・いいね570）。
#
# 5と0のつく日は むぎ型、それ以外は 9選型 にする。
# むぎ型の力は「期限」にあり、期限が作れるのはクーポンが出る日だけのため。
# 成果は楽天アフィリエイトのレポートで分かれて見える
# （むぎ型＝クーポンのリンク、9選型＝宿のリンク）。


def 宿の型(対象日) -> str:
    """その日の宿の枠をどちらの型で書くか。"""
    return "むぎ" if お得日.旅(対象日) else "9選"


def むぎの決まり(材料: dict) -> list[str]:
    """むぎ型で守ってもらう決まり。"""
    数 = 材料.get("うたい文句") or ""
    return [
        "1. **本文の冒頭を必ず「【PR】」で始める。** 末尾ではなく先頭です（ステマ規制）",
        "2. **1行目で「誰に向けた話か」をはっきり書く。**",
        "   例：「週末に福井へ泊まる人へ」「連休に子どもと出かける人へ」。",
        "   全員に向けて書かないこと。宛先がはっきりしている投稿ほど読まれます",
        "3. **どんなお得かを一言で。**",
        (f"   書いてよい数字は「{数}」だけです。これ以外の数字を作らないこと"
         if 数 else "   数字は書かないでください。渡していません"),
        f"4. **いつまでかを書く（{材料.get('期限') or 'この日から48時間'}）。**",
        "   いま見る理由になります。ここが無いと後回しにされます",
        "5. **エントリーは要らないと書いてよい。** ただし",
        "   「クーポンは自分で取りに行く必要がある」ことも書いてください",
        "6. **宿の名前を出さない。** この枠はクーポンの話だけです",
        "7. **URL は絶対に書かない。** リンクは返信（コメント欄）にこちらで付けます",
        "8. 「泊まった」「行ってきた」と書かない",
        "",
        "**本文は【PR】を含めて日本語 40〜90 字。短いほど読まれます。**",
        "note記事で20.2万表示・66,102円になった投稿は37字でした。長く書かないこと。",
        "thread は空のままにしてください。返信はこちらで付けます。",
    ]


def むぎの返信(材料: dict) -> list[str]:
    """むぎ型の返信。クーポンのリンク1本だけ。"""
    行 = ["PR", "楽天トラベルのクーポンはこちらです", ""]
    for c in 材料["クーポン"][:2]:
        行.append(f"{c['名']}\n{c['url']}")
        行.append("")
    return ["\n".join(行).strip()]


def むぎの数字(text: str, 材料: dict) -> str | None:
    """本文にある数字のうち、渡したうたい文句に無いものを返す。"""
    許す = str(材料.get("うたい文句") or "") + str(材料.get("期限") or "")
    許す = 許す.replace("％", "%").replace(" ", "")
    for m in re.finditer(r"\d+(?:\.\d+)?\s*(?:割|%|％|倍|円|時間|日|泊)", text):
        語 = m.group(0).replace("％", "%").replace(" ", "")
        if 語 in 許す:
            continue
        return m.group(0)
    return None


def 宿の決まり(選んだ: dict) -> list[str]:
    """宿の枠で守ってもらう決まり。

    2026-09-23、代表が見つけた「よく伸びている楽天トラベルの投稿」に合わせた。
      1本目 … 「【福井】◯◯な宿7選」＋ 宿名の一覧だけ。リンクを入れない
      返信  … 冒頭に「PR」。宿ごとに一文とリンク
    本文にリンクを入れると表示が落ちるので、リンクは返信に置く。
    一覧は保存されやすく、返信まで読んだ人がリンクを踏む、という流れ。

    AI に書いてもらうのは **1行目の見出しだけ**。
    宿の一覧・一文・リンクは、こちらがデータから組み立てる
    （宿の名前を書き間違えたり、無い宿を足したりしないため）。
    """
    return [
        "**この枠で書くのは、1行目の見出しだけです。** 他は何も書かないでください。",
        "",
        f"今日の切り口: {選んだ['name']}",
        "",
        "見出しの決まり",
        "",
        "1. **「【福井】」で始める。** そのあとに、どんな宿を集めたかを書く",
        "2. **最後に「◯選」と軒数を入れる。**",
        f"   今日は {選んだ['軒数']} 軒なので「{選んだ['軒数']}選」です",
        "3. **日本語で 30 字まで。** 1行だけ。改行しない",
        "4. **URL・【PR】・絵文字・ハッシュタグは書かない。** こちらで付けます",
        "5. **「ない」と書かない。** 楽天トラベルに載っていないのは",
        "   「設備が無い」ではなく「宿が登録していない」かもしれません",
        "6. **泊まった体で書かない。** この宿には泊まっていません",
        "",
        "例（そのまま使わず、今日の切り口に合わせて書いてください）",
        "  【福井】夜遅く着いても入れる宿7選",
        "  【福井】サウナがある宿7選",
        "  【福井】朝ごはんの場所が分かる宿7選",
        "",
        "thread は空のままにしてください。返信はこちらで付けます。",
    ]


def 宿の本文(まとめ: dict, 見出し: str) -> str:
    """1本目。見出し＋宿の一覧。リンクは入れない。

    宿の名前が長い日に上限を超えることがあるので、入らなければ下から減らす。
    見出しの「◯選」と数が食い違わないよう、数もここで直す。
    """
    宿たち = list(まとめ["宿"])
    while 宿たち:
        削り = {**まとめ, "宿": 宿たち}
        直した = 見出し.strip()
        for 数 in range(len(まとめ["宿"]), 0, -1):
            直した = 直した.replace(f"{数}選", f"{len(宿たち)}選")
        本 = 直した + "\n\n" + "\n".join(宿.一覧の行(削り))
        if リンクの長さ(本) <= リンクの上限 or len(宿たち) <= 3:
            return 本
        宿たち = 宿たち[:-1]
    return 見出し.strip()


def 宿の返信(まとめ: dict, 対象日) -> list[str]:
    """返信。冒頭に PR を置き、宿ごとの一文とリンクを並べる。

    楽天アフィリエイトの決まりでは、広告表記はファーストビューに置く。
    だから返信の1行目を「PR」にする。
    """
    行たち = 宿.返信の行(まとめ)
    頭 = "PR\n楽天トラベルのページはこちらです"
    出, いま, 先頭 = [], 頭, True
    for 行 in 行たち:
        つぎ = いま + "\n\n" + 行
        if リンクの長さ(つぎ) > リンクの上限:
            出.append(いま)
            いま = "PR\n\n" + 行
        else:
            いま = つぎ
        先頭 = False
    if いま:
        出.append(いま)

    # クーポン。代表が楽天アフィリエイトの管理画面で作ったリンクだけを使う。
    # 「5と0のつく日」のものは、その日だけ出す。
    クーポン = 宿.クーポンを読む()
    きょう旅 = お得日.旅(対象日)
    使う = [
        c for c in クーポン
        if str(c.get("いつ", "いつでも")) != "5と0のつく日" or きょう旅
    ]
    if 使う:
        塊 = ["PR", "楽天トラベルのクーポンはこちらです"]
        if きょう旅:
            塊.append("今日は5と0のつく日。エントリーは要りません")
        塊.append("")
        for c in 使う[:3]:
            塊.append(f"{c['名']}\n{c['url']}")
            塊.append("")
        出.append("\n".join(塊).strip())
    return 出


リンクの長さ = weighted_length  # X は URL を 23 字として数える
リンクの上限 = 270


# 倍率・割引率の数字。お得日の枠では書かせない（楽天のキャンペーンは変わる）。
# 商品名そのものに「P10倍」「20%OFF」が入っていることがあるので、
# 渡した商品名に含まれる分は見逃す。名前を書き写しただけで止めると、
# その日の投稿が全部できなくなってしまう。
倍率の数字 = re.compile(r"(?:ポイント|P)?\s*\d+(?:\.\d+)?\s*(?:倍|％|%|パーセント|割|割引|OFF|off|オフ)")


def あやしい倍率(text: str, deal: dict) -> str | None:
    """本文にある倍率のうち、渡した商品名に無いものを返す。"""
    名たち = " ".join(x["name"] for x in deal["商品"])
    for m in 倍率の数字.finditer(text):
        語 = m.group(0)
        if 語.replace(" ", "") in 名たち.replace(" ", ""):
            continue
        return 語
    return None


def お得日のリンク(deal: dict) -> list[str]:
    """お得日の枠のリンクを、連投にまとめる。本文には入れない。"""
    かたまり, いま = [], ""
    for x in deal["商品"]:
        行 = f"【PR】{x['name']}\n{x['url']}"
        つぎ = (いま + "\n\n" + 行) if いま else 行
        if いま and リンクの長さ(つぎ) > リンクの上限:
            かたまり.append(いま)
            いま = 行
        else:
            いま = つぎ
    if いま:
        かたまり.append(いま)
    return かたまり


def 宿のリンク(選んだ: dict) -> list[str]:
    """宿のリンクを、連投1本にまとめられるだけまとめる。

    本文にURLを入れると表示が落ちるので、リンクは連投（コメント欄）に置く。
    連投は少ないほうが読まれるので、入るだけ1本にまとめる。
    """
    かたまり, いま = [], ""
    for 行 in 選んだ.get("links") or []:
        つぎ = (いま + "\n\n" + 行) if いま else 行
        if いま and リンクの長さ(つぎ) > リンクの上限:
            かたまり.append(いま)
            いま = 行
        else:
            いま = つぎ
    if いま:
        かたまり.append(いま)
    return かたまり


class 枠を落とす(Exception):
    """この枠だけ作らない。他の枠は残す。

    2026-09-24 と 25 に、1本の見張り違反で fail() が走り、その日の10本が
    まるごと作られなかった。1本の取りこぼしと、1日の全滅は釣り合わない。
    """


def 落とす(わけ: str):
    raise 枠を落とす(わけ)


def new_id(hour: int, existing: set[str]) -> str:
    stamp = datetime.now(JST).strftime("%Y%m%d")
    while True:
        suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=4))
        candidate = f"p-{stamp}{hour:02d}-{suffix}"
        if candidate not in existing:
            return candidate


def main() -> None:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        fail("ANTHROPIC_API_KEY が未設定です。リポジトリの Secrets に登録してください。")

    dry_run = os.environ.get("DRY_RUN", "").lower() == "true"
    override = os.environ.get("TARGET_DATE", "").strip()
    if override:
        try:
            target_date = datetime.strptime(override, "%Y-%m-%d").date()
        except ValueError:
            fail(f"TARGET_DATE の形式が不正です: {override}（YYYY-MM-DD で指定してください）")
    else:
        target_date = (datetime.now(JST) + timedelta(days=1)).date()
    print(f"作成対象: {target_date}（日本時間）")

    lines = read_queue_lines()
    entries = parse_entries(lines)
    existing_ids = {str(e.get("id")) for e in entries if e.get("id")}

    # すでに埋まっている枠は触らず、空いている枠だけを作る
    filled = find_filled(entries, target_date)
    needed = [slot for slot in SLOTS if slot[0] not in filled]
    # お得日じゃない日は、お得日の枠を作らない。
    if not お得日.市場(target_date):
        needed = [slot for slot in needed if slot[0] != DEAL_HOUR]
    if filled:
        print("すでに予約済みの枠: " + "、".join(f"{h}:00" for h in sorted(filled)))
    if not needed:
        print(f"{target_date} は全ての枠が埋まっています。何もしません。")
        return
    # 当日ぶんを作り直すときに、すでに時刻を過ぎた枠を作らない
    # （過ぎた時刻で作ると、次の tick で即座に投稿されてしまうため）
    now_jst = datetime.now(JST)
    past = [
        slot[0]
        for slot in needed
        if datetime(target_date.year, target_date.month, target_date.day, slot[0], tzinfo=JST) <= now_jst
    ]
    if past:
        print("すでに時刻を過ぎているため作らない枠: " + "、".join(f"{h}:00" for h in past))
        needed = [slot for slot in needed if slot[0] not in past]
        if not needed:
            print("作れる枠がありません。何もしません。")
            return

    print("これから作る枠: " + "、".join(f"{h}:00" for h, *_ in needed))

    board = fetch_doc(os.environ.get("BOARD_DOC_ID", "").strip(), "運用ボード")
    neta = read_neta()

    # 紹介枠。毎日 1 本、PR_HOUR の枠だけ。
    # どの商品を出すかは scripts/商品.py が日付から決める。
    # X と yu は同じリスト・同じ計算なので、同じ日には同じ商品になる。
    一覧 = 商品.読む()
    product = None
    if 一覧 and any(hour == PR_HOUR for hour, *_ in needed):
        選んだ = 商品.今日の商品(target_date, 一覧)
        if 選んだ:
            product = 商品.投稿用にする(選んだ)
            並び = 商品.並び(一覧)
            print(
                f"紹介枠: {PR_HOUR}:00 ｜ {product['name']}"
                f"（{len(一覧)} 件中／並びの長さ {len(並び)}）"
            )
            成績 = 選んだ.get("成績") or {}
            if 成績:
                print(
                    f"  これまで {成績.get('本数')} 本・平均閲覧 {成績.get('平均閲覧')}"
                    f"・平均反応 {成績.get('平均反応')}"
                )
            if 選んだ.get("セール"):
                print("  セール中のため、並びに多く入っています。")
    elif 一覧:
        print(f"紹介枠: {PR_HOUR}:00 はすでに埋まっているため、今回は紹介しません。")
    else:
        print("::warning::商品リストが空です。紹介枠は通常の投稿になります。")

    # お得日の枠（2026-09-23 代表指示）。お得日に当たった日だけ出る。
    # 型は「誰向け ＋ どんなお得 ＋ 期限」。代表共有のnote記事より。
    # 数字（倍率・割引率）は書かせない。楽天のキャンペーンは予告なく変わるため。
    deal = None
    きょうの得 = お得日.市場(target_date)
    if きょうの得 and 一覧 and any(hour == DEAL_HOUR for hour, *_ in needed):
        のぞく = (product or {}).get("url")
        品 = [商品.投稿用にする(x) for x in 商品.お得日の品(target_date, 一覧, のぞく=のぞく)]
        if 品:
            deal = {"お得日": きょうの得, "商品": 品}
            print(f"お得日の枠: {DEAL_HOUR}:00 ｜ {きょうの得['名']} ｜ {len(品)} 件")
    elif きょうの得:
        print(f"お得日の枠: 今日は{きょうの得['名']}ですが、枠が埋まっているか商品がありません。")

    # 宿のまとめ枠（2026-09-23 代表指示）。毎日 1 本、HOTEL_HOUR の枠だけ。
    # どの切り口で何軒並べるかは scripts/宿.py が日付から決める。
    # 3アカウントとも同じリスト・同じ計算なので、同じ日には同じ宿が並ぶ。
    宿たち = 宿.読む()
    hotel = None
    if 宿たち and any(hour == HOTEL_HOUR for hour, *_ in needed):
        まとめ = 宿.今日のまとめ(target_date, 宿たち, いくつ=宿の軒数)
        if まとめ:
            hotel = {
                "name": まとめ["切り口"]["問い"],
                "軒数": len(まとめ["宿"]),
                "一覧": 宿.一覧の行(まとめ),
                "raw": まとめ,
            }
            print(
                f"宿の枠: {HOTEL_HOUR}:00 ｜ {hotel['name']}"
                f"（{hotel['軒数']} 軒／リスト {len(宿たち)} 軒）"
            )
        else:
            print("::warning::今日は 5 軒そろう切り口がありません。宿の紹介はしません。")
    elif 宿たち:
        print(f"宿の枠: {HOTEL_HOUR}:00 はすでに埋まっているため、今回は紹介しません。")
    else:
        print("::warning::宿のリストが空です。宿の紹介はしません。")

    # むぎ型（クーポン1本だけの短文）。5と0のつく日に出す。
    mugi = None
    if hotel and 宿の型(target_date) == "むぎ":
        旅の得 = お得日.旅(target_date)
        使える = [c for c in 宿.クーポンを読む()
                  if str(c.get("いつ", "いつでも")) != "5と0のつく日" or 旅の得]
        if 使える:
            mugi = {
                "お得日": 旅の得,
                "クーポン": 使える,
                "うたい文句": next((c.get("うたい文句") for c in 使える if c.get("うたい文句")), ""),
                "期限": next((c.get("期限") for c in 使える if c.get("期限")), None),
            }
            hotel = None   # この日は宿の一覧を出さない
            print(f"  → 今日は5と0のつく日なので、むぎ型（クーポン {len(使える)} 本）に差し替えます")
        else:
            print("::warning::5と0のつく日ですが、使えるクーポンがありません。9選型で出します。")

    model = pick_model(api_key)
    prompt = build_prompt(
        board,
        neta,
        recent_texts(entries),
        target_date,
        needed,
        filled,
        product=product,
        pr_hour=PR_HOUR if product else None,
        hotel=hotel,
        hotel_hour=HOTEL_HOUR if (hotel or mugi) else None,
        mugi=mugi,
        deal=deal,
        deal_hour=DEAL_HOUR if deal else None,
    )
    posts = generate(api_key, model, prompt, len(needed))

    by_hour = {int(p["hour"]): p for p in posts}
    new_lines = []
    # その日すでにキューに入っている投稿の出典も数に入れる。
    # YU さんの指示で入れたものは例外なので、note に「指示」と書いてあれば数えない。
    出典の枠: dict[str, int] = {}
    for h, e in filled.items():
        if "指示" in str(e.get("note", "")):
            continue
        for u in source_urls(e.get("text", ""), e.get("thread") or []):
            出典の枠[u] = h

    for hour, *_ in needed:
        try:
            post = by_hour.get(hour)
            if not post:
                落とす(f"{hour}:00 の投稿が返ってきませんでした。")
            text = (post.get("text") or "").strip()
            if not text:
                落とす(f"{hour}:00 の本文が空です。")
            thread = [t.strip() for t in (post.get("thread") or []) if t and t.strip()]

            if not product and not hotel and not deal and text.startswith(PR_MARKERS):
                # 紹介枠が立っていないのに PR 投稿が作られた。
                # リンクが付かないので成果にならず、表示だけが残る。
                落とす(
                    f"{hour}:00 が【PR】で始まっていますが、紹介できる商品がありません"
                    f"（先頭 30 字: {text[:30]!r}）。"
                    "ネタ帳の「紹介する商品」に、まだ紹介していない商品を足してください。"
                )

            if product and hour == PR_HOUR:
                # 本文に URL が紛れ込んでいたら止める。AI に URL を書かせない方針のため。
                if URL_IN_TEXT.search(text):
                    落とす(f"{hour}:00 の本文に URL が入っています。この枠では本文にリンクを書きません。")
                if not text.startswith(PR_MARKERS):
                    落とす(
                        f"{hour}:00 の本文が【PR】で始まっていません（先頭 20 字: {text[:20]!r}）。"
                        "ステマ規制のため、冒頭の表記は必須です。"
                    )
                # 楽天の検索で入れた商品に「使っている」と書かせない。
                if is_unused(product):
                    found = USED_VOICE.search(text)
                    if found:
                        落とす(
                            f"{hour}:00 の本文に「{found.group(0)}」が入っています。"
                            f"この商品（{product['name']}）は本人がまだ使っていません。"
                            "使った体で書くと嘘になるので、未使用だと分かる書き方にしてください。"
                        )
                # リンクはネタ帳に書かれた文字列をそのまま使う。AI を通さない。
                thread = [f"【PR】{product['name']}\n{product['url']}"]

            for part in [text, *thread]:
                length = weighted_length(part)
                if length > 280:
                    落とす(
                        f"{hour}:00 に X の上限を超える要素があります"
                        f"（{length} / 280。日本語なら 140 字まで）。"
                    )
            if deal and hour == DEAL_HOUR:
                if URL_IN_TEXT.search(text):
                    落とす(f"{hour}:00 の本文に URL が入っています。この枠では本文にリンクを書きません。")
                if not text.startswith(PR_MARKERS):
                    落とす(
                        f"{hour}:00 の本文が【PR】で始まっていません（先頭 20 字: {text[:20]!r}）。"
                        "ステマ規制のため、冒頭の表記は必須です。"
                    )
                if "エントリー" not in text:
                    落とす(
                        f"{hour}:00 の本文に「エントリー」が入っていません。"
                        "エントリーを忘れると1円も得しないので、必ず書いてください。"
                    )
                数 = あやしい倍率(text, deal)
                if 数:
                    落とす(
                        f"{hour}:00 の本文に「{数}」が入っています。"
                        "楽天のキャンペーンは予告なく変わるので、倍率・割引率の数字は書きません。"
                    )
                if not deal["お得日"].get("誰でも", True) and "ゴールド" not in text:
                    落とす(
                        f"{hour}:00 はゴールド会員以上だけが対象の日ですが、本文に書かれていません。"
                        "誰でも得をすると読めてしまうので、必ず書いてください。"
                    )
                thread = お得日のリンク(deal)

            if mugi and hour == HOTEL_HOUR:
                if URL_IN_TEXT.search(text):
                    落とす(f"{hour}:00 の本文に URL が入っています。この枠では本文にリンクを書きません。")
                if not text.startswith(PR_MARKERS):
                    落とす(
                        f"{hour}:00 の本文が【PR】で始まっていません（先頭 20 字: {text[:20]!r}）。"
                        "ステマ規制のため、冒頭の表記は必須です。"
                    )
                if len(text) > 120:
                    落とす(f"{hour}:00 の本文が長すぎます（{len(text)} 字）。この枠は 40〜90 字です。")
                泊 = STAYED_VOICE.search(text)
                if 泊:
                    落とす(f"{hour}:00 の本文に「{泊.group(0)}」が入っています。泊まった体で書かないこと。")
                数 = むぎの数字(text, mugi)
                if 数:
                    落とす(
                        f"{hour}:00 の本文に「{数}」が入っています。"
                        "楽天のキャンペーンは予告なく変わるので、渡した数字以外は書きません。"
                        "（neta/宿_クーポン.jsonl の「うたい文句」に書いた数字だけ使えます）"
                    )
                thread = むぎの返信(mugi)

            if not hotel and not mugi and hour == HOTEL_HOUR and text.startswith(PR_MARKERS):
                # 宿の枠が立っていないのに PR 投稿が作られた。
                # リンクが付かないので成果にならず、表示だけが残る。
                落とす(
                    f"{hour}:00 が【PR】で始まっていますが、今日は紹介できる宿がありません"
                    f"（先頭 30 字: {text[:30]!r}）。"
                )

            if hotel and hour == HOTEL_HOUR:
                # AI に書かせるのは見出し1行だけ。宿の一覧・リンクはこちらで組み立てる。
                見出し = text.splitlines()[0].strip() if text else ""
                if not 見出し:
                    落とす(f"{hour}:00 の見出しが空です。")
                if URL_IN_TEXT.search(見出し):
                    落とす(f"{hour}:00 の見出しに URL が入っています。")
                if 見出し.startswith(PR_MARKERS):
                    落とす(
                        f"{hour}:00 の見出しが【PR】で始まっています。"
                        "1本目にはリンクを入れないので、PR は返信の先頭に付けます。"
                    )
                if "福井" not in 見出し:
                    落とす(f"{hour}:00 の見出しに「福井」が入っていません（{見出し!r}）。")
                if len(見出し) > 34:
                    落とす(f"{hour}:00 の見出しが長すぎます（{len(見出し)} 字）: {見出し!r}")
                泊 = STAYED_VOICE.search(見出し)
                if 泊:
                    落とす(
                        f"{hour}:00 の見出しに「{泊.group(0)}」が入っています。"
                        "この宿には泊まっていません。"
                    )
                text = 宿の本文(hotel["raw"], 見出し)
                thread = 宿の返信(hotel["raw"], target_date)

            # 同じ催しを 1 日に 2 本出していないかを、ここで機械的に確かめる。
            # 指示だけだと読み飛ばされる。
            重なり = source_urls(text, thread) & set(出典の枠)
            if 重なり:
                どこ = "、".join(f"{h}:00" for h in sorted(出典の枠[u] for u in 重なり))
                落とす(
                    f"{hour}:00 が {どこ} と同じ出来事です"
                    f"（出典 {sorted(重なり)[0]}）。"
                    "同じ出来事は 1 日 1 本までです。別のネタを選んでください。"
                )
            for u in source_urls(text, thread):
                出典の枠[u] = hour

            item = {
                "id": new_id(hour, existing_ids),
                "text": text,
                "scheduled_at": f"{target_date.isoformat()}T{hour:02d}:00:00+09:00",
            }
            existing_ids.add(item["id"])
            if thread:
                item["thread"] = thread
            if post.get("note"):
                item["note"] = str(post["note"])[:120]
            new_lines.append(json.dumps(item, ensure_ascii=False))
            print(f"\n=== {hour}:00 ({len(text)} 字) ===\n{text}")
            for index, part in enumerate(thread, start=2):
                print(f"--- 連投 {index} ({len(part)} 字) ---\n{part}")
            if post.get("note"):
                print(f"[メモ] {post['note']}")
        except 枠を落とす as わけ:
            print(f"::warning::{hour}:00 は作れませんでした（{わけ}）。この枠は空のままにします。")
            continue

    if dry_run:
        print("\nDRY_RUN のため、キューには書き込みません。")
        return

    with QUEUE_PATH.open("a", encoding="utf-8") as handle:
        for line in new_lines:
            handle.write(line + "\n")
    print(f"\nキューに {len(new_lines)} 件追加しました。")


if __name__ == "__main__":
    main()
