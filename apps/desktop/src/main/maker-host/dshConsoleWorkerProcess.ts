/**
 * Electron utility-process entry for the official DSH Web profile.
 *
 * Production disables RunAsNode, so the CLI must run inside Electron's supported
 * utility-process host instead of spawning the Electron executable as Node.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cliPath = process.argv[2];

if (typeof cliPath !== 'string' || !path.isAbsolute(cliPath) || path.extname(cliPath) !== '.js') {
  throw new Error('DSH console CLI path is invalid');
}

process.argv = [process.argv[0], cliPath, 'web', '--host', '127.0.0.1', '--port', '0'];

void import(/* @vite-ignore */ pathToFileURL(cliPath).href).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`DSH console failed to load: ${message}\n`);
  setImmediate(() => process.exit(1));
});
