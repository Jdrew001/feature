import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-legacy';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const firebaseDirectory = dirname(require.resolve('firebase-compat/package.json'));

function verifyToolchain() {
  const firebase = JSON.parse(readFileSync(join(firebaseDirectory, 'package.json'), 'utf8'));
  assert.equal(ts.version, '4.9.5', 'The consumer check must use TypeScript 4.9.5');
  assert.equal(firebase.version, '12.19.0', 'The consumer check must use Firebase 12.19.0');
}

function checkConsumer() {
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2020,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    baseUrl: root,
    paths: {
      '@feature-gates/core': ['packages/core/dist/index.d.ts'],
      '@feature-gates/firebase': ['packages/firebase/dist/index.d.ts'],
      '@feature-gates/firebase-admin': ['packages/firebase-admin/dist/index.d.ts'],
      'firebase/app': [join(firebaseDirectory, 'app/dist/app/index.d.ts')],
      'firebase/remote-config': [join(firebaseDirectory, 'remote-config/dist/remote-config/index.d.ts')],
    },
  };
  const program = ts.createProgram([join(root, 'tests/compatibility/legacy-consumer.ts')], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    const host = {
      getCanonicalFileName: path => path,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    };
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  }
  assertSdkDeclarations(program);
}

function assertSdkDeclarations(program) {
  const sdkRequire = createRequire(join(firebaseDirectory, 'package.json'));
  for (const name of ['@firebase/app', '@firebase/remote-config']) {
    const directory = dirname(sdkRequire.resolve(`${name}/package.json`));
    assert.ok(program.getSourceFiles().some(source => source.fileName.startsWith(`${directory}/`)),
      `The consumer must parse Firebase 12.19 declarations for ${name}`);
  }
}

verifyToolchain();
checkConsumer();
console.log('TypeScript 4.9.5 consumer and Firebase 12.19.0 declarations passed.');
