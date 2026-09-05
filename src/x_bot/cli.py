"""x-bot コマンドラインインターフェース。"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

from .client import API_BASE, XError, _auth_header, weighted_length
from .config import Config, ConfigError
from .poster import publish_item
from .queue import QueueError, QueueItem, load_queue, select_due, without_schedule
from .state import State

logger = logging.getLogger("x_bot")


def cmd_post(args: argparse.Namespace, config: Config) -> int:
    items = load_queue(config.queue_path, timezone=config.timezone)
    state = State.load(config.state_path)
    now = datetime.now(ZoneInfo(config.timezone))
    due = select_due(items, state.posted_ids, now=now, limit=args.limit)

    if not due:
        remaining = len([i for i in items if i.id not in state.posted_ids])
        logger.info("予約時刻が来た項目はありません（未投稿の残り %d 件）", remaining)
        return 0

    failures = 0
    for item in due:
        try:
            result = publish_item(item, config, dry_run=args.dry_run)
        except XError as exc:
            failures += 1
            logger.error("投稿に失敗しました id=%s: %s", item.id, exc)
            continue
        if result is not None:
            state.record(item.id, post_id=result.post_id, permalink=result.permalink)
            state.save()
            logger.info("URL: %s", result.permalink)

    return 1 if failures else 0


def cmd_validate(args: argparse.Namespace, config: Config) -> int:
    items = load_queue(config.queue_path, timezone=config.timezone)
    state = State.load(config.state_path)
    pending = [i for i in items if i.id not in state.posted_ids]

    stranded = without_schedule(items, state.posted_ids)
    if stranded:
        for item in stranded:
            logger.error(
                "%d 行目 [%s]: scheduled_at がありません。このままでは投稿されません。",
                item.line_number,
                item.id,
            )
        return 1

    logger.info(
        "キュー %s: 全 %d 件 / 未投稿 %d 件 — 形式に問題はありません",
        config.queue_path,
        len(items),
        len(pending),
    )
    for item in pending[: args.limit]:
        logger.info("  次: %s", _describe(item))
    return 0


def _describe(item: QueueItem) -> str:
    when = item.scheduled_at.isoformat() if item.scheduled_at else "日時なし"
    head = item.text.replace("\n", " ")[:34]
    return f"[{item.id}] {when} {weighted_length(item.text)}/280 {head!r}"


# 取りに行く項目。X 側が知らない項目名を混ぜると 400 になるので、
# 通らなかったときは順に減らして試す。
ME_FIELDS = (
    "verified_type,subscription_type,public_metrics",
    "verified_type,public_metrics",
    "public_metrics",
    "",
)


def _fetch_me(config: Config, fields: str) -> dict:
    base = f"{API_BASE}/users/me"
    params = {"user.fields": fields} if fields else {}
    url = base + ("?" + urllib.parse.urlencode(params) if params else "")
    request = urllib.request.Request(url, method="GET")
    request.add_header(
        "Authorization", _auth_header("GET", base, config.credentials, params=params)
    )
    try:
        with urllib.request.urlopen(request, timeout=config.timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        raise XError(f"X API エラー ({exc.code}): {detail}") from exc


def cmd_me(_args: argparse.Namespace, config: Config) -> int:
    """トークンの持ち主を確認する。投稿せずに認証だけ試せる。

    ついでにフォロワー数と Premium 加入の有無も取る。
    Premium かどうかで 1 投稿に書ける長さが変わるため。
    """
    last_error: XError | None = None
    for fields in ME_FIELDS:
        try:
            data = _fetch_me(config, fields)
            break
        except XError as exc:
            last_error = exc
            if "(400)" not in str(exc):
                raise
    else:  # すべて 400 だった
        raise last_error  # type: ignore[misc]

    print(json.dumps(data, ensure_ascii=False, indent=2))
    user = data.get("data", {})
    metrics = user.get("public_metrics") or {}
    logger.info(
        "認証できました: @%s（%s） フォロワー=%s verified_type=%s subscription_type=%s",
        user.get("username"),
        user.get("name"),
        metrics.get("followers_count", "不明"),
        user.get("verified_type", "不明"),
        user.get("subscription_type", "不明"),
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="x-bot", description="X への自動投稿ボット")
    parser.add_argument("-v", "--verbose", action="store_true", help="デバッグログを出す")
    sub = parser.add_subparsers(dest="command", required=True)

    post = sub.add_parser("post", help="キューから投稿する")
    post.add_argument("--limit", type=int, default=1, help="1 回の実行で投稿する件数（既定 1）")
    post.add_argument("--dry-run", action="store_true", help="API を呼ばずに内容だけ表示する")
    post.set_defaults(func=cmd_post)

    validate = sub.add_parser("validate", help="キューの形式を検証する")
    validate.add_argument("--limit", type=int, default=5, help="表示する未投稿件数")
    validate.set_defaults(func=cmd_validate, needs_credentials=False)

    me = sub.add_parser("me", help="トークンの持ち主を確認する（投稿しない）")
    me.set_defaults(func=cmd_me)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        needs_credentials = getattr(args, "needs_credentials", True) and not getattr(
            args, "dry_run", False
        )
        config = Config.from_env(require_credentials=needs_credentials)
        return args.func(args, config)
    except (ConfigError, QueueError, XError) as exc:
        logger.error("%s", exc)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
