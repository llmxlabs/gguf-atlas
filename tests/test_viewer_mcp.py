"""MCP protocol and local HTTP bridge tests; no installed-model mutation."""
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import threading
import unittest

from viewer.mcp_server import AtlasClient, MAX_INPUT_BYTES, MCPServer, serve


INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}
READY = {"jsonrpc": "2.0", "method": "notifications/initialized"}


class FakeClient:
    base_url = "http://127.0.0.1:18040"

    def __init__(self):
        self.calls = []
        self.failure = None

    def request(self, path, query=None, body=None):
        self.calls.append((path, query, body))
        if self.failure:
            raise ValueError(self.failure)
        if path == "/api/models":
            return {"models": [{"id": str(i), "name": f"model-{i}.gguf"} for i in range(120)]}
        if path == "/api/model":
            return {"schema_version": "1.0", "file": {"name": "fixture.gguf"}, "architecture": {"name": "llama"},
                    "summary": {"tensor_count": 3}, "metadata": {f"key.{i}": "x" * 1200 for i in range(50)},
                    "layers": [{"index": 0}, {"index": 1}], "warnings": [],
                    "tensors": [{"name": "blk.0.q.weight", "layer": 0}, {"name": "blk.1.q.weight", "layer": 1}, {"name": "output.weight", "layer": None}]}
        if path == "/api/sample":
            return {"values": [1, 2], "supported": True}
        if path == "/api/experiments/plan":
            return {"plan_id": "a" * 32, "status": "awaiting_review"}
        return {"status": "complete", "job_id": "job-1"}


class MCPTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        self.server = MCPServer(self.client)
        self.server.handle(INIT)
        self.server.handle(READY)

    def call(self, name, arguments):
        return self.server.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": name, "arguments": arguments}})

    def data(self, reply):
        self.assertFalse(reply["result"]["isError"])
        return json.loads(reply["result"]["content"][0]["text"])["data"]

    def test_negotiation_and_initialization_gate(self):
        server = MCPServer(self.client)
        reply = server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(reply["error"]["code"], -32002)
        initialize = json.loads(json.dumps(INIT))
        initialize["params"]["protocolVersion"] = "2099-01-01"
        self.assertEqual(server.handle(initialize)["result"]["protocolVersion"], "2025-03-26")
        self.assertIsNone(server.handle(READY))
        self.assertEqual(server.handle({"jsonrpc": "2.0", "id": 3, "method": "ping"})["result"], {})

    def test_tool_discovery_excludes_apply(self):
        reply = self.server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = {entry["name"] for entry in reply["result"]["tools"]}
        self.assertEqual(len(names), 8)
        self.assertIn("propose_edit", names)
        self.assertFalse(any("apply" in name for name in names))

    def test_model_and_tensor_pagination(self):
        data = self.data(self.call("list_models", {"offset": 100, "limit": 10}))
        self.assertEqual(len(data["models"]), 10)
        self.assertEqual(data["next_offset"], 110)
        data = self.data(self.call("list_tensors", {"model_id": "abc", "query": "Q.WEIGHT", "layer": 1}))
        self.assertEqual(data["tensors"], [{"name": "blk.1.q.weight", "layer": 1}])

    def test_compact_model_inspection(self):
        data = self.data(self.call("inspect_model", {"model_id": "abc"}))
        self.assertNotIn("tensors", data)
        self.assertEqual(data["metadata_matching_count"], 50)
        self.assertEqual(len(data["metadata_preview"]), 32)
        self.assertIn("truncated", data["metadata_preview"]["key.0"])

    def test_tensor_and_sample_use_catalog_id(self):
        data = self.data(self.call("inspect_tensor", {"model_id": "abc", "tensor": "output.weight"}))
        self.assertEqual(data["name"], "output.weight")
        data = self.data(self.call("sample_tensor", {"model_id": "abc", "tensor": "output.weight"}))
        self.assertEqual(data["values"], [1, 2])
        self.assertEqual(self.client.calls[-1][1], {"id": "abc", "tensor": "output.weight"})

    def test_edit_only_proposes_and_provides_user_review_url(self):
        data = self.data(self.call("propose_edit", {"model_id": "abc", "tensor": "norm", "operation": "scale", "factor": 0.9}))
        self.assertEqual(data["review_url"], self.client.base_url + "/?plan=" + "a" * 32)
        path, _, body = self.client.calls[-1]
        self.assertEqual(path, "/api/experiments/plan")
        self.assertEqual(body["id"], "abc")
        self.assertFalse(any("apply" in path for path, _, _ in self.client.calls))

    def test_assistant_context_is_typed(self):
        self.data(self.call("ask_model_assistant", {"model_id": "abc", "provider_model": "local", "message": "Explain block 1", "selection": {"layer": 1}}))
        path, _, body = self.client.calls[-1]
        self.assertEqual(path, "/api/chat")
        self.assertEqual(body["selection"], {"layer": 1})
        self.assertEqual(body["history"], [])

    def test_argument_validation_and_unexposed_apply(self):
        cases = [("apply_plan", {}), ("list_models", {"limit": 101}), ("list_models", {"limit": True}),
                 ("sample_tensor", {"model_id": "abc", "tensor": "x", "path": "C:/secret"}),
                 ("propose_edit", {"model_id": "abc", "tensor": "x", "operation": "execute"}),
                 ("propose_edit", {"model_id": "abc", "tensor": "x", "operation": "scale", "factor": float("nan")})]
        for name, args in cases:
            with self.subTest(name=name, args=args):
                self.assertEqual(self.call(name, args)["error"]["code"], -32602)
        self.assertEqual(self.client.calls, [])

    def test_backend_errors_become_tool_errors(self):
        self.client.failure = "Atlas HTTP 400: tensor unavailable"
        reply = self.call("inspect_model", {"model_id": "abc"})
        self.assertTrue(reply["result"]["isError"])
        self.assertNotIn("error", reply)

    def test_batch_and_notification_behavior(self):
        batch = [{"jsonrpc": "2.0", "id": 5, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/cancelled"}]
        self.assertEqual(len(self.server.handle(batch)), 1)
        self.assertIsNone(self.server.handle([READY]))
        self.assertEqual(self.server.handle([INIT])["error"]["code"], -32600)

    def test_stdio_json_lines_and_malformed_input(self):
        source = b"not-json\n" + b"\n".join(json.dumps(m).encode() for m in (INIT, READY, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})) + b"\n"
        output = io.BytesIO()
        self.assertEqual(serve(io.BytesIO(source), output, MCPServer(self.client)), 0)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(replies), 3)
        self.assertEqual(replies[0]["error"]["code"], -32700)
        self.assertEqual(len(replies[2]["result"]["tools"]), 8)

    def test_oversize_input_closes_session(self):
        output = io.BytesIO()
        self.assertEqual(serve(io.BytesIO(b"x" * (MAX_INPUT_BYTES + 1)), output, self.server), 1)
        self.assertEqual(json.loads(output.getvalue())["error"]["code"], -32700)

    def test_real_stdio_subprocess_has_protocol_only_stdout(self):
        messages = [INIT, READY, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
        result = subprocess.run([sys.executable, "-m", "viewer.mcp_server"],
                                input="".join(json.dumps(m) + "\n" for m in messages), capture_output=True,
                                text=True, cwd=Path(__file__).resolve().parents[1], timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(replies), 2)
        self.assertEqual(len(replies[1]["result"]["tools"]), 8)

    def test_loopback_url_restrictions(self):
        for url in ("https://127.0.0.1:18040", "http://example.com:18040", "http://localhost:18040", "http://user@127.0.0.1:18040", "http://127.0.0.1:18040/path"):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    AtlasClient(url)


class BridgeHTTPTests(unittest.TestCase):
    def test_real_http_success_errors_and_redirect_rejection(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "http://example.com/")
                    self.end_headers()
                elif self.path == "/fail":
                    self.send_response(403)
                    self.end_headers()
                    self.wfile.write(b'{"error":"denied"}')
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": True, "origin": self.headers.get("Origin")}).encode())
        http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            client = AtlasClient(f"http://127.0.0.1:{http.server_port}")
            self.assertEqual(client.request("/ok"), {"ok": True, "origin": client.base_url})
            with self.assertRaisesRegex(ValueError, "HTTP 403"):
                client.request("/fail")
            with self.assertRaisesRegex(ValueError, "redirects"):
                client.request("/redirect")
        finally:
            http.shutdown()
            http.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
