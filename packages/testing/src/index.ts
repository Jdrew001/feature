import type { EvaluationContext, FeatureProvider, ProviderEvaluation, ProviderSession } from '@feature-gates/core';

export class MemorySession implements ProviderSession {
  readonly listeners = new Set<() => void>();
  closed = false;
  constructor(readonly context: EvaluationContext, private readonly values: Map<string, unknown>) {}
  evaluate(key: string): ProviderEvaluation {
    if (this.closed) return { kind: 'unavailable', reason: 'unavailable' };
    if (!this.values.has(key)) return { kind: 'unavailable', reason: 'missing' };
    const value = this.values.get(key);
    return typeof value === 'boolean' ? { kind: 'value', value, source: 'provider' } : { kind: 'unavailable', reason: 'invalid' };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  set(key: string, value: unknown): void { this.values.set(key, value); this.notify(); }
  delete(key: string): void { this.values.delete(key); this.notify(); }
  notify(): void { if (!this.closed) for (const listener of [...this.listeners]) listener(); }
  close(): void { this.closed = true; this.listeners.clear(); }
}

/** Manual readiness and per-context sessions let tests reproduce races without a vendor SDK. */
export class MemoryProvider implements FeatureProvider {
  readonly sessions: MemorySession[] = [];
  private readonly pending = new Map<MemorySession, () => void>();
  constructor(private readonly initial: Readonly<Record<string, unknown>> = {}, readonly autoReady = true) {}
  connect(context: EvaluationContext, signal: AbortSignal): Promise<ProviderSession> {
    const session = new MemorySession(context, new Map(Object.entries(this.initial)));
    this.sessions.push(session);
    return new Promise((resolve, reject) => {
      const abort = () => { session.close(); this.pending.delete(session); reject(new Error('Connection aborted')); };
      const ready = () => {
        signal.removeEventListener('abort', abort);
        this.pending.delete(session);
        resolve(session);
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      if (this.autoReady) ready(); else this.pending.set(session, ready);
    });
  }
  ready(session: MemorySession | undefined = this.sessions.at(-1)): void { if (session) this.pending.get(session)?.(); }
  get current(): MemorySession { const session = this.sessions.at(-1); if (!session) throw new Error('Provider has not connected'); return session; }
}
