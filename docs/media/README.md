# Gallery provenance

The gallery is captured from GGUF Atlas v0.3 using `examples/create_demo.py`, seed 42. The resulting 955,584-byte fixture contains 50 F32 tensors, eight numbered layers and two global tensors. No real model weights, user conversations or account identifiers are included.

| Asset | What it demonstrates |
| --- | --- |
| `landscape.jpg` | Layer 2 signed sample with named neighboring floors |
| `layers.jpg` | Layer 4 tensor blocks and inferred roles |
| `heatmap.jpg` | Packed prefix of the layer 4 attention tensor |
| `distribution.jpg` | Histogram for that sampled prefix |
| `configuration.jpg` | Three detected guide connections and saved provider controls |
| `atlas-tour.gif`, `atlas-tour.mp4` | Horizontal orbit, underside inspection, layer navigation, layer map, heatmap and distribution |

The tour is a paced sequence of 48 real browser captures, encoded with FFmpeg. Motion is sampled and playback timing is edited for readability; it is not a performance benchmark. The GIF is 960 pixels wide; MP4 and stills preserve the captured view at approximately 1280 pixels. There is no audio. The configuration screenshot shows a particular machine's successful CLI detection; availability elsewhere depends on compatible provider versions and separate sign-in.

To recreate the dataset, run the README's demo command. Capture the actual interface using ordinary controls; keep model names and paths visibly synthetic, and keep generated MCP paths or credentials out of public screenshots.
