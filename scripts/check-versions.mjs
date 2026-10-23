// Fails if the version fields release-please manages have drifted apart.
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = (path) => JSON.parse(read(path));

const lock = json('engine/package-lock.json');
const versions = {
  '.release-please-manifest.json': json('.release-please-manifest.json')['.'],
  'version.txt': read('version.txt').trim(),
  '.claude-plugin/plugin.json': json('.claude-plugin/plugin.json').version,
  'engine/package.json': json('engine/package.json').version,
  'engine/package-lock.json': lock.version,
  'engine/package-lock.json packages[""]': lock.packages[''].version,
};

const distinct = new Set(Object.values(versions));
if (distinct.size !== 1) {
  console.error('Version mismatch:');
  for (const [file, version] of Object.entries(versions)) console.error(`  ${version}\t${file}`);
  process.exit(1);
}
console.log(`versions in sync: ${[...distinct][0]}`);
