/**
 * Bundles the CLI into the single file the npm package ships.
 *
 * The product's pitch is that it needs no credentials, no repository access and
 * uploads nothing; a package that dragged in a dependency tree would undercut
 * that before anyone read the README. Everything the CLI imports is bundled
 * here — inlined into this one file, never left as an external `require`/
 * `import` — so the published tarball is this one file plus the README and
 * the licence: nothing to install, nothing that runs at install time.
 *
 * "Zero runtime dependencies" describes the published package (its own
 * package.json declares none, and nothing it imports resolves to
 * node_modules at install or run time), not the source tree this builds
 * from: `cli/src/yaml.ts` deliberately depends on the `yaml` npm package
 * (see its own doc comment for why), and esbuild inlines it into the bundle
 * like everything else. `ALLOWED_VENDORED_PACKAGES` is the exhaustive list of
 * node_modules packages this build is allowed to inline; the build fails
 * rather than warns if bundling pulls in anything from node_modules that is
 * NOT on that list — an accidental new dependency should never slip into the
 * bundle unnoticed.
 */

import { build } from 'esbuild';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const outfile = join(root, 'cli', 'dist', 'apibreak.js');

/** node_modules packages this build is allowed to inline into the bundle. */
const ALLOWED_VENDORED_PACKAGES = ['yaml'];
const vendoredPackageName = (path) => {
  const m = path.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//);
  return m?.[1];
};

await mkdir(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [join(root, 'cli', 'src', 'bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: {
    // The `yaml` package's dist is CommonJS; bundled into this ESM output,
    // esbuild replaces its internal `require(...)` calls with a shim that
    // throws "Dynamic require ... is not supported" unless a real `require`
    // is already in scope — Node builtins like `process` and `node:util`
    // are among the modules it reaches for. `createRequire` supplies one.
    js:
      '#!/usr/bin/env node\n' +
      '// apibreak — generated bundle, do not edit. Source: https://github.com/Skyblueballykid/apibreak\n' +
      "import { createRequire as __apibreakCreateRequire } from 'node:module';\n" +
      'const require = __apibreakCreateRequire(import.meta.url);',
  },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

const allVendored = Object.keys(result.metafile.inputs).filter((p) => p.includes('node_modules'));
const disallowedVendored = allVendored.filter((p) => !ALLOWED_VENDORED_PACKAGES.includes(vendoredPackageName(p)));
if (disallowedVendored.length > 0) {
  process.stderr.write(`bundle pulled in unlisted third-party code:\n${disallowedVendored.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}

await chmod(outfile, 0o755);

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
const sources = Object.keys(result.metafile.inputs).length;
const vendoredPackages = [...new Set(allVendored.map(vendoredPackageName))];
process.stdout.write(
  `cli/dist/apibreak.js — ${(bytes / 1024).toFixed(1)} kB, ${sources} sources, ` +
    `0 runtime dependencies (${vendoredPackages.length} inlined: ${vendoredPackages.join(', ') || 'none'})\n`
);
