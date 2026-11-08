# Testing and troubleshooting

[Project home](../README.md) · [Contributing](../CONTRIBUTING.md) · [Configuration](configuration.md) · [Architecture](architecture.md)

Routine tests use temporary synthetic GGUF files and mocked provider replies. They do not download weights, load an inference model, switch services, or consume cloud quota. Run the commands from the repository root.

## Offline checks

```sh
python -m pip install -e .
python -m unittest discover -s tests -p 'test_*.py' -v
node --check viewer/static/app.js
node --check viewer/static/guide.js
node --check viewer/static/topology.js
node tests/test_atlas_orbit.cjs
node tests/test_atlas_wheel.cjs
```

Python 3.11+ runs the application without third-party runtime dependencies. Node is needed for JavaScript validation only. The explicit `unittest discover -s tests` invocation places the test fixture modules on the discovery path; use that command rather than assuming every alternative test runner has equivalent import behavior.

| Test area | What it checks |
| --- | --- |
| [GGUF parser](../tests/test_gguf_core.py) | Synthetic headers, metadata/directory bounds, malformed inputs, scalar/quantized decoding, byte-order behavior, unknown types and sample semantics |
| [HTTP server](../tests/test_viewer_server.py) | Catalog scoping, exact sample values, manifest export, source preservation, Host/Origin checks, traversal rejection, and unsupported routes/methods |
| [Candidate writer](../tests/test_viewer_experiments.py) | Exact transformed ranges, unchanged source/outside bytes, source drift rejection, native-precision behavior, exclusive destination handling, disk failure and cleanup |
| [Workbench integration](../tests/test_viewer_workbench.py) | Retained plans, explicit confirmation, background jobs, idempotency, and HTTP/provider boundaries |
| [Assistant](../tests/test_viewer_assistant.py) | Compact context, privacy bounds, provider filtering, rejected tool operations, selection/view meaning, and bounded tool behavior with fake transport |
| [Configuration](../tests/test_viewer_configuration.py) | Validated settings, portable paths, provider discovery, and configuration persistence without credentials |
| [CLI snapshot adapters](../tests/test_viewer_cli_assistant.py) | Restricted command construction, bounded process input/output, response parsing and mocked snapshot requests |
| [MCP](../tests/test_viewer_mcp.py) | Lifecycle/version negotiation, tool discovery, typed arguments, input/output bounds, missing apply tool, loopback restrictions, and stdio subprocess behavior |
| [Orbit](../tests/test_atlas_orbit.cjs) | Full rotations, pole crossings, camera/reset behavior |
| [Wheel navigation](../tests/test_atlas_wheel.cjs) | Wheel direction/delta modes, trackpad accumulation, throttling, modifier zoom routing and layout fallback |

Passing these tests validates their fixtures and assertions. It does not prove every GGUF encoding is supported, every model loads in an inference runtime, every browser/GPU combination renders correctly, or a candidate preserves model quality. Do not turn a test count into an inference benchmark claim.

## Safe browser review

Use the generated demo or a small synthetic fixture before inspecting personal files:

```sh
python examples/create_demo.py --help
gguf-atlas --help
```

Use the demo generator's documented output option and point Atlas at that directory. Consult [User guide](user-guide.md) for the complete first-run example. No model download is needed for UI review.

Check model selection, layer/global filtering, tensor search, metadata previews, and supported/unsupported sample states. Exercise Weight landscape, Layer map Floors/Overview, 2D heatmap, and Distribution; confirm labels describe the selected tensor and sample. Orbit above and below a floor, use keyboard controls, navigate with the wheel, and test reduced-motion behavior where applicable.

Switch all palettes and verify sign colors agree across the 3D view, heatmap, legend, and assistant context. Resize the window and check that model names, errors, dialogs/plan details, and controls remain readable. Test a non-WebGL environment or its failure path so the table and 2D views remain useful.

For a writer change, apply a tiny fixture plan and compare the original hash and exact candidate bytes. A screenshot of a completed job is not a substitute for byte-level assertions. For public screenshots, use synthetic names/data and inspect every image for local paths, private model inventory, chats, and client account information.

## Packaging and portability

A source-checkout run does not establish that a wheel contains its frontend assets. Before a release:

1. Build a wheel with standard Python packaging tools.
2. Install it into a clean virtual environment.
3. Change to a directory outside the checkout and run the installed `gguf-atlas --help` and `gguf-atlas-mcp --help` entry points.
4. Start the installed server with a temporary synthetic model root, separate output/log locations, and an unused loopback port. Verify `/api/health`, the HTML, all referenced static assets, and a sample request.
5. Verify MCP initialization/tool discovery through the installed entry point without making a provider call.

Exercise supported platforms through CI and report untested configurations honestly. In particular, case-sensitive filesystems must retain separate catalog entries for names that differ only by case. Candidate writing requires hard-link support in its output filesystem. Do not treat successful Windows testing as proof of behavior on a network share, removable-drive format, Linux, or macOS.

Check documentation links and the publication allowlist alongside code. Do not include models, local configuration, provider session files, generated logs, or screenshots containing private information in a release artifact.

## Optional provider and decoder verification

Live provider tests are separate from routine CI. Use them only when intentionally exercising the configured account. Record the provider identifier, exact synthetic question/context, requested settings, returned usage, duration, tool outcomes, and errors. Never record credentials or authentication/session files. A provider timeout may leave a request running; avoid repeatedly retrying blindly.

CLI snapshot chat and agent MCP sessions are different tests. A CLI explanation of supplied JSON does not verify MCP discovery or tool execution. Conversely, successful MCP initialization does not verify authentication or a paid conversation with an external model. Describe exactly which path was exercised.

For new quantization decoders, compare numerical results with a pinned upstream implementation, using synthetic packed blocks and explicit tolerances. Preserve the upstream revision and source hashes. Any oracle requiring NumPy or fetching/executing upstream Python must be opt-in and separate from the dependency-free runtime. Include malformed/truncated blocks and relevant endianness tests as well as normal values; an upstream decoder match alone does not establish full-model compatibility.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser cannot connect | Confirm the viewer is running, its printed port, and `/api/health`. Check configuration and startup errors before stopping any process. |
| Port already occupied | Use another `--port` or identify the existing owner. Do not stop an unrelated service to make the default port available. |
| Catalog is empty | Configure a directory containing `.gguf` files, then refresh. Atlas does not download a model automatically. Use catalog IDs in API calls. |
| A model disappears or inspection reports drift | Let external downloads/copies finish, then rescan. Inspect a stable source rather than a file being rewritten concurrently. |
| Unknown encoding or unsupported sample | Read the returned reason. Directory inspection can work when value decoding does not; no packed-byte heatmap is substituted. |
| Blank 3D canvas | Read the WebGL error, reset the camera, and try 2D/table views. Check browser graphics support before assuming the model is empty. |
| Spikes seem to vanish below a floor | Orbit underneath. Negative values extend below the zero plane; palette colors identify sign. |
| Equal-height spikes have different numbers | Landscape floors normalize independently. Compare numerical statistics rather than absolute heights across floors. |
| Scrolling changes floors instead of zooming | Expected in carousel layouts. Use the documented modifier/keyboard zoom controls; Overview uses different navigation. |
| Provider unavailable | Check that provider's CLI/daemon installation, sign-in and registration. Atlas does not infer account availability from a model filename. |
| Cloud authentication/quota/timeout error | Use the provider's normal account flow or check usage. Try a narrower request after the previous request has finished; never paste credentials into chat. |
| MCP cannot start | Verify command, environment, project trust/approval, and the separate Atlas backend URL. A local REST URL is not a remotely hosted MCP endpoint. |
| Plan ID rejected | Plans are session-scoped and bounded. A restart or eviction requires a new reviewed plan. |
| Candidate creation failed | Inspect the job error for source drift, range/type, overflow, free space, permissions, or hard-link support. Fix the cause and prepare a new plan. |
| Partial output after crash | Do not treat it as a valid candidate. Identify the owned artifact and review available evidence before manual cleanup. |

If reporting a bug, include the Atlas revision/version, OS/Python/browser versions, reproducible steps, sanitized error, and a minimal synthetic fixture if possible. Include a real model path or sample only after reviewing what it exposes. See [API](api.md) for transport errors and [Experiments](experiments.md) for candidate validation boundaries.
