// Only an owned, public synthetic Keychain fixture is created. No user credential is read.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolveCredential, credentialValue } from '../../server/credentials.js';
import { now } from '../../server/store.js';
import type { Account } from '../../shared/types.js';

assert.equal(process.platform, 'darwin', 'Native Keychain conformance requires macOS.');
const exec = promisify(execFile);
const service = `forge-conformance-${randomUUID()}`,
  user = 'owned-public-fixture';
const value = 'public-synthetic-native-keychain-fixture';
const account: Account = {
  id: randomUUID(),
  label: 'Owned keychain conformance',
  harness: 'claude',
  nativeHome: '',
  billingMode: 'api',
  credentialEnv: 'ANTHROPIC_API_KEY',
  credentialReference: { kind: 'macos-keychain', service, account: user },
  state: 'configured',
  identity: null,
  identityKey: null,
  plan: null,
  checkedAt: null,
  error: null,
  quotas: [],
  createdAt: now(),
};
let created = false;
try {
  // This argument contains deliberately public test text, never a real provider key.
  await exec(
    '/usr/bin/security',
    ['add-generic-password', '-s', service, '-a', user, '-w', value],
    { timeout: 10000, maxBuffer: 16384 },
  );
  created = true;
  const material = (await resolveCredential(account))!;
  assert.equal(credentialValue(account, 'ANTHROPIC_API_KEY', material), value);
  assert.equal(JSON.stringify({ account, material }).includes(value), false);
  material.dispose();
  assert.throws(() => credentialValue(account, 'ANTHROPIC_API_KEY', material), /binding/);
  console.log(
    JSON.stringify({
      status: 'passed',
      nativeBackend: 'macOS Keychain',
      syntheticFixtureOnly: true,
      modelCalls: 0,
    }),
  );
} finally {
  if (created) {
    await exec('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', user], {
      timeout: 10000,
      maxBuffer: 16384,
    });
    await assert.rejects(
      exec('/usr/bin/security', ['find-generic-password', '-s', service, '-a', user, '-w'], {
        timeout: 5000,
        maxBuffer: 16384,
      }),
    );
  }
}
