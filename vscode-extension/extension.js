// @ts-check
'use strict';

// Status bar badge: is the Claude Code extension running Claude inside a Docker Sandbox?
//
// "✓" means: claudeCode.claudeProcessWrapper points at claude-sbx, the wrapper file exists,
// `sbx ls --json` reports the sandbox as running, and the open folder is mounted in it.
// It checks configuration + sandbox state; it can't see inside the Claude panel itself.
//
// The sandbox is picked like the wrapper does: an explicit name if one is set, otherwise the
// sandbox whose workspace contains the open folder. In sandboxed mode, if no sandbox mounts the
// folder, it offers to create one.

const vscode = require('vscode');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_SECTION = 'claudeCode';
const WRAPPER_KEY = 'claudeProcessWrapper';
const LAST_WRAPPER_KEY = 'claudeSbx.lastWrapper';
const NEVER_CREATE_KEY = 'claudeSbx.neverOfferCreate';
const SETUP_PROMPTED_KEY = 'claudeSbx.setupPrompted';
/** SHA-256 of wrapper files you installed or chose to keep during setup. */
const TRUSTED_HASHES_KEY = 'claudeSbx.trustedWrapperHashes';
const DEFAULT_WRAPPER = '~/.local/bin/claude-sbx';
// The line in the bundled wrapper where setup writes in the sbx path it found.
const SBX_BIN_LINE = /^SBX_BIN="\$\{CLAUDE_SBX_BIN:-[^}]*\}"$/m;
// Setup writes the sbx path inside a bash "…" string, so only allow characters that are plain text there
// (no $, `, ", \, } or newlines).
const SAFE_SBX_PATH = /^\/[A-Za-z0-9 ._/+@-]+$/;
// macOS GUI apps often don't inherit the shell PATH, so look in the usual places too.
const SBX_CANDIDATES = ['/opt/homebrew/bin/sbx', '/usr/local/bin/sbx', path.join(os.homedir(), '.docker/bin/sbx')];

/** @type {vscode.StatusBarItem} */
let item;
/** @type {vscode.OutputChannel} */
let log;
/** @type {NodeJS.Timeout | undefined} */
let timer;
let refreshing = false;
/** @type {{ kind: string, sandbox?: string, sbx?: string } } */
let lastState = { kind: 'init' };
/** @type {vscode.ExtensionContext} */
let ctx;
/** Folders we've already offered to create a sandbox for in this window (refresh runs every few seconds). */
const offered = new Set();
let creating = false;
/** Ids of findings you marked as reviewed (see hostRunFindings). */
const REVIEWED_KEY = 'claudeSbx.reviewedHostRunFindings';
/** Findings from the last refresh that you haven't reviewed yet. */
/** @type {{ id: string, file: string, detail: string }[]} */
let unreviewed = [];
/** Finding ids already shown in a notification in this window. */
const notified = new Set();

function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reads `${VAR:-default}` from wrapper script text. */
function defaultFromText(text, varName) {
  const m = text.match(new RegExp('\\$\\{' + varName + ':-([^}]*)\\}'));
  return m ? m[1].trim() : undefined;
}

/** Reads `${VAR:-default}` from the wrapper script, so the badge matches what the wrapper will do. */
function wrapperDefault(wrapperPath, varName) {
  try {
    return defaultFromText(fs.readFileSync(wrapperPath, 'utf8'), varName);
  } catch {
    return undefined;
  }
}

function cfg() {
  return vscode.workspace.getConfiguration('claudeSbx');
}

/**
 * A claudeSbx setting, read from user settings only. These settings decide which programs run on this
 * machine, and code inside a sandbox can write the workspace's .vscode/settings.json (the project folder
 * is mounted read-write), so workspace values are ignored. package.json also gives these settings
 * "machine" scope, so VS Code doesn't accept them in workspace settings.
 * @param {string} key @param {string} fallback
 */
function userSetting(key, fallback) {
  const info = cfg().inspect(key);
  const v = info && info.globalValue !== undefined ? info.globalValue : info && info.defaultValue;
  return String(v === undefined || v === null ? fallback : v).trim();
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Says why `p` isn't safe to run, or returns undefined if it is. Checks the real file (symlinks
 * resolved) and its folder: both must belong to you or root and must not be writable by group or others.
 * @param {string} p
 */
function fileProblem(p) {
  if (!path.isAbsolute(p)) return `${p} is not an absolute path`;
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    return `${p} doesn't exist`;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const f of [real, path.dirname(real)]) {
    const st = fs.statSync(f);
    if (uid !== undefined && st.uid !== uid && st.uid !== 0) return `${f} belongs to another user`;
    if (st.mode & 0o022) return `${f} is writable by group or others`;
  }
  return undefined;
}

/** Every host path any sandbox mounts. A sandbox can write to all of them. */
function allRoots(list) {
  return list.flatMap((s) => (s ? sandboxRoots(s) : []));
}

/** The sandbox-mounted folder that contains `p` (as given or with symlinks resolved), if any. */
function mountedRoot(p, roots) {
  const candidates = [p, realOrSelf(p)];
  return roots.find((r) => candidates.some((c) => isUnder(c, r) || isUnder(c, realOrSelf(r))));
}

/** Says whether the wrapper or the sbx it uses lives where a sandbox can change it, or returns undefined. */
function locationProblem(wrapperPath, sbx, list) {
  const roots = allRoots(list);
  const w = mountedRoot(wrapperPath, roots);
  if (w) return `${wrapperPath} is inside ${w}, which a sandbox mounts, so code in the sandbox could change it`;
  const s = sbx.includes('/') ? mountedRoot(sbx, roots) : undefined;
  if (s) return `sbx (${sbx}) is inside ${s}, which a sandbox mounts, so code in the sandbox could change it`;
  return undefined;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Remembers a wrapper file's contents as trusted (you installed it, or chose to keep it, during setup). */
async function trustWrapperText(context, text) {
  const hashes = context.globalState.get(TRUSTED_HASHES_KEY) || [];
  const h = sha256(text);
  if (!hashes.includes(h)) await context.globalState.update(TRUSTED_HASHES_KEY, [...hashes, h].slice(-20));
}

/**
 * True if the file is the bundled wrapper (with a safe sbx path filled in), or contents you trusted during
 * setup. A file that only happens to be named claude-sbx doesn't count.
 */
function isKnownWrapper(context, wrapperPath) {
  let text;
  try {
    text = fs.readFileSync(wrapperPath, 'utf8');
  } catch {
    return false;
  }
  if ((context.globalState.get(TRUSTED_HASHES_KEY) || []).includes(sha256(text))) return true;
  const baked = defaultFromText(text, 'CLAUDE_SBX_BIN');
  if (baked === undefined) return false;
  try {
    return text === wrapperText(context, baked);
  } catch {
    return false;
  }
}

/** Checks the wrapper file itself (permissions and contents). Returns a problem, or undefined. */
function wrapperFileProblem(context, wrapperPath) {
  const p = fileProblem(wrapperPath);
  if (p) return p;
  if (!isKnownWrapper(context, wrapperPath)) return `${wrapperPath} doesn't match the wrapper this extension installs`;
  return undefined;
}

/** First workspace or folder value among `inspect()` results, i.e. a value the workspace sets rather than you. */
function workspaceValueOf(infos) {
  for (const i of infos) {
    if (!i) continue;
    if (i.workspaceValue !== undefined) return String(i.workspaceValue);
    if (i.workspaceFolderValue !== undefined) return String(i.workspaceFolderValue);
  }
  return undefined;
}

/** All the places the workspace can set claudeCode.claudeProcessWrapper: the workspace and each folder. */
function wrapperScopes() {
  const folders = vscode.workspace.workspaceFolders || [];
  return [
    { conf: vscode.workspace.getConfiguration(CLAUDE_SECTION), target: vscode.ConfigurationTarget.Workspace },
    ...folders.map((f) => ({ conf: vscode.workspace.getConfiguration(CLAUDE_SECTION, f.uri), target: vscode.ConfigurationTarget.WorkspaceFolder })),
  ];
}

/** claudeCode.claudeProcessWrapper as set by workspace settings (not by you), if it is. */
function workspaceWrapperValue() {
  return workspaceValueOf(wrapperScopes().map((s) => s.conf.inspect(WRAPPER_KEY)));
}

/** Removes claudeCode.claudeProcessWrapper from workspace and folder settings. */
async function clearWorkspaceWrapper() {
  for (const { conf, target } of wrapperScopes()) {
    const info = conf.inspect(WRAPPER_KEY);
    const v = info && (target === vscode.ConfigurationTarget.Workspace ? info.workspaceValue : info.workspaceFolderValue);
    if (v !== undefined) await conf.update(WRAPPER_KEY, undefined, target);
  }
}

// ---------------------------------------------------------------------------
// Files in a mounted folder that tools on this machine run. The sandbox can write them, so a change
// there can run code outside the sandbox: git runs hooks and config commands (VS Code's Git extension
// runs `git status` by itself, which triggers core.fsmonitor), and VS Code can run tasks when a folder opens.
// This can only detect such changes, not prevent them. The real fix is sbx's clone mode (see README).

/** Parses git config text into `section[.subsection].name` keys (section and name lowercased, like git). */
function parseGitConfig(text) {
  /** @type {{ key: string, value: string, line: number }[]} */
  const out = [];
  let section = '';
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^\s+/, '');
    if (!line || line[0] === '#' || line[0] === ';') return;
    const sec = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/);
    if (sec) {
      // [a.b] is the old spelling of [a "b"].
      const [name, ...rest] = sec[1].split('.');
      const sub = sec[2] !== undefined ? sec[2].replace(/\\(.)/g, '$1') : rest.join('.');
      section = name.toLowerCase() + (sub ? '.' + sub : '');
      const after = line.slice(sec[0].length).trim();
      if (!after) return;
      // A key on the same line as its section header.
      const kv = after.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/);
      if (kv && section) out.push({ key: `${section}.${kv[1].toLowerCase()}`, value: (kv[2] || 'true').trim(), line: i + 1 });
      return;
    }
    const kv = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/);
    if (kv && section) out.push({ key: `${section}.${kv[1].toLowerCase()}`, value: (kv[2] || 'true').trim(), line: i + 1 });
  });
  return out;
}

// Git config keys whose value is a command (or a path to one, or a file of more config) that git runs.
const GIT_COMMAND_KEYS = [
  /^core\.(fsmonitor|hookspath|pager|editor|sshcommand|askpass|gitproxy)$/,
  /^(sequence\.editor|diff\.external|gpg\.program|gpg\.[^.]+\.program|credential\.helper|credential\..+\.helper)$/,
  /^diff\..+\.(textconv|command)$/,
  /^merge\..+\.driver$/,
  /^filter\..+\.(clean|smudge|process)$/,
  /^pager\.[^.]+$/,
  /^remote\..+\.(uploadpack|receivepack)$/,
  /^(include\.path|includeif\..+\.path)$/,
  /^(web\.browser|browser\..+\.(cmd|path)|man\..+\.(cmd|path))$/,
];
const GIT_BOOL = /^(true|false|yes|no|on|off|1|0|)$/i;

/** Why this git config entry can run a command, or undefined. */
function gitEntryRisk({ key, value }) {
  // core.fsmonitor=true is git's built-in daemon; any other value is a command to run.
  if (key === 'core.fsmonitor' && GIT_BOOL.test(value)) return undefined;
  if (key.startsWith('pager.') && GIT_BOOL.test(value)) return undefined;
  if (GIT_COMMAND_KEYS.some((re) => re.test(key))) return 'git runs this as a command (or loads it as config)';
  if (key.startsWith('alias.') && value.replace(/^"/, '').startsWith('!')) return 'this alias runs a shell command';
  if (/^(remote\..+\.(url|pushurl)|url\..+\.(insteadof|pushinsteadof))$/.test(key) && /^"?ext::/.test(value))
    return 'an ext:: URL runs a command';
  return undefined;
}

/** The git directory for a folder: `.git`, or where a `.git` file (worktree/submodule) points. */
function gitDirOf(folder) {
  const dotGit = path.join(folder, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(folder, m[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Things in `folder` (and git repos one level down) that would run code on this machine and that a
 * sandbox mounting the folder could have written. Each finding has a stable id: it changes when the
 * content changes, so a reviewed finding comes back if it's edited.
 * @returns {{ id: string, file: string, detail: string }[]}
 */
function hostRunFindings(folder) {
  /** @type {{ id: string, file: string, detail: string }[]} */
  const found = [];
  const add = (file, detail, content) => found.push({ id: sha256([file, detail, content].join('\0')), file, detail });

  /** @type {string[]} */
  let dirs = [folder];
  try {
    dirs = dirs.concat(
      fs
        .readdirSync(folder, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== '.git' && d.name !== 'node_modules')
        .map((d) => path.join(folder, d.name))
    );
  } catch {
    /* unreadable folder: just check the folder itself */
  }

  for (const dir of dirs) {
    const gitDir = gitDirOf(dir);
    if (gitDir) {
      const configFile = path.join(gitDir, 'config');
      try {
        for (const e of parseGitConfig(fs.readFileSync(configFile, 'utf8'))) {
          const risk = gitEntryRisk(e);
          if (risk) add(configFile, `line ${e.line}: ${e.key} = ${e.value} (${risk})`, `${e.key}=${e.value}`);
        }
      } catch {
        /* no config */
      }
      const hooksDir = path.join(gitDir, 'hooks');
      try {
        for (const h of fs.readdirSync(hooksDir)) {
          if (h.endsWith('.sample')) continue;
          const f = path.join(hooksDir, h);
          if (!isExecutable(f) || !fs.statSync(f).isFile()) continue;
          add(f, `git hook "${h}" (git runs it on the matching git command)`, fs.readFileSync(f, 'utf8'));
        }
      } catch {
        /* no hooks dir */
      }
    }
    const tasks = path.join(dir, '.vscode', 'tasks.json');
    try {
      const text = fs.readFileSync(tasks, 'utf8');
      if (/"runOn"\s*:\s*"folderOpen"/.test(text)) add(tasks, 'a task with "runOn": "folderOpen" (VS Code can run it when the folder opens)', text);
    } catch {
      /* no tasks.json */
    }
  }
  return found;
}

/**
 * Why a new sandbox must not mount these folders, or undefined. A mount the sandbox can write must not
 * contain your home folder, the wrapper or sbx, or code in the sandbox could change what runs on this machine.
 * @param {string[]} folders @param {{ home: string, wrapperPath?: string, sbx?: string }} o
 */
function mountRefusal(folders, { home, wrapperPath, sbx }) {
  for (const f of folders) {
    if (isUnder(home, f)) return `${f} is your home folder or contains it`;
    if (wrapperPath && path.isAbsolute(wrapperPath) && mountedRoot(wrapperPath, [f])) return `${f} contains the wrapper (${wrapperPath})`;
    if (sbx && sbx.includes('/') && mountedRoot(sbx, [f])) return `${f} contains sbx (${sbx})`;
  }
  return undefined;
}

function currentWrapper() {
  return (vscode.workspace.getConfiguration(CLAUDE_SECTION).get(WRAPPER_KEY) || '').toString().trim();
}

function isSbxWrapper(wrapper) {
  return !!wrapper && path.basename(wrapper).includes('claude-sbx');
}

/** A sandbox name set explicitly (setting, env var or wrapper default). Empty means: look it up by folder. */
function explicitSandboxName(wrapperPath) {
  return (
    userSetting('sandboxName', '') ||
    process.env.CLAUDE_SBX_NAME ||
    wrapperDefault(wrapperPath, 'CLAUDE_SBX_NAME') ||
    ''
  );
}

function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

function resolveSbx(wrapperPath) {
  const explicit = userSetting('sbxPath', '') || process.env.CLAUDE_SBX_BIN || '';
  if (explicit) return expandHome(explicit);
  const fromWrapper = wrapperDefault(wrapperPath, 'CLAUDE_SBX_BIN');
  if (fromWrapper && fromWrapper.includes('/')) return expandHome(fromWrapper);
  for (const c of SBX_CANDIDATES) if (isExecutable(c)) return c;
  return 'sbx'; // fall back to PATH
}

/** @returns {Promise<any[]>} */
function sbxList(sbx) {
  return new Promise((resolve, reject) => {
    execFile(sbx, ['ls', '--json'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().trim()));
      try {
        const data = JSON.parse(stdout);
        resolve(Array.isArray(data) ? data : []);
      } catch (e) {
        reject(new Error('could not parse `sbx ls --json` output: ' + e.message));
      }
    });
  });
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Host paths a sandbox mounts. */
function sandboxRoots(sandbox) {
  return (sandbox.workspaces || [])
    .concat((sandbox.mounts || []).map((m) => String(m).split(':')[0]))
    .filter((r) => typeof r === 'string' && r);
}

/** The sandbox with the most specific workspace containing `folder` (same rule as the wrapper). */
function sandboxForFolder(list, folder) {
  let best;
  let bestLen = -1;
  for (const s of list) {
    if (!s || !s.name) continue;
    for (const r of sandboxRoots(s)) {
      if (isUnder(folder, r) && r.length > bestLen) {
        best = s;
        bestLen = r.length;
      }
    }
  }
  return best;
}

/** Folders open in VS Code that aren't mounted in the sandbox (the wrapper's `-w "$PWD"` would fail there). */
function unmountedFolders(sandbox) {
  const roots = sandboxRoots(sandbox);
  return workspaceFolderPaths().filter((folder) => !roots.some((r) => isUnder(folder, r)));
}

/** sbx's default name is <agent>-<folder>; keep to its allowed characters and avoid taken names. */
function newSandboxName(list, folder) {
  const base =
    path
      .basename(folder)
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^[^a-z0-9]+|-+$/g, '') || 'workspace';
  const taken = new Set(list.map((s) => s && s.name));
  let name = `claude-${base}`;
  for (let i = 2; taken.has(name); i++) name = `claude-${base}-${i}`;
  return name;
}

/** @param {string} text @param {string} tooltip @param {boolean} warn */
function show(text, tooltip, warn) {
  item.text = text;
  item.tooltip = new vscode.MarkdownString(tooltip + '\n\n_Click for options._');
  item.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  item.show();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const wrapper = currentWrapper();

    // A wrapper from workspace settings could have been written from inside a sandbox. Don't read or run
    // anything based on it.
    const fromWorkspace = workspaceWrapperValue();
    if (fromWorkspace !== undefined) {
      lastState = { kind: 'wrapper-workspace' };
      show(
        `$(warning) Claude: workspace wrapper`,
        `**This workspace's settings set \`claudeCode.claudeProcessWrapper\`** to \`${fromWorkspace}\`.\n\nCode inside a sandbox can write workspace settings, so this could run code on this machine when the Claude panel starts. Remove it from the workspace settings, or run **Claude sbx: Set Up Sandboxed Claude**. Setup sets the wrapper in your user settings and clears the workspace value.`,
        true
      );
      return;
    }

    if (!isSbxWrapper(wrapper)) {
      lastState = { kind: 'local' };
      if (cfg().get('showWhenLocal', true)) {
        const note = wrapper ? `A different process wrapper is set: \`${wrapper}\`.` : 'No process wrapper is set.';
        show('$(device-desktop) Claude: local', `**Claude runs directly on this machine**, not in a sandbox.\n\n${note}`, false);
      } else {
        item.hide();
      }
      return;
    }

    const wrapperPath = expandHome(wrapper);
    const untrusted = (/** @type {string} */ problem) => {
      lastState = { kind: 'wrapper-unsafe' };
      show(
        `$(warning) sbx: wrapper not trusted`,
        `The Claude panel will start \`${wrapperPath}\`, but ${problem}.\n\nRun **Claude sbx: Set Up Sandboxed Claude** to reinstall it.`,
        true
      );
    };

    if (!isExecutable(wrapperPath)) {
      lastState = { kind: 'wrapper-missing' };
      show(`$(warning) sbx: wrapper missing`, `\`${wrapperPath}\` doesn't exist or isn't executable, so the Claude panel can't start.\n\nRun **Claude sbx: Set Up Sandboxed Claude** to install it.`, true);
      return;
    }
    // Check the wrapper before using the sbx path written into it.
    const fileIssue = wrapperFileProblem(ctx, wrapperPath);
    if (fileIssue) return untrusted(fileIssue);

    const sbx = resolveSbx(wrapperPath);
    const sbxIssue = sbx.includes('/') ? fileProblem(sbx) : undefined;
    if (sbxIssue) return untrusted(`the sbx it runs isn't safe: ${sbxIssue}`);

    let list;
    try {
      list = await sbxList(sbx);
    } catch (e) {
      lastState = { kind: 'sbx-error' };
      log.appendLine(`[${new Date().toISOString()}] ${sbx} ls --json failed: ${e.message}`);
      show(`$(warning) sbx: error`, `Couldn't run \`${sbx} ls --json\`:\n\n\`${e.message}\`\n\nSet **claudeSbx.sbxPath** if sbx isn't found.`, true);
      return;
    }

    const where = locationProblem(wrapperPath, sbx, list);
    if (where) return untrusted(where);

    scanHostRunFiles(list);

    const explicit = explicitSandboxName(wrapperPath);
    // Only set once sbx has passed every check: start/create use lastState.sbx.
    lastState = { kind: 'checking', sandbox: explicit || undefined, sbx };

    const folders = workspaceFolderPaths();
    if (!explicit && !folders.length) {
      lastState.kind = 'no-folder';
      show(`$(vm) sbx: on`, 'Claude runs in a Docker Sandbox. Open a folder to pick its sandbox.', false);
      return;
    }

    const sandbox = explicit ? list.find((s) => s && s.name === explicit) : sandboxForFolder(list, folders[0]);
    if (!sandbox) {
      const names = list.map((s) => s.name).join(', ') || 'none';
      if (explicit) {
        lastState.kind = 'not-found';
        show(`$(warning) sbx: ${explicit} not found`, `No sandbox named **${explicit}**.\n\nExisting sandboxes: ${names}`, true);
      } else {
        lastState.kind = 'no-sandbox';
        show(
          `$(warning) sbx: no sandbox`,
          `No Docker Sandbox mounts \`${folders[0]}\`, so the Claude panel can't start here.\n\nExisting sandboxes: ${names}`,
          true
        );
        offerCreate(folders[0]);
      }
      return;
    }
    const name = sandbox.name;
    lastState.sandbox = name;

    const status = String(sandbox.status || 'unknown');
    if (status !== 'running') {
      lastState.kind = 'stopped';
      show(
        `$(vm-outline) sbx: ${name} $(warning)`,
        `Sandbox **${name}** is **${status}**.\n\nOpening the Claude panel starts it automatically (\`sbx exec\` does), or pick **Start sandbox** from the menu.`,
        true
      );
      return;
    }

    const missing = unmountedFolders(sandbox);
    if (missing.length) {
      lastState.kind = 'not-mounted';
      show(
        `$(vm-running) sbx: ${name} $(warning)`,
        `Sandbox **${name}** is running, but this folder isn't mounted in it:\n\n${missing.map((m) => `- \`${m}\``).join('\n')}\n\nClaude can't start here through the wrapper.`,
        true
      );
      return;
    }

    if (unreviewed.length) {
      lastState.kind = 'host-run';
      show(
        `$(vm-running) sbx: ${name} $(warning)`,
        `**Claude runs inside Docker Sandbox \`${name}\`**, but the mounted folder has ${unreviewed.length} thing(s) that tools on this machine run, which code in the sandbox could have written:\n\n${unreviewed
          .slice(0, 5)
          // The details come from files the sandbox can write: keep them out of Markdown syntax.
          .map((f) => `- \`${f.file.replace(/`/g, "'")}\`: ${f.detail.replace(/[`*_[\]<>\\]/g, ' ')}`)
          .join('\n')}\n\nPick **Review files that run on this machine** from the menu.`,
        true
      );
      return;
    }

    lastState.kind = 'ok';
    show(
      `$(vm-running) sbx: ${name} $(check)`,
      `**Claude runs inside Docker Sandbox \`${name}\`.**\n\nWrapper: \`${wrapperPath}\`\n\nIf you just changed the wrapper setting, reload the window so the Claude panel picks it up.`,
      false
    );
  } finally {
    refreshing = false;
  }
}

async function offerReload(message) {
  const choice = await vscode.window.showInformationMessage(message, 'Reload Window');
  if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/** @param {vscode.ExtensionContext} context */
async function toggle(context) {
  const conf = vscode.workspace.getConfiguration(CLAUDE_SECTION);
  const info = conf.inspect(WRAPPER_KEY);
  const wrapper = currentWrapper();

  if (isSbxWrapper(wrapper)) {
    // Remember only a wrapper you set yourself, never one that came from workspace settings.
    if (info && isSbxWrapper(String(info.globalValue || ''))) await context.globalState.update(LAST_WRAPPER_KEY, info.globalValue);
    // Clear it wherever it's set, otherwise a workspace value would keep overriding.
    await clearWorkspaceWrapper();
    if (info && info.globalValue !== undefined) await conf.update(WRAPPER_KEY, undefined, vscode.ConfigurationTarget.Global);
    await refresh();
    await offerReload('Claude sandbox wrapper turned off. Reload the window so the Claude panel runs locally.');
  } else {
    const target = expandHome(context.globalState.get(LAST_WRAPPER_KEY) || userSetting('wrapperPath', DEFAULT_WRAPPER));
    if (!isExecutable(target)) {
      const choice = await vscode.window.showErrorMessage(`Wrapper not found or not executable: ${target}.`, 'Run setup');
      if (choice === 'Run setup') await setup(context);
      return;
    }
    const problem = await checkWrapper(context, target);
    if (problem) {
      stamp(`not turning on ${target}: ${problem}`);
      const choice = await vscode.window.showErrorMessage(`Not turning on the wrapper: ${problem}.`, 'Run setup');
      if (choice === 'Run setup') await setup(context);
      return;
    }
    await setWrapperSetting(target);
    await refresh();
    await offerReload('Claude sandbox wrapper turned on. Reload the window so the Claude panel starts inside the sandbox.');
  }
}

/** Checks the open folders that a sandbox mounts for files tools on this machine run. Notifies once per new finding. */
function scanHostRunFiles(list) {
  const roots = allRoots(list);
  const reviewed = ctx.globalState.get(REVIEWED_KEY) || [];
  const findings = workspaceFolderPaths()
    .filter((f) => mountedRoot(f, roots))
    .flatMap((f) => hostRunFindings(f));
  unreviewed = findings.filter((f) => !reviewed.includes(f.id));
  const fresh = unreviewed.filter((f) => !notified.has(f.id));
  if (!fresh.length) return;
  fresh.forEach((f) => {
    notified.add(f.id);
    stamp(`host-run file in a mounted folder: ${f.file}: ${f.detail}`);
  });
  vscode.window
    .showWarningMessage(
      `${fresh.length} file(s) in a folder the sandbox can write would run code on this machine (git config or hooks, or VS Code tasks). Check that you made these changes.`,
      'Review',
      'Show log'
    )
    .then((choice) => {
      if (choice === 'Review') reviewHostRun();
      if (choice === 'Show log') log.show();
    });
}

/** Shows the unreviewed findings and lets you mark them as reviewed. */
async function reviewHostRun() {
  if (!unreviewed.length) {
    vscode.window.showInformationMessage('Nothing to review: no unreviewed git config, git hooks or auto-run tasks in mounted folders.');
    return;
  }
  const items = unreviewed.map((f) => ({ label: path.basename(f.file), description: f.file, detail: f.detail, picked: false, finding: f }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select the entries you made yourself and trust (Esc to cancel). Open a file to check it first.',
  });
  if (!picked || !picked.length) return;
  const reviewed = ctx.globalState.get(REVIEWED_KEY) || [];
  await ctx.globalState.update(REVIEWED_KEY, [...new Set([...reviewed, ...picked.map((p) => p.finding.id)])].slice(-500));
  stamp(`marked as reviewed: ${picked.map((p) => `${p.finding.file}: ${p.finding.detail}`).join('; ')}`);
  await refresh();
}

/** Asks once per folder per window whether to create a sandbox. Doesn't block refresh. */
function offerCreate(folder) {
  if (!cfg().get('offerCreate', true) || creating || offered.has(folder)) return;
  if ((ctx.globalState.get(NEVER_CREATE_KEY) || []).includes(folder)) return;
  offered.add(folder);
  const create = 'Create sandbox';
  const never = "Don't ask for this folder";
  vscode.window
    .showInformationMessage(
      `No Docker Sandbox mounts "${path.basename(folder)}". Create one so Claude runs sandboxed here?`,
      create,
      'Not now',
      never
    )
    .then(async (choice) => {
      if (choice === create) await createSandbox();
      if (choice === never) {
        const list = ctx.globalState.get(NEVER_CREATE_KEY) || [];
        await ctx.globalState.update(NEVER_CREATE_KEY, [...new Set([...list, folder])]);
      }
    });
}

/**
 * Runs `sbx <args>` in a visible terminal with a cancellable progress notification. A real terminal because
 * sbx can stall without a TTY, and you can see its output and answer any prompt there.
 * Resolves true once `isDone()` is true (checked every few seconds and when the terminal closes), false if
 * you cancel or close the terminal first.
 * @param {string} sbx @param {string[]} args @param {string} title @param {() => Promise<boolean>} isDone
 * @returns {Promise<boolean>}
 */
async function sbxInTerminal(sbx, args, title, isDone) {
  const what = `sbx ${args.slice(0, 1).join(' ')}`;
  stamp(`${sbx} ${args.join(' ')} (in terminal)`);
  const term = vscode.window.createTerminal({ name: `sbx ${args.join(' ')}`.slice(0, 60), shellPath: sbx, shellArgs: args });
  term.show();
  const check = async () => {
    try {
      return await isDone();
    } catch {
      return false;
    }
  };
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${title} (see terminal)…`, cancellable: true },
    (_progress, token) =>
      new Promise((resolve) => {
        let done = false;
        /** @type {vscode.Disposable[]} */
        const subs = [];
        const finish = (/** @type {boolean} */ result) => {
          if (done) return;
          done = true;
          clearInterval(poll);
          subs.forEach((d) => d.dispose());
          resolve(result);
        };
        const poll = setInterval(async () => {
          if (await check()) finish(true);
        }, 3000);
        subs.push(
          vscode.window.onDidCloseTerminal(async (t) => {
            if (t !== term) return;
            const code = t.exitStatus && t.exitStatus.code;
            stamp(`${what} exited (code ${code ?? 'unknown'})`);
            finish(await check());
          }),
          token.onCancellationRequested(() => {
            stamp(`${what} cancelled`);
            term.dispose();
            finish(false);
          })
        );
      })
  );
}

/**
 * Removes the sandbox Claude uses for this folder (`sbx rm <name>`), after asking. Files in mounted folders
 * stay; everything inside the sandbox goes. Afterwards refresh offers to create a new one.
 */
async function removeSandbox() {
  const { sandbox: name, sbx } = lastState;
  if (!name || !sbx) {
    vscode.window.showErrorMessage('Claude sbx: no sandbox to remove for this folder. Hover the status bar badge for details.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Remove sandbox ${name}?`,
    {
      modal: true,
      detail:
        'Deletes the sandbox and everything inside it: Claude\'s history and settings there, installed tools and temp files. ' +
        'Your project files on this machine are not touched.\n\nA Claude session running in this sandbox will stop.',
    },
    'Remove sandbox'
  );
  if (choice !== 'Remove sandbox') return;

  // Success = the sandbox is gone from `sbx ls`.
  const ok = await sbxInTerminal(sbx, ['rm', name], `Removing sandbox ${name}`, async () => !(await sbxList(sbx)).some((s) => s && s.name === name));
  if (!ok) {
    stamp(`sandbox ${name} still exists`);
    vscode.window.showWarningMessage(`Sandbox ${name} wasn't removed. Check the terminal output.`);
    return;
  }
  stamp(`removed sandbox ${name}`);
  // Let refresh offer to create a new sandbox for these folders right away.
  workspaceFolderPaths().forEach((f) => offered.delete(f));
  await refresh();
}

/**
 * Creates one sandbox mounting all open folders, named like sbx's default (claude-<folder>).
 * Returns the name of the sandbox that mounts the folder afterwards, or undefined.
 * `quiet`: don't offer a reload at the end (setup does that itself).
 * @param {{ sbx?: string, quiet?: boolean }} [opts]
 * @returns {Promise<string | undefined>}
 */
async function createSandbox(opts = {}) {
  const folders = workspaceFolderPaths();
  // Only an sbx that passed refresh()'s or setup's checks.
  const sbx = opts.sbx || lastState.sbx;
  if (!sbx) {
    vscode.window.showErrorMessage('Claude sbx: the wrapper or sbx failed its safety checks (hover the status bar badge). Run setup first.');
    return undefined;
  }
  if (!folders.length || creating) return undefined;
  creating = true;
  try {
    let list = [];
    try {
      list = await sbxList(sbx);
    } catch (e) {
      vscode.window.showErrorMessage(`Couldn't list sandboxes: ${e.message}`);
      return undefined;
    }
    const existing = sandboxForFolder(list, folders[0]);
    if (existing) {
      if (!opts.quiet) vscode.window.showInformationMessage(`Sandbox ${existing.name} already mounts this folder.`);
      return existing.name;
    }
    const name = newSandboxName(list, folders[0]);
    // The sandbox gets read-write access to every folder below.
    const refusal =
      mountRefusal(folders, { home: os.homedir(), wrapperPath: expandHome(currentWrapper()), sbx }) ||
      mountRefusal(folders, { home: os.homedir(), wrapperPath: expandHome(userSetting('wrapperPath', DEFAULT_WRAPPER)) });
    if (refusal) {
      stamp(`not creating a sandbox: ${refusal}`);
      vscode.window.showErrorMessage(
        `Not creating a sandbox: ${refusal}. The sandbox could change files that run on this machine. Open a project folder instead.`
      );
      return undefined;
    }
    if (folders.length > 1) {
      const choice = await vscode.window.showWarningMessage(
        `Create sandbox ${name} with read-write access to all ${folders.length} open folders?`,
        { modal: true, detail: folders.join('\n') },
        'Create sandbox'
      );
      if (choice !== 'Create sandbox') return undefined;
    }
    const args = ['create', '--name', name, 'claude', ...folders];
    // Success = the new sandbox shows up as running in `sbx ls`.
    const ok = await sbxInTerminal(sbx, args, `Creating sandbox ${name}`, async () => {
      const s = (await sbxList(sbx)).find((x) => x && x.name === name);
      return !!s && String(s.status) === 'running';
    });
    await refresh();
    if (ok && !opts.quiet) await offerReload(`Sandbox ${name} created. Reload the window so the Claude panel starts inside it.`);
    return ok ? name : undefined;
  } finally {
    creating = false;
  }
}

// ---------------------------------------------------------------------------
// One-command setup: install the wrapper, point the Claude extension at it, make sure the
// open folder has a sandbox, and check that Claude actually starts inside it.

/** @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>} */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') })
    );
  });
}

function stamp(msg) {
  log.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

/** Full path to sbx: setting/env/usual places, else the user's login shell (GUI apps on macOS don't get its PATH). */
async function findSbx() {
  const candidate = resolveSbx('');
  if (candidate !== 'sbx') return isExecutable(candidate) ? candidate : undefined;
  const shell = process.env.SHELL || '/bin/zsh';
  const r = await run(shell, ['-lc', 'command -v sbx']);
  const found = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('/'));
  if (found && isExecutable(found)) return found;
  if ((await run('sbx', ['ls', '--json'])).ok) return 'sbx';
  return undefined;
}

/** The bundled wrapper with the sbx path written in as its default. */
function wrapperText(context, sbx) {
  const template = fs.readFileSync(path.join(context.extensionPath, 'claude-sbx'), 'utf8');
  if (!SBX_BIN_LINE.test(template)) throw new Error('bundled claude-sbx has no SBX_BIN line to fill in');
  if (!sbx.includes('/')) return template;
  if (!SAFE_SBX_PATH.test(sbx)) throw new Error(`the sbx path has characters that aren't safe to write into a shell script: ${JSON.stringify(sbx)}`);
  // A function, so `$&`-style patterns in the path aren't expanded by replace().
  return template.replace(SBX_BIN_LINE, () => `SBX_BIN="\${CLAUDE_SBX_BIN:-${sbx}}"`);
}

/**
 * Every check to run before pointing the Claude extension at `wrapperPath`: file permissions and contents,
 * the sbx it uses, and that neither is somewhere a sandbox mounts. Returns a problem, or undefined.
 */
async function checkWrapper(context, wrapperPath) {
  const fileIssue = wrapperFileProblem(context, wrapperPath);
  if (fileIssue) return fileIssue;
  const sbx = resolveSbx(wrapperPath);
  const sbxIssue = sbx.includes('/') ? fileProblem(sbx) : undefined;
  if (sbxIssue) return `the sbx it runs isn't safe: ${sbxIssue}`;
  let list;
  try {
    list = await sbxList(sbx);
  } catch (e) {
    return `couldn't list sandboxes to check where the wrapper is: ${e.message}`;
  }
  return locationProblem(wrapperPath, sbx, list);
}

/** Writes the wrapper to claudeSbx.wrapperPath. Asks before replacing a different file. Returns its path, or undefined if cancelled. */
async function installWrapper(context, sbx, list) {
  const target = expandHome(userSetting('wrapperPath', DEFAULT_WRAPPER));
  if (!path.isAbsolute(target)) throw new Error(`claudeSbx.wrapperPath must be an absolute path (or start with ~): ${target}`);
  // Never put the wrapper where a sandbox could rewrite it.
  const where = locationProblem(target, sbx, list);
  if (where) throw new Error(where);
  const text = wrapperText(context, sbx);
  /** @type {string | undefined} */
  let existing;
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing === text) {
    fs.chmodSync(target, 0o755);
    await trustWrapperText(context, text);
    stamp(`wrapper already up to date: ${target}`);
    return target;
  }
  if (existing !== undefined) {
    const choice = await vscode.window.showWarningMessage(
      `${target} already exists and is different from the wrapper bundled with this extension.`,
      { modal: true, detail: 'Replace keeps a copy of the old file as claude-sbx.bak.' },
      'Replace',
      'Keep mine'
    );
    if (!choice) return undefined;
    if (choice === 'Keep mine') {
      fs.chmodSync(target, 0o755);
      await trustWrapperText(context, existing); // you chose it, so the badge accepts it
      stamp(`kept existing wrapper: ${target} (sha256 ${sha256(existing)})`);
      return target;
    }
    fs.copyFileSync(target, target + '.bak');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  await trustWrapperText(context, text);
  stamp(`installed wrapper: ${target} (sbx: ${sbx})`);
  return target;
}

/**
 * Sets claudeCode.claudeProcessWrapper in user settings and removes any workspace or folder value. The
 * sandbox can write workspace settings, so the wrapper must come from user settings.
 */
async function setWrapperSetting(target) {
  await vscode.workspace.getConfiguration(CLAUDE_SECTION).update(WRAPPER_KEY, target, vscode.ConfigurationTarget.Global);
  await clearWorkspaceWrapper();
}

/** Name of the sandbox Claude will use for the open folder, creating one if the user agrees. */
async function ensureSandbox(sbx, wrapperPath) {
  const list = await sbxList(sbx);
  const explicit = explicitSandboxName(wrapperPath);
  if (explicit) {
    if (list.some((s) => s && s.name === explicit)) return explicit;
    throw new Error(`no sandbox named ${explicit} (set by claudeSbx.sandboxName or CLAUDE_SBX_NAME)`);
  }
  const folders = workspaceFolderPaths();
  const found = sandboxForFolder(list, folders[0]);
  if (found) return found.name;
  const choice = await vscode.window.showInformationMessage(
    `No Docker Sandbox mounts "${path.basename(folders[0])}". Create one now?`,
    { modal: true, detail: 'Runs sbx create in a terminal so you can see its output.' },
    'Create sandbox'
  );
  if (choice !== 'Create sandbox') return undefined;
  return createSandbox({ sbx, quiet: true });
}

/** Runs `claude-sbx --version` from the folder, i.e. exactly the path the Claude panel takes. */
async function testWrapper(wrapperPath, folder) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking that Claude starts inside the sandbox…' },
    () => run(wrapperPath, ['--version'], { cwd: folder, timeout: 120000 })
  );
}

/** @param {vscode.ExtensionContext} context */
async function setup(context) {
  await context.globalState.update(SETUP_PROMPTED_KEY, true);
  if (process.platform === 'win32') {
    vscode.window.showErrorMessage('Claude sbx setup supports macOS and Linux only.');
    return;
  }
  stamp('setup started');
  const fail = async (/** @type {string} */ msg) => {
    stamp(`setup failed: ${msg}`);
    const choice = await vscode.window.showErrorMessage(`Claude sbx setup: ${msg}`, 'Show log');
    if (choice === 'Show log') log.show();
  };

  // 1. sbx
  const sbx = await findSbx();
  if (!sbx) {
    const choice = await vscode.window.showErrorMessage(
      "Claude sbx setup: couldn't find the sbx CLI. Install Docker Sandboxes, or set claudeSbx.sbxPath to its full path.",
      'Open settings'
    );
    if (choice === 'Open settings') vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSbx.sbxPath');
    return;
  }
  stamp(`sbx: ${sbx}`);
  const sbxIssue = sbx.includes('/') ? fileProblem(sbx) : undefined;
  if (sbxIssue) return fail(`not using ${sbx}: ${sbxIssue}`);
  // Needed to keep the wrapper out of every folder a sandbox mounts.
  let list;
  try {
    list = await sbxList(sbx);
  } catch (e) {
    return fail(`couldn't list sandboxes: ${e.message}`);
  }

  // 2. wrapper
  let wrapperPath;
  try {
    wrapperPath = await installWrapper(context, sbx, list);
  } catch (e) {
    return fail(`couldn't install the wrapper: ${e.message}`);
  }
  if (!wrapperPath) return stamp('setup cancelled');
  const installedIssue = wrapperFileProblem(context, wrapperPath);
  if (installedIssue) return fail(`the installed wrapper isn't safe to use: ${installedIssue}`);

  // 3. Claude extension setting
  await setWrapperSetting(wrapperPath);
  await context.globalState.update(LAST_WRAPPER_KEY, wrapperPath);
  stamp(`set ${CLAUDE_SECTION}.${WRAPPER_KEY} = ${wrapperPath}`);
  await refresh();

  const folders = workspaceFolderPaths();
  if (!folders.length && !explicitSandboxName(wrapperPath)) {
    await offerReload('Sandboxed Claude is set up. Open a folder to pick or create its sandbox, then reload.');
    return;
  }

  // 4. sandbox
  let sandbox;
  try {
    sandbox = await ensureSandbox(sbx, wrapperPath);
  } catch (e) {
    return fail(e.message);
  }
  if (!sandbox) {
    stamp('no sandbox for this folder');
    vscode.window.showWarningMessage(
      'The wrapper is set up, but no sandbox mounts this folder yet, so the Claude panel can\'t start here. Use "Claude sbx: Create Sandbox for This Folder" when you\'re ready.'
    );
    return;
  }
  stamp(`sandbox: ${sandbox}`);

  // 5. test
  const cwd = folders[0] || os.homedir();
  const result = await testWrapper(wrapperPath, cwd);
  const version = (result.stdout.match(/\S+ \(Claude Code\)/) || [])[0];
  if (!result.ok || !version) {
    stamp(`test output:\n${result.stdout}\n${result.stderr}`);
    return fail(`Claude didn't start inside ${sandbox}: ${result.stderr.trim().split('\n').pop() || 'no version printed'}`);
  }
  stamp(`test ok: ${version} in ${sandbox}`);
  await refresh();

  // 6. done
  await offerReload(`Sandboxed Claude is ready: ${version} in sandbox ${sandbox}. Reload the window so the Claude panel starts inside it.`);
}

/** Undo setup: unset the wrapper setting and optionally delete the wrapper file. */
async function teardown(context) {
  const conf = vscode.workspace.getConfiguration(CLAUDE_SECTION);
  const info = conf.inspect(WRAPPER_KEY);
  if (info && isSbxWrapper(String(info.workspaceValue || ''))) await conf.update(WRAPPER_KEY, undefined, vscode.ConfigurationTarget.Workspace);
  if (info && isSbxWrapper(String(info.globalValue || ''))) await conf.update(WRAPPER_KEY, undefined, vscode.ConfigurationTarget.Global);
  stamp(`unset ${CLAUDE_SECTION}.${WRAPPER_KEY}`);

  const target = expandHome(userSetting('wrapperPath', DEFAULT_WRAPPER));
  if (fs.existsSync(target) && !isKnownWrapper(context, target)) {
    // Only ever offer to delete the wrapper itself, never some other file the setting points at.
    stamp(`not offering to delete ${target}: it isn't the wrapper this extension installs`);
  } else if (fs.existsSync(target)) {
    const choice = await vscode.window.showInformationMessage(
      `Claude no longer uses the sandbox. Also delete ${target}?`,
      'Delete wrapper',
      'Keep it'
    );
    if (choice === 'Delete wrapper') {
      fs.unlinkSync(target);
      await context.globalState.update(LAST_WRAPPER_KEY, undefined);
      stamp(`deleted ${target}`);
    }
  }
  await refresh();
  await offerReload('Sandboxed Claude setup removed. Reload the window so the Claude panel runs locally. Your sandboxes are untouched.');
}

/** First run: offer setup once if the wrapper isn't in use. */
function maybeOfferSetup(context) {
  if (context.globalState.get(SETUP_PROMPTED_KEY)) return;
  if (isSbxWrapper(currentWrapper())) {
    context.globalState.update(SETUP_PROMPTED_KEY, true);
    return;
  }
  vscode.window
    .showInformationMessage('Run Claude Code inside a Docker Sandbox instead of directly on this machine?', 'Set up', 'Not now', "Don't ask again")
    .then(async (choice) => {
      if (choice === 'Set up') await setup(context);
      if (choice === "Don't ask again") await context.globalState.update(SETUP_PROMPTED_KEY, true);
    });
}

async function startSandbox() {
  const { sandbox, sbx } = lastState;
  if (!sandbox || !sbx) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Starting sandbox ${sandbox}…` },
    () =>
      new Promise((resolve) => {
        // `sbx exec` starts a stopped sandbox before running the command.
        execFile(sbx, ['exec', sandbox, 'true'], { timeout: 120000 }, (err, _out, stderr) => {
          if (err) vscode.window.showErrorMessage(`Couldn't start ${sandbox}: ${(stderr || err.message).toString().trim()}`);
          resolve(undefined);
        });
      })
  );
  await refresh();
}

/** @param {vscode.ExtensionContext} context */
async function menu(context) {
  const on = isSbxWrapper(currentWrapper());
  /** @type {(vscode.QuickPickItem & { run: () => any })[]} */
  const picks = [
    { label: '$(refresh) Refresh status', run: refresh },
    on
      ? { label: '$(device-desktop) Run Claude locally', description: 'unset claudeCode.claudeProcessWrapper', run: () => toggle(context) }
      : { label: '$(vm) Run Claude in the sandbox', description: 'set claudeCode.claudeProcessWrapper', run: () => toggle(context) },
  ];
  if (!on || ['wrapper-missing', 'wrapper-unsafe', 'wrapper-workspace'].includes(lastState.kind))
    picks.unshift({ label: '$(rocket) Set up sandboxed Claude', description: 'install wrapper, pick sandbox, test', run: () => setup(context) });
  if (on && lastState.kind === 'stopped') picks.push({ label: '$(play) Start sandbox', description: lastState.sandbox, run: startSandbox });
  if (on && lastState.kind === 'no-sandbox')
    picks.push({ label: '$(add) Create sandbox for this folder', description: 'sbx create claude …', run: createSandbox });
  if (on && lastState.sandbox && ['ok', 'host-run', 'stopped', 'not-mounted'].includes(lastState.kind))
    picks.push({ label: '$(close) Remove sandbox', description: `sbx rm ${lastState.sandbox}`, run: removeSandbox });
  if (on && unreviewed.length)
    picks.push({ label: '$(shield) Review files that run on this machine', description: `${unreviewed.length} unreviewed`, run: reviewHostRun });
  if (on) picks.push({ label: '$(trash) Remove sandboxed Claude setup', description: 'unset wrapper, optionally delete it', run: () => teardown(context) });
  picks.push({ label: '$(output) Show log', run: () => log.show() });

  const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Claude sbx' });
  if (pick) await pick.run();
}

function schedule() {
  if (timer) clearInterval(timer);
  const seconds = Math.max(3, cfg().get('refreshIntervalSeconds', 15));
  timer = setInterval(refresh, seconds * 1000);
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  ctx = context;
  log = vscode.window.createOutputChannel('Claude sbx');
  item = vscode.window.createStatusBarItem('claudeSbx.status', vscode.StatusBarAlignment.Left, 100);
  item.name = 'Claude sbx';
  item.command = 'claudeSbx.menu';

  context.subscriptions.push(
    log,
    item,
    vscode.commands.registerCommand('claudeSbx.menu', () => menu(context)),
    vscode.commands.registerCommand('claudeSbx.refresh', refresh),
    vscode.commands.registerCommand('claudeSbx.toggle', () => toggle(context)),
    vscode.commands.registerCommand('claudeSbx.createSandbox', () => createSandbox()),
    vscode.commands.registerCommand('claudeSbx.removeSandbox', () => removeSandbox()),
    vscode.commands.registerCommand('claudeSbx.setup', () => setup(context)),
    vscode.commands.registerCommand('claudeSbx.teardown', () => teardown(context)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeSbx.refreshIntervalSeconds')) schedule();
      if (e.affectsConfiguration(`${CLAUDE_SECTION}.${WRAPPER_KEY}`) || e.affectsConfiguration('claudeSbx')) refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
    // Check right away when git config, hooks or tasks change, not just on the next timer tick.
    ...['**/.git/config', '**/.git/hooks/*', '**/.vscode/tasks.json'].map((glob) => {
      const w = vscode.workspace.createFileSystemWatcher(glob);
      w.onDidCreate(() => refresh());
      w.onDidChange(() => refresh());
      return w;
    }),
    vscode.window.onDidChangeWindowState((s) => s.focused && refresh()),
    { dispose: () => timer && clearInterval(timer) }
  );

  schedule();
  refresh();
  maybeOfferSetup(context);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  // Pure helpers, exported for the tests in test/.
  _test: {
    expandHome,
    wrapperDefault,
    isUnder,
    sandboxRoots,
    sandboxForFolder,
    newSandboxName,
    wrapperText,
    isSbxWrapper,
    fileProblem,
    mountedRoot,
    allRoots,
    locationProblem,
    isKnownWrapper,
    wrapperFileProblem,
    workspaceValueOf,
    sha256,
    parseGitConfig,
    gitEntryRisk,
    hostRunFindings,
    mountRefusal,
  },
};
