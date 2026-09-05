"""キューの項目を実際に X へ投稿する処理。"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .client import XError, post, weighted_length
from .config import Config
from .queue import QueueItem

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PostResult:
    post_id: str
    permalink: str | None = None


def publish_item(
    item: QueueItem, config: Config, *, dry_run: bool = False
) -> PostResult | None:
    """本文を投稿し、連投があれば返信としてぶら下げる。"""
    if item.image_url or item.video_url:
        raise XError(
            f"[{item.id}] 画像・動画には未対応です。テキストだけにしてください。"
        )

    if dry_run:
        logger.info(
            "[dry-run] 投稿しません id=%s text=%r（%d/280） thread=%d件",
            item.id,
            item.text,
            weighted_length(item.text),
            len(item.thread),
        )
        return None

    first = post(item.text, config.credentials)
    post_id = first["data"]["id"]
    logger.info("投稿しました id=%s post_id=%s", item.id, post_id)

    reply_to = post_id
    for index, text in enumerate(item.thread, start=2):
        import time

        time.sleep(config.reply_delay)
        reply = post(text, config.credentials, reply_to=reply_to)
        reply_to = reply["data"]["id"]
        logger.info("連投 %d 件目を投稿しました post_id=%s", index, reply_to)

    return PostResult(post_id=post_id, permalink=f"https://x.com/i/status/{post_id}")
