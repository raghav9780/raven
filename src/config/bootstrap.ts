/**
 * bootstrap.ts — zero-config resolution (ADR-0017). Turns a PartialConfig +
 * live provider discovery into the fully-resolved `Config` the loop uses:
 *   pick provider → listModels() → keep persisted default if still live else the
 *   FIRST discovered → describeModel() → assemble Config → persist on first run.
 *
 * Nothing about the model is hardcoded; static values are last-resort fallbacks
 * for fields a backend omits.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userConfigPath, configFilesFor } from './load.ts';
import type { PartialConfig } from './load.ts';
import type {
  CapabilityProfile,
  Config,
  ContextBudget,
  HarnessPaths,
  ModelConfig,
  ModelProvider,
  PermissionMode,
  RetryPolicy,
} from '../contracts.ts';

/** Base class for user-facing startup failures (printed cleanly, no stack). */
export class StartupError extends Error {}

/** Raised when a provider is reachable but exposes no usable models. */
export class NoModelsError extends StartupError {}

/** Raised when an explicit --model is not among the discovered models. */
export class UnknownModelError extends StartupError {}

export interface ResolveOptions {
  cwd: string;
  /** Provider id to use (default "ollama"). */
  provider?: string;
  /** Explicit model id override (skips the "first discovered" default). */
  model?: string;
  /** Permission mode override. */
  permissionMode?: PermissionMode;
  /** Persist the resolved default to the user config on first run (default true). */
  persist?: boolean;
}

export interface ResolvedConfig {
  config: Config;
  model: ModelConfig;
  profile: CapabilityProfile;
  /** The full discovered list, for the banner / `/model`. */
  discovered: string[];
}

function defaultPaths(cwd: string): HarnessPaths {
  const dir = join(cwd, '.raven');
  return {
    root: cwd,
    sessions: join(dir, 'sessions'),
    spill: join(dir, 'spill'),
    skills: join(dir, 'skills'),
    logs: join(dir, 'logs'),
    configFiles: configFilesFor(cwd),
  };
}

function contextBudgetFor(profile: CapabilityProfile): ContextBudget {
  return {
    contextWindow: profile.contextWindow,
    compactionThreshold: 0.82,
    reserveTokens: Math.min(13_000, Math.floor(profile.contextWindow * 0.15)),
    spillCharThreshold: 50_000,
    keepRecentToolResults: 4,
    maxFailedCompactions: 3,
  };
}

function defaultRetry(profile: CapabilityProfile): RetryPolicy {
  return {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 15_000,
    jitter: true,
    overloadedSwitchThreshold: 2,
    maxTokensEscalation: Math.max(profile.maxOutputTokens, 4096),
  };
}

function persistDefault(model: ModelConfig, providerBaseUrl?: string): void {
  const path = userConfigPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const toWrite: PartialConfig = {
      defaultModel: model.name,
      providers: [
        { id: model.provider, ...(providerBaseUrl ? { baseUrl: providerBaseUrl } : {}) },
      ],
      models: [model],
    };
    writeFileSync(path, `${JSON.stringify(toWrite, null, 2)}\n`, 'utf8');
  } catch {
    // Persistence is best-effort; a read-only home must not break startup.
  }
}

/**
 * Resolve the effective config by discovering live models.
 * @throws NoModelsError when the provider returns an empty model list.
 */
export async function resolveConfig(
  partial: PartialConfig,
  providers: Record<string, ModelProvider>,
  opts: ResolveOptions,
): Promise<ResolvedConfig> {
  const providerId = opts.provider ?? 'ollama';
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`No provider registered for id "${providerId}".`);
  }

  const discovered = provider.listModels
    ? await provider.listModels()
    : [];
  if (discovered.length === 0) {
    throw new NoModelsError(
      `No models found for provider "${providerId}". ` +
        (providerId === 'ollama'
          ? 'Start Ollama and pull a model, e.g. `ollama pull llama3.1`.'
          : 'Configure at least one model for this provider.'),
    );
  }

  // Validate an explicit --model up front so a typo fails cleanly (and is never
  // persisted as the default) rather than surfacing as a mid-run HTTP 404.
  if (opts.model && !discovered.some((m) => m.modelId === opts.model)) {
    throw new UnknownModelError(
      `Model "${opts.model}" is not available for provider "${providerId}". ` +
        `Discovered: ${discovered.map((m) => m.modelId).join(', ')}`,
    );
  }

  const persistedDefault = partial.defaultModel;
  const stillLive =
    persistedDefault &&
    discovered.some((m) => m.modelId === persistedDefault);
  const chosenId =
    opts.model ??
    (stillLive ? persistedDefault : discovered[0].modelId);

  const profile = provider.describeModel
    ? await provider.describeModel(chosenId)
    : provider.capabilities(chosenId);

  const model: ModelConfig = {
    name: chosenId,
    provider: providerId,
    modelId: chosenId,
    profile,
  };

  const baseUrl = partial.providers?.find((p) => p.id === providerId)?.baseUrl;

  const config: Config = {
    providers: partial.providers ?? [{ id: providerId, ...(baseUrl ? { baseUrl } : {}) }],
    models: [model],
    defaultModel: model.name,
    summarizerModel: model.name,
    permissionMode: opts.permissionMode ?? partial.permissionMode ?? 'default',
    permissions: partial.permissions ?? { allow: [], deny: [], ask: [] },
    protectedPaths: partial.protectedPaths ?? [],
    hooks: [],
    context: contextBudgetFor(profile),
    retry: defaultRetry(profile),
    maxSubagentDepth: partial.maxSubagentDepth ?? 0,
    paths: defaultPaths(opts.cwd),
    logLevel: partial.logLevel ?? 'info',
  };

  if (opts.persist !== false && !stillLive) {
    persistDefault(model, baseUrl);
  }

  return {
    config,
    model,
    profile,
    discovered: discovered.map((m) => m.modelId),
  };
}
