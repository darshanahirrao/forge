export type CredentialReference =
  | { kind: 'private-json'; path: string; key: string }
  | { kind: 'macos-keychain'; service: string; account: string; keychain?: string };
