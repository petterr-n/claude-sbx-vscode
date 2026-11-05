'use strict';
// Runs the real claude-sbx wrapper against a fake `sbx` and checks the command it would run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tempDir, fakeSbx, runWrapper } = require('./helpers');

const { sandboxForFolder } = loadExtension()._test;

/** A project tree: <root>/proj/app/src, plus <root>/other. */
function setup(listFor) {
  const root = tempDir();
  for (const d of ['proj/app/src', 'other', 'bin']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const list = listFor(root);
  return { root, list, sbx: fakeSbx(path.join(root, 'bin'), list) };
}

test('runs claude in the sandbox that mounts the folder, without -t', () => {
  const { root, sbx } = setup((r) => [{ name: 'claude-proj', workspaces: [path.join(r, 'proj')] }]);
  const cwd = path.join(root, 'proj/app');
  const r = runWrapper({ cwd, sbx, args: ['--output-format', 'stream-json'] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.argv, ['exec', '-i', '-w', cwd, 'claude-proj', 'claude', '--output-format', 'stream-json']);
  assert.ok(!r.argv.includes('-t'), 'a TTY would corrupt the JSON stream');
});

test("drops the host claude binary the extension passes first", () => {
  const { root, sbx } = setup((r) => [{ name: 'claude-proj', workspaces: [path.join(r, 'proj')] }]);
  const hostClaude = path.join(root, 'bin', 'claude');
  fs.writeFileSync(hostClaude, '#!/bin/sh\n');
  fs.chmodSync(hostClaude, 0o755);
  const r = runWrapper({ cwd: path.join(root, 'proj'), sbx, args: [hostClaude, '--version'] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.argv.slice(-2), ['claude', '--version']);
  assert.ok(!r.argv.includes(hostClaude));
});

test('CLAUDE_SBX_NAME overrides the lookup', () => {
  const { root, sbx } = setup(() => []);
  const r = runWrapper({ cwd: path.join(root, 'other'), sbx, env: { CLAUDE_SBX_NAME: 'fixed' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.argv[4], 'fixed');
});

test('exits with a hint when no sandbox mounts the folder', () => {
  const { root, sbx } = setup((r) => [{ name: 'claude-proj', workspaces: [path.join(r, 'proj')] }]);
  const r = runWrapper({ cwd: path.join(root, 'other'), sbx });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no Docker Sandbox mounts/);
  assert.match(r.stderr, /sbx create claude/);
});

test("falls back to claude-<folder> when sbx ls fails", () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'My App'));
  const sbx = fakeSbx(path.join(root, 'bin'), null);
  const r = runWrapper({ cwd: path.join(root, 'My App'), sbx });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.argv[4], 'claude-My App');
});

// The sandbox lookup is written twice (bash wrapper + extension). They must agree.
test('wrapper and extension pick the same sandbox', () => {
  const { root, list, sbx } = setup((r) => [
    { name: 'outer', workspaces: [path.join(r, 'proj') + '/'] }, // trailing slash
    { name: 'inner', mounts: [path.join(r, 'proj/app') + ':/in/box'] },
    { name: 'stopped-dup', workspaces: [path.join(r, 'proj/app/src/nothing')] },
    { workspaces: [path.join(r, 'other')] }, // no name: ignored
  ]);
  const cases = { 'proj': 'outer', 'proj/app': 'inner', 'proj/app/src': 'inner', 'other': undefined };
  for (const [rel, expected] of Object.entries(cases)) {
    const cwd = path.join(root, rel);
    const fromExt = sandboxForFolder(list, cwd);
    const r = runWrapper({ cwd, sbx });
    const fromWrapper = r.status === 0 ? r.argv[4] : undefined;
    assert.equal(fromExt && fromExt.name, expected, `extension, ${rel}`);
    assert.equal(fromWrapper, expected, `wrapper, ${rel}: ${r.stderr}`);
  }
});
