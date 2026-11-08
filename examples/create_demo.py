"""Create a deterministic synthetic GGUF for UI exploration, not inference."""
from pathlib import Path
import argparse
import math
import random
import struct


def create_demo(path):
    path = Path(path)
    rng = random.Random(42)
    tensors = []
    for layer in range(8):
        for role, shape in [('attn_q', (64, 64)), ('attn_k', (64, 64)),
                            ('attn_v', (64, 64)), ('ffn_up', (64, 128)),
                            ('ffn_down', (128, 64)), ('attn_norm', (64,))]:
            count = math.prod(shape)
            values = [rng.gauss(0, .035 + layer * .003) + .018 * math.sin(i / (7 + layer))
                      for i in range(count)]
            if len(shape) > 1:
                values[(layer * 173 + 97) % count] = .32 + .02 * layer
                values[(layer * 119 + 701) % count] = -.28 - .015 * layer
            tensors.append((f'blk.{layer}.{role}.weight', shape, struct.pack(f'<{count}f', *values)))
    for name in ['token_embd.weight', 'output.weight']:
        values = [rng.gauss(0, .04) for _ in range(4096)]
        tensors.append((name, (64, 64), struct.pack('<4096f', *values)))
    def string(value):
        encoded = value.encode('utf-8')
        return struct.pack('<Q', len(encoded)) + encoded
    metadata = [('general.architecture', 8, 'llama'),
                ('general.name', 8, 'Atlas demo - SYNTHETIC, not an inference model'),
                ('general.description', 8, 'Deterministic generated weights for visualization; no trained model or tokenizer.'),
                ('llama.block_count', 4, 8), ('llama.embedding_length', 4, 64)]
    header = b'GGUF' + struct.pack('<IQQ', 3, len(tensors), len(metadata))
    for key, kind, value in metadata:
        header += string(key) + struct.pack('<I', kind)
        header += string(value) if kind == 8 else struct.pack('<I', value)
    payload = bytearray()
    for name, shape, raw in tensors:
        header += string(name) + struct.pack('<I', len(shape))
        header += struct.pack('<' + 'Q' * len(shape), *shape) + struct.pack('<IQ', 0, len(payload))
        payload += raw
        payload += b'\0' * (-len(payload) % 32)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Never silently replace a user's existing file.
    with path.open('xb') as stream:
        stream.write(header + b'\0' * (-len(header) % 32) + payload)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='New file to create; refuses to overwrite')
    args = parser.parse_args()
    path = create_demo(args.output)
    print(f'Created synthetic visualization fixture: {path} ({path.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
