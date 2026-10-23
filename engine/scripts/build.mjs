// Bundles the CLI into a single self-contained file so the plugin runs without `npm install`.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/genie.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  minify: true,
  banner: {
    // Bundled CommonJS dependencies (ajv) call require(); give them one under ESM.
    js: "#!/usr/bin/env node\nimport { createRequire as __genieCreateRequire } from 'node:module';\nconst require = __genieCreateRequire(import.meta.url);",
  },
});
