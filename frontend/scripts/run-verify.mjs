// 复核版本化逻辑的本地验证：esbuild 打包 TS 脚本后用 node 执行（fake-indexeddb 内存库）
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(root, '..', 'node_modules', '.tmp-verify.mjs');

await build({
  entryPoints: [path.join(root, 'verify-review.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'warning',
});

await import(path.resolve(outfile));
