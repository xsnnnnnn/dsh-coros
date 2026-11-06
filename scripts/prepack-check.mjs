/**
 * Pre-publish static checks for dsh-coros-mcp (runs on `npm pack` / `npm publish`).
 *
 * Fails the pack when the package would ship something the DSH plugin market
 * preflight rejects: version drift between package.json and dsh.plugin.json,
 * a missing published file, a hard-coded user path, or a token-like literal.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function requireFile(relative) {
  const absolute = path.join(ROOT, relative);
  if (!existsSync(absolute)) {
    fail(`missing published file: ${relative}`);
    return false;
  }
  return true;
}

// 1) files whitelist must resolve
for (const entry of pkg.files) requireFile(entry);

// 2) runtime/first-run essentials
for (const relative of [
  'lib/index.js',
  'lib/proxy.mjs',
  'lib/login.mjs',
  'cordis.patch.yml',
  'dsh.plugin.json',
  'assets/icon.png',
  'README.md',
  'README.zh.md',
  'LICENSE',
]) {
  if (requireFile(relative) && !pkg.files.some((entry) => relative === entry || relative.startsWith(`${entry}/`))) {
    fail(`${relative} is not covered by package.json files`);
  }
}

// 3) manifest identity / version sync
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'dsh.plugin.json'), 'utf8'));
if (manifest.name !== pkg.name) fail('dsh.plugin.json name !== package.json name');
if (manifest.version !== pkg.version) fail('dsh.plugin.json version !== package.json version');
if (manifest.entry?.name !== pkg.name) fail('dsh.plugin.json entry.name !== package.json name');
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch must point at ./cordis.patch.yml');

// 4) bundle patch sanity: exactly one insert row, id === package name, no trailing comment
const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
const idLine = patch.split(/\r?\n/).find((line) => /^\s*-\s+id:/.test(line));
if (!idLine) fail('cordis.patch.yml has no id row');
else {
  if (idLine.trim() !== `- id: ${pkg.name}`) fail(`patch id must be - id: ${pkg.name} (got ${idLine.trim()})`);
  if (/#/.test(patch.split(/\r?\n/).find((line) => line.includes('id:')) ?? '')) fail('patch id row must not carry a trailing comment');
}

// 5) icon constraints (DSH host icon loader: square raster, <= 256 KiB, inside the package)
const iconPath = path.join(ROOT, pkg.icon ?? '');
if (existsSync(iconPath)) {
  const size = statSync(iconPath).size;
  const bytes = readFileSync(iconPath);
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) warn(`package icon ${pkg.icon} is not a PNG`);
  if (size > 256 * 1024) fail(`icon ${pkg.icon} is larger than 256 KiB (${size} bytes)`);
  if (size > 64 * 1024) warn(`icon ${pkg.icon} is larger than 64 KiB (${size} bytes)`);
} else {
  fail(`icon file missing: ${pkg.icon}`);
}

// 6) shipped text must not leak tokens or absolute user paths
const textFiles = ['cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'README.zh.md', 'LICENSE', 'package.json'];
for (const name of readdirSync(path.join(ROOT, 'lib'))) textFiles.push(path.posix.join('lib', name));
for (const relative of textFiles) {
  const absolute = path.join(ROOT, relative);
  if (!existsSync(absolute)) continue;
  const text = readFileSync(absolute, 'utf8');
  for (const [pattern, label] of [
    [/[A-Za-z]:\\Users\\/i, 'absolute Windows user path'],
    [/\/Users\/[^/\s]+\//, 'absolute macOS user path'],
    [/\/home\/[^/\s]+\//, 'absolute Linux user path'],
    [/eyJ[A-Za-z0-9_-]{20,}\./, 'JWT literal'],
    [/ya29\.[A-Za-z0-9_-]{10,}/, 'OAuth token literal'],
    [/refresh_token["']?\s*[:=]\s*["'](?!r1|r2|revoked)[A-Za-z0-9_-]{20,}/, 'refresh token assignment'],
  ]) {
    if (pattern.test(text)) fail(`${label} found in ${relative}`);
  }
}

// 7) README must document the essentials
for (const relative of ['README.md', 'README.zh.md']) {
  const text = readFileSync(path.join(ROOT, relative), 'utf8');
  if (!/mcp__coros__/.test(text)) warn(`${relative} does not mention the mcp__coros__ tool prefix`);
  if (!/token/i.test(text)) warn(`${relative} does not explain token storage`);
}

if (warnings.length) {
  process.stderr.write(`prepack warnings:\n${warnings.map((line) => `  - ${line}`).join('\n')}\n`);
}
if (failures.length) {
  process.stderr.write(`prepack FAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`prepack ok: ${pkg.name}@${pkg.version} (${pkg.files.length} published entries)\n`);
