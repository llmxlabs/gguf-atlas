"""Offline parser, bounded sampling and malformed-file regression fixtures."""
import hashlib
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest

from viewer.gguf_core import GGUFError, QUANT_TYPES, _Reader, _decode_block, inspect_model, sample_tensor


def gguf_bytes(tensors, metadata=None, endian="<", version=3):
    pack = lambda fmt, *args: struct.pack(endian + fmt, *args)
    string = lambda s: pack("Q", len(s.encode())) + s.encode()
    fields = metadata if metadata is not None else [("general.architecture", 8, "llama"), ("llama.block_count", 4, 1)]
    data = b"GGUF" + pack("IQQ", version, len(tensors), len(fields))
    for key, kind, value in fields:
        data += string(key) + pack("I", kind)
        if kind == 8:
            data += string(value)
        elif kind == 9:
            subtype, values = value
            data += pack("IQ", subtype, len(values))
            data += b"".join(string(v) if subtype == 8 else pack("B" if subtype == 7 else "I", v) for v in values)
        else:
            data += pack({4: "I", 7: "B", 10: "Q"}[kind], value)
    offset, payload = 0, b""
    for name, shape, typ, raw in tensors:
        data += string(name) + pack("I", len(shape)) + pack("Q" * len(shape), *shape) + pack("IQ", typ, offset)
        payload += raw
        payload += b"\0" * (-len(payload) % 32)
        offset = len(payload)
    return data + b"\0" * (-len(data) % 32) + payload


class GGUFCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "fixture.gguf"

    def tearDown(self):
        self.temp.cleanup()

    def write(self, tensors, **kwargs):
        self.path.write_bytes(gguf_bytes(tensors, **kwargs))
        return self.path

    def test_real_float_values_and_no_mutation(self):
        values = [-2.0, -1.0, 0.0, 1.0, 2.0, 3.0]
        p = self.write([("blk.0.attn_q.weight", [3, 2], 0, struct.pack("<6f", *values))])
        before = hashlib.sha256(p.read_bytes()).hexdigest()
        model, sample = inspect_model(p), sample_tensor(p, "blk.0.attn_q.weight")
        self.assertEqual(model["summary"]["parameter_count"], 6)
        self.assertEqual(model["summary"]["tensor_bytes"], 24)
        self.assertEqual(model["layers"][0]["index"], 0)
        self.assertEqual(sample["values"], values)
        self.assertEqual(sample["stats"]["mean"], 0.5)
        self.assertEqual(sum(x["count"] for x in sample["histogram"]), 6)
        self.assertEqual(before, hashlib.sha256(p.read_bytes()).hexdigest())

    def test_big_endian_v3_scalar(self):
        p = self.write([("output.weight", [2], 0, struct.pack(">2f", 1.25, -3.5))], endian=">")
        self.assertEqual(inspect_model(p)["file"]["endianness"], "big")
        self.assertEqual(sample_tensor(p, "output.weight")["values"], [1.25, -3.5])

    def test_v2_little_endian(self):
        p = self.write([("output.weight", [1], 1, struct.pack("<e", 2))], version=2)
        self.assertEqual(inspect_model(p)["file"]["version"], 2)

    def test_reject_big_endian_v2(self):
        self.write([], endian=">", version=2)
        with self.assertRaisesRegex(GGUFError, "requires version 3"):
            inspect_model(self.path)

    def test_unknown_type_keeps_size_unknown(self):
        self.write([("weight", [32], 999, b"\0" * 64)])
        m = inspect_model(self.path)
        self.assertIsNone(m["summary"]["tensor_bytes"])
        self.assertFalse(sample_tensor(self.path, "weight")["supported"])

    def test_iq_directory_without_fake_weight_values(self):
        self.write([("weight", [256], 18, b"\0" * 98)])
        self.assertEqual(inspect_model(self.path)["summary"]["tensor_bytes"], 98)
        s = sample_tensor(self.path, "weight")
        self.assertFalse(s["supported"])
        self.assertEqual(s["values"], [])

    def test_array_preview_and_following_metadata(self):
        fields = [("tokenizer.ggml.tokens", 9, (8, [str(i) for i in range(100)])), ("llama.context_length", 4, 8192)]
        self.write([], metadata=fields)
        m = inspect_model(self.path)["metadata"]
        self.assertEqual(m["tokenizer.ggml.tokens"]["count"], 100)
        self.assertEqual(len(m["tokenizer.ggml.tokens"]["preview"]), 16)
        self.assertEqual(m["llama.context_length"], 8192)

    def test_numeric_array_preview(self):
        self.write([], metadata=[("numbers", 9, (4, list(range(1000))))])
        self.assertEqual(inspect_model(self.path)["metadata"]["numbers"]["preview"], list(range(16)))

    def test_truncated_tensor_rejected(self):
        self.write([("weight", [8], 0, b"\0" * 32)])
        self.path.write_bytes(self.path.read_bytes()[:-1])
        with self.assertRaisesRegex(GGUFError, "Truncated"):
            inspect_model(self.path)

    def test_bad_magic_and_version(self):
        for raw in [b"bad!", b"GGUF" + struct.pack("<I", 1)]:
            self.path.write_bytes(raw)
            with self.assertRaises(GGUFError):
                inspect_model(self.path)

    def test_duplicate_tensor(self):
        self.write([("same", [1], 0, b"\0" * 4)] * 2)
        with self.assertRaisesRegex(GGUFError, "Duplicate tensor"):
            inspect_model(self.path)

    def test_duplicate_metadata(self):
        self.write([], metadata=[("x", 4, 1), ("x", 4, 2)])
        with self.assertRaisesRegex(GGUFError, "Duplicate metadata"):
            inspect_model(self.path)

    def test_invalid_alignment(self):
        self.write([], metadata=[("general.alignment", 4, 3)])
        with self.assertRaisesRegex(GGUFError, "alignment"):
            inspect_model(self.path)

    def test_invalid_boolean(self):
        self.write([], metadata=[("bad", 7, 2)])
        with self.assertRaisesRegex(GGUFError, "boolean"):
            inspect_model(self.path)

    def test_invalid_boolean_array_tail(self):
        self.write([], metadata=[("bad", 9, (7, [1] * 20 + [2]))])
        with self.assertRaisesRegex(GGUFError, "boolean"):
            inspect_model(self.path)

    def test_cached_inspection_sampling_and_identity(self):
        self.write([("weight", [1], 0, struct.pack("<f", 3.5))])
        model = inspect_model(self.path)
        self.assertEqual(sample_tensor(self.path, "weight", inspection=model)["values"], [3.5])
        model["file"]["path"] += ".different"
        with self.assertRaisesRegex(GGUFError, "does not match"):
            sample_tensor(self.path, "weight", inspection=model)

    def test_quant_row_must_be_block_multiple(self):
        self.write([("weight", [31, 32], 2, b"\0" * 1000)])
        with self.assertRaisesRegex(GGUFError, "block size"):
            inspect_model(self.path)

    def test_bounded_prefix_and_request_limit(self):
        self.write([("weight", [32], 8, struct.pack("<e", 0.5) + bytes(range(32)))])
        s = sample_tensor(self.path, "weight", 3)
        self.assertEqual(s["values"], [0, 0.5, 1])
        self.assertEqual(s["bytes_read"], 34)
        for count in (0, 16_385, True):
            with self.assertRaises(GGUFError):
                sample_tensor(self.path, "weight", count)

    def test_nonfinite_values_are_json_safe(self):
        self.write([("weight", [4], 0, struct.pack("<4f", 1, float("nan"), float("inf"), -float("inf")))])
        s = sample_tensor(self.path, "weight")
        self.assertEqual(s["values"], [1, None, None, None])
        self.assertEqual(s["nonfinite_count"], 3)
        json.dumps(s, allow_nan=False)

    def test_reader_budgets_enforced_before_allocation(self):
        r = _Reader(io.BytesIO(struct.pack("<Q", 100) + b"a" * 100), 108)
        r.retained_budget = 32
        with self.assertRaisesRegex(GGUFError, "retained"):
            r.string()
        r = _Reader(io.BytesIO(), 2**40)
        with self.assertRaisesRegex(GGUFError, "256 MiB"):
            r.skip(256 * 1024 * 1024 + 1)

    def test_q4_q5_and_bf16_known_values(self):
        raw = struct.pack("<e", 2) + bytes([0xF0] * 16)
        self.assertEqual(_decode_block(raw, 2), [-16] * 16 + [14] * 16)
        raw = struct.pack("<e", 1) + b"\xff" * 4 + bytes([0] * 16)
        self.assertEqual(_decode_block(raw, 6), [0] * 32)
        self.assertEqual(_decode_block(struct.pack("<H", 0x3F80), 30), [1])

    def test_k_quant_reference_patterns(self):
        raw = bytes([0x21] * 16) + bytes([0xE4] * 64) + struct.pack("<2e", 2, 3)
        expected = [2 * ((0xE4 >> (2 * ((j % 128) // 32))) & 3) - 6 for j in range(256)]
        self.assertEqual(_decode_block(raw, 10), expected)
        # Q6: zero bit planes represent -32; signed per-group scales are 1.
        raw = bytes(192) + bytes([1] * 16) + struct.pack("<e", 0.5)
        self.assertEqual(_decode_block(raw, 14), [-16] * 256)

    def test_all_zero_blocks_decode_finite_zero(self):
        for typ in (2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20):
            name, block, size = QUANT_TYPES[typ]
            with self.subTest(type=name):
                self.assertEqual(_decode_block(bytes(size), typ), [0] * block)


if __name__ == "__main__":
    unittest.main()
