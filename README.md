# Claude sub as API

A local Anthropic-compatible API (`POST /v1/messages`) for your Claude Pro or Max subscription.
Point the Anthropic SDK at `http://127.0.0.1:8787` and each call runs through your Claude Code login,
without an Anthropic API key. Streaming, tools, images, structured output, and effort are supported.
Models: `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5`.
Node.js built-in modules only; no npm dependencies.

This is an unofficial project and is not affiliated with Anthropic. Calls count against your subscription limits.

## Install

Requirements:
- Node.js 22 or newer.
- Claude Code on `PATH`.
- A Claude subscription login (`claude auth login`).

The easiest install is through Claude Code. Clone this repository, open Claude Code in it, and say:
"Follow DEPLOY.md". To install by hand, follow the same steps in [DEPLOY.md](DEPLOY.md).
The installed server runs from `~/.local/share/claude-local-api` as the `local.claude-api` macOS LaunchAgent.
On Linux, DEPLOY.md sets it up as a systemd user service instead. The commands below are for macOS.

## Start and restart

The macOS LaunchAgent starts at login and restarts the service if it stops.
After a code update, repeat DEPLOY.md step 2 to copy the files, then restart the service:

```sh
launchctl kickstart -k "gui/$(id -u)/local.claude-api"
```

Stop until the next login:

```sh
launchctl bootout "gui/$(id -u)/local.claude-api"
```

Start again after stopping:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.claude-api.plist
```

To disable automatic startup, stop the service and move its plist out of `~/Library/LaunchAgents`.
For a foreground run, stop the service, then run `claude-local-api`.
If your Claude login expires, run `claude auth login` and select your subscription.

## Anthropic SDK

Use the local base URL and the local access key. Do not use a paid Anthropic API key.

```python
from pathlib import Path
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:8787",
    api_key=(Path.home() / ".local/share/claude-local-api/token").read_text().strip(),
    max_retries=0,
    timeout=1800,
)
message = client.messages.create(
    model="claude-haiku-5-5",
    max_tokens=512,
    messages=[{"role": "user", "content": "Explain recursion in three sentences."}],
)
for block in message.content:
    if block.type == "text":
        print(block.text)
```

`POST /v1/messages` accepts these fields:

| Field | Support |
| --- | --- |
| `model`, `max_tokens`, `messages` | Required. Output limit: 1–128,000 tokens. |
| `messages[].role` | `user`, `assistant`, and text-only `system` notes. After system notes are removed, the list must start and end with `user`. |
| `messages[].content` | Text, text blocks, base64 images, assistant tool calls, user tool results, and signed thinking blocks. |
| `system` | Text or a list of text blocks, including an empty list. |
| `stream` | Anthropic SSE events, including tool argument fragments; works with `client.messages.stream()`. |
| `tools` | Client tools with `name`, optional `description`, and `input_schema`. |
| `tool_choice` | `auto` or `none`. |
| `output_config.effort` | `low`, `medium`, `high`, `xhigh`, or `max`. |
| `output_config.format` | `{"type":"json_schema","schema":{...}}`. The JSON result is returned as a text block. |
| `thinking` | `{"type":"adaptive"}`. Omit it for the model default. See the disabled-thinking limit below. |
| `cache_control` | On a message content block, or top-level for automatic caching. See [Prompt caching](#prompt-caching). |

Image sources use `{"type":"base64","media_type":"image/png","data":"..."}`.
PNG, JPEG, GIF, and WebP are accepted, up to 5 MiB per image and 32 MiB per request.
User and assistant content blocks are preserved. History is loaded through a temporary Claude transcript.
A final user message without tool results is sent through Claude's structured input protocol.
A final user message with tool results goes into the transcript instead, and Claude Code resumes the turn
those results answer. Claude Code then adds one short meta note after them ("Continue from where you left off.").
A new prompt after the results would make Claude Code insert an assistant reply the model never wrote
("No response requested."). Temporary files are removed after the call.

`system` messages are a local extension. Their text is appended to the top-level system prompt in message
order and sent through SDK initialization. These notes have system priority. Their original positions among
user and assistant messages are not retained: Claude receives one combined system prompt for the request.

Tool definitions are exposed through an SDK MCP bridge. When Claude requests a tool, the API returns
`stop_reason: "tool_use"` with tool IDs, names, and input objects. Your application runs those tools.
Append the assistant content and a user `tool_result` message, then call the endpoint again.
Return all pending tool results before other user content. Adjacent messages with the same role are merged;
an empty tool result is allowed.
You can pass SDK response content objects directly. Tool blocks accept `caller: {"type":"direct"}` or a
missing/null caller, and a missing/null `toolset_name`. Empty text citations (`null` or `[]`) are accepted.
Non-empty citations, programmatic code-execution callers, and toolset member calls are not supported.
The proxy does not run the client tools or enable local shell/file tools.

For structured output, send `output_config.format` on each call. Schema output is emitted when the complete
result is ready, including when `stream` is true. Claude Code validates the schema but does not enforce `format`
annotations such as `email`. Schema definitions are limited to 64 KiB.

Unsupported fields return HTTP 400. This includes image URLs, document blocks, metadata,
custom stop sequences, forced tool choice, strict tool flags, and combining client tools with structured output.
These models accept only the default `temperature: 1`; omit temperature in normal calls.
Claude Code still owns context management. This adapter does not implement the full Anthropic platform API.

The compatibility checks on 2026-10-12 found that Claude Code 2.1.296 can still use thinking tokens after
`--thinking disabled` or the SDK thinking control is set to zero, even on Haiku at low effort. The local API
therefore rejects disabled thinking with HTTP 400. Use `output_config.effort` to select reasoning effort;
a small `max_tokens` budget can end during thinking, before any text is returned.
This is a Claude Code adapter limit; the direct Haiku API supports disabled thinking at high effort or below.
See [Anthropic thinking support](https://platform.claude.com/docs/en/build-with-claude/thinking).

Other limits remain explicit: no token-counting or batch endpoints, no SDK-compatible model-list endpoint
(`/v1/models` has the custom shape below), and no server tools, PDF/document
blocks, URL images, forced tool choice, or strict tool schemas. These need upstream support or separate
implementation; they are not silently converted to a different behavior.

## Prompt caching

`/v1/messages` caches what the request marks, as the Messages API does.

- Put `cache_control: {"type": "ephemeral"}` on a text, image, tool use, or tool result block in `messages`.
  The cached prefix runs from the tools and system prompt through that block.
- Or set top-level `cache_control` for automatic caching. It marks the last block of the final user message,
  so the next turn of the conversation reads everything before its new content.
- `ttl` is `5m` (the default) or `1h`, as on the API. A request holds at most four breakpoints,
  and a longer TTL must come before a shorter one; the API rejects other requests.
- A request without breakpoints is not cached. Claude Code's own breakpoints are off for this endpoint
  (`DISABLE_PROMPT_CACHING`). They wrote every prompt with a one-hour TTL, twice the input rate,
  including prompts nothing read again, and took two or three of the four breakpoints.
- Breakpoints on `system` blocks and `tools` are accepted but not placed: Claude Code builds the system prompt
  and the tool list. A message breakpoint still caches them with the rest of its prefix.

Claude Code puts the account context (the user's email address) in front of the first prompt of a session.
On a follow-up, the rebuilt history carries that context after its first message, where the conversation's
first call put it, so the follow-up's prompt starts with the same bytes and reads that call's cache.
The adapter reads the context from the first call's transcript, the only transcript it keeps, and deletes it.
After a restart or a login change, the first follow-up of an older conversation can miss the cache once.

Live check on 2026-10-12 with Haiku 5.5 at low effort, a 15K-token prefix marked with a five-minute TTL:

| Call | Cache write | Cache read | Read share |
| --- | --- | --- | --- |
| First call | 15,170 | 0 | 0% |
| Second call, same prefix and a different question | 13 | 15,157 | 97.6% |
| Follow-up turn of the first call | 21 | 15,170 | 97.5% |
| Tool result turn after a tool call | 38 | 15,608 | 97.4% |

Before this change, a follow-up wrote the whole conversation again and read nothing from cache, and
parallel calls with a shared prefix each wrote it in full.

## Parallel requests

- Up to **10 calls run at once**, shared by both endpoints. Another 32 calls can wait in the queue.
- A full local queue returns HTTP 503.
- Calls that resume the same saved session run in order. Other sessions can run at the same time.
- Each model process has a twenty-minute timeout, starting when its queue slot opens.
- A client disconnect cancels an active call or removes a waiting call.
- Active slots are released after the process closes. A process that ignores termination is killed after one second.
- Upstream subscription limits can still return HTTP 429. The proxy does not switch models or use a paid API key.

To change concurrency, set `CLAUDE_LOCAL_API_CONCURRENCY` in the LaunchAgent's `EnvironmentVariables`, then reload the agent.
For a foreground run, use `CLAUDE_LOCAL_API_CONCURRENCY=10 claude-local-api`.

## Local reuse and usage

Caching and duplicate sharing are on by default for supported requests to both POST endpoints.
These headers override each option for one request:

| Header | Effect |
| --- | --- |
| `x-local-cache: false` | Generate a new response instead of reading or writing the ten-minute cache. |
| `x-local-coalesce: false` | Run a separate call instead of sharing a pending duplicate. |

Omit both headers to use caching and sharing. Set both to `false` when each request needs a new,
independent answer. Set either to `true` to require that option. Neither option changes upstream prompt caching.

The cache key includes the endpoint and exact request body bytes. Whitespace, field order, model,
effort, system text, output limits, history, and schema changes produce different keys. Cache lookup and
sharing occur before queue admission or subprocess startup. Only non-streaming, stateless text or JSON
requests use reuse by default. Streaming, saved sessions, tools, images, and non-text history bypass
reuse. Explicitly setting either header to `true` for these unsupported requests returns HTTP 400. Only successful responses with `stop_reason: "end_turn"` enter the cache.

The in-memory cache holds at most 32 MiB of serialized responses and keys, and 1,024 entries.
It removes the least recently used entries when full and removes expired entries on cache access or
usage reads. There is no background timer or disk cache. Restart clears the cache and counters.
Shared calls allow up to 32 additional waiting clients. A disconnect cancels only that client's wait;
the Claude process stops when all its clients disconnect. Failed calls are removed and are never cached.

Non-streaming responses include `x-local-reuse`: `bypass`, `miss`, `hit`, or `shared`.
A reused response retains its original message ID, token usage, and generation duration. The HTTP
`request-id` stays unique. Do not sum reused response usage to calculate new upstream work.

`GET /v1/usage` requires the local key and reports totals since server startup:

- `claude_processes`: generation subprocesses started; excludes the startup login check.
- `model_calls`: model messages observed in upstream streams. One subprocess can make several calls.
- `failed_processes`: failed or cancelled generation subprocesses. A client that closes the stream after
  the answer ends does not count.
- Input/output tokens and upstream cache read/write tokens reported by Claude, counted once per process.
  Interrupted calls include only reported usage; these counters are not an account billing or quota report.
- `local_reuse`: hits, misses, shared calls, evictions, stored bytes, entries, and waiting clients.

To request independent answers with the Anthropic SDK:

```python
message = client.messages.create(
    model="claude-haiku-5-5",
    max_tokens=128,
    messages=[{"role": "user", "content": "Name a primary color."}],
    extra_headers={"x-local-cache": "false", "x-local-coalesce": "false"},
)
```

Live experiment, 2026-10-10, three identical short Haiku text requests:

| Mode | Claude processes | CPU seconds, user + system | Response time |
| --- | --- | --- | --- |
| Independent parallel calls | 3 | 1.67 | 2.63–2.99 s |
| One call, then two cache hits | 1 | 0.60 | First 2.72 s; hits 1 ms |
| Three parallel calls with sharing | 1 | 0.82 | 2.78 s each |

CPU was measured with macOS `/usr/bin/time -lp`, including proxy startup, the login check, and child
processes. This small sample shows avoided work; it does not predict savings for unique requests.
Both reuse options and usage counters were kept. Reuse is enabled by default for supported requests as of 2026-10-12.

## Original prompt endpoint

`POST /v1/generate` remains available:

```sh
curl --fail-with-body http://127.0.0.1:8787/v1/generate \
  -H "Authorization: Bearer $(cat ~/.local/share/claude-local-api/token)" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-5-5","prompt":"Hello","effort":"low"}'
```

| Field | Use |
| --- | --- |
| `model`, `prompt` | Required model ID and non-empty text. |
| `system` | System prompt for an independent request or new saved session. |
| `stream` | `true` enables custom SSE events: `start`, `delta`, `result`, `error`. Use curl `-N`. |
| `save_session` | `true` creates a saved conversation. Default: `false`. |
| `session_id` | Resume a successful saved conversation returned by this endpoint. |
| `effort` | The five effort levels listed above. |
| `json_schema` | JSON Schema object, up to 64 KiB. Read the result from `structured_output`. |

The JSON response includes `model`, `text`, `usage`, `stop_reason`, `duration_ms`, and `session_id`.
Independent requests return `session_id: null`. A custom SSE stream succeeds only when it emits `result`.
Validation errors return HTTP JSON; failures after streaming starts use an `error` event.
The prompt endpoint accepts up to 1 MiB per request.

Create a saved conversation with `save_session: true`, then send its `session_id` on later calls.
Use the original model. Set `system` only on the first request and omit `save_session` when resuming.
Saved conversations survive restarts. Claude Code stores their prompts and responses under `~/.claude/projects`.
This saved-session option is separate from the SDK's stateless `messages` lists.

## Health and access

Every endpoint accepts the local key through `Authorization: Bearer ...` or `x-api-key`.
The key is in `~/.local/share/claude-local-api/token` with mode 0600. It is not your Claude OAuth token.
The server listens only on `127.0.0.1`.

- `GET /v1/models`: the three supported IDs in the custom `models` array.
- `GET /v1/health`: `active`, `queued`, `max_concurrency`, uptime, and features.
  This checks the local service, not upstream connectivity or remaining quota.

The wrapper removes inherited API credentials and provider environment variables. It excludes user, project,
and local settings files, and limits each call to its requested model with fallback disabled. Managed policy still applies.
It uses the existing Claude login, safe mode, and an empty built-in tool list. Only explicitly supplied client tool definitions are exposed.
Subscription limits and account extra-usage settings apply.

## Files and checks

- `server.mjs`: endpoints and Claude subprocess control.
- `anthropic.mjs`: Messages request validation, history import, and response translation.
- `queue.mjs`: concurrency and waiting requests.
- `reuse.mjs`: bounded response cache and shared-call cancellation.
- `sessions.json`: saved prompt-endpoint IDs and models, created on the first saved request.
- `server.log`: service output and errors. `CONTEXT.md`: implementation and validation notes.
- `~/.local/bin/claude-local-api`: launcher; uses the Node.js path set at install.
- `~/Library/LaunchAgents/local.claude-api.plist`: startup and restart settings.

Validated with Claude Code 2.1.296 and Anthropic Python SDK 1.11.0 (JSON, SSE, tools, structured output, reuse,
cancellation, and timeouts). `CONTEXT.md` records the checks. No test files are stored.

References: [Claude programmatic interface](https://code.claude.com/docs/en/headless),
[structured image input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
[subscription usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
