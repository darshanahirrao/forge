import { z } from 'zod';

// Only these native fields enter Forge. Provider settings, credentials and raw configuration do not.
export const nativeId = z.string().min(1).max(500);
const optionalText = z.string().max(2000).optional();
export const t3Config = z.object({
  environment: z.object({
    environmentId: nativeId,
    orchestrationProtocolVersion: z.number().optional(),
  }),
  providers: z
    .array(
      z.object({
        instanceId: nativeId,
        driver: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/),
        displayName: optionalText,
        enabled: z.boolean(),
        installed: z.boolean(),
        status: z.string(),
        auth: z
          .object({
            status: z.string(),
            label: optionalText,
            email: optionalText,
            profileId: optionalText,
            workspaceId: optionalText,
          })
          .optional(),
        models: z
          .array(
            z
              .object({ slug: nativeId, isDefault: z.boolean().optional() })
              .transform((model) => ({ id: model.slug, isDefault: model.isDefault })),
          )
          .max(1000),
        runtimePaths: z.object({ homePath: z.string().max(2000) }).optional(),
        usageLimits: z
          .object({
            checkedAt: z.string(),
            credentialFingerprint: optionalText,
            windows: z
              .array(
                z.object({
                  id: nativeId,
                  label: z.string().max(500),
                  usedPercent: z.number().min(0).max(100),
                  resetsAt: z.string().optional(),
                }),
              )
              .max(100),
          })
          .optional(),
      }),
    )
    .max(200),
});
export const t3Projects = z.object({
  kind: z.literal('snapshot'),
  snapshot: z.object({
    projects: z
      .array(z.object({ id: nativeId, title: z.string(), workspaceRoot: z.string() }))
      .max(2000),
  }),
});
const usage = z.object({
  usageScope: z.string(),
  usageStatus: z.string(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  cacheCreationTokens: z.number().nonnegative().optional(),
});
export const t3Projection = z.object({
  thread: z.object({
    id: nativeId,
    projectId: nativeId,
    runtimeMode: z.string(),
    worktreePath: z.string().nullable(),
    modelSelection: z.object({ instanceId: nativeId, model: nativeId }),
    activeProviderThreadId: nativeId.nullable(),
  }),
  runs: z
    .array(
      z.object({
        id: nativeId,
        userMessageId: nativeId,
        providerInstanceId: nativeId,
        status: z.string(),
        rootNodeId: nativeId.nullable(),
        providerThreadId: nativeId.nullable(),
        completedAt: z.string().nullable(),
      }),
    )
    .max(10000),
  providerThreads: z
    .array(
      z.object({
        id: nativeId,
        providerInstanceId: nativeId,
        nativeThreadRef: z.object({ nativeId: nativeId, strength: z.string() }).nullable(),
        providerSessionId: nativeId.nullable(),
        pendingBackgroundTasks: z.array(z.unknown()).max(10000).optional(),
      }),
    )
    .max(10000),
  contextHandoffs: z
    .array(z.object({ targetRunId: nativeId, strategy: z.string(), status: z.string() }))
    .max(10000),
  nodes: z.array(z.object({ id: nativeId, runId: nativeId })).max(20000),
  providerTurns: z
    .array(
      z.object({
        id: nativeId,
        nodeId: nativeId,
        status: z.string(),
        turnTokenUsage: usage.optional(),
      }),
    )
    .max(20000),
  runtimeRequests: z
    .array(
      z.object({
        id: nativeId,
        nodeId: nativeId,
        providerTurnId: nativeId.nullable(),
        kind: z.string(),
        status: z.string(),
        nativeRequestRef: z
          .object({
            nativeId: z.union([z.string(), z.number()]),
            strength: z.string(),
            driver: z.string(),
          })
          .nullable(),
        responseCapability: z.object({ type: z.string() }),
      }),
    )
    .max(10000),
  turnItems: z
    .array(
      z.object({
        id: nativeId,
        type: z.string(),
        runId: nativeId.nullable(),
        providerTurnId: nativeId.nullable(),
        requestId: nativeId.optional(),
        prompt: z.string().max(200000).optional(),
        text: z.string().max(400000).optional(),
        options: z
          .array(
            z.object({
              decision: z.string(),
              label: z.string().optional(),
              warning: z.string().optional(),
            }),
          )
          .max(30)
          .optional(),
      }),
    )
    .max(20000),
});
export type T3Projection = z.infer<typeof t3Projection>;
export const terminalRunStates = new Set([
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'rolled_back',
]);
