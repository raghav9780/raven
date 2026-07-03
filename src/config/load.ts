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
