# Working on GGUF Atlas

Read README.md and the relevant guide in docs/ before editing. Preserve model originals; never run an inference workload, download weights or call a paid provider merely to test the UI. Use examples/create_demo.py and temporary test fixtures.

Keep the service on loopback. Maintain bounded parser, sampling, subprocess and tool output. Treat GGUF strings and assistant output as untrusted data. Candidate writes require an explicit reviewed plan and a new output file.

Run the checks in CONTRIBUTING.md appropriate to the change and update public documentation when behavior changes. Do not commit credentials, per-user configurations, logs, weights or provider session files.
