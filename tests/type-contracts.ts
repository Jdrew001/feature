import { createFeatureClient } from '@feature-gates/core';
import { createFeatureBindings } from '@feature-gates/react';
import { createFeatureRoute } from '@feature-gates/angular';
import { MemoryProvider } from '@feature-gates/testing';
const catalog = { reports: { providerKey: 'reports', fallback: false } } as const;
const client = createFeatureClient({ catalog, provider: new MemoryProvider() });
// @ts-expect-error Unknown feature names must fail compilation.
client.getSnapshot('typo');
// @ts-expect-error Environment is selected by the runtime key, not the evaluation context.
client.start({ targetId: 'user', environment: 'PROD' });
const bindings = createFeatureBindings<'reports'>();
// @ts-expect-error Domain React bindings reject unknown feature names.
bindings.useFeature('typo');
const route = createFeatureRoute<'reports'>();
// @ts-expect-error Domain Angular route helpers reject unknown feature names.
route('typo', { path: 'reports' });
