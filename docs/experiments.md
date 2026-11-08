# Controlled candidate experiments

[Project home](../README.md) · [User guide](user-guide.md) · [Configuration](configuration.md) · [API](api.md)

An Atlas experiment creates a **separate complete GGUF candidate** and a verification manifest. The original file is opened for reading and preserved. A successful result means the intended bytes were written and structurally checked; it does not certify runtime loadability, useful behavior, or improved quality.

## Supported edits

| Property | Behavior |
| --- | --- |
| Target | A flat range in one tensor of one single-file GGUF |
| Encodings | F32, F16, BF16 |
| Operations | Scale by a finite factor in `[-2, 2]`, or replace values with positive-zero bytes |
| Range | Nonnegative `element_start`, positive `element_count`, end exclusive, wholly within the tensor |
| Default range | Start at 0; omitted/null count means the remaining tensor elements |
| Output | Unique full-file candidate in the configured experiment directory |
| Evidence | JSON verification manifest in the configured log directory |
| Runtime | CPU streaming; no inference model or GPU workload is started |

Configuration determines the model, output, and log directories; see [Configuration](configuration.md). Do not place large weights inside the source checkout simply to try the application.

The range uses GGUF storage order: dimension 0 is contiguous. It is not a range of visualization coordinates, tokens, neurons, or attention heads. The display's packed 64-column layout can differ from the tensor's dimensions. Use an exact tensor record to interpret a range.

Packed quantized editing, requantization, tensor resizing, metadata rewriting, adapter merging, split-shard changes, architecture surgery, and semantic capability edits are not implemented. A Q/K/IQ tensor may support visualization while remaining unwritable. F16/BF16 changes round to native precision; a scaling result that overflows the destination representation is rejected. Scaling nonfinite source values is rejected; an explicit zero operation can replace them.

## Prepare and review

Select a supported tensor in the browser, specify the operation/range, and prepare a plan. This synchronously inspects and hashes the whole source file; changing a handful of values in a large model still requires a full-source hash. Preparing a plan does not create a candidate.

Plans can also originate from the HTTP plan endpoint or MCP `propose_edit`. Ollama Cloud's bounded proposal tool has an additional 4,096-element range cap and at most two plans per question. Direct HTTP/manual/MCP planning can cover a larger valid range. CLI snapshot chat is read-only and does not execute proposal tools.

Review the following fields before applying:

| Plan field | Review meaning |
| --- | --- |
| `plan_id`, `status` | Identifier for a retained `awaiting_review` plan |
| `source` | Exact file path/name, byte length, modification time, device/inode identity, full SHA256 |
| `tensor` | Exact tensor name, encoding, dimensions, element count, encoded bytes, absolute data offset |
| `edit` | Operation/factor, flat start/count/end, encoded byte range and element width |
| `required_copy_bytes` | Size of the entire new file, not just the edited values |
| `output_root` | Server-configured destination; a client cannot choose a different path in its apply request |
| `effects`, `limitations` | What the writer promises and what remains untested |

An external MCP proposal includes `review_url`, pointing to the local workbench with `?plan=<plan_id>`. Open that URL or use the browser's plan-ID review control. Neither MCP nor an assistant tool has an apply capability. The separate **Create candidate copy** action submits the stored plan ID and literal Boolean confirmation.

The UI handoff does not replace operating-system trust. This is a local service without authentication; another program running on the machine could call its HTTP API. Do not give an autonomous agent unrestricted HTTP access and assume the absence of an MCP apply tool is a hard isolation mechanism.

## What happens during apply

The [writer](../viewer/experiments.py) validates the server-held plan again rather than trusting offsets sent back by a browser:

1. Resolve the source, compare its identity, inspect the current tensor directory, and recompute the edit specification from the tensor record.
2. Check destination free space for a full source-sized candidate plus a chunk of working margin. Create a new exclusive partial file; existing files are never intentionally overwritten.
3. Stream the source in 1 MiB chunks. Transform only the reviewed range, count changed bytes/elements, and hash both the original stream and expected candidate bytes.
4. Flush/synchronize the output, then compare source length, identity, and SHA256 with the plan.
5. Parse the candidate and compare its inspected metadata/directory with the source. Read both files again and compare **every byte** against the expected transformation, checking hashes and source identity again.
6. Publish the candidate with an exclusive hard link, remove the owned partial name, and write a unique verification manifest. Refresh the catalog so the new candidate is inspectable.

The extra read-back makes large experiments disk-intensive. Time and space requirements depend on whole-file size, storage speed, and the range transformed, not on the visual size of a selection. The source is never patched in place.

### Filesystem requirements

Candidate publication uses a hard link within the output directory to avoid replacing an existing destination or making a second full-size copy. The destination filesystem must support that operation. Some removable-drive formats and network shares do not. Unsupported publication fails; the implementation does not silently fall back to an overwrite-prone rename.

Free-space preflight cannot reserve capacity against other processes. A disk can fill later. Use a writable local output filesystem with enough headroom and avoid changing the source while planning/copying. Review configuration paths before an experiment on a large file.

## Results and job state

The apply endpoint returns HTTP 202 and a job ID. Polling reports `queued`, `running`, `completed`, or `failed`; a worker may already be running by the time the initial response arrives. There is no cancellation/resume protocol or percentage-progress estimate.

On completion, `result.status` is `ready_for_evaluation`. The result records source/output identities and SHA256, operation/range, changed-byte/element counts, duration, manifest location, and these distinctions:

- `unchanged_outside_edit: true`: the read-back matched the expected transformation everywhere.
- `source_hash_verified_after_copy: true`: the original still matched its reviewed hash.
- `structure_validated: true`: the candidate's structure matched the intended file structure.
- `behavior_tested: false`: Atlas did not test inference behavior.
- `runtime_switched: false`: no active model service was replaced.

A scale factor of 1, zeroing values already zero, or native-precision rounding can result in fewer changed elements than the selected count. Review `changed_elements` rather than assuming every selected value changed.

Plans/jobs are held in server memory, with up to 64 retained entries in each history. Restarting the server loses them. Reapplying a retained plan returns its existing job instead of creating another candidate, including when that job failed. After correcting a failure, prepare a new plan. Retention/idempotency are session features, not a persistent transaction ledger.

## Failures and recovery

Expected exceptions remove the writer's own partial/candidate/manifest artifacts as appropriate; unrelated files are preserved. A process crash, power loss, or forced termination can leave an orphan partial file because cleanup cannot run. A partial file is not evidence of a completed experiment and should not be used for inference. Inspect its path and any job/manifest evidence before manually removing only that artifact.

If a source hash or identity changed, stop and prepare a fresh plan after the file stabilizes. If a format, range, overflow, disk-space, permission, or hard-link error occurs, fix that cause before retrying. Do not edit a serialized plan to bypass validation. Manifests may include local paths and source metadata; review them before sharing publicly.

## Evaluate behavior separately

For an actual model candidate, define a hypothesis and a fixed baseline before experimenting. Validate runtime loadability, then compare the original and candidate on the same prompts, token limits, sampling settings, runtime version, hardware, and relevant quality measures. Record failures as well as successful outputs. If using a GPU, check capacity and preserve unrelated services before launching either model.

These are recommended evaluation steps, not an automated Atlas pipeline. A changed distribution, valid GGUF file, or attractive visualization is not evidence of better reasoning, coding, safety, context support, or speed. Keep a working original and its configuration until independent evidence supports a deliberate switch.

For exact endpoint schemas see [API](api.md). Fixture-based source-preservation and byte-verification tests are described in [Testing](testing.md).
