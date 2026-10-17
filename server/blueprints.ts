import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import type {
  BlueprintBindings,
  BlueprintDefinition,
  BlueprintPlan,
  BlueprintReceipt,
} from '../shared/blueprints.js';
import type {
  Account,
  AgentProfile,
  CompanionGrant,
  MemorySource,
  NativeSource,
  Run,
  Work,
} from '../shared/types.js';
import { assert } from './errors.js';
import { inspectMemory, Profiles, scopeApplies } from './memory.js';
import { id, now, Store } from './store.js';

const text = (max: number) => z.string().trim().max(max);
const role = text(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const memoryBindingRole = text(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const harness = text(80).regex(/^[A-Za-z][A-Za-z0-9._-]*$/);
export const blueprintSchema = z
  .object({
    format: z.literal('forge.workspace-blueprint'),
    version: z.literal(1),
    name: text(100).min(1).optional(),
    harnesses: z.array(harness).max(100).default([]),
    accounts: z
      .array(
        z
          .object({ role, harness, billingMode: z.enum(['native', 'api', 'subscription']) })
          .strict(),
      )
      .max(64),
    settings: z
      .object({
        maxConcurrent: z.literal(1),
        memoryPressurePolicy: z.enum(['protect', 'observe']).optional(),
      })
      .strict(),
    profiles: z
      .array(
        z
          .object({
            role,
            name: text(100).min(1).optional(),
            instructions: text(8000).optional(),
            memoryOwners: z
              .array(
                z
                  .object({
                    owner: z.enum(['hermes', 'openclaw', 'obsidian', 'markdown']),
                    scope: z.enum(['global', 'project', 'work']),
                  })
                  .strict(),
              )
              .max(8),
            preferredCompanion: z.enum(['hermes', 'openclaw']).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    requirements: z.array(text(300)).max(32).default([]),
    workTemplates: z
      .array(
        z
          .object({
            role,
            title: text(140).min(1),
            goal: text(20000).min(1),
            acceptance: text(10000).optional(),
            context: text(30000).optional(),
            accountRole: role,
            profileRole: role,
            projectRole: role,
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
const bindingsSchema = z
  .object({
    accounts: z.record(role, text(200).min(1)).default({}),
    profiles: z.record(role, text(100).min(1)).default({}),
    memories: z.record(memoryBindingRole, text(200).min(1)).default({}),
    companions: z.record(role, text(200).min(1)).default({}),
    projects: z.record(role, text(2000).min(1)).default({}),
    applySettings: z.boolean().default(false),
  })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bound = (record: Record<string, string>, role: string) =>
  Object.hasOwn(record, role) ? record[role] : undefined;
const accountBinding = (account: Account) => ({
  id: account.id,
  harness: account.harness,
  billingMode: account.billingMode,
  nativeHome: account.nativeHome,
  credentialEnv: account.credentialEnv,
  ...(account.credentialReference ? { credentialReference: account.credentialReference } : {}),
  backend: account.backend,
  identityKey: account.identityKey,
});
export const memoryRole = (profile: string, index: number) => `${profile}:memory:${index + 1}`;
interface Prepared {
  plan: BlueprintPlan;
  definition: BlueprintDefinition;
  bindings: BlueprintBindings;
  fingerprint: string;
}

export class Blueprints {
  private plans = new Map<string, Prepared>();
  constructor(
    private store: Store,
    private profiles: Profiles,
    private isBusy: () => boolean,
  ) {}
  parse(value: unknown): BlueprintDefinition {
    const spec = blueprintSchema.parse(value);
    for (const list of [spec.accounts, spec.profiles, spec.workTemplates ?? []])
      assert(
        new Set(list.map((item) => item.role)).size === list.length,
        400,
        'Blueprint roles must be unique within each component type.',
      );
    for (const work of spec.workTemplates ?? [])
      assert(
        spec.accounts.some((account) => account.role === work.accountRole) &&
          spec.profiles.some((profile) => profile.role === work.profileRole),
        400,
        'A work template references an unknown account or profile role.',
      );
    return spec;
  }
  list() {
    return this.store.db
      .prepare(
        "SELECT data FROM records WHERE collection='blueprint_imports' ORDER BY rowid DESC LIMIT 50",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)) as BlueprintReceipt);
  }
  private async prepare(definition: BlueprintDefinition, bindings: BlueprintBindings) {
    const accounts = new Map<string, Account>();
    const fresh: (() => boolean)[] = [];
    const allowed = {
      accounts: new Set(definition.accounts.map((item) => item.role)),
      profiles: new Set(definition.profiles.map((item) => item.role)),
      companions: new Set(definition.profiles.map((item) => item.role)),
      memories: new Set(
        definition.profiles.flatMap((profile) =>
          profile.memoryOwners.map((_, index) => memoryRole(profile.role, index)),
        ),
      ),
      projects: new Set((definition.workTemplates ?? []).map((item) => item.projectRole)),
    };
    for (const key of ['accounts', 'profiles', 'companions', 'memories', 'projects'] as const)
      assert(
        Object.keys(bindings[key]).every((role) => allowed[key].has(role)),
        400,
        'Remove local bindings for unknown blueprint roles.',
      );
    for (const requirement of definition.accounts) {
      const binding = bound(bindings.accounts, requirement.role);
      if (!binding) continue;
      const account = this.store.account(binding);
      assert(
        account.harness === requirement.harness && account.billingMode === requirement.billingMode,
        409,
        'A selected account does not match its blueprint harness and billing mode.',
      );
      accounts.set(requirement.role, account);
      const fingerprint = hash(accountBinding(account));
      fresh.push(() => {
        const current = this.store.get<Account>('accounts', account.id);
        return Boolean(current && hash(accountBinding(current)) === fingerprint);
      });
    }
    const fingerprints: unknown[] = [
      definition,
      bindings,
      [...accounts.values()].map(accountBinding),
    ];
    const warnings: string[] = [];
    const inspections = new Map<string, ReturnType<typeof inspectMemory>>();
    const preparedProfiles: BlueprintPlan['profiles'] = [];
    for (const profile of definition.profiles) {
      const memories: BlueprintPlan['profiles'][number]['memories'] = [];
      let characters = profile.instructions?.length ?? 0;
      for (const [index, requirement] of profile.memoryOwners.entries()) {
        const key = memoryRole(profile.role, index),
          sourceId = bound(bindings.memories, key);
        assert(sourceId, 409, `Choose a local memory reference for ${key}.`);
        const source = this.store.get<MemorySource>('memory_sources', sourceId);
        assert(
          source && source.owner === requirement.owner && source.scope.kind === requirement.scope,
          409,
          'A selected memory reference does not match its blueprint owner and scope.',
        );
        if (!inspections.has(source.id))
          inspections.set(source.id, inspectMemory(source.path, source.section));
        const selection = await inspections.get(source.id)!;
        assert(
          selection.content !== null,
          409,
          'A selected memory reference is too large. Review a smaller section in Memory.',
        );
        characters += selection.content.length;
        fingerprints.push({
          source,
          selectionSha256: selection.selectionSha256,
        });
        const fingerprint = hash(source);
        fresh.push(
          () => hash(this.store.get<MemorySource>('memory_sources', source.id)) === fingerprint,
        );
        memories.push({
          id: source.id,
          label: source.label,
          owner: source.owner,
          scope: source.scope,
        });
        if (source.scope.kind === 'work')
          warnings.push(
            `${profile.role}: the selected reference retains its existing work scope and will be skipped for unrelated imported work.`,
          );
      }
      assert(
        characters <= 32000,
        409,
        'A blueprint profile exceeds the selected context limit. Choose fewer memory references.',
      );
      assert(
        new Set(memories.map((memory) => memory.id)).size === memories.length,
        409,
        'Choose distinct local memory references for each profile.',
      );
      let companion: BlueprintPlan['profiles'][number]['companion'] = null;
      const companionId = bound(bindings.companions, profile.role);
      if (companionId) {
        const source = this.store.get<NativeSource>('native_sources', companionId);
        assert(
          source && profile.preferredCompanion && source.kind === profile.preferredCompanion,
          409,
          'Choose a native activity reference matching this companion role.',
        );
        companion = { id: source.id, kind: source.kind, label: source.label };
        fingerprints.push(source);
        const fingerprint = hash(source);
        fresh.push(
          () => hash(this.store.get<NativeSource>('native_sources', source.id)) === fingerprint,
        );
      } else if (profile.preferredCompanion)
        warnings.push(
          `${profile.role}: connect ${profile.preferredCompanion} separately. Import grants no companion access.`,
        );
      preparedProfiles.push({
        role: profile.role,
        name: bound(bindings.profiles, profile.role) ?? profile.name ?? `Imported ${profile.role}`,
        instructions: profile.instructions ?? '',
        memories,
        companion,
      });
    }
    const work: BlueprintPlan['work'] = [];
    for (const template of definition.workTemplates ?? []) {
      const account = accounts.get(template.accountRole),
        path = bound(bindings.projects, template.projectRole);
      assert(account, 409, `Choose a local account for ${template.accountRole}.`);
      assert(
        path && isAbsolute(path) && !/[\x00-\x1f]/.test(path),
        400,
        `Choose an absolute local directory for ${template.projectRole}.`,
      );
      const directory = await realpath(path).catch(() => null);
      assert(
        directory && (await stat(directory)).isDirectory(),
        409,
        'An imported work directory was not found.',
      );
      for (const memory of preparedProfiles.find(
        (profile) => profile.role === template.profileRole,
      )!.memories)
        if (
          memory.scope.kind === 'project' &&
          !scopeApplies(memory.scope, { id: '', cwd: directory })
        )
          warnings.push(
            `${template.title}: ${memory.label} retains another project's scope and will not be included in this work.`,
          );
      work.push({
        role: template.role,
        title: template.title,
        goal: template.goal,
        acceptance: template.acceptance ?? '',
        context: template.context ?? '',
        account: account.id,
        harness: account.harness,
        directory,
        profileRole: template.profileRole,
      });
    }
    const settings = bindings.applySettings
      ? {
          before: this.store.settings(),
          after: {
            ...this.store.settings(),
            maxConcurrent: 1,
            memoryPressurePolicy: definition.settings.memoryPressurePolicy ?? 'protect',
          },
        }
      : null;
    assert(
      fresh.every((check) => check()),
      409,
      'A local binding changed while preparing the preview. Review it again.',
    );
    if (settings) fingerprints.push(settings);
    fingerprints.push(preparedProfiles, work);
    return {
      profiles: preparedProfiles,
      work,
      settings,
      warnings: [...new Set(warnings)],
      fingerprint: hash(fingerprints),
    };
  }
  async inspect(value: unknown) {
    assert(
      !this.isBusy(),
      409,
      'Wait for native preparation, execution and source reads before previewing setup.',
    );
    const input = z
      .object({ definition: z.unknown(), bindings: bindingsSchema })
      .strict()
      .parse(value);
    const definition = this.parse(input.definition),
      bindings = input.bindings;
    const prepared = await this.prepare(definition, bindings);
    for (const [id, value] of this.plans) if (value.plan.expiresAt <= now()) this.plans.delete(id);
    assert(
      this.plans.size < 16,
      409,
      'There are too many pending blueprint previews. Wait for one to expire.',
    );
    const plan: BlueprintPlan = {
      id: id(),
      digest: prepared.fingerprint,
      name: definition.name ?? 'Workspace blueprint',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      profiles: prepared.profiles,
      work: prepared.work,
      settings: prepared.settings,
      warnings: prepared.warnings,
    };
    this.plans.set(plan.id, { plan, definition, bindings, fingerprint: prepared.fingerprint });
    return plan;
  }
  async apply(planId: string, digest: string) {
    const previous = this.store.get<BlueprintReceipt>('blueprint_imports', planId);
    if (previous) {
      assert(previous.digest === digest, 409, 'This import ID belongs to another preview.');
      return previous;
    }
    const saved = this.plans.get(planId);
    assert(
      saved && saved.plan.expiresAt > now() && saved.plan.digest === digest,
      409,
      'This preview expired or belongs to another import. Review it again.',
    );
    const checked = await this.prepare(saved.definition, saved.bindings);
    const completed = this.store.get<BlueprintReceipt>('blueprint_imports', planId);
    if (completed) {
      assert(completed.digest === digest, 409, 'This import ID belongs to another preview.');
      return completed;
    }
    assert(
      saved.plan.expiresAt > now(),
      409,
      'This preview expired while checking local sources. Review it again.',
    );
    assert(
      checked.fingerprint === saved.fingerprint,
      409,
      'A native binding, memory source, directory or preference changed after preview. Review the blueprint again.',
    );
    assert(
      !this.isBusy(),
      409,
      'Wait for native preparation, execution and source reads before importing setup.',
    );
    const applied = this.store.transaction(() => {
      const profiles: Record<string, string> = {},
        work: Record<string, string> = {};
      for (const profile of checked.profiles)
        profiles[profile.role] = this.profiles.create({
          name: profile.name,
          instructions: profile.instructions,
          companionSourceId: profile.companion?.id ?? null,
          memorySourceIds: profile.memories.map((memory) => memory.id),
        }).id;
      for (const template of checked.work) {
        const record: Work = {
          id: id(),
          title: template.title,
          project:
            basename(template.directory)
              .slice(0, 80)
              .replace(/[\uD800-\uDBFF]$/, '') || 'Imported project',
          cwd: template.directory,
          goal: template.goal,
          acceptance: template.acceptance,
          context: template.context,
          harness: template.harness,
          accountId: template.account,
          profileId: profiles[template.profileRole],
          priority: 'normal',
          status: 'ready',
          generation: 0,
          revision: 0,
          nativeSessionId: null,
          nativeSessionKey: null,
          activeRunId: null,
          createdAt: now(),
          updatedAt: now(),
        };
        this.store.put('work', record.id, record);
        this.store.event(
          record.id,
          'blueprint',
          'Work template imported',
          `Imported from ${saved.plan.name}. Native execution has not started.`,
        );
        work[template.role] = record.id;
      }
      if (checked.settings) this.store.put('settings', 'workspace', checked.settings.after);
      const receipt: BlueprintReceipt = {
        id: planId,
        digest,
        name: saved.plan.name,
        createdAt: now(),
        rolledBackAt: null,
        profiles,
        work,
        settings: checked.settings,
      };
      this.store.put('blueprint_imports', planId, receipt);
      return receipt;
    });
    this.plans.delete(planId);
    return applied;
  }
  rollback(importId: string) {
    const receipt = this.store.get<BlueprintReceipt>('blueprint_imports', importId);
    assert(receipt, 404, 'This blueprint import was not found.');
    if (receipt.rolledBackAt) return receipt;
    assert(
      !this.isBusy(),
      409,
      'Wait for native preparation, execution and source reads before rollback.',
    );
    return this.store.transaction(() => {
      const workIds = Object.values(receipt.work),
        profileIds = Object.values(receipt.profiles);
      assert(
        workIds.every((id) => {
          const work = this.store.get<Work>('work', id);
          return (
            work &&
            work.revision === 0 &&
            work.generation === 0 &&
            work.status === 'ready' &&
            !work.activeRunId &&
            !work.nativeSessionId
          );
        }),
        409,
        'Imported work has changed or executed. Its history must be preserved.',
      );
      assert(
        !this.store.all<Run>('runs').some((run) => workIds.includes(run.workId)),
        409,
        'Imported work has native run history.',
      );
      assert(
        profileIds.every((id) => this.store.get<AgentProfile>('profiles', id)?.revision === 0),
        409,
        'An imported profile changed after activation.',
      );
      assert(
        !this.store
          .all<Work>('work')
          .some((work) => profileIds.includes(work.profileId ?? '') && !workIds.includes(work.id)),
        409,
        'Other work now references an imported profile.',
      );
      assert(
        !this.store
          .all<Pick<CompanionGrant, 'profileId' | 'revokedAt' | 'expiresAt'>>('companion_grants')
          .some(
            (grant) =>
              profileIds.includes(grant.profileId) && !grant.revokedAt && grant.expiresAt > now(),
          ),
        409,
        'Revoke active companion access before rolling back its profile.',
      );
      if (receipt.settings) {
        assert(
          hash(this.store.settings()) === hash(receipt.settings.after),
          409,
          'Workspace preferences changed after import. Preserve the current settings.',
        );
        this.store.put('settings', 'workspace', receipt.settings.before);
      }
      for (const workId of workIds) {
        assert(
          this.store.recentEvents(workId, 2).length === 1,
          409,
          'Imported work has additional history.',
        );
        for (const event of this.store.recentEvents(workId, 2))
          this.store.remove('events', event.id);
        this.store.remove('work_summaries', workId);
        this.store.remove('work', workId);
      }
      for (const profileId of profileIds) this.profiles.removeProfile(profileId);
      return this.store.put('blueprint_imports', importId, { ...receipt, rolledBackAt: now() });
    });
  }
}
