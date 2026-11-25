# @wayang-ai/cli

The `wayang` / `waya` terminal entry of [Wayang](https://github.com/pgYou/wayang) — a multi-agent orchestration platform that runs in your terminal.

A Controller agent understands your intent, decomposes it into tasks, and dispatches them to parallel Worker agents (built-in LLM workers, or third-party agents such as Claude Code), then synthesizes the results — all through natural conversation.

This package ships the whole CLI as one self-contained bundle (the internal `@wayang-ai/core` / `@wayang-ai/protocol` workspace libraries are compiled in; only public npm dependencies are installed).

## Install

Requires Node.js >= 20.

```bash
npm install -g @wayang-ai/cli
```

After installation, the global command `wayang` (alias `waya`) is available:

```bash
wayang          # start a new session
waya            # shorthand alias
wayang --resume # resume last session
```

On first run, an interactive setup wizard will guide you through configuring your LLM provider.

## Configure

Or create `~/.wayang.config.json` manually:

```json
{
  "providers": {
    "anthropic": {
      "baseURL": "https://api.anthropic.com",
      "apiKey": "xxx"
    }
  },
  "models": {
    "sonnet": {
      "provider": "anthropic",
      "name": "claude-sonnet-4-20250514",
      "contextWindowTokens": 200000
    }
  },
  "controller": { "model": "sonnet" },
  "worker": { "model": "sonnet", "maxConcurrency": 3 }
}
```

The API key can also be set via the `WAYANG_LLM_API_KEY` environment variable (`WAYANG_ENDPOINT` / `WAYANG_MODEL` are available for env-only setups).

## Documentation

Full documentation lives in the repository: <https://github.com/pgYou/wayang#readme>

## License

MIT
