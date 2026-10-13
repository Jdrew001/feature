import { describe, expect, it, vi } from 'vitest';
import { createFeatureClient, defineFeatures } from '@feature-gates/core';
import { createFirebaseAdminProvider } from '../packages/firebase-admin/src/index.js';
import type { FirebaseAdminTemplate, FirebaseAdminValue } from '../packages/firebase-admin/src/index.js';

function value(raw: string, source = 'remote'): FirebaseAdminValue {
  return { asString: () => raw, getSource: () => source };
}

function template(values: Record<string, FirebaseAdminValue>): FirebaseAdminTemplate {
  return { evaluate: () => ({ getAll: () => values }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Firebase Admin provider', () => {
  it('rejects cancellation before loading without invoking the loader', async () => {
    const loadTemplate = vi.fn(async () => template({}));
    const provider = createFirebaseAdminProvider({ loadTemplate });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.connect({ targetId: 'first' }, controller.signal)).rejects.toThrow('Connection aborted');
    expect(loadTemplate).not.toHaveBeenCalled();
  });

  it('cancels a waiter immediately while another request completes its shared load', async () => {
    const pending = deferred<FirebaseAdminTemplate>();
    const evaluate = vi.fn(() => ({ getAll: () => ({ beta: value('true') }) }));
    const provider = createFirebaseAdminProvider({ loadTemplate: () => pending.promise });
    const canceled = new AbortController();
    const first = provider.connect({ targetId: 'first' }, canceled.signal);
    const second = provider.connect({ targetId: 'second' }, new AbortController().signal);
    canceled.abort();
    await expect(first).rejects.toThrow('Connection aborted');
    pending.resolve({ evaluate });
    const session = await second;
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith({ randomizationId: 'second' });
    expect(session.evaluate('beta', false)).toEqual({ kind: 'value', value: true, source: 'provider' });
    await session.close();
  });

  it('rejects cancellation after the loader settles before evaluating', async () => {
    const controller = new AbortController();
    const evaluate = vi.fn(() => ({ getAll: () => ({}) }));
    const provider = createFirebaseAdminProvider({ loadTemplate: async () => {
      controller.abort();
      return { evaluate };
    } });
    await expect(provider.connect({ targetId: 'first' }, controller.signal)).rejects.toThrow('Connection aborted');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('isolates simultaneous tenant and account signals and snapshots evaluated values', async () => {
    const pending = deferred<FirebaseAdminTemplate>();
    const signals = { individual_id: 'first', tenant_id: 'tenant-a', randomizationId: 'first' };
    const provider = createFirebaseAdminProvider({
      loadTemplate: () => pending.promise,
      context: context => context.targetId === 'first' ? signals : {
        individual_id: context.targetId, tenant_id: 'tenant-b', randomizationId: context.targetId,
      },
    });
    const first = provider.connect({ targetId: 'first' }, new AbortController().signal);
    const second = provider.connect({ targetId: 'second' }, new AbortController().signal);
    signals.individual_id = 'changed';
    let raw = 'true';
    const evaluate = vi.fn(context => ({ getAll: () => ({ beta: value(context?.tenant_id === 'tenant-a' ? raw : 'false') }) }));
    pending.resolve({ evaluate });
    const [firstSession, secondSession] = await Promise.all([first, second]);
    raw = 'false';
    expect(evaluate.mock.calls[0]?.[0]).toEqual({ individual_id: 'first', tenant_id: 'tenant-a', randomizationId: 'first' });
    expect(Object.isFrozen(evaluate.mock.calls[0]?.[0])).toBe(true);
    expect(firstSession.evaluate('beta', false)).toMatchObject({ value: true });
    expect(secondSession.evaluate('beta', true)).toMatchObject({ value: false });
    await firstSession.close();
    expect(secondSession.evaluate('beta', true)).toMatchObject({ value: false });
    await secondSession.close();
  });

  it('accepts only explicit remote Boolean strings and reports missing values', async () => {
    const provider = createFirebaseAdminProvider({ loadTemplate: async () => template({
      on: value(' TRUE '), off: value('false'), invalid: value('yes'),
      numeric: value('1'), fallback: value('true', 'default'), absent: value('', 'static'),
    }) });
    const session = await provider.connect({ targetId: 'first' }, new AbortController().signal);
    expect(session.evaluate('on', false)).toMatchObject({ value: true });
    expect(session.evaluate('off', true)).toMatchObject({ value: false });
    for (const key of ['invalid', 'numeric']) expect(session.evaluate(key, false)).toEqual({ kind: 'unavailable', reason: 'invalid' });
    for (const key of ['fallback', 'absent', 'missing']) expect(session.evaluate(key, true)).toEqual({ kind: 'unavailable', reason: 'missing' });
    await session.close();
  });

  it('fails closed through core on template errors and invalid signals', async () => {
    const catalog = defineFeatures({ beta: { providerKey: 'beta', fallback: false } });
    const client = createFeatureClient({ catalog, provider: createFirebaseAdminProvider({
      loadTemplate: async () => { throw new Error('offline'); },
    }) });
    await client.start({ targetId: 'first' });
    expect(client.getSnapshot('beta')).toMatchObject({ enabled: false, status: 'degraded', source: 'fallback' });
    await client.dispose();
    const loadTemplate = vi.fn(async () => template({}));
    const invalid = createFirebaseAdminProvider({ loadTemplate, context: () => ({ signal: Number.NaN }) });
    await expect(invalid.connect({ targetId: 'first' }, new AbortController().signal)).rejects.toThrow('finite numbers');
    expect(loadTemplate).not.toHaveBeenCalled();
  });

  it('closes sessions on cancellation and removes listeners on explicit disposal', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const provider = createFirebaseAdminProvider({ loadTemplate: async () => template({ beta: value('true') }) });
    const session = await provider.connect({ targetId: 'first' }, controller.signal);
    const removeBefore = remove.mock.calls.length;
    await session.close();
    expect(remove.mock.calls.length).toBeGreaterThan(removeBefore);
    await session.close();
    expect(session.evaluate('beta', false)).toEqual({ kind: 'unavailable', reason: 'unavailable' });
    const canceled = await provider.connect({ targetId: 'second' }, controller.signal);
    controller.abort();
    expect(canceled.evaluate('beta', false)).toEqual({ kind: 'unavailable', reason: 'unavailable' });
  });
});
