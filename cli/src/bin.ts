/**
 * The one entry point: the `apibreak` binary, and `pnpm apibreak` in this repo.
 *
 * `cli.ts` exports `main` and runs nothing on import, so this file decides when
 * the tool runs. It sets `process.exitCode` rather than calling `process.exit`:
 * a report written to a pipe is flushed asynchronously, and exiting straight
 * after the write truncates it at the pipe buffer — a 158 kB report arrived as
 * 64 kB when piped. Letting Node exit on its own drains stdout first.
 *
 * There is deliberately no shebang here: scripts/build-npm.mjs adds exactly one
 * to the bundle. A shebang in this file too would survive bundling and land on
 * line 2 of the output, where it is a syntax error rather than a comment.
 */

import { main } from './cli.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`apibreak failed: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
