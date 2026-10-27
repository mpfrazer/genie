import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import YAML from 'yaml';
import schema from '../../../schema/config.schema.json' with { type: 'json' };
import { GenieError } from '../errors.ts';
import { defaultConfig, PROFILE_OVERLAYS } from './defaults.ts';
import { PROFILES, type Config, type ConfigLayer, type ProfileName } from './types.ts';

const validateLayer = new Ajv({ allErrors: true }).compile(schema);

export interface LoadOptions {
  /** Repository root containing `.genie/`. */
  root: string;
  /** Run-time overrides; the highest-precedence layer. */
  flags?: ConfigLayer;
  /** Directory holding the user layer; defaults to `$GENIE_HOME` or `~/.genie`. */
  userDir?: string;
}

export interface LoadedConfig {
  config: Config;
  /** Files that contributed, lowest precedence first. */
  sources: string[];
}

export function userConfigDir(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

export function repoConfigPath(root: string): string {
  return join(root, '.genie', 'config.yaml');
}

/** Merges plugin defaults → profile → user → repo → flags, validating each file layer. */
export function loadConfig(opts: LoadOptions): LoadedConfig {
  const userPath = join(opts.userDir ?? userConfigDir(), 'config.yaml');
  const repoPath = repoConfigPath(opts.root);
  const user = readLayer(userPath);
  const repo = readLayer(repoPath);
  const flags = opts.flags ?? {};
  if (Object.keys(flags).length > 0) checkLayer(flags, 'flags');

  const profile: ProfileName = flags.profile ?? repo?.profile ?? user?.profile ?? defaultConfig().profile;
  if (!PROFILES.includes(profile)) throw new GenieError(`unknown profile "${profile}"`);

  const config = resolveConfig(profile, [user, repo, flags]);
  return { config, sources: [userPath, repoPath].filter((p) => existsSync(p)) };
}

/** Pure merge of defaults → profile overlay → `layers` (lowest precedence first), plus semantic checks. */
export function resolveConfig(profile: ProfileName, layers: (ConfigLayer | undefined)[]): Config {
  let merged = defaultConfig() as unknown as Record<string, unknown>;
  for (const layer of [PROFILE_OVERLAYS[profile], ...layers]) {
    if (layer) merged = deepMerge(merged, layer as Record<string, unknown>);
  }
  merged.profile = profile;
  const config = merged as unknown as Config;
  checkSemantics(config);
  return config;
}

function readLayer(path: string): ConfigLayer | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new GenieError(`${path}: invalid YAML: ${(err as Error).message}`);
  }
  if (parsed == null) return {};
  checkLayer(parsed, path);
  return parsed as ConfigLayer;
}

export function checkLayer(layer: unknown, source: string): void {
  if (validateLayer(layer)) return;
  const problems = (validateLayer.errors ?? []).map((e) => {
    const where = e.instancePath || '(root)';
    const extra = e.keyword === 'additionalProperties' ? ` "${String(e.params.additionalProperty)}"` : '';
    return `  ${where}: ${e.message}${extra}`;
  });
  throw new GenieError(`${source}: invalid config\n${problems.join('\n')}`);
}

/** Cross-field rules JSON Schema can't express. */
function checkSemantics(config: Config): void {
  if (config.stages.deploy.enabled && !config.deploy.command) {
    throw new GenieError('stages.deploy is enabled but deploy.command is not set (set it, or disable stages.deploy)');
  }
  if (config.forge.pr_per === 'slice') {
    // Each slice's PR is opened and merged as part of implement, so both stages have to be on.
    const off = (['pr', 'merge'] as const).filter((stage) => !config.stages[stage].enabled);
    if (off.length > 0) throw new GenieError(`forge.pr_per: slice opens and merges a PR per slice, but stages.${off.join(' and stages.')} ${off.length === 1 ? 'is' : 'are'} disabled`);
    if (config.forge.provider !== 'github') throw new GenieError(`forge.pr_per: slice needs forge.provider: github (it is ${config.forge.provider})`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Objects merge recursively; arrays and scalars replace; undefined is ignored. */
export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined || key === '$schema') continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}
