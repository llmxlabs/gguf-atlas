"""Portable user settings and local CLI discovery; never stores credentials."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

PROVIDERS = ("ollama", "claude", "codex")
DEFAULT_SETTINGS = {"default_provider": "ollama", "timeout_seconds": 180,
                    "providers": {"ollama": {"model": "", "base_url": "http://127.0.0.1:11434"},
                                  "claude": {"executable": "", "model": ""}, "codex": {"executable": "", "model": ""}}}


def _absolute_env_dir(name, fallback):
    value = os.environ.get(name)
    return Path(value) if value and Path(value).is_absolute() else fallback


def user_data_dir():
    if os.name == "nt":
        return _absolute_env_dir("LOCALAPPDATA", Path.home() / "AppData" / "Local") / "GGUFAtlas"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "GGUFAtlas"
    return _absolute_env_dir("XDG_DATA_HOME", Path.home() / ".local" / "share") / "gguf-atlas"


def default_storage():
    preferred = Path(r"G:\AI")
    repository = Path(__file__).resolve().parents[1]
    data = user_data_dir()
    if os.name == "nt" and preferred.is_dir():
        output = preferred / "Experiments" / "GGUF-Atlas"
        roots = [preferred / "Models", preferred / "GGUF", output]
    else:
        output = data / "experiments"
        roots = [data / "models", output]
    logs = repository / "logs" / "gguf-atlas-experiments" if (repository / "docs" / "STATE.md").is_file() else data / "logs" / "experiments"
    return roots, output, logs


def config_path():
    return Path(os.environ.get("GGUF_ATLAS_CONFIG", user_data_dir() / "config.json")).expanduser().resolve()


def _validate_model(value):
    if not isinstance(value, str) or len(value) > 200 or (value and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]*", value)):
        raise ValueError("Model must be empty or a model identifier of at most 200 characters, without spaces or flags")


def _read_existing_config(path):
    """Never treat a model or unrelated existing file as a writable settings file."""
    resolved = path.resolve()
    if resolved.suffix.lower() == ".gguf":
        raise ValueError("Configuration path cannot target a GGUF model")
    if not resolved.exists():
        return None
    if not resolved.is_file():
        raise ValueError("Configuration path is not a regular file")
    with resolved.open("rb") as stream:
        if stream.read(4) in (b"GGUF", b"FUGG"):
            raise ValueError("Configuration path points to GGUF model data")
    if resolved.stat().st_size > 65536:
        raise ValueError("Existing configuration exceeds 64 KiB; choose a new settings path")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8"))
        validate_settings(value)
    except (ValueError, OSError) as error:
        raise ValueError("Existing file is not a valid Atlas configuration and will not be overwritten; choose a new settings path") from error
    return value


def validate_settings(settings):
    if not isinstance(settings, dict) or set(settings) - set(DEFAULT_SETTINGS):
        raise ValueError("Unknown configuration fields")
    if settings.get("default_provider") not in PROVIDERS:
        raise ValueError("default_provider must be ollama, claude, or codex")
    timeout = settings.get("timeout_seconds")
    if type(timeout) is not int or not 15 <= timeout <= 300:
        raise ValueError("timeout_seconds must be an integer from 15 to 300")
    providers = settings.get("providers")
    if not isinstance(providers, dict) or set(providers) != set(PROVIDERS):
        raise ValueError("Configuration must contain ollama, claude, and codex provider settings")
    for name in PROVIDERS:
        value = providers[name]
        if not isinstance(value, dict) or set(value) != set(DEFAULT_SETTINGS["providers"][name]):
            raise ValueError(f"Unknown or missing {name} settings; credentials and arbitrary arguments are not accepted")
        _validate_model(value["model"])
        if name == "ollama":
            parsed = urlsplit(value["base_url"]) if isinstance(value["base_url"], str) else None
            if (not parsed or parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
                    or not parsed.port or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
                raise ValueError("Ollama base_url must be http://127.0.0.1:<port> or http://localhost:<port>")
            value["base_url"] = value["base_url"].rstrip("/")
        else:
            executable = value["executable"]
            if not isinstance(executable, str) or len(executable) > 4096 or "\0" in executable:
                raise ValueError("CLI executable must be an absolute executable path or empty for discovery")
            if executable:
                path = Path(executable).expanduser()
                if not path.is_absolute() or path.name.lower() not in {name, name + ".exe", name + ".cmd", name + ".ps1"}:
                    raise ValueError(f"Configured executable must be an absolute path to {name}, not a shell command")
                value["executable"] = str(path)


class ConfigStore:
    def __init__(self, path=None):
        self.path = Path(path).expanduser().resolve() if path else config_path()
        self.lock = threading.RLock()
        self.settings = copy.deepcopy(DEFAULT_SETTINGS)
        self.error = None
        try:
            value = _read_existing_config(self.path)
            if value is not None:
                self.settings = value
        except (ValueError, OSError) as exc:
            self.error = f"Stored configuration was not loaded: {exc}. Defaults are active; the existing file is preserved."

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.settings)

    def update(self, patch):
        if not isinstance(patch, dict) or set(patch) - set(DEFAULT_SETTINGS):
            raise ValueError("Only default_provider, timeout_seconds, and providers may be configured")
        with self.lock:
            _read_existing_config(self.path)  # Recheck even if the path changed after startup.
            merged = self.snapshot()
            for key, value in patch.items():
                if key == "providers":
                    if not isinstance(value, dict) or set(value) - set(PROVIDERS):
                        raise ValueError("Unknown provider")
                    for provider, options in value.items():
                        if not isinstance(options, dict):
                            raise ValueError("Provider settings must be an object")
                        merged[key][provider].update(options)
                else:
                    merged[key] = value
            validate_settings(merged)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, prefix=".atlas-config-", suffix=".tmp", delete=False) as stream:
                    temporary = Path(stream.name)
                    json.dump(merged, stream, indent=2, allow_nan=False)
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
            finally:
                if temporary and temporary.exists():
                    temporary.unlink()
            self.settings, self.error = merged, None
            return self.snapshot()


def resolve_cli(provider, configured=""):
    if provider not in {"claude", "codex"}:
        raise ValueError("Unknown CLI provider")
    candidates = [Path(configured).expanduser()] if configured else []
    if not configured:
        found = shutil.which(provider)
        if found:
            candidates.append(Path(found))
        candidates.extend([Path.home() / ".local" / "bin" / provider,
                           Path.home() / ".local" / "bin" / (provider + ".exe")])
        if os.name == "nt":
            local = _absolute_env_dir("LOCALAPPDATA", Path.home() / "AppData" / "Local")
            roaming = _absolute_env_dir("APPDATA", Path.home() / "AppData" / "Roaming")
            candidates.extend([local / "Programs" / "OpenAI" / "Codex" / "bin" / "codex.exe"] if provider == "codex" else [roaming / "npm" / "claude.cmd"])
    for candidate in candidates:
        if os.name == "nt" and candidate.suffix.lower() in {".cmd", ".ps1"}:
            if provider == "claude":
                candidate = candidate.parent / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
            else:
                vendor = candidate.parent / "node_modules" / "@openai" / "codex" / "vendor"
                matches = sorted(vendor.glob("*-pc-windows-msvc/codex/codex.exe")) if vendor.is_dir() else []
                if not matches:
                    continue
                candidate = matches[0]
        if candidate.is_file() and (os.name != "nt" or candidate.suffix.lower() == ".exe"):
            return str(candidate.resolve())
    return None


_DETECTION_CACHE = {}
_DETECTION_LOCK = threading.Lock()


def detect_cli(provider, configured=""):
    executable = resolve_cli(provider, configured)
    result = {"id": provider, "label": "Claude Code CLI" if provider == "claude" else "Codex CLI",
              "available": False, "executable": executable, "version": None,
              "reason": "Executable not found. Install and sign in using the CLI, or configure its absolute executable path."}
    if not executable:
        return result
    key = (provider, executable, Path(executable).stat().st_mtime_ns)
    with _DETECTION_LOCK:
        cached = _DETECTION_CACHE.get(key)
        if cached and time.monotonic() - cached[0] < 30:
            return copy.deepcopy(cached[1])
    try:
        from .cli_assistant import run_bounded, CODEX_DISABLED_FEATURES
        version_code, version_text, _ = run_bounded([executable, "--version"], timeout=5, output_limit=256000)
        help_code, help_text, _ = run_bounded([executable, *( ["exec"] if provider == "codex" else [] ), "--help"], timeout=5, output_limit=256000)
        required = ("--tools", "--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts",
                    "--permission-mode", "--disable-slash-commands", "--no-chrome", "--output-format") if provider == "claude" else ("--ignore-user-config", "--ephemeral", "--sandbox", "--json", "--skip-git-repo-check", "--color", "--disable", "--enable")
        compatible = all(flag in help_text for flag in required)
        if provider == "codex":
            root_code, root_help, _ = run_bounded([executable, "--help"], timeout=5, output_limit=256000)
            feature_code, feature_text, _ = run_bounded([executable, "features", "list"], timeout=5, output_limit=256000)
            features = {line.split()[0] for line in feature_text.splitlines() if line.split()}
            compatible = compatible and not root_code and not feature_code and '--no-daemon' in root_help and '--ask-for-approval' in root_help and set(CODEX_DISABLED_FEATURES + ("skip_host_skill_discovery",)) <= features
        result["version"] = version_text.strip()[:200]
        if version_code or help_code or not compatible:
            result["reason"] = "This CLI version is missing required bounded-invocation options. Update it before using Atlas chat."
        else:
            result.update(available=True, reason="Compatible executable detected. Authentication is checked only when you send a question; sign in through the CLI first.")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        result["reason"] = "CLI detection failed or timed out. Check its executable path and run --help in a terminal."
    with _DETECTION_LOCK:
        _DETECTION_CACHE[key] = (time.monotonic(), copy.deepcopy(result))
    return result


def mcp_snippets(port=18040):
    script = str(Path(__file__).with_name("mcp_server.py").resolve())
    command = sys.executable
    args = [script, "--base-url", f"http://127.0.0.1:{port}"]
    claude = {"mcpServers": {"gguf-atlas": {"type": "stdio", "command": command, "args": args}}}
    codex = "[mcp_servers.gguf_atlas]\ncommand = " + json.dumps(command) + "\nargs = " + json.dumps(args) + "\nstartup_timeout_sec = 10\ntool_timeout_sec = 300\n"
    return {"command": command, "args": args, "claude_config": claude, "codex_config": codex,
            "instructions": "Merge the snippet into the external client's project configuration and approve the MCP server there. Start Atlas first. MCP inspection/proposals are separate from the answer-only CLI chat provider; no apply tool is exposed."}
