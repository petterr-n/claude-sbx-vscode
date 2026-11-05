'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadExtension, WRAPPER, tempDir } = require('./helpers');

const t = loadExtension()._test;

test('expandHome replaces a leading ~ only', () => {
  assert.equal(t.expandHome('~/bin/claude-sbx'), path.join(os.homedir(), 'bin/claude-sbx'));
  assert.equal(t.expandHome('/usr/local/bin/x'), '/usr/local/bin/x');
  assert.equal(t.expandHome(''), '');
});

test('isSbxWrapper recognises the wrapper by file name', () => {
  assert.equal(t.isSbxWrapper('/Users/me/bin/claude-sbx'), true);
  assert.equal(t.isSbxWrapper('/usr/local/bin/claude'), false);
  assert.equal(t.isSbxWrapper(''), false);
});

test('isUnder', () => {
  assert.equal(t.isUnder('/a/b', '/a/b'), true);
  assert.equal(t.isUnder('/a/b/c', '/a/b'), true);
  assert.equal(t.isUnder('/a/b/c', '/a/b/'), true);
  assert.equal(t.isUnder('/a/bc', '/a/b'), false);
  assert.equal(t.isUnder('/a', '/a/b'), false);
});

test('sandboxRoots combines workspaces and the host side of mounts', () => {
  assert.deepEqual(t.sandboxRoots({ workspaces: ['/w'], mounts: ['/m:/in/box', '/n'] }), ['/w', '/m', '/n']);
  assert.deepEqual(t.sandboxRoots({}), []);
});

test('sandboxForFolder picks the most specific match', () => {
  const list = [
    { name: 'outer', workspaces: ['/p'] },
    { name: 'inner', workspaces: ['/p/app'] },
    { name: 'other', workspaces: ['/q'] },
    null,
    { workspaces: ['/p/app/deep'] }, // no name: ignored
  ];
  assert.equal(t.sandboxForFolder(list, '/p/app/src').name, 'inner');
  assert.equal(t.sandboxForFolder(list, '/p/lib').name, 'outer');
  assert.equal(t.sandboxForFolder(list, '/elsewhere'), undefined);
});

test('newSandboxName follows sbx naming and avoids taken names', () => {
  assert.equal(t.newSandboxName([], '/x/My Project!'), 'claude-my-project');
  assert.equal(t.newSandboxName([{ name: 'claude-app' }, { name: 'claude-app-2' }], '/x/app'), 'claude-app-3');
  assert.equal(t.newSandboxName([], '/x/___'), 'claude-workspace');
});

test('wrapperDefault reads ${VAR:-default} from the real wrapper', () => {
  assert.equal(t.wrapperDefault(WRAPPER, 'CLAUDE_SBX_BIN'), 'sbx');
  assert.equal(t.wrapperDefault(WRAPPER, 'CLAUDE_SBX_NAME'), '');
  assert.equal(t.wrapperDefault('/does/not/exist', 'CLAUDE_SBX_BIN'), undefined);
});

test('wrapperText writes the found sbx path into the bundled wrapper', () => {
  const dir = tempDir();
  fs.copyFileSync(WRAPPER, path.join(dir, 'claude-sbx'));
  const ctx = { extensionPath: dir };

  const filled = t.wrapperText(ctx, '/opt/homebrew/bin/sbx');
  assert.match(filled, /^SBX_BIN="\$\{CLAUDE_SBX_BIN:-\/opt\/homebrew\/bin\/sbx\}"$/m);
  // A bare name (found on PATH) leaves the wrapper unchanged.
  assert.equal(t.wrapperText(ctx, 'sbx'), fs.readFileSync(WRAPPER, 'utf8'));

  fs.writeFileSync(path.join(dir, 'claude-sbx'), '#!/bin/bash\necho no sbx line\n');
  assert.throws(() => t.wrapperText(ctx, '/x/sbx'), /no SBX_BIN line/);
});
