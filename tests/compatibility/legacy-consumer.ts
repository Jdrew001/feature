import { createFeatureClient, defineFeatures } from '@feature-gates/core';
import { createFirebaseProvider } from '@feature-gates/firebase';
import { createFirebaseAdminProvider } from '@feature-gates/firebase-admin';
import type { FirebaseRemoteConfigSdk } from '@feature-gates/firebase';
import { initializeApp } from 'firebase/app';
import type { FirebaseOptions } from 'firebase/app';
import {
  activate, ensureInitialized, fetchAndActivate, getAll, getRemoteConfig,
  isSupported, onConfigUpdate, setCustomSignals,
} from 'firebase/remote-config';
import type { ConfigUpdate } from 'firebase/remote-config';

const sdk: FirebaseRemoteConfigSdk = {
  activate, ensureInitialized, fetchAndActivate, getAll, isSupported,
  onConfigUpdate, setCustomSignals,
};
const update: ConfigUpdate = { getUpdatedKeys: () => new Set(['beta_giving']) };
update.getUpdatedKeys();

const catalog = defineFeatures({
  betaGiving: { providerKey: 'beta_giving', fallback: false },
});
declare const firebaseOptions: FirebaseOptions;
const app = initializeApp(firebaseOptions);
const provider = createFirebaseProvider({
  remoteConfig: getRemoteConfig(app),
  sdk,
  customSignals: context => ({
    donor_id: context.targetId === 'anonymous' ? null : context.targetId,
  }),
});
const client = createFeatureClient({ catalog, provider });
client.getSnapshot('betaGiving');
client.subscribe('betaGiving', () => undefined);
client.whenSettled('betaGiving');
client.start({ targetId: 'donor-123' });
client.setContext({ targetId: 'anonymous' });

// @ts-expect-error Unknown feature names must remain invalid in the legacy compiler.
client.getSnapshot('unknownFeature');
// @ts-expect-error Subscription names must preserve the catalog's literal keys.
client.subscribe('unknownFeature', () => undefined);
// @ts-expect-error Settlement names must preserve the catalog's literal keys.
client.whenSettled('unknownFeature');
// @ts-expect-error Catalog validation requires a Boolean fallback.
defineFeatures({ invalid: { providerKey: 'invalid', fallback: 'false' } });
// @ts-expect-error Evaluation contexts require a string target ID.
client.setContext({ targetId: 123 });

const inlineClient = createFeatureClient({
  catalog: { inlineFeature: { providerKey: 'inline', fallback: false } },
  provider,
});
inlineClient.getSnapshot('inlineFeature');
// @ts-expect-error Inline catalogs must also infer their valid feature names.
inlineClient.getSnapshot('unknownFeature');

const serverClient = createFeatureClient({ catalog, provider: createFirebaseAdminProvider({
  loadTemplate: async () => ({ evaluate: () => ({ getAll: () => ({}) }) }),
  context: context => ({ individual_id: context.targetId, tenant_id: 'tenant-fixture' }),
}) });
serverClient.getSnapshot('betaGiving');
// @ts-expect-error Server providers preserve the same typed catalog names.
serverClient.getSnapshot('unknownFeature');
