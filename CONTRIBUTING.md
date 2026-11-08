# Contributing to GGUF Atlas

Start with the [architecture guide](docs/architecture.md) and open an issue describing the concrete workflow or bug. Small, focused pull requests are easier to review.

## Development

Python 3.11+ runs the application without third-party runtime packages. Node.js is needed only for JavaScript checks. The browser UI uses plain HTML/CSS/JavaScript and WebGL; there is no frontend build step.

```sh
python -m pip install -e .
python -m unittest discover -s tests -p 'test_*.py' -v
node --check viewer/static/app.js
node --check viewer/static/guide.js
node --check viewer/static/topology.js
node tests/test_atlas_orbit.cjs
node tests/test_atlas_wheel.cjs
```

Use synthetic fixtures and a temporary directory for tests. Do not commit weights, personal file paths, authentication files, CLI sessions, local configuration or chat transcripts. A visual change should include a screenshot and keyboard/control verification. Changes to parsing or candidate writing need meaningful malformed-input and preservation tests.

Document public API or behavior changes alongside the implementation. Keep sampled statistics clearly distinguished from whole-tensor measurements, structure from runtime execution, and byte validity from model quality. Avoid automatic downloads or paid provider calls in tests.

## Pull requests

Describe the user-visible problem, resulting behavior and validation performed. Note untested platforms or provider paths. Keep provider execution opt-in, retain loopback binding, and never introduce a path that lets an assistant silently apply a weight edit.
