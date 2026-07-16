/**
 * bootstrap.ts — zero-config resolution (ADR-0017). Turns a PartialConfig +
 * live provider discovery into the fully-resolved `Config` the loop uses:
 *   pick provider → listModels() → keep persisted default if still live else the
 *   FIRST discovered → describeModel() → assemble Config → persist on first run.
 *
 * Nothing about the model is hardcoded; static values are last-resort fallbacks
 * for fields a backend omits.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    // MERGE with the existing file — persisting a new default must never wipe
    // other providers/models/settings the user has configured by hand.
    let existing: PartialConfig = {};
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as PartialConfig;
    } catch {
      // no file yet / unreadable → start fresh
    }
    const providers = [...(existing.providers ?? [])];
    if (!providers.some((p) => p.id === model.provider)) {
      providers.push({
        id: model.provider,
        ...(providerBaseUrl ? { baseUrl: providerBaseUrl } : {}),
      });
    }
    const models = [
      ...(existing.models ?? []).filter((m) => m.name !== model.name),
      model,
    ];
    const toWrite: PartialConfig = {
      ...existing,
      defaultModel: model.name,
      providers,
      models,
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
    throw new StartupError(
      `Unknown provider "${providerId}". Available: ${Object.keys(providers).join(', ') || '(none)'}.`,
    );
  }

  // Models the user declared for this provider in config. They serve as a
  // fallback when live discovery is unavailable (an API gateway without a
  // /models endpoint) and their profiles override discovered capabilities.
  const declared = (partial.models ?? []).filter(
    (m) => m.provider === providerId,
  );
  const declaredAsDiscovered = declared.map((m) => ({
    modelId: m.modelId,
    provider: providerId,
  }));

  let discovered;
  try {
    discovered = provider.listModels ? await provider.listModels() : [];
  } catch (err) {
    if (declaredAsDiscovered.length > 0) {
      discovered = declaredAsDiscovered; // config keeps us usable offline
    } else {
      const detail = err instanceof Error ? err.message : String(err);
      throw new StartupError(
        `Could not reach the "${providerId}" backend: ${detail}. ` +
          (providerId === 'ollama'
            ? 'Is Ollama running? Start it with `ollama serve` (or launch the Ollama app).'
            : 'Check the provider baseUrl/apiKey and that the service is up, ' +
              'or declare its models in the config `models` array.'),
      );
    }
  }
  if (discovered.length === 0) {
    if (declaredAsDiscovered.length > 0) {
      discovered = declaredAsDiscovered;
    } else {
      throw new NoModelsError(
        `No models found for provider "${providerId}". ` +
          (providerId === 'ollama'
            ? 'Start Ollama and pull a model, e.g. `ollama pull llama3.1`.'
            : 'Configure at least one model for this provider.'),
      );
    }
  }

  // Validate an explicit --model up front so a typo fails cleanly (and is never
  // persisted as the default) rather than surfacing as a mid-run HTTP 404.
  if (opts.model && !discovered.some((m) => m.modelId === opts.model)) {
    throw new UnknownModelError(
      `Model "${opts.model}" is not available for provider "${providerId}". ` +
        `Discovered: ${discovered.map((m) => m.modelId).join(', ')}`,
    );
  }

  // Preferred default: this provider's own `defaultModel` (so local and API
  // modes keep separate defaults) falling back to the global `defaultModel`.
  // Used only when it's actually one of this provider's live models; else the
  // first discovered model wins. An explicit --model always overrides.
  const providerEntry = partial.providers?.find((p) => p.id === providerId);
  const preferred = providerEntry?.defaultModel ?? partial.defaultModel;
  const preferredLive =
    preferred && discovered.some((m) => m.modelId === preferred);
  const chosenId =
    opts.model ?? (preferredLive ? preferred : discovered[0].modelId);

  const liveProfile = provider.describeModel
    ? await provider.describeModel(chosenId)
    : provider.capabilities(chosenId);
  // A profile declared for this model in config overrides discovered fields
  // (cloud backends can't be introspected; users may also pin e.g. a smaller
  // context window than the backend advertises).
  const declaredModel = declared.find(
    (m) => m.modelId === chosenId || m.name === chosenId,
  );
  const profile = declaredModel?.profile
    ? { ...liveProfile, ...declaredModel.profile }
    : liveProfile;

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

  // Persist only when the resolved default actually changed, so a normal run
  // doesn't rewrite the user config every time.
  if (opts.persist !== false && partial.defaultModel !== chosenId) {
    persistDefault(model, baseUrl);
  }

  return {
    config,
    model,
    profile,
    discovered: discovered.map((m) => m.modelId),
  };
}
