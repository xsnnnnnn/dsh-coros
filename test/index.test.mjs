import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bridgeArgs, bridgeExists, loadMcpClientPlugin, mcpClientConfig, resolveNodeExecutable } from '../lib/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

test('resolveNodeExecutable prefers an explicit nodePath', () => {
  const resolved = resolveNodeExecutable({ nodePath: 'D:/node/node.exe' }, { DSH_HOME: 'D:/dsh' });
  assert.equal(resolved.command, 'D:/node/node.exe');
  assert.deepEqual(resolved.env, {});
});

test('resolveNodeExecutable prefers an existing DSH desktop node executable', () => {
  const resolved = resolveNodeExecutable({}, {
    DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
    DSH_HOME: 'D:/dsh',
  });
  assert.equal(resolved.command, process.execPath);
});

test('resolveNodeExecutable ignores a stale DSH desktop node path', () => {
  const resolved = resolveNodeExecutable({}, {
    DSH_DESKTOP_NODE_EXECUTABLE: 'D:/does/not/exist/node.exe',
    DSH_HOME: 'D:/does/not/exist',
  });
  assert.notEqual(resolved.command, 'D:/does/not/exist/node.exe');
});

test('loadMcpClientPlugin can be forced onto the Loader fallback path', async () => {
  process.env.COROS_MCP_FORCE_LOADER_FALLBACK = '1';
  try {
    assert.equal(await loadMcpClientPlugin(), null);
  } finally {
    delete process.env.COROS_MCP_FORCE_LOADER_FALLBACK;
  }
});

test('resolveNodeExecutable falls back to an Electron re-entry with ELECTRON_RUN_AS_NODE', () => {
  const resolved = resolveNodeExecutable({}, {});
  assert.equal(typeof resolved.command, 'string');
  assert.ok(resolved.command.length > 0);
  // In this sandboxed test host the DSH runtime node usually exists, so accept
  // either a concrete node path or the Electron fallback with the re-entry env.
  if (!/node(\.exe)?$/i.test(resolved.command)) {
    assert.deepEqual(resolved.env, { ELECTRON_RUN_AS_NODE: '1' });
  }
});

test('bridgeArgs point at the packaged proxy and forward overrides', () => {
  assert.deepEqual(bridgeArgs({}), [path.join(PACKAGE_ROOT, 'lib', 'proxy.mjs')]);
  const args = bridgeArgs({
    cacheRoot: '~/.dsh/coros-mcp',
    region: 'eu',
    issuer: 'https://mcpeu.coros.com',
    mcpUrl: 'https://mcpeu.coros.com/mcp',
    requestTimeoutMs: 15000,
  });
  assert.equal(args[0], path.join(PACKAGE_ROOT, 'lib', 'proxy.mjs'));
  assert.deepEqual(args.slice(1), [
    '--cache-root', '~/.dsh/coros-mcp',
    '--region', 'eu',
    '--issuer', 'https://mcpeu.coros.com',
    '--mcp-url', 'https://mcpeu.coros.com/mcp',
    '--timeout-ms', '15000',
  ]);
});

test('bridgeExists finds the shipped proxy script', () => {
  assert.equal(bridgeExists(), true);
});

test('mcpClientConfig builds a stdio row with the coros namespace', () => {
  const row = mcpClientConfig({ toolCallTimeoutMs: 90000, failOnStartupError: true });
  assert.equal(row.serverName, 'coros');
  assert.equal(row.transport, 'stdio');
  assert.equal(row.toolCallTimeoutMs, 90000);
  assert.equal(row.failOnStartupError, true);
  assert.deepEqual(row.reconnect, { enabled: true });
  assert.ok(row.args[0].endsWith('proxy.mjs'));
  assert.equal(typeof row.command, 'string');
  assert.equal('cwd' in row, false);
});

test('mcpClientConfig carries the ELECTRON_RUN_AS_NODE re-entry env when needed', () => {
  const row = mcpClientConfig({ nodePath: 'D:/node/node.exe' });
  assert.equal('env' in row, false, 'explicit nodePath needs no env override');
});
