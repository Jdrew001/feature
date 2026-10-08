import { Directive, DestroyRef, Injectable, InjectionToken, NgModule, NgZone, TemplateRef, ViewContainerRef, effect, inject, signal, Input, provideAppInitializer, makeEnvironmentProviders } from '@angular/core';
import type { EnvironmentProviders, ModuleWithProviders, Signal, WritableSignal } from '@angular/core';
import { Router } from '@angular/router';
import type { CanMatchFn, Route } from '@angular/router';
import { createFeatureClient, ContextChangedError } from '@feature-gates/core';
import type { ClientOptions, EvaluationContext, FeatureCatalog, FeatureClient, FeatureDecision, FeatureReader } from '@feature-gates/core';

export const FEATURE_CLIENT = new InjectionToken<FeatureClient<FeatureCatalog>>('FEATURE_CLIENT');
export interface AngularFeatureOptions<C extends FeatureCatalog> extends ClientOptions<C> { initialContext: EvaluationContext; }

export function provideFeatures<C extends FeatureCatalog>(options: AngularFeatureOptions<C>): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: FEATURE_CLIENT,
      useFactory: () => {
        const client = createFeatureClient(options);
        inject(DestroyRef).onDestroy(() => { void client.dispose(); });
        return client;
      },
    },
    provideAppInitializer(() => inject(FEATURE_CLIENT).start(options.initialContext).catch(error => {
      if (!(error instanceof ContextChangedError)) throw error;
    })),
  ]);
}

@Injectable({ providedIn: 'root' })
export class FeatureState {
  private readonly reader = inject(FEATURE_CLIENT);
  private readonly zone = inject(NgZone);
  private readonly states = new Map<string, Signal<FeatureDecision>>();
  private readonly cleanups: (() => void)[] = [];
  constructor() { inject(DestroyRef).onDestroy(() => { this.cleanups.forEach(cleanup => cleanup()); }); }
  decision(feature: string): Signal<FeatureDecision> {
    let state = this.states.get(feature);
    if (!state) {
      const writable = signal(this.reader.getSnapshot(feature));
      this.cleanups.push(this.reader.subscribe(feature, () => this.zone.run(() => writable.set(this.reader.getSnapshot(feature)))));
      state = writable.asReadonly();
      this.states.set(feature, state);
    }
    return state;
  }
}

@Directive({ selector: '[featureGate]', standalone: true })
export class FeatureGateDirective {
  private readonly feature = signal<string | undefined>(undefined);
  private readonly disabled = signal<TemplateRef<unknown> | undefined>(undefined);
  private readonly pending = signal<TemplateRef<unknown> | undefined>(undefined);
  private readonly template = inject(TemplateRef<unknown>);
  private readonly container = inject(ViewContainerRef);
  private readonly state = inject(FeatureState);
  private active: TemplateRef<unknown> | undefined;

  @Input({ required: true }) set featureGate(feature: string) { this.feature.set(feature); }
  @Input() set featureGateElse(template: TemplateRef<unknown> | undefined) { this.disabled.set(template); }
  @Input() set featureGatePending(template: TemplateRef<unknown> | undefined) { this.pending.set(template); }

  constructor() {
    effect(() => {
      const feature = this.feature();
      if (feature === undefined) return;
      const decision = this.state.decision(feature)();
      const selected = decision.status === 'pending' ? this.pending() : decision.enabled ? this.template : this.disabled();
      if (selected === this.active) return;
      this.container.clear();
      this.active = selected;
      if (selected) this.container.createEmbeddedView(selected);
    });
  }
}

/** Reads local decisions, waits a bounded time, and unsubscribes on every completion path. */
export function waitForFeature(reader: FeatureReader, feature: string, timeoutMs: number): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Route timeout must be positive');
  const initial = reader.getSnapshot(feature);
  if (initial.status !== 'pending') return Promise.resolve(initial.enabled);
  return new Promise(resolve => {
    let unsubscribe = () => {};
    let complete = false;
    const finish = (enabled: boolean) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(enabled);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = reader.subscribe(feature, () => {
      const decision = reader.getSnapshot(feature);
      if (decision.status !== 'pending') finish(decision.enabled);
    });
    const current = reader.getSnapshot(feature);
    if (current.status !== 'pending') finish(current.enabled);
  });
}

export const featureCanMatch: CanMatchFn = route => {
  const client = inject(FEATURE_CLIENT);
  const router = inject(Router);
  const feature = route.data?.['feature'];
  const redirect = route.data?.['disabledRedirect'];
  const timeout = route.data?.['featureTimeoutMs'] ?? 3000;
  if (typeof feature !== 'string') throw new Error('Feature route requires feature metadata');
  if (redirect !== undefined && typeof redirect !== 'string') throw new Error('disabledRedirect must be a URL string');
  return waitForFeature(client, feature, timeout).then(enabled => {
    // Recheck after the promise boundary so an intervening identity switch cannot grant access.
    const current = client.getSnapshot(feature);
    return enabled && current.status !== 'pending' && current.enabled ? true : redirect ? router.parseUrl(redirect) : false;
  });
};

/** Bind to the domain feature union once; retain app-owned loaders and route declarations. */
export function createFeatureRoute<K extends string>() {
  return (feature: K, route: Route, disabledRedirect?: string): Route => ({
    ...route,
    data: { ...route.data, feature, ...(disabledRedirect ? { disabledRedirect } : {}) },
    canMatch: [...(route.canMatch ?? []), featureCanMatch],
  });
}

@NgModule({ imports: [FeatureGateDirective], exports: [FeatureGateDirective] })
export class FeatureFlagsModule {
  static forRoot<C extends FeatureCatalog>(options: AngularFeatureOptions<C>): ModuleWithProviders<FeatureFlagsModule> {
    return { ngModule: FeatureFlagsModule, providers: [provideFeatures(options)] };
  }
}
