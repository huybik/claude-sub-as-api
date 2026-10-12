# Deploy the Claude local API (instructions for Claude)

You are deploying a small local HTTP server. It exposes an Anthropic-compatible `/v1/messages` endpoint at
`http://127.0.0.1:8787` and answers each call by running the user's Claude Code CLI with their Claude subscription.
`README.md` and `docs/reference.md` are the user guide. `CONTEXT.md` holds the implementation notes. Read them before you change anything.

Install directory: `~/.local/share/claude-local-api` (call it `INSTALL_DIR`). The server uses the directory that holds
`server.mjs` as its working directory and stores its files there.

## 1. Check prerequisites and stop on any failure

- **Node.js 22 or newer.** Run `node --version`, then record the absolute path from `command -v node`.
  With nvm, use the real version path, such as `~/.nvm/versions/node/v22.x.y/bin/node`, not a shim.
- **Claude Code on `PATH`.** The server runs `claude` through `PATH`. Record the directory from `command -v claude`.
  Claude Code must support the `claude-*-5-5` models. Run `claude --version`; the server was validated on 2.1.296.
- **Subscription login.** Run `claude auth status`. It must report `loggedIn: true`, `authMethod: "claude.ai"`, and
  `apiProvider: "firstParty"`. If any value differs, ask the user to run `claude auth login` and select their subscription.
  The server refuses to start without this login. It does not use API keys.
- **Port 8787 is free.** Run `lsof -nP -iTCP:8787 -sTCP:LISTEN`. If another process holds the port, ask the user before you continue.
  To use another port, add `CLAUDE_LOCAL_API_PORT` to the service environment and use that port in the steps below.

## 2. Copy the files

```sh
mkdir -p ~/.local/share/claude-local-api/docs ~/.local/bin
cp server.mjs anthropic.mjs cloud.mjs queue.mjs reuse.mjs README.md CONTEXT.md CHANGELOG.md ~/.local/share/claude-local-api/
cp docs/reference.md ~/.local/share/claude-local-api/docs/
```

Do not copy `DEPLOY.md` or `deploy/`. Do not create a `CLAUDE.md` in `INSTALL_DIR`.
Every Claude subprocess runs there, so a `CLAUDE.md` would add its text to every request.

The package does not include a `token` file. On the first start, the server creates a random local key in
`INSTALL_DIR/token` with mode 0600. If you redeploy over an existing install, keep its `token` and `sessions.json`.

## 3. Install the launcher

Copy `deploy/claude-local-api` to `~/.local/bin/claude-local-api`, then replace these placeholders with absolute paths:

- `__NODE__`: the Node.js binary from step 1.
- `__INSTALL_DIR__`: the expanded `~/.local/share/claude-local-api`.

Run `chmod 755 ~/.local/bin/claude-local-api`.

## 4. Start it as a service

For optional cloud mode, add `CLAUDE_LOCAL_API_CLOUD_ENVIRONMENT` with the user's existing Anthropic cloud environment
ID (`env_...`) to the service environment. Leave it unset for local-only use. Cloud mode is selected per request by
`x-local-backend: cloud`; it has a narrower contract documented in `docs/reference.md`.

### macOS (LaunchAgent)

Run `mkdir -p ~/Library/LaunchAgents`, then copy `deploy/local.claude-api.plist` to `~/Library/LaunchAgents/local.claude-api.plist`.
Replace `__HOME__`, `__INSTALL_DIR__`, and `__NODE_BIN_DIR__` (the directory that contains the Node.js binary).
If the `claude` directory from step 1 is not already in the plist `PATH`, add it.
launchd does not expand `~` or `$HOME`, so use absolute paths. Validate the file with `plutil -lint`, then load it:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.claude-api.plist
```

If `local.claude-api` is already loaded, apply updated code with `launchctl kickstart -k "gui/$(id -u)/local.claude-api"`.
A kickstart does not reread the plist. After a plist change, run `launchctl bootout "gui/$(id -u)/local.claude-api"`, then run the bootstrap command again.
The agent starts at login and restarts the server if it exits.

### Linux

Write an equivalent systemd user unit, such as `~/.config/systemd/user/claude-local-api.service`:
- `ExecStart`: the launcher path.
- `WorkingDirectory`: `INSTALL_DIR`.
- `Restart=always`.
- Output goes to the journal.

Enable it with `systemctl --user enable --now claude-local-api`.
Update the start, restart, and log commands in `INSTALL_DIR/docs/reference.md` to match. The server code itself is not macOS-specific.

### Foreground run

Use this instead of a service for a one-time check. If the service is loaded, stop it first so that port 8787 is free.
Run `~/.local/bin/claude-local-api`. It prints the base URL and the token path.

## 5. Verify the server

```sh
TOKEN=$(cat ~/.local/share/claude-local-api/token)
curl -sS --fail-with-body http://127.0.0.1:8787/v1/health -H "Authorization: Bearer $TOKEN"
curl -sS --fail-with-body http://127.0.0.1:8787/v1/generate -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'x-local-cache: false' -H 'x-local-coalesce: false' \
  -d '{"model":"claude-haiku-5-5","prompt":"Reply with OK.","effort":"low"}'
```

The health call must show `max_concurrency: 10`. The generate call must return JSON with `text`.
The generate call uses a small amount of the user's subscription usage. Do not run load or sweep tests unless the user asks.
On a failure, read `INSTALL_DIR/server.log` on macOS or `journalctl --user -u claude-local-api` on Linux.
Report the exact error. Do not work around it.

## 6. Report to the user

Report:
- The base URL.
- The token path.
- How to restart or stop the service.

Tell the user to point the Anthropic SDK at `base_url="http://127.0.0.1:8787"`, with `api_key` read from the token file,
`max_retries=0`, and `timeout=1800`. Also tell them that `README.md` lists the request fields that return HTTP 400, and `docs/reference.md` has the details.
