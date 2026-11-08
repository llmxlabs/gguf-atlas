"""Integration of explicit plans, async copy jobs, and cloud transport boundaries."""
import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock
from urllib.parse import urlencode

from test_viewer_server import gguf_fixture
from viewer.server import create_server
from viewer.gguf_core import sample_tensor


class WorkbenchHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.models = self.root / 'models'
        self.models.mkdir()
        self.source = self.models / 'original.gguf'
        gguf_fixture(self.source)
        self.original = self.source.read_bytes()
        self.server = create_server([self.models], port=0,
                                    experiment_root=self.root / 'candidates', log_root=self.root / 'logs')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port
        self.ident = self.server.app.catalog()['models'][0]['id']

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temp.cleanup()

    def request(self, route, body=None, headers=None, raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            payload = raw if raw is not None else None if body is None else json.dumps(body)
            request_headers = {'Content-Type': 'application/json'} if payload is not None else {}
            request_headers.update(headers or {})
            connection.request('POST' if payload is not None else 'GET', route, body=payload, headers=request_headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def plan(self):
        status, plan = self.request('/api/experiments/plan', {
            'id': self.ident, 'tensor': 'blk.0.attn_q.weight', 'operation': 'scale',
            'factor': 0.5, 'element_start': 1, 'element_count': 3})
        self.assertEqual(status, 200, plan)
        return plan

    def test_review_confirm_copy_and_idempotence(self):
        plan = self.plan()
        self.assertEqual(plan['source']['sha256'], hashlib.sha256(self.original).hexdigest())
        self.assertFalse((self.root / 'candidates').exists())
        status, restored = self.request('/api/experiments/plan?' + urlencode({'id': plan['plan_id']}))
        self.assertEqual(status, 200)
        self.assertEqual(restored, plan)
        status, _ = self.request('/api/experiments/apply', {'plan_id': plan['plan_id'], 'confirm': False})
        self.assertEqual(status, 400)
        self.assertFalse((self.root / 'candidates').exists())
        status, started = self.request('/api/experiments/apply', {'plan_id': plan['plan_id'], 'confirm': True})
        self.assertEqual(status, 202, started)
        _, repeat = self.request('/api/experiments/apply', {'plan_id': plan['plan_id'], 'confirm': True})
        self.assertEqual(started['job_id'], repeat['job_id'])
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _, job = self.request('/api/jobs?' + urlencode({'id': started['job_id']}))
            if job['status'] in {'completed', 'failed'}:
                break
            time.sleep(0.01)
        self.assertEqual(job['status'], 'completed', job)
        result = job['result']
        self.assertFalse(result['behavior_tested'])
        self.assertFalse(result['runtime_switched'])
        self.assertTrue(result['unchanged_outside_edit'])
        self.assertEqual(self.source.read_bytes(), self.original)
        output = Path(result['output']['path'])
        # Temp paths may use a symlink (macOS /var) or a short-name alias on Windows.
        self.assertTrue(output.resolve().is_relative_to((self.root / 'candidates').resolve()))
        self.assertEqual(sample_tensor(output, 'blk.0.attn_q.weight')['values'], [-3, -1, -.5, 0, 0, 1, 2, 3])
        self.assertTrue(Path(result['manifest_path']).is_file())
        self.assertEqual(len(self.server.app.catalog()['models']), 2)

    def test_plan_identity_checks_before_copy(self):
        plan = self.plan()
        self.source.write_bytes(self.original[:-4] + b'\0\0\0\0')
        status, started = self.request('/api/experiments/apply', {'plan_id': plan['plan_id'], 'confirm': True})
        self.assertEqual(status, 202)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            _, job = self.request('/api/jobs?' + urlencode({'id': started['job_id']}))
            if job['status'] == 'failed':
                break
            time.sleep(.01)
        self.assertEqual(job['status'], 'failed')
        self.assertFalse(list((self.root / 'candidates').glob('*.gguf')))

    def test_post_boundaries_and_no_automatic_cloud_call(self):
        assistant = Mock()
        self.server.app.assistant = assistant
        for headers, raw in [({'Origin': 'https://evil.invalid'}, '{}'),
                             ({'Host': 'evil.invalid'}, '{}'),
                             ({'Content-Type': 'text/plain'}, '{}'),
                             ({}, '{"number":NaN}'), ({}, '[]')]:
            with self.subTest(headers=headers, raw=raw):
                status, _ = self.request('/api/chat', raw=raw, headers=headers)
                self.assertIn(status, {400, 403})
        assistant.chat.assert_not_called()
        self.request('/api/model?' + urlencode({'id': self.ident}))
        assistant.chat.assert_not_called()

    def test_chat_route_and_model_id_isolation(self):
        self.server.app.assistant = Mock()
        self.server.app.assistant.chat.return_value = {'reply': 'Grounded answer', 'proposals': []}
        body = {'id': self.ident, 'provider_model': 'test:cloud', 'message': 'Explain the selected tensor.'}
        status, answer = self.request('/api/chat', body)
        self.assertEqual(status, 200)
        self.assertEqual(answer['reply'], 'Grounded answer')
        self.server.app.assistant.chat.assert_called_once_with(body)
        status, _ = self.request('/api/experiments/plan', {'id': str(self.source), 'tensor': 'blk.0.attn_q.weight', 'operation': 'zero'})
        self.assertEqual(status, 400)


if __name__ == '__main__':
    unittest.main()
