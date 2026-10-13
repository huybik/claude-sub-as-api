# Claude sub as API

**Turn your Claude Pro or Max subscription into a local Anthropic API.**
Point the official Anthropic SDK at `http://127.0.0.1:8787` with a local key; no Anthropic API key needed.

[![Version](https://img.shields.io/badge/version-0.2.0-blue)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen)](docs/reference.md#project-layout)

> [!NOTE]
> Unofficial; not affiliated with Anthropic. Calls use your subscription's usage limits and follow its terms; see
> [using the Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

## Why

You already pay for Claude. Scripts, evals, and prototypes written against the Anthropic SDK should be able to
use that subscription too. Claude Code can call Claude with your login, but only through its own CLI.
This project wraps Claude Code in the standard Messages API, so the SDK code you already have keeps working.
It keeps your usage low by caching what you mark, as the API does.

## How it works

```
  your app ── Anthropic SDK ──▶  POST /v1/messages   127.0.0.1:8787, local key
                                        │
                     ┌──────────────────▼───────────────────┐
                     │ claude-sub-as-api                    │
                     │ validate → queue (1 per GiB of RAM)  │
                     │ → history transcript + cache marks   │
                     └──────────────────┬───────────────────┘
                                        │ claude -p   (safe mode, no built-in tools)
                                        ▼
                     Claude Code + your subscription login ──▶ Claude
                                        │ stream events
                                        ▼
  your app ◀── Anthropic JSON / SSE ── translated response
```

- **Local execution by default.** A local request runs one Claude Code process, or none when it is served from the response cache or shares an identical call already running.
- **Your tools stay yours.** Tool definitions reach Claude through an in-process MCP bridge, and the call stops
  before Claude Code would run a tool, so your app runs it.
- **No dependencies.** Node.js built-ins only.

## Features

- **Messages API features:** streaming, tool use, images, structured output, effort levels, and adaptive thinking.
- **Models:** Sonnet 5.5, Opus 5.5, and Haiku 5.5.
- **Prompt caching** with `cache_control`. Shared prefixes, follow-ups, and tool turns read about 97% from the cache.
- **Concurrency:** one call at once per GiB of RAM (48 on a 48 GB Mac), the rest wait; plus a local response cache
  and a usage counter.
- **Service:** runs as a macOS LaunchAgent or a Linux systemd unit, bound to `127.0.0.1` behind a local key.

## Quick start

You need Node.js 22+ and [Claude Code](https://code.claude.com) logged in with your subscription (`claude auth login`).

```sh
git clone https://github.com/huybik/claude-sub-as-api.git
cd claude-sub-as-api
claude          # then say: "Follow DEPLOY.md"
```

Claude Code installs the server, starts it as a service, and checks it. To install by hand, see [DEPLOY.md](DEPLOY.md).

```python
from pathlib import Path
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8787", max_retries=0, timeout=1800,
                   api_key=(Path.home() / ".local/share/claude-local-api/token").read_text().strip())

reply = client.messages.create(model="claude-sonnet-5-5", max_tokens=1024,
                               messages=[{"role": "user", "content": "Hello, Claude"}])
print(next(block.text for block in reply.content if block.type == "text"))
```

## Cloud sessions (experimental)

Set `CLAUDE_LOCAL_API_CLOUD_ENVIRONMENT` to an existing Anthropic cloud environment ID (`env_...`) in the service
environment, then reload the service. Opt in on each `/v1/messages` call:

```python
reply = client.messages.create(
    model="claude-haiku-5-5", max_tokens=128000,
    messages=[{"role": "user", "content": "What is 17 times 19?"}],
    extra_headers={"x-local-backend": "cloud"},
)
```

Cloud mode supports **one user turn, text, base64 images, system text, effort, and buffered SSE**. It requires
`max_tokens=128000`: smaller output limits, history, client tools, structured output, and `cache_control` return
HTTP 400. Cloud prompt caching is automatic; local response caching and request sharing also work, with separate
entries for local and cloud calls. It never switches execution modes on failure.

Each uncached call creates a cloud session and archives it after completion or cancellation. Its transcript stays
in your Claude account. Eligible cloud credits apply automatically; normal plan and extra-usage rules apply after
those credits expire or run out. This uses an **undocumented session API**, not the Anthropic Messages endpoint.
See the [cloud reference](docs/reference.md#cloud-mode-experimental) for exact limits and authentication.

## Good to know (local mode)

- **Cache what you reuse.** Unmarked requests are not prompt-cached. Put `cache_control: {"type": "ephemeral"}` on the
  last shared block, or set top-level `cache_control` in multi-turn calls.
- **Timeout.** Set the SDK `timeout` to 1800 s. The 600 s default is shorter than the server's twenty-minute limit.
- **Unsupported input returns HTTP 400.** That's any field not listed in the [reference](docs/reference.md), notably:
  - a final assistant message (prefill), image URLs, and document or PDF blocks,
  - `metadata`, `stop_sequences`, `service_tier`, `inference_geo`, and non-default `temperature`,
  - `thinking` other than `{"type": "adaptive"}`,
  - forced `tool_choice`, `disable_parallel_tool_use`, tool fields beyond `name`, `description`, and `input_schema`,
    and tools combined with structured output,
  - cache breakpoints on `system` or `tools`, more than four breakpoints, or `1h` after `5m`.
- **Limits.** Subscription limits return HTTP 429. The server never falls back to a paid API.
- **Login change.** Restart the service after you switch Claude logins.

## Docs

- [Reference](docs/reference.md): every field, errors, caching, concurrency, configuration, security, and troubleshooting.
- [DEPLOY.md](DEPLOY.md): install and service steps, written for Claude Code to follow.
- [CHANGELOG.md](CHANGELOG.md): release history.

## License

[MIT](LICENSE) © 2026 huybik
