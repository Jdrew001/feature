import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

function compile(arguments_) {
  const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.json', ...arguments_], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

compile([]);
compile(['--module', 'CommonJS', '--moduleResolution', 'Node10', '--verbatimModuleSyntax', 'false', '--outDir', 'dist/cjs']);
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n');
