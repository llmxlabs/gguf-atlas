"""Offline CLI adapter checks; subprocess tests run Python fixtures, never a model."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from viewer.assistant import AssistantError, AssistantService
from viewer.cli_assistant import CLIAssistant, build_command, parse_answer, run_bounded
from viewer.configuration import DEFAULT_SETTINGS, detect_cli
from test_viewer_assistant import FakeApp


class CLIAdapterTests(unittest.TestCase):
    def test_claude_command_has_no_tools_or_bypass(self):
        command = build_command("claude", "/bin/claude", "sonnet")
        self.assertEqual(command[command.index("--tools") + 1], "")
        self.assertIn("--safe-mode", command)
        self.assertIn("--strict-mcp-config", command)
        self.assertIn("--no-session-persistence", command)
        self.assertFalse(any("bypass" in argument or "skip-permissions" in argument for argument in command))

    def test_codex_command_readonly_auth_preserving_and_no_tools(self):
        command = build_command("codex", "/bin/codex")
        self.assertIn("--ignore-user-config", command)
        self.assertIn("--ephemeral", command)
        self.assertEqual(command[command.index("--sandbox") + 1], "read-only")
        self.assertEqual(command[command.index("--ask-for-approval") + 1], "never")
        self.assertIn("mcp_servers={}", command)
        self.assertIn("shell_tool", command)
        self.assertIn("--no-daemon", command)
        self.assertFalse(any("bypass" in argument for argument in command))

    def test_model_cannot_inject_arguments(self):
        for value in ("--model x", "x; command", "a\nother", "--help"):
            with self.assertRaises(ValueError):
                build_command("codex", "/bin/codex", value)

    def test_parses_claude_and_codex_answers(self):
        reply, usage = parse_answer("claude", json.dumps({"result": "hello", "usage": {"input_tokens": 5, "cache_creation_input_tokens": 10, "cache_read_input_tokens": 20, "output_tokens": 2}}))
        self.assertEqual((reply, usage["completion_tokens"]), ("hello", 2))
        self.assertEqual(usage["prompt_tokens"], 35)
        self.assertEqual(usage["uncached_input_tokens"], 5)
        raw = '\n'.join(json.dumps(value) for value in [{"type": "item.completed", "item": {"type": "agent_message", "text": "answer"}}, {"type": "turn.completed", "usage": {"input_tokens": 6, "output_tokens": 3}}])
        reply, usage = parse_answer("codex", raw)
        self.assertEqual((reply, usage["completion_tokens"]), ("answer", 3))

    def test_failed_and_tool_responses_rejected(self):
        for provider, raw in (("claude", '{"is_error":true,"result":"secret"}'),
                              ("codex", '{"type":"turn.failed"}'),
                              ("codex", '{"type":"item.completed","item":{"type":"command_execution"}}'),
                              ("claude", "not json")):
            with self.assertRaises(AssistantError):
                parse_answer(provider, raw)

    def test_bounded_runner_stdin_without_shell(self):
        with tempfile.TemporaryDirectory() as folder:
            code, out, error = run_bounded([sys.executable, "-c", "import sys; print(sys.stdin.read())"], prompt="literal $(command) & text", cwd=folder)
        self.assertEqual(code, 0)
        self.assertIn("literal $(command) & text", out)
        self.assertEqual(error, "")

    def test_runner_output_and_timeout_limits(self):
        with self.assertRaisesRegex(AssistantError, "output"):
            run_bounded([sys.executable, "-c", "print('x'*10000)"], output_limit=100)
        with self.assertRaisesRegex(AssistantError, "timed out"):
            run_bounded([sys.executable, "-c", "import time; time.sleep(5)"], timeout=.05)

    def test_exited_leader_inherited_pipe_still_obeys_deadline_and_kills_child(self):
        with tempfile.TemporaryDirectory() as folder:
            ready, late = Path(folder) / "spawned", Path(folder) / "late-write"
            child = "import time,pathlib; time.sleep(1.2); pathlib.Path(" + repr(str(late)) + ").write_text('child survived'); print('late output',flush=True)"
            parent = "import subprocess,sys,pathlib; subprocess.Popen([sys.executable,'-c'," + repr(child) + "]); pathlib.Path(" + repr(str(ready)) + ").write_text('spawned')"
            started = time.monotonic()
            with self.assertRaisesRegex(AssistantError, "timed out"):
                run_bounded([sys.executable, "-c", parent], timeout=.3, cwd=folder)
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertTrue(ready.exists(), "Fixture must spawn the child before the deadline")
            time.sleep(1.3)
            self.assertFalse(late.exists(), "Timed-out owned descendant must not survive")

    def test_successful_leader_also_cleans_background_children(self):
        with tempfile.TemporaryDirectory() as folder:
            late = Path(folder) / "late-write"
            child = "import time,pathlib; time.sleep(.6); pathlib.Path(" + repr(str(late)) + ").write_text('child survived')"
            parent = "import subprocess,sys; subprocess.Popen([sys.executable,'-c'," + repr(child) + "],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print('done')"
            code, out, _ = run_bounded([sys.executable, "-c", parent], timeout=2, cwd=folder)
            self.assertEqual(code, 0)
            self.assertIn("done", out)
            time.sleep(.7)
            self.assertFalse(late.exists(), "Successful invocation must not leave background descendants")

    def test_snapshot_uses_bounded_context_and_no_credentials(self):
        app = FakeApp()
        app.assistant = AssistantService(app, transport=lambda *args: (_ for _ in ()).throw(AssertionError("No Ollama calls allowed")))
        runner = Mock(return_value=(0, '{"result":"Eight stored values","usage":{"input_tokens":10,"output_tokens":3}}', ""))
        service = CLIAssistant(app, runner=runner)
        detected = {"available": True, "executable": "/bin/claude", "label": "Claude Code CLI"}
        with patch("viewer.cli_assistant.detect_cli", return_value=detected):
            result = service.chat({"id": "fixture", "provider_model": "", "message": "Explain the selected tensor", "selected_tensor": "blk.0.attn_norm.weight", "selected_view": "heatmap"}, "claude", copy.deepcopy(DEFAULT_SETTINGS))
        prompt = runner.call_args.kwargs["prompt"]
        self.assertIn("heatmap", prompt)
        snapshot = json.loads(prompt.split("Conversation and inspection snapshot (JSON data):\n", 1)[1])
        self.assertIn('"example_values": [0, 1, 2, 3', snapshot[-1]["content"])
        self.assertNotIn("PRIVATE_TOKEN_SENTINEL", prompt)
        self.assertNotIn("SYSTEM_INJECTION_SENTINEL", prompt)
        self.assertNotIn("private.gguf", prompt)
        self.assertEqual(result["proposals"], [])
        self.assertEqual(result["provider"], "claude")
        self.assertEqual(app.plan_calls, [])
        self.assertFalse(Path(runner.call_args.kwargs["cwd"]).exists())

    def test_cli_failure_does_not_leak_diagnostics(self):
        app = FakeApp()
        app.assistant = AssistantService(app)
        service = CLIAssistant(app, runner=Mock(return_value=(1, "SECRET_TOKEN", "SECRET_TOKEN")))
        with patch("viewer.cli_assistant.detect_cli", return_value={"available": True, "executable": "/bin/claude", "label": "Claude"}):
            with self.assertRaises(AssistantError) as caught:
                service.chat({"id": "fixture", "message": "Explain", "provider_model": ""}, "claude", copy.deepcopy(DEFAULT_SETTINGS))
        self.assertNotIn("SECRET_TOKEN", str(caught.exception))

    def test_missing_cli_does_not_run(self):
        runner = Mock()
        with patch("viewer.cli_assistant.detect_cli", return_value={"available": False, "reason": "missing"}):
            with self.assertRaisesRegex(AssistantError, "missing"):
                CLIAssistant(FakeApp(), runner).chat({}, "codex", copy.deepcopy(DEFAULT_SETTINGS))
        runner.assert_not_called()


if __name__ == "__main__":
    unittest.main()
