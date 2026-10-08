import { describe, expect, it, vi } from 'vitest';
import { Event } from '@harnessio/ff-javascript-client-sdk';
import type { initialize, Result } from '@harnessio/ff-javascript-client-sdk';
import { createHarnessProvider } from '@feature-gates/harness';
import { createFeatureClient } from '@feature-gates/core';
function fixture() {
  const listeners = new Map<string, Set<(value?: unknown) => void>>();
  const values = new Map<string, unknown>();
  const sdk = {
    on: (event: string, listener: (value?: unknown) => void) => { let set = listeners.get(event); if (!set) { set = new Set(); listeners.set(event, set); } set.add(listener); },
    off: (event: string, listener: (value?: unknown) => void) => { listeners.get(event)?.delete(listener); },
    variation: (key: string, fallback: boolean) => ({ value: values.has(key) ? values.get(key) : fallback, isDefaultValue: !values.has(key) }),
    close: vi.fn(), registerAPIRequestMiddleware: vi.fn(),
  };
  const init = vi.fn(() => sdk) as unknown as typeof initialize;
  const provider = createHarnessProvider({ sdkKey: 'runtime-injected-key', initialize: init });
  const emit = (event: Event, value: unknown = event === Event.FLAGS_LOADED ? [...values].map(([flag, value]) => ({ flag, value, identifier: 'test', kind: 'boolean' })) : { flag: 'a', value: values.get('a'), kind: 'boolean', identifier: 'test' }) => { for (const fn of [...(listeners.get(event) ?? [])]) fn(value); };
  return { provider, sdk, init, emit, values, listeners };
}
describe('Harness adapter contract', () => {
  it('passes the runtime key and target without any environment configuration', async () => {
    const f = fixture(); const controller = new AbortController(); const connecting = f.provider.connect({ targetId: 'user', attributes: { tenant: 'one' } }, controller.signal);
    f.emit(Event.FLAGS_LOADED); const session = await connecting;
    expect(f.init).toHaveBeenCalledWith('runtime-injected-key', { identifier: 'user', attributes: { tenant: 'one' } }, expect.objectContaining({ cache: false, pollingEnabled: true }));
    session.close();
  });
  it('does not accept READY alone as proof that flags were fetched', async () => {
    const f = fixture(); const controller = new AbortController();
    const connected = f.provider.connect({ targetId: 'user' }, controller.signal);
    let settled = false; void connected.then(() => { settled = true; }, () => {});
    f.emit(Event.READY); await Promise.resolve(); expect(settled).toBe(false);
    controller.abort(); await expect(connected).rejects.toThrow('aborted');
  });
  it('recovers only the changed flag after a disconnect', async () => {
    const f = fixture(); f.values.set('a', true); f.values.set('b', true);
    const connected = f.provider.connect({ targetId: 'user' }, new AbortController().signal);
    f.emit(Event.FLAGS_LOADED); const session = await connected;
    f.emit(Event.DISCONNECTED); f.emit(Event.CHANGED);
    expect(session.evaluate('a', false)).toMatchObject({ kind: 'value', value: true });
    expect(session.evaluate('b', false)).toEqual({ kind: 'unavailable', reason: 'unavailable' });
    session.close();
  });
  it('evaluates remote false, missing values, and invalid types distinctly', async () => {
    const f = fixture(); f.values.set('a', false); f.values.set('b', {});
    const connecting = f.provider.connect({ targetId: 'user' }, new AbortController().signal); f.emit(Event.FLAGS_LOADED); const session = await connecting;
    expect(session.evaluate('a', true)).toEqual({ kind: 'value', value: false, source: 'provider' });
    expect(session.evaluate('missing', false)).toEqual({ kind: 'unavailable', reason: 'missing' });
    expect(session.evaluate('b', false)).toEqual({ kind: 'unavailable', reason: 'invalid' }); session.close();
  });
  it('falls back on disconnect and waits for evaluations rather than connection alone', async () => {
    const f = fixture(); const connecting = f.provider.connect({ targetId: 'user' }, new AbortController().signal); f.emit(Event.FLAGS_LOADED); const session = await connecting;
    f.values.set('a', true); const listener = vi.fn(); session.subscribe(listener);
    f.emit(Event.DISCONNECTED); expect(session.evaluate('a', false).kind).toBe('unavailable');
    f.emit(Event.CONNECTED); expect(session.evaluate('a', false).kind).toBe('unavailable');
    f.emit(Event.FLAGS_LOADED); expect(session.evaluate('a', false)).toMatchObject({ value: true }); expect(listener).toHaveBeenCalledTimes(2); session.close();
  });
  it('notifies polling loads and live changes, and releases listeners on close', async () => {
    const f = fixture(); const connecting = f.provider.connect({ targetId: 'user' }, new AbortController().signal); f.emit(Event.FLAGS_LOADED); const session = await connecting;
    const listener = vi.fn(); const off = session.subscribe(listener); f.emit(Event.FLAGS_LOADED); f.emit(Event.CHANGED); expect(listener).toHaveBeenCalledTimes(2);
    off(); session.close(); session.close(); f.emit(Event.CHANGED); expect(listener).toHaveBeenCalledTimes(2); expect(f.sdk.close).toHaveBeenCalledOnce(); expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
  });
  it('closes and rejects an aborted pending connection', async () => {
    const f = fixture(); const controller = new AbortController(); const connecting = f.provider.connect({ targetId: 'user' }, controller.signal);
    controller.abort(); await expect(connecting).rejects.toThrow('aborted'); expect(f.sdk.close).toHaveBeenCalledOnce();
  });
  it('rejects and cleans up failed authentication', async () => {
    const f = fixture(); const connecting = f.provider.connect({ targetId: 'user' }, new AbortController().signal);
    f.emit(Event.ERROR_AUTH); await expect(connecting).rejects.toThrow('authentication'); expect(f.sdk.close).toHaveBeenCalledOnce();
  });
  it('returns pending then updates core decisions when readiness arrives', async () => {
    const f = fixture(); const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: f.provider });
    const started = client.start({ targetId: 'user' }); for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(client.getSnapshot('a').status).toBe('pending'); f.values.set('a', true); f.emit(Event.FLAGS_LOADED); await started;
    expect(client.getSnapshot('a').enabled).toBe(true); f.emit(Event.DISCONNECTED); expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'degraded' }); await client.dispose();
  });
});
