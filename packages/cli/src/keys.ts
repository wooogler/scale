/**
 * API-key store for the INTERVENTION providers (quest generation + the web
 * socratic proxy).
 *
 * SECURITY POSTURE — read before changing anything here:
 *
 *  - Keys live in `~/.scale/keys.json` at mode 0600 (owner read/write only),
 *    the same shape of secret-at-rest as `~/.aws/credentials`. They are USER
 *    global, not per-repo: a key is an account credential, not project state,
 *    and `~/.scale/<repo-id>/` is the repo's state dir.
 *  - **Environment variables win.** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
 *    always take precedence over the stored value, so CI and shell-managed
 *    setups are never silently overridden by something a browser wrote.
 *  - A key is NEVER returned over HTTP and never logged. The only thing that
 *    leaves this module for display is {@link keyStatus}: a boolean plus a
 *    masked tail (`sk-…AB12`). `scale serve` binds to loopback for the same
 *    reason — the key-entry endpoint must not be reachable off-box.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LlmProvider } from '@scale/core';

import { scaleHome } from './state.js';

/** `<scaleHome()>/keys.json` — user-global, mode 0600 (`~/.scale/keys.json` unless `SCALE_STATE_DIR` relocates the root). */
export function keysPath(): string {
  return path.join(scaleHome(), 'keys.json');
}

/** Env var consulted first for each provider. */
const ENV_VAR: Record<LlmProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

type KeyFile = Partial<Record<LlmProvider, string>>;

function readKeyFile(): KeyFile {
  try {
    const raw = fs.readFileSync(keysPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: KeyFile = {};
    for (const p of ['anthropic', 'openai'] as LlmProvider[]) {
      const v = (parsed as Record<string, unknown>)[p];
      if (typeof v === 'string' && v.trim()) out[p] = v.trim();
    }
    return out;
  } catch {
    return {}; // missing/unreadable/corrupt → behave as "no stored keys"
  }
}

function writeKeyFile(next: KeyFile): void {
  const file = keysPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write then chmod: `mode` on writeFileSync only applies at creation, so an
  // existing file keeps its old (possibly looser) permissions without this.
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort (e.g. exotic filesystems) */
  }
}

/**
 * The key to use for `provider`: env var first, then the stored value.
 * Returns null when neither is set — callers degrade (deterministic fallback
 * for quest generation, a clear error for the socratic proxy).
 */
export function resolveKey(provider: LlmProvider): string | null {
  const env = process.env[ENV_VAR[provider]];
  if (env && env.trim()) return env.trim();
  return readKeyFile()[provider] ?? null;
}

/** Persist (or, with an empty string, clear) a provider's key. */
export function setKey(provider: LlmProvider, key: string): void {
  const next = readKeyFile();
  const trimmed = key.trim();
  if (trimmed) next[provider] = trimmed;
  else delete next[provider];
  writeKeyFile(next);
}

/**
 * Store a key that arrived on STDIN.
 *
 * Split out from {@link setKey} so the CLI path has somewhere to be tested
 * without a subprocess, and so the trimming rule ("a trailing newline from
 * `echo` is not part of the key") lives in one place. The caller must never
 * accept key material as an argv value: argv is visible in `ps`, in shell
 * history, and in any hook transcript. Returns nothing — there is deliberately
 * no echo of what was stored.
 */
export function setKeyFromInput(provider: LlmProvider, raw: string): void {
  setKey(provider, raw.trim());
}

export interface ProviderKeyStatus {
  /** True when a key is available from either source. */
  configured: boolean;
  /** 'env' | 'file' | null — where the effective key came from. */
  source: 'env' | 'file' | null;
  /** Masked tail for display, e.g. `sk-…9f2A`. Never the full key. */
  masked: string | null;
}

/** Mask everything but a short tail; short/odd values collapse to a dot run. */
function mask(key: string): string {
  const tail = key.slice(-4);
  const head = key.startsWith('sk-') ? 'sk-' : '';
  return key.length <= 8 ? '••••' : `${head}…${tail}`;
}

/** Display-safe status for both providers — the ONLY thing the API may return. */
export function keyStatus(): Record<LlmProvider, ProviderKeyStatus> {
  const file = readKeyFile();
  const out = {} as Record<LlmProvider, ProviderKeyStatus>;
  for (const p of ['anthropic', 'openai'] as LlmProvider[]) {
    const env = process.env[ENV_VAR[p]]?.trim();
    const stored = file[p];
    const effective = env || stored || null;
    out[p] = {
      configured: Boolean(effective),
      source: env ? 'env' : stored ? 'file' : null,
      masked: effective ? mask(effective) : null,
    };
  }
  return out;
}
