export interface NativeConnectorManifest {
  format: 'forge.native-connector';
  version: 1;
  id: string;
  name: string;
  protocol: 'acp/1';
  executable: string;
  args: string[];
  agent: { name: string; version: string };
  mode: string;
  model?: string;
  homeVariables: Record<string, string>;
}
export interface NativeConnector {
  id: string;
  manifest: NativeConnectorManifest;
  executable: string;
  executableDigest: string;
  digest: string;
  enabled: boolean;
  installedAt: string;
}
export interface ConnectorPlan {
  id: string;
  connector: NativeConnector;
  expiresAt: string;
  coverage: string;
}
