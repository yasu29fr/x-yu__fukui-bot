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

### GitHub 上で確かめる場合

手元に鍵を置かずに確認できます。Actions の **「X 認証の確認」** を
`Run workflow` から実行してください（外部からは `x-auth-check` で起動）。

投稿はせず `GET /2/users/me` を叩くだけです。返ってきたアカウント名が
`EXPECTED_USERNAME`（既定 `yu__fukui`）と違えば**失敗**します。
別アカウントでログインしたままトークンを発行してしまう事故を、ここで止めます。

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

## 6. 商品紹介（Amazonアソシエイト）の扱い

**紹介は 1 日 1 本まで。12:00 の枠だけです**（`scripts/compose.py` の `PR_HOUR`）。
朝と夜は入れません。宣伝ばかりのアカウントに見せないためです。

### リンクは AI に書かせません

紹介する商品は、**ネタ帳の「## 紹介する商品」**に 1 行 1 件で書きます。

```
- 商品名 | https://amzn.to/xxxx | 一言メモ（実際に使ってどうだったか）
```

`compose.py` は商品名とメモだけを AI に渡し、**URL はここで読んだ文字列を
そのまま投稿に入れます**。AI に URL を書かせると、1 文字変わっただけで
別の場所へ飛ぶためです。本文に URL が紛れ込んでいたら、その場で止まります。

まだ紹介していない商品が上から順に選ばれます。全部紹介済みなら、
その日は通常の投稿になります。

### PR 表記は仕組みで強制しています

- `compose.py`：本文が **【PR】で始まっていなければ失敗**します
- `queue.py`：Amazon のリンクを含む投稿は、**本文の冒頭が PR 表記でなければ
  `validate` で弾きます**。手で書き足した投稿にも同じ検査がかかります

末尾やハッシュタグの列に埋めるのは、ステマ規制（景品表示法）上ふさわしくない
とされています。**冒頭に置いてください。**

### 自分でやること

- **プロフィール欄に「Amazonアソシエイト・プログラムの参加者です」と明記する**
  （Amazon の規約。怠るとアカウント停止の対象）
- **登録メディアに、このアカウントが入っていることを確認する**
  （登録していないメディアへのリンク掲載は規約違反）
- **実際に使っているものだけを書く**

美容・健康系は薬機法の確認が要るため、**AI が書いたものをそのまま公開しない**
運用に切り替えてください。

## 7. 予約画面とネタ帳の記録先

予約画面は GitHub Pages で公開する（Settings → Pages → main / `/docs`）。

ネタ帳への書き込みは Google Apps Script を中継する。**Threads 用と同じ 1 つの
プロジェクトで、両方のネタ帳をまかなう。** `scripts/notes.gs` の `TARGETS` に
宛先を並べ、画面は `target` を送って切り替える（この画面は `"x"` を送る）。

プロジェクトを分けないのは、新しく作ると OAuth の承認をやり直すことになり、
**「The OAuth client is not fully created yet」（401 invalid_client）** で
止まることがあるため。承認済みのものを使い回すほうが確実。

## 8. ファイル構成

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
scripts/notes.gs         ネタ帳への中継（Apps Script。Threads と共用）
docs/                    予約画面（GitHub Pages）
tests/                   ユニットテスト 15 件（ネットワークを使わない）
```

## 9. テスト

```bash
PYTHONPATH=src python3 -m unittest discover -s tests
```

署名の実装は、**X 開発者ドキュメントの検証用サンプルと一致すること**を
テストで確認しています。ここがずれると全部 401 になるので、
`client.py` を触ったら必ず流してください。
