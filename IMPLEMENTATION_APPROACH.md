# Reusable feature gates for Angular and React

This document defines an implementation approach for a reusable feature gate library backed by Harness. It supports Angular applications that currently initialize through `forRoot()`, React applications, and trunk based development with independent SIT, UAT, and PROD release decisions.

Build a framework independent TypeScript core, a Harness adapter, and small Angular and React adapters. Gate features at routes, feature containers, and business operation boundaries. Application code inside a gated feature should ordinarily have no flag checks.

The library is now implemented in packages/. The root README documents the executable API and supported versions. This document preserves the broader implementation rationale; advanced retention and server rendering policies remain future extensions. Proposed API examples below describe the design rather than replace the package declarations. The package names and new helper APIs below are proposed. Before coding, confirm supported Angular and React versions, the installed Harness SDK and product family, the React router, and whether applications use server rendering or microfrontends. Harness Feature Flags and Harness Feature Management and Experimentation have different SDK contracts; use the adapter for the product actually installed.

## Goals and boundaries

The library must centralize SDK lifecycle, typed evaluation, fallback behavior, subscriptions, and diagnostics. Framework adapters must share the same decision semantics while integrating with their own rendering and lifecycle systems. Consumers must be able to substitute an in memory provider in tests without loading Harness.

A feature gate cannot discover all code belonging to a business feature. Each application must declare its entry points. A route and a navigation entry may both need a declaration, but should reference one feature identifier and decision policy. This is intentional reuse rather than repeated implementation.

Start with boolean release flags. Keep user authorization, subscription entitlements, operational configuration, and experiments as separate concepts. If a product requires a composite capability such as release enabled AND user authorized, put that composition in a named application capability service. Do not silently mix permissions into the generic feature SDK.

Client gates do not secure APIs or make deployed browser code secret. Backend authorization is always independent. Where disabling a release must also stop backend work, evaluate its backend release policy using a server SDK or trusted server configuration.

## Package layout and dependencies

Use one repository with independently consumable packages or equivalent isolated entry points:

```text
packages/
  feature-core/
    src/definitions.ts
    src/decisions.ts
    src/provider.ts
    src/feature-client.ts
    src/diagnostics.ts
  feature-harness/
    src/harness-provider.ts
    src/sdk-session.ts
  feature-angular/
    src/providers.ts
    src/feature-gate.directive.ts
    src/feature-can-match.ts
    src/feature-state.service.ts
    src/feature-flags.module.ts
  feature-react/
    src/feature-provider.tsx
    src/use-feature.ts
    src/feature-gate.tsx
  feature-testing/
    src/memory-provider.ts
    src/provider-contract.ts
examples/
  angular-app/
  react-app/
```

Dependency direction is Angular/React adapters → core, and Harness adapter → core. Core imports no Angular, React, RxJS, or Harness runtime code. Framework packages declare their framework dependencies as peers. Keep Harness dependencies in its adapter. Publish explicit exports and declarations; do not require consumers to import internal paths. Mark packages side effect free only after confirming there is no initialization during module import.

The core owns a store and provider lifecycle. A single client instance belongs to one application root and one active evaluation identity. Applications own their domain feature catalog and entry point declarations. A shared domain catalog can serve several applications without putting all business flags in the generic library.

## Typed catalog

A small helper should preserve literal feature names and validate definitions:

```ts
export interface FeatureDefinition {
  readonly providerKey: string;
  readonly fallback: boolean;
  readonly owner: string;
  readonly kind: 'release' | 'operational';
  readonly removeBy?: string;
}

export type FeatureCatalog = Readonly<Record<string, FeatureDefinition>>;

export function defineFeatures<const C extends FeatureCatalog>(catalog: C): C {
  return catalog;
}

export const features = defineFeatures({
  advancedReports: {
    providerKey: 'reports.advanced',
    fallback: false,
    owner: 'reporting-team',
    kind: 'release',
    removeBy: 'YYYY-MM-DD', // Replace with a real review date.
  },
  checkoutV2: {
    providerKey: 'checkout.v2',
    fallback: false,
    owner: 'checkout-team',
    kind: 'release',
  },
});

export type FeatureName = keyof typeof features;
```

The const type parameter example assumes TypeScript 5 or later; adapt the helper for older supported versions. During client construction validate empty provider keys, duplicate provider keys unless aliases are explicitly supported, boolean fallback values, and malformed metadata. Freeze or defensively copy the catalog so later caller mutation cannot change policy unexpectedly.

Generic framework declarations can provide only string typing by themselves. For strict application typing, export an application hook wrapper for React and an application directive input typed to `FeatureName` for Angular, or generate those bindings from the catalog. Runtime validation remains required for route metadata and dynamically supplied names. Never cast an arbitrary string to `FeatureName` to bypass validation.

## Public core contract

Keep provider responsibilities and consumer responsibilities separate:

```ts
export interface EvaluationContext {
  readonly targetId: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface FeatureDecision {
  readonly enabled: boolean;
  readonly status: 'pending' | 'ready' | 'degraded';
  readonly source: 'provider' | 'cache' | 'fallback';
  readonly reason?: 'initializing' | 'timeout' | 'missing' |
    'invalid' | 'unavailable' | 'stale' | 'disposed';
  readonly revision: number;
  readonly contextRevision: number;
}

export type ProviderEvaluation =
  | { readonly kind: 'value'; readonly value: boolean;
      readonly source: 'provider' | 'cache' }
  | { readonly kind: 'unavailable';
      readonly reason: 'missing' | 'invalid' | 'unavailable' };

export interface ProviderSession {
  evaluate(key: string, fallback: boolean): ProviderEvaluation;
  subscribe(listener: () => void): () => void;
  close(): void | Promise<void>;
}

export interface FeatureProvider {
  connect(context: EvaluationContext,
          signal: AbortSignal): Promise<ProviderSession>;
}

export interface FeatureReader<K extends string> {
  getSnapshot(feature: K): FeatureDecision;
  subscribe(feature: K, listener: () => void): () => void;
  whenSettled(feature: K): Promise<FeatureDecision>;
}

export interface FeatureClient<K extends string> extends FeatureReader<K> {
  start(context: EvaluationContext): Promise<void>;
  setContext(context: EvaluationContext): Promise<void>;
  dispose(): Promise<void>;
}
```

This design defines `connect()` as resolving only after the provider can supply its initial evaluation results. The adapter normalizes its SDK readiness events to that contract. A later subscription notification means reevaluate affected decisions. Extend notifications with changed keys when the SDK can reliably identify them; otherwise reevaluate the registered catalog, not the network.

`getSnapshot()` is synchronous and reads local state. `whenSettled()` waits for the current identity to reach ready or degraded state; it never waits indefinitely because initialization has a configured deadline. Provider/network failure resolves into degraded decisions. Invalid setup is a programming/configuration error and should be reported distinctly. `whenSettled()` called after disposal rejects with a documented disposal error. A context transition rejects waiters from the previous context with a documented `ContextChangedError`; adapters can retry against the new context within their overall deadline.

For the same context, concurrent `start()` calls reuse the current startup promise. A different context goes through `setContext()`. Reject attempts to restart a disposed instance; create a new client for a new lifecycle. Expose a narrow reader through feature code and keep lifecycle methods in the application shell.

## Store implementation

Maintain one immutable decision object per feature. Return the exact same object from `getSnapshot()` until an externally visible field changes. Keep revisions stable on no-op reads and no-op provider notifications. Replace changed objects and notify their subscribers once after the complete update batch is committed.

Do not expose mutable SDK objects. Each feature subscriber sees only its own changes. Catch and report subscriber exceptions so one subscriber does not prevent notification of the others. Cleanup functions must be idempotent. Keep runtime state scoped to the client, with no module global target or mutable default client.

Validate provider results: accept only boolean values for this API, including explicit `false`. Do not use truthiness conversion or infer an error from a returned `false`. A remote off decision is ready; a local false fallback is degraded or pending. That distinction lets diagnostics detect outages without confusing them with deliberate release configuration.

Unknown runtime feature names produce a descriptive development error and an off decision plus a deduplicated diagnostic in production. Do not silently create unknown feature entries. Define how production mode is passed into core configuration instead of importing framework mode detection into core.

## Startup and identity changes

Use a configurable initial deadline, proposed as three seconds for browser applications. The deadline is a product policy to measure and adjust, not a Harness requirement. Initially expose pending decisions with each definition's fallback as the effective value. Gate boundaries render pending UI; they do not instantiate enabled content merely because fallback is true while pending.

On timeout, publish degraded fallback decisions and release route/startup waiters. Keep the same initialization attempt able to recover until it is superseded or disposed. Never start a second competing SDK initialization just because the first attempt timed out.

There is no deployment environment in EvaluationContext. For login, logout, tenant switching, or target attribute changes:

1. Increment `contextRevision` and publish pending fallback decisions immediately.
2. Reject settlement waiters from the previous context with `ContextChangedError`, so callers can discard them or retry; route adapters also compare the revision before allowing navigation.
3. Abort the previous connection attempt, remove listeners, and close its session before opening a replacement session.
4. Serialize transitions. A newer request supersedes an older request; the older request cannot publish results.
5. If the SDK does not support cancelling connection, check the revision after resolution and close any superseded session immediately.
6. Publish one batch for the current context when connection completes, or degraded fallbacks on failure/deadline.

When replacement connection cannot proceed until an earlier connection actually terminates, still release UI waiters at the deadline and report degraded state. Do not create overlapping clients to bypass that restriction. Add integration tests around the installed SDK's lifecycle behavior.

Never retain a previous user's or tenant's enabled decision during a context transition. Use the provider's documented identity update operation only if verified to invalidate and reevaluate correctly; otherwise perform a serialized session replacement. Redact targets and attributes in diagnostics.

## Fallback and disconnected operation

The implemented first release disables persistent caching and immediately uses catalog fallbacks on disconnection. Cached-value retention in this section is a future extension requiring dedicated verification, not current library behavior. Define policies in one place. A possible extended policy is:

| Condition | Effective value | Decision status |
| --- | --- | --- |
| Initializing or identity transition | Catalog fallback | pending |
| Valid evaluated false or true | Evaluated value | ready |
| Missing flag or invalid value | Catalog fallback | degraded |
| Startup failure or deadline | Catalog fallback | degraded |
| Connection lost after a valid decision | Same context's last accepted value for a bounded period | degraded |
| That bounded period expires | Catalog fallback | degraded |

If retaining last accepted values, start the freshness timer from the last verified synchronization, not from repeated reads. A proposed initial maximum is five minutes. It is configurable and should be disabled for flags requiring conservative disconnection behavior. Expiration must trigger publication even when the provider emits no events.

The SDK may use its own persistent cache. Do not relabel cached data as freshly verified provider data. If the installed SDK cannot distinguish cache provenance or freshness, document that limitation and do not advertise a stronger freshness guarantee. For strict flags, disable persistent cache where supported, or require a provider-confirmed decision before enabling. A remote kill switch cannot be guaranteed instantaneous for disconnected browsers; backend enforcement is needed for actions that must stop reliably.

The adapter maps verified readiness, cache, synchronization, update, failure, and shutdown events from the installed SDK. Include events used in both streaming and polling modes. It must not make a remote request for every `getSnapshot()` call. Use the SDK's evaluation method consistently; some SDKs also collect evaluation analytics, so do not discard that behavior without checking its contract.

## Angular integration

Expose `provideFeatures()` for standalone roots and retain `FeatureFlagsModule.forRoot()` for existing applications. Both invoke the same provider factory and initialize once at the root. Keep directive declarations/imports separate from SDK creation. Lazy routes importing UI helpers must not initialize additional clients.

Illustrative setup:

```ts
provideFeatures({
  catalog: features,
  provider: createHarnessProvider({ browserSdkKey }),
  initialContext: { targetId, attributes },
  initializationTimeoutMs: 3000,
});
```

Resolve target context and the runtime-injected browser SDK key from application configuration. Harness selects its configured deployment context from that key; the library has no environment field. If auth loads asynchronously, show pending feature boundaries until a stable anonymous or authenticated identity is available. Do not put server credentials in browser configuration.

Expose feature state as read-only Angular signals for supported modern Angular versions. If older Angular support is required, provide an Observable facade in the Angular package without imposing RxJS on core. Ensure external SDK events trigger rendering under the application's zone or zoneless setup. Reuse one subscription per feature where practical and release component subscriptions through Angular lifecycle cleanup.

### Route guard

Implement a shared `CanMatch` guard that reads a typed application route helper's feature metadata, waits for settlement, and checks that the context revision is still current. Return true when enabled. When disabled, return a `UrlTree` for a configured fallback or false to permit another matching route. Do not call imperative navigation inside the guard. Limit repeated retries during identity churn; return a safe fallback after the configured deadline.

```ts
{
  path: 'advanced-reports',
  data: { feature: 'advancedReports', disabledRedirect: '/reports' },
  canMatch: [featureCanMatch],
  loadComponent: () => import('./advanced-reports.component')
    .then(m => m.AdvancedReportsComponent),
}
```

A guard controls subsequent navigation. It does not evict an already active route when a flag changes. An application route shell may subscribe and navigate on disable, subject to unsaved work policy. Lazy loading also does not prove disabled code cannot be fetched: configure preloading separately if avoiding downloads matters.

### Structural directive

Provide a directive with enabled, disabled, and pending templates:

```html
<app-advanced-report
  *featureGate="'advancedReports'; else: unavailable; pending: loading">
</app-advanced-report>

<ng-template #loading><app-loading /></ng-template>
<ng-template #unavailable><p>Reports are unavailable.</p></ng-template>
```

Inputs are `featureGate`, `featureGateElse`, and `featureGatePending`. Only create the selected embedded view. Do not use CSS hiding or ordinary projected content as a substitute, since hidden/projected children can still instantiate and run effects. On changed input, stop tracking the old feature signal and read the new feature. The implemented shared signal service retains one subscription per accessed feature until root destruction; directive effects and views are released on directive destruction. Do not recreate an unchanged view when only diagnostic metadata changes.

## React integration

Provide context containing the already constructed core client. The provider owns lifecycle only when explicitly configured to own the instance; externally owned clients must not be disposed by a leaf provider. Choose one ownership mode per application root.

Build `useFeature()` using `useSyncExternalStore()` with stable subscription and snapshot functions. The core's immutable snapshots satisfy React's external store contract. Supply a deterministic server snapshot when server rendering is supported.

Illustrative boundary:

```tsx
<FeatureGate
  feature="advancedReports"
  pending={<Loading />}
  fallback={<ReportsUnavailable />}
>
  <AdvancedReport />
</FeatureGate>
```

The component calls the hook unconditionally. It returns pending content for pending decisions, children when enabled, and fallback otherwise. Creating a React element does not mount its component, but parent-level hooks and expressions still run. Put feature-owned effects inside the gated subtree, not in the parent or a boundary's prop expressions.

Keep provider creation out of rendering. Verify mount/cleanup behavior under development Strict Mode; cleanup must not permanently dispose a client that the following effect setup expects to reuse. Use a lifecycle controller with balanced acquire/release and deferred, cancellable final disposal, or establish ownership outside React's effect lifecycle.

Add router helpers for the selected React router. Do not invent a universal React guard API: loader-based routers and component routers have different loading and redirect behavior. Both must use the same core settlement and identity semantics.

## Navigation and feature declarations

For route-based features, define application-owned metadata once:

```ts
const reportEntry = {
  id: 'advancedReports',
  feature: 'advancedReports',
  path: '/advanced-reports',
  label: 'Advanced reports',
} as const;
```

Use that entry when declaring a route and generating navigation. Filter navigation reactively through the feature reader. Do not filter once during bootstrap and let it become stale. Keep actual route component loaders in each framework's application; the generic library should not import business components or dynamically construct an entire application router.

If a feature also appears in an existing dashboard, one additional boundary declaration is appropriate. A shared feature identifier unifies these entry points without forcing unrelated components into one giant registry.

## Business operations and strategies

Use a facade when a flag selects old versus new behavior:

```ts
interface Checkout {
  submit(order: Order): Promise<Receipt>;
}

class CheckoutFacade {
  constructor(
    private readonly flags: FeatureReader<'checkoutV2'>,
    private readonly legacy: Checkout,
    private readonly next: Checkout,
  ) {}

  async submit(order: Order): Promise<Receipt> {
    const decision = await this.flags.whenSettled('checkoutV2');
    const strategy = decision.enabled ? this.next : this.legacy;
    return strategy.submit(order);
  }
}
```

For one isolated operation this illustrates the pattern, but identity-sensitive production code must validate the current context before executing. For a multi-step flow, select a strategy once when the flow starts and retain it through completion. Preserve the selected variant in the application flow state or a server-owned workflow identifier when reloads must resume consistently.

A live disable can prevent new flows while existing flows finish, or abort them safely. That policy belongs to the business workflow. Do not automatically unmount forms with unsaved work whenever a subscription changes. A backend must recheck authorization and any current operational restriction when accepting an action.

An Angular injection factory chooses once when the dependency is instantiated. Use a facade for per-operation selection; use construction-time selection only for intentional session-fixed behavior. Prevent inactive implementations from starting effects in constructors. Where expensive resources exist, instantiate the chosen implementation lazily.

Avoid decorators that suppress arbitrary method execution. If a legacy decorator stays during migration, document disabled return behavior, async behavior, identity selection, and disposal. Deprecate it in favor of explicit boundaries rather than pretending it can transparently gate every class and variable.

## Server rendering and microfrontends

Only implement these extensions when required by an application, but keep the initial core free of global state so they remain possible.

For server rendering, create a client per request with trusted server configuration and verified identity. Serialize only an allowlisted evaluated snapshot. Hydrate the browser with the same context and initial snapshot so its first render matches the server, then subscribe to browser updates. Do not serialize credentials, targeting rules, or private attributes. Never share one server user's client with another request. Responses containing targeted decisions must use appropriate private caching; prevent a CDN from serving one user's rendered variant to another.

For microfrontends, let the shell own SDK initialization and expose a read-only client to participating frontends. Agree on identity, catalog versions, environment, and dependency sharing. If genuinely separate browser applications need separate SDK clients, verify the installed SDK's isolation and cache behavior before sharing a page or storage namespace. Do not solve this by silently creating one SDK instance in every widget.

## Environment configuration and release lifecycle

Use the same feature identifiers across deployments. OpenShift injects the browser SDK key at runtime, and Harness selects its configuration from that key. Application builds do not select an environment and the library does not accept an environment parameter. Verify the runtime key mapping in deployment checks. Server SDK secrets remain server-only.

Local false fallback, remote off state, and a rollout targeting rule are separate settings. Validate each explicitly. A cached previously enabled value may still be effective under the chosen disconnection policy.

Use this workflow for each temporary release flag:

1. Define owner, purpose, review/removal date, fallback, and disabled behavior.
2. Create the remote flag off in SIT, UAT, and PROD before deploying its first reference.
3. Merge short-lived branches containing small safe increments behind the gate. Shared initialization, contracts, and migrations must remain backward compatible with the off path.
4. Exercise the increment with an in memory provider and selected SIT targets.
5. Enable controlled UAT exposure after the complete feature is ready.
6. Roll out to PROD using recorded environment changes and production monitoring.
7. After stability, remove the old path and temporary gate from application code.
8. Retain remote configuration while supported deployed versions still reference it, then delete the flag.

A feature may need several safe merges before completion. Do not wait for an entire large feature to finish merely to keep one branch. Browser releases may remain active in old tabs, so removal must account for the deployed-version retention policy.

Operational flags with continuing value have a different retirement policy. Do not accumulate temporary release flags as permanent product configuration.

## Tests and diagnostics

Use an in memory provider with explicit readiness, failures, notifications, and context transitions. Avoid static mocks that only return true: they miss the most consequential behavior.

| Layer | Required proof |
| --- | --- |
| Core | False is valid; missing/invalid use fallback; stable snapshots; bounded settlement; no-op updates; expiry; listener isolation; disposal |
| Identity | A slow previous target cannot enable the next target; overlapping transitions serialize; superseded sessions close |
| Provider contract | Every adapter meets readiness, change notification, boolean validation, abort, and cleanup semantics |
| Harness integration | Installed SDK emits the events mapped by the adapter in streaming and polling; cache behavior and reconnect match claims |
| Angular | Off/pending child never instantiates; on mounts once; input change unsubscribes; rendering updates; guard redirect and direct URL behavior |
| React | No disabled subtree effects; stable external store snapshots; unsubscribe; Strict Mode ownership; hydration if supported |
| Business flow | Legacy path when off; new path when on; selected strategy does not change midway; identity changes handled safely |
| Release | Off path and on path work in each consuming app; correct environment mapping; retirement compatibility |

Do not test every combination of unrelated flags. Test each flag's two paths and declared interacting combinations. If two flags cannot operate independently, document that dependency or combine the release boundary rather than leaving implicit coupling.

Inject a diagnostics sink into core. Report startup duration, missing identifiers, invalid types, fallback transitions, connection degradation, and cleanup failures. Include application/version/environment and feature key, but redact identities and sensitive attributes. Deduplicate repeated reports and emit transition diagnostics rather than a log for each read.

Distinguish flag evaluation from feature exposure. A menu read is not proof a user saw or exercised the feature. If analytics need exposures, record them at the actual boundary according to the installed SDK's analytics contract. Live environments and real targeting should have dedicated integration verification; local unit tests alone do not prove them.

## Implementation sequence and completion criteria

### Phase one core and testing

Implement typed definitions, immutable store, bounded startup, serialized context transitions, fallback policy, subscriptions, and disposal. Build the in memory provider and shared provider contract suite. Complete this phase when the concurrency and failure tests pass without framework dependencies.

### Phase two Harness adapter

Pin the chosen SDK version, map lifecycle events, normalize evaluations, implement cleanup, and verify context replacement. Test readiness, timeout recovery, cached initialization, remote on/off, streaming/polling updates, disconnect, and reconnect against a dedicated nonproduction configuration. Record any provenance/freshness limitations rather than hiding them.

### Phase three Angular pilot

Add root initialization and the existing `forRoot()` compatibility wrapper. Add signals or Observable bindings, guard, structural directive, and typed application wrappers. Pilot one new route and one embedded feature. Completion requires no checks in their child components, direct URL handling, no disabled child effects, and no duplicate SDK startup in lazy routes.

### Phase four React pilot

Add context, external store hook, boundary, and router integration. Run the same decisions against a React example and verify Strict Mode cleanup. Implement server rendering only if required, with request isolation and hydration tests.

### Phase five migration and release

Replace legacy decorators boundary by boundary. Enforce imports so application components cannot access Harness directly; restrict raw flag keys to domain catalogs and adapters. Publish package versions together initially, document peer version ranges, and exercise installation in real Angular and React consumers. Verify package exports, declaration output, tree shaking, and dependency ownership.

Completion means both frameworks share evaluation semantics, startup cannot hang, identity changes cannot leak old decisions, gates do not instantiate disabled content, fallback behavior is visible, and owners can remove a released flag without restructuring the feature.

## Design patterns used

| Pattern or principle | Concrete responsibility |
| --- | --- |
| Adapter | Translate Harness and framework contracts into the core contract |
| Dependency inversion | Feature code consumes a reader, not a vendor SDK |
| Observer or external store | Publish reactive decisions without framework dependencies |
| Facade | Hide SDK lifecycle and old/new business implementation selection |
| Strategy | Choose between compatible implementations at an explicit operation boundary |
| Single responsibility | Keep evaluation, rendering, routing, and business rules in their own layers |
| Interface segregation | Give ordinary consumers read access and the shell lifecycle control |
| DRY | Define feature identity, fallback, and evaluation mechanics once |

Do not introduce a generic expression language, dynamic component registry, dependency graph, or multivariate experiment API into the first release. Add a separate typed variant contract later if a concrete consumer requires one; do not stretch a boolean gate into an untyped configuration service.

## Reference documentation

The architecture and timeout/retention policies in this document are proposed design choices. These primary sources support the framework mechanisms and provider behaviors; confirm the installed versions before implementation.

- [Angular structural directives](https://angular.dev/guide/directives/structural-directives) explains conditional embedded view creation.
- [Angular route guards](https://angular.dev/guide/routing/route-guards) explains CanMatch fallthrough, redirect return values, and the need for server authorization.
- [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore) specifies subscription, snapshot stability, and server snapshot behavior.
- [Harness Feature Flags JavaScript SDK](https://github.com/harness/ff-javascript-client-sdk) provides SDK evaluation, events, and lifecycle usage.
- [Harness Feature Flags FAQs](https://developer.harness.io/docs/feature-flags/harness-feature-flag-faqs/) describes environment independence and cached/default behavior. Check the installed SDK directly where product documentation is ambiguous.
