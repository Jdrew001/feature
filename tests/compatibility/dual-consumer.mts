import { createFeatureClient, defineFeatures } from '@feature-gates/core';
import { createFirebaseAdminProvider } from '@feature-gates/firebase-admin';

const client = createFeatureClient({
  catalog: defineFeatures({ testing: { providerKey: 'testing', fallback: false } }),
  provider: createFirebaseAdminProvider({ loadTemplate: async () => ({ evaluate: () => ({ getAll: () => ({}) }) }) }),
});
client.getSnapshot('testing');
// @ts-expect-error ES module declarations retain feature-name checking.
client.getSnapshot('unknown');
