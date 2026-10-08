import { deleteApp, initializeApp } from 'firebase/app';
import type { FirebaseOptions } from 'firebase/app';
import { getRemoteConfig } from 'firebase/remote-config';
import { createFeatureClient, defineFeatures } from '@feature-gates/core';
import { createFirebaseProvider } from '@feature-gates/firebase';

// Illustrative Faith Giving catalog; use the same keys in Firebase Remote Config.
export const firebaseFeatures = defineFeatures({
  betaGiving: { providerKey: 'beta_giving', fallback: false, owner: 'giving' },
});

export async function bootstrapFirebaseFeatures(
  firebaseConfig: FirebaseOptions,
  user: { id: string; betaTester: boolean },
) {
  const app = initializeApp(firebaseConfig, 'faith-giving-features');
  const remoteConfig = getRemoteConfig(app);
  remoteConfig.settings.fetchTimeoutMillis = 10000;

  const client = createFeatureClient({
    catalog: firebaseFeatures,
    provider: createFirebaseProvider({
      remoteConfig,
      customSignals: context => ({
        beta_tester: context.attributes?.betaTester === true ? 'true' : 'false',
      }),
    }),
  });
  await client.start({ targetId: user.id, attributes: { betaTester: user.betaTester } });

  return {
    client,
    async dispose() {
      await client.dispose();
      await deleteApp(app);
    },
  };
}

// On login/account changes:
// await client.setContext({ targetId: nextUser.id, attributes: { betaTester: nextUser.betaTester } });
// On logout:
// await client.setContext({ targetId: 'anonymous', attributes: { betaTester: false } });
// Pass client into React FeatureProvider; Angular can use the same provider options
// with provideFeatures, which owns startup and disposal of its feature client.
