# @feature-gates/firebase

Firebase Remote Config provider for the framework-independent feature client.
Requires Firebase JavaScript SDK 12.3 or newer within major 12, or major 13,
and @feature-gates/core 0.1. The compatibility checks exercise Firebase 12.19.0
with TypeScript 4.9.5 and Firebase 13.0.0 with the workspace compiler. For an
Angular 15 consumer, use core and this provider behind an application-owned
service; the separate Angular adapter requires Angular 20.

The SDK's browser and Node requirements are independent of the Angular adapter.
Firebase 12.19.0 supports Node 20 for consumers that also import the SDK on their
backend. Choose and pin the SDK version in the application; this provider does
not initialize Firebase or upgrade the consuming application's framework.
Angular and React use the same feature declarations and gates with either this
provider or Harness.

## Setup

Install @feature-gates/core, @feature-gates/firebase, and firebase in the consuming
application. Initialize your Firebase web app in the application shell from its
runtime configuration, then pass a dedicated Remote Config instance:

```ts
import { initializeApp } from 'firebase/app';
import { getRemoteConfig } from 'firebase/remote-config';
import { createFeatureClient, defineFeatures } from '@feature-gates/core';
import { createFirebaseProvider } from '@feature-gates/firebase';

const app = initializeApp(runtime.firebaseConfig);
const remoteConfig = getRemoteConfig(app);
const catalog = defineFeatures({
  betaGiving: { providerKey: 'beta_giving', fallback: false },
});
const client = createFeatureClient({
  catalog,
  provider: createFirebaseProvider({
    remoteConfig,
    customSignals: context => ({
      beta_tester: context.attributes?.betaTester === true ? 'true' : 'false',
    }),
  }),
});
await client.start({
  targetId: user.id,
  attributes: { betaTester: user.betaTester },
});
```

Your application owns Firebase initialization and deletion. The provider owns its
subscription, detaches it on abort/disposal, and never deletes the supplied app.
Use one client per Remote Config instance and avoid external fetches, activation,
or custom-signal writes while that client is running.

## Firebase-managed donor allowlist

For an application such as Faith Giving, membership can be managed entirely in
Firebase without adding a beta field to donor profiles:

```ts
createFirebaseProvider({
  remoteConfig,
  customSignals: context => ({
    donor_id: context.targetId === 'anonymous' ? null : context.targetId,
  }),
});
```

Create a Boolean `beta_giving` parameter with a template default of false. In the
Firebase console, add a custom-signal condition matching `donor_id` against the
selected donor IDs and set its conditional value to true. The app supplies the
signed-in donor ID through `start` and `setContext`; Firebase owns the allowlist.
Use `setContext({ targetId: 'anonymous' })` on logout to unset the persisted ID.
These flags control frontend release exposure; they do not authorize donations
or protect private data.

## Application-managed beta membership

1. Store beta membership in your application's account/profile data or opt-in system.
2. Create a Boolean Remote Config parameter called beta_giving with a template
   default of false.
3. Create a condition comparing the custom signal beta_tester to the string true.
   Assign true to beta_giving for that condition, then publish the template.
4. Pass the signed-in user's beta membership into client.start or client.setContext.
5. Gate the beta screen with the feature name betaGiving through the existing
   Angular or React integration.

On logout, call:

```ts
await client.setContext({
  targetId: 'anonymous',
  attributes: { betaTester: false },
});
```

Firebase manages flag values and rollout conditions. Your application manages who
is a beta tester. The library maps only the signals you explicitly select;
targetId and all attributes are not automatically uploaded. Custom signal values
are strings, numbers, or null, so map boolean attributes to strings.

Firebase persists custom signals. Return every signal you manage on every
context, using false-like values or null to remove prior membership. Returning
an empty object does not clear previously persisted signals. Targeted sessions
set signals before fetching and temporarily bypass the SDK fetch cache so a
previous user's template is not reused; the configured interval is restored
after the request. If Firebase still reuses the fetch timestamp, the targeted
session falls back rather than accepting the cached template. Frequent identity changes/retries can still be throttled by
Firebase and produce catalog fallbacks.

See [the full example](../../examples/firebase.ts),
[Firebase parameters and conditions](https://firebase.google.com/docs/remote-config/parameters),
and [the SDK reference](https://firebase.google.com/docs/reference/js/remote-config).
This example does not modify or integrate the Faith Giving application itself.

## Decisions and lifecycle

Only remote strings true and false are accepted (case insensitive, trimmed).
Firebase's permissive boolean conversion is deliberately avoided. Missing keys,
static values, and SDK in-app defaults use the core catalog fallback. Firebase
template defaults fetched from the server count as remote values.

Initialization waits for fetchAndActivate to succeed. An unchanged template
(the SDK returns false) is still successful. Reused fetch timestamps are
reported with source cache, which core marks degraded; fresh fetches and live
updates use source provider. Failed fetches never reuse a prior active template
as a successful connection.

Real-time updates are enabled by default: onConfigUpdate fetches the published
template, the adapter activates it, copies its remote values, and notifies core.
Removed flags become missing. Stream/activation errors degrade decisions to
catalog fallbacks; a later successful update restores them. Set realtime: false
for fetch-only operation and use client.retry to refresh.

Without customSignals, Firebase evaluates its ordinary project/installation
conditions; core context changes reconnect but do not change Firebase targeting.
With customSignals, the app explicitly maps its context to Firebase conditions.
Do not use client feature flags as backend authorization or payment validation.

SDK fetch/activation calls have no public AbortSignal option. Cancellation rejects
the connection promptly, closes subscriptions, and suppresses late publication,
but an already-running SDK request may finish. Operations are serialized for
the supplied instance before a replacement session can publish. Configure
remoteConfig.settings.fetchTimeoutMillis to bound these requests.

This is a browser provider requiring Firebase's IndexedDB support. Unsupported
environments use core's degraded fallbacks. Server-side rendering and Firebase
Admin SDK integration are outside this package.

Local tests cover the provider contract, beta signal mapping and logout, cache,
failures/retry, live activation, cancellation, and replacement sessions. They
use SDK fixtures plus the installed SDK's environment support check; a live
Firebase project and its rollout rules have not been verified.
