# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [SemVer](https://semver.org).

## Unreleased

- A profile can send its calls through a local proxy such as TeamClaude, as `teamclaude run --no-mitm` does:
  `{"base_url": "http://localhost:3456"}` in `profiles.json`, with an optional `config_dir`. Claude Code retries once
  there instead of ten times. While nothing accepts connections on the proxy's port, calls naming the profile fail at
  once with HTTP 502 and calls without `x-local-profile` move on. TeamClaude's 429s have no reset time Claude Code can
  report, so one holds the profile for one minute, and calls without `x-local-profile` move on.
- Calls without `x-local-profile` rotate across `profiles.json`: they stay on one profile until its subscription limit
  is reached, then move to the next with quota left. A call refused before its stream starts is retried there.
- A profile that is out of quota fails calls naming it at once with HTTP 429 and `retry-after`, without starting a process.
- `/v1/health` reports each profile's last quota report; `/v1/usage` adds per-profile token totals.
- Every profile's login is checked at startup instead of on first use. Profile names must start with a letter.
- A streaming `/v1/generate` response starts when the model's message starts; a failure before it is an HTTP error.
- `x-local-profile` selects a Claude subscription from `profiles.json`. `default` leaves `CLAUDE_CONFIG_DIR` unset. Cloud mode accepts only `default`.
- Response cache and request sharing keys include the profile. Saved `/v1/generate` sessions resume on the profile that started them.
- Fixed: a cache breakpoint on an image in the final user message cached nothing, since Claude Code rebuilds those
  images without it. The breakpoint now moves to the nearest text, tool use or tool result block before the image, in
  that message or an earlier one, so the prefix up to it caches; a request with none before the image returns HTTP 400.
- Fixed: after `/login` switched accounts, follow-up turns carried the old account's context and missed the cache
  until the service restarted. Each call now reads the profile's login and relearns the context when it changes.
- Each failed or cancelled process writes one line to the service log: time, profile, model, status and error.
- Optional cloud mode on `/v1/messages`, selected by `x-local-backend: cloud`. Supports one user turn, images,
  system text, effort, automatic cloud prompt caching, and buffered SSE. Unsupported controls return HTTP 400.
- Cloud sessions are archived on completion or cancellation. Usage counters distinguish cloud work from local work.
- Response cache and request sharing keys include the execution backend.
- Concurrency defaults to one call per GiB of RAM instead of 10. Neither the waiting list nor shared calls have a cap:
  calls wait for a slot instead of failing with HTTP 503 past 42 waiting calls or 32 sharers.

## [0.2.0] - 2026-10-12

### Added
- Prompt caching as on the Messages API: `cache_control` on message blocks (`5m` or `1h`), and top-level automatic caching.
- HTTP 400 for breakpoints the API or Claude Code can't take: more than four, `1h` after `5m`, or on `system` or `tools`.
- Short README, full [reference](docs/reference.md), and this changelog.

### Changed
- Only client breakpoints cache. Claude Code's own one-hour breakpoints are off, so **unmarked requests are no longer cached**.
- Tool-result turns resume the interrupted turn instead of sending an empty prompt.

### Fixed
- Follow-up turns read the earlier turns from the cache; before, they wrote the whole conversation again.
- Tool-result turns no longer get a fake "No response requested." assistant reply.
- `failed_processes` no longer counts streamed calls that succeeded.

Measured with Haiku 5.5: 97% of the prompt read from the cache on shared-prefix, follow-up, and tool turns.

## [0.1.0] - 2026-10-12

### Added
- First release. Anthropic-compatible `POST /v1/messages` with streaming, tools, images, structured output, and effort.
- `POST /v1/generate` with saved sessions; `/v1/health`, `/v1/usage`, and `/v1/models`.
- 10-call queue, local response cache, a local key, a LaunchAgent, and a DEPLOY.md written for Claude Code.

[0.2.0]: https://github.com/huybik/claude-sub-as-api/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/huybik/claude-sub-as-api/releases/tag/v0.1.0
