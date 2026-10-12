import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const endpoint = 'https://api.anthropic.com/v1/code/sessions';
const fail = (status, message) => Object.assign(new Error(message), { status });
const tokenFields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

export function validateCloud(input) {
  if (input.max_tokens !== 128000) throw fail(400, 'Cloud mode requires max_tokens: 128000. The cloud worker does not accept a per-request output limit.');
  if (input.messages.length !== 1) throw fail(400, 'Cloud mode supports one user message; conversation history is not supported.');
  if (input.tools.length || input.tool_choice?.type === 'auto') throw fail(400, 'Cloud mode does not support client tools.');
  if (input.schema) throw fail(400, 'Cloud mode does not support output_config.format.');
  if (input.cache_control || input.messages.some(message => message.content.some(block => block.cache_control))) {
    throw fail(400, 'Cloud prompt caching is automatic. Client cache_control breakpoints and TTLs are not supported.');
  }
  if (input.messages[0].content.some(block => !['text', 'image'].includes(block.type))) {
    throw fail(400, 'Cloud mode supports text and base64 images only.');
  }
}

// Read only Claude Code's existing login. Never copy or log credentials.
async function accessToken() {
  let raw;
  try {
    if (process.platform === 'darwin') {
      ({ stdout: raw } = await exec('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }));
    } else raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    const oauth = JSON.parse(raw).claudeAiOauth;
    if (!oauth?.accessToken || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= Date.now()) throw new Error('Missing or expired login');
    return oauth.accessToken;
  } catch {
    throw fail(502, 'Cloud mode needs a current Claude Code subscription login. Run claude auth login, then restart this service.');
  }
}

async function api(token, path, { body, signal } = {}) {
  let response;
  try {
    response = await fetch(endpoint + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      redirect: 'error',
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw fail(502, `Cloud session request failed: ${error.name}.`);
  }
  if (!response.ok) {
    // Do not reflect an upstream body that may contain private request data.
    const login = response.status === 401 ? ' Run claude auth login, then restart this service.' : '';
    throw fail(response.status === 429 ? 429 : 502, `Cloud session API returned HTTP ${response.status}.${login}`);
  }
  try { return await response.json(); }
  catch { throw fail(502, 'Cloud session API returned invalid JSON.'); }
}

export class CloudMessages {
  constructor(environment = process.env.CLAUDE_LOCAL_API_CLOUD_ENVIRONMENT) {
    if (environment && !/^env_[A-Za-z0-9]+$/.test(environment)) throw new Error('CLAUDE_LOCAL_API_CLOUD_ENVIRONMENT must be an Anthropic cloud environment ID (env_...).');
    this.environment = environment;
  }

  usage = { sessions_started: 0, model_calls: 0, failed_requests: 0, promotional_calls: 0, reported_cost_usd: 0,
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  async run(input, signal) {
    if (!this.environment) throw fail(503, 'Cloud mode is not configured. Set CLAUDE_LOCAL_API_CLOUD_ENVIRONMENT and restart the service.');
    const token = await accessToken();
    signal.throwIfAborted();
    const deadline = AbortSignal.timeout(1_200_000);
    const workSignal = AbortSignal.any([signal, deadline]);
    const userID = randomUUID();
    let sessionID, message, failure;
    try {
      // Let creation finish even if the caller leaves, so its session can be archived.
      // No retries: a lost create response may have started a session upstream.
      const created = await api(token, '', { body: {
        title: 'Local API request', environment_id: this.environment,
        config: { sources: [], outcomes: [], mcp_connector_ids: [], model: input.model,
          disallowed_tools: ['*'], max_turns: 1,
          ...(input.system ? { custom_system_prompt: input.system } : {}),
          ...(input.effort ? { effort_level: input.effort } : {}) },
        events: [{ payload: { type: 'user', uuid: userID, session_id: '', parent_tool_use_id: null,
          client_composed: true, message: input.messages[0] } }],
      } });
      sessionID = created.session?.id;
      if (!/^cse_[A-Za-z0-9]+$/.test(sessionID ?? '')) throw fail(502, 'Cloud creation returned no session ID. Check claude.ai/code for an unfinished Local API request.');
      this.usage.sessions_started++;
      if (created.session.environment_kind !== 'anthropic_cloud') throw fail(502, 'The session did not start in an Anthropic cloud environment.');
      const collected = new Map();
      while (true) {
        workSignal.throwIfAborted();
        const page = await api(token, `/${sessionID}/events?limit=100&sort_order=desc`, { signal: workSignal });
        if (!Array.isArray(page.data) || page.has_more) throw fail(502, 'Cloud session event history is incomplete.');
        for (const item of page.data) {
          if (!item.event_id || !item.payload || !/^\d+$/.test(String(item.sequence_num))) throw fail(502, 'Cloud session returned an invalid event.');
          collected.set(item.event_id, item);
        }
        const events = [...collected.values()].sort((a, b) => Number(a.sequence_num) - Number(b.sequence_num)).map(item => item.payload);
        const init = events.find(event => event.type === 'system' && event.subtype === 'init');
        if (init && (!Array.isArray(init.tools) || init.tools.length)) throw fail(502, 'The cloud worker did not disable its built-in tools.');
        // New-session seed replies do not carry user_message_uuid. This adapter
        // owns one turn per session; refuse any other user message in its log.
        // Image ingestion also writes a synthetic replay naming its cloud file.
        const users = events.filter(event => event.type === 'user' && !(event.isSynthetic === true && event.isReplay === true));
        if (users.some(event => event.uuid !== userID)) throw fail(502, 'The cloud session contains another user turn.');
        const result = events.find(event => event.type === 'result');
        if (result) {
          if (users.length !== 1 || (result.user_message_uuid && result.user_message_uuid !== userID)) throw fail(502, 'Cloud reply does not match this request.');
          const rate = events.findLast(event => event.type === 'rate_limit_event')?.rate_limit_info;
          this.usage.model_calls++;
          this.usage.promotional_calls += Number(rate?.rateLimitType === 'ccr_promotional');
          if (Number.isFinite(result.total_cost_usd)) this.usage.reported_cost_usd += result.total_cost_usd;
          for (const field of tokenFields) this.usage[field] += result.usage?.[field] ?? 0;
          if (result.is_error || result.subtype !== 'success') throw fail(result.api_error_status === 429 ? 429 : 502, 'The cloud worker did not complete the request successfully.');
          if (!init || init.model !== input.model || result.modelUsage?.[input.model]?.maxOutputTokens !== input.max_tokens) {
            throw fail(502, 'The cloud worker did not confirm the requested model and output limit.');
          }
          const parts = events.filter(event => event.type === 'assistant' && !event.parent_tool_use_id).map(event => event.message);
          if (!parts.length || parts.some(part => part.model !== input.model || part.id !== parts[0].id || !Array.isArray(part.content))) {
            throw fail(502, 'The cloud worker returned an unexpected assistant message.');
          }
          const content = parts.flatMap(part => part.content);
          if (content.some(block => !['text', 'thinking', 'redacted_thinking'].includes(block.type))) throw fail(502, 'The cloud worker returned an unsupported response block.');
          if (!['end_turn', 'max_tokens', 'refusal'].includes(result.stop_reason)) throw fail(502, 'The cloud worker returned an unsupported stop reason.');
          message = { id: parts[0].id, type: 'message', role: 'assistant', model: input.model, content,
            stop_reason: result.stop_reason, stop_sequence: null,
            usage: Object.fromEntries(tokenFields.map(field => [field, result.usage?.[field] ?? 0])) };
          break;
        }
        await delay(1000, undefined, { signal: workSignal });
      }
    } catch (error) {
      failure = deadline.aborted && !signal.aborted ? fail(504, 'Cloud request exceeded the twenty-minute limit.') : error;
      if (!sessionID) failure = fail(failure.status ?? 502, `${failure.message} If creation reached the service, check claude.ai/code for an unfinished Local API request. No retry was made.`);
    } finally {
      if (sessionID) {
        try {
          const archived = await api(token, `/${sessionID}/archive`, { body: {} });
          if (archived.session?.status !== 'archived') throw new Error('Not archived');
        } catch {
          failure = fail(502, `Cloud session cleanup failed. Open and archive https://claude.ai/code/${sessionID}.`);
        }
      }
    }
    if (failure) { this.usage.failed_requests++; throw failure; }
    signal.throwIfAborted();
    return message;
  }
}

// The session log contains complete blocks, not token deltas. Emit valid SSE only
// after the completed reply and archive are confirmed; do not invent live timing.
export function emitCloudMessage(message, emit) {
  emit({ type: 'message_start', message: { ...message, content: [], stop_reason: null,
    usage: { ...message.usage, output_tokens: 0 } } });
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'thinking') {
      emit({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      emit({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      emit({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else emit({ type: 'content_block_start', index, content_block: block });
    emit({ type: 'content_block_stop', index });
  });
  emit({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  emit({ type: 'message_stop' });
}
