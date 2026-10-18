/** Public runtime metadata only. Executable code stays in explicitly configured local modules. */
export interface NativeRuntimeProvider {
  id: string;
  name: string;
  nativeVersion: string;
  extensionId: string;
  extensionName: string;
  extensionVersion: string;
  digest: string;
}
export interface NativeProviderBinding {
  id: string;
  extensionId: string;
  extensionVersion: string;
  digest: string;
}
