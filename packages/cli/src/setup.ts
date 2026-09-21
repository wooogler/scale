/**
 * "Is SCALE usable in this repo, for this person, right now?" — one answer,
 * assembled from the five places that each know a piece of it.
 *
 * This exists so the chat settings surface never has to shell out five times
 * and stitch the results together. Everything is a file read plus one bounded
 * health probe: no LLM, no network beyond loopback, no writes.
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadScaleDir, type LlmProvider } from '@scale/core';

import {
  stateDir,
  resolveRepoId,
  configExists,
  readConfigSafe,
  loadEffectiveConfig,
} from './state.js';
import { keyStatus } from './keys.js';
import { resolveViewer, publicViewerUrl } from './serve-state.js';

export interface SetupStatus {
  repoId: string;
  stateDir: string;
  /** A personal config.json exists — `scale init` has been run here. */
  initialized: boolean;
  user: string | null;
  memory: { present: boolean; components: number };
  provider: LlmProvider;
  /** A key is available for the EFFECTIVE provider (env or stored). */
  keyPresent: boolean;
  gate: { assessment: string; modality: string; enforcement: string };
  language: string;
  viewer: { url: string; running: boolean };
}

/** How many components the coverage memory holds; 0 when there is none. */
function countComponents(cwd: string): number {
  try {
    return loadScaleDir(cwd).docs.length;
  } catch {
    return 0;
  }
}

/**
 * Assemble the setup picture. Never throws: a repo with no `.scale/`, no
 * config, and nothing running is a perfectly normal answer — it is exactly the
 * first-run case the caller needs to detect.
 */
export async function buildSetupStatus(cwd: string = process.cwd()): Promise<SetupStatus> {
  const dir = stateDir(cwd);
  const eff = loadEffectiveConfig(cwd, dir).config;
  const provider = eff.models.provider;
  const components = countComponents(cwd);
  const viewer = await resolveViewer(cwd, {}, 300);
  return {
    repoId: resolveRepoId(cwd),
    stateDir: dir,
    initialized: configExists(dir),
    // The identity as the user actually wrote it, not the schema's fallback —
    // "no config" must read as null, not as whoever $USER happens to be.
    user: readConfigSafe(dir)?.user ?? null,
    memory: {
      present: fs.existsSync(path.join(cwd, '.scale')) && components > 0,
      components,
    },
    provider,
    keyPresent: keyStatus()[provider].configured,
    gate: {
      assessment: eff.gate.assessment,
      modality: eff.gate.modality,
      enforcement: eff.gate.enforcement,
    },
    language: eff.language,
    // Token-free (`publicViewerUrl`): this JSON is read by the SessionStart
    // hook and by skills, and ends up in the transcript verbatim.
    viewer: { url: publicViewerUrl(viewer.url), running: viewer.running },
  };
}
