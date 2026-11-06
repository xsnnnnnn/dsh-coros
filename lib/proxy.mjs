#!/usr/bin/env node
/**
 * dsh-coros-mcp — stdio <-> Streamable HTTP bridge for the official COROS MCP endpoint.
 *
 * Why a bridge: DSH's MCP client speaks stdio (or plain HTTP with static headers) but
 * COROS' official MCP endpoint authenticates with short-lived OAuth 2.0 bearer tokens.
 * This process reads the shared COROS token cache, refreshes it when needed, and
 * forwards MCP JSON-RPC traffic both ways.
 *
 * It is deliberately dependency-free (Node >= 22 built-ins only) so the DSH plugin can
 * ship it as-is, and it also works as a standalone MCP server for any other client:
 *
 *   node lib/proxy.mjs                       # MCP stdio server
 *   node lib/proxy.mjs --status              # show login/cache status, no network
 *   node lib/proxy.mjs --selftest            # initialize + tools/list against COROS
 *   node lib/proxy.mjs --print-config        # alias of --selftest, prints endpoint/tools
 *
 * Options:
 *   --cache-root <dir>    token cache root        (default ~/.coros-mcp-skill-gateway-ts)
 *   --region <cn|eu|us>   force a region          (default: inferred from cache)
 *   --issuer <url>        force the OAuth issuer
 *   --mcp-url <url>       force the MCP endpoint  (default <issuer>/mcp)
 *   --timeout-ms <n>      per-request timeout     (default 30000)
 *   --verbose             log to stderr (never stdout: stdout is the MCP channel)
 *
 * Environment fallbacks: COROS_MCP_CACHE_ROOT, COROS_MCP_REGION, COROS_MCP_ISSUER,
 * COROS_MCP_URL, COROS_MCP_TIMEOUT_MS.
 */

import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_TIMEOUT_MS,
  CorosConfigError,
  createTokenProvider,
  describeAuth,
  fetchJson,
  formatAuthStatus,
  isTokenFresh,
  readToken,
  resolveTarget,
} from './config.mjs';

const LOG_PREFIX = '[coros-mcp]';

function log(...parts) {
  // stderr only: stdout is reserved for JSON-RPC frames.
  process.stderr.write(`${LOG_PREFIX} ${parts.join(' ')}\n`);
}

function fail(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    cacheRoot: undefined,
    region: undefined,
    issuer: undefined,
    mcpUrl: undefined,
    timeoutMs: Number(process.env.COROS_MCP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    selftest: false,
    printConfig: false,
    status: false,
    verbose: false,
    help: false,
  };
  const value = (flag, index) => {
    if (index + 1 >= argv.length) throw new CorosConfigError(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--cache-root') options.cacheRoot = value(flag, i++);
    else if (flag === '--region') options.region = value(flag, i++);
    else if (flag === '--issuer') options.issuer = value(flag, i++);
    else if (flag === '--mcp-url') options.mcpUrl = value(flag, i++);
    else if (flag === '--timeout-ms') options.timeoutMs = Number(value(flag, i++));
    else if (flag === '--selftest') options.selftest = true;
    else if (flag === '--print-config') options.printConfig = true;
    else if (flag === '--status') options.status = true;
    else if (flag === '--verbose') options.verbose = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new CorosConfigError(`unknown option: ${flag}`);
  }
  return options;
}

/** Parse a Streamable HTTP MCP reply: plain JSON or an SSE stream. */
function parseReply(contentType, text) {
  if (!text) return undefined;
  if (String(contentType).includes('text/event-stream')) {
    const messages = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        /* keep-alive or partial frame */
      }
    }
    return messages.length === 1 ? messages[0] : messages;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/*
 * COROS serves tool schemas that rely on a top-level `$defs` plus `$ref`s into it
 * (e.g. `{"$ref":"#/$defs/Section"}` for workout sections). Several model providers —
 * and the tool-schema normaliser in front of them — keep the `$ref` but drop `$defs`,
 * which is rejected with `Pointer '/$defs/Section' does not exist` and fails the whole
 * turn. Resolve the references ourselves and hand out self-contained schemas.
 * `Section` recurses through `sets[]`, so expansion is depth-limited and the deepest
 * hop degrades to a permissive object.
 */
const MAX_REF_DEPTH = 2;

export function inlineSchemaRefs(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const defs = schema.$defs && typeof schema.$defs === 'object' ? schema.$defs : {};
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function expand(node, depth) {
    if (Array.isArray(node)) return node.map((item) => expand(item, depth));
    if (!node || typeof node !== 'object') return node;

    if (typeof node.$ref === 'string') {
      const match = /^#\/\$defs\/(.+)$/.exec(node.$ref);
      const def = match ? defs[match[1]] : undefined;
      if (!def || depth >= MAX_REF_DEPTH) {
        const placeholder = { type: 'object' };
        if (def?.description) placeholder.description = def.description;
        return placeholder;
      }
      const resolved = expand(clone(def), depth + 1);
      if (typeof node.description === 'string') resolved.description = node.description;
      return resolved;
    }

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$defs' || key === '$schema' || key === '$id') continue;
      out[key] = expand(value, depth);
    }
    return out;
  }

  return expand(schema, 0);
}

/** Rewrite `tools/list` payloads so every tool schema is self-contained. */
export function sanitizeToolsReply(reply) {
  const messages = Array.isArray(reply) ? reply : [reply];
  for (const message of messages) {
    const tools = message?.result?.tools;
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) {
      if (tool && tool.inputSchema) tool.inputSchema = inlineSchemaRefs(tool.inputSchema);
    }
  }
  return reply;
}

/** POST one JSON-RPC message to the COROS MCP endpoint, refreshing the token on 401. */
async function post(target, provider, message, options, state) {
  let token = await provider.get();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchJson(
      target.mcpUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `${token.token_type ?? 'Bearer'} ${token.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(message),
      },
      options.timeoutMs,
    );
    if (response.status === 401 && attempt === 0) {
      log('server returned 401; forcing a token refresh');
      token = await provider.get(true);
      continue;
    }
    if (!response.ok) {
      throw new CorosConfigError(`MCP request failed (HTTP ${response.status}): ${response.text.slice(0, 300)}`);
    }
    state.sessionId = response.headers['mcp-session-id'] || state.sessionId;
    return parseReply(response.headers['content-type'] ?? '', response.text);
  }
  throw new CorosConfigError('MCP request failed after token refresh');
}

async function rpc(target, provider, state, options, id, method, params) {
  const reply = await post(target, provider, { jsonrpc: '2.0', id, method, params }, options, state);
  const message = Array.isArray(reply) ? (reply.find((item) => item && item.id === id) ?? reply[0]) : reply;
  if (!message) throw new CorosConfigError(`no JSON-RPC reply for ${method}`);
  if (message.error) throw new CorosConfigError(`${method} failed: ${JSON.stringify(message.error).slice(0, 300)}`);
  sanitizeToolsReply(message);
  return message.result;
}

async function selftest(target, provider, options) {
  const state = {};
  const startedAt = Date.now();
  const init = await rpc(target, provider, state, options, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-coros-mcp', version: '1.0.0' },
  });
  const tools = await rpc(target, provider, state, options, 2, 'tools/list', {});
  const toolList = (tools?.tools ?? []).map((tool) => tool.name);
  return {
    ok: true,
    endpoint: target.mcpUrl,
    region: target.region,
    issuer: target.issuer,
    tokenFile: target.tokenFile,
    server: init?.serverInfo ?? null,
    protocolVersion: init?.protocolVersion ?? null,
    toolCount: toolList.length,
    tools: toolList,
    elapsedMs: Date.now() - startedAt,
  };
}

async function runStatus(options) {
  const target = resolveTarget(options);
  let token;
  try {
    token = readToken(target.tokenFile);
  } catch (error) {
    if (error instanceof CorosConfigError) {
      process.stdout.write(`${formatAuthStatus(describeAuth(target, undefined))}\n`);
      process.stdout.write(`\nwarning: ${error.message}\n`);
      return 0;
    }
    throw error;
  }
  process.stdout.write(`${formatAuthStatus(describeAuth(target, token))}\n`);
  if (!isTokenFresh(token)) {
    process.stdout.write('\naccess token needs a refresh on next use (refresh_token will be used automatically).\n');
  }
  return 0;
}

/**
 * Stdio MCP server: every stdin line is one JSON-RPC message. Replies are written
 * to stdout as single-line JSON; diagnostics go to stderr only.
 */
async function serve(options) {
  const target = resolveTarget(options);
  const provider = createTokenProvider(target, { timeoutMs: options.timeoutMs });
  if (!target.loggedIn) {
    log(`no COROS login cache at ${target.tokenFile}; run "coros-mcp-login login-start" first`);
  } else {
    log(`endpoint ${target.mcpUrl} region=${target.region} token=${target.tokenFile}`);
  }
  const state = {};
  const pending = new Set();

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      log(`ignoring unparsable input: ${trimmed.slice(0, 120)}`);
      return;
    }
    const task = (async () => {
      try {
        const reply = await post(target, provider, message, options, state);
        sanitizeToolsReply(reply);
        if (message.id === undefined || message.id === null || reply === undefined) return;
        const chosen = Array.isArray(reply) ? (reply.find((item) => item && item.id === message.id) ?? reply[0]) : reply;
        if (chosen) send(chosen);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        log(text);
        if (message.id !== undefined && message.id !== null) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } });
        }
      }
    })();
    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
    });
  });

  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}

function helpText() {
  return [
    'usage: node lib/proxy.mjs [options]',
    '',
    '  (no options)          run as a stdio MCP server',
    '  --status              print login/region/token status (no network)',
    '  --selftest            initialize + tools/list against COROS, then exit',
    '  --print-config        alias of --selftest (endpoint + tools)',
    '',
    'options:',
    '  --cache-root <dir>    token cache root (~/.coros-mcp-skill-gateway-ts)',
    '  --region <cn|eu|us>   force region (inferred from cache otherwise)',
    '  --issuer <url>        force OAuth issuer',
    '  --mcp-url <url>       force MCP endpoint',
    '  --timeout-ms <n>      per-request timeout (30000)',
    '  --verbose             verbose stderr logging',
    '  --help                this text',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (options.status) return runStatus(options);
  if (options.selftest || options.printConfig) {
    const target = resolveTarget(options);
    const provider = createTokenProvider(target, { timeoutMs: options.timeoutMs });
    const result = await selftest(target, provider, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  await serve(options);
  return 0;
}

const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
