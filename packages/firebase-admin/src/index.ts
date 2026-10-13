import type { EvaluationContext, FeatureProvider, ProviderEvaluation, ProviderSession } from '@feature-gates/core';

export type FirebaseAdminEvaluationContext = Readonly<Record<string, string | number>>;

export interface FirebaseAdminValue {
  getSource(): string;
  asString(): string;
}

/** Firebase Admin ServerTemplate satisfies this interface without a browser SDK import. */
export interface FirebaseAdminTemplate {
  evaluate(context?: FirebaseAdminEvaluationContext): {
    getAll(): Record<string, FirebaseAdminValue>;
  };
}

export interface FirebaseAdminProviderOptions {
  /** The application owns template caching, refresh policy, credentials, and Admin app lifetime. */
  loadTemplate(): Promise<FirebaseAdminTemplate>;
  context?(context: EvaluationContext): FirebaseAdminEvaluationContext;
}

export function createFirebaseAdminProvider(options: FirebaseAdminProviderOptions): FeatureProvider {
  return {
    async connect(context, signal) {
      assertActive(signal);
      const signals = snapshotSignals(options.context?.(context) ?? { randomizationId: context.targetId });
      const template = await waitForTemplate(options.loadTemplate(), signal);
      assertActive(signal);
      const session = new FirebaseAdminSession(template.evaluate(signals).getAll());
      const abort = () => session.close();
      session.onClose = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        session.close();
        assertActive(signal);
      }
      return session;
    },
  };
}

function snapshotSignals(signals: FirebaseAdminEvaluationContext): FirebaseAdminEvaluationContext {
  const snapshot: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(signals)) {
    if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('Firebase Admin signals must contain strings or finite numbers');
    }
    Object.defineProperty(snapshot, key, { value, enumerable: true });
  }
  return Object.freeze(snapshot);
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Connection aborted');
}

function waitForTemplate(load: Promise<FirebaseAdminTemplate>, signal: AbortSignal): Promise<FirebaseAdminTemplate> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('Connection aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    load.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

class FirebaseAdminSession implements ProviderSession {
  onClose: () => void = () => undefined;
  private readonly values = new Map<string, ProviderEvaluation>();
  private closed = false;

  constructor(values: Record<string, FirebaseAdminValue>) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, evaluateBoolean(value));
    }
  }

  evaluate(key: string, _fallback: boolean): ProviderEvaluation {
    if (this.closed) return { kind: 'unavailable', reason: 'unavailable' };
    return this.values.get(key) ?? { kind: 'unavailable', reason: 'missing' };
  }

  /** Request sessions are immutable; new requests evaluate the application's latest cached template. */
  subscribe(_listener: () => void): () => void {
    return () => undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.values.clear();
    this.onClose();
  }
}

function evaluateBoolean(value: FirebaseAdminValue): ProviderEvaluation {
  if (value.getSource() !== 'remote') return { kind: 'unavailable', reason: 'missing' };
  const raw = value.asString().trim().toLowerCase();
  if (raw !== 'true' && raw !== 'false') return { kind: 'unavailable', reason: 'invalid' };
  return Object.freeze({ kind: 'value', value: raw === 'true', source: 'provider' });
}
