/** Public runtime metadata only. Executable code stays in explicitly configured local modules. */
export interface NativeRuntimeProvider {
  accountReader?: import('./types.js').BuiltinHarness;
  id: string;
  name: string;
  nativeVersion: string;
  extensionId: string;
  extensionName: string;
  extensionVersion: string;
  digest: string;
}
export interface NativeProviderBinding {
  accountReader?: import('./types.js').BuiltinHarness;
  name?: string;
  id: string;
  extensionId: string;
  extensionVersion: string;
  digest: string;
}
