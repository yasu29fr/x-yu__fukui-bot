"""x-bot のユニットテスト。ネットワークは一切使わない。"""

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from x_bot import client, queue
from x_bot.config import Config, ConfigError

JST = ZoneInfo("Asia/Tokyo")


class SignatureTest(unittest.TestCase):
    """X 開発者ドキュメントの検証用サンプルと一致するか。"""

    def test_matches_official_example(self):
        params = {
            "status": "Hello Ladies + Gentlemen, a signed OAuth request!",
            "include_entities": "true",
            "oauth_consumer_key": "xvz1evFS4wEEPTGEFPHBog",
            "oauth_nonce": "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
            "oauth_signature_method": "HMAC-SHA1",
            "oauth_timestamp": "1318622958",
            "oauth_token": "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
            "oauth_version": "1.0",
        }
        signature = client._signature(
            "POST",
            "https://api.twitter.com/1.1/statuses/update.json",
            params,
            "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
            "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
        )
        self.assertEqual(signature, "hCtSmYh+iHYCEqBWrE7C7hYmtUk=")


class WeightedLengthTest(unittest.TestCase):
    def test_latin_counts_as_one(self):
        self.assertEqual(client.weighted_length("a" * 280), 280)

    def test_japanese_counts_as_two(self):
        self.assertEqual(client.weighted_length("あ" * 140), 280)

    def test_over_limit(self):
        self.assertGreater(client.weighted_length("あ" * 141), client.MAX_TEXT_LENGTH)


class PostGuardTest(unittest.TestCase):
    CRED = {
        "api_key": "k",
        "api_secret": "s",
        "access_token": "t",
        "access_token_secret": "ts",
    }

    def test_rejects_empty(self):
        with self.assertRaises(client.XError):
            client.post("   ", self.CRED, dry_run=True)

    def test_rejects_too_long(self):
        with self.assertRaises(client.XError):
            client.post("あ" * 141, self.CRED, dry_run=True)

    def test_dry_run_does_not_call_api(self):
        result = client.post("テスト", self.CRED, dry_run=True)
        self.assertTrue(result["dry_run"])

    def test_reply_is_attached(self):
        result = client.post("返信", self.CRED, reply_to="123", dry_run=True)
        self.assertEqual(result["payload"]["reply"]["in_reply_to_tweet_id"], "123")


class ConfigTest(unittest.TestCase):
    def test_missing_credentials_are_named(self):
        with self.assertRaises(ConfigError) as caught:
            Config.from_env({"X_API_KEY": "a"})
        message = str(caught.exception)
        self.assertIn("X_API_SECRET", message)
        self.assertIn("X_ACCESS_TOKEN", message)

    def test_validate_does_not_need_credentials(self):
        config = Config.from_env({}, require_credentials=False)
        self.assertEqual(config.timezone, "Asia/Tokyo")


class QueueTest(unittest.TestCase):
    def _write(self, lines):
        handle = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
        handle.write("\n".join(lines) + "\n")
        handle.close()
        return handle.name

    def test_rejects_text_over_x_limit(self):
        path = self._write([json.dumps({"text": "あ" * 141}, ensure_ascii=False)])
        with self.assertRaises(queue.QueueError) as caught:
            queue.load_queue(path)
        self.assertIn("上限", str(caught.exception))

    def test_accepts_140_japanese(self):
        path = self._write([json.dumps({"text": "あ" * 140}, ensure_ascii=False)])
        self.assertEqual(len(queue.load_queue(path)), 1)

    def test_only_due_items_are_selected(self):
        path = self._write([
            json.dumps({"id": "past", "text": "過去", "scheduled_at": "2026-01-01T09:00"}, ensure_ascii=False),
            json.dumps({"id": "future", "text": "未来", "scheduled_at": "2099-01-01T09:00"}, ensure_ascii=False),
        ])
        items = queue.load_queue(path)
        now = datetime(2026, 6, 1, tzinfo=JST)
        due = queue.select_due(items, set(), now=now, limit=5)
        self.assertEqual([i.id for i in due], ["past"])

    def test_posted_items_are_skipped(self):
        path = self._write([
            json.dumps({"id": "done", "text": "済", "scheduled_at": "2026-01-01T09:00"}, ensure_ascii=False),
        ])
        items = queue.load_queue(path)
        due = queue.select_due(items, {"done"}, now=datetime(2026, 6, 1, tzinfo=JST), limit=5)
        self.assertEqual(due, [])

    def test_duplicate_ids_are_rejected(self):
        path = self._write([
            json.dumps({"id": "same", "text": "1"}, ensure_ascii=False),
            json.dumps({"id": "same", "text": "2"}, ensure_ascii=False),
        ])
        with self.assertRaises(queue.QueueError):
            queue.load_queue(path)


if __name__ == "__main__":
    unittest.main()
