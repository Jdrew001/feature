import { activate, ensureInitialized, fetchAndActivate, getAll, isSupported, onConfigUpdate, setCustomSignals } from 'firebase/remote-config';
import type { CustomSignals, RemoteConfig, Value } from 'firebase/remote-config';
import type { EvaluationContext, FeatureProvider, ProviderEvaluation, ProviderSession } from '@feature-gates/core';

export interface FirebaseRemoteConfigSdk {
  activate: typeof activate;
  ensureInitialized: typeof ensureInitialized;
  fetchAndActivate: typeof fetchAndActivate;
  getAll: typeof getAll;
  isSupported: typeof isSupported;
  onConfigUpdate: typeof onConfigUpdate;
  setCustomSignals: typeof setCustomSignals;
}

export interface FirebaseProviderOptions {
  /** An application-owned Remote Config instance, dedicated to this provider. */
  readonly remoteConfig: RemoteConfig;
  /** Listen for published template updates. Defaults to true. */
  readonly realtime?: boolean;
  /** Return every managed signal on every context, using null to unset a signal. */
  readonly customSignals?: (context: EvaluationContext) => CustomSignals;
  /** SDK boundary for deterministic tests. */
  readonly sdk?: FirebaseRemoteConfigSdk;
}

const firebaseSdk: FirebaseRemoteConfigSdk = { activate, ensureInitialized, fetchAndActivate, getAll, isSupported, onConfigUpdate, setCustomSignals };
// Firebase fetch/activation mutates the shared instance. Finish old work before a
// replacement session reads it, and only publish that session's copied snapshot.
const operations = new WeakMap<RemoteConfig, Promise<void>>();

export function createFirebaseProvider(options: FirebaseProviderOptions): FeatureProvider {
  if (!options.remoteConfig) throw new Error('Firebase remoteConfig is required');
  const sdk = options.sdk ?? firebaseSdk;
  return {
    connect(context, signal) {
      if (signal.aborted) return Promise.reject(new Error('Connection aborted'));
      const session = new FirebaseSession(options, sdk, context);
      return new Promise((resolve, reject) => {
        const abort = () => { session.close(); reject(new Error('Connection aborted')); };
        session.onClose = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        session.open().then(() => resolve(session), error => { session.close(); reject(error); });
        if (signal.aborted) abort();
      });
    },
  };
}

class FirebaseSession implements ProviderSession {
  onClose: () => void = () => undefined;
  private readonly listeners = new Set<() => void>();
  private values = new Map<string, ProviderEvaluation>();
  private closed = false;
  private available = false;
  private unsubscribe: (() => void) | undefined;
  private updateRevision = 0;

  constructor(
    private readonly options: FirebaseProviderOptions,
    private readonly sdk: FirebaseRemoteConfigSdk,
    private readonly context: EvaluationContext,
  ) {}

  async open(): Promise<void> {
    if (!await this.sdk.isSupported()) throw new Error('Firebase Remote Config is unsupported in this browser');
    this.assertOpen();
    await this.enqueue(async () => {
      await this.sdk.ensureInitialized(this.options.remoteConfig);
      this.assertOpen();
      const before = this.options.remoteConfig.fetchTimeMillis;
      // A false result means the activated template was unchanged, not failure.
      await this.fetchForContext();
      if (this.closed) return;
      const source = before > 0 && before === this.options.remoteConfig.fetchTimeMillis ? 'cache' : 'provider';
      if (this.options.customSignals && source === 'cache') {
        throw new Error('Firebase targeted fetch reused a cached template');
      }
      this.readSnapshot(source);
    });
    this.assertOpen();
    this.listenForUpdates();
  }

  evaluate(key: string, _fallback: boolean): ProviderEvaluation {
    if (this.closed || !this.available) return { kind: 'unavailable', reason: 'unavailable' };
    return this.values.get(key) ?? { kind: 'unavailable', reason: 'missing' };
  }

  subscribe(listener: () => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    this.listeners.clear();
    this.values.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private listenForUpdates(): void {
    if (this.options.realtime === false) return;
    this.unsubscribe = this.sdk.onConfigUpdate(this.options.remoteConfig, {
      next: () => { this.applyUpdate(); },
      error: () => this.markUnavailable(),
      complete: () => this.markUnavailable(),
    });
  }

  private async fetchForContext(): Promise<void> {
    const remoteConfig = this.options.remoteConfig;
    if (!this.options.customSignals) {
      await this.sdk.fetchAndActivate(remoteConfig);
      return;
    }
    await this.sdk.setCustomSignals(remoteConfig, this.options.customSignals(this.context));
    this.assertOpen();
    // A cached template may have been evaluated for the previous user's signals.
    // Force a fetch for targeted sessions and restore application settings after it.
    const interval = remoteConfig.settings.minimumFetchIntervalMillis;
    remoteConfig.settings.minimumFetchIntervalMillis = 0;
    try {
      await this.sdk.fetchAndActivate(remoteConfig);
    } finally {
      remoteConfig.settings.minimumFetchIntervalMillis = interval;
    }
  }

  private async applyUpdate(): Promise<void> {
    const revision = ++this.updateRevision;
    try {
      await this.enqueue(async () => {
        await this.sdk.activate(this.options.remoteConfig);
        if (this.closed || revision !== this.updateRevision) return;
        this.readSnapshot('provider');
        this.notify();
      });
    } catch {
      if (revision === this.updateRevision) this.markUnavailable();
    }
  }

  private readSnapshot(source: 'provider' | 'cache'): void {
    this.values = new Map(Object.entries(this.sdk.getAll(this.options.remoteConfig))
      .map(([key, value]) => [key, evaluateValue(value, source)]));
    this.available = true;
  }

  private markUnavailable(): void {
    if (this.closed) return;
    this.updateRevision++;
    this.available = false;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* One subscriber must not prevent another from updating. */ }
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const remoteConfig = this.options.remoteConfig;
    const pending = (operations.get(remoteConfig) ?? Promise.resolve()).then(async () => {
      if (!this.closed) await operation();
    });
    operations.set(remoteConfig, pending.catch(() => undefined));
    return pending;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Connection aborted');
  }
}

function evaluateValue(value: Value, source: 'provider' | 'cache'): ProviderEvaluation {
  if (value.getSource() !== 'remote') return { kind: 'unavailable', reason: 'missing' };
  const raw = value.asString().trim().toLowerCase();
  if (raw !== 'true' && raw !== 'false') return { kind: 'unavailable', reason: 'invalid' };
  return { kind: 'value', value: raw === 'true', source };
}
