"""Bounded, read-only GGUF inspection. No model runtime or GPU dependency.

Layout reference: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
Type sizes and quant packing checked 2026-11-07 against llama.cpp gguf-py,
revision 80d2c0c2c56e4a1bbf74be98f64b99927bf230bc:
https://github.com/ggml-org/llama.cpp/blob/master/gguf-py/gguf/constants.py
https://github.com/ggml-org/llama.cpp/blob/master/gguf-py/gguf/quants.py
Shapes retain GGUF order (dimension 0 is contiguous), not NumPy order.
"""
from __future__ import annotations

import math
from pathlib import Path
import re
import struct

SCHEMA_VERSION = "1.0"
KINDS = {0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i", 6: "f", 7: "?", 10: "Q", 11: "q", 12: "d"}
# id: (name, number of elements per encoded block, bytes per encoded block)
QUANT_TYPES = {
    0: ("F32", 1, 4), 1: ("F16", 1, 2), 2: ("Q4_0", 32, 18), 3: ("Q4_1", 32, 20),
    6: ("Q5_0", 32, 22), 7: ("Q5_1", 32, 24), 8: ("Q8_0", 32, 34), 9: ("Q8_1", 32, 36),
    10: ("Q2_K", 256, 84), 11: ("Q3_K", 256, 110), 12: ("Q4_K", 256, 144),
    13: ("Q5_K", 256, 176), 14: ("Q6_K", 256, 210), 15: ("Q8_K", 256, 292),
    16: ("IQ2_XXS", 256, 66), 17: ("IQ2_XS", 256, 74), 18: ("IQ3_XXS", 256, 98),
    19: ("IQ1_S", 256, 50), 20: ("IQ4_NL", 32, 18), 21: ("IQ3_S", 256, 110),
    22: ("IQ2_S", 256, 82), 23: ("IQ4_XS", 256, 136), 24: ("I8", 1, 1),
    25: ("I16", 1, 2), 26: ("I32", 1, 4), 27: ("I64", 1, 8), 28: ("F64", 1, 8),
    29: ("IQ1_M", 256, 56), 30: ("BF16", 1, 2), 34: ("TQ1_0", 256, 54),
    35: ("TQ2_0", 256, 66), 39: ("MXFP4", 32, 17), 40: ("NVFP4", 64, 36),
    41: ("Q1_0", 128, 18), 42: ("Q2_0", 64, 18), 43: ("F8_E4M3", 1, 1),
}
SUPPORTED_SAMPLE_TYPES = frozenset([0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 24, 25, 26, 27, 28, 30])


class GGUFError(ValueError):
    """Malformed or unsupported GGUF input, safe for a user-facing error."""


class _Reader:
    def __init__(self, f, size):
        self.f, self.size, self.endian = f, size, "<"
        self.item_budget = 8_000_000
        self.retained_budget = 16 * 1024 * 1024

    def read(self, count):
        if self.f.tell() + count > 256 * 1024 * 1024:
            raise GGUFError("GGUF header exceeds 256 MiB inspection limit")
        if count < 0 or count > self.size - self.f.tell():
            raise GGUFError("Truncated GGUF or out-of-bounds length")
        value = self.f.read(count)
        if len(value) != count:
            raise GGUFError("GGUF changed or was truncated while reading")
        return value

    def skip(self, count):
        if self.f.tell() + count > 256 * 1024 * 1024:
            raise GGUFError("GGUF header exceeds 256 MiB inspection limit")
        if count < 0 or count > self.size - self.f.tell():
            raise GGUFError("Truncated GGUF or out-of-bounds length")
        self.f.seek(count, 1)

    def number(self, fmt):
        return struct.unpack(self.endian + fmt, self.read(struct.calcsize(fmt)))[0]

    def string(self, limit=16_384, preview=True):
        size = self.number("Q")
        if not preview and size > limit:
            raise GGUFError("GGUF key or tensor name exceeds inspection limit")
        retained = min(size, limit)
        self.retained_budget -= retained
        if self.retained_budget < 0:
            raise GGUFError("GGUF text exceeds 16 MiB retained inspection budget")
        raw = self.read(retained)
        self.skip(size - len(raw))
        value = raw.decode("utf-8", errors="replace")
        return {"preview": value, "byte_length": size, "truncated": True} if size > limit else value

    def value(self, kind, retain=True):
        self.item_budget -= 1
        if self.item_budget < 0:
            raise GGUFError("Metadata exceeds bounded inspection item budget")
        if kind == 7:
            value = self.number("B")
            if value not in (0, 1):
                raise GGUFError("Invalid GGUF boolean value")
            return bool(value)
        if kind in KINDS:
            value = self.number(KINDS[kind])
            return value if not isinstance(value, float) or math.isfinite(value) else str(value)
        if kind == 8:
            return self.string(limit=16_384 if retain else 0)
        if kind != 9:
            raise GGUFError(f"Unknown metadata value type {kind}")
        subtype, count = self.number("I"), self.number("Q")
        if subtype == 9 or subtype not in {*KINDS, 8}:
            raise GGUFError("Invalid or nested GGUF metadata array type")
        if count > 4_000_000 or count > self.item_budget:
            raise GGUFError("Metadata array exceeds bounded inspection limit")
        keep = min(count, 16)
        values = [self.value(subtype) for _ in range(keep)]
        if subtype == 7:
            remaining = count - keep
            while remaining:
                chunk = self.read(min(remaining, 65_536))
                if any(v not in (0, 1) for v in chunk):
                    raise GGUFError("Invalid GGUF boolean value in array")
                remaining -= len(chunk)
            self.item_budget -= count - keep
        elif subtype in KINDS:
            self.skip((count - keep) * struct.calcsize(KINDS[subtype]))
            self.item_budget -= count - keep
        else:
            for _ in range(count - keep):
                self.value(subtype, retain=False)
        return values if count <= 16 else {"count": count, "preview": values, "truncated": True, "element_type": subtype}


def _role(name):
    if "token_embd" in name or "embed_tokens" in name:
        return "embedding"
    if "norm" in name:
        return "normalization"
    if "ssm" in name:
        return "state_space"
    if "attn" in name:
        return "attention"
    if "exp" in name or "expert" in name:
        return "experts"
    if "ffn" in name:
        return "feed_forward"
    if "output" in name:
        return "output"
    return "other"


def inspect_model(path):
    """Read directory and bounded metadata previews without reading tensor payloads."""
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise GGUFError("Expected a regular GGUF file")
    size = path.stat().st_size
    warnings = ["Architecture grouping and tensor roles are inferred from metadata and names; this is not an executable computation graph.",
                "Parameter count is stored tensor elements in this file, including auxiliary tensors; it is not active MoE parameters."]
    with path.open("rb") as f:
        r = _Reader(f, size)
        magic = r.read(4)
        if magic not in (b"GGUF", b"FUGG"):
            raise GGUFError("Not a GGUF file (magic mismatch)")
        version_raw = r.read(4)
        little = struct.unpack("<I", version_raw)[0]
        big = struct.unpack(">I", version_raw)[0]
        if little in (2, 3):
            version = little
        elif big in (2, 3):
            version, r.endian = big, ">"
        else:
            raise GGUFError(f"Unsupported GGUF version {little}; viewer accepts v2 and v3")
        if version == 2 and r.endian == ">":
            raise GGUFError("Big-endian GGUF requires version 3")
        tensor_count, metadata_count = r.number("Q"), r.number("Q")
        if tensor_count > 200_000 or metadata_count > 100_000:
            raise GGUFError("GGUF directory exceeds bounded inspection limits")
        metadata = {}
        for _ in range(metadata_count):
            key = r.string(limit=65_535, preview=False)
            if key in metadata:
                raise GGUFError(f"Duplicate metadata key: {key}")
            metadata[key] = r.value(r.number("I"))
        alignment = metadata.get("general.alignment", 32)
        if type(alignment) is not int or not 1 <= alignment <= 1_048_576 or alignment & (alignment - 1):
            raise GGUFError("Invalid GGUF data alignment (expected bounded power of two)")
        tensors, names = [], set()
        for index in range(tensor_count):
            name = r.string(limit=65_535, preview=False)
            if name in names:
                raise GGUFError(f"Duplicate tensor name: {name}")
            names.add(name)
            dims = r.number("I")
            if not 1 <= dims <= 4:
                raise GGUFError(f"Invalid tensor dimension count: {dims}")
            shape = [r.number("Q") for _ in range(dims)]
            if any(d == 0 or d > 2**40 for d in shape) or math.prod(shape) > 2**63 - 1:
                raise GGUFError(f"Invalid tensor shape: {name}")
            type_id, offset = r.number("I"), r.number("Q")
            if offset % alignment:
                raise GGUFError(f"Unaligned tensor offset: {name}")
            n = math.prod(shape)
            kind = QUANT_TYPES.get(type_id)
            nbytes = None
            if kind:
                if shape[0] % kind[1]:
                    raise GGUFError(f"Tensor row is not divisible by {kind[0]} block size: {name}")
                nbytes = n // kind[1] * kind[2]
            match = re.search(r"(?:^|\.)blk\.(\d+)\.", name)
            tensors.append({"index": index, "name": name, "shape": shape, "type": kind[0] if kind else f"UNKNOWN_{type_id}",
                            "type_id": type_id, "parameter_count": n, "bytes": nbytes, "offset": offset,
                            "layer": int(match.group(1)) if match else None, "role": _role(name),
                            "sample_supported": type_id in SUPPORTED_SAMPLE_TYPES and (r.endian == "<" or kind[1] == 1)})
        header_end = f.tell()
        if header_end > 256 * 1024 * 1024:
            raise GGUFError("GGUF header exceeds 256 MiB inspection limit")
        data_offset = (header_end + alignment - 1) // alignment * alignment
        if tensors and data_offset > size:
            raise GGUFError("Missing aligned GGUF tensor data")
        ordered = sorted(tensors, key=lambda t: t["offset"])
        for i, tensor in enumerate(ordered):
            start = data_offset + tensor["offset"]
            next_start = data_offset + ordered[i + 1]["offset"] if i + 1 < len(ordered) else size
            if start > size or next_start < start or (tensor["bytes"] is not None and start + tensor["bytes"] > next_start):
                raise GGUFError(f"Truncated or overlapping tensor data: {tensor['name']}")
            tensor["absolute_offset"] = start
            tensor["stored_span_bytes"] = next_start - start
        endian = "little" if r.endian == "<" else "big"
    quant = {}
    layers = {}
    for t in tensors:
        q = quant.setdefault(t["type"], {"type": t["type"], "tensor_count": 0, "parameter_count": 0, "bytes": 0})
        q["tensor_count"] += 1
        q["parameter_count"] += t["parameter_count"]
        q["bytes"] = q["bytes"] + t["bytes"] if q["bytes"] is not None and t["bytes"] is not None else None
        if t["layer"] is not None:
            l = layers.setdefault(t["layer"], {"index": t["layer"], "name": f"Block {t['layer']}", "tensor_count": 0, "parameter_count": 0, "bytes": 0, "types": set()})
            l["tensor_count"] += 1
            l["parameter_count"] += t["parameter_count"]
            l["bytes"] = l["bytes"] + t["bytes"] if l["bytes"] is not None and t["bytes"] is not None else None
            l["types"].add(t["type"])
    for layer in layers.values():
        layer["types"] = sorted(layer["types"])
    arch_name = metadata.get("general.architecture", "unknown")
    if not isinstance(arch_name, str):
        arch_name = "unknown"
    architecture = {"name": arch_name}
    keys = {"block_count": "block_count", "embedding_length": "embedding_length", "context_length": "context_length",
            "head_count": "attention.head_count", "head_count_kv": "attention.head_count_kv", "expert_count": "expert_count",
            "expert_used_count": "expert_used_count", "feed_forward_length": "feed_forward_length", "vocab_size": "vocab_size",
            "key_length": "attention.key_length", "value_length": "attention.value_length", "full_attention_interval": "full_attention_interval",
            "nextn_predict_layers": "nextn_predict_layers", "rope_frequency_base": "rope.freq_base"}
    architecture.update({k: metadata.get(f"{arch_name}.{v}") for k, v in keys.items()})
    if metadata.get("split.count", 1) != 1:
        warnings.append("This is a split GGUF shard. Counts and tensors cover this file only, not the complete model.")
    unknown = [q["type"] for q in quant.values() if q["bytes"] is None]
    if unknown:
        warnings.append("Unknown tensor encoding sizes: " + ", ".join(unknown) + ". Byte totals are incomplete.")
    nbytes = sum(t["bytes"] or 0 for t in tensors)
    return {"schema_version": SCHEMA_VERSION, "file": {"path": str(path), "name": path.name, "size_bytes": size, "version": version,
            "endianness": endian, "data_offset": data_offset, "alignment": alignment}, "metadata": metadata,
            "architecture": architecture, "summary": {"tensor_count": tensor_count, "parameter_count": sum(t["parameter_count"] for t in tensors),
            "tensor_bytes": None if unknown else nbytes, "known_tensor_bytes": nbytes, "quantization": sorted(quant.values(), key=lambda q: q["parameter_count"], reverse=True)},
            "layers": [layers[k] for k in sorted(layers)], "tensors": tensors, "warnings": warnings}


def _decode_block(raw, type_id, endian="<"):
    scalar = {0: "f", 1: "e", 24: "b", 25: "h", 26: "i", 27: "q", 28: "d"}
    if type_id in scalar:
        return [float(struct.unpack(endian + scalar[type_id], raw)[0])]
    if type_id == 30:
        bits = struct.unpack(endian + "H", raw)[0] << 16
        return [struct.unpack("<f", struct.pack("<I", bits))[0]]
    half = lambda offset: struct.unpack_from("<e", raw, offset)[0]
    if type_id in (8, 9, 15):
        d = struct.unpack_from("<f", raw)[0] if type_id == 15 else half(0)
        offset = 4 if type_id in (9, 15) else 2
        count = 256 if type_id == 15 else 32
        return [d * x for x in struct.unpack_from(f"{count}b", raw, offset)]
    if type_id in (2, 3, 6, 7, 20):
        d, m = half(0), half(2) if type_id in (3, 7) else 0.0
        offset = 4 if type_id in (3, 7) else 2
        high = int.from_bytes(raw[offset:offset + 4], "little") if type_id in (6, 7) else 0
        offset += 4 if type_id in (6, 7) else 0
        grid = [-127, -104, -83, -65, -49, -35, -22, -10, 1, 13, 25, 38, 53, 69, 89, 113]
        out = []
        for j in range(32):
            value = (raw[offset + j % 16] >> (4 * (j // 16))) & 15
            value |= ((high >> j) & 1) << 4
            value = grid[value] if type_id == 20 else value - (8 if type_id == 2 else 16 if type_id == 6 else 0)
            out.append(d * value + m)
        return out
    if type_id == 10:
        d, dm = half(80), half(82)
        return [d * (raw[j // 16] & 15) * ((raw[16 + (j // 128) * 32 + j % 32] >> (2 * ((j % 128) // 32))) & 3)
                - dm * (raw[j // 16] >> 4) for j in range(256)]
    if type_id == 11:
        d, out = half(108), []
        for j in range(256):
            group = j // 16
            scale = ((raw[96 + group % 8] >> (4 * (group // 8))) & 15) | (((raw[104 + group % 4] >> (2 * (group // 4))) & 3) << 4)
            low = (raw[32 + (j // 128) * 32 + j % 32] >> (2 * ((j % 128) // 32))) & 3
            high = (raw[j % 32] >> (j // 32)) & 1
            out.append(d * (scale - 32) * (low - 4 * (1 - high)))
        return out
    if type_id in (12, 13):
        d, dm, scales, out = half(0), half(2), raw[4:16], []
        for j in range(256):
            group = j // 32
            if group < 4:
                scale, minimum = scales[group] & 63, scales[group + 4] & 63
            else:
                scale = (scales[group + 4] & 15) | ((scales[group - 4] >> 6) << 4)
                minimum = (scales[group + 4] >> 4) | ((scales[group] >> 6) << 4)
            offset = 48 if type_id == 13 else 16
            q = (raw[offset + (j // 64) * 32 + j % 32] >> (4 * ((j % 64) // 32))) & 15
            if type_id == 13:
                q |= ((raw[16 + j % 32] >> group) & 1) << 4
            out.append(d * scale * q - dm * minimum)
        return out
    if type_id == 14:
        d, out = half(208), []
        for j in range(256):
            low = (raw[(j // 128) * 64 + j % 64] >> (4 * ((j % 128) // 64))) & 15
            high = (raw[128 + (j // 128) * 32 + j % 32] >> (2 * ((j % 128) // 32))) & 3
            scale = raw[192 + j // 16]
            scale = scale - 256 if scale >= 128 else scale
            out.append(d * scale * ((low | (high << 4)) - 32))
        return out
    raise GGUFError("Unsupported sampled encoding")


def sample_tensor(path, tensor_name, max_values=4096, *, inspection=None):
    """Decode a prefix; statistics describe the sample, not the full tensor.

    inspection is an optional trusted server-side inspect_model cache entry, never
    client JSON. The caller must invalidate its cache when the file stat changes.
    """
    if type(max_values) is not int or not 1 <= max_values <= 16_384:
        raise GGUFError("max_values must be an integer from 1 to 16384")
    if inspection is None:
        model = inspect_model(path)
    else:
        resolved = Path(path).resolve(strict=True)
        if Path(inspection["file"]["path"]) != resolved or inspection.get("schema_version") != SCHEMA_VERSION:
            raise GGUFError("Cached inspection does not match the requested file")
        if resolved.stat().st_size != inspection["file"]["size_bytes"]:
            raise GGUFError("GGUF changed since cached inspection")
        model = inspection
    tensor = next((t for t in model["tensors"] if t["name"] == tensor_name), None)
    if tensor is None:
        raise GGUFError(f"Tensor not found: {tensor_name}")
    result = {"schema_version": SCHEMA_VERSION, "name": tensor_name, "type": tensor["type"], "shape": tensor["shape"],
              "supported": tensor["sample_supported"], "values": [], "sample_shape": [], "stats": None, "histogram": [],
              "sampling": "Contiguous prefix in GGUF storage order; sample statistics do not describe the entire tensor. Heatmap rows wrap at 64 values and are not tensor axes."}
    if not result["supported"]:
        result["reason"] = ("Packed big-endian tensor sampling is not implemented." if model["file"]["endianness"] == "big" else
                            f"Value decoding for {tensor['type']} is not implemented; directory and encoded byte counts remain available.")
        return result
    count = min(max_values, tensor["parameter_count"])
    _, block_elements, block_bytes = QUANT_TYPES[tensor["type_id"]]
    nblocks = (count + block_elements - 1) // block_elements
    endian = "<" if model["file"]["endianness"] == "little" else ">"
    with Path(model["file"]["path"]).open("rb") as f:
        f.seek(tensor["absolute_offset"])
        raw = f.read(nblocks * block_bytes)
    if len(raw) != nblocks * block_bytes:
        raise GGUFError("Tensor file changed or was truncated while sampling")
    values = []
    for offset in range(0, len(raw), block_bytes):
        values.extend(_decode_block(raw[offset:offset + block_bytes], tensor["type_id"], endian))
    values = values[:count]
    finite = [v for v in values if math.isfinite(v)]
    result["values"] = [v if math.isfinite(v) else None for v in values]
    cols = min(64, count)
    result.update({"sample_shape": [math.ceil(count / cols), cols], "sample_count": count,
                   "total_count": tensor["parameter_count"], "nonfinite_count": count - len(finite),
                   "bytes_read": len(raw), "start_element": 0})
    if finite:
        low, high = min(finite), max(finite)
        mean = math.fsum(v / len(finite) for v in finite)
        # Scaled variance avoids overflow from squaring a large finite F64.
        scale = max(abs(low), abs(high)) or 1.0
        std = math.sqrt(math.fsum(((v / scale) - (mean / scale)) ** 2 / len(finite) for v in finite)) * scale
        result["stats"] = {"min": low, "max": high, "mean": mean, "std": std if math.isfinite(std) else None,
                           "zero_fraction": sum(v == 0 for v in finite) / len(finite), "finite_count": len(finite)}
        if low == high:
            result["histogram"] = [{"min": low, "max": high, "count": len(finite)}]
        else:
            # Work in a normalized domain so high - low cannot overflow.
            lo, hi = low / scale, high / scale
            bins = [0] * 32
            for value in finite:
                index = min(31, max(0, int(((value / scale - lo) / (hi - lo)) * 32)))
                bins[index] += 1
            result["histogram"] = [{"min": (lo + (hi - lo) * i / 32) * scale,
                                     "max": (lo + (hi - lo) * (i + 1) / 32) * scale, "count": n} for i, n in enumerate(bins)]
    return result
