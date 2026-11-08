"""HTTP contract tests using tiny generated GGUF files, never production weights."""
import hashlib
import http.client
import json
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from urllib.parse import urlencode

from viewer.server import create_server


def gguf_fixture(path):
    def string(value):
        raw = value.encode("utf-8")
        return struct.pack("<Q", len(raw)) + raw

    fields = [
        string("general.architecture") + struct.pack("<I", 8) + string("llama"),
        string("llama.block_count") + struct.pack("<II", 4, 1),
        string("general.name") + struct.pack("<I", 8) + string("Fixture <script> data"),
    ]
    directory = (string("blk.0.attn_q.weight") + struct.pack("<IQQIQ", 2, 4, 2, 0, 0))
    header = b"GGUF" + struct.pack("<IQQ", 3, 1, len(fields)) + b"".join(fields) + directory
    path.write_bytes(header + bytes((-len(header)) % 32) + struct.pack("<8f", -3, -2, -1, 0, 0, 1, 2, 3))


class ViewerHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.model_path = cls.root / "fixture.gguf"
        gguf_fixture(cls.model_path)
        (cls.root / "malformed.gguf").write_bytes(b"not a model")
        (cls.root / "private.txt").write_text("NEVER SERVE THIS", encoding="utf-8")
        cls.original_hash = hashlib.sha256(cls.model_path.read_bytes()).hexdigest()
        cls.server = create_server([cls.root], port=0)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.temp.cleanup()

    def request(self, target, method="GET", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request(method, target, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def catalog(self):
        status, _, raw = self.request("/api/models")
        self.assertEqual(status, 200)
        return json.loads(raw)["models"]

    def model_id(self, name="fixture.gguf"):
        return next(model["id"] for model in self.catalog() if model["name"] == name)

    def test_health_and_static_ui(self):
        status, _, raw = self.request("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["application"], "gguf-observatory")
        status, headers, raw = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertIn(b"<html", raw.lower())
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_catalog_only_exposes_gguf(self):
        models = self.catalog()
        self.assertTrue(any(model["name"] == "fixture.gguf" for model in models))
        self.assertFalse(any(model["name"] == "private.txt" for model in models))

    def test_inspection_and_sample_match_file(self):
        query = urlencode({"id": self.model_id()})
        status, _, raw = self.request("/api/model?" + query)
        self.assertEqual(status, 200, raw)
        report = json.loads(raw)
        self.assertEqual(report["schema_version"], "1.0")
        self.assertEqual(report["summary"]["parameter_count"], 8)
        self.assertEqual(report["tensors"][0]["shape"], [4, 2])
        self.assertEqual(report["metadata"]["general.name"], "Fixture <script> data")
        query = urlencode({"id": self.model_id(), "tensor": "blk.0.attn_q.weight"})
        status, _, raw = self.request("/api/sample?" + query)
        self.assertEqual(status, 200, raw)
        sample = json.loads(raw)
        self.assertTrue(sample["supported"])
        self.assertEqual(sample["values"], [-3, -2, -1, 0, 0, 1, 2, 3])
        self.assertEqual(sample["stats"]["mean"], 0)
        self.assertEqual(sum(bucket["count"] for bucket in sample["histogram"]), 8)

    def test_export_is_attachment_and_read_only(self):
        query = urlencode({"id": self.model_id()})
        status, headers, raw = self.request("/api/export?" + query)
        self.assertEqual(status, 200, raw)
        self.assertIn("attachment", headers.get("Content-Disposition", ""))
        self.assertEqual(json.loads(raw)["summary"]["parameter_count"], 8)
        self.assertEqual(hashlib.sha256(self.model_path.read_bytes()).hexdigest(), self.original_hash)

    def test_unknown_and_path_ids_rejected(self):
        for value in ["missing", str(self.model_path), "../private.txt"]:
            with self.subTest(value=value):
                status, _, raw = self.request("/api/model?" + urlencode({"id": value}))
                self.assertIn(status, [400, 404])
                self.assertIn("error", json.loads(raw))

    def test_cross_origin_and_rebinding_hosts_rejected(self):
        for headers in [
            {"Host": "attacker.invalid"},
            {"Host": f"attacker.invalid:{self.port}"},
            {"Host": "127.0.0.1:1"},
            {"Origin": "https://attacker.invalid"},
            {"Origin": "null"},
            {"Sec-Fetch-Site": "cross-site"},
        ]:
            with self.subTest(headers=headers):
                status, _, _ = self.request("/api/models", headers=headers)
                self.assertEqual(status, 403)
        status, _, _ = self.request("/api/models", headers={"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(status, 200)

    def test_static_traversal_and_private_paths_rejected(self):
        for target in ["/private.txt", "/../private.txt", "/%2e%2e/private.txt", "/viewer/server.py", "/api/../private.txt"]:
            with self.subTest(target=target):
                status, _, raw = self.request(target)
                self.assertIn(status, [400, 404])
                self.assertNotIn(b"NEVER SERVE THIS", raw)

    def test_write_methods_rejected(self):
        for method in ["POST", "PUT", "PATCH", "DELETE"]:
            with self.subTest(method=method):
                status, _, _ = self.request("/api/model", method=method)
                self.assertIn(status, [405, 501])

    def test_malformed_model_is_bounded_error(self):
        status, _, raw = self.request("/api/model?" + urlencode({"id": self.model_id("malformed.gguf")}))
        self.assertIn(status, [400, 422])
        self.assertIn("error", json.loads(raw))
        status, _, raw = self.request("/api/health")
        self.assertEqual(status, 200, raw)

    def test_unknown_tensor_is_error(self):
        query = urlencode({"id": self.model_id(), "tensor": "not-a-tensor"})
        status, _, raw = self.request("/api/sample?" + query)
        self.assertIn(status, [400, 404, 422])
        self.assertIn("error", json.loads(raw))

    def test_non_loopback_bind_refused(self):
        with self.assertRaises(ValueError):
            create_server([self.root], port=0, host="0.0.0.0")


if __name__ == "__main__":
    unittest.main()
