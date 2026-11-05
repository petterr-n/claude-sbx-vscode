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
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_SECTION = 'claudeCode';
const WRAPPER_KEY = 'claudeProcessWrapper';
const LAST_WRAPPER_KEY = 'claudeSbx.lastWrapper';
const NEVER_CREATE_KEY = 'claudeSbx.neverOfferCreate';
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

/** Reads `${VAR:-default}` from the wrapper script, so the badge matches what the wrapper will do. */
function wrapperDefault(wrapperPath, varName) {
  try {
    const text = fs.readFileSync(wrapperPath, 'utf8');
    const m = text.match(new RegExp('\\$\\{' + varName + ':-([^}]*)\\}'));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

function cfg() {
  return vscode.workspace.getConfiguration('claudeSbx');
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
    cfg().get('sandboxName', '').trim() ||
    process.env.CLAUDE_SBX_NAME ||
    wrapperDefault(wrapperPath, 'CLAUDE_SBX_NAME') ||
    ''
  );
}

function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

function resolveSbx(wrapperPath) {
  const explicit = cfg().get('sbxPath', '').trim() || process.env.CLAUDE_SBX_BIN || '';
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
    const explicit = explicitSandboxName(wrapperPath);
    const sbx = resolveSbx(wrapperPath);
    lastState = { kind: 'checking', sandbox: explicit || undefined, sbx };

    if (!isExecutable(wrapperPath)) {
      lastState.kind = 'wrapper-missing';
      show(`$(warning) sbx: wrapper missing`, `\`${wrapperPath}\` doesn't exist or isn't executable, so the Claude panel can't start.`, true);
      return;
    }

    let list;
    try {
      list = await sbxList(sbx);
    } catch (e) {
      lastState.kind = 'sbx-error';
      log.appendLine(`[${new Date().toISOString()}] ${sbx} ls --json failed: ${e.message}`);
      show(`$(warning) sbx: error`, `Couldn't run \`${sbx} ls --json\`:\n\n\`${e.message}\`\n\nSet **claudeSbx.sbxPath** if sbx isn't found.`, true);
      return;
    }

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
    await context.globalState.update(LAST_WRAPPER_KEY, wrapper);
    // Clear it wherever it's set, otherwise a workspace value would keep overriding.
    if (info && info.workspaceValue !== undefined) await conf.update(WRAPPER_KEY, undefined, vscode.ConfigurationTarget.Workspace);
    if (info && info.globalValue !== undefined) await conf.update(WRAPPER_KEY, undefined, vscode.ConfigurationTarget.Global);
    await refresh();
    await offerReload('Claude sandbox wrapper turned off. Reload the window so the Claude panel runs locally.');
  } else {
    const target = expandHome(context.globalState.get(LAST_WRAPPER_KEY) || cfg().get('wrapperPath', '~/bin/claude-sbx'));
    if (!isExecutable(target)) {
      vscode.window.showErrorMessage(`Wrapper not found or not executable: ${target}. Set claudeSbx.wrapperPath.`);
      return;
    }
    const scope = info && info.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await conf.update(WRAPPER_KEY, target, scope);
    await refresh();
    await offerReload('Claude sandbox wrapper turned on. Reload the window so the Claude panel starts inside the sandbox.');
  }
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

/** Creates one sandbox mounting all open folders, named like sbx's default (claude-<folder>). */
async function createSandbox() {
  const folders = workspaceFolderPaths();
  const sbx = lastState.sbx || resolveSbx(expandHome(currentWrapper()));
  if (!folders.length || creating) return;
  creating = true;
  try {
    let list = [];
    try {
      list = await sbxList(sbx);
    } catch (e) {
      vscode.window.showErrorMessage(`Couldn't list sandboxes: ${e.message}`);
      return;
    }
    const existing = sandboxForFolder(list, folders[0]);
    if (existing) {
      vscode.window.showInformationMessage(`Sandbox ${existing.name} already mounts this folder.`);
      return;
    }
    const name = newSandboxName(list, folders[0]);
    const args = ['create', '--name', name, 'claude', ...folders];
    log.appendLine(`[${new Date().toISOString()}] ${sbx} ${args.join(' ')} (in terminal)`);
    // Run in a real terminal: sbx create can stall without a TTY, and any prompt it shows can be answered there.
    const term = vscode.window.createTerminal({ name: `sbx create ${name}`, shellPath: sbx, shellArgs: args });
    term.show();
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating sandbox ${name} (see terminal)…`, cancellable: true },
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
          // Success = the new sandbox shows up as running in `sbx ls`.
          const isUp = async () => {
            try {
              const s = (await sbxList(sbx)).find((x) => x && x.name === name);
              return !!s && String(s.status) === 'running';
            } catch {
              return false;
            }
          };
          const poll = setInterval(async () => {
            if (await isUp()) finish(true);
          }, 3000);
          subs.push(
            vscode.window.onDidCloseTerminal(async (t) => {
              if (t !== term) return;
              const code = t.exitStatus && t.exitStatus.code;
              log.appendLine(`[${new Date().toISOString()}] sbx create exited (code ${code ?? 'unknown'})`);
              finish(await isUp());
            }),
            token.onCancellationRequested(() => {
              log.appendLine(`[${new Date().toISOString()}] sbx create cancelled`);
              term.dispose();
              finish(false);
            })
          );
        })
    );
    if (ok) {
      await refresh();
      await offerReload(`Sandbox ${name} created. Reload the window so the Claude panel starts inside it.`);
    } else {
      await refresh();
    }
  } finally {
    creating = false;
  }
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
  if (on && lastState.kind === 'stopped') picks.push({ label: '$(play) Start sandbox', description: lastState.sandbox, run: startSandbox });
  if (on && lastState.kind === 'no-sandbox')
    picks.push({ label: '$(add) Create sandbox for this folder', description: 'sbx create claude …', run: createSandbox });
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
    vscode.commands.registerCommand('claudeSbx.createSandbox', createSandbox),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeSbx.refreshIntervalSeconds')) schedule();
      if (e.affectsConfiguration(`${CLAUDE_SECTION}.${WRAPPER_KEY}`) || e.affectsConfiguration('claudeSbx')) refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
    vscode.window.onDidChangeWindowState((s) => s.focused && refresh()),
    { dispose: () => timer && clearInterval(timer) }
  );

  schedule();
  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
