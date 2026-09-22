/**
 * The map viewer as a THING THAT IS RUNNING, rather than a command someone
 * typed: where it is, whether it answers, how to reach a particular screen of
 * it, and how to start one without blocking the caller.
 *
 * Every surface that wants to hand the user a clickable URL — session-start
 * hooks, `scale status`, `scale context`, a gate denial — goes through here, so
 * there is exactly one answer to "what is the viewer URL" and one definition of
 * a healthy server.
 *
 * TWO RULES SHAPE THIS FILE.
 *
 *  1. **Nothing here may block a hook.** Every probe is deadline-bounded and
 *     every failure is a value, not an exception that reaches the caller's
 *     fast path. A viewer that is down must cost milliseconds and still produce
 *     a URL (the default one), because a missing link is a worse outcome than a
 *     link that happens to 404 until the server comes up.
 *  2. **A server is only "ours" if its `/api/health` reports THIS repo-id.**
 *     Port 4318 on a laptop with six checkouts is a coin flip otherwise, and
 *     adopting a neighbouring repo's server would show the wrong map and write
 *     the wrong config.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { stateDir, resolveRepoId, ensureStateDir } from './state.js';

/** The port `scale serve` uses when nobody says otherwise. */
export const DEFAULT_PORT = 4318;
/** First/last alternative port tried when the preferred one is taken. */
export const PORT_WALK_START = 4319;
export const PORT_WALK_END = 4328;
/** Loopback, for the same reason `startServer` defaults to it. */
export const DEFAULT_HOST = '127.0.0.1';

/** `~/.scale/<repo-id>/serve.json` — the running viewer's calling card. */
export interface ServeState {
  pid: number;
  port: number;
  host: string;
  url: string;
  startedAt: string;
  /** Minutes of silence after which the server exits; null = never. */
  idleMinutes: number | null;
  version: string;
}

/** The body of `GET /api/health` (unauthenticated, see serve.ts). */
export interface HealthInfo {
  ok: boolean;
  repoId: string;
  pid: number;
  version: string;
  startedAt: string;
  /**
   * The per-user state dir the server reads and writes. Two personas on one
   * machine (`SCALE_STATE_DIR`) share a repo-id but not a state dir, and a
   * viewer answering for the right repo from the WRONG state dir would show
   * one persona the other's coverage and settings. Absent on older bundles,
   * in which case callers fall back to the repo-id match alone.
   */
  stateDir?: string;
}

/** Where the state file lives for the repo at `cwd`. */
export function serveStatePath(cwd: string = process.cwd()): string {
  return path.join(stateDir(cwd), 'serve.json');
}

/**
 * The recorded viewer for this repo, or null. A missing, unreadable, corrupt or
 * structurally wrong file all read the same way — "nothing is running" — because
 * every caller's next move is identical and none of them can fix the file.
 */
export function readServeState(cwd: string = process.cwd()): ServeState | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(serveStatePath(cwd), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.port !== 'number' || !Number.isInteger(s.port) || s.port <= 0) return null;
    return {
      pid: typeof s.pid === 'number' ? s.pid : 0,
      port: s.port,
      host: typeof s.host === 'string' ? s.host : DEFAULT_HOST,
      url: typeof s.url === 'string' && s.url ? s.url : viewerOrigin(DEFAULT_HOST, s.port),
      startedAt: typeof s.startedAt === 'string' ? s.startedAt : '',
      idleMinutes: typeof s.idleMinutes === 'number' ? s.idleMinutes : null,
      version: typeof s.version === 'string' ? s.version : '',
    };
  } catch {
    return null;
  }
}

/** Record the running viewer. Best-effort: a failed write must not kill a server. */
export function writeServeState(state: ServeState, cwd: string = process.cwd()): void {
  try {
    const dir = stateDir(cwd);
    ensureStateDir(dir);
    fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify(state, null, 2) + '\n');
  } catch {
    /* the server still runs; `serve url` just falls back to the default URL */
  }
}

/** Forget the running viewer (clean exit, or a state file we proved stale). */
export function removeServeState(cwd: string = process.cwd()): void {
  try {
    fs.rmSync(serveStatePath(cwd), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * The origin a human should click. Loopback bind addresses print as
 * `localhost`, which is what browsers, `open`, and copy-paste all want.
 */
export function viewerOrigin(host: string, port: number): string {
  const h =
    host === '127.0.0.1' || host === '0.0.0.0' || host === '::' || host === '::1' || !host
      ? 'localhost'
      : host;
  return `http://${h}:${port}`;
}

/** The URL of a viewer nobody has started yet — a real, useful fallback. */
export function defaultViewerUrl(port: number = DEFAULT_PORT): string {
  return viewerOrigin(DEFAULT_HOST, port);
}

/**
 * The same URL with its query string removed — in practice, without `?token=`.
 *
 * EVERY agent-readable surface goes through here: a gate denial, `scale
 * context`, `scale status`, `scale setup status`, the missing-key message, the
 * SessionStart envelope. Those strings land in a transcript that is quoted,
 * shared and shipped to a model provider, and the token is a bearer credential
 * for a server that writes config and accepts API keys.
 *
 * The HUMAN's surfaces — `serve url`, `serve open`, `serve ensure` stdout —
 * keep the token, because that is the URL a phone has to type; without it the
 * API answers 401. On loopback no token exists at all, so for the common case
 * this function changes nothing.
 *
 * Deliberately string surgery rather than `new URL()`: the parser normalises
 * (`http://h:p` → `http://h:p/`) and these URLs are compared against
 * {@link defaultViewerUrl} and printed verbatim.
 */
export function publicViewerUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const hash = url.indexOf('#');
  return hash > q ? url.slice(0, q) + url.slice(hash) : url.slice(0, q);
}

/**
 * The viewer URL to put in front of an AGENT: the recorded one, token removed,
 * falling back to the default. Synchronous on purpose — its two callers (the
 * edit gate, in front of every edit, and a missing-key error) cannot afford a
 * probe, and a link that is occasionally stale beats no link.
 */
export function agentViewerBase(cwd: string = process.cwd()): string {
  return publicViewerUrl(readServeState(cwd)?.url ?? defaultViewerUrl());
}

/** A screen of the viewer: a component's panel, or a Settings tab. */
export interface ViewerTarget {
  /** Component id → `#/c/<id>`. */
  component?: string;
  /**
   * Section anchor within that component's doc → `#/c/<id>/<section>`.
   *
   * Ignored without a `component`, because a section is a place INSIDE a doc
   * and there is no such thing as one on its own. The slug vocabulary is
   * core's {@link import('@scale/core').headingSlugs} — English, derived from
   * the doc's own headings, plus the reserved `concepts` / `decisions`.
   */
  section?: string;
  /** Settings tab → `#/settings/<tab>`; empty string → `#/settings`. */
  settings?: string;
}

/**
 * Compose a deep link onto a base URL, preserving whatever the base carries —
 * notably the `?token=` a non-loopback server puts in its URL, which must stay
 * in the query and never migrate into the hash.
 *
 * A base we cannot parse is returned unchanged rather than dropped: a slightly
 * wrong link still beats no link.
 */
export function viewerUrl(base: string, target: ViewerTarget = {}): string {
  const hash =
    target.component !== undefined && target.component !== ''
      ? `#/c/${encodeURIComponent(target.component)}${
          target.section ? `/${encodeURIComponent(target.section)}` : ''
        }`
      : target.settings !== undefined
        ? target.settings === ''
          ? '#/settings'
          : `#/settings/${encodeURIComponent(target.settings)}`
        : '';
  if (hash === '') return base;
  try {
    const u = new URL(base);
    u.hash = hash;
    return u.toString();
  } catch {
    return base;
  }
}

/**
 * Ask a server whether it is a SCALE viewer, within `timeoutMs`. Null means
 * "not one of ours" for every reason there is — refused, timed out, wrong body,
 * some other app on the port.
 */
export async function probeHealth(base: string, timeoutMs = 300): Promise<HealthInfo | null> {
  try {
    const res = await fetch(new URL('/api/health', base), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<HealthInfo>;
    if (!body || body.ok !== true || typeof body.repoId !== 'string') return null;
    return {
      ok: true,
      repoId: body.repoId,
      pid: typeof body.pid === 'number' ? body.pid : 0,
      version: typeof body.version === 'string' ? body.version : '',
      startedAt: typeof body.startedAt === 'string' ? body.startedAt : '',
      ...(typeof body.stateDir === 'string' ? { stateDir: body.stateDir } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Does this server serve THIS persona of THIS repo? Repo-id alone was the test
 * until `SCALE_STATE_DIR` made two state dirs per repo possible; a health
 * body that names its state dir must name ours. One without (older bundle) is
 * matched on repo-id, as before.
 */
export function servesThisState(health: HealthInfo, cwd: string): boolean {
  if (health.repoId !== resolveRepoId(cwd)) return false;
  return health.stateDir === undefined || path.resolve(health.stateDir) === stateDir(cwd);
}

/** Is anything listening? Distinguishes "free port" from "someone else's port". */
export function tcpOpen(host: string, port: number, timeoutMs = 150): Promise<boolean> {
  const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return new Promise((resolve) => {
    const socket = net.connect({ host: connectHost, port });
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Where the viewer is, without starting anything. */
export interface ViewerLocation {
  url: string;
  running: boolean;
  port: number;
}

/**
 * The URL to show the user right now: the recorded server when it answers for
 * THIS repo, otherwise a URL that at least points at the RECORDED port with
 * `running: false`. Bounded by `timeoutMs` (one probe), so it is safe on a hook
 * path.
 *
 * A recorded-but-silent server still fixes the port: the viewer usually comes
 * back on the port it was last on (`serve ensure` prefers it), so
 * `http://localhost:4321` is a link that will work in a moment, while the
 * default 4318 is a link that will never work. Only with nothing recorded at
 * all is the default the best guess there is.
 */
export async function resolveViewer(
  cwd: string = process.cwd(),
  target: ViewerTarget = {},
  timeoutMs = 300,
): Promise<ViewerLocation> {
  const state = readServeState(cwd);
  if (state) {
    const health = await probeHealth(viewerOrigin(state.host, state.port), timeoutMs);
    if (health && servesThisState(health, cwd)) {
      return { url: viewerUrl(state.url, target), running: true, port: state.port };
    }
    return {
      url: viewerUrl(viewerOrigin(state.host, state.port), target),
      running: false,
      port: state.port,
    };
  }
  return { url: viewerUrl(defaultViewerUrl(), target), running: false, port: DEFAULT_PORT };
}

// ---------------------------------------------------------------------------
// ensure / stop
// ---------------------------------------------------------------------------

export interface EnsureOptions {
  cwd?: string;
  /** Preferred port; 4319-4328 are tried after it. */
  port?: number;
  host?: string;
  /** Idle timeout handed to a server we start. */
  idleMinutes?: number;
  /**
   * Bearer token handed to a server we start. Off loopback the server
   * generates one when none is given, and either way the URL it records is the
   * only one that works — see {@link serverWrittenState}.
   */
  token?: string;
  /** Test seam: spawn nothing, just report what the scan found. */
  spawn?: boolean;
}

export interface EnsureResult {
  url: string;
  port: number;
  pid: number | null;
  /** We launched this process. */
  started: boolean;
  /** An already-running server for this repo was adopted. */
  reused: boolean;
}

/** Ports to try, preferred first, without repeats. */
export function portCandidates(preferred: number): number[] {
  const out = [preferred];
  for (let p = PORT_WALK_START; p <= PORT_WALK_END; p++) if (p !== preferred) out.push(p);
  return out;
}

/** How long the port scan may take before we give up and report failure. */
const SCAN_BUDGET_MS = 1000;
/** How long we wait for a server we just spawned to answer /api/health. */
const BOOT_BUDGET_MS = 2200;

/**
 * Re-launch this same CLI as a detached `scale serve`.
 *
 * `process.execPath` + `process.argv[1]` rather than a `scale` on PATH: the
 * plugin ships its own bundle and there may be no `scale` anywhere. `execArgv`
 * comes along so a dev run under `tsx` (which registers a loader there) can
 * still spawn a child that can read TypeScript.
 */
function spawnDaemon(
  cwd: string,
  host: string,
  port: number,
  idleMinutes: number | undefined,
  token: string | undefined,
): number | null {
  const script = process.argv[1];
  if (!script) return null;
  const args = [
    ...process.execArgv,
    script,
    'serve',
    '--port',
    String(port),
    '--host',
    host,
  ];
  if (idleMinutes && idleMinutes > 0) args.push('--idle-minutes', String(idleMinutes));
  // `--token` on the child's argv is exactly what `scale serve --token` already
  // is: visible to `ps` for whoever owns this box. It is not a new exposure,
  // and the alternative (an env var) is no less visible.
  if (token) args.push('--token', token);
  try {
    const child = spawn(process.execPath, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.on('error', () => {
      /* ENOENT etc. — the health poll below is what decides success */
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/** Poll /api/health until it answers for `repoId`, or the deadline passes. */
async function pollHealth(base: string, repoId: string, budgetMs: number): Promise<HealthInfo | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const health = await probeHealth(base, 250);
    if (health && health.repoId === repoId) return health;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** Same scheme, host and port? Used to decide whether a recorded URL is still about THIS server. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The serve.json the SERVER itself wrote for the viewer at `host:port`, if that
 * is what is on disk.
 *
 * The server is the only party that knows the token — off loopback it invents
 * one when none was given — so its `url` is the authoritative one. `ensure`
 * must never overwrite it with a bare origin: that would leave the state file,
 * and therefore every later `serve url`, pointing at a URL the API answers 401
 * to, with the working one gone for good.
 */
function serverWrittenState(cwd: string, host: string, port: number): ServeState | null {
  const s = readServeState(cwd);
  if (!s || s.port !== port) return null;
  return sameOrigin(s.url, viewerOrigin(host, port)) ? s : null;
}

function stateFor(
  port: number,
  host: string,
  pid: number,
  idleMinutes: number | undefined,
  version: string,
  startedAt: string,
  /** The server's own URL when we have it (it carries `?token=`); else the bare origin. */
  url?: string,
): ServeState {
  return {
    pid,
    port,
    host,
    url: url ?? viewerOrigin(host, port),
    startedAt,
    idleMinutes: idleMinutes && idleMinutes > 0 ? idleMinutes : null,
    version,
  };
}

/**
 * Make sure a viewer is running for this repo and return how to reach it.
 *
 * Reuse (serve.json answers) → adopt (a port answers for this repo) → spawn
 * (first free port). Every branch is deadline-bounded; the whole call is under
 * ~3 s even when every port is held by someone else's server.
 *
 * Throws with a one-line message the caller can print. It never leaves a
 * half-truth on disk: serve.json is written only after a health check passed.
 */
export async function ensureServer(opts: EnsureOptions = {}): Promise<EnsureResult> {
  const cwd = opts.cwd ?? process.cwd();
  const host = opts.host ?? DEFAULT_HOST;
  const repoId = resolveRepoId(cwd);
  const preferred = opts.port ?? DEFAULT_PORT;

  // 1. The recorded server, if it still answers for this repo.
  const recorded = readServeState(cwd);
  if (recorded) {
    const health = await probeHealth(viewerOrigin(recorded.host, recorded.port), 400);
    if (health && servesThisState(health, cwd)) {
      return {
        url: recorded.url,
        port: recorded.port,
        pid: health.pid || recorded.pid,
        started: false,
        reused: true,
      };
    }
    // Proved stale — stop advertising it.
    removeServeState(cwd);
  }

  // 2. Walk the ports: adopt one of ours, skip anyone else's, spawn on the
  //    first free one.
  const scanDeadline = Date.now() + SCAN_BUDGET_MS;
  const candidates = portCandidates(preferred);
  let firstFree: number | null = null;
  for (const port of candidates) {
    if (Date.now() > scanDeadline && firstFree === null) break;
    const base = viewerOrigin(host, port);
    if (await tcpOpen(host, port, 150)) {
      const health = await probeHealth(base, 300);
      if (health && servesThisState(health, cwd)) {
        // A server we did not start (or one whose state file we just pruned as
        // stale): keep whatever working URL we can still see — its own file
        // first, then the entry we read on the way in — because only those
        // carry the token.
        const known =
          serverWrittenState(cwd, host, port) ??
          (recorded && recorded.port === port && sameOrigin(recorded.url, base)
            ? recorded
            : null);
        const url = known?.url ?? base;
        writeServeState(
          stateFor(port, host, health.pid, opts.idleMinutes, health.version, health.startedAt, url),
          cwd,
        );
        return { url, port, pid: health.pid, started: false, reused: true };
      }
      continue; // someone else holds it
    }
    firstFree = port;
    break;
  }

  if (firstFree === null) {
    throw new Error(
      `no free port for the map viewer (tried ${preferred} and ${PORT_WALK_START}-${PORT_WALK_END})`,
    );
  }
  if (opts.spawn === false) {
    return { url: viewerOrigin(host, firstFree), port: firstFree, pid: null, started: false, reused: false };
  }

  // 3. Spawn, then believe only /api/health.
  const base = viewerOrigin(host, firstFree);
  spawnDaemon(cwd, host, firstFree, opts.idleMinutes, opts.token);
  const health = await pollHealth(base, repoId, BOOT_BUDGET_MS);
  if (!health) {
    throw new Error(`the map viewer did not come up on ${host}:${firstFree} — try \`scale serve\` to see why`);
  }
  // The child wrote serve.json as it started listening, and that entry is the
  // one with the token in it. Leave it alone; write our own only if it is
  // somehow not there.
  const written = serverWrittenState(cwd, host, firstFree);
  if (written) {
    return {
      url: written.url,
      port: firstFree,
      pid: health.pid || written.pid,
      started: true,
      reused: false,
    };
  }
  writeServeState(
    stateFor(firstFree, host, health.pid, opts.idleMinutes, health.version, health.startedAt),
    cwd,
  );
  return { url: base, port: firstFree, pid: health.pid, started: true, reused: false };
}

export interface StopResult {
  stopped: boolean;
  pid: number | null;
  port: number | null;
}

/**
 * Stop the viewer we started. The pid is taken from the LIVE health response
 * rather than from serve.json wherever possible: a stale file's pid may have
 * been recycled by an unrelated process, and signalling that would be worse
 * than leaving a dead entry behind.
 */
export async function stopServer(cwd: string = process.cwd()): Promise<StopResult> {
  const state = readServeState(cwd);
  if (!state) return { stopped: false, pid: null, port: null };
  const health = await probeHealth(viewerOrigin(state.host, state.port), 400);
  let stopped = false;
  const pid = health && health.repoId === resolveRepoId(cwd) ? health.pid : 0;
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGTERM');
      stopped = true;
    } catch {
      /* already gone */
    }
  }
  removeServeState(cwd);
  return { stopped, pid: pid || state.pid || null, port: state.port };
}
