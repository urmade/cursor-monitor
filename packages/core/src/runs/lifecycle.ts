import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { RunTrigger } from '@nexus/contracts';
import { ACTIVE_RUN_STATUSES } from '@nexus/contracts';
import {
  CursorApiError,
  CursorClient,
  postAutomationWebhook,
} from '@nexus/cursor-client';
import {
  automationBindings,
  mcpCallLog,
  newId,
  projects,
  promptTemplates,
  runs,
  stageInstances,
  stageReports,
  stages,
  workItems,
  type Db,
} from '@nexus/db';
import { resolveBinding } from '../bindings';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { createMcpToken, revokeRunTokens } from '../mcp/tokens';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import { DEFAULT_PROMPT_TEMPLATE, renderPromptTemplate } from './prompt';

export type Run = typeof runs.$inferSelect;

export type LaunchErrorCode =
  | 'run_already_active'
  | 'no_binding'
  | 'orchestration_disabled'
  | 'provider_busy'
  | 'provider_error'
  | 'item_archived'
  | 'daily_cap_exceeded'
  | 'concurrency_ceiling'
  | 'forbidden'
  | 'not_found'
  | 'validation';

function deterministicAgentId(parts: string[]): string {
  const hash = createHash('sha256').update(parts.join(':')).digest('hex');
  return `bc-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function newNonce(): string {
  return randomBytes(16).toString('hex');
}

function publicBaseUrl(): string {
  const raw =
    process.env.DEPLOYMENT_URL ??
    process.env.NEXUS_PUBLIC_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    'http://localhost:3000';
  return raw.replace(/\/$/, '');
}

function protectionBypass(): string | undefined {
  return (
    process.env.VERCEL_PROTECTION_BYPASS ??
    process.env.NEXUS_VERCEL_BYPASS ??
    undefined
  );
}

function cursorApiKey(): string | undefined {
  return (
    process.env.CURSOR_API_KEY ??
    process.env.CURSOR_SERVICE_ACCOUNT_KEY ??
    undefined
  );
}

function projectSettings(project: { settings: Record<string, unknown> }) {
  const s = project.settings ?? {};
  return {
    concurrentRunCeiling: Number(s.concurrentRunCeiling ?? 5),
    dailyRunCap: Number(s.dailyRunCap ?? 50),
  };
}

async function countActiveProjectRuns(db: Db, projectId: string): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as c
    from runs r
    join work_items w on w.id = r.work_item_id
    where w.project_id = ${projectId}
      and r.status in ('pending','launched','running')
  `);
  const arr = rows as unknown as Array<{ c: number }>;
  return Number(arr[0]?.c ?? 0);
}

async function countTodaysProjectRuns(db: Db, projectId: string): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as c
    from runs r
    join work_items w on w.id = r.work_item_id
    where w.project_id = ${projectId}
      and r.created_at >= date_trunc('day', now())
  `);
  const arr = rows as unknown as Array<{ c: number }>;
  return Number(arr[0]?.c ?? 0);
}

export async function listRunsForWorkItem(
  ctx: ServiceContext,
  workItemId: string,
): Promise<Result<Run[], CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));
  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'run.read', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Work item not found'));
  }
  const rows = await ctx.db.query.runs.findMany({
    where: eq(runs.workItemId, workItemId),
    orderBy: [desc(runs.createdAt)],
  });
  return ok(rows);
}

export async function getRun(
  ctx: ServiceContext,
  runId: string,
): Promise<Result<Run, CoreError>> {
  const row = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!row) return err(coreError('not_found', 'Run not found'));
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, row.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Run not found'));
  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'run.read', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Run not found'));
  }
  return ok(row);
}

export async function launchRun(
  ctx: ServiceContext,
  input: {
    workItemId: string;
    bindingId?: string;
    trigger?: RunTrigger;
    resumeAgentId?: string | null;
    forceFreshAgent?: boolean;
    /**
     * Vitest-only: return after the advisory-lock transaction persists a pending run.
     * Ignored outside `process.env.VITEST === 'true'` so production never skips provider I/O.
     */
    _testStopAfterPersist?: boolean;
  },
): Promise<Result<Run, CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, input.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));
  if (item.archivedAt) {
    return err(coreError('item_archived', 'Work item is archived'));
  }

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'run.launch', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot launch runs'));
  }

  if (!(await ctx.flags.isEnabled('p2.runs', item.projectId))) {
    return err(coreError('orchestration_disabled', 'p2.runs flag disabled'));
  }
  if (!(await ctx.flags.isEnabled('orchestration.enabled', item.projectId))) {
    return err(
      coreError('orchestration_disabled', 'Global orchestration kill switch is off'),
    );
  }

  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, item.projectId),
  });
  if (!project) return err(coreError('not_found', 'Project not found'));
  const settings = projectSettings(project);

  const activeCount = await countActiveProjectRuns(ctx.db, item.projectId);
  if (activeCount >= settings.concurrentRunCeiling) {
    return err(
      coreError(
        'concurrency_ceiling',
        `Project concurrent run ceiling (${settings.concurrentRunCeiling}) reached`,
      ),
    );
  }
  const todayCount = await countTodaysProjectRuns(ctx.db, item.projectId);
  if (todayCount >= settings.dailyRunCap) {
    return err(
      coreError(
        'daily_cap_exceeded',
        `Project daily run cap (${settings.dailyRunCap}) reached`,
      ),
    );
  }

  // One-active-run enforced by partial unique index; pre-check for clearer errors.
  const existingActive = await ctx.db.query.runs.findFirst({
    where: and(
      eq(runs.workItemId, item.id),
      inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
    ),
  });
  if (existingActive) {
    return err(
      coreError('run_already_active', 'An active run already exists for this work item', {
        runId: existingActive.id,
      }),
    );
  }

  let binding = input.bindingId
    ? await ctx.db.query.automationBindings.findFirst({
        where: and(
          eq(automationBindings.id, input.bindingId),
          eq(automationBindings.projectId, item.projectId),
          isNull(automationBindings.archivedAt),
        ),
      })
    : null;

  if (!binding) {
    const resolved = await resolveBinding(ctx, { workItemId: item.id });
    if (!resolved.ok || !resolved.value.binding) {
      return err(coreError('no_binding', 'No automation binding for this stage'));
    }
    binding = resolved.value.binding;
  }

  if (!item.currentStageInstanceId) {
    return err(coreError('invariant', 'Work item has no current stage instance'));
  }
  const stageInstanceId = item.currentStageInstanceId;

  const stage = await ctx.db.query.stages.findFirst({
    where: eq(stages.id, item.currentStageId),
  });
  if (!stage) return err(coreError('invariant', 'Stage missing'));

  const config = binding.config as Record<string, unknown>;
  const maxDurationMinutes = Number(config.maxDurationMinutes ?? 60);
  const previousAttempts = await ctx.db.query.runs.findMany({
    where: and(
      eq(runs.workItemId, item.id),
      eq(runs.stageInstanceId, item.currentStageInstanceId),
      eq(runs.bindingId, binding.id),
    ),
  });
  const attempt = previousAttempts.length + 1;

  const promptTemplateId = binding.promptTemplateId;
  let promptBody = DEFAULT_PROMPT_TEMPLATE;
  if (promptTemplateId) {
    const tpl = await ctx.db.query.promptTemplates.findFirst({
      where: eq(promptTemplates.id, promptTemplateId),
    });
    if (tpl) promptBody = tpl.body;
  }

  const runId = newId();
  const nonce = newNonce();
  const now = ctx.clock();
  const deadlineAt = new Date(now.getTime() + maxDurationMinutes * 60_000);
  const trigger: RunTrigger = input.trigger ?? {
    kind: 'manual',
    by: ctx.actor,
  };

  const budgetCheck = await (
    await import('../budgets/check')
  ).checkBudget(ctx, { workItemId: item.id });
  if (!budgetCheck.ok) {
    return err(budgetCheck.error);
  }
  if (!budgetCheck.value.allow) {
    const code =
      budgetCheck.value.reason === 'project_burn'
        ? 'budget_burn'
        : budgetCheck.value.reason === 'item_paused'
          ? 'budget_paused'
          : budgetCheck.value.reason === 'budget_unavailable'
            ? 'budget_unavailable'
            : 'budget_hard';
    return err(coreError(code, budgetCheck.value.detail, {
      reason: budgetCheck.value.reason,
    }));
  }

  let launchBlocked: CoreError | null = null;

  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${item.projectId}), 51004)`,
    );

    const txCtx: ServiceContext = { ...ctx, db: tx };

    const existingInTx = await tx.query.runs.findFirst({
      where: and(
        eq(runs.workItemId, item.id),
        inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
      ),
    });
    if (existingInTx) {
      launchBlocked = coreError('run_already_active', 'An active run already exists for this work item', {
        runId: existingInTx.id,
      });
      return;
    }

    const budgetInTx = await (
      await import('../budgets/check')
    ).checkBudget(txCtx, { workItemId: item.id });
    if (!budgetInTx.ok) {
      launchBlocked = budgetInTx.error;
      return;
    }
    if (!budgetInTx.value.allow) {
      const code =
        budgetInTx.value.reason === 'project_burn'
          ? 'budget_burn'
          : budgetInTx.value.reason === 'item_paused'
            ? 'budget_paused'
            : budgetInTx.value.reason === 'budget_unavailable'
              ? 'budget_unavailable'
              : 'budget_hard';
      launchBlocked = coreError(code, budgetInTx.value.detail, {
        reason: budgetInTx.value.reason,
      });
      return;
    }

    await tx.insert(runs).values({
      id: runId,
      workItemId: item.id,
      stageInstanceId,
      bindingId: binding.id,
      promptTemplateId: promptTemplateId ?? null,
      adapter: binding.adapter,
      trigger,
      status: 'pending',
      nonce,
      attempt,
      deadlineAt,
      model: typeof config.model === 'string' ? config.model : null,
    });

    await tx
      .update(workItems)
      .set({ currentRunId: runId, updatedAt: now })
      .where(eq(workItems.id, item.id));
  });

  if (launchBlocked) {
    return err(launchBlocked);
  }

  if (input._testStopAfterPersist === true && process.env.VITEST === 'true') {
    const pending = await ctx.db.query.runs.findFirst({
      where: eq(runs.id, runId),
    });
    if (!pending) {
      return err(coreError('invariant', 'Pending run row missing after persist'));
    }
    return ok(pending);
  }

  // Persist run BEFORE provider call so timeouts leave a record — done inside advisory lock above.

  const minted = await createMcpToken(ctx.db, {
    runId,
    workItemId: item.id,
    projectId: item.projectId,
  });

  const promptText = renderPromptTemplate(promptBody, {
    ticket: { id: item.id, key: item.key, title: item.title },
    stage: { name: stage.name, key: stage.key },
    run: { nonce, id: runId },
  });

  try {
    if (binding.adapter === 'cloud_agent') {
      const apiKey = cursorApiKey();
      if (!apiKey) {
        throw new Error('CURSOR_API_KEY not configured');
      }
      const client = new CursorClient({ apiKey });
      const useFollowUp =
        input.resumeAgentId && !input.forceFreshAgent && input.trigger?.kind === 'resume';
      const agentId = useFollowUp
        ? input.resumeAgentId!
        : deterministicAgentId([
            item.id,
            item.currentStageInstanceId,
            binding.id,
            String(attempt),
          ]);
      const mcpUrl = `${publicBaseUrl()}/api/mcp`;
      const bypass = protectionBypass();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${minted.rawToken}`,
      };
      if (bypass) headers['x-vercel-protection-bypass'] = bypass;

      const noRepo = config.noRepo === true || !config.repoUrl;
      const body = {
        agentId,
        name: `nexus-${item.key}-${stage.key}`,
        prompt: { text: promptText },
        model: typeof config.model === 'string' ? { id: config.model } : undefined,
        autoCreatePR: Boolean(config.autoCreatePR),
        mcpServers: [
          {
            name: 'nexus',
            type: 'http' as const,
            url: mcpUrl,
            headers,
          },
        ],
        ...(noRepo
          ? {}
          : {
              repos: [
                {
                  url: String(config.repoUrl),
                  startingRef: String(config.startingRef ?? 'main'),
                },
              ],
            }),
      };

      let created;
      try {
        if (useFollowUp) {
          const follow = await client.createRun(agentId, {
            prompt: { text: promptText },
            mcpServers: body.mcpServers,
            model: body.model,
          });
          created = {
            agent: { id: agentId, url: `https://cursor.com/agents/${agentId}` },
            run: { id: follow.id, status: follow.status },
          };
        } else {
          created = await client.createAgent(body);
        }
      } catch (e) {
        if (
          e instanceof CursorApiError &&
          (e.code === 'agent_busy' || e.code === 'agent_id_conflict')
        ) {
          if (e.code === 'agent_busy' || useFollowUp) {
            throw new CursorApiError({
              message: 'agent_busy',
              status: 409,
              code: 'agent_busy',
            });
          }
          // Adopt existing agent — create a follow-up run on it.
          const follow = await client.createRun(agentId, {
            prompt: { text: promptText },
            mcpServers: body.mcpServers,
            model: body.model,
          });
          created = {
            agent: { id: agentId, url: `https://cursor.com/agents/${agentId}` },
            run: { id: follow.id, status: follow.status },
          };
        } else {
          throw e;
        }
      }

      const providerAgentId = created.agent.id;
      const providerRunId = created.run.id;
      const providerUrl =
        (typeof created.agent.url === 'string' && created.agent.url) ||
        `https://cursor.com/agents/${providerAgentId}`;

      const [updated] = await ctx.db
        .update(runs)
        .set({
          status: 'launched',
          providerAgentId,
          providerRunId,
          providerUrl,
          launchedAt: ctx.clock(),
        })
        .where(eq(runs.id, runId))
        .returning();

      await emit(ctx.db, {
        orgId: ctx.orgId,
        projectId: item.projectId,
        type: 'run.launched',
        subjectType: 'run',
        subjectId: runId,
        actor: ctx.actor,
        payload: {
          workItemId: item.id,
          bindingId: binding.id,
          providerAgentId,
          providerRunId,
          adapter: 'cloud_agent',
        },
      });

      // Enqueue first poll
      await enqueuePoll(ctx.db, runId, 5);

      return ok(updated!);
    }

    // automation_webhook adapter
    const secretKey = String(config.webhookUrlSecretKey ?? '');
    const webhookUrl = secretKey ? process.env[secretKey] : undefined;
    if (!webhookUrl) {
      throw new Error(
        `Webhook secret key ${secretKey || '(missing)'} is not set in environment`,
      );
    }
    const automationKey =
      process.env.CURSOR_AUTOMATION_KEY ?? process.env.CURSOR_API_KEY ?? '';
    await postAutomationWebhook({
      webhookUrl,
      automationKey,
      payload: {
        ticket_id: item.id,
        nonce,
        stage: stage.key,
        mcp_url: `${publicBaseUrl()}/api/mcp`,
      },
    });

    const [updated] = await ctx.db
      .update(runs)
      .set({
        status: 'launched',
        launchedAt: ctx.clock(),
      })
      .where(eq(runs.id, runId))
      .returning();

    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: item.projectId,
      type: 'run.launched',
      subjectType: 'run',
      subjectId: runId,
      actor: ctx.actor,
      payload: {
        workItemId: item.id,
        bindingId: binding.id,
        adapter: 'automation_webhook',
      },
    });

    await enqueuePoll(ctx.db, runId, 15);
    return ok(updated!);
  } catch (e) {
    const mapped =
      e instanceof CursorApiError && e.code === 'agent_busy'
        ? 'provider_busy'
        : 'provider_error';
    const message = e instanceof Error ? e.message : String(e);
    const [failed] = await ctx.db
      .update(runs)
      .set({
        status: 'launch_failed',
        terminalAt: ctx.clock(),
        errorCode: mapped,
        errorDetail: message.slice(0, 2000),
      })
      .where(eq(runs.id, runId))
      .returning();

    await revokeRunTokens(ctx.db, runId);
    await ctx.db
      .update(workItems)
      .set({ currentRunId: null, updatedAt: ctx.clock() })
      .where(and(eq(workItems.id, item.id), eq(workItems.currentRunId, runId)));

    await emit(ctx.db, {
      orgId: ctx.orgId,
      projectId: item.projectId,
      type: 'run.launch_failed',
      subjectType: 'run',
      subjectId: runId,
      actor: ctx.actor,
      payload: { errorCode: mapped, message: message.slice(0, 500) },
    });

    try {
      const { captureRunCostAtCloseOut } = await import('../cost/capture');
      await captureRunCostAtCloseOut(ctx, runId);
    } catch (captureErr) {
      ctx.logger.warn(
        {
          err: captureErr instanceof Error ? captureErr.message : String(captureErr),
          runId,
        },
        'cost capture failed for launch_failed run',
      );
    }

    return err(
      coreError(mapped, message, { runId, run: failed }),
    );
  }
}

async function enqueuePoll(db: Db, runId: string, delaySec: number): Promise<void> {
  const { jobs } = await import('@nexus/db');
  await db
    .insert(jobs)
    .values({
      id: newId(),
      kind: 'poll_run',
      payload: { runId },
      runAfter: new Date(Date.now() + delaySec * 1000),
      dedupeKey: `poll_run:${runId}:${Math.floor(Date.now() / 1000)}`,
      priority: 10,
    })
    .onConflictDoNothing();
}

export function nextPollDelaySec(pollAttempts: number, ageMs: number): number {
  if (ageMs < 60_000) return 5;
  if (ageMs < 5 * 60_000) return 15;
  return 60;
}

function mapProviderStatus(status: string): {
  status: string;
  terminal: boolean;
} {
  const s = status.toUpperCase();
  if (s === 'RUNNING' || s === 'CREATING' || s === 'PENDING') {
    return { status: s === 'RUNNING' ? 'running' : 'launched', terminal: false };
  }
  if (s === 'FINISHED' || s === 'COMPLETED' || s === 'SUCCESS') {
    return { status: 'completed', terminal: true };
  }
  if (s === 'FAILED' || s === 'ERROR') {
    return { status: 'failed', terminal: true };
  }
  if (s === 'CANCELLED' || s === 'CANCELED') {
    return { status: 'cancelled', terminal: true };
  }
  if (s === 'EXPIRED') {
    return { status: 'expired', terminal: true };
  }
  return { status: 'running', terminal: false };
}

export async function pollRun(
  ctx: ServiceContext,
  runId: string,
): Promise<Result<Run, CoreError>> {
  const run = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) return err(coreError('not_found', 'Run not found'));

  if (!ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
    return ok(run);
  }

  const now = ctx.clock();
  if (run.deadlineAt.getTime() <= now.getTime()) {
    return closeOutRun(ctx, runId, {
      forcedStatus: 'expired',
      errorCode: 'deadline',
      errorDetail: 'Run exceeded deadline; cancel not required for recovery',
    });
  }

  // Webhook adapter without provider ids: only deadline + report presence.
  if (run.adapter === 'automation_webhook' && !run.providerAgentId) {
    const report = await ctx.db.query.stageReports.findFirst({
      where: eq(stageReports.runId, runId),
    });
    if (report) {
      return closeOutRun(ctx, runId, { forcedStatus: 'completed' });
    }
    await ctx.db
      .update(runs)
      .set({
        lastPolledAt: now,
        pollAttempts: run.pollAttempts + 1,
        status: run.status === 'pending' ? 'launched' : run.status,
      })
      .where(eq(runs.id, runId));
    const ageMs = now.getTime() - (run.launchedAt ?? run.createdAt).getTime();
    await enqueuePoll(ctx.db, runId, nextPollDelaySec(run.pollAttempts + 1, ageMs));
    const refreshed = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
    return ok(refreshed!);
  }

  const apiKey = cursorApiKey();
  if (!apiKey || !run.providerAgentId || !run.providerRunId) {
    await ctx.db
      .update(runs)
      .set({ lastPolledAt: now, pollAttempts: run.pollAttempts + 1 })
      .where(eq(runs.id, runId));
    const ageMs = now.getTime() - (run.launchedAt ?? run.createdAt).getTime();
    await enqueuePoll(ctx.db, runId, nextPollDelaySec(run.pollAttempts + 1, ageMs));
    return ok(run);
  }

  const client = new CursorClient({ apiKey });
  try {
    const providerRun = await client.getRun(run.providerAgentId, run.providerRunId);
    const mapped = mapProviderStatus(providerRun.status);

    if (!mapped.terminal) {
      const nextStatus = mapped.status === 'running' ? 'running' : run.status;
      const patch: Partial<Run> = {
        lastPolledAt: now,
        pollAttempts: run.pollAttempts + 1,
        status: nextStatus,
      };
      if (nextStatus === 'running' && !run.startedAt) {
        patch.startedAt = now;
        await emit(ctx.db, {
          orgId: ctx.orgId,
          projectId: (
            await ctx.db.query.workItems.findFirst({
              where: eq(workItems.id, run.workItemId),
            })
          )?.projectId,
          type: 'run.started',
          subjectType: 'run',
          subjectId: runId,
          actor: { kind: 'system', reason: 'poll_run' },
          payload: {},
        });
      }
      await ctx.db.update(runs).set(patch).where(eq(runs.id, runId));
      const ageMs = now.getTime() - (run.launchedAt ?? run.createdAt).getTime();
      await enqueuePoll(ctx.db, runId, nextPollDelaySec(run.pollAttempts + 1, ageMs));
      const refreshed = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
      return ok(refreshed!);
    }

    // Terminal from provider — fetch usage then close out.
    let tokens: Record<string, unknown> | null = null;
    let usageUuid: string | null = null;
    const gitSnapshot: unknown = providerRun.git?.branches ?? null;
    try {
      const usage = await client.getUsage(run.providerAgentId, run.providerRunId);
      tokens = {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheWrite: usage.cacheWriteTokens,
        cacheRead: usage.cacheReadTokens,
        total:
          (usage.inputTokens ?? 0) +
          (usage.outputTokens ?? 0) +
          (usage.cacheWriteTokens ?? 0) +
          (usage.cacheReadTokens ?? 0),
        chargedCents:
          typeof (usage as { chargedCents?: unknown }).chargedCents === 'number'
            ? (usage as { chargedCents: number }).chargedCents
            : undefined,
        rawCostCents:
          typeof (usage as { rawCostCents?: unknown }).rawCostCents === 'number'
            ? (usage as { rawCostCents: number }).rawCostCents
            : undefined,
      };
      usageUuid = usage.usageUuid ?? null;
    } catch (usageErr) {
      ctx.logger.warn(
        { err: String(usageErr), runId },
        'usage fetch failed; closing without tokens',
      );
    }

    await ctx.db
      .update(runs)
      .set({
        tokens,
        usageUuid,
        gitSnapshot: gitSnapshot as Record<string, unknown> | null,
        durationMs: providerRun.durationMs ?? null,
        lastPolledAt: now,
        pollAttempts: run.pollAttempts + 1,
      })
      .where(eq(runs.id, runId));

    return closeOutRun(ctx, runId, {
      forcedStatus: mapped.status as
        | 'completed'
        | 'failed'
        | 'cancelled'
        | 'expired',
    });
  } catch (e) {
    ctx.logger.warn({ err: String(e), runId }, 'poll_run provider error');
    await ctx.db
      .update(runs)
      .set({ lastPolledAt: now, pollAttempts: run.pollAttempts + 1 })
      .where(eq(runs.id, runId));
    const ageMs = now.getTime() - (run.launchedAt ?? run.createdAt).getTime();
    await enqueuePoll(ctx.db, runId, nextPollDelaySec(run.pollAttempts + 1, ageMs));
    return ok(run);
  }
}

export async function closeOutRun(
  ctx: ServiceContext,
  runId: string,
  opts?: {
    forcedStatus?:
      | 'completed'
      | 'completed_no_report'
      | 'failed'
      | 'cancelled'
      | 'expired';
    errorCode?: string;
    errorDetail?: string;
  },
): Promise<Result<Run, CoreError>> {
  const run = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) return err(coreError('not_found', 'Run not found'));

  if (
    !ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number]) &&
    run.status !== 'pending'
  ) {
    const item = await ctx.db.query.workItems.findFirst({
      where: eq(workItems.id, run.workItemId),
    });
    if (item?.currentRunId === runId) {
      const report = await ctx.db.query.stageReports.findFirst({
        where: eq(stageReports.runId, runId),
      });
      await completeRunAfterTerminal(ctx, {
        run,
        status: run.status,
        report,
        now: run.terminalAt ?? ctx.clock(),
        durationMs: run.durationMs,
      });
    }
    if (run.costMicroUsd == null) {
      await captureAtCloseOutBestEffort(ctx, runId);
    }
    const refreshed = await ctx.db.query.runs.findFirst({
      where: eq(runs.id, runId),
    });
    return ok(refreshed ?? run);
  }

  const report = await ctx.db.query.stageReports.findFirst({
    where: eq(stageReports.runId, runId),
  });

  let status =
    opts?.forcedStatus ??
    (report ? 'completed' : 'completed_no_report');

  // Provider said completed but no MCP report → completed_no_report (Phase 0 proven).
  if (status === 'completed' && !report) {
    status = 'completed_no_report';
  }

  const now = ctx.clock();
  const durationMs =
    run.durationMs ??
    (run.launchedAt ? now.getTime() - run.launchedAt.getTime() : null);

  const [updated] = await ctx.db
    .update(runs)
    .set({
      status,
      terminalAt: now,
      durationMs,
      outcome: report?.outcome ?? run.outcome,
      errorCode: opts?.errorCode ?? run.errorCode,
      errorDetail: opts?.errorDetail ?? run.errorDetail,
    })
    .where(eq(runs.id, runId))
    .returning();

  await completeRunAfterTerminal(ctx, {
    run,
    status,
    report,
    now,
    durationMs,
  });

  await captureAtCloseOutBestEffort(ctx, runId);

  const finalRun = await ctx.db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });

  return ok(finalRun ?? updated!);
}

async function captureAtCloseOutBestEffort(
  ctx: ServiceContext,
  runId: string,
): Promise<void> {
  try {
    const { captureRunCostAtCloseOut } = await import('../cost/capture');
    const captured = await captureRunCostAtCloseOut(ctx, runId);
    if (!captured.ok) {
      ctx.logger.warn(
        { err: captured.error.message, runId },
        'cost capture failed at close-out (will retry on next close-out)',
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.logger.warn(
      { err: message, runId },
      'cost capture threw at close-out (will retry on next close-out)',
    );
  }
}

async function completeRunAfterTerminal(
  ctx: ServiceContext,
  input: {
    run: Run;
    status: string;
    report: { outcome: string | null } | null | undefined;
    now: Date;
    durationMs: number | null;
  },
): Promise<void> {
  const { run, status, report, now, durationMs } = input;
  const runId = run.id;

  await revokeRunTokens(ctx.db, runId);

  await ctx.db
    .update(workItems)
    .set({ currentRunId: null, updatedAt: now })
    .where(and(eq(workItems.id, run.workItemId), eq(workItems.currentRunId, runId)));

  if (report) {
    await ctx.db
      .update(stageInstances)
      .set({ outcome: report.outcome })
      .where(eq(stageInstances.id, run.stageInstanceId));
  }

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, run.workItemId),
  });

  const eventType =
    status === 'completed'
      ? 'run.finished'
      : status === 'completed_no_report'
        ? 'run.completed_without_report'
        : status === 'cancelled'
          ? 'run.cancelled'
          : status === 'expired'
            ? 'run.expired'
            : 'run.failed';

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item?.projectId,
    type: eventType,
    subjectType: 'run',
    subjectId: runId,
    actor: { kind: 'system', reason: 'closeOutRun' },
    payload: {
      status,
      workItemId: run.workItemId,
      hasReport: Boolean(report),
      durationMs,
    },
  });

  if (status === 'completed' || status === 'completed_no_report') {
    try {
      const { evaluateOnRunFinished } = await import('../gates/events');
      const stageInst = await ctx.db.query.stageInstances.findFirst({
        where: eq(stageInstances.id, run.stageInstanceId),
      });
      const result = await evaluateOnRunFinished(ctx, {
        workItemId: run.workItemId,
        stageId: stageInst?.stageId,
      });
      if (!result.ok) {
        ctx.logger.warn(
          { err: result.error.message, runId },
          'gate evaluation on run finished failed',
        );
      }
    } catch (e) {
      ctx.logger.warn(
        { err: e instanceof Error ? e.message : String(e), runId },
        'gate evaluation on run finished threw',
      );
    }
  }
}

export async function cancelRun(
  ctx: ServiceContext,
  runId: string,
  reason?: string,
): Promise<Result<Run, CoreError>> {
  const run = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) return err(coreError('not_found', 'Run not found'));

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, run.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'run.cancel', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('forbidden', 'Cannot cancel runs'));
  }

  if (!ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
    return ok(run);
  }

  let providerCancelFailed: string | null = null;
  if (run.providerAgentId && run.providerRunId) {
    const apiKey = cursorApiKey();
    if (apiKey) {
      try {
        const client = new CursorClient({ apiKey });
        await client.cancelRun(run.providerAgentId, run.providerRunId);
      } catch (e) {
        // Phase 0: cancel may 500 while run stays RUNNING — keep observing.
        providerCancelFailed = e instanceof Error ? e.message : String(e);
        ctx.logger.warn(
          { runId, err: providerCancelFailed },
          'provider cancel failed; continuing observation',
        );
      }
    }
  }

  if (providerCancelFailed) {
    await ctx.db
      .update(runs)
      .set({
        errorCode: 'cancel_provider_failed',
        errorDetail: providerCancelFailed.slice(0, 2000),
      })
      .where(eq(runs.id, runId));
    // Keep polling — do not mark cancelled until provider terminal or deadline.
    await enqueuePoll(ctx.db, runId, 5);
    const refreshed = await ctx.db.query.runs.findFirst({ where: eq(runs.id, runId) });
    return ok(refreshed!);
  }

  return closeOutRun(ctx, runId, {
    forcedStatus: 'cancelled',
    errorCode: 'cancelled',
    errorDetail: reason ?? 'Cancelled by user',
  });
}

export async function sweepStuckRuns(ctx: ServiceContext): Promise<number> {
  const stuck = await ctx.db.query.runs.findMany({
    where: and(
      inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
      sql`${runs.deadlineAt} <= now()`,
    ),
    limit: 50,
  });
  let n = 0;
  for (const run of stuck) {
    await closeOutRun(ctx, run.id, {
      forcedStatus: 'expired',
      errorCode: 'stuck_watchdog',
      errorDetail: 'Force-terminated by sweep_stuck_runs',
    });
    n += 1;
  }
  return n;
}

export async function logMcpCall(
  db: Db,
  input: {
    tokenId?: string | null;
    runId?: string | null;
    workItemId?: string | null;
    tool: string;
    ok: boolean;
    errorCode?: string | null;
    durationMs?: number;
    requestBytes?: number;
    responseBytes?: number;
  },
): Promise<void> {
  await db.insert(mcpCallLog).values({
    id: newId(),
    tokenId: input.tokenId ?? null,
    runId: input.runId ?? null,
    workItemId: input.workItemId ?? null,
    tool: input.tool,
    ok: input.ok,
    errorCode: input.errorCode ?? null,
    durationMs: input.durationMs ?? null,
    requestBytes: input.requestBytes ?? null,
    responseBytes: input.responseBytes ?? null,
  });
}
