# @feature-gates/firebase-admin

Server-side Boolean feature evaluation using Firebase Admin Remote Config **Server** templates.
Use Firebase Admin 13.5 or newer within major 13. The application initializes its Admin app,
owns credentials, and loads/refreshes a shared template. This package does not initialize Firebase,
fetch templates independently, or publish configuration.

```ts
import { createFirebaseAdminProvider } from '@feature-gates/firebase-admin';

const provider = createFirebaseAdminProvider({
  loadTemplate: () => templateCache.current(),
  context: context => ({
    randomizationId: context.targetId,
    individual_id: context.targetId,
    tenant_id: String(context.attributes?.tenant_id ?? ''),
  }),
});
```

Pass the provider to `createFeatureClient` from `@feature-gates/core`. Create and dispose a
client per concurrent request/context; never switch a global client among users. Derive identity
and tenant from authenticated server context. Omit absent custom signals rather than sending
another user's context. Session values are immutable snapshots of the evaluated template.

Cancellation immediately rejects an outstanding connection and closes an established session.
It does not cancel a shared Admin SDK network fetch used by other requests. Missing parameters,
SDK default values, and values other than `true`/`false` select the catalog fallback.

The application owns template refresh intervals and how long an old template may remain usable.
New requests use its latest template; established request sessions do not subscribe to refreshes.
Firebase Client and Server templates are separate. Manage this provider's parameters in the
Firebase Console's **Server** selector. `ServerTemplate.set()` updates memory only;
Admin `publishTemplate()` manages Client templates.

ES modules and CommonJS are both supported. The Firebase Admin peer is optional for workspaces
that test structural template fixtures; production applications must install the supported SDK.
