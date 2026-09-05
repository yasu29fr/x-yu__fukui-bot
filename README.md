# x-bot — X（旧 Twitter）自動投稿の仕組み

`@yu__fukui` 用。Threads の仕組み（`yasu29fr/yasu29fr`）と同じ考え方で、投稿部分だけ X 用に書き直したもの。

```
毎晩 22:00  外部 cron → 翌日ぶんの 3 本を作ってキューに追加
翌日 7:00 / 12:00 / 21:00  外部 cron → 予約時刻が来たものを投稿
```

---

## 1. Threads 版との違い

| | Threads | X |
| --- | --- | --- |
| 文字数 | 500 字 | **280（日本語は 1 文字 2 なので実質 140 字）** |
| 連投 | コンテナを作って返信 | **投稿への返信としてぶら下げる** |
| 認証 | 長期アクセストークン 1 つ | **OAuth 1.0a（4 つの値）** |
| トークンの期限 | 60 日で失効・要更新 | **失効しない**（再発行しない限り） |
| 画像・動画 | 対応 | **未対応**（テキストのみ） |

**いちばん効くのは文字数です。** 日本語 140 字は Threads の 4 分の 1 以下なので、
1 投稿に 1 つのことしか書けません。長い話は連投に分けます。

## 2. 必要な値

X 開発者ポータルで発行される 4 つを、GitHub の **Secrets** に入れます。

| Secret | 中身 |
| --- | --- |
| `X_API_KEY` | API Key（Consumer Key） |
| `X_API_SECRET` | API Key Secret |
| `X_ACCESS_TOKEN` | Access Token |
| `X_ACCESS_TOKEN_SECRET` | Access Token Secret |

> **アプリの権限を Read and write にしておくこと。** 既定は Read only で、
> そのままだと投稿時に 403 になります。権限を変えたら **Access Token を発行し直す**
> 必要があります（古いトークンには古い権限が焼き付いています）。

翌日ぶんの自動作成を使う場合は、さらに次を登録します。

| 種別 | 名前 | 中身 |
| --- | --- | --- |
| Secrets | `ANTHROPIC_API_KEY` | Anthropic の API キー |
| Variables | `BOARD_DOC_ID` | 運用ボードの Google ドキュメント ID |
| Variables | `NETA_DOC_ID` | ネタ帳の Google ドキュメント ID |

ドキュメントは 2 つとも「リンクを知っている全員が閲覧可」にしてください。

## 3. 動作確認の順番

```bash
export PYTHONPATH=src

# 1. キューの形式（認証は不要）
python -m x_bot validate

# 2. 認証だけ確認する。投稿はしない
python -m x_bot me

# 3. 投稿せずに中身だけ見る
python -m x_bot post --dry-run

# 4. 実際に投稿する
python -m x_bot post --limit 1
```

`me` が通れば 4 つの値は正しく組み合わさっています。**ここで止まるなら、
投稿を試す前に権限とトークンを見直してください。**

## 4. 起動の設定（cron-job.org）

Threads 版と同じ形で、ジョブを 2 つ登録します。

```
URL    : https://api.github.com/repos/yasu29fr/x-yu__fukui-bot/dispatches
Method : POST
Headers: Accept: application/vnd.github+json
         Authorization: Bearer <Contents: Read and write のトークン>
         X-GitHub-Api-Version: 2022-11-28
         Content-Type: application/json
```

| ジョブ | 間隔 | Body |
| --- | --- | --- |
| 予約投稿の確認 | 5〜15 分おき | `{"event_type": "x-tick"}` |
| 翌日ぶんの作成 | 1 日 1 回（例 22:00） | `{"event_type": "x-compose"}` |

> **`event_type` の綴りに注意。** 知らない値でも GitHub は 204 を返すので、
> 間違えると「成功しているのに何も起きない」状態になります。

## 5. キューの書き方

`posts/queue.jsonl` に 1 行 1 投稿の JSON で書きます。

```json
{"id": "p-20260910-a1", "text": "本文", "scheduled_at": "2026-09-10T07:00:00+09:00", "thread": ["続き"]}
```

- `scheduled_at` が**ない項目は永久に投稿されません**（`validate` が警告します）
- `id` は重複させないこと
- 予約時刻が来たものだけが出るので、起動を増やしても投稿は増えません

## 6. いまの方針

**当面は商品の紹介・宣伝を一切しません。**

`scripts/compose.py` に、アフィリエイトのリンクや購入をすすめる書き方を
しないよう明記してあります。まず読まれるアカウントにするのが先で、
初期に宣伝を混ぜると伸びが鈍るためです。

紹介を始めるときは、次の 2 つを必ず守ります。

- **`#PR` を付ける**（ステマ規制。景品表示法の対象）
- **実際に使っているものだけを書く**

美容・健康系を扱う場合は、薬機法の確認が要るため
**AI が書いたものをそのまま公開しない**運用に切り替えます。

## 7. ファイル構成

```
posts/queue.jsonl        投稿キュー（ここに書けば予約される）
state/posted.json        投稿済みの記録。二重投稿を防ぐ唯一の判断材料
src/x_bot/
  client.py              X API（OAuth 1.0a 署名・投稿・文字数）
  queue.py               キューの読み込みと、次に投稿すべき項目の選択
  poster.py              本文 → 連投の順に投げる
  state.py               投稿済み記録
  config.py              環境変数
  cli.py                 post / validate / me
scripts/compose.py       翌日ぶんの 3 本を作る
tests/                   ユニットテスト 15 件（ネットワークを使わない）
```

## 8. テスト

```bash
PYTHONPATH=src python3 -m unittest discover -s tests
```

署名の実装は、**X 開発者ドキュメントの検証用サンプルと一致すること**を
テストで確認しています。ここがずれると全部 401 になるので、
`client.py` を触ったら必ず流してください。
