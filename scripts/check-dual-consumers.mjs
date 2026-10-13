import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function checkDeclarations() {
  const program = ts.createProgram(['dual-consumer.cts', 'dual-consumer.mts'].map(name =>
    fileURLToPath(new URL(`../tests/compatibility/${name}`, import.meta.url))), {
    strict: true, noEmit: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
    }));
  }
}

async function checkConsumer(core, admin) {
  const provider = admin.createFirebaseAdminProvider({
    loadTemplate: async () => ({ evaluate: () => ({ getAll: () => ({
      testing: { getSource: () => 'remote', asString: () => 'true' },
    }) }) }),
  });
  const client = core.createFeatureClient({
    catalog: core.defineFeatures({ testing: { providerKey: 'testing', fallback: false } }),
    provider,
  });
  await client.start({ targetId: 'dual-format-fixture' });
  assert.equal(client.getSnapshot('testing').enabled, true);
  await client.dispose();
}

await checkConsumer(await import('@feature-gates/core'), await import('@feature-gates/firebase-admin'));
await checkConsumer(require('@feature-gates/core'), require('@feature-gates/firebase-admin'));
checkDeclarations();
console.log('ES module and CommonJS runtime and declaration consumers passed.');
