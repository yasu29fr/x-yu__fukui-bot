"""X（旧 Twitter）へ投稿するための最小クライアント。

標準ライブラリだけで動く。threads_bot と同じ方針。

X API v2 の POST /2/tweets は OAuth 1.0a のユーザー認証を使う。
開発者ポータルで発行される 4 つの値が必要:

  X_API_KEY              API Key（Consumer Key）
  X_API_SECRET           API Key Secret（Consumer Secret）
  X_ACCESS_TOKEN         Access Token
  X_ACCESS_TOKEN_SECRET  Access Token Secret

Access Token は「投稿するアカウント」のもの。開発者アカウントとは別でもよい。
アプリの権限は Read and write にしておくこと（Read only だと 403 になる）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://api.x.com/2"
MAX_TEXT_LENGTH = 280  # 日本語は 1 文字 = 2 カウントで 140 文字相当

# X は URL を t.co で包み直すため、実際の長さに関係なく一律 23 として数える。
# 短縮 URL でも長い Amazon の URL でも同じ 23。ここを文字数で数えると、
# 長い URL のときに投稿できるものを弾いてしまう。
URL_PATTERN = re.compile(r"https?://\S+")
URL_WEIGHT = 23


class XError(Exception):
    """X API からエラーが返った。"""


def _quote(value: str) -> str:
    """OAuth 1.0a のパーセントエンコード（RFC 5849 3.6）。"""
    return urllib.parse.quote(str(value), safe="~")


def _signature(
    method: str,
    url: str,
    params: dict[str, str],
    consumer_secret: str,
    token_secret: str,
) -> str:
    """署名ベース文字列を組み立てて HMAC-SHA1 で署名する。"""
    normalized = "&".join(
        f"{_quote(k)}={_quote(params[k])}" for k in sorted(params)
    )
    base = "&".join([method.upper(), _quote(url), _quote(normalized)])
    key = f"{_quote(consumer_secret)}&{_quote(token_secret)}"
    digest = hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def _auth_header(
    method: str,
    url: str,
    credentials: dict[str, str],
    *,
    params: dict[str, str] | None = None,
    nonce: str | None = None,
    timestamp: str | None = None,
) -> str:
    """Authorization ヘッダを作る。

    POST /2/tweets は本文が JSON なので、署名の対象はクエリと OAuth パラメータだけ
    （本文はフォームエンコードでないため署名に含めない）。

    url にはクエリを付けないこと。クエリがある場合は params に渡す。
    OAuth 1.0a はクエリも署名対象なので、渡し忘れると 401 になる。
    """
    oauth = {
        "oauth_consumer_key": credentials["api_key"],
        "oauth_nonce": nonce or secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": timestamp or str(int(time.time())),
        "oauth_token": credentials["access_token"],
        "oauth_version": "1.0",
    }
    to_sign = dict(oauth)
    if params:
        to_sign.update(params)
    oauth["oauth_signature"] = _signature(
        method,
        url,
        to_sign,
        credentials["api_secret"],
        credentials["access_token_secret"],
    )
    parts = ", ".join(f'{_quote(k)}="{_quote(v)}"' for k, v in sorted(oauth.items()))
    return "OAuth " + parts


def load_credentials(env: dict[str, str] | None = None) -> dict[str, str]:
    """環境変数から 4 つの値を読む。欠けていれば何が足りないかを言って止める。"""
    source = env if env is not None else os.environ
    names = {
        "api_key": "X_API_KEY",
        "api_secret": "X_API_SECRET",
        "access_token": "X_ACCESS_TOKEN",
        "access_token_secret": "X_ACCESS_TOKEN_SECRET",
    }
    credentials, missing = {}, []
    for key, name in names.items():
        value = (source.get(name) or "").strip()
        if not value:
            missing.append(name)
        credentials[key] = value
    if missing:
        raise XError("次の環境変数が未設定です: " + ", ".join(missing))
    return credentials


def _weigh_plain(text: str) -> int:
    """URL を含まない文字列の重み。ラテン文字などは 1、日本語などは 2。"""
    total = 0
    for ch in text:
        code = ord(ch)
        if (
            0x0000 <= code <= 0x10FF
            or 0x2000 <= code <= 0x200D
            or 0x2010 <= code <= 0x201F
            or 0x2032 <= code <= 0x2037
        ):
            total += 1
        else:
            total += 2
    return total


def weighted_length(text: str) -> int:
    """X の文字数の数え方に合わせる。

    ラテン文字などは 1、日本語を含む多くの文字は 2。
    URL だけは別扱いで、長さに関係なく一律 23 として数える（X が t.co で包むため）。
    正確な仕様は Unicode の範囲で決まるが、ここは実運用で困らない近似にしてある。
    """
    total = 0
    cursor = 0
    for match in URL_PATTERN.finditer(text):
        total += _weigh_plain(text[cursor : match.start()])
        total += URL_WEIGHT
        cursor = match.end()
    total += _weigh_plain(text[cursor:])
    return total


def post(
    text: str,
    credentials: dict[str, str],
    *,
    reply_to: str | None = None,
    dry_run: bool = False,
) -> dict:
    """1 件投稿する。reply_to を渡すと、その投稿への返信になる（＝連投）。"""
    if not text.strip():
        raise XError("本文が空です。")
    length = weighted_length(text)
    if length > MAX_TEXT_LENGTH:
        raise XError(f"本文が上限を超えています（{length} / {MAX_TEXT_LENGTH}）。")

    payload: dict = {"text": text}
    if reply_to:
        payload["reply"] = {"in_reply_to_tweet_id": reply_to}

    if dry_run:
        return {"dry_run": True, "weighted_length": length, "payload": payload}

    url = f"{API_BASE}/tweets"
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Authorization", _auth_header("POST", url, credentials))
    request.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise XError(f"X API エラー ({exc.code}): {detail}") from exc
    except Exception as exc:  # noqa: BLE001
        raise XError(f"X API に接続できませんでした: {exc}") from exc


def post_thread(
    text: str,
    thread: list[str],
    credentials: dict[str, str],
    *,
    delay: float = 3.0,
    dry_run: bool = False,
) -> list[dict]:
    """本文を投稿し、続きを順に返信としてぶら下げる。"""
    results = [post(text, credentials, dry_run=dry_run)]
    parent = None if dry_run else results[0]["data"]["id"]
    for part in thread:
        if not dry_run:
            time.sleep(delay)
        results.append(post(part, credentials, reply_to=parent, dry_run=dry_run))
        if not dry_run:
            parent = results[-1]["data"]["id"]
    return results
