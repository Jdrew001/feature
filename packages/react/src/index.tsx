import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { FeatureDecision, FeatureReader } from '@feature-gates/core';

const ReaderContext = createContext<FeatureReader | null>(null);

/** The application shell owns startup, target updates, and disposal. Safe under Strict Mode. */
export function FeatureProvider({ reader, children }: { reader: FeatureReader; children: ReactNode }): ReactNode {
  return <ReaderContext.Provider value={reader}>{children}</ReaderContext.Provider>;
}

export function useFeature(feature: string, serverSnapshot?: FeatureDecision): FeatureDecision {
  const reader = useContext(ReaderContext);
  if (!reader) throw new Error('useFeature requires a FeatureProvider');
  const subscribe = useCallback((listener: () => void) => reader.subscribe(feature, listener), [reader, feature]);
  const snapshot = useCallback(() => reader.getSnapshot(feature), [reader, feature]);
  const server = useCallback(() => {
    if (!serverSnapshot) throw new Error('Server rendering requires an explicit feature snapshot');
    return serverSnapshot;
  }, [serverSnapshot]);
  return useSyncExternalStore(subscribe, snapshot, server);
}

export interface FeatureGateProps {
  feature: string;
  children: ReactNode;
  pending?: ReactNode;
  fallback?: ReactNode;
  serverSnapshot?: FeatureDecision;
}
export function FeatureGate({ feature, children, pending = null, fallback = null, serverSnapshot }: FeatureGateProps): ReactNode {
  const decision = useFeature(feature, serverSnapshot);
  return decision.status === 'pending' ? pending : decision.enabled ? children : fallback;
}

/** Bind once in a domain package to reject misspelled names in hooks and JSX. */
export function createFeatureBindings<K extends string>() {
  return {
    useFeature: (feature: K, serverSnapshot?: FeatureDecision) => useFeature(feature, serverSnapshot),
    FeatureGate: (props: Omit<FeatureGateProps, 'feature'> & { feature: K }) => <FeatureGate {...props} />,
  };
}
