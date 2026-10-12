import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const toolPrefix = 'mcp__client__';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const upstreamError = message => { throw Object.assign(new Error(message), { status: 502 }); };
function fields(value, allowed, label) {
  if (!object(value)) fail(`${label} must be an object.`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) fail(`Unsupported ${label} fields: ${extra.join(', ')}.`);
}

function content(value, role, nested = false) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value) || (!nested && value.length === 0)) fail('Message content must be text or a non-empty block list.');
  return value.map(block => {
    if (!object(block)) fail('Each content block must be an object.');
    switch (block.type) {
      case 'text': {
        fields(block, ['type', 'text', 'citations'], 'text block');
        if (typeof block.text !== 'string') fail('Text blocks require text.');
        if (block.citations != null && (!Array.isArray(block.citations) || block.citations.length)) fail('Text citations are not supported.');
        return { type: 'text', text: block.text };
      }
      case 'image': {
        if (role !== 'user') fail('Image blocks must be in user messages.');
        fields(block, ['type', 'source'], 'image block');
        fields(block.source, ['type', 'media_type', 'data'], 'image source');
        const source = block.source;
        if (source.type !== 'base64' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(source.media_type)) {
          fail('Send images as base64 PNG, JPEG, GIF, or WebP blocks.');
        }
        if (typeof source.data !== 'string' || !source.data || source.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) {
          fail('Image data must be valid base64.');
        }
        if (Buffer.byteLength(source.data, 'base64') > 5 * 1024 * 1024) fail('Each image must be at most 5 MiB.');
        break;
      }
      case 'tool_use': {
        if (role !== 'assistant' || nested) fail('tool_use blocks must be in assistant messages.');
        fields(block, ['type', 'id', 'name', 'input', 'caller', 'toolset_name'], 'tool_use block');
        if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !object(block.input)) fail('Invalid tool_use block.');
        if (block.caller != null) {
          fields(block.caller, ['type'], 'tool caller');
          if (block.caller.type !== 'direct') fail('Only direct client tool callers are supported.');
        }
        if (block.toolset_name != null) fail('Toolset member calls are not supported.');
        // SDK response objects include null optional fields; omit these on replay.
        const { caller, toolset_name, ...tool } = block;
        return caller == null ? tool : { ...tool, caller: { ...caller } };
      }
      case 'tool_result':
        if (role !== 'user' || nested) fail('tool_result blocks must be in user messages.');
        fields(block, ['type', 'tool_use_id', 'content', 'is_error'], 'tool_result block');
        if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) fail('tool_result requires tool_use_id.');
        if (block.is_error !== undefined && typeof block.is_error !== 'boolean') fail('is_error must be boolean.');
        return { ...block, content: content(block.content ?? '', 'user', true) };
      case 'thinking':
        if (role !== 'assistant' || nested) fail('Thinking blocks must be in assistant messages.');
        fields(block, ['type', 'thinking', 'signature'], 'thinking block');
        if (typeof block.thinking !== 'string' || typeof block.signature !== 'string') fail('Invalid thinking block.');
        break;
      case 'redacted_thinking':
        if (role !== 'assistant' || nested) fail('Thinking blocks must be in assistant messages.');
        fields(block, ['type', 'data'], 'redacted thinking block');
        if (typeof block.data !== 'string') fail('Invalid redacted thinking block.');
        break;
      default: fail(`Unsupported content block: ${block.type}.`);
    }
    return { ...block };
  });
}

export function validateAnthropic(input, models, efforts) {
  fields(input, ['model', 'max_tokens', 'messages', 'system', 'stream', 'tools', 'tool_choice', 'output_config', 'thinking', 'stop_sequences', 'temperature'], 'request');
  if (!models.includes(input.model)) fail(`Choose a model: ${models.join(', ')}.`);
  if (!Number.isInteger(input.max_tokens) || input.max_tokens < 1 || input.max_tokens > 128000) fail('max_tokens must be an integer from 1 to 128000.');
  if (input.stream !== undefined && typeof input.stream !== 'boolean') fail('stream must be boolean.');
  if (input.temperature !== undefined && input.temperature !== 1) fail('These models do not support a non-default temperature.');
  if (input.stop_sequences !== undefined && (!Array.isArray(input.stop_sequences) || input.stop_sequences.length)) fail('Custom stop_sequences are not supported.');
  const systemParts = [];
  const appendSystem = value => {
    const blocks = content(value, 'system', true);
    if (blocks.some(block => block.type !== 'text')) fail('system must contain text only.');
    systemParts.push(...blocks.map(block => block.text));
  };
  if (input.system !== undefined) appendSystem(input.system);
  if (!Array.isArray(input.messages) || input.messages.length === 0) fail('messages must be a non-empty list.');
  const messages = [];
  for (const message of input.messages) {
    fields(message, ['role', 'content'], 'message');
    if (!['user', 'assistant', 'system'].includes(message.role)) fail('Message roles must be user, assistant, or system.');
    // Claude has one system prompt. Keep these notes at system priority.
    if (message.role === 'system') { appendSystem(message.content); continue; }
    const blocks = content(message.content, message.role);
    const previous = messages.at(-1);
    if (previous?.role === message.role) previous.content.push(...blocks);
    else messages.push({ role: message.role, content: blocks });
  }
  if (messages[0]?.role !== 'user' || messages.at(-1)?.role !== 'user') fail('The non-system message list must start and end with a user message. Assistant prefills are not supported.');
  const pendingTools = new Set();
  const knownTools = new Set();
  for (const message of messages) {
    let nonResult = false;
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        if (knownTools.has(block.id)) fail('Tool call IDs must be unique.');
        knownTools.add(block.id); pendingTools.add(block.id);
      }
      if (block.type === 'tool_result') {
        if (nonResult) fail('Place tool_result blocks before other content in the user turn.');
        if (!pendingTools.delete(block.tool_use_id)) fail('tool_result does not match a pending tool_use.');
      } else nonResult = true;
    }
    if (message.role === 'user' && pendingTools.size) fail('Return results for all pending tools before continuing.');
  }
  const tools = input.tools ?? [];
  if (!Array.isArray(tools)) fail('tools must be a list.');
  const names = new Set();
  for (const tool of tools) {
    fields(tool, ['name', 'description', 'input_schema'], 'tool');
    if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name)) fail('Tool names must be unique and contain 1–64 letters, digits, underscores, or hyphens.');
    if (tool.description !== undefined && typeof tool.description !== 'string') fail('Tool description must be text.');
    if (!object(tool.input_schema) || tool.input_schema.type !== 'object') fail('Tool input_schema must have type object.');
    names.add(tool.name);
  }
  if (input.tool_choice !== undefined) {
    fields(input.tool_choice, ['type'], 'tool_choice');
    if (!['auto', 'none'].includes(input.tool_choice.type)) fail('tool_choice supports auto and none; forced tool calls are not supported.');
  }
  let effort, schema;
  if (input.output_config !== undefined) {
    fields(input.output_config, ['effort', 'format'], 'output_config');
    effort = input.output_config.effort;
    if (effort !== undefined && !efforts.includes(effort)) fail(`Choose an effort: ${efforts.join(', ')}.`);
    if (input.output_config.format !== undefined) {
      fields(input.output_config.format, ['type', 'schema'], 'output format');
      if (input.output_config.format.type !== 'json_schema' || !object(input.output_config.format.schema)) fail('Use output_config.format with type json_schema and a schema object.');
      schema = input.output_config.format.schema;
      if (Buffer.byteLength(JSON.stringify(schema)) > 65536) fail('JSON Schema exceeds 64 KiB.');
      if (tools.length) fail('Combining tools with output_config.format is not supported by this adapter.');
    }
  }
  if (input.thinking !== undefined) {
    fields(input.thinking, ['type'], 'thinking');
    if (input.thinking.type !== 'adaptive') fail('Only adaptive thinking is supported. Claude Code does not reliably honor disabled thinking; use output_config.effort to control reasoning effort.');
  }
  return { ...input, messages, system: systemParts.join('\n\n'), tools: input.tool_choice?.type === 'none' ? [] : tools, effort, schema };
}

export function prepareAnthropic(input, directory) {
  const folder = mkdtempSync(join(directory, 'request-'));
  const cleanup = () => rmSync(folder, { recursive: true, force: true });
  try {
    const args = ['--no-session-persistence', '--input-format', 'stream-json'];
    if (input.effort) args.push('--effort', input.effort);
    if (input.schema) args.push('--json-schema', JSON.stringify(input.schema));
    if (input.thinking) args.push('--thinking', input.thinking.type);
    const nativeMessages = input.messages.map(message => ({ ...message, content: message.content.map(block =>
      block.type === 'tool_use' ? { ...block, name: toolPrefix + block.name } : block) }));
    const history = nativeMessages.slice(0, -1);
    let userMessage = nativeMessages.at(-1);
    const results = userMessage.content.filter(block => block.type === 'tool_result');
    if (results.length) {
      // Resume repairs unanswered calls before stdin is read. Load their results first.
      history.push({ role: 'user', content: results });
      const remaining = userMessage.content.filter(block => block.type !== 'tool_result');
      userMessage = { role: 'user', content: remaining.length ? remaining : [{ type: 'text', text: '' }] };
    }
    if (history.length) {
      const sessionId = randomUUID();
      let parentUuid = null;
      const entries = history.map(message => {
        const uuid = randomUUID();
        const entry = { parentUuid, uuid, sessionId, cwd: directory, isSidechain: false, userType: 'external',
          timestamp: new Date().toISOString(), type: message.role, message: message.role === 'assistant'
            ? { id: `msg_${uuid}`, type: 'message', model: input.model, ...message,
              stop_reason: message.content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
              stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } : message };
        parentUuid = uuid;
        return JSON.stringify(entry);
      });
      const historyPath = join(folder, 'history.jsonl');
      writeFileSync(historyPath, entries.join('\n') + '\n', { mode: 0o600 });
      args.push(`--resume=${historyPath}`, '--fork-session');
    }
    return { args, cleanup, userMessage: { type: 'user', message: userMessage, parent_tool_use_id: null, client_composed: true } };
  } catch (error) { cleanup(); throw error; }
}

// Rebuild the provider's first message without flattening blocks or inventing tool calls.
export class AnthropicMessage {
  constructor(model, tools, emit) { this.model = model; this.tools = new Set(tools.map(tool => tool.name)); this.emit = emit; this.inputs = new Map(); }

  accept(raw) {
    if (this.complete) return true;
    const event = structuredClone(raw);
    if (event.type === 'error') {
      throw Object.assign(new Error(event.error?.message ?? 'Claude stream failed.'), { status: event.error?.type === 'rate_limit_error' ? 429 : 502 });
    } else if (event.type === 'message_start') {
      if (this.message) upstreamError('Claude started an unexpected second message.');
      if (event.message.model !== this.model) upstreamError(`Claude returned an unexpected model: ${event.message.model}.`);
      this.message = { ...event.message, content: [] };
    } else if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block.type === 'tool_use') {
        const name = block.name.startsWith(toolPrefix) ? block.name.slice(toolPrefix.length) : null;
        if (!name || !this.tools.has(name)) upstreamError(`Claude requested an unknown tool: ${block.name}.`);
        block.name = name;
        this.inputs.set(event.index, '');
      }
      if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)) upstreamError(`Unsupported response block: ${block.type}.`);
      this.message.content[event.index] = structuredClone(block);
    } else if (event.type === 'content_block_delta') {
      const block = this.message.content[event.index];
      const delta = event.delta;
      if (!block) upstreamError('Claude sent a delta without a content block.');
      if (delta.type === 'text_delta') block.text += delta.text;
      else if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
      else if (delta.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature;
      else if (delta.type === 'input_json_delta') this.inputs.set(event.index, this.inputs.get(event.index) + delta.partial_json);
      else upstreamError(`Unsupported response delta: ${delta.type}.`);
    } else if (event.type === 'content_block_stop') {
      if (this.inputs.has(event.index)) {
        const json = this.inputs.get(event.index);
        if (json) {
          try { this.message.content[event.index].input = JSON.parse(json); }
          catch { upstreamError('Claude returned invalid tool input JSON.'); }
        }
      }
    } else if (event.type === 'message_delta') {
      Object.assign(this.message, event.delta);
      Object.assign(this.message.usage, event.usage);
    } else if (event.type === 'message_stop') {
      if (!this.message?.stop_reason) upstreamError('Claude ended without a stop reason.');
      this.complete = true;
    } else if (event.type !== 'ping') upstreamError(`Unsupported provider event: ${event.type}.`);
    this.emit?.(event);
    return this.complete === true;
  }
}

export function toolControl(request, tools) {
  if (request.subtype !== 'mcp_message' || request.server_name !== 'client') return null;
  const rpc = request.message;
  let result;
  if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'client', version: '1.0.0' } };
  else if (rpc.method === 'tools/list') result = { tools: tools.map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.input_schema })) };
  else if (rpc.method === 'ping' || rpc.method?.startsWith('notifications/')) result = {};
  else if (rpc.method === 'tools/call') return null; // The HTTP caller runs its tools. Never execute them here.
  else return { mcp_response: { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not supported.' } } };
  return { mcp_response: { jsonrpc: '2.0', ...(rpc.id !== undefined ? { id: rpc.id } : {}), result } };
}

export function anthropicError(status, message, requestID) {
  const types = { 400: 'invalid_request_error', 401: 'authentication_error', 404: 'not_found_error', 413: 'request_too_large', 415: 'invalid_request_error', 429: 'rate_limit_error', 503: 'overloaded_error' };
  return { type: 'error', error: { type: types[status] ?? 'api_error', message }, request_id: requestID };
}
