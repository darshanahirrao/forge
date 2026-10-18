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
