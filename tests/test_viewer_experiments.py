"""Small synthetic fixtures only: never copy or edit installed model weights."""
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from viewer.experiments import apply_plan, create_plan
from viewer.gguf_core import GGUFError, sample_tensor


def fixture(path, values, typ=0, endian="<", split=False):
    pack = lambda fmt, *v: struct.pack(endian + fmt, *v)
    string = lambda text: pack("Q", len(text)) + text.encode()
    metadata = string("general.architecture") + pack("I", 8) + string("llama")
    if split:
        metadata += string("split.count") + pack("II", 4, 2)
    if typ == 30:
        raw = b"".join(pack("H", struct.unpack("<I", struct.pack("<f", value))[0] >> 16) for value in values)
    elif typ in (0, 1):
        raw = pack(("f" if typ == 0 else "e") * len(values), *values)
    else:
        raw = b"\0" * 18
    header = b"GGUF" + pack("IQQ", 3, 2, 2 if split else 1) + metadata
    header += string("blk.0.attn_norm.weight") + pack("IQIQ", 1, len(values), typ, 0)
    second_offset = (len(raw) + 31) // 32 * 32
    header += string("output_norm.weight") + pack("IQIQ", 1, 2, 0, second_offset)
    header += b"\0" * (-len(header) % 32)
    raw += b"\0" * (-len(raw) % 32)
    path.write_bytes(header + raw + pack("2f", 9, 10))


class ExperimentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source.gguf"
        self.output = self.root / "candidates"
        self.logs = self.root / "logs"
        self.tensor = "blk.0.attn_norm.weight"
        fixture(self.source, [1, -2, 3, -4])

    def tearDown(self):
        self.temp.cleanup()

    def plan(self, **kwargs):
        return create_plan(self.source, self.tensor, kwargs.pop("operation", "scale"), **kwargs)

    def test_plan_review_contains_hash_and_creates_no_copy(self):
        p = self.plan(factor=0.5, element_start=1, element_count=2)
        self.assertEqual(p["source"]["sha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(p["status"], "awaiting_review")
        self.assertEqual(p["edit"]["element_end"], 3)
        self.assertEqual(p["required_copy_bytes"], self.source.stat().st_size)
        self.assertFalse(self.output.exists())

    def test_scale_subset_verifies_copy_and_preserves_all_other_bytes(self):
        original = self.source.read_bytes()
        plan = self.plan(factor=0.5, element_start=1, element_count=2)
        result = apply_plan(plan, self.output, self.logs)
        candidate = Path(result["output"]["path"])
        sample = sample_tensor(candidate, self.tensor)
        self.assertEqual(sample["values"], [1, -1, 1.5, -4])
        self.assertEqual(self.source.read_bytes(), original)
        lo, count = plan["edit"]["byte_start"], plan["edit"]["byte_count"]
        updated = candidate.read_bytes()
        self.assertEqual(original[:lo], updated[:lo])
        self.assertEqual(original[lo + count:], updated[lo + count:])
        self.assertEqual(result["changed_elements"], 2)
        self.assertTrue(result["unchanged_outside_edit"])
        self.assertEqual(result["output"]["sha256"], hashlib.sha256(updated).hexdigest())
        self.assertFalse(result["behavior_tested"])
        self.assertFalse(result["runtime_switched"])
        self.assertEqual(json.loads(Path(result["manifest_path"]).read_text())["plan_id"], plan["plan_id"])
        self.assertEqual(list(self.output.glob("*.partial")), [])

    def test_zero_remaining_range(self):
        result = apply_plan(self.plan(operation="zero", element_start=2), self.output, self.logs)
        self.assertEqual(sample_tensor(result["output"]["path"], self.tensor)["values"], [1, -2, 0, 0])

    def test_f16_bf16_and_big_endian(self):
        for typ, endian in ((1, "<"), (30, "<"), (0, ">"), (1, ">"), (30, ">")):
            with self.subTest(type=typ, endian=endian):
                fixture(self.source, [1, -2, 3, -4], typ, endian)
                r = apply_plan(self.plan(factor=-0.5), self.output, self.logs)
                self.assertEqual(sample_tensor(r["output"]["path"], self.tensor)["values"], [-0.5, 1, -1.5, 2])

    def test_duplicate_apply_produces_distinct_candidates(self):
        plan = self.plan(factor=0.5)
        one = apply_plan(plan, self.output, self.logs)
        two = apply_plan(plan, self.output, self.logs)
        self.assertNotEqual(one["output"]["path"], two["output"]["path"])
        self.assertEqual(one["output"]["sha256"], two["output"]["sha256"])

    def test_unsupported_quantized_tensor(self):
        fixture(self.source, [0] * 32, typ=2)
        with self.assertRaisesRegex(GGUFError, "unsupported"):
            self.plan()

    def test_split_model_rejected(self):
        fixture(self.source, [1, 2], split=True)
        with self.assertRaisesRegex(GGUFError, "Split"):
            self.plan()

    def test_invalid_operations_factors_and_ranges(self):
        for options in ({"operation": "execute"}, {"factor": float("nan")}, {"factor": 3}, {"factor": True},
                        {"factor": 10**1000}, {"element_start": -1}, {"element_start": True},
                        {"element_count": 0}, {"element_count": 5}, {"element_start": 3, "element_count": 2}):
            with self.subTest(options=str(options)[:80]):
                with self.assertRaises(GGUFError):
                    self.plan(**options)

    def test_source_stat_change_rejected_before_copy(self):
        plan = self.plan()
        self.source.write_bytes(self.source.read_bytes() + b"x")
        with self.assertRaisesRegex(GGUFError, "changed"):
            apply_plan(plan, self.output, self.logs)
        self.assertFalse(self.output.exists())

    def test_same_stat_different_content_rejected_by_hash(self):
        plan = self.plan(factor=0.5)
        original_stat = self.source.stat()
        raw = bytearray(self.source.read_bytes())
        raw[-1] ^= 1
        self.source.write_bytes(raw)
        os.utime(self.source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        with self.assertRaisesRegex(GGUFError, "SHA256"):
            apply_plan(plan, self.output, self.logs)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_tampered_range_plan_rejected(self):
        plan = self.plan()
        plan["edit"]["byte_start"] = 0
        with self.assertRaisesRegex(GGUFError, "inconsistent"):
            apply_plan(plan, self.output, self.logs)

    def test_overflow_cleans_only_owned_candidate(self):
        fixture(self.source, [65504, 1], typ=1)
        self.output.mkdir()
        marker = self.output / "unrelated.txt"
        marker.write_text("preserve")
        with self.assertRaisesRegex(GGUFError, "finite F16"):
            apply_plan(self.plan(factor=2), self.output, self.logs)
        self.assertEqual([p.name for p in self.output.iterdir()], ["unrelated.txt"])
        self.assertEqual(marker.read_text(), "preserve")

    def test_nonfinite_scale_rejected_but_zero_is_explicit(self):
        fixture(self.source, [float("nan"), 1])
        with self.assertRaisesRegex(GGUFError, "non-finite"):
            apply_plan(self.plan(factor=0.5), self.output, self.logs)
        result = apply_plan(self.plan(operation="zero"), self.output, self.logs)
        self.assertEqual(sample_tensor(result["output"]["path"], self.tensor)["values"], [0, 0])

    def test_copy_across_many_chunks(self):
        fixture(self.source, list(range(100)))
        with patch("viewer.experiments.CHUNK_BYTES", 32):
            result = apply_plan(self.plan(factor=0.5, element_start=3, element_count=90), self.output, self.logs)
        values = sample_tensor(result["output"]["path"], self.tensor)["values"]
        self.assertEqual(values, [x * 0.5 if 3 <= x < 93 else x for x in range(100)])

    def test_existing_destination_never_overwritten(self):
        plan = self.plan()
        self.output.mkdir()
        suffix = "a" * 32
        existing = self.output / f"source-atlas-{suffix}.gguf"
        existing.write_bytes(b"keep existing")
        with patch("viewer.experiments.uuid.uuid4", return_value=SimpleNamespace(hex=suffix)):
            with self.assertRaisesRegex(GGUFError, "must be new"):
                apply_plan(plan, self.output, self.logs)
        self.assertEqual(existing.read_bytes(), b"keep existing")

    def test_disk_preflight_before_copy(self):
        with patch("viewer.experiments.shutil.disk_usage", return_value=SimpleNamespace(free=0)):
            with self.assertRaisesRegex(GGUFError, "disk space"):
                apply_plan(self.plan(), self.output, self.logs)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_failed_manifest_cleans_published_candidate(self):
        plan = self.plan(factor=0.5)
        original_open = Path.open
        def intercept(path, mode="r", *args, **kwargs):
            if mode == "x":
                raise OSError("simulated manifest failure")
            return original_open(path, mode, *args, **kwargs)
        with patch.object(Path, "open", intercept):
            with self.assertRaisesRegex(OSError, "manifest failure"):
                apply_plan(plan, self.output, self.logs)
        self.assertEqual(list(self.output.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
