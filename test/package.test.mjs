import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8'));
}

function readText(relative) {
  return readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');
}

const pkg = readJson('package.json');
const manifest = readJson('dsh.plugin.json');
const patch = readText('cordis.patch.yml');

test('package.json declares the DSH bundle entry', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(existsSync(path.join(PACKAGE_ROOT, pkg.dsh.bundle.patch)));
  assert.equal(pkg.license, 'MIT');
  assert.ok(pkg.engines.node);
});

test('every published file exists and the whitelist covers the runtime', () => {
  for (const entry of pkg.files) {
    assert.ok(existsSync(path.join(PACKAGE_ROOT, entry)), `missing published file: ${entry}`);
  }
  for (const required of ['lib/index.js', 'lib/proxy.mjs', 'lib/login.mjs', 'lib/config.mjs', 'dsh.plugin.json', 'README.md', 'README.zh.md', 'LICENSE', 'assets/icon.png']) {
    assert.ok(existsSync(path.join(PACKAGE_ROOT, required)), `missing required file: ${required}`);
    assert.ok(
      pkg.files.some((entry) => required === entry || required.startsWith(`${entry}/`)),
      `${required} is not covered by package.json files`,
    );
  }
});

test('bin targets exist and are declared', () => {
  assert.equal(pkg.bin['coros-mcp'], 'lib/proxy.mjs');
  assert.equal(pkg.bin['coros-mcp-login'], 'lib/login.mjs');
  for (const target of Object.values(pkg.bin)) {
    assert.ok(existsSync(path.join(PACKAGE_ROOT, target)), `missing bin target: ${target}`);
  }
});

test('dsh.plugin.json matches package identity', () => {
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.entry.name, pkg.name);
  assert.ok(Array.isArray(manifest.entry.inject));
});

test('bundle patch uses the package name as entry id, with no trailing comment', () => {
  const lines = patch.split(/\r?\n/);
  const idLine = lines.find((line) => /^\s*-\s*id:/.test(line) || /^\s+-\s*id:/.test(line));
  assert.ok(idLine, 'no id row in cordis.patch.yml');
  assert.equal(idLine.trim(), `- id: ${pkg.name}`);
  assert.equal(/- id:.*#/.test(patch), false, 'entry id must not carry a trailing comment');
  assert.ok(patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: ${pkg.name}`));
});

test('no absolute user paths or token literals are shipped', () => {
  const shipped = ['package.json', 'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'README.zh.md', 'LICENSE'];
  const libDir = path.join(PACKAGE_ROOT, 'lib');
  for (const name of readDir(libDir)) shipped.push(path.posix.join('lib', name));
  for (const relative of shipped) {
    const text = readText(relative);
    assert.equal(/[A-Za-z]:\\Users\\/.test(text), false, `absolute user path in ${relative}`);
    assert.equal(/\/Users\/[^/]+\//.test(text), false, `absolute user path in ${relative}`);
    assert.equal(/\/home\/[^/]+\//.test(text), false, `absolute user path in ${relative}`);
    assert.equal(/ya29\.[A-Za-z0-9_-]{10,}/.test(text), false, `google-style token literal in ${relative}`);
    assert.equal(/eyJ[A-Za-z0-9_-]{20,}\./.test(text), false, `JWT literal in ${relative}`);
  }
});

test('icon is a square PNG under the host icon limits', () => {
  const iconPath = path.join(PACKAGE_ROOT, 'assets', 'icon.png');
  const bytes = readFileSync(iconPath);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'icon must be a PNG',
  );
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(width, height, 'icon must be square');
  assert.ok(width >= 128 && width <= 1024, `unexpected icon size ${width}x${height}`);
  assert.ok(statSync(iconPath).size < 256 * 1024, 'icon must be under 256 KiB');
});

test('READMEs document install, login and configuration', () => {
  for (const relative of ['README.md', 'README.zh.md']) {
    const text = readText(relative);
    assert.ok(/install/i.test(text) || text.includes('安装'), `${relative} lacks install docs`);
    assert.ok(/login/i.test(text) || text.includes('登录'), `${relative} lacks login docs`);
    assert.ok(text.includes('mcp__coros__'), `${relative} lacks the tool prefix`);
  }
});

function readDir(dir) {
  const { readdirSync } = process.getBuiltinModule('node:fs');
  return readdirSync(dir).filter((name) => !name.endsWith('.map'));
}
