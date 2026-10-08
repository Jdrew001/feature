import { initialize, Event } from '@harnessio/ff-javascript-client-sdk';
import type { Options, Result, Evaluation } from '@harnessio/ff-javascript-client-sdk';
import type { EvaluationContext, FeatureProvider, ProviderEvaluation, ProviderSession } from '@feature-gates/core';

export interface HarnessProviderOptions {
  /** Runtime-injected browser SDK key selects the Harness environment; no environment parameter exists. */
  sdkKey: string;
  sdkOptions?: Omit<Options, 'cache'>;
  /** Dependency injection seam for contract testing. Defaults to the installed Harness SDK. */
  initialize?: typeof initialize;
}

/** Browser Harness Feature Flags adapter. Persistent caching is deliberately disabled. */
export function createHarnessProvider(options: HarnessProviderOptions): FeatureProvider {
  if (!options.sdkKey?.trim()) throw new Error('Harness sdkKey must be non-empty');
  const initializeSdk = options.initialize ?? initialize;
  return {
    connect(context: EvaluationContext, signal: AbortSignal): Promise<ProviderSession> {
      if (signal.aborted) return Promise.reject(new Error('Connection aborted'));
      return new Promise((resolve, reject) => {
        const requestController = new AbortController();
        const sdk: Result = initializeSdk(options.sdkKey, { identifier: context.targetId, attributes: context.attributes ?? {} }, {
          streamEnabled: true,
          pollingEnabled: true,
          authRequestReadTimeout: 10000,
          ...options.sdkOptions,
          cache: false,
        });
        // Cancel subsequent SDK fetches on session close without losing SDK request deadlines.
        // Requests started inside initialize() precede middleware registration; auth has
        // its own configured deadline. The SDK owns streaming transport cleanup.
        sdk.registerAPIRequestMiddleware(([url, request]) => [url, { ...request, signal: request?.signal ? AbortSignal.any([request.signal, requestController.signal]) : requestController.signal }]);
        const listeners = new Set<() => void>();
        const detach: (() => void)[] = [];
        let available = false;
        const freshKeys = new Set<string>();
        const evaluations = new Map<string, Evaluation>();
        let connected = false;
        let closed = false;
        const notify = () => { for (const listener of [...listeners]) listener(); };
        const session: ProviderSession = {
          evaluate(key, fallback): ProviderEvaluation {
            if (closed || (!available && !freshKeys.has(key))) return { kind: 'unavailable', reason: 'unavailable' };
            const evaluation = evaluations.get(key);
            if (!evaluation) return { kind: 'unavailable', reason: 'missing' };
            const raw = evaluation.value;
            if (evaluation.kind !== 'boolean' || !(typeof raw === 'boolean' || (typeof raw === 'string' && /^(true|false)$/i.test(raw)))) {
              return { kind: 'unavailable', reason: 'invalid' };
            }
            const result = sdk.variation(key, fallback, true);
            if (result.isDefaultValue) return { kind: 'unavailable', reason: 'missing' };
            if (typeof result.value !== 'boolean') return { kind: 'unavailable', reason: 'invalid' };
            return { kind: 'value', value: result.value, source: 'provider' };
          },
          subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
          close() {
            if (closed) return;
            closed = true;
            signal.removeEventListener('abort', abort);
            requestController.abort();
            detach.forEach(off => off());
            listeners.clear();
            sdk.close();
          },
        };
        const abort = () => { session.close(); if (!connected) reject(new Error('Connection aborted')); };
        const ready = (loaded: Evaluation[]) => {
          if (closed) return;
          available = true;
          freshKeys.clear();
          evaluations.clear();
          for (const evaluation of loaded) if (!evaluation.deleted) evaluations.set(evaluation.flag, evaluation);
          if (!connected) { connected = true; resolve(session); }
          notify();
        };
        const unavailable = () => { if (!closed) { available = false; freshKeys.clear(); notify(); } };
        const fatalAuth = () => {
          unavailable();
          if (!connected) { session.close(); reject(new Error('Harness authentication failed')); }
        };
        function on(event: Event.READY | Event.FLAGS_LOADED | Event.CHANGED | Event.DISCONNECTED | Event.ERROR_AUTH | Event.ERROR_FETCH_FLAGS | Event.ERROR_FETCH_FLAG | Event.ERROR_STREAM | Event.STOPPED, listener: () => void): void {
          sdk.on(event, listener);
          detach.push(() => sdk.off(event, listener));
        }
        // A CONNECTED event by itself does not prove fresh evaluation data.
        // READY also fires after an initial evaluation fetch failure in SDK 1.32.0.
        // FLAGS_LOADED is the evidence that a complete evaluation response succeeded.
        sdk.on(Event.FLAGS_LOADED, ready);
        detach.push(() => sdk.off(Event.FLAGS_LOADED, ready));
        const changed = (evaluation: Evaluation) => {
          if (closed || !connected) return;
          freshKeys.add(evaluation.flag);
          if (evaluation.deleted) evaluations.delete(evaluation.flag); else evaluations.set(evaluation.flag, evaluation);
          notify();
        };
        sdk.on(Event.CHANGED, changed);
        detach.push(() => sdk.off(Event.CHANGED, changed));
        on(Event.DISCONNECTED, unavailable);
        on(Event.STOPPED, unavailable);
        on(Event.ERROR_STREAM, unavailable);
        on(Event.ERROR_FETCH_FLAGS, unavailable);
        on(Event.ERROR_FETCH_FLAG, unavailable);
        on(Event.ERROR_AUTH, fatalAuth);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  };
}
