'use strict';
// Shared test helpers: load extension.js without VS Code, and run the real wrapper against a fake sbx.

const Module = require('module');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Loads extension.js with a minimal stand-in for the `vscode` module (only needed at require time). */
function loadExtension() {
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return {};
    return origLoad.call(this, request, ...rest);
  };
  try {
    return require('../extension.js');
  } finally {
    Module._load = origLoad;
  }
}

const WRAPPER = path.resolve(__dirname, '..', '..', 'claude-sbx');

/** Temp dirs created by this test file, deleted when its process exits (each test file runs in its own process). */
const created = [];
process.on('exit', () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort: never fail the run over cleanup */
    }
  }
});

/** A temp dir with symlinks resolved (macOS /var -> /private/var), so it matches bash's $PWD. Deleted after the tests. */
function tempDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sbx-test-')));
  created.push(dir);
  return dir;
}

/**
 * Writes a fake `sbx`: `ls --json` prints `list` (or fails if list is null),
 * `exec ...` prints its arguments as JSON instead of running anything.
 */
function fakeSbx(dir, list) {
  const json = path.join(dir, 'ls.json');
  if (list !== null) fs.writeFileSync(json, JSON.stringify(list));
  const bin = path.join(dir, 'sbx');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env bash
if [[ "$1" == ls ]]; then
  [[ -f "${json}" ]] || { echo "sbx: daemon not running" >&2; exit 1; }
  cat "${json}"
  exit 0
fi
node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"
`
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** Runs the real claude-sbx wrapper from `cwd` with the fake sbx. Returns status, stderr and the parsed `sbx` argv. */
function runWrapper({ cwd, sbx, args = [], env = {}, home = tempDir() }) {
  const r = spawnSync('bash', [WRAPPER, ...args], {
    cwd,
    encoding: 'utf8',
    // A temp HOME, so a "run outside the sandbox" flag on this machine doesn't change the result.
    env: { ...process.env, HOME: home, PWD: cwd, CLAUDE_SBX_NAME: '', ...env, CLAUDE_SBX_BIN: sbx },
  });
  let argv;
  try {
    argv = JSON.parse(r.stdout);
  } catch {
    argv = undefined;
  }
  return { status: r.status, stderr: r.stderr, argv };
}

module.exports = { loadExtension, WRAPPER, tempDir, fakeSbx, runWrapper };
