# Third-party references and notices

GGUF Atlas is distributed under the [MIT license](LICENSE). It uses Python's standard library at runtime and browser-provided Canvas/WebGL APIs. No model weights are distributed with this project; the optional demo generator produces explicitly synthetic values.

## GGUF and llama.cpp

The parser follows the [GGUF format specification](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md). Type identifiers, block sizes and quantization algorithms in `viewer/gguf_core.py` were cross-checked against llama.cpp's `gguf-py` constants and quantization implementation at revision `80d2c0c2c56e4a1bbf74be98f64b99927bf230bc`.

For these format/algorithm references and any adapted portions, retain the upstream notice below. Source: [llama.cpp LICENSE at the referenced revision](https://github.com/ggml-org/llama.cpp/blob/80d2c0c2c56e4a1bbf74be98f64b99927bf230bc/LICENSE).

```text
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Visual inspiration

[PortexAnalyzerGUI](https://github.com/struppigel/PortexAnalyzerGUI) was a reference for a large visual inspection workspace. No Portex source code or executable is included. Atlas's layer-floor and weight-landscape views are implemented in the local browser UI.

## Provider names

Ollama, Claude Code, Codex, and their associated names belong to their respective owners. Atlas is an independent integration. Users install and authenticate provider software separately; provider software, credentials and subscriptions are not bundled.
