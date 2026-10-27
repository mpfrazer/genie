import { existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { GenieError } from '../errors.ts';
import { detect } from '../detect.ts';
import { checkLayer, repoConfigPath, resolveConfig } from '../config/load.ts';
import { defaultConfig, PROFILE_OVERLAYS } from '../config/defaults.ts';
import { PROFILES, type Config, type ConfigLayer, type ProfileName } from '../config/types.ts';
import { findRoot, genieDir, writeAtomic } from '../store.ts';

export interface InitOptions {
  cwd: string;
  profile?: string;
  force?: boolean;
}

export interface InitResult {
  root: string;
  path: string;
  profile: ProfileName;
  ecosystem?: string;
  layer: ConfigLayer;
  notes: string[];
}

export function init(opts: InitOptions): InitResult {
  const root = findRoot(opts.cwd);
  const path = repoConfigPath(root);
  if (existsSync(path) && !opts.force) {
    throw new GenieError(`${path} already exists (use --force to overwrite)`);
  }
  const profile = (opts.profile ?? 'service') as ProfileName;
  if (!PROFILES.includes(profile)) {
    throw new GenieError(`unknown profile "${opts.profile}" (expected one of: ${PROFILES.join(', ')})`);
  }

  const found = detect(root);
  const notes: string[] = [];
  const layer: ConfigLayer = {
    version: 1,
    profile,
    commands: found.commands,
    forge: {
      provider: found.provider,
      base_branch: found.baseBranch,
      ...(found.ciCommand ? { ci_command: found.ciCommand } : {}),
    },
  };

  // Deploy can't run without a command; leave it off until one is configured.
  const profileDeploys = PROFILE_OVERLAYS[profile].stages?.deploy?.enabled ?? defaultConfig().stages.deploy.enabled;
  if (profileDeploys) {
    layer.stages = { deploy: { enabled: false } };
    notes.push('stages.deploy disabled until deploy.command is set');
  }
  if (Object.keys(found.commands).length === 0) {
    notes.push('no build/test commands detected: fill in `commands` so verification gates can run');
  }
  if (found.provider === 'none') notes.push('no GitHub/GitLab remote found: forge.provider set to none');
  if (found.provider !== 'none' && !found.ciCommand) {
    notes.push('no CI workflows detected: set forge.ci_command so pr.ready can wait for CI (until then a human decides it)');
  }

  checkLayer(layer, 'generated config');
  const presets = resolveConfig(profile, [{ stages: { deploy: { enabled: false } } }]);
  const header = [
    '# genie configuration. Layers merge: plugin defaults < profile < ~/.genie/config.yaml < this file.',
    `# Profile "${profile}" presets: ${describeProfile(presets, profileDeploys)}`,
    '# Override any gate under `gates:`, e.g.  gates: { intent.reviewed: { enabled: false } }',
    '# Orchestrated runs open one PR for the run; for a PR per slice, set  forge: { pr_per: slice }',
    '',
  ].join('\n');
  // Literal blocks keep multi-line commands (like forge.ci_command) readable and editable as written.
  writeAtomic(path, header + YAML.stringify(layer, { blockQuote: 'literal', lineWidth: 0 }));
  writeAtomic(join(genieDir(root), '.gitignore'), 'runs/\nworktrees/\n');

  return { root, path, profile, ecosystem: found.ecosystem, layer, notes };
}

function describeProfile(config: Config, deploys: boolean): string {
  const gates = Object.entries(config.gates);
  const off = gates.filter(([, g]) => !g.enabled).map(([name]) => name);
  const advisory = gates.filter(([, g]) => g.enabled && !g.blocking).map(([name]) => name);
  const stagesOff = Object.entries(config.stages)
    .filter(([name, s]) => !s.enabled && !(name === 'deploy' && deploys))
    .map(([name]) => name);
  const parts = [
    off.length ? `gates off: ${off.join(', ')}` : 'all gates on',
    advisory.length ? `advisory: ${advisory.join(', ')}` : '',
    stagesOff.length ? `stages off: ${stagesOff.join(', ')}` : '',
  ];
  return parts.filter(Boolean).join('; ');
}
