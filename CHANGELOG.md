# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [SemVer](https://semver.org).

## Unreleased

- `x-local-profile` selects a Claude subscription from `profiles.json`. `default` leaves `CLAUDE_CONFIG_DIR` unset. Cloud mode accepts only `default`.
- Response cache and request sharing keys include the profile. Saved `/v1/generate` sessions resume on the profile that started them.
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
