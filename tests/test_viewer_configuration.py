"""Portable configuration tests; all writes stay in temporary folders."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from viewer.configuration import ConfigStore, DEFAULT_SETTINGS, config_path, mcp_snippets, user_data_dir, _absolute_env_dir
from viewer.server import ViewerApp


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / "settings" / "config.json"

    def tearDown(self):
        self.temp.cleanup()

    def test_defaults_do_not_write_until_save(self):
        store = ConfigStore(self.path)
        self.assertEqual(store.snapshot(), DEFAULT_SETTINGS)
        self.assertFalse(self.path.exists())

    def test_partial_update_roundtrips_without_credentials(self):
        store = ConfigStore(self.path)
        store.update({"default_provider": "claude", "providers": {"claude": {"model": "sonnet"}}})
        saved = ConfigStore(self.path).snapshot()
        self.assertEqual(saved["default_provider"], "claude")
        self.assertEqual(saved["providers"]["claude"]["model"], "sonnet")
        self.assertEqual(saved["providers"]["codex"], DEFAULT_SETTINGS["providers"]["codex"])
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_unknown_keys_secrets_shell_and_remote_urls_rejected(self):
        store = ConfigStore(self.path)
        cases = [{"api_key": "secret"}, {"providers": {"claude": {"token": "secret"}}},
                 {"providers": {"codex": {"executable": "codex --dangerously-bypass-approvals-and-sandbox"}}},
                 {"providers": {"claude": {"model": "--tools Bash"}}},
                 {"providers": {"ollama": {"base_url": "http://example.com:11434"}}},
                 {"providers": {"ollama": {"base_url": "http://token@localhost:11434"}}},
                 {"providers": {"ollama": {"base_url": "http://localhost:11434/private"}}},
                 {"timeout_seconds": 301}, {"timeout_seconds": True}, {"default_provider": "arbitrary"}]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    store.update(value)
        self.assertFalse(self.path.exists())

    def test_ollama_url_normalization_and_timeout(self):
        result = ConfigStore(self.path).update({"providers": {"ollama": {"base_url": "http://localhost:12345/"}}, "timeout_seconds": 15})
        self.assertEqual(result["providers"]["ollama"]["base_url"], "http://localhost:12345")

    def test_bad_configuration_reported_and_preserved_until_save(self):
        self.path.parent.mkdir()
        self.path.write_text("not json", encoding="utf-8")
        store = ConfigStore(self.path)
        self.assertIsNotNone(store.error)
        self.assertEqual(store.snapshot(), DEFAULT_SETTINGS)
        self.assertEqual(self.path.read_text(), "not json")
        with self.assertRaisesRegex(ValueError, "will not be overwritten"):
            store.update({"default_provider": "codex"})
        self.assertEqual(self.path.read_text(), "not json")

    def test_model_suffix_and_magic_never_overwritten_as_config(self):
        for name, content in (("model.gguf", b"GGUFfixture"), ("renamed.json", b"GGUFfixture"),
                              ("big-endian.json", b"FUGGfixture"), ("data.json", b'{"unrelated":true}')):
            with self.subTest(name=name):
                path = self.root / name
                path.write_bytes(content)
                store = ConfigStore(path)
                self.assertIsNotNone(store.error)
                with self.assertRaises(ValueError):
                    store.update({"default_provider": "claude"})
                self.assertEqual(path.read_bytes(), content)
        absent_model = self.root / "new-model.gguf"
        with self.assertRaises(ValueError):
            ConfigStore(absent_model).update({"default_provider": "claude"})
        self.assertFalse(absent_model.exists())

    def test_configuration_changed_to_model_after_load_is_rejected(self):
        store = ConfigStore(self.path)
        store.update({"default_provider": "claude"})
        self.path.write_bytes(b"GGUFchanged-file")
        with self.assertRaisesRegex(ValueError, "GGUF"):
            store.update({"default_provider": "codex"})
        self.assertEqual(self.path.read_bytes(), b"GGUFchanged-file")

    def test_config_symlink_to_model_preserves_target(self):
        model, link = self.root / "source.gguf", self.root / "settings.json"
        model.write_bytes(b"GGUFfixture")
        try:
            link.symlink_to(model)
        except OSError:
            self.skipTest("Symlinks unavailable for this user")
        with self.assertRaises(ValueError):
            ConfigStore(link).update({"default_provider": "claude"})
        self.assertEqual(model.read_bytes(), b"GGUFfixture")
        self.assertTrue(link.is_symlink())

    def test_empty_or_relative_data_environment_uses_absolute_fallback(self):
        fallback = Path.home() / "fallback"
        for name in ("XDG_DATA_HOME", "LOCALAPPDATA"):
            for value in ("", "relative/settings"):
                with self.subTest(name=name, value=value), patch.dict(os.environ, {name: value}):
                    self.assertEqual(_absolute_env_dir(name, fallback), fallback)
        with patch.dict(os.environ, {"XDG_DATA_HOME": "", "LOCALAPPDATA": "relative"}):
            self.assertTrue(user_data_dir().is_absolute())

    def test_environment_config_path(self):
        with patch.dict(os.environ, {"GGUF_ATLAS_CONFIG": str(self.path)}):
            self.assertEqual(config_path(), self.path.resolve())

    def test_generated_snippets_follow_interpreter_package_and_port(self):
        result = mcp_snippets(19099)
        entry = result["claude_config"]["mcpServers"]["gguf-atlas"]
        self.assertEqual(entry["args"][-1], "http://127.0.0.1:19099")
        self.assertTrue(Path(entry["args"][0]).is_file())
        self.assertIn("19099", result["codex_config"])
        self.assertNotIn("token", json.dumps(result))

    def test_catalog_ids_respect_filesystem_case(self):
        upper, lower = self.root / "Foo.gguf", self.root / "foo.gguf"
        upper.write_bytes(b"fixture")
        lower.write_bytes(b"fixture")
        if upper.samefile(lower):
            self.skipTest("Filesystem is case-insensitive")
        app = ViewerApp([self.root], config_file=self.path)
        self.assertEqual(len(app.models), 2)
        self.assertEqual(len(set(app.models)), 2)

    def test_configuration_endpoint_shape_with_mock_detection(self):
        app = ViewerApp([self.root], config_file=self.path)
        app.port = 19099
        with patch.object(app.assistant, "status", return_value={"available": False, "models": [], "default_model": None, "status": "unavailable", "error": "offline"}), \
             patch("viewer.server.detect_cli", side_effect=lambda name, executable: {"id": name, "label": name, "available": True, "reason": "fixture"}):
            value = app.configuration()
            self.assertEqual(value["storage"]["config_path"], str(self.path.resolve()))
            self.assertEqual(len(value["providers"]), 3)
            self.assertEqual(value["mcp"]["args"][-1], "http://127.0.0.1:19099")
            self.assertTrue(app.provider_status()["available"])


if __name__ == "__main__":
    unittest.main()
