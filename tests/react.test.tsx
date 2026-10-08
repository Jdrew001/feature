import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { FeatureGate, FeatureProvider } from '@feature-gates/react';
import { createFeatureClient } from '@feature-gates/core';
import { MemoryProvider } from '@feature-gates/testing';
const roots: Root[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(() => root.unmount()); await Promise.all(cleanups.splice(0).map(fn => fn())); document.body.replaceChildren(); });
async function setup(autoReady = true) {
  const provider = new MemoryProvider({ a: false, b: true }, autoReady);
  const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false }, b: { providerKey: 'b', fallback: false } }, provider });
  const started = client.start({ targetId: 'user' }); cleanups.push(() => client.dispose());
  if (autoReady) await started; else void started.catch(() => {});
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element); roots.push(root);
  return { client, provider, element, root, started };
}
describe('React boundaries', () => {
  it('does not mount disabled child effects, then responds to live updates', async () => {
    const f = await setup(); const mounted = vi.fn();
    function Child() { useEffect(() => { mounted(); }, []); return <p>enabled</p>; }
    await act(() => f.root.render(<FeatureProvider reader={f.client}><FeatureGate feature="a" fallback={<p>off</p>}><Child /></FeatureGate></FeatureProvider>));
    expect(mounted).not.toHaveBeenCalled(); expect(f.element.textContent).toBe('off');
    await act(() => f.provider.current.set('a', true)); expect(mounted).toHaveBeenCalledOnce(); expect(f.element.textContent).toBe('enabled');
    await act(() => f.provider.current.set('a', false)); expect(f.element.textContent).toBe('off');
  });
  it('renders pending without mounting feature content', async () => {
    const f = await setup(false); const mounted = vi.fn();
    function Child() { useEffect(() => { mounted(); }, []); return <p>enabled</p>; }
    await act(() => f.root.render(<FeatureProvider reader={f.client}><FeatureGate feature="a" pending={<p>loading</p>}><Child /></FeatureGate></FeatureProvider>));
    expect(f.element.textContent).toBe('loading'); expect(mounted).not.toHaveBeenCalled();
    await act(async () => { f.provider.current.set('a', true); f.provider.ready(); await f.started; }); expect(f.element.textContent).toBe('enabled');
  });
  it('switches feature inputs and unsubscribes from the previous feature', async () => {
    const f = await setup();
    const render = (feature: string) => <FeatureProvider reader={f.client}><FeatureGate feature={feature} fallback="off">on</FeatureGate></FeatureProvider>;
    await act(() => f.root.render(render('a'))); expect(f.element.textContent).toBe('off');
    await act(() => f.root.render(render('b'))); expect(f.element.textContent).toBe('on');
    await act(() => f.provider.current.set('a', true)); expect(f.element.textContent).toBe('on');
  });
  it('does not initialize or dispose the shell-owned client in Strict Mode', async () => {
    const f = await setup(); const dispose = vi.spyOn(f.client, 'dispose');
    await act(() => f.root.render(<StrictMode><FeatureProvider reader={f.client}><FeatureGate feature="b">on</FeatureGate></FeatureProvider></StrictMode>));
    expect(f.provider.sessions).toHaveLength(1); expect(dispose).not.toHaveBeenCalled(); expect(f.element.textContent).toBe('on');
  });
  it('removes its subscription on unmount', async () => {
    const f = await setup(); const subscribe = vi.spyOn(f.client, 'subscribe');
    await act(() => f.root.render(<FeatureProvider reader={f.client}><FeatureGate feature="a">on</FeatureGate></FeatureProvider>));
    expect(subscribe).toHaveBeenCalledOnce(); await act(() => f.root.render(null));
    await act(() => f.provider.current.set('a', true)); expect(f.element.textContent).toBe('');
  });
});
