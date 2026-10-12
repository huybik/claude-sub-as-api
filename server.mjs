import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RequestQueue } from './queue.mjs';
import { ResponseReuse, reuseOptions } from './reuse.mjs';
import { AnthropicMessage, anthropicError, prepareAnthropic, toolControl, validateAnthropic } from './anthropic.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const claude = 'claude';
const models = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const sessionsPath = join(directory, 'sessions.json');
const sessions = existsSync(sessionsPath) ? JSON.parse(readFileSync(sessionsPath, 'utf8')) : {};
const port = Number(process.env.CLAUDE_LOCAL_API_PORT ?? 8787);
const tokenPath = join(directory, 'token');
if (!existsSync(tokenPath)) {
  writeFileSync(tokenPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
}
chmodSync(tokenPath, 0o600);
const token = readFileSync(tokenPath, 'utf8').trim();
if (!token) throw new Error(`The local API token is empty: ${tokenPath}`);

// Use the existing Claude login. Do not inherit API credentials or providers.
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDECODE$)/.test(name)) delete env[name];
}
const options = { cwd: directory, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 1_200_000 };
const { stdout } = await promisify(execFile)(claude, ['--setting-sources', '', 'auth', 'status'], options);
const auth = JSON.parse(stdout);
if (!auth.loggedIn || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty') {
  throw new Error('Run claude auth login and select your Claude subscription first.');
}

const queue = new RequestQueue(Number(process.env.CLAUDE_LOCAL_API_CONCURRENCY ?? 10));
const activeCalls = new Set();
const reuse = new ResponseReuse();
const usage = { started_at: new Date().toISOString(), claude_processes: 0, model_calls: 0, failed_processes: 0,
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const tokenFields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
function addTokens(target, source) {
  for (const key of tokenFields) target[key] = (target[key] ?? 0) + (source?.[key] ?? 0);
}
function reply(response, status, data) {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
function event(response, name, data) {
  if (response.destroyed) return;
  response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Parse one output format for both normal responses and streaming responses.
function runClaude(args, prompt, signal, onText, bridge = {}) {
  signal.throwIfAborted();
  usage.claude_processes++;
  return new Promise((resolve, reject) => {
    let pending = '', stderr = '';
    let result, messageUsage;
    const streamUsage = {};
    let failure, killTimer;
    let stopping = false, closed = false;
    const child = spawn(claude, args, { cwd: directory,
      env: { ...env, ...(bridge.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(bridge.maxTokens) } : {}) } });
    function stop(error) {
      failure ??= error;
      if (stopping || closed) return;
      stopping = true;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    }
    const cancel = () => stop(signal.reason ?? fail(503, 'The service is stopping.'));
    const timeout = setTimeout(() => stop(fail(504, 'Claude exceeded the twenty-minute execution limit.')), options.timeout);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    function consume(line) {
      if (!line.trim() || stopping) return;
      try {
        const message = JSON.parse(line);
        if (message.type === 'stream_event' && !message.parent_tool_use_id) {
          const event = message.event;
          if (event?.type === 'message_start') { usage.model_calls++; messageUsage = { ...event.message.usage }; }
          if (event?.type === 'message_delta' && messageUsage) Object.assign(messageUsage, event.usage);
          if (event?.type === 'message_stop' && messageUsage) { addTokens(streamUsage, messageUsage); messageUsage = undefined; }
        }
        if (message.type === 'control_response' && message.response.request_id === 'local-init') {
          if (message.response.subtype !== 'success') throw fail(502, message.response.error || 'Claude initialization failed.');
          send(bridge.userMessage);
        }
        if (message.type === 'control_request') {
          const response = toolControl(message.request, bridge.tools ?? []);
          if (response) send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
        }
        if (message.type === 'result') {
          result = message;
          if (bridge.userMessage) child.stdin.end();
        }
        if (message.type === 'stream_event' && !message.parent_tool_use_id && bridge.capture) {
          if (bridge.capture.accept(message.event)) stop();
        }
        if (message.type === 'stream_event' && !message.parent_tool_use_id && message.event?.delta?.type === 'text_delta') {
          onText(message.event.delta.text);
        }
      } catch (error) {
        stop(error.status ? error : fail(502, 'Claude returned invalid stream JSON.'));
      }
    }
    activeCalls.add(cancel);
    signal.addEventListener('abort', cancel, { once: true });
    child.on('error', error => stop(fail(502, `Cannot run Claude: ${error.message}`)));
    child.on('close', (code, exitSignal) => {
      closed = true;
      consume(pending);
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', cancel);
      activeCalls.delete(cancel);
      if (messageUsage) addTokens(streamUsage, messageUsage);
      addTokens(usage, result?.usage ?? streamUsage);
      if (failure) { usage.failed_processes++; return reject(failure); }
      if (bridge.capture?.complete) return resolve(bridge.capture.message);
      if (!result || code !== 0 || result.is_error || result.subtype !== 'success') {
        usage.failed_processes++;
        const message = result?.result || result?.errors?.join('\n') || stderr.trim() || `Claude ended without a successful result (${exitSignal ?? code}).`;
        const status = result?.api_error_status === 429 ? 429 : message.includes('--json-schema is not a valid JSON Schema') ? 400 : 502;
        return reject(fail(status, message));
      }
      resolve(result);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (stopping) return;
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        consume(line);
      }
    });
    child.stdin.on('error', error => {
      if (!stopping && !result) stop(fail(502, `Cannot send input to Claude: ${error.message}`));
    });
    if (signal.aborted) { cancel(); return; }
    if (bridge.userMessage) send({ type: 'control_request', request_id: 'local-init', request: {
      subtype: 'initialize', hooks: {}, skills: [], systemPrompt: [bridge.system], systemPromptSnapshot: false,
    } });
    else child.stdin.end(prompt);
  });
}

function baseArgs(model, tools = []) {
  const mcpServers = tools.length ? { client: { type: 'sdk', name: 'client' } } : {};
  return ['-p', '--safe-mode', '--setting-sources', '',
    '--settings', JSON.stringify({ availableModels: [model], fallbackModel: [], switchModelsOnFlag: false }),
    '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers }),
    '--model', model, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
}

async function messagesRequest(input, response, signal, requestID) {
  const prepared = prepareAnthropic(input, directory);
  const emit = data => {
    if (!input.stream || response.destroyed) return;
    if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'request-id': requestID });
    event(response, data.type, data);
  };
  try {
    const args = [...baseArgs(input.model, input.tools), ...prepared.args, '--permission-prompt-tool', 'stdio'];
    const capture = input.schema ? undefined : new AnthropicMessage(input.model, input.tools, emit);
    const result = await runClaude(args, '', signal, () => {}, {
      userMessage: prepared.userMessage, system: input.system, tools: input.tools, maxTokens: input.max_tokens, capture,
    });
    let message;
    if (capture?.complete) message = capture.message;
    else {
      if (!input.schema || result.structured_output === undefined) throw fail(502, 'Claude did not return the requested message.');
      const usedModels = Object.keys(result.modelUsage ?? {});
      if (usedModels.length !== 1 || usedModels[0] !== input.model) throw fail(502, 'Claude returned an unexpected model.');
      const text = JSON.stringify(result.structured_output);
      const usage = Object.fromEntries(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].filter(key => result.usage[key] !== undefined).map(key => [key, result.usage[key]]));
      message = { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: input.model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage };
      emit({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      emit({ type: 'message_stop' });
    }
    if (input.stream) response.end();
    return message;
  } finally { prepared.cleanup(); }
}

async function generateRequest(input, response, signal) {
  let cleanup;
  try {
    const sessionID = input.session_id ?? (input.save_session ? randomUUID() : null);
    const args = baseArgs(input.model);
    if (input.session_id) args.push('--resume', sessionID);
    else if (sessionID) args.push('--session-id', sessionID);
    else args.push('--no-session-persistence');
    if (input.system !== undefined) {
      const folder = mkdtempSync(join(directory, 'request-'));
      cleanup = () => rmSync(folder, { recursive: true, force: true });
      const systemPath = join(folder, 'system.txt');
      writeFileSync(systemPath, input.system, { mode: 0o600 });
      args.push('--system-prompt-file', systemPath);
    }
    if (input.effort !== undefined) args.push('--effort', input.effort);
    if (input.json_schema !== undefined) args.push('--json-schema', JSON.stringify(input.json_schema));
    if (input.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      event(response, 'start', { model: input.model, session_id: sessionID });
    }
    const result = await runClaude(args, input.prompt, signal, text => {
      if (input.stream) event(response, 'delta', { text });
    });
    const usedModels = Object.keys(result.modelUsage ?? {});
    if (usedModels.length !== 1 || usedModels[0] !== input.model) {
      throw fail(502, `Claude reported an unexpected model: ${usedModels.join(', ')}.`);
    }
    if (sessionID && result.session_id !== sessionID) throw fail(502, 'Claude returned an unexpected session ID.');
    if (input.json_schema !== undefined && result.structured_output === undefined) {
      throw fail(502, 'Claude did not return the requested structured output.');
    }
    if (input.save_session) {
      const saved = { ...sessions, [sessionID]: { model: input.model } };
      writeFileSync(`${sessionsPath}.tmp`, JSON.stringify(saved) + '\n', { mode: 0o600 });
      renameSync(`${sessionsPath}.tmp`, sessionsPath);
      sessions[sessionID] = saved[sessionID];
    }
    const data = {
      model: input.model, text: result.result ?? '', usage: result.usage,
      stop_reason: result.stop_reason, duration_ms: result.duration_ms,
      session_id: sessionID,
      ...(input.json_schema !== undefined ? { structured_output: result.structured_output } : {}),
    };
    if (input.stream) {
      event(response, 'result', data);
      response.end();
    }
    return data;
  } finally { cleanup?.(); }
}

const server = createServer(async (request, response) => {
  const path = request.url.split('?')[0];
  const anthropic = path === '/v1/messages';
  const requestID = `req_${randomUUID().replaceAll('-', '')}`;
  if (anthropic) response.setHeader('request-id', requestID);
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort();
  response.on('close', cancel);
  request.on('aborted', cancel);
  try {
    if (request.headers.authorization !== `Bearer ${token}` && request.headers['x-api-key'] !== token) throw fail(401, 'Invalid local API token.');
    if (request.method === 'GET' && path === '/v1/models') {
      return reply(response, 200, { models });
    }
    if (request.method === 'GET' && path === '/v1/usage') {
      return reply(response, 200, { ...usage, local_reuse: reuse.stats() });
    }
    if (request.method === 'GET' && path === '/v1/health') {
      return reply(response, 200, {
        status: 'ok', busy: queue.active > 0, active: queue.active, queued: queue.waiting.length,
        max_concurrency: queue.limit, uptime_seconds: Math.floor(process.uptime()),
        features: ['streaming', 'sessions', 'structured_output', 'effort', 'anthropic_messages', 'images', 'client_tools', 'request_queue', 'usage', 'response_cache', 'request_coalescing'],
      });
    }
    if (request.method !== 'POST' || !['/v1/generate', '/v1/messages'].includes(path)) throw fail(404, 'Unknown endpoint.');
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
      throw fail(415, 'Send Content-Type: application/json.');
    }
    let body = '';
    let bytes = 0;
    request.setEncoding('utf8');
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > (anthropic ? 32 : 1) * 1024 * 1024) throw fail(413, `Request exceeds ${anthropic ? 32 : 1} MiB.`);
      body += chunk;
    }
    let input;
    try { input = JSON.parse(body); } catch { throw fail(400, 'Invalid JSON.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Send a JSON object.');
    async function execute(input) {
      const settings = reuseOptions(request.headers, path, body, input);
      const result = await reuse.run(settings, signal, async workSignal => {
        const release = await queue.acquire(workSignal, input.session_id);
        try {
          workSignal.throwIfAborted();
          return await (anthropic ? messagesRequest(input, response, workSignal, requestID) : generateRequest(input, response, workSignal));
        } finally { release(); }
      });
      if (!response.headersSent) response.setHeader('x-local-reuse', result.source);
      return result.data;
    }
    if (anthropic) {
      input = validateAnthropic(input, models, efforts);
      const result = await execute(input);
      if (!input.stream) reply(response, 200, result);
      return;
    }
    const fields = ['model', 'prompt', 'system', 'stream', 'save_session', 'session_id', 'effort', 'json_schema'];
    const unknown = Object.keys(input).filter(key => !fields.includes(key));
    if (unknown.length) throw fail(400, `Unsupported fields: ${unknown.join(', ')}.`);
    if (!models.includes(input.model)) throw fail(400, `Choose a model: ${models.join(', ')}.`);
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw fail(400, 'prompt must be a non-empty string.');
    if (input.system !== undefined && (typeof input.system !== 'string' || !input.system.trim())) {
      throw fail(400, 'system must be a non-empty string.');
    }
    for (const field of ['stream', 'save_session']) {
      if (input[field] !== undefined && typeof input[field] !== 'boolean') throw fail(400, `${field} must be a boolean.`);
    }
    if (input.effort !== undefined && !efforts.includes(input.effort)) {
      throw fail(400, `Choose an effort level: ${efforts.join(', ')}.`);
    }
    if (input.json_schema !== undefined && (!input.json_schema || typeof input.json_schema !== 'object' || Array.isArray(input.json_schema))) {
      throw fail(400, 'json_schema must be a JSON Schema object.');
    }
    if (input.json_schema !== undefined && Buffer.byteLength(JSON.stringify(input.json_schema)) > 65536) throw fail(400, 'JSON Schema exceeds 64 KiB.');
    if (input.session_id !== undefined) {
      if (typeof input.session_id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.session_id)) {
        throw fail(400, 'session_id must be a UUID returned by this API.');
      }
      if (!Object.hasOwn(sessions, input.session_id)) throw fail(404, 'Unknown saved session.');
      if (sessions[input.session_id].model !== input.model) throw fail(400, 'Use the original model for this session.');
      if (input.save_session !== undefined || input.system !== undefined) {
        throw fail(400, 'Set save_session and system only when starting a session.');
      }
    }
    const result = await execute(input);
    if (!input.stream) reply(response, 200, result);
  } catch (error) {
    if (response.destroyed) return;
    const status = error.status ?? 500;
    if (status === 413) response.shouldKeepAlive = false;
    const data = anthropic ? anthropicError(status, error.message, requestID) : { error: error.message, status };
    if (response.headersSent) {
      event(response, 'error', data);
      response.end();
    } else reply(response, status, data);
  } finally {
    response.off('close', cancel);
    request.off('aborted', cancel);
  }
});

server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Claude local API: http://127.0.0.1:${port}`);
  console.log(`Local token file: ${tokenPath}`);
  console.log('Using your Claude subscription login. Press Ctrl+C to stop.');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); server.closeAllConnections(); for (const cancel of activeCalls) cancel(); });
}
