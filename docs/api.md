# Local HTTP API

[Project home](../README.md) · [Configuration](configuration.md) · [Architecture](architecture.md) · [Experiments](experiments.md)

The browser and MCP adapter use the same loopback HTTP application. The default URL is `http://127.0.0.1:18040`; use the port printed by your server. This is a local desktop API without user authentication, not a hosted multi-user service. MCP itself uses a separate stdio transport described in [Configuration](configuration.md).

## Routes and transport

| Request | Success | Behavior |
| --- | --- | --- |
| `GET /api/health` | 200 | Process identity/version and active candidate-job count |
| `GET /api/models` | 200 | Rescan configured roots and return catalog IDs/files |
| `GET /api/model?id=<model_id>` | 200 | Inspect the complete tensor directory and bounded metadata |
| `GET /api/sample?id=<model_id>&tensor=<name>` | 200 | Decode a supported prefix of at most 4,096 values |
| `GET /api/export?id=<model_id>` | 200 | Download inspection and agent interpretation/capability contract |
| `GET /api/assistant/status` | 200 | Discover configured provider choices and availability/disclosure |
| `GET /api/config` | 200 | Read settings, detected providers, storage locations and generated MCP snippets |
| `POST /api/config` | 200 | Validate and persist a provider-settings patch; no generation or client registration |
| `POST /api/chat` | 200 | Request a nonstreaming assistant answer using the selected provider mode |
| `POST /api/experiments/plan` | 200 | Inspect/hash source and store a review plan; no candidate creation |
| `GET /api/experiments/plan?id=<plan_id>` | 200 | Retrieve a retained plan |
| `POST /api/experiments/apply` | 202 | Explicitly confirm a retained plan and dispatch its candidate job |
| `GET /api/jobs?id=<job_id>` | 200 | Read job state/result |

Static routes serve the HTML and its local JavaScript/CSS assets through an allowlist. There is no general filesystem-serving endpoint. There is no HTTP tensor pagination endpoint; `/api/model` returns the directory and local clients filter it. The MCP tool contract provides its own pagination.

Responses are UTF-8 JSON unless serving a static asset. Export has `Content-Disposition: attachment; filename="gguf-manifest.json"`. Responses are marked `Cache-Control: no-store`; no CORS response header is enabled.

| Constraint | Requirement |
| --- | --- |
| Host | `127.0.0.1:<actual-port>` or `localhost:<actual-port>` |
| Origin | If present, exactly `http://<Host>` |
| Fetch metadata | `Sec-Fetch-Site: cross-site` is rejected |
| GET URL | At most 8,192 characters |
| POST content type | `application/json`; charset parameters are accepted |
| POST body | A JSON object; Content-Length from 1 to 65,536 bytes |
| Transfer encoding | Chunked bodies are not accepted |
| Body reading | 15-second socket timeout |
| JSON constants | Nonfinite constants such as `NaN` and `Infinity` are rejected |
| Methods | Documented GET/POST only; PUT/PATCH/DELETE/OPTIONS are rejected |

The HTTP implementation selects documented fields rather than applying one global JSON Schema. Unknown top-level fields are not uniformly rejected. Selection/history objects and agent tool arguments have stricter field checks. Send only documented fields. There is no generated OpenAPI endpoint.

## IDs and local paths

Obtain model IDs from `/api/models`. These are 24-character path-derived catalog keys, **not SHA256 content identities**. Do not pass a file path in place of `id`. An exact tensor name identifies a record within the selected model. Plan/job IDs are distinct UUID-derived identifiers.

Catalog `models[]` contains `id`, `name`, absolute `path`, and `size_bytes`. The surrounding response contains resolved `roots`, `source_read_only: true`, and `candidate_output_root`. Catalog size is bounded to 10,000 files. These paths are intended for the local client; built-in assistant context uses a different compact representation. Review API exports before sharing them externally.

Health reports `status`, the internal application identifier, schema/application version, and `active_jobs`. The historical internal identifier is `gguf-observatory` even though the product is named GGUF Atlas. A healthy process does not prove provider authentication, remaining quota, or inference-model readiness.

## Configuration response and update

`GET /api/config` returns `schema_version: "1.0"`, `settings`, `providers`, optional stored-configuration `error`, `storage`, and `mcp`. Storage contains `config_path`, `model_roots`, `experiment_root`, and `log_root`. Generated MCP snippets describe the running Python/script/port for another client; returning them does not register or approve a server in that client.

Provider rows have `id`, label, availability, detected executable/version where applicable, and a reason. Discovery can run bounded local CLI version/help checks and query local Ollama tags; it does not request model generation. Compatible executable or registered tag detection does not verify sign-in, entitlement, or quota. A malformed saved configuration activates defaults with an explanatory error rather than silently trusting its fields.

`POST /api/config` accepts a partial patch of these settings directly—not an enclosing `settings` object:

```json
{
  "default_provider": "ollama",
  "timeout_seconds": 180,
  "providers": {
    "ollama": {"base_url": "http://127.0.0.1:11434", "model": ""},
    "claude": {"executable": "", "model": ""},
    "codex": {"executable": "", "model": ""}
  }
}
```

`default_provider` is `ollama`, `claude`, or `codex`. `timeout_seconds` is an integer from 15 to 300 and controls the CLI subprocess deadline. Ollama uses its separate fixed request/loop limits. An empty CLI executable enables discovery; a supplied executable must be an absolute path to the corresponding named CLI, not a shell command. An empty model selects the provider's default behavior. Nonempty model identifiers are bounded to 200 characters and cannot contain spaces or arbitrary flags.

Ollama `base_url` must be loopback HTTP using `127.0.0.1` or `localhost` with an explicit port; credentials, URL paths other than `/`, queries and fragments are rejected. Unknown settings/provider fields are rejected. Account credentials and arbitrary command arguments are not settings. Partial provider objects merge with current values before complete validation; a successful update returns the full configuration response.

Model roots, output/log directories, and the config-file location are startup settings, not mutable fields of this endpoint. Use `--root`, `--experiment-root`, `--log-root`, and `--config` as described in [Configuration](configuration.md).

Saving settings refuses an existing invalid/unrelated file and any GGUF destination or detected GGUF content. Such a path can produce defaults plus an error on GET, but POST will not replace it. Choose a new configuration path. Writes recheck existing content before publication.

## Inspection response

Inspection schema version is `1.0`. The export's additional agent contract has its own version; do not confuse either with the application version.

| Object | Contents |
| --- | --- |
| `file` | `path`, `name`, `size_bytes`, GGUF `version`, `endianness`, `data_offset`, `alignment`; HTTP adds modification-time identity details |
| `metadata` | Stored GGUF keys with scalar values, small arrays, or explicit preview objects |
| `architecture` | Architecture name and available declared layer, embedding, attention, context, expert, feed-forward, RoPE and auxiliary-layer fields |
| `summary` | `tensor_count`, `parameter_count`, `tensor_bytes`, `known_tensor_bytes`, and `quantization[]` |
| `summary.quantization[]` | `type`, `tensor_count`, `parameter_count`, `bytes` |
| `layers[]` | Recognized numbered groups: `index`, `name`, `tensor_count`, `parameter_count`, `bytes`, `types` |
| `tensors[]` | Exact directory records plus inferred role/layer and sampling support |
| `warnings` | Interpretation limits, shard scope, unknown sizes, and related caveats |

Each tensor record has `index`, `name`, `shape`, `type`, `type_id`, `parameter_count`, `bytes`, relative `offset`, `absolute_offset`, `stored_span_bytes`, inferred `layer`, inferred `role`, and `sample_supported`.

`shape` retains GGUF order: dimension 0 is contiguous. `layer: null` means the name did not match a recognized numbered layer. `stored_span_bytes` extends to the next tensor/end of file and can include padding; use `bytes` for known encoded payload size. Unknown encoding sizes and affected total byte counts remain `null`; `known_tensor_bytes` retains the known subtotal.

Stored parameter counts are products/sums of tensor dimensions, including auxiliary tensors. They are not active MoE counts. Architecture metadata can contain per-layer arrays; do not assume every architecture field is a scalar. Missing fields are `null`.

Arrays longer than 16 elements use a representation such as:

```json
{"count": 100000, "preview": [0, 1, 2], "truncated": true, "element_type": 4}
```

The displayed example is shortened; actual previews retain up to 16 elements. Long strings similarly use `preview`, `byte_length`, and `truncated`. Exported previews are not a lossless representation for conversion or metadata editing. Nonfinite metadata is represented safely rather than emitted as invalid JSON numeric constants.

## Sample response

Common fields are `schema_version`, `name`, `type`, original `shape`, `supported`, `values`, `sample_shape`, `stats`, `histogram`, and `sampling`.

An unsupported encoding returns HTTP 200 with `supported: false`, a `reason`, empty arrays, and `stats: null`. Unsupported decoding is a valid inspection result; it does not mean the source is necessarily invalid.

Supported responses additionally include:

| Field | Meaning |
| --- | --- |
| `sample_count`, `total_count` | Returned values versus total stored elements |
| `start_element` | Currently 0: a deterministic contiguous prefix |
| `bytes_read` | Encoded prefix bytes read, rounded up to complete encoding blocks if needed |
| `values` | Decoded values in storage order; nonfinite values become `null` |
| `sample_shape` | Display `[rows, columns]`, at most 64 columns; the last row may be partial |
| `nonfinite_count` | Number excluded from finite statistics |
| `stats` | `min`, `max`, `mean`, `std`, `zero_fraction`, `finite_count`; null when no finite values exist |
| `histogram` | Up to 32 `{min, max, count}` bins; constant finite samples use one bin |

These statistics describe only the finite values in this prefix. The sample is neither random nor a whole-tensor measurement. Packed display dimensions are not the original tensor geometry. See [Visualizations](visualizations.md).

## Assistant request

Choose a provider from `/api/assistant/status`'s `providers` rows. `models`/`default_model` describe discovered Ollama Cloud tags; CLI model overrides come from request/configuration instead of that tag list. Provider modes can transmit the supplied question/context to an external account and consume its quota. Availability checks are not a guarantee of successful authentication or remaining usage.

The following is a request-shape example, not a request to execute a provider call:

```json
{
  "id": "<catalog-model-id>",
  "provider": "ollama",
  "provider_model": "<registered-cloud-model-name>",
  "message": "Explain the selected floor and the limits of this sample.",
  "history": [],
  "selected_tensor": "<exact-tensor-name>",
  "selected_layer": 0,
  "selected_view": "landscape",
  "selected_theme": "slate"
}
```

| Field | Constraint |
| --- | --- |
| `id` | Nonempty model ID, at most 128 characters; `model_id` is a fallback alias |
| `provider` | Optional `ollama`, `claude`, or `codex`; defaults to configured `default_provider` |
| `provider_model` | Optional model override; Ollama falls back to its configured model or discovered default, while CLI modes fall back to their configured/default model |
| `message` | Nonempty, at most 4,000 characters; `question` is a fallback alias |
| `history` | Default `[]`; at most 12 plain `{role,content}` objects, role `user` or `assistant`, content at most 6,000 characters |
| `selection` | Optional object containing only `tensor` and `layer`; takes precedence over the two shorthand fields when non-null |
| `selected_tensor` / `selection.tensor` | Exact selected tensor name; built-in context limits names to 256 characters |
| `selected_layer` / `selection.layer` | Nonnegative integer, `"global"`, or null/omitted |
| `selected_view` | Optional `landscape`, `layers`, `heatmap`, or `distribution` |
| `selected_layer_layout` | For `layers`: `floors` or `overview`, default `overview` |
| `selected_theme` | Optional `slate`, `indigo`, `ember`, or `forest` |

Selection/view fields describe context; they do not move a browser camera. A global selection includes only tensors with no recognized numbered layer. The cloud guide sees compact facts and visualization descriptions, not a live screenshot.

Ollama Cloud mode can use bounded inspection/proposal tools: at most five provider rounds, 12 tools, and two proposals, with proposals capped at 4,096 elements. The loop checks a 180-second elapsed budget between rounds; a running 90-second provider request or local tool can finish after that check. This is not a hard 180-second cancellation deadline.

CLI-backed chat modes use read-only snapshot prompts. They do not receive the Ollama tool loop, perform MCP calls, or automatically prepare/apply local edits. Configuring a Codex/Claude MCP client is a separate integration. [Configuration](configuration.md) describes the actual provider names, subprocess controls, authentication expectations, and MCP setup.

Shared response fields include `reply`, `provider`, `provider_model`, `evidence`, `proposals`, `usage`, `disclosure`, `tool_limit_reached`, and `warning`. Ollama evidence records tool name, optional tensor and `ok`/`rejected` status. Ollama usage aggregates provider-reported prompt/completion tokens, provider/tool call counts and elapsed seconds. CLI evidence describes locally prepared inspection/sample context, while CLI `tool_calls` is zero and `proposals` is empty. CLI token fields reflect available provider output, not a guarantee of metric equivalence. Proposals are local review plans, never evidence that a write occurred.

## Plan, apply, and job contracts

Prepare a plan:

```json
{
  "id": "<catalog-model-id>",
  "tensor": "<exact-F32-F16-or-BF16-tensor>",
  "operation": "scale",
  "factor": 0.99,
  "element_start": 0,
  "element_count": 16
}
```

`id`, `tensor`, and `operation` are required in practice. Operation is `scale` or `zero`; start defaults to 0. An omitted/null count selects all remaining elements, and the range must be nonempty and within the tensor. Scale factor defaults to 1.0 and must be finite in `[-2,2]`. Zero ignores factor and stores it as `null`. This direct plan API has no 4,096-element cap; that smaller bound belongs to the Ollama proposal tool.

The response is an `awaiting_review` plan containing source identity/SHA256, exact tensor/edit specification, copy size, limitations, model ID, and server-selected output root. Planning hashes the entire source but creates no candidate. See [Experiments](experiments.md) before using it with a large file.

Apply only a plan retained by this running server:

```json
{"plan_id": "<retained-plan-id>", "confirm": true}
```

Only literal Boolean `true` confirms. The server looks up its plan; it does not accept replacement offsets, source paths, output paths, or an edited plan document from the client. Applying is a documented write action that creates a separate candidate, not an in-place modification.

A 202 response contains `job_id`, `plan_id`, status/message, and `started_at`. Poll `/api/jobs?id=<job_id>` for `queued`, `running`, `completed`, or `failed`. Completion includes a result whose inner status is `ready_for_evaluation`; failure includes `error`. `finished_at` is added when the worker exits. Repeated apply of a retained plan returns its existing job. There is no cancellation, resumable transfer, progress-percentage, or durable job-history API.

## Error behavior

Expected failures return `{ "error": "human-readable message" }`.

| Status | Common cause |
| --- | --- |
| 400 | Invalid body/range/selection, malformed GGUF, unsupported edit, stale source, or busy application slot; POST lookup errors also map here |
| 403 | Rejected Host, Origin, or cross-site request |
| 404 | Unknown GET route, model/file, plan, or job |
| 405 | Unsupported method or POST route |
| 414 | Oversized GET URL |
| 429 | Provider rate or usage limit |
| 502 | Invalid provider response or provider request failure |
| 503 | Provider/daemon unavailable or authentication required |
| 504 | Provider timeout |
| 500 | Unexpected internal failure |

Assistant discovery normally reports unavailability in a successful response instead of generating a provider request. A background candidate failure appears in job state, not as a retroactive change to the apply response. Provider/client timeouts do not guarantee cancellation of work already in progress.

## Read-only example

This Python example lists local models and inspects one directory; it does not call a provider or create a candidate:

```python
import json
from urllib.parse import urlencode
from urllib.request import urlopen

base = "http://127.0.0.1:18040"
with urlopen(base + "/api/models") as response:
    catalog = json.load(response)
for model in catalog["models"]:
    print(model["id"], model["name"], model["size_bytes"])
if catalog["models"]:
    query = urlencode({"id": catalog["models"][0]["id"]})
    with urlopen(base + "/api/model?" + query) as response:
        inspection = json.load(response)
    print(inspection["architecture"])
```

Always URL-encode tensor names and IDs. In JavaScript, integers beyond `2^53 - 1` cannot be represented exactly as Number. Do not reconstruct writable offsets from browser-parsed numbers; apply by the server-retained plan ID instead. Treat returned model strings and assistant answers as data rather than executable instructions.
