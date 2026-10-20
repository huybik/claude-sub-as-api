# Reference

Full details for [claude-sub-as-api](../README.md): request fields, errors, prompt caching, local reuse,
configuration, security, and troubleshooting.

## API reference

### `POST /v1/messages`

The table below describes local mode, the default. Set `x-local-backend: cloud` for the narrower cloud contract below.

| Field | Support |
| --- | --- |
| `model`, `max_tokens`, `messages` | Required. Output limit: 1–128,000 tokens. |
| `messages[].role` | `user`, `assistant`, and text-only `system` notes. After system notes are removed, the list must start and end with `user`. |
| `messages[].content` | Text, text blocks, base64 images, assistant tool calls, user tool results, and signed thinking blocks. |
| `system` | Text or a list of text blocks, including an empty list. |
| `stream` | Anthropic SSE events, including tool argument fragments. |
| `tools` | Client tools with `name`, optional `description`, and `input_schema`. |
| `tool_choice` | `auto` or `none`. |
| `output_config.effort` | `low`, `medium`, `high`, `xhigh`, or `max`. |
| `output_config.format` | `{"type":"json_schema","schema":{...}}`. The JSON result is returned as a text block. |
| `thinking` | `{"type":"adaptive"}`. Omit it for the model default. |
| `cache_control` | On a message content block, or top-level for automatic caching. See [Prompt caching](#prompt-caching). |

Details:

- **Images.** Use `{"type":"base64","media_type":"image/png","data":"..."}`. PNG, JPEG, GIF, and WebP are accepted,
  up to 5 MiB per image and 32 MiB per request.
- **History.** Earlier user and assistant blocks are loaded through a temporary Claude Code transcript, which is
  removed after the call.
- **Tool results.** A final user message with tool results is loaded into the transcript too, and Claude Code resumes
  the turn those results answer. It adds one short meta note after them: "Continue from where you left off."
- **Tool rules.** Return every pending tool result before other user content. Adjacent messages with the same role are
  merged, and an empty tool result is allowed.
- **SDK objects.** Tool blocks accept `caller: {"type":"direct"}` or a missing or null caller, and a missing or null
  `toolset_name`. Empty text citations (`null` or `[]`) are accepted.
- **`system` messages** are a local extension. Their text is appended to the top-level system prompt in message order,
  with system priority; their positions among user and assistant messages are not kept.
- **Structured output.** Send `output_config.format` on each call. The JSON is emitted when the result is complete,
  even with `stream: true`. Claude Code validates the schema but does not enforce `format` annotations such as `email`.
  Schemas are limited to 64 KiB.

### Cloud mode (experimental)

Set `CLAUDE_LOCAL_API_CLOUD_ENVIRONMENT=env_...` to an existing Anthropic-hosted cloud environment and reload the
service. Requests select `x-local-backend: local` (default) or `x-local-backend: cloud`. The response repeats that
header. Other values, and cloud mode on `/v1/generate`, return HTTP 400. Without the environment setting, cloud
requests return HTTP 503; the service never changes to local execution or an API key.

| Feature | Cloud behavior |
| --- | --- |
| Text and base64 images | One user turn after normal role merging. Same image and request size limits as local mode. |
| System text | Sent as the session's custom system prompt. The cloud worker can add its own instructions. |
| Model and effort | Requested model and effort are sent in session configuration. Reply model and worker output capacity are checked. |
| `max_tokens` | Must be `128000`, the worker's output capacity. Per-request environment variables are disabled upstream, so smaller limits return HTTP 400. |
| JSON response | Actual assistant text and thinking blocks, message ID, stop reason, and reported token usage. |
| `stream: true` | Buffered Anthropic SSE after completion and archive, including thinking signatures. This is not live token streaming. |
| Prompt cache | Automatic cloud worker caching. Usage includes real cache read/write counts. Client breakpoints and TTLs return HTTP 400. |
| Local response cache and request sharing | Enabled for eligible requests. Backend, profile, endpoint, and exact body bytes form the key. |
| History, tools, structured output | HTTP 400. No history flattening, simulated tool calls, or prompt-based schema enforcement. |

Each cache miss creates a fresh session with no repository or connectors, all tools denied, and one model turn.
The adapter checks that the worker reports an empty tool list and that the session contains only its own user turn.
It reads the session event log and archives the session before returning the reply. Its slot stays occupied
through cleanup. Disconnect, shutdown, or the twenty-minute deadline also causes archive. An archive failure returns
HTTP 502 with the session URL so you can stop it. Creation is not retried: if its response is lost, check
`claude.ai/code` for an unfinished **Local API request** before sending another request.

Cloud mode reads the default Claude Code OAuth login from the macOS **Claude Code-credentials** Keychain item,
or `~/.claude/.credentials.json` on Linux. It does not save or log the token and sends it only to
`https://api.anthropic.com`. A non-default `x-local-profile` returns HTTP 400. If the login expires, run
`claude auth login` and restart the service. All cloud input and replies remain in the archived cloud transcript;
they are not deleted from the account.

The cloud session API is undocumented and may change. Promotional cloud credits apply only while eligible credits
remain; after that, your plan limits and account extra-usage settings apply. The adapter cannot select a billing pool
or enforce a credits-only spending limit. See [Anthropic's credit rules](https://support.claude.com/en/articles/17152539-cloud-sessions-bonus-credit-promotion).

`/v1/health.cloud` describes configuration and limits. `/v1/usage.cloud` reports cloud sessions, completed model calls,
failed requests, observed promotional calls, reported cost, and tokens. Local process counters remain separate.
These counters reset at restart; cache hits and shared callers do not count as new cloud work. An interrupted
request can incur upstream usage before a result is available, so these counters are not a billing ledger.

### `POST /v1/generate`

A simpler prompt endpoint, with optional saved conversations:

```sh
curl --fail-with-body http://127.0.0.1:8787/v1/generate \
  -H "Authorization: Bearer $(cat ~/.local/share/claude-local-api/token)" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-5-5","prompt":"Hello","effort":"low"}'
```

| Field | Use |
| --- | --- |
| `model`, `prompt` | Required model ID and non-empty text. |
| `system` | System prompt for an independent request or a new saved session. |
| `stream` | `true` enables custom SSE events: `start`, `delta`, `result`, `error`. Use curl `-N`. |
| `save_session` | `true` creates a saved conversation. Default: `false`. |
| `session_id` | Resume a saved conversation returned by this endpoint. |
| `effort` | One of the five effort levels. |
| `json_schema` | JSON Schema object, up to 64 KiB. Read the result from `structured_output`. |

- **Response:** JSON with `model`, `text`, `usage`, `stop_reason`, `duration_ms`, and `session_id` (`null` for
  independent requests).
- **Streaming:** a stream succeeds only when it emits `result`. Failures after the stream starts arrive as an `error`
  event.
- **Size:** at most 1 MiB per request.
- **Saved sessions:**
  - They survive restarts. Claude Code stores them under `~/.claude/projects`.
  - When resuming, use the original model and omit `system` and `save_session`.

### Other endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /v1/health` | `status`, `active`, `queued`, `max_concurrency`, uptime, features, and `quota`: the current profile, and for each profile the last `rate_limit_info` Claude Code reported with when its spent scopes reset. It makes no upstream call. |
| `GET /v1/usage` | Totals since startup: processes, model calls, failed processes, input/output and cache tokens (also per profile under `profiles`), local reuse counters. |
| `GET /v1/models` | The three model IDs in a custom `models` array (not the SDK's model-list shape). |

`failed_processes` counts failed or cancelled processes. A client that closes the stream after the answer ends does
not count. Each one also writes a line to the service log with its time, profile, model, status and error. These
counters are not a billing or quota report.

### Errors

Errors on `/v1/messages` use the Anthropic error shape: `{"type":"error","error":{"type","message"},"request_id"}`.

| Status | Meaning |
| --- | --- |
| 400 | Invalid or unsupported request field. The message names the field. |
| 401 | Missing or wrong local key. |
| 404 | Unknown endpoint or saved session. |
| 413 | Request body over 32 MiB (`/v1/messages`) or 1 MiB (`/v1/generate`). |
| 415 | Content type is not `application/json`. |
| 429 | Every profile the call may use is out of quota, or upstream refused it with another rate limit. `retry-after` gives the seconds until a known reset. |
| 502 | Claude Code failed or returned something unexpected. Upstream request errors also arrive as 502. |
| 503 | The service is stopping, or cloud mode is not configured. |
| 504 | The call ran past the twenty-minute limit. |

## Prompt caching

In local mode, `/v1/messages` caches what a request marks, as the Messages API does. Cache reads cost a fraction of normal input,
so marking a shared prefix is the biggest lever on subscription usage.

- **Block breakpoints.** Put `cache_control: {"type": "ephemeral"}` on a text, image, tool use, or tool result block in
  `messages`, including blocks inside a tool result. The cached prefix runs from the tools and system prompt through
  that block.
- **Images in the final user message.** Claude Code rebuilds each image it reads on stdin without its `cache_control`,
  so a breakpoint on such an image moves to the nearest text, tool use or tool result block before it, in that message
  or an earlier one: the prefix up to the image caches, the image does not. A request with no such block before the
  image returns HTTP 400. Images in earlier turns, and in a final message of tool results, keep their breakpoints.
- **Automatic caching.** Set top-level `cache_control`. It marks the last block of the final user message, so the next
  turn of a conversation reads everything before its new content. Where that block is an image, the mark moves back as
  above.
- **TTL.** `ttl` is `5m` (the default) or `1h`. A request holds at most four breakpoints, and a `1h` breakpoint must
  come before every `5m` one. If the last block already has a breakpoint, top-level `cache_control` must use the same
  TTL. Other requests return HTTP 400.
- **Unmarked requests are not cached.** Claude Code's own breakpoints are off for this endpoint
  (`DISABLE_PROMPT_CACHING`). They wrote every prompt with a one-hour TTL, at twice the input rate, even when nothing
  read it again, and they used two or three of the four breakpoints.
- **System and tool breakpoints return HTTP 400.** Claude Code builds the system prompt and the tool list, so neither
  can hold a breakpoint. A message breakpoint still caches them as part of its prefix.

```python
shared = [{"type": "text", "text": long_document, "cache_control": {"type": "ephemeral"}}]
for question in questions:   # the first call writes the prefix; the rest read it
    client.messages.create(model="claude-sonnet-5-5", max_tokens=1024,
                           messages=[{"role": "user", "content": [*shared, {"type": "text", "text": question}]}])
```

**Follow-up turns.** Claude Code puts your account context (your email address) in front of the first prompt of a
session. On a follow-up, the adapter puts that context back after the first message, where the conversation's first
call had it. The follow-up's prompt then starts with the same bytes and reads that call's cache.
- **Learning the context.** The adapter learns it from the transcript of a profile's first call on each login, then
  deletes that transcript. That first call can miss the cache once.
- **Login changes.** Every call reads the profile's current login (`oauthAccount.emailAddress` in its `.claude.json`).
  After `/login` switches accounts, the next call learns the new context instead of reusing the old account's.

**Measured on 2026-10-12** with Haiku 5.5 at low effort and a 15K-token prefix with a five-minute TTL:

| Call | Cache write | Cache read | Read share |
| --- | ---: | ---: | ---: |
| First call | 15,170 | 0 | 0% |
| Second call, same prefix, different question | 13 | 15,157 | 97.6% |
| Follow-up turn of the first call | 21 | 15,170 | 97.5% |
| Tool result turn after a tool call | 38 | 15,608 | 97.4% |

A separate live run used one call to write a shared prefix, four parallel calls to read it, and one follow-up. Together
they read **81.4%** of all input from the cache. In 0.1.0, each of these calls wrote its whole prompt to the cache.

## Concurrency and local reuse

- **Concurrency.** **One call runs at once per GiB of RAM** (48 on a 48 GB Mac), shared by both POST endpoints.
  A Claude Code process holds about 250 MB, so a full load stays out of swap. Further calls wait for a free slot,
  and time spent waiting counts toward the client's timeout. A waiting call keeps its request body in the server's
  memory, so don't hold hundreds of large image requests in flight at once.
- **Saved sessions.** Calls that resume the same saved session run in order.
- **Timeouts.** Each process has a twenty-minute limit. A client disconnect cancels its call. A process that ignores
  termination is killed after one second. Set the SDK `timeout` to 1800 s: its 600 s default is shorter, and without
  an explicit timeout, a non-streaming call with a large `max_tokens` is refused by the SDK.

**Local reuse** is separate from prompt caching. It skips the model entirely for repeated non-streaming, stateless
text or JSON requests:

| Header | Effect |
| --- | --- |
| `x-local-cache: false` | Generate a new response instead of reading or writing the ten-minute response cache. |
| `x-local-coalesce: false` | Run a separate call instead of sharing an identical call already in flight. |

- **Key.** Execution backend, profile, endpoint, and exact request body bytes. Local and cloud calls never share an entry, and neither do two profiles.
- **Limits.** 32 MiB, 1,024 entries, least recently used eviction, memory only. Only `end_turn` responses are stored.
- **Bypassed:** streaming, saved sessions, tools, and any non-text block. Setting either header to `true` on those
  returns HTTP 400.
- **Response header.** Non-streaming responses carry `x-local-reuse`: `bypass`, `miss`, `hit`, or `shared`.
  A reused body keeps its original message ID and usage, so don't add it to totals of new work.
- **Independent answers.** Set both headers to `false`, for example in evaluation runs:

```python
client.messages.create(..., extra_headers={"x-local-cache": "false", "x-local-coalesce": "false"})
```

## Configuration and service

| Variable | Default | Effect |
| --- | --- | --- |
| `CLAUDE_LOCAL_API_PORT` | `8787` | Listening port on `127.0.0.1`. |
| `CLAUDE_LOCAL_API_CONCURRENCY` | GiB of RAM | Calls that run at once. |
| `CLAUDE_LOCAL_API_CLOUD_ENVIRONMENT` | Unset | Enables opt-in cloud requests in the specified `env_...` environment. |

### Profiles

`profiles.json`, next to `server.mjs`, maps a name to a Claude Code config directory. The server creates it on first start with `{"default": null}` and mode 0600. `default` leaves `CLAUDE_CONFIG_DIR` unset so Claude uses `~/.claude`. Any other value is an absolute directory. The file stays on the machine: a redeploy keeps it, like `token` and `sessions.json`. An unknown name in `x-local-profile` returns HTTP 400. The response's `x-local-profile` names the profile that served the call. A response reused from the local cache or shared with an identical call names none unless the request named one.

```python
client.messages.create(..., extra_headers={"x-local-profile": "claude-p"})
```

The server checks a non-default profile's `claude auth status` on first use and keeps that result until restart. Safe mode still ignores that profile's settings, MCP servers, and `CLAUDE.md`. The profile chooses which subscription is billed. Each profile keeps its own account-context announcement, so follow-up transcripts match that login. A saved `/v1/generate` session resumes only on the profile that created it, with or without the header. Sessions saved before profiles existed resume on `default`.

Restart the service after editing `profiles.json`.

**Quota.** Each Claude Code process reports its subscription's limits in a `rate_limit_event`. The server keeps each
profile's last report, keyed by that profile's login, so a `/login` to another account starts over.

- **A profile is out of quota** when a call is refused (`status: "rejected"` without extra usage). It stays out until
  the reported reset time. A weekly cap on one model family (`seven_day_opus`, `seven_day_sonnet`) blocks only that family.
- **Calls without `x-local-profile`** use the current profile, which starts as the first in `profiles.json`. When the
  current profile is out of quota, it moves to the first profile in file order that has quota left. Staying on one
  profile keeps prompt caches warm, since a cache belongs to one account. A profile last seen running on paid extra usage
  is used only when no other profile has plan quota. A call refused before its stream started is retried on the next
  profile; one refused after it started returns the error. Each move writes one line to the service log.
- **Calls that name a profile** never move. While that profile is out of quota, they return HTTP 429 with
  `retry-after` without starting a process.
- **Recovery.** If you raise a spend limit or log a spent profile in again before its reset, restart the service.

Set the variables above in the LaunchAgent's `EnvironmentVariables` or the systemd unit, then reload the service.

macOS service commands (the `local.claude-api` LaunchAgent starts at login and restarts the server if it exits):

```sh
launchctl kickstart -k "gui/$(id -u)/local.claude-api"                     # restart, e.g. after an update
launchctl bootout "gui/$(id -u)/local.claude-api"                          # stop until next login
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.claude-api.plist   # start again
```

**Update.** Pull the repository, repeat DEPLOY.md step 2 to copy the files, then restart. Keep the installed
`token`, `profiles.json`, and `sessions.json`.

**Service logs.** `~/.local/share/claude-local-api/server.log` (macOS) or `journalctl --user -u claude-local-api` (Linux).

**Foreground run.** Stop the service, then run `claude-local-api`; it logs to the terminal.

**Turn off autostart.** Stop the service, then move `local.claude-api.plist` out of `~/Library/LaunchAgents`.

## Security

- **Local only.** The server listens on `127.0.0.1` only.
- **Local key.** Every endpoint needs it as `Authorization: Bearer …` or `x-api-key`. The key lives in
  `~/.local/share/claude-local-api/token` (mode 0600) and is not your Claude OAuth token.
- **What each Claude Code process gets:**
  - Your existing login, in safe mode, with no built-in tools.
  - No user, project, or local settings files.
  - Inherited API keys and provider variables removed.
  - Only the requested model, with fallback off.
- **Tools.** Only the client tool definitions you send are exposed, and your application runs them. The server never
  runs shell or file tools.
- **Policy and limits.** Managed policy, subscription limits, and your account's extra-usage settings still apply.
- **Transcripts.** Local `/v1/messages` keeps no transcripts. The exception is the calls that run before the account context
  is known, normally just the first call after a start: the adapter reads their transcript, then deletes it.
  Claude Code keeps saved `/v1/generate` sessions.
- **Cloud execution.** Cloud requests use an Anthropic-hosted worker with all tools denied and no repository or
  connectors. Cloud settings and instructions still apply. Archived cloud transcripts remain in your account.

## Limitations

- **Not supported (HTTP 400).** Any field not in the tables above, including:
  - a final assistant message (prefill), image URLs, and PDF and document blocks,
  - `metadata`, custom `stop_sequences`, `service_tier`, and `inference_geo`,
  - forced `tool_choice`, `disable_parallel_tool_use`, and tool fields such as `strict`, `type`, `defer_loading`, and
    `input_examples`,
  - client tools combined with structured output,
  - temperatures other than the default `1`,
  - `thinking` with `enabled`, `budget_tokens`, or `display`,
  - disabled thinking. Claude Code 2.1.296 still used thinking tokens with thinking disabled, even on Haiku at low
    effort; use `output_config.effort` instead. A small `max_tokens` can end during thinking, before any text.
- **Not implemented:** server tools, token counting, batches, or an SDK-shaped model list.
- **Context management stays with Claude Code.** This adapter does not implement the full Anthropic platform API.

Unsupported input fails explicitly; it is never silently converted to different behavior.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Service won't start; log says "Run claude auth login…" | Run `claude auth login`, choose your subscription, then restart the service. |
| `401 Invalid local API token` | Read the key from `~/.local/share/claude-local-api/token`; don't use an Anthropic API key. |
| `429` errors | The profiles the call may use are out of quota; `/v1/health` shows when each resets. Add a profile, wait for the reset, or restart after raising a limit. The server never falls back to a paid API. |
| Cache reads stay at 0 | Mark a block with `cache_control`, or set top-level `cache_control`. |
| Port 8787 in use | Stop the other process, or set `CLAUDE_LOCAL_API_PORT`. |

## Project layout

| Path | Role |
| --- | --- |
| `server.mjs` | HTTP endpoints and Claude Code subprocess control. |
| `anthropic.mjs` | Messages validation, history transcripts, and response translation. |
| `queue.mjs` | Concurrency limit, waiting requests, and saved-session order. |
| `reuse.mjs` | Local response cache and shared in-flight calls. |
| `quota.mjs` | Each profile's reported quota, and the profile a call without `x-local-profile` uses. |
| `cloud.mjs` | Cloud validation, OAuth access, session lifecycle, replies, and buffered SSE. |
| `deploy/` | Launcher script and LaunchAgent template. |
| [`DEPLOY.md`](../DEPLOY.md) | Install steps, written for Claude Code to follow. |
| [`CONTEXT.md`](../CONTEXT.md) | Implementation and validation notes. |
| [`CHANGELOG.md`](../CHANGELOG.md) | Release history. |

Installed files: `~/.local/share/claude-local-api/` (code, `token`, `sessions.json`, `server.log`),
`~/.local/bin/claude-local-api`, and `~/Library/LaunchAgents/local.claude-api.plist`.

Validated with Claude Code 2.1.296 and the Anthropic Python SDK 1.11.0: JSON, SSE, tools, structured output, prompt
caching, local reuse, cancellation, and timeouts. [CONTEXT.md](../CONTEXT.md) records the checks.

**Contributing.** Issues and pull requests are welcome. Keep the zero-dependency design, run `node --check` on changed
files, and describe any live checks in the pull request. Live checks use real subscription usage, so keep them small.
