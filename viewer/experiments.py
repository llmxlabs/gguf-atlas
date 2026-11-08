"""Typed GGUF experiments: review a hash-bound plan, write and verify a new copy.

Only F32/F16/BF16 scale/zero edits are supported. No execution of model text,
quantized requantization, in-place write, runtime launch, or production switch.
The HTTP layer owns plan storage/approval and must not accept client plan dicts.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import time
import uuid

from .gguf_core import GGUFError, inspect_model

PLAN_VERSION = "1.0"
CHUNK_BYTES = 1024 * 1024
SUPPORTED_TYPES = {"F32": (0, 4), "F16": (1, 2), "BF16": (30, 2)}


def _utc():
    return datetime.now(timezone.utc).isoformat()


def _identity(path):
    stat = path.stat()
    return {"size_bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns,
            "device": stat.st_dev, "inode": stat.st_ino}


def _hash_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def _check_identity(path, expected):
    if _identity(path) != {key: expected[key] for key in ("size_bytes", "mtime_ns", "device", "inode")}:
        raise GGUFError("Source changed since the reviewed plan; create a new plan")


def _edit_spec(tensor, operation, factor, element_start, element_count):
    if tensor["type"] not in SUPPORTED_TYPES:
        raise GGUFError(f"Editing {tensor['type']} is unsupported; select an F32, F16, or BF16 tensor")
    if operation not in ("scale", "zero"):
        raise GGUFError("Operation must be scale or zero")
    if type(element_start) is not int or element_start < 0:
        raise GGUFError("element_start must be a non-negative integer")
    total = tensor["parameter_count"]
    if element_count is None:
        element_count = total - element_start
    if type(element_count) is not int or element_count < 1 or element_start + element_count > total:
        raise GGUFError("Element range must contain at least one value and stay inside the tensor")
    if operation == "scale":
        if type(factor) not in (float, int) or not -2 <= factor <= 2 or not math.isfinite(factor):
            raise GGUFError("Scale factor must be a finite number between -2 and 2")
        factor = float(factor)
    else:
        factor = None
    width = SUPPORTED_TYPES[tensor["type"]][1]
    return {"operation": operation, "factor": factor, "element_start": element_start,
            "element_count": element_count, "byte_start": tensor["absolute_offset"] + element_start * width,
            "byte_count": element_count * width, "element_bytes": width,
            "range_order": "Flat GGUF storage order, dimension 0 contiguous; end exclusive",
            "element_end": element_start + element_count}


def create_plan(path, tensor_name, operation, factor=1.0, element_start=0, element_count=None):
    """Inspect and hash source; create a reviewable plan without creating a candidate."""
    started = time.perf_counter()
    path = Path(path).resolve(strict=True)
    before = _identity(path)
    model = inspect_model(path)
    if model["metadata"].get("split.count", 1) != 1:
        raise GGUFError("Split GGUF editing is unsupported; select a single-file model")
    tensor = next((t for t in model["tensors"] if t["name"] == tensor_name), None)
    if tensor is None:
        raise GGUFError("Tensor not found in source GGUF")
    edit = _edit_spec(tensor, operation, factor, element_start, element_count)
    digest = _hash_file(path)
    _check_identity(path, before)
    return {"schema_version": PLAN_VERSION, "plan_id": uuid.uuid4().hex, "created_at": _utc(),
            "status": "awaiting_review", "source": {"path": str(path), "name": path.name, **before, "sha256": digest},
            "tensor": {key: tensor[key] for key in ("name", "type", "type_id", "shape", "absolute_offset", "parameter_count", "bytes")},
            "endianness": model["file"]["endianness"], "edit": edit,
            "required_copy_bytes": before["size_bytes"], "planning_seconds": time.perf_counter() - started,
            "effects": ["Creates a separate full GGUF copy; original remains unchanged.",
                        "Changes only the reviewed element range in one tensor; shape, metadata, and other bytes stay identical.",
                        "Candidate is structurally checked and hashed, but model behavior and quality remain untested.",
                        "No inference service is started or switched."],
            "limitations": ["Editing quantized tensors and split shards is unsupported.",
                            "F16 and BF16 results round to their native precision; overflowing scale results are rejected.",
                            "No architecture change, tuning benefit, or preserved model quality is implied."]}


def _transform(raw, tensor_type, endian, edit):
    if edit["operation"] == "zero":
        return bytes(len(raw))
    prefix = "<" if endian == "little" else ">"
    factor = edit["factor"]
    width = SUPPORTED_TYPES[tensor_type][1]
    output = bytearray(len(raw))
    for offset in range(0, len(raw), width):
        if tensor_type == "BF16":
            bits = struct.unpack_from(prefix + "H", raw, offset)[0] << 16
            value = struct.unpack("<f", struct.pack("<I", bits))[0]
        else:
            value = struct.unpack_from(prefix + ("f" if tensor_type == "F32" else "e"), raw, offset)[0]
        scaled = value * factor
        if not math.isfinite(value) or not math.isfinite(scaled):
            raise GGUFError("Selected values contain non-finite data or scale results; candidate rejected")
        try:
            if tensor_type == "BF16":
                bits = struct.unpack("<I", struct.pack("<f", scaled))[0]
                # IEEE nearest-even BF16 rounding, matching upstream's finite path.
                rounded = (bits + 0x7FFF + ((bits >> 16) & 1)) >> 16
                if rounded & 0x7F80 == 0x7F80:
                    raise OverflowError("BF16 overflow")
                struct.pack_into(prefix + "H", output, offset, rounded)
            else:
                struct.pack_into(prefix + ("f" if tensor_type == "F32" else "e"), output, offset, scaled)
        except (OverflowError, struct.error) as error:
            raise GGUFError(f"Scale result exceeds finite {tensor_type} range; candidate rejected") from error
    return bytes(output)


def _patch_block(raw, offset, plan):
    edit = plan["edit"]
    left = max(offset, edit["byte_start"])
    right = min(offset + len(raw), edit["byte_start"] + edit["byte_count"])
    if right <= left:
        return raw, 0, 0
    begin, end = left - offset, right - offset
    before = raw[begin:end]
    after = _transform(before, plan["tensor"]["type"], plan["endianness"], edit)
    width = edit["element_bytes"]
    changed_bytes = sum(a != b for a, b in zip(before, after))
    changed_elements = sum(before[i:i + width] != after[i:i + width] for i in range(0, len(before), width))
    return raw[:begin] + after + raw[end:], changed_bytes, changed_elements


def apply_plan(plan, output_root, log_root):
    """Apply a trusted server-stored plan to a unique new copy and verify every byte.

    output_root/log_root are server configuration, never model/client-supplied.
    Parent owns the explicit review confirmation and only dispatches plan IDs.
    Full files are streamed in 1 MiB chunks; no GPU or model runtime is used.
    """
    started = time.perf_counter()
    # Detach from callers modifying shared in-memory state during the job.
    plan = json.loads(json.dumps(plan, allow_nan=False))
    if plan.get("schema_version") != PLAN_VERSION or not re.fullmatch(r"[0-9a-f]{32}", plan.get("plan_id", "")):
        raise GGUFError("Invalid experiment plan")
    source = Path(plan["source"]["path"]).resolve(strict=True)
    if str(source) != plan["source"]["path"]:
        raise GGUFError("Source path changed since planning")
    _check_identity(source, plan["source"])
    model = inspect_model(source)
    tensor = next((t for t in model["tensors"] if t["name"] == plan["tensor"]["name"]), None)
    if tensor is None or any(tensor[k] != v for k, v in plan["tensor"].items()):
        raise GGUFError("Tensor structure changed since planning")
    if model["file"]["endianness"] != plan["endianness"]:
        raise GGUFError("Source endianness changed since planning")
    edit = plan["edit"]
    if _edit_spec(tensor, edit["operation"], edit["factor"], edit["element_start"], edit["element_count"]) != edit:
        raise GGUFError("Experiment plan edit fields are inconsistent")
    output_root, log_root = Path(output_root).resolve(), Path(log_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    log_root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(output_root).free < plan["source"]["size_bytes"] + CHUNK_BYTES:
        raise GGUFError("Insufficient disk space for a full candidate GGUF copy")
    suffix = uuid.uuid4().hex
    stem = re.sub(r"[^a-zA-Z0-9._-]", "_", source.stem)[:72] or "model"
    final = output_root / f"{stem}-atlas-{suffix}.gguf"
    partial = output_root / f".{stem}-atlas-{suffix}.partial"
    manifest = log_root / f"{suffix}-experiment.json"
    if source == final or source == partial or final.exists() or partial.exists() or manifest.exists():
        raise GGUFError("Candidate destination must be new and different from source")
    owned_partial = owned_final = owned_manifest = False
    changed_bytes = changed_elements = 0
    try:
        source_digest, expected_digest = hashlib.sha256(), hashlib.sha256()
        with source.open("rb") as input_stream, partial.open("xb") as output_stream:
            owned_partial = True
            offset = 0
            for raw in iter(lambda: input_stream.read(CHUNK_BYTES), b""):
                source_digest.update(raw)
                patched, nbytes, nelements = _patch_block(raw, offset, plan)
                output_stream.write(patched)
                expected_digest.update(patched)
                changed_bytes += nbytes
                changed_elements += nelements
                offset += len(raw)
            output_stream.flush()
            os.fsync(output_stream.fileno())
        if offset != plan["source"]["size_bytes"] or source_digest.hexdigest() != plan["source"]["sha256"]:
            raise GGUFError("Source content differs from reviewed SHA256; candidate rejected")
        _check_identity(source, plan["source"])
        candidate_model = inspect_model(partial)
        if candidate_model["metadata"] != model["metadata"] or candidate_model["tensors"] != model["tensors"]:
            raise GGUFError("Candidate structure differs unexpectedly from source")
        # Read both files back, recompute expected bytes, and verify source again.
        verified_source, verified_output = hashlib.sha256(), hashlib.sha256()
        with source.open("rb") as original, partial.open("rb") as candidate:
            offset = 0
            while True:
                raw = original.read(CHUNK_BYTES)
                actual = candidate.read(CHUNK_BYTES)
                if not raw and not actual:
                    break
                expected, _, _ = _patch_block(raw, offset, plan)
                if actual != expected:
                    raise GGUFError("Candidate byte verification failed; candidate rejected")
                verified_source.update(raw)
                verified_output.update(actual)
                offset += len(raw)
        _check_identity(source, plan["source"])
        if verified_source.hexdigest() != plan["source"]["sha256"] or verified_output.hexdigest() != expected_digest.hexdigest():
            raise GGUFError("Source or candidate changed during verification; candidate rejected")
        # Hard-link publication is exclusive on both NTFS and POSIX: no overwrite,
        # no second multi-gigabyte copy, and partial files never appear as GGUFs.
        os.link(partial, final)
        owned_final = True
        partial.unlink()
        owned_partial = False
        result = {"schema_version": PLAN_VERSION, "experiment_id": suffix, "plan_id": plan["plan_id"],
                  "status": "ready_for_evaluation", "created_at": _utc(), "source": plan["source"],
                  "output": {"path": str(final), "name": final.name, "size_bytes": final.stat().st_size,
                             "sha256": verified_output.hexdigest()},
                  "tensor": plan["tensor"], "edit": edit, "changed_bytes": changed_bytes,
                  "changed_elements": changed_elements, "unchanged_outside_edit": True,
                  "source_hash_verified_after_copy": True, "structure_validated": True,
                  "behavior_tested": False, "runtime_switched": False,
                  "duration_seconds": time.perf_counter() - started, "manifest_path": str(manifest),
                  "errors": [], "plan": plan}
        with manifest.open("x", encoding="utf-8") as stream:
            owned_manifest = True
            json.dump(result, stream, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        return result
    except BaseException as error:
        # Only files successfully created by this call may be removed.
        cleanup_failures = []
        for path, owned in ((manifest, owned_manifest), (final, owned_final), (partial, owned_partial)):
            if owned:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    cleanup_failures.append(str(path))
        if cleanup_failures:
            raise GGUFError("Experiment failed and cleanup could not remove owned incomplete files: " + ", ".join(cleanup_failures)) from error
        raise
