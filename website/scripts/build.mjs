import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await copyFile('index.html', 'dist/index.html');
await build({
  entryPoints: ['src/edge.ts'],
  outfile: 'dist/_worker.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  // Cloudflare provides Node.js APIs and its native HTTP-server bridge.
  external: ['node:*', 'cloudflare:*'],
  sourcemap: false,
  logLevel: 'info'
});
console.log('AniChan Pages staging build complete.');

