"""環境変数から読み込む実行時設定。"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_TIMEZONE = "Asia/Tokyo"

# X の認証は 4 つの値をそろえて 1 組。1 つでも欠けると署名が通らない。
CREDENTIAL_ENV = {
    "api_key": "X_API_KEY",
    "api_secret": "X_API_SECRET",
    "access_token": "X_ACCESS_TOKEN",
    "access_token_secret": "X_ACCESS_TOKEN_SECRET",
}


class ConfigError(Exception):
    """必須の設定が欠けている、または値が不正。"""


@dataclass(frozen=True)
class Config:
    credentials: dict[str, str]
    timezone: str = DEFAULT_TIMEZONE
    queue_path: str = "posts/queue.jsonl"
    state_path: str = "state/posted.json"
    timeout: float = 60.0
    # 連投を続けて投げると弾かれることがあるため、間隔をあける
    reply_delay: float = 3.0

    @classmethod
    def from_env(
        cls, env: dict[str, str] | None = None, *, require_credentials: bool = True
    ) -> "Config":
        env = dict(os.environ if env is None else env)
        credentials = {k: (env.get(name) or "").strip() for k, name in CREDENTIAL_ENV.items()}
        missing = [CREDENTIAL_ENV[k] for k, v in credentials.items() if not v]
        if missing and require_credentials:
            raise ConfigError("必須の環境変数が設定されていません: " + ", ".join(missing))
        return cls(
            credentials=credentials,
            timezone=env.get("X_TIMEZONE", DEFAULT_TIMEZONE),
            queue_path=env.get("X_QUEUE_PATH", "posts/queue.jsonl"),
            state_path=env.get("X_STATE_PATH", "state/posted.json"),
            timeout=float(env.get("X_TIMEOUT", "60")),
            reply_delay=float(env.get("X_REPLY_DELAY", "3")),
        )
