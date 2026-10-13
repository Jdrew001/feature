export interface FeatureDefinition {
  readonly providerKey: string;
  readonly fallback: boolean;
  readonly owner?: string;
  readonly removeBy?: string;
}
export type FeatureCatalog = Readonly<Record<string, FeatureDefinition>>;
export function defineFeatures<C extends FeatureCatalog>(catalog: C): C { return catalog; }
export interface EvaluationContext {
  readonly targetId: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}
export interface FeatureDecision {
  readonly enabled: boolean;
  readonly status: 'pending' | 'ready' | 'degraded';
  readonly source: 'provider' | 'cache' | 'fallback';
  readonly reason?: 'initializing' | 'timeout' | 'missing' | 'invalid' | 'unavailable' | 'disposed' | 'unknown';
  readonly revision: number;
  readonly contextRevision: number;
}
export type ProviderEvaluation =
  | { readonly kind: 'value'; readonly value: boolean; readonly source: 'provider' | 'cache' }
  | { readonly kind: 'unavailable'; readonly reason: 'missing' | 'invalid' | 'unavailable' };
export interface ProviderSession {
  evaluate(key: string, fallback: boolean): ProviderEvaluation;
  subscribe(listener: () => void): () => void;
  close(): void | Promise<void>;
}
export interface FeatureProvider {
  connect(context: EvaluationContext, signal: AbortSignal): Promise<ProviderSession>;
}
export interface FeatureReader<K extends string = string> {
  getSnapshot(feature: K): FeatureDecision;
  subscribe(feature: K, listener: () => void): () => void;
  whenSettled(feature: K): Promise<FeatureDecision>;
}
export interface Diagnostic {
  readonly code: 'fallback' | 'unknown' | 'listener-error' | 'cleanup-error';
  readonly feature?: string;
  readonly reason?: FeatureDecision['reason'];
}
export interface ClientOptions<C extends FeatureCatalog> {
  readonly catalog: C;
  readonly provider: FeatureProvider;
  readonly initializationTimeoutMs?: number;
  readonly strictUnknownFeatures?: boolean;
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
}
export class ContextChangedError extends Error {
  constructor() { super('Feature evaluation context changed'); this.name = 'ContextChangedError'; }
}
export class DisposedError extends Error {
  constructor() { super('Feature client is disposed'); this.name = 'DisposedError'; }
}

type DecisionValue = Omit<FeatureDecision, 'revision' | 'contextRevision'>;
type Waiter = { feature: string; resolve: (d: FeatureDecision) => void; reject: (e: Error) => void };
function normalizeContext(context: EvaluationContext): EvaluationContext {
  if (!context.targetId?.trim()) throw new Error('targetId must be non-empty');
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(context.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('Target attributes must contain finite primitive values');
    }
    Object.defineProperty(attributes, key, { value, enumerable: true });
  }
  return Object.freeze({ targetId: context.targetId, attributes: Object.freeze(attributes) });
}

/** Own one instance in the application shell. Reads and subscriptions never issue network requests. */
export class FeatureClient<C extends FeatureCatalog> implements FeatureReader<Extract<keyof C, string>> {
  readonly catalog: C;
  private readonly firstFeature: Extract<keyof C, string>;
  private readonly states = new Map<string, FeatureDecision>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly waiters = new Set<Waiter>();
  private readonly timeoutMs: number;
  private contextKey?: string;
  private context: EvaluationContext | undefined;
  private generation = 0;
  private revision = 0;
  private controller?: AbortController;
  private timer: (ReturnType<typeof setTimeout>) | undefined;
  private session: (ProviderSession) | undefined;
  private unsubscribe: (() => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private startup?: Promise<void>;
  private disposed = false;
  private disposal?: Promise<void>;
  private readonly unknowns = new Map<string, FeatureDecision>();

  constructor(private readonly options: ClientOptions<C>) {
    this.timeoutMs = options.initializationTimeoutMs ?? 3000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('initializationTimeoutMs must be positive');
    const catalog: Record<string, FeatureDefinition> = {};
    const keys = new Set<string>();
    for (const [name, definition] of Object.entries(options.catalog)) {
      if (!name || !definition.providerKey?.trim() || typeof definition.fallback !== 'boolean') throw new Error('Invalid feature definition');
      if (keys.has(definition.providerKey)) throw new Error(`Duplicate provider key: ${definition.providerKey}`);
      keys.add(definition.providerKey);
      Object.defineProperty(catalog, name, { value: Object.freeze({ ...definition }), enumerable: true });
      this.states.set(name, Object.freeze({ enabled: definition.fallback, status: 'pending', source: 'fallback', reason: 'initializing', revision: 0, contextRevision: 0 }));
    }
    const [firstFeature] = Object.keys(catalog);
    if (firstFeature === undefined) throw new Error('At least one feature is required');
    this.firstFeature = firstFeature as Extract<keyof C, string>;
    this.catalog = Object.freeze(catalog) as C;
  }

  getSnapshot(feature: Extract<keyof C, string>): FeatureDecision {
    const state = this.states.get(feature);
    if (state) return state;
    if (this.options.strictUnknownFeatures !== false) throw new Error(`Unknown feature: ${feature}`);
    let unknown = this.unknowns.get(feature);
    if (!unknown) {
      unknown = Object.freeze({ enabled: false, status: 'degraded', source: 'fallback', reason: 'unknown', revision: 0, contextRevision: 0 });
      this.unknowns.set(feature, unknown);
      this.diagnostic({ code: 'unknown', feature });
    }
    return unknown;
  }

  subscribe(feature: Extract<keyof C, string>, listener: () => void): () => void {
    this.getSnapshot(feature);
    if (this.disposed) return () => undefined;
    let listeners = this.listeners.get(feature);
    if (!listeners) { listeners = new Set(); this.listeners.set(feature, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(feature); };
  }

  whenSettled(feature: Extract<keyof C, string>): Promise<FeatureDecision> {
    if (this.disposed) return Promise.reject(new DisposedError());
    const state = this.getSnapshot(feature);
    if (state.status === 'pending' && !this.contextKey) return Promise.reject(new Error('Start the client before awaiting decisions'));
    if (state.status !== 'pending') return Promise.resolve(state);
    return new Promise((resolve, reject) => { this.waiters.add({ feature, resolve, reject }); });
  }

  start(context: EvaluationContext): Promise<void> {
    if (this.disposed) return Promise.reject(new DisposedError());
    const normalized = normalizeContext(context);
    if (JSON.stringify(normalized) === this.contextKey && this.startup) return this.startup;
    return this.transition(normalized);
  }

  setContext(context: EvaluationContext): Promise<void> { return this.start(context); }

  retry(): Promise<void> {
    if (this.disposed) return Promise.reject(new DisposedError());
    if (!this.context) throw new Error('Start the client before retrying');
    return this.transition(this.context);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.generation++;
    this.controller?.abort();
    this.clearTimer();
    this.rejectWaiters(new DisposedError());
    this.fallback('disposed');
    this.listeners.clear();
    this.disposal = this.queue.then(() => this.closeSession());
    return this.disposal;
  }

  private transition(context: EvaluationContext): Promise<void> {
    const generation = ++this.generation;
    this.contextKey = JSON.stringify(context);
    this.context = context;
    this.controller?.abort();
    this.clearTimer();
    this.rejectWaiters(new ContextChangedError());
    this.publish(Object.fromEntries(Object.entries(this.catalog).map(([key, def]) => [key, { enabled: def.fallback, status: 'pending', source: 'fallback', reason: 'initializing' }])) as Record<string, DecisionValue>);
    const controller = new AbortController();
    this.controller = controller;
    this.timer = setTimeout(() => {
      if (generation === this.generation && !this.disposed) this.fallback('timeout');
    }, this.timeoutMs);
    const startup = this.whenSettled(this.firstFeature).then(() => undefined);
    // Mark the internal promise handled even when callers choose not to await start().
    startup.catch(() => undefined);
    this.startup = startup;
    this.queue = this.queue.then(async () => {
      await this.closeSession();
      if (controller.signal.aborted || this.disposed) return;
      try {
        const session = await this.connect(context, controller.signal);
        if (!session) return;
        if (generation !== this.generation || this.disposed) { await this.close(session); return; }
        this.session = session;
        this.unsubscribe = session.subscribe(() => {
          if (generation === this.generation && !this.disposed) this.refresh();
        });
        this.clearTimer();
        this.refresh();
      } catch {
        if (generation === this.generation && !this.disposed) { this.clearTimer(); this.fallback('unavailable'); }
      }
    });
    return startup;
  }

  private connect(context: EvaluationContext, signal: AbortSignal): Promise<ProviderSession | undefined> {
    // Providers must close on abort. Also release the queue if a provider ignores cancellation,
    // and close any session it returns later without ever publishing it.
    return new Promise((resolve, reject) => {
      let finished = false;
      const resolveConnection = (session?: ProviderSession) => { finished = true; resolve(session); };
      const abort = () => { if (!finished) resolveConnection(); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => signal.aborted ? undefined : this.options.provider.connect(context, signal)).then(session => {
        signal.removeEventListener('abort', abort);
        if (finished || signal.aborted) { if (session) this.close(session); return; }
        resolveConnection(session);
      }, error => {
        signal.removeEventListener('abort', abort);
        if (!finished) { finished = true; reject(error); }
      });
      if (signal.aborted) abort();
    });
  }

  private refresh(): void {
    const session = this.session;
    if (!session) { this.fallback('unavailable'); return; }
    const next: Record<string, DecisionValue> = Object.create(null) as Record<string, DecisionValue>;
    for (const [key, def] of Object.entries(this.catalog)) {
      let evaluation: ProviderEvaluation;
      try { evaluation = session.evaluate(def.providerKey, def.fallback); }
      catch { evaluation = { kind: 'unavailable', reason: 'unavailable' }; }
      next[key] = evaluation.kind === 'value' && typeof evaluation.value === 'boolean'
        ? { enabled: evaluation.value, status: evaluation.source === 'cache' ? 'degraded' : 'ready', source: evaluation.source }
        : { enabled: def.fallback, status: 'degraded', source: 'fallback', reason: evaluation.kind === 'unavailable' ? evaluation.reason : 'invalid' };
    }
    this.publish(next);
  }

  private fallback(reason: FeatureDecision['reason']): void {
    this.publish(Object.fromEntries(Object.entries(this.catalog).map(([key, def]) => [key, { enabled: def.fallback, status: 'degraded', source: 'fallback', ...(reason ? { reason } : {}) }])) as Record<string, DecisionValue>);
  }

  private publish(values: Record<string, DecisionValue>): void {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      const previous = this.requireRegisteredState(key);
      if (previous.contextRevision === this.generation && previous.enabled === value.enabled && previous.status === value.status && previous.source === value.source && previous.reason === value.reason) continue;
      this.states.set(key, Object.freeze({ ...value, revision: ++this.revision, contextRevision: this.generation }));
      changed.push(key);
    }
    for (const waiter of [...this.waiters]) {
      const state = this.requireRegisteredState(waiter.feature);
      if (state.status !== 'pending') { this.waiters.delete(waiter); waiter.resolve(state); }
    }
    for (const key of changed) {
      const state = this.requireRegisteredState(key);
      if (state.status === 'degraded' && state.source === 'fallback') this.diagnostic({ code: 'fallback', feature: key, ...(state.reason ? { reason: state.reason } : {}) });
      for (const listener of [...(this.listeners.get(key) ?? [])]) {
        try { listener(); } catch { this.diagnostic({ code: 'listener-error', feature: key }); }
      }
    }
  }

  private requireRegisteredState(feature: string): FeatureDecision {
    const state = this.states.get(feature);
    if (!state) throw new Error(`Feature state is not registered: ${feature}`);
    return state;
  }

  private rejectWaiters(error: Error): void { for (const waiter of this.waiters) waiter.reject(error); this.waiters.clear(); }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private async closeSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    try { this.unsubscribe?.(); } catch { this.diagnostic({ code: 'cleanup-error' }); }
    this.unsubscribe = undefined;
    if (session) await this.close(session);
  }
  private async close(session: ProviderSession): Promise<void> {
    try { await session.close(); } catch { this.diagnostic({ code: 'cleanup-error' }); }
  }
  private diagnostic(diagnostic: Diagnostic): void { try { this.options.onDiagnostic?.(diagnostic); } catch { /* Diagnostics must not break release decisions. */ } }
}

export function createFeatureClient<C extends FeatureCatalog>(options: ClientOptions<C>): FeatureClient<C> { return new FeatureClient(options); }
