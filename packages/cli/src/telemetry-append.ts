import fs from 'node:fs';
import path from 'node:path';
import { TelemetryRowSchema, type TelemetryRow } from '@scale/core';

/**
 * The telemetry primitive, kept dependency-free so `state.ts` (the ledger) can
 * write rows without an import cycle. Everything analytical lives in
 * `telemetry.ts`.
 *
 * Sync and best-effort by design: rows are written from the edit-gate hook
 * path (<200 ms budget) and from ledger mutations that must not fail because
 * accounting did. A row that fails validation is dropped with a stderr note —
 * the schema is the contract with the collection path, and a malformed row
 * that slipped through would be worse than a missing one.
 */
export const telemetryPath = (dir: string): string => path.join(dir, 'telemetry.jsonl');

export function appendTelemetry(dir: string, row: TelemetryRow): boolean {
  const parsed = TelemetryRowSchema.safeParse(row);
  if (!parsed.success) {
    console.error(`scale: telemetry row dropped — ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    return false;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(telemetryPath(dir), JSON.stringify(parsed.data) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** Every parseable row, in file order. Unparseable lines are skipped. */
export function readTelemetrySafe(dir: string): TelemetryRow[] {
  let text: string;
  try {
    text = fs.readFileSync(telemetryPath(dir), 'utf8');
  } catch {
    return [];
  }
  const rows: TelemetryRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = TelemetryRowSchema.safeParse(JSON.parse(line));
      if (p.success) rows.push(p.data);
    } catch {
      /* skip */
    }
  }
  return rows;
}
