/**
 * load.ts — layered config loading. The on-disk config is a PARTIAL override
 * (it may declare nothing — zero-config is the norm). Layers merge most-specific
 * last: user (~/.raven) → project (cwd/.raven, cwd/raven.config.json). API keys
 * support `env:VAR` indirection so secrets never live in the file.
 *
 * `config/bootstrap.ts` turns this PartialConfig + live discovery into the fully
 * resolved `Config` the loop uses.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config, ProviderConfig } from '../contracts.ts';

/**
 * Minimal `.env` loader (zero-dependency; no dotenv package). Parses simple
 * `KEY=VALUE` lines from `<cwd>/.env` then `~/.raven/.env` and populates
 * `process.env` — WITHOUT overwriting a variable already set in the real
 * environment (an explicit `$env:VAR` / shell export always wins). This is what
 * lets `apiKey: "env:PETROIT_API_KEY"` resolve from a local file the user never
 * has to export by hand. Supports `# comments`, blank lines, `export KEY=…`,
 * and single/double-quoted values. Values are NOT variable-expanded.
 */
export function loadDotEnv(cwd: string): void {
  const files = [join(cwd, '.env'), join(homedir(), '.raven', '.env')];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const body = line.startsWith('export ') ? line.slice('export '.length) : line;
      const eq = body.indexOf('=');
      if (eq <= 0) continue;
      const key = body.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] !== undefined) continue; // real env wins
      let value = body.slice(eq + 1).trim();
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

/** A partial, on-disk view of the config; every field is optional. */
export type PartialConfig = Partial<Config>;

/** Absolute path to the user-level config file (where bootstrap persists). */
export function userConfigPath(): string {
  return join(homedir(), '.raven', 'config.json');
}

/** Candidate config files, least-specific first. */
export function configFilesFor(cwd: string): string[] {
  return [
    userConfigPath(),
    join(cwd, '.raven', 'config.json'),
    join(cwd, 'raven.config.json'),
  ];
}

function readJsonIfExists(path: string): PartialConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PartialConfig;
  } catch {
    return undefined;
  }
}

/** Resolve `env:VAR` API-key indirection against the environment. */
function resolveProviderSecrets(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.map((provider) => {
    if (provider.apiKey?.startsWith('env:')) {
      const varName = provider.apiKey.slice('env:'.length);
      return { ...provider, apiKey: process.env[varName] ?? '' };
    }
    return provider;
  });
}

/**
 * Load and shallow-merge the layered config for `cwd`. Returns a PartialConfig;
 * absent fields are filled by discovery in bootstrap.
 */
export function loadConfig(cwd: string): PartialConfig {
  let merged: PartialConfig = {};
  for (const path of configFilesFor(cwd)) {
    const layer = readJsonIfExists(path);
    if (layer) merged = { ...merged, ...layer };
  }
  if (merged.providers) {
    merged = { ...merged, providers: resolveProviderSecrets(merged.providers) };
  }
  return merged;
}
