/** Stable extension entry point. Importing this module starts no server or native process. */
export { defineExtension } from './extensions.js';
export type { ForgeExtension, LoadedExtensions } from './extensions.js';
export { nativeCompanion, hermesCompanion, openClawCompanion } from './companion-providers.js';
export type {
  CompanionProvider,
  CompanionProviderDefinition,
  CompanionConnection,
} from './companion-providers.js';
export type { Account } from '../shared/types.js';
export type { CredentialMaterial } from './credentials.js';
export { credentialValue } from './credentials.js';
export type { NativeSpawn, SupervisedChild } from './owned-native.js';
export type { NativeHarnessDefinition } from './harness-providers.js';
export type { NativeDriver, DriverContext, DriverSink, NativeApproval } from './adapters/driver.js';
export { CodexDriver } from './adapters/codex-driver.js';
export { HermesDriver } from './adapters/hermes-driver.js';
export { OpenCodeDriver } from './adapters/opencode-driver.js';
export { ClaudeDriver } from './adapters/claude-driver.js';
export { OpenClawDriver } from './adapters/openclaw-driver.js';
