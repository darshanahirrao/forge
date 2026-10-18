import type { Account, BuiltinHarness } from '../shared/types.js';
import type { NativeRuntimeProvider } from '../shared/extensions.js';
import type { DriverFactory, NativeDriver, DriverContext, DriverSink } from './adapters/driver.js';
import { CredentialMaterial, credentialTarget, credentialValue } from './credentials.js';
import { assert } from './errors.js';
import { probeAccount } from './adapters/accounts.js';

export interface NativeHarnessDefinition {
  contract: 1;
  id: string;
  name: string;
  nativeVersion: string;
  /** Native configuration contract declarations, not copied credentials. */
  profileFiles: readonly string[];
  create: DriverFactory;
  /** Optional reuse of an existing finite native account reader, never a model call. */
  accountReader?: BuiltinHarness;
  extension?: NativeRuntimeProvider;
}

/** Adapt an existing native driver without copying its tools, model loop or permissions. */
export function bindNativeDriver(harness: string, driver: NativeDriver): NativeDriver {
  assert(
    /^ext\.[a-z][a-z0-9.-]{1,75}$/.test(harness),
    400,
    'Use a versioned extension harness ID.',
  );
  assert(
    driver.ownership !== 'delegated-run',
    409,
    'Native execution extensions require an original owned native process.',
  );
  let started = false;
  return {
    harness,
    get closed() {
      return driver.closed;
    },
    async start(context, sink) {
      assert(
        !started && !driver.closed,
        409,
        'This native extension driver has already started or closed.',
      );
      started = true;
      assert(
        context.spawnNative && sink.worker && context.account.nativeExecutor,
        409,
        'Native execution extensions require persistent original-child supervision.',
      );
      const account = { ...context.account, harness: driver.harness };
      let credentials: CredentialMaterial | undefined;
      try {
        if (context.credentials) {
          const target = credentialTarget(context.account);
          credentials = new CredentialMaterial(
            account,
            credentialValue(context.account, target, context.credentials)!,
          );
        }
        const material: DriverContext = {
          ...context,
          account,
          credentials,
          work: { ...context.work, harness: driver.harness },
          run: { ...context.run, harness: driver.harness },
        };
        let registered = false;
        const beforeEvidence = () =>
          assert(
            registered,
            409,
            'Register the original native child before reporting session, approvals or usage.',
          );
        const forward: DriverSink = {
          ...sink,
          delegated: undefined,
          async worker(pid) {
            await sink.worker!(pid);
            registered = true;
          },
          session(id, key) {
            beforeEvidence();
            sink.session(id, key);
          },
          turn(id) {
            beforeEvidence();
            sink.turn(id);
          },
          approval(request) {
            beforeEvidence();
            sink.approval(request);
          },
          usage(usage) {
            beforeEvidence();
            sink.usage({ ...usage, harness, key: harness + ':' + usage.key });
          },
          account(checked) {
            assert(
              checked.id === account.id,
              409,
              'The native extension changed account identity scope.',
            );
            sink.account({
              ...context.account,
              state: checked.state,
              identity: checked.identity,
              identityKey: checked.identityKey,
              plan: checked.plan,
              checkedAt: checked.checkedAt,
              error: checked.error,
              quotas: checked.quotas,
              ordinaryUsageAllowed: checked.ordinaryUsageAllowed,
            });
          },
          ended(status, title, detail) {
            if (status === 'completed' && !registered)
              sink.ended(
                'failed',
                'Native execution was not registered',
                'The extension reported completion without an original owned worker. Inspect its native state before another attempt.',
              );
            else sink.ended(status, title, detail);
          },
        };
        await driver.start(material, forward);
      } finally {
        credentials?.dispose();
      }
    },
    interrupt: () => driver.interrupt(),
    close: () => driver.close(),
  };
}

/** Registry bindings are rechecked immediately before factory construction and credential use. */
export class NativeHarnesses {
  constructor(
    private definitions: Readonly<Record<string, NativeHarnessDefinition>> = {},
    private readAccount: typeof probeAccount = probeAccount,
  ) {}
  current(account: Account) {
    const bound = account.nativeExecutor;
    const definition = this.definitions[account.harness];
    return Boolean(
      bound &&
      definition?.extension &&
      definition.id === bound.id &&
      definition.extension.extensionId === bound.extensionId &&
      definition.extension.extensionVersion === bound.extensionVersion &&
      definition.accountReader === bound.accountReader &&
      definition.extension.digest === bound.digest,
    );
  }
  validate(account: Account) {
    if (!account.nativeExecutor) return;
    assert(
      this.current(account),
      409,
      'This native harness extension changed or is unavailable. Keep its history and link a reviewed current account.',
    );
    assert(
      account.nativeHome &&
        !account.connector &&
        !account.backend &&
        !account.nativeProvider &&
        account.billingMode !== 'subscription',
      409,
      'Choose one explicit native harness profile with native or API billing.',
    );
  }
  async probe(account: Account, credentials?: CredentialMaterial) {
    this.validate(account);
    const reader = this.definitions[account.harness].accountReader;
    if (!reader) return account;
    const native = { ...account, harness: reader };
    let material: CredentialMaterial | undefined;
    try {
      if (credentials) {
        const target = credentialTarget(account);
        material = new CredentialMaterial(native, credentialValue(account, target, credentials)!);
      }
      const checked = await this.readAccount(native, material);
      assert(checked.id === account.id, 409, 'The native account reader changed scope.');
      return {
        ...checked,
        harness: account.harness,
        nativeExecutor: account.nativeExecutor,
        nativeExecutorReady: true,
      };
    } finally {
      material?.dispose();
    }
  }
  driver(context: DriverContext) {
    this.validate(context.account);
    assert(
      context.spawnNative,
      409,
      'Native harness extensions require a persistent workspace on a supported supervision host.',
    );
    const definition = this.definitions[context.account.harness];
    assert(definition, 409, 'This native harness extension is unavailable.');
    const driver = definition.create(context);
    assert(
      driver &&
        typeof driver.harness === 'string' &&
        driver.harness &&
        typeof driver.start === 'function' &&
        typeof driver.close === 'function' &&
        typeof driver.interrupt === 'function' &&
        driver.ownership !== 'delegated-run',
      409,
      'The native harness extension did not provide its declared owned execution contract.',
    );
    return bindNativeDriver(definition.id, driver);
  }
}
