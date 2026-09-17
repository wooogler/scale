#!/usr/bin/env node
/**
 * Install, uninstall, reload, or inspect the SCALE plugin in Claude Code.
 *
 *   node scripts/plugin.mjs install   [--path]        register marketplace + install plugin
 *   node scripts/plugin.mjs uninstall [--purge]       reverse of install; --purge also clears caches
 *                                                     and moves ~/.scale aside (never deletes it)
 *   node scripts/plugin.mjs reload                    re-copy the repo into the plugin cache without
 *                                                     a version bump (dev iteration)
 *   node scripts/plugin.mjs status                    where SCALE is registered, what version runs
 *   any command: --dry-run                            print what would happen, change nothing
 *
 * Why this exists: an install touches six places — settings.json, installed_plugins.json,
 * known_marketplaces.json, the version-keyed plugin cache, the plugin data dir, and (for
 * terminal use) ~/.zshrc — and `~/.scale` holds both learning data and an API key. None of
 * them knows about the others, so a hand uninstall is easy to leave half done. This script is
 * the one place that knows the whole surface. It shells out to `claude plugin …` for anything
 * Claude Code owns and only touches files the CLI does not manage.
 *
 * Claude Code only, for now. Codex has its own registry (~/.codex/config.toml); `status`
 * reports a stray SCALE entry there but nothing here edits it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT, 'packages', 'plugin');
const BIN_DIR = path.join(PLUGIN_DIR, 'bin');
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const SCALE_HOME = path.join(HOME, '.scale');
const ZSHRC = path.join(HOME, '.zshrc');
const MARKER_BEGIN = '# >>> scale plugin >>>';
const MARKER_END = '# <<< scale plugin <<<';
const PATH_LINE = `export PATH="${BIN_DIR}:$PATH"`;

// ---------------------------------------------------------------------------
// output + side effects (every mutation goes through one of these so --dry-run is total)

const say = (mark, msg) => console.log(`${mark} ${msg}`);
const ok = (m) => say('✔', m);
const skip = (m) => say('–', m);
const warn = (m) => say('!', m);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    warn(`${p} is not valid JSON (${e.message}) — treating it as empty`);
    return null;
  }
}

// Names come from the manifest so they cannot drift from what Claude Code sees.
const marketplaceManifest = readJson(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
if (!marketplaceManifest?.plugins?.[0]?.name) fail(`${ROOT}/.claude-plugin/marketplace.json missing or malformed — run from the SCALE repo`);
const MARKETPLACE = marketplaceManifest.name;
const PLUGIN = marketplaceManifest.plugins[0].name;
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;

const P = {
  settings: path.join(CLAUDE_DIR, 'settings.json'),
  installed: path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'),
  knownMarketplaces: path.join(CLAUDE_DIR, 'plugins', 'known_marketplaces.json'),
  cache: path.join(CLAUDE_DIR, 'plugins', 'cache', MARKETPLACE),
  // `<plugin>-inline` is what an older `--plugin-dir` style install left behind.
  dataDirs: [`${PLUGIN}-${MARKETPLACE}`, `${PLUGIN}-inline`].map((id) => path.join(CLAUDE_DIR, 'plugins', 'data', id)),
  codexConfig: path.join(HOME, '.codex', 'config.toml'),
};

// ---------------------------------------------------------------------------
// args

const COMMANDS = ['install', 'uninstall', 'reload', 'status'];
const FLAGS = ['--path', '--purge', '--dry-run', '-h', '--help'];
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('-'));
const flags = args.filter((a) => a.startsWith('-'));
const command = positional[0];
const flag = (name) => flags.includes(name);
const DRY = flag('--dry-run');

if (!command || flag('-h') || flag('--help')) {
  console.log(`usage: node scripts/plugin.mjs <install [--path] | uninstall [--purge] | reload | status> [--dry-run]

  install    register ${ROOT} as marketplace "${MARKETPLACE}" and install ${PLUGIN_ID}
             --path   also put packages/plugin/bin on PATH in ~/.zshrc (for \`scale\` in a terminal;
                      sessions do not need it — Claude Code adds the plugin's bin/ itself)
  uninstall  uninstall the plugin, remove the marketplace, drop the ~/.zshrc block
             --purge  also delete the plugin cache + data dirs and move ~/.scale to a
                      timestamped backup (learning data and ~/.scale/keys.json are never deleted)
  reload     force Claude Code to re-copy this repo into its plugin cache without a version bump
             (zero-install alternative: \`claude --plugin-dir ${PLUGIN_DIR}\`)
  status     show every place SCALE is registered and the version actually installed
  --dry-run  print the commands and file changes, perform none of them

Restart Claude Code (quit fully) after install / uninstall / reload — hooks load at session start.`);
  process.exit(command ? 0 : 1);
}
// A typo'd flag must not silently run for real (`--dryrun`), so reject anything unknown.
const unknown = [...flags.filter((f) => !FLAGS.includes(f)), ...positional.slice(1)];
if (unknown.length) fail(`unknown argument(s): ${unknown.join(' ')} — try --help`);
if (!COMMANDS.includes(command)) fail(`unknown command "${command}" — try --help`);

function claude(...cliArgs) {
  console.log(`$ claude ${cliArgs.join(' ')}`);
  if (DRY) return true;
  const r = spawnSync('claude', cliArgs, { stdio: 'inherit' });
  if (r.error?.code === 'ENOENT') fail('`claude` is not on PATH — install Claude Code first.');
  return r.status === 0;
}

function rmrf(p) {
  if (!fs.existsSync(p)) return false;
  console.log(`$ rm -rf ${p}`);
  if (!DRY) fs.rmSync(p, { recursive: true, force: true });
  return true;
}

function mv(from, to) {
  console.log(`$ mv ${from} ${to}`);
  if (!DRY) fs.renameSync(from, to);
}

function writeText(p, text) {
  console.log(`  (write ${p})`);
  if (!DRY) fs.writeFileSync(p, text);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

// ---------------------------------------------------------------------------
// state

function dirSizeKb(p) {
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) bytes += fs.statSync(f).size;
    }
  };
  walk(p);
  return Math.round(bytes / 1024);
}

const samePath = (a, b) => {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
};

/**
 * The managed ~/.zshrc blocks: every BEGIN…END pair, each paired with the first END after it.
 * A block is `valid` only when its interior is exactly the one line this script writes — a
 * stray marker must never pair with a real one and swallow the user's lines in between.
 */
function zshrcState() {
  if (!fs.existsSync(ZSHRC)) return { lines: null, blocks: [], legacy: [] };
  const lines = fs.readFileSync(ZSHRC, 'utf8').split('\n');
  const blocks = [];
  for (let a = lines.indexOf(MARKER_BEGIN); a !== -1; a = lines.indexOf(MARKER_BEGIN, a + 1)) {
    const b = lines.indexOf(MARKER_END, a + 1);
    if (b === -1) { blocks.push({ a, b: -1, valid: false }); break; }
    blocks.push({ a, b, valid: b === a + 2 && lines[a + 1] === PATH_LINE });
  }
  const inBlock = (i) => blocks.some(({ a, b }) => b !== -1 && i > a && i < b);
  // Lines that put the plugin's bin/ on PATH outside a managed block: hand-written, so
  // reported rather than edited.
  const legacy = lines
    .map((l, i) => [i + 1, l])
    .filter(([n, l]) => l.includes(BIN_DIR) && !inBlock(n - 1));
  return { lines, blocks, legacy };
}

function inspect() {
  const settings = readJson(P.settings) ?? {};
  const installed = readJson(P.installed)?.plugins?.[PLUGIN_ID] ?? [];
  const known = readJson(P.knownMarketplaces)?.[MARKETPLACE] ?? null;
  const cacheVersions = fs.existsSync(path.join(P.cache, PLUGIN))
    ? fs.readdirSync(path.join(P.cache, PLUGIN)).filter((v) => !v.startsWith('.'))
    : [];
  const markers = cacheVersions.flatMap((v) =>
    ['.in_use', '.orphaned_at']
      .filter((m) => fs.existsSync(path.join(P.cache, PLUGIN, v, m)))
      .map((m) => `${v}${m}`),
  );
  const repoVersion = readJson(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'))?.version ?? '?';
  const codex = fs.existsSync(P.codexConfig) && /scale/.test(fs.readFileSync(P.codexConfig, 'utf8'));
  const scaleOnPath = spawnSync('sh', ['-c', 'command -v scale'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  return {
    // known_marketplaces.json is what the plugin registry reads; settings.json is the
    // user-facing declaration. Track both — they drift apart in half-removed installs.
    // A directory source has `path`; a GitHub/git source has `repo`/`url`. Only the
    // directory form is this script's business — the remote form is updated with
    // `claude plugin marketplace update` + `claude plugin update`, not by reloading a clone.
    knownSource: known?.source?.path ?? known?.source?.repo ?? known?.source?.url ?? null,
    knownRemote: Boolean(known) && known.source?.source !== 'directory',
    settingsSource: settings.extraKnownMarketplaces?.[MARKETPLACE]?.source?.path ?? null,
    installed,
    enabled: settings.enabledPlugins?.[PLUGIN_ID],
    cacheVersions,
    markers,
    dataDirs: P.dataDirs.filter((d) => fs.existsSync(d)),
    scaleHome: fs.existsSync(SCALE_HOME)
      ? { kb: dirSizeKb(SCALE_HOME), keys: fs.existsSync(path.join(SCALE_HOME, 'keys.json')) }
      : null,
    zshrc: zshrcState(),
    repoVersion,
    codex,
    scaleOnPath,
  };
}

function printStatus(s = inspect()) {
  console.log(`SCALE plugin — ${PLUGIN_ID}   (repo ${ROOT}, version ${s.repoVersion})`);
  console.log('');

  if (s.knownRemote) {
    ok(`marketplace "${MARKETPLACE}" → ${s.knownSource} (remote — update with \`claude plugin marketplace update ${MARKETPLACE}\` + \`claude plugin update ${PLUGIN_ID}\`)`);
  } else if (s.knownSource) {
    const here = samePath(s.knownSource, ROOT);
    (here ? ok : warn)(`marketplace "${MARKETPLACE}" → ${s.knownSource}${here ? '' : '   (NOT this repo)'}`);
  } else if (s.settingsSource) {
    warn(`marketplace "${MARKETPLACE}" is declared in settings.json but unknown to the plugin registry (half-removed?) — \`claude plugin marketplace remove ${MARKETPLACE}\` clears it`);
  } else skip(`marketplace "${MARKETPLACE}" not registered`);

  if (s.installed.length) {
    for (const i of s.installed) {
      const stale = i.version !== s.repoVersion;
      (stale ? warn : ok)(`installed v${i.version} (scope ${i.scope})${stale ? `   ← repo is ${s.repoVersion}: stale cache, run \`reload\`` : ''}`);
    }
    if (s.enabled === false) warn('plugin is installed but DISABLED — `install` re-enables it');
  } else {
    skip('plugin not installed');
    if (s.enabled !== undefined) warn(`enabledPlugins still has an entry for ${PLUGIN_ID} but nothing is installed (half-removed?)`);
  }

  if (s.cacheVersions.length) {
    const m = s.markers.length ? `   markers: ${s.markers.join(', ')}` : '';
    (s.installed.length ? ok : warn)(`cache ${P.cache} → ${s.cacheVersions.join(', ')}${m}${s.installed.length ? '' : '   (orphaned; --purge removes it)'}`);
  } else skip('no plugin cache');
  if (s.dataDirs.length) skip(`plugin data dirs present: ${s.dataDirs.join(', ')}`);

  if (s.scaleHome) ok(`~/.scale present (${s.scaleHome.kb} KB${s.scaleHome.keys ? ', has keys.json' : ''})   learning data — not touched by uninstall`);
  else skip('~/.scale absent');

  const valid = s.zshrc.blocks.filter((b) => b.valid).length;
  const broken = s.zshrc.blocks.length - valid;
  if (valid) ok(`~/.zshrc has the managed PATH block${valid > 1 ? ` (${valid} copies — uninstall removes all)` : ''}`);
  if (broken) warn(`~/.zshrc has ${broken} malformed "${MARKER_BEGIN}" block(s) — fix by hand; the script will not touch them`);
  for (const [n, l] of s.zshrc.legacy) warn(`~/.zshrc:${n} unmanaged PATH line — remove by hand: ${l.trim()}`);
  if (!s.zshrc.blocks.length && !s.zshrc.legacy.length) skip('~/.zshrc: no PATH entry (only needed for `scale` in a terminal)');
  if (s.scaleOnPath) skip(`\`scale\` resolves to ${s.scaleOnPath} in this shell`);

  if (s.codex) warn('~/.codex/config.toml mentions scale — a Codex install this script does not manage');
}

// ---------------------------------------------------------------------------
// ~/.zshrc block (only ever the marker-delimited block; a hand-written line is reported, not edited)

function addZshrcBlock() {
  if (zshrcState().blocks.some((b) => b.valid)) return skip('~/.zshrc block already present');
  const block = `\n${MARKER_BEGIN}\n${PATH_LINE}\n${MARKER_END}\n`;
  console.log(`$ cat >> ${ZSHRC}   # ${MARKER_BEGIN} … ${MARKER_END}`);
  if (!DRY) fs.appendFileSync(ZSHRC, block);
  ok('~/.zshrc: PATH block added (open a new terminal to pick it up)');
}

function removeZshrcBlock() {
  const { lines, blocks, legacy } = zshrcState();
  for (const [n, l] of legacy) warn(`~/.zshrc:${n} has a hand-written PATH line this script did not add — remove it yourself: ${l.trim()}`);
  if (!blocks.length) return skip('~/.zshrc: no managed block');
  const broken = blocks.filter((b) => !b.valid);
  if (broken.length) {
    return warn(`~/.zshrc: "${MARKER_BEGIN}" block at line ${broken[0].a + 1} does not look like one this script wrote — leaving ~/.zshrc alone; remove it by hand`);
  }
  const drop = new Set(blocks.flatMap(({ a, b }) => [a, a + 1, b]));
  const kept = lines.filter((_, i) => !drop.has(i));
  // Collapse the blank line each block was appended with, where it left two in a row or a
  // trailing one; end with exactly one newline.
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  const backup = `${ZSHRC}.scale-plugin.bak`;
  console.log(`$ cp ${ZSHRC} ${backup}`);
  if (!DRY) fs.copyFileSync(ZSHRC, backup);
  console.log(`$ sed -i '' '/${MARKER_BEGIN}/,/${MARKER_END}/d' ${ZSHRC}`);
  writeText(ZSHRC, text);
  ok(`~/.zshrc: PATH block removed (previous copy at ${backup})`);
}

// ---------------------------------------------------------------------------
// commands

function ensureMarketplace(s) {
  if (s.knownRemote) {
    fail(`marketplace "${MARKETPLACE}" is registered from ${s.knownSource}, not a local clone.\n  That install is updated with \`claude plugin marketplace update ${MARKETPLACE}\` + \`claude plugin update ${PLUGIN_ID}\`.\n  To switch to this clone: \`node scripts/plugin.mjs uninstall\`, then \`install\`.`);
  }
  if (s.knownSource) {
    if (!samePath(s.knownSource, ROOT)) {
      fail(`marketplace "${MARKETPLACE}" is registered from ${s.knownSource}, not this repo.\n  Run \`node scripts/plugin.mjs uninstall\` from there (or \`claude plugin marketplace remove ${MARKETPLACE}\`) first.`);
    }
    return skip(`marketplace "${MARKETPLACE}" already registered`);
  }
  if (s.settingsSource) warn(`marketplace "${MARKETPLACE}" was declared in settings.json but not in the registry — re-adding`);
  if (!claude('plugin', 'marketplace', 'add', ROOT)) {
    fail(`marketplace add failed${s.settingsSource ? ` — try \`claude plugin marketplace remove ${MARKETPLACE}\` first, then rerun` : ''}`);
  }
  ok(`marketplace "${MARKETPLACE}" → ${ROOT}`);
}

function installPlugin(s) {
  if (s.installed.length) {
    skip(`${PLUGIN_ID} already installed (v${s.installed[0].version}) — \`reload\` re-copies the repo`);
    if (s.enabled === false) {
      if (!claude('plugin', 'enable', PLUGIN_ID)) fail('plugin enable failed');
      ok(`${PLUGIN_ID} enabled`);
    }
    return;
  }
  if (!claude('plugin', 'install', PLUGIN_ID)) fail('plugin install failed');
  ok(`${PLUGIN_ID} installed (repo version ${s.repoVersion})`);
}

/** Returns true when nothing is left to uninstall or the CLI succeeded. */
function uninstallPlugin(s) {
  if (!s.installed.length && s.enabled === undefined) { skip(`${PLUGIN_ID} not installed`); return true; }
  const done = claude('plugin', 'uninstall', PLUGIN_ID);
  if (done) ok(`${PLUGIN_ID} uninstalled`);
  else warn('plugin uninstall reported an error — check `claude plugin list`');
  return done;
}

function removeMarketplace(s) {
  if (!s.knownSource && !s.settingsSource) return skip(`marketplace "${MARKETPLACE}" not registered`);
  if (!claude('plugin', 'marketplace', 'remove', MARKETPLACE)) warn('marketplace remove reported an error — check `claude plugin marketplace list`');
  else ok(`marketplace "${MARKETPLACE}" removed`);
}

function dropCache(s) {
  if (s.markers.some((m) => m.endsWith('.in_use'))) {
    warn('a running Claude Code session still holds the plugin cache; its SCALE hooks will no-op (they fail open) until it restarts');
  }
  if (rmrf(P.cache)) ok('plugin cache removed');
}

function purge(s) {
  dropCache(s);
  for (const d of P.dataDirs) if (rmrf(d)) ok(`plugin data dir removed: ${d}`);
  if (fs.existsSync(SCALE_HOME)) {
    const backup = `${SCALE_HOME}.bak-${stamp()}`;
    mv(SCALE_HOME, backup);
    ok(`~/.scale moved to ${backup}   (learning data${s.scaleHome?.keys ? ' and keys.json' : ''} kept there — delete it yourself when sure)`);
    if (s.scaleHome?.keys) console.log(`  to restore just the API key later:  mkdir -p ${SCALE_HOME} && cp ${backup}/keys.json ${SCALE_HOME}/`);
  }
}

const restartNote = () => console.log('\n→ Quit Claude Code fully and reopen it: hooks are read at session start, so running sessions keep the old state.');
const verifyNote = (v) => console.log(`  then verify with:  scale --version   → should print ${v}`);

const commands = {
  status() {
    printStatus();
  },

  install() {
    const s = inspect();
    ensureMarketplace(s);
    installPlugin(s);
    if (flag('--path')) addZshrcBlock();
    restartNote();
    verifyNote(s.repoVersion);
  },

  uninstall() {
    const s = inspect();
    uninstallPlugin(s);
    removeMarketplace(s);
    removeZshrcBlock();
    if (flag('--purge')) purge(s);
    else if (s.cacheVersions.length || s.scaleHome) console.log('  (caches and ~/.scale left in place; add --purge to clear them)');
    restartNote();
  },

  // Claude Code caches a plugin under a version-keyed path, so `plugin update` is a no-op
  // while the version is unchanged (packages/plugin/README.md, "Releasing a change").
  // Dropping the cache and reinstalling is the bump-free way to get the repo's current
  // state into a session. For a pure dev loop, `claude --plugin-dir` skips all of this.
  reload() {
    const s = inspect();
    if (!s.installed.length) fail(`${PLUGIN_ID} is not installed — \`reload\` refreshes an existing install; run \`install\` instead`);
    // Anything that can refuse must refuse before the first mutation, or reload leaves the
    // plugin uninstalled with its cache gone.
    ensureMarketplace(s);
    if (!uninstallPlugin(s)) fail('stopping before touching the cache — the registry still lists the plugin');
    dropCache(s);
    if (!claude('plugin', 'marketplace', 'update', MARKETPLACE)) warn('marketplace update reported an error — the install below may see stale marketplace metadata');
    installPlugin({ ...s, installed: [] });
    restartNote();
    verifyNote(s.repoVersion);
  },
};

if (DRY) console.log('[dry-run] nothing below is executed\n');
commands[command]();
