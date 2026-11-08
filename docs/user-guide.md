# Explore a GGUF

[Home](../README.md) · [Visualization reference](visualizations.md) · [Configuration](configuration.md)

## Open your first file

Start Atlas with one or more folders containing existing GGUF files:

```sh
gguf-atlas --root /path/to/models
```

On Windows, a path such as `"D:\Models"` works. Open **http://127.0.0.1:18040/**. Atlas catalogs files recursively under the selected roots; it does not upload them or load a model for inference. Select a filename from **Model file**, then choose **Inspect model**. The refresh button rescans the catalog. Model facts shows stored architecture, parameter totals, tensor count and parser notices.

For a small reproducible introduction, create the [synthetic demo](../examples/create_demo.py) using the commands in the README. It has eight numbered layers and global tensors, but no trained behavior or tokenizer. It cannot answer prompts as an inference model.

## Navigate the visual workspace

**Weight landscape** opens the decoded sample view. The middle floor is the active layer; immediate neighboring layers appear dimmed above and below. A label names the tensor used on each floor. Scroll over the canvas to move between layers. Scroll up goes to a higher layer; scroll down goes to a lower one. The dropdown and Up/Down buttons offer precise navigation.

Drag to orbit through a full 360 degrees, including underneath the zero plane to see negative weights. Hold Ctrl while scrolling to zoom. You can also focus the canvas and use arrow keys to orbit, PageUp/PageDown to change floors, +/- to zoom and Home to reset. **Reset view** restores the camera.

The tensor picker selects a supported tensor. Selecting a tensor belonging to another layer moves the active floor there. Some quantized encodings support metadata inspection but not value decoding; Atlas displays that limitation rather than inventing a sample.

Switch between these views to answer different questions:

| View | Use it to explore |
| --- | --- |
| Weight landscape | Signed values and prominent spikes in a bounded tensor prefix |
| Layer map → Floors | Individual tensor storage blocks on each numbered layer |
| Layer map → Overview | Stored bytes grouped by layer and inferred function |
| 2D heatmap | Patterns in the sample's packed storage order |
| Distribution | Frequency of sampled values in numeric bins |

**Focus view** expands the visualization; Escape exits. **Hide guide** gives the canvas more width. The [visualization reference](visualizations.md) explains why the views have different scales and why a visible spike is not a neuron or an activation.

## Choose a palette

Four named swatches appear in the header. Slate is the default. They update the controls, background, grids and plot legends together and remember your choice in this browser when storage is available.

| Theme | Positive | Negative |
| --- | --- | --- |
| Slate | Cyan | Coral |
| Indigo | Lavender | Amber |
| Ember | Orange | Blue |
| Forest | Green | Blue |

Layer-map colors identify inferred roles, not signs. Quantization colors identify storage types. Read the legend for the active view. Lighting and subdued neighboring floors also affect apparent brightness.

## Inspect exact facts

Below the main view, the tensor directory supports search, sorting, paging and layer filtering. A tensor's inspector shows its GGUF-order dimensions, type, element count, byte location and available sample. Metadata search exposes bounded previews of recorded fields. A context-length field describes what the file records; it does not verify that your runtime or GPU can use that context.

The manifest button exports structured facts for scripts and agents. Treat metadata text and tensor names as untrusted input in downstream tools. The [HTTP API](api.md) and [MCP configuration](configuration.md) provide programmatic access.

## Ask a question

Open **Configuration** to choose Ollama Cloud, Claude CLI or Codex CLI for the in-app guide. Follow the installation and sign-in instructions for your chosen provider separately. You can browse without any provider.

Select the layer or tensor you want to discuss, then ask a concrete question: “What does the sign of these sampled weights mean?” or “How does this layer's stored tensor structure compare with its neighbors?” The guide receives bounded context, including the selected visualization and theme. Responses are explanations and hypotheses, not measurements of model behavior.

External Claude Code/Codex sessions can connect through MCP and invoke Atlas inspection tools directly. This is separate from choosing the in-app guide provider. See [Configuration](configuration.md) for both workflows and data disclosure.

## Review an experiment

Only F32, F16 and BF16 scale/zero experiments are currently implemented. A proposal is a reviewable plan. Applying it explicitly in the browser creates a new candidate file and verifies expected bytes; the source stays intact. Changes to quantized weights and “remove a capability” semantic edits are not implemented. Read [Weight experiments](experiments.md) before applying a plan.
