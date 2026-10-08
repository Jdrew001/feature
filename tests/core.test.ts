import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextChangedError, DisposedError, createFeatureClient, defineFeatures } from '@feature-gates/core';
import type { FeatureCatalog, FeatureClient, FeatureProvider, ProviderSession } from '@feature-gates/core';
import { MemoryProvider } from '@feature-gates/testing';
const catalog = defineFeatures({ reports: { providerKey: 'reports', fallback: false }, checkout: { providerKey: 'checkout', fallback: false } });
const clients: FeatureClient<FeatureCatalog>[] = [];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup(provider = new MemoryProvider({ reports: false, checkout: true }), options = {}) {
  const client = createFeatureClient({ catalog, provider, ...options });
  clients.push(client);
  return { client, provider };
}
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.dispose())); vi.useRealTimers(); });
describe('feature client', () => {
  it('accepts remote false as ready, not a failed evaluation', async () => {
    const { client } = setup(); await client.start({ targetId: 'a' });
    expect(client.getSnapshot('reports')).toMatchObject({ enabled: false, status: 'ready', source: 'provider' });
  });
  it('is idempotent and keeps stable snapshots on repeated evaluations', async () => {
    const { client, provider } = setup();
    const first = client.start({ targetId: 'a', attributes: { b: true, a: 1 } });
    expect(client.start({ targetId: 'a', attributes: { a: 1, b: true } })).toBe(first);
    await first;
    const previous = client.getSnapshot('reports'); provider.current.notify();
    expect(client.getSnapshot('reports')).toBe(previous);
    expect(provider.sessions).toHaveLength(1);
  });
  it('uses fallback for missing and invalid values', async () => {
    const { client } = setup(new MemoryProvider({ checkout: 'true' })); await client.start({ targetId: 'a' });
    expect(client.getSnapshot('reports')).toMatchObject({ enabled: false, status: 'degraded', reason: 'missing' });
    expect(client.getSnapshot('checkout')).toMatchObject({ enabled: false, status: 'degraded', reason: 'invalid' });
  });
  it('publishes the complete batch before notifying and isolates listener failures', async () => {
    const { client, provider } = setup(); await client.start({ targetId: 'a' });
    client.subscribe('reports', () => { throw new Error('consumer'); });
    const seen: boolean[] = []; const off = client.subscribe('reports', () => seen.push(client.getSnapshot('checkout').enabled));
    provider.current.set('reports', true);
    expect(seen).toEqual([true]); off(); off(); provider.current.set('reports', false); expect(seen).toEqual([true]);
  });
  it('releases startup after the deadline and recovers on late readiness', async () => {
    vi.useFakeTimers(); const { client, provider } = setup(new MemoryProvider({ reports: true }, false), { initializationTimeoutMs: 10 });
    const started = client.start({ targetId: 'a' }); await flush();
    await vi.advanceTimersByTimeAsync(10); await started;
    expect(client.getSnapshot('reports')).toMatchObject({ reason: 'timeout', enabled: false });
    provider.ready(); await flush(); expect(client.getSnapshot('reports')).toMatchObject({ status: 'ready', enabled: true });
  });
  it('clears enabled decisions synchronously when target identity changes', async () => {
    const { client, provider } = setup(new MemoryProvider({ reports: true })); await client.start({ targetId: 'a' });
    const firstSession = provider.current; const changed = client.setContext({ targetId: 'b' });
    expect(client.getSnapshot('reports')).toMatchObject({ status: 'pending', enabled: false });
    await changed; expect(firstSession.closed).toBe(true); expect(provider.current.context.targetId).toBe('b');
  });
  it('rejects previous context waiters and ignores obsolete sessions', async () => {
    const { client, provider } = setup(new MemoryProvider({ reports: true }, false));
    const first = client.start({ targetId: 'a' }); const rejected = expect(first).rejects.toBeInstanceOf(ContextChangedError); await flush();
    const old = provider.current; const second = client.setContext({ targetId: 'b' }); await flush(); await rejected;
    expect(old.closed).toBe(true); provider.ready(old); expect(client.getSnapshot('reports').status).toBe('pending');
    provider.current.set('reports', false); provider.ready(); await second;
    expect(client.getSnapshot('reports').enabled).toBe(false);
  });
  it('closes a late result from a provider that ignores abort', async () => {
    let resolveOld!: (s: ProviderSession) => void;
    const old = { evaluate: () => ({ kind: 'value' as const, value: true, source: 'provider' as const }), subscribe: () => () => {}, close: vi.fn() };
    const memory = new MemoryProvider({ reports: false });
    const provider: FeatureProvider = { connect: (context, signal) => context.targetId === 'a' ? new Promise(resolve => { resolveOld = resolve; }) : memory.connect(context, signal) };
    const client = createFeatureClient({ catalog, provider }); clients.push(client);
    const first = client.start({ targetId: 'a' }); void first.catch(() => {}); await flush();
    await client.setContext({ targetId: 'b' }); resolveOld(old); await flush();
    expect(old.close).toHaveBeenCalledOnce(); expect(client.getSnapshot('reports').enabled).toBe(false);
  });
  it('supports explicit retry after provider connection failure', async () => {
    let fails = true; const memory = new MemoryProvider({ reports: true });
    const client = createFeatureClient({ catalog, provider: { connect: (context, signal) => fails ? Promise.reject(new Error('offline')) : memory.connect(context, signal) } }); clients.push(client);
    await client.start({ targetId: 'a' }); expect(client.getSnapshot('reports').reason).toBe('unavailable');
    fails = false; await client.retry(); expect(client.getSnapshot('reports').enabled).toBe(true);
  });
  it('disposes idempotently and releases pending waiters', async () => {
    const { client } = setup(new MemoryProvider({}, false)); const started = client.start({ targetId: 'a' });
    const rejected = expect(started).rejects.toBeInstanceOf(DisposedError); await flush();
    const disposed = client.dispose(); expect(client.dispose()).toBe(disposed); await disposed; await rejected;
    await expect(client.whenSettled('reports')).rejects.toBeInstanceOf(DisposedError);
  });
  it('validates definitions and context', () => {
    expect(() => createFeatureClient({ catalog: { a: { providerKey: 'same', fallback: false }, b: { providerKey: 'same', fallback: false } }, provider: new MemoryProvider() })).toThrow('Duplicate');
    const { client } = setup(); expect(() => client.start({ targetId: '' })).toThrow('targetId');
    expect(() => client.getSnapshot('typo' as 'reports')).toThrow('Unknown');
  });
  it('deduplicates unknown feature diagnostics in tolerant mode', () => {
    const sink = vi.fn(); const { client } = setup(undefined, { strictUnknownFeatures: false, onDiagnostic: sink });
    expect(client.getSnapshot('typo' as 'reports').enabled).toBe(false);
    client.getSnapshot('typo' as 'reports'); expect(sink).toHaveBeenCalledOnce();
  });
  it('protects fallback policy from mutation of the original catalog', () => {
    const definitions = { a: { providerKey: 'a', fallback: false } }; const client = createFeatureClient({ catalog: definitions, provider: new MemoryProvider() }); clients.push(client);
    definitions.a.fallback = true; expect(client.catalog.a.fallback).toBe(false); expect(Object.isFrozen(client.getSnapshot('a'))).toBe(true);
  });
});
