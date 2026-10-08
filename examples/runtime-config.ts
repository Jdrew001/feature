export interface RuntimeConfig { harnessSdkKey: string; }
/** OpenShift serves or mounts this JSON before the application bootstraps. */
export async function loadRuntimeConfig(url = '/runtime-config.json'): Promise<RuntimeConfig> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load runtime configuration');
  const config: unknown = await response.json();
  if (typeof config !== 'object' || config === null || !('harnessSdkKey' in config) || typeof config.harnessSdkKey !== 'string' || !config.harnessSdkKey.trim()) {
    throw new Error('Runtime configuration requires a Harness browser SDK key');
  }
  return { harnessSdkKey: config.harnessSdkKey };
}
