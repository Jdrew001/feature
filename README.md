# Feature gates for Angular and React

A reusable TypeScript feature decision client with Harness, Firebase Remote Config, Angular, React, and in memory testing adapters. Gate complete features at routes, UI containers, or business operation boundaries instead of repeating SDK checks in child components.

Harness selects its deployment context from the runtime-injected SDK key. **There is no environment setting in the library.** Applications supply only the target identifier and targeting attributes. OpenShift runtime configuration is loaded before constructing the provider; no credential is embedded in the source or compiled examples.

## Build and verify

Use Node 24 LTS, or another version satisfying the root `engines` field. The lockfile pins the development dependencies.

```sh
npm ci
npm run check
```

`check` builds every package, checks test and example types, and runs the tests. Angular builds with its compiler in partial compilation mode for consumption by Angular applications. Tests execute the emitted package exports, including the Angular output.

The root `.npmrc` uses legacy peer resolution for this development workspace. All required peers are explicitly installed in root development dependencies. Published package manifests still declare their consumer peer requirements; this setting is not included in their tarballs.

## Packages

| Package | Responsibility | Supported integration |
| --- | --- | --- |
| `@feature-gates/core` | Typed catalog, decisions, subscriptions, lifecycle | Plain TypeScript |
| `@feature-gates/harness` | Browser SDK evaluation and events | Harness Feature Flags JavaScript SDK 1.32 |
| `@feature-gates/firebase` | Remote Config values, beta targeting signals, and real-time updates | Firebase JavaScript SDK 13 |
| `@feature-gates/angular` | Providers, signals, directive, route guard, forRoot | Angular 20 |
| `@feature-gates/react` | Reader context, hook, boundary, typed bindings | React 19 |
| `@feature-gates/testing` | Controlled provider and per-target sessions | Unit and component tests |

Angular and React adapters depend on core; neither depends on Harness or Firebase. Select the provider when constructing your root client. Business catalogs belong to applications or shared domain packages, rather than to the generic library.

## Define features once

```ts
import { defineFeatures } from '@feature-gates/core';

export const features = defineFeatures({
  advancedReports: {
    providerKey: 'reports.advanced',
    fallback: false,
    owner: 'reporting',
  },
});
export type FeatureName = keyof typeof features;
```

Definitions are defensively copied and frozen during client construction. Empty catalogs, duplicate provider keys, invalid definitions, empty target identifiers, and nonprimitive/nonfinite attributes are rejected. Unknown names throw by default. Explicit `strictUnknownFeatures: false` produces an off decision and a deduplicated diagnostic for unknown names.

## Initialize from runtime configuration

```ts
import { createFeatureClient } from '@feature-gates/core';
import { createHarnessProvider } from '@feature-gates/harness';

const client = createFeatureClient({
  catalog: features,
  provider: createHarnessProvider({ sdkKey: runtime.harnessSdkKey }),
  initializationTimeoutMs: 3000,
  onDiagnostic: diagnostic => telemetry.record(diagnostic),
});
await client.start({
  targetId: authenticatedUser.stableId,
  attributes: { tenant: authenticatedUser.tenantId },
});
```

`runtime` and the authenticated user come from your application shell. See `examples/runtime-config.ts` and `examples/runtime-config.example.json` for a JSON contract that OpenShift can mount or serve. Deployment configuration selects the correct browser SDK key. The browser SDK must receive a browser/client key, never a server SDK secret.

Construct one provider/client at the application root. A changed runtime credential requires disposal and construction of a new root client; target changes use `setContext()`. Do not initialize SDKs in lazy routes or leaf components.

## Firebase and beta features

Use `createFirebaseProvider({ remoteConfig })` in place of `createHarnessProvider`
to read flags from Firebase Remote Config. Applications initialize Firebase from
their runtime configuration and supply a dedicated Remote Config instance.
The UI and core packages need no changes when choosing the provider.

For beta access, provide an explicit `customSignals` mapping:

```ts
provider: createFirebaseProvider({
  remoteConfig,
  customSignals: context => ({
    beta_tester: context.attributes?.betaTester === true ? 'true' : 'false',
  }),
})
```

Your application manages beta membership and passes it in the evaluation context.
Firebase stores the flags and conditions: create a Boolean parameter such as
`beta_giving`, default it to false, and enable it when `beta_tester` equals the
string `true`. Update the context on account changes and set beta membership to
false on logout. Explicit signal mapping avoids sending identifiers or unrelated
attributes automatically.

See [Firebase setup and behavior](packages/firebase/README.md) and
[the illustrative Faith Giving example](examples/firebase.ts). Targeted sessions
force a fetch after setting signals; ordinary sessions respect Firebase's fetch
cache and report reused values as degraded cache decisions. Live updates are
activated automatically. No live Firebase project or Faith Giving application
has been configured by adding this package.

## Angular

```ts
provideFeatures({
  catalog: features,
  provider: createHarnessProvider({ sdkKey: runtime.harnessSdkKey }),
  initialContext: { targetId: userId, attributes: { tenant: tenantId } },
});
```

The initializer waits until decisions settle or the initialization deadline expires. Root destruction disposes the client. NgModule applications can use `FeatureFlagsModule.forRoot(options)`; import `FeatureFlagsModule` without `forRoot()` in feature modules, or import the standalone directive directly.

```html
<app-advanced-reports
  *featureGate="reportsFeature; else: unavailable; pending: loading">
</app-advanced-reports>
<ng-template #loading>Loading…</ng-template>
<ng-template #unavailable>Reports are unavailable.</ng-template>
```

Set `reportsFeature` to a property typed as your domain `FeatureName`. The generic directive accepts strings; Angular cannot infer a domain union from unrelated provider registration. The typed property and runtime catalog validation cover that boundary. Use an application wrapper directive if literal template names must be checked against the union.

Only the selected template instantiates. Pending and off content do not instantiate the enabled subtree. Views are retained on no-op updates, and effects track the currently selected feature. `FeatureState.decision(name)` returns a read-only signal; it shares one subscription per accessed catalog feature until the root service is destroyed.

For a whole screen, gate its route:

```ts
const featureRoute = createFeatureRoute<FeatureName>();
const routes = [
  featureRoute('advancedReports', {
    path: 'reports',
    loadComponent: () => import('./reports.component').then(m => m.ReportsComponent),
  }, '/home'),
];
```

`featureCanMatch` reads route metadata, waits a bounded time, and returns either true, false to permit fallthrough, or a redirect URL tree. `featureTimeoutMs` in route data overrides the three-second wait. It rechecks the current decision after waiting. Keep authentication guards separate. Guards do not evict an already active screen and do not disable router preloading; those are application policies.

On login, logout, or tenant changes, call `inject(FEATURE_CLIENT).setContext(nextContext)` from the shell. Logout should use a stable anonymous target or dispose the root, rather than retain the previous user's context.

## React

The shell owns startup and disposal. The React provider exposes the reader and does not initialize or dispose it, making ownership explicit and avoiding Strict Mode lifecycle duplication.

```tsx
const { FeatureGate, useFeature } = createFeatureBindings<FeatureName>();

<FeatureProvider reader={client}>
  <FeatureGate feature="advancedReports" pending={<Loading />} fallback={null}>
    <AdvancedReports />
  </FeatureGate>
</FeatureProvider>
```

The hook uses `useSyncExternalStore` with immutable snapshots. Put feature effects inside the gated subtree. A parent hook or an expression evaluated while constructing props still executes even when its child boundary is off.

Call `root.unmount()` and then `await client.dispose()` when the shell is destroyed. See `examples/react.tsx` for the full bootstrap and lifecycle handle. Router integration is application-owned because React routers differ; use the reader to make the same bounded decision at the router's loader or component boundary.

`useFeature` and `FeatureGate` accept an explicit `serverSnapshot` for server rendering. A complete server provider, request isolation, and snapshot serialization are not included. The Harness adapter is for browsers. Never share a mutable target client between server requests.

## Core lifecycle and decisions

`getSnapshot(name)` synchronously reads local state. Repeated reads return the same frozen object until a decision changes. `subscribe(name, listener)` returns an idempotent cleanup function. `whenSettled(name)` resolves ready or degraded decisions; start the client before awaiting settlement.

Decisions contain `enabled`, `status`, `source`, `reason`, `revision`, and `contextRevision`. A remote false is a valid ready decision. A missing/invalid/unavailable flag uses the catalog fallback and is degraded. Initial loading and target transitions are pending even though the snapshot includes an effective fallback value; UI adapters display their pending branch first.

Startup is idempotent for the same target and attributes. Attribute ordering does not change context identity. Initialization timeout publishes degraded fallbacks and releases startup waiters, while allowing the same connection attempt to recover later. `retry()` explicitly creates a new attempt after a failure.

`setContext()` clears previous decisions immediately, rejects old waiters with `ContextChangedError`, aborts superseded work, and serializes replacement sessions. Late results cannot publish into the next target's store. Providers must release resources when aborted. The core defensively closes sessions returned after cancellation, but cannot force an arbitrary third-party provider to cancel its own network work.

`dispose()` is idempotent, aborts pending work, rejects pending waiters with `DisposedError`, removes listeners, and closes the session. Diagnostics contain feature keys and reason codes rather than raw credentials, targets, attributes, or provider error payloads. The application decides which deployment metadata to attach in its telemetry sink.

## Harness behavior

Persistent caching is disabled. A disconnect or evaluation failure immediately uses catalog fallbacks. Successful full loads restore all decisions; a successful live flag update can restore that flag while others remain degraded. There is no last-known-value retention timer in this version.

The adapter maintains a current evaluation catalog from full loads and live events. Flags omitted from a successful full response become missing even if the underlying SDK retains a previous storage value. Only boolean flags are accepted. It uses the SDK debug variation result to distinguish a remote false from a returned default.

The adapter waits for `FLAGS_LOADED`: SDK 1.32 can emit `READY` after an initial evaluation fetch failure. Authentication failure rejects the provider connection and produces fallback decisions through core. Polling and streaming update handlers use the installed SDK's event contract. Metrics failures do not turn off features. SDK evaluation analytics are not a substitute for application exposure metrics.

Live flag changes may unmount a generic UI boundary. For forms and multi-step workflows, pin the chosen implementation in an application facade or flow controller, and define what disabling means for existing work. Keep backend authorization and required backend release checks independent of browser flags.

## Tests and limitations

Tests cover typed package compilation, snapshot stability, fallback states, deadlines and late recovery, identity races, abort/disposal, listener isolation, Angular view creation and routing, React subtree effects and Strict Mode, Harness event mapping, and Firebase Remote Config evaluation, beta signals, cache, activation, failures, and cancellation. Additional Harness tests use the actual installed SDK with simulated fetch responses for authentication, polling, removed flags, and cleanup. Firebase tests use SDK fixtures and the installed SDK's environment support check.

These checks prove local library behavior. They do not prove a live Harness project, real rollout rules, deployed OpenShift configuration, or production application compatibility. No remote flag or deployment was changed. Streaming event mapping is exercised with fixtures; the live streaming transport has not been verified.

The first version intentionally provides boolean gates, not experiments, entitlement rules, generic decorators, or a rules expression language. Backend adapters, complete SSR support, and shared microfrontend hosting remain extensions. Angular 20 and React 19 are the supported baselines; older versions need their own compatibility work and tests.

## Internal distribution

After `npm run check`, pack each workspace with `npm pack --workspace @feature-gates/core` and the corresponding adapter workspace. Packages include compiled code, declarations, source for maps, and a package README. Install core alongside the framework adapter and your chosen provider's SDK/adapter peers. Publishing to an internal registry is a separate action and has not been performed.

Each temporary release flag should have an owner and removal condition. Create remote flags off before deploying their first references, merge small safe increments, enable controlled testing through Harness targeting, and remove the gate and old behavior after rollout stabilizes. Keep remote definitions until supported deployed versions no longer reference them.
