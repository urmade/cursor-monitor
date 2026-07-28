import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  RUBRIC_EVAL_HOURLY_CAP,
  RUBRIC_EVAL_TIMEOUT_MS,
  RubricCriteriaSchema,
  type RubricCriterion,
  type RubricVerdict,
} from '@nexus/contracts';
import {
  newId,
  rubricVerdicts,
  rubrics,
  runs,
  specVersions,
  stageReports,
  workItems,
} from '@nexus/db';
import { can } from '../authz/can';
import type { ServiceContext } from '../context';
import { applyCostRollups } from '../cost/rollups';
import { type MicroUsd } from '../cost/money';
import { coreError, type CoreError } from '../errors';
import { emit } from '../events/emit';
import { checkRateLimitWindow } from '../redis/rate-limit';
import { getProjectRole } from '../projects/members';
import { err, ok, type Result } from '../result';
import {
  isCircuitOpen,
  recordCircuitFailure,
  recordCircuitSuccess,
} from './circuit';
import {
  applyUncertaintyPolicy,
  assembleRubricPrompt,
  contentHash,
  parseVerdictJson,
  validateVerdict,
} from './prompt';
import { resolveModelProvider } from './provider';

export type StoredVerdict = typeof rubricVerdicts.$inferSelect;

export type EvaluateRubricResult = {
  verdict: RubricVerdict | null;
  outcome: 'pass' | 'warn' | 'block' | 'error';
  stored: StoredVerdict;
  cacheHit: boolean;
  reason?: string;
  modelOutcome?: 'pass' | 'warn' | 'block';
};

export const INFRA_CONTENT_HASH = {
  circuit_open: 'circuit_open',
  rate_limited: 'rate_limited',
  budget_blocked: 'budget_blocked',
  evaluator_timeout: 'evaluator_timeout',
  provider_unavailable: 'provider_unavailable',
  provider_error: 'provider_error',
  schema_invalid: 'schema_invalid',
} as const;

export function estimateMicroFromTokens(
  model: string,
  tokens?: { input?: number; output?: number },
  opts?: { promptChars?: number; maxOutputTokens?: number },
): MicroUsd {
  const rates = modelRates(model);
  let input = tokens?.input;
  let output = tokens?.output;
  if (input == null && opts?.promptChars != null) {
    input = Math.max(1, Math.ceil(opts.promptChars / 4));
  }
  if (output == null && opts?.maxOutputTokens != null) {
    output = Math.max(1, Math.ceil(opts.maxOutputTokens * 0.25));
  }
  input = input ?? 0;
  output = output ?? 0;
  const usd =
    (input / 1_000_000) * rates.inputPerM +
    (output / 1_000_000) * rates.outputPerM;
  return BigInt(Math.max(0, Math.round(usd * 1_000_000)));
}

function modelRates(model: string): { inputPerM: number; outputPerM: number } {
  const m = model.toLowerCase();
  if (m.includes('gpt-4o-mini') || m.includes('fixture')) {
    return { inputPerM: 0.15, outputPerM: 0.6 };
  }
  if (m.includes('gpt-4o') && !m.includes('mini')) {
    return { inputPerM: 2.5, outputPerM: 10 };
  }
  if (m.includes('gpt-4.1') || m.includes('gpt-4-turbo')) {
    return { inputPerM: 10, outputPerM: 30 };
  }
  if (m.includes('o3') || m.includes('o1')) {
    return { inputPerM: 15, outputPerM: 60 };
  }
  return { inputPerM: 0.15, outputPerM: 0.6 };
}

async function loadArtefact(
  ctx: ServiceContext,
  input: {
    workItemId: string;
    target: 'spec' | 'stage_report';
  },
): Promise<
  Result<{ json: string; targetRef: string; targetKind: 'spec' | 'stage_report' }, CoreError>
> {
  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, input.workItemId), isNull(workItems.archivedAt)),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));

  if (input.target === 'spec') {
    if (!item.currentSpecVersionId) {
      return err(coreError('validation', 'No spec to evaluate'));
    }
    const spec = await ctx.db.query.specVersions.findFirst({
      where: eq(specVersions.id, item.currentSpecVersionId),
    });
    if (!spec) return err(coreError('not_found', 'Spec version not found'));
    return ok({
      json: JSON.stringify(spec.content),
      targetRef: spec.id,
      targetKind: 'spec',
    });
  }

  const report = await ctx.db.query.stageReports.findFirst({
    where: eq(stageReports.workItemId, input.workItemId),
    orderBy: [desc(stageReports.createdAt)],
  });
  if (!report) {
    return err(coreError('validation', 'No stage report to evaluate'));
  }
  return ok({
    json: JSON.stringify({
      outcome: report.outcome,
      headline: report.headline,
      summary: report.summary,
      confidence: report.confidence,
      not_verified: report.notVerified,
      assumptions: report.assumptions,
    }),
    targetRef: report.id,
    targetKind: 'stage_report',
  });
}

async function recordInternalLlmRun(
  ctx: ServiceContext,
  input: {
    workItemId: string;
    projectId: string;
    model: string;
    tokens: { input?: number; output?: number; total?: number } | null;
    costMicro: MicroUsd;
    durationMs: number;
    trigger: Record<string, unknown>;
  },
): Promise<string | null> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, input.workItemId),
  });
  if (!item?.currentStageInstanceId) return null;

  const runId = newId();
  const now = new Date();
  await ctx.db.insert(runs).values({
    id: runId,
    workItemId: input.workItemId,
    stageInstanceId: item.currentStageInstanceId,
    bindingId: null,
    promptTemplateId: null,
    adapter: 'internal_llm',
    trigger: input.trigger,
    status: 'completed',
    nonce: `llm-${runId}`,
    attempt: 1,
    model: input.model,
    launchedAt: now,
    startedAt: now,
    terminalAt: now,
    deadlineAt: now,
    durationMs: input.durationMs,
    tokens: input.tokens,
    outcome: 'completed',
    costEstimateMicroUsd: input.costMicro,
    costActualMicroUsd: input.costMicro,
    costMicroUsd: input.costMicro,
    costSource: 'estimated',
  });

  if (input.costMicro > BigInt(0)) {
    await applyCostRollups(ctx.db, {
      runId,
      workItemId: input.workItemId,
      stageInstanceId: item.currentStageInstanceId,
      projectId: input.projectId,
      deltaMicro: input.costMicro,
      costSource: 'estimated',
    });
  }
  return runId;
}

export async function evaluateRubric(
  ctx: ServiceContext,
  input: {
    rubricId: string;
    workItemId: string;
    /** Override target; defaults to rubric.target */
    target?: 'spec' | 'stage_report';
    gateEvaluationId?: string;
    skipCache?: boolean;
    /** Skip auth for system/job callers that already authorised the gate path. */
    skipAuthz?: boolean;
    artefactOverride?: {
      json: string;
      targetKind: 'spec' | 'stage_report';
      targetRef?: string;
    };
  },
): Promise<Result<EvaluateRubricResult, CoreError>> {
  const rubric = await ctx.db.query.rubrics.findFirst({
    where: and(eq(rubrics.id, input.rubricId), isNull(rubrics.archivedAt)),
  });
  if (!rubric) return err(coreError('not_found', 'Rubric not found'));

  const item = await ctx.db.query.workItems.findFirst({
    where: and(eq(workItems.id, input.workItemId), isNull(workItems.archivedAt)),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));
  if (item.projectId !== rubric.projectId) {
    return err(coreError('validation', 'Rubric and work item project mismatch'));
  }

  if (!input.skipAuthz) {
    const role = await getProjectRole(ctx, item.projectId);
    if (
      !can(ctx.actor, 'work_item.read', {
        type: 'work_item',
        projectId: item.projectId,
        role,
      })
    ) {
      return err(coreError('not_found', 'Work item not found'));
    }
  }

  if (await isCircuitOpen(item.projectId)) {
    const id = newId();
    const stored = await persistErrorVerdict(ctx, {
      id,
      rubric,
      workItemId: input.workItemId,
      gateEvaluationId: input.gateEvaluationId,
      targetKind: rubric.target,
      targetRef: item.currentSpecVersionId ?? item.id,
      contentHash: INFRA_CONTENT_HASH.circuit_open,
      headline: 'Agentic gates temporarily unavailable',
      errorCode: 'circuit_open',
      durationMs: 0,
    });
    return ok({
      verdict: null,
      outcome: 'warn',
      stored,
      cacheHit: false,
      reason: 'circuit_open',
    });
  }

  try {
    const { checkBudget } = await import('../budgets/check');
    const budget = await checkBudget(ctx, {
      workItemId: input.workItemId,
      reserve: false,
    });
    if (budget.ok && !budget.value.allow) {
      const id = newId();
      const stored = await persistErrorVerdict(ctx, {
        id,
        rubric,
        workItemId: input.workItemId,
        gateEvaluationId: input.gateEvaluationId,
        targetKind: rubric.target,
        targetRef: item.currentSpecVersionId ?? item.id,
        contentHash: INFRA_CONTENT_HASH.budget_blocked,
        headline: `Budget blocked: ${budget.value.detail}`,
        errorCode: 'budget_blocked',
        durationMs: 0,
        rawResponse: { reason: budget.value.reason },
      });
      return ok({
        verdict: null,
        outcome: 'warn',
        stored,
        cacheHit: false,
        reason: 'budget_blocked',
      });
    }
  } catch (e) {
    ctx.logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'rubric.budget_check_failed',
    );
  }

  const target = input.target ?? rubric.target;
  const artefact = input.artefactOverride
    ? ok({
        json: input.artefactOverride.json,
        targetRef:
          input.artefactOverride.targetRef ??
          item.currentSpecVersionId ??
          item.id,
        targetKind: input.artefactOverride.targetKind,
      })
    : await loadArtefact(ctx, {
        workItemId: input.workItemId,
        target,
      });
  if (!artefact.ok) return artefact;

  const hash = contentHash({
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    model: rubric.model,
    artefact: artefact.value.json,
  });

  if (!input.skipCache) {
    const cached = await ctx.db.query.rubricVerdicts.findFirst({
      where: and(
        eq(rubricVerdicts.rubricId, rubric.id),
        eq(rubricVerdicts.rubricVersion, rubric.version),
        eq(rubricVerdicts.contentHash, hash),
        isNull(rubricVerdicts.errorCode),
      ),
      orderBy: [desc(rubricVerdicts.createdAt)],
    });
    if (cached && cached.outcome !== 'error') {
      const criteria = (cached.criteria ?? []) as RubricVerdict['criteria'];
      const verdict: RubricVerdict | null =
        cached.outcome === 'pass' ||
        cached.outcome === 'warn' ||
        cached.outcome === 'block'
          ? {
              outcome: cached.outcome,
              confidence: Number(cached.confidence ?? 0),
              headline: cached.headline,
              criteria,
              ...(cached.suggestedRemediation
                ? { suggested_remediation: cached.suggestedRemediation }
                : {}),
            }
          : null;
      // Re-insert as cache hit record for audit trail of this evaluation attempt
      const id = newId();
      const [stored] = await ctx.db
        .insert(rubricVerdicts)
        .values({
          id,
          rubricId: rubric.id,
          rubricVersion: rubric.version,
          workItemId: input.workItemId,
          gateEvaluationId: input.gateEvaluationId ?? null,
          targetKind: artefact.value.targetKind,
          targetRef: artefact.value.targetRef,
          contentHash: hash,
          outcome: cached.outcome,
          modelOutcome: cached.modelOutcome ?? null,
          confidence: cached.confidence,
          headline: cached.headline,
          criteria: cached.criteria,
          suggestedRemediation: cached.suggestedRemediation,
          model: cached.model,
          tokens: cached.tokens,
          costMicroUsd: BigInt(0),
          durationMs: 0,
          cacheHit: true,
          rawResponse: null,
          runId: null,
        })
        .returning();
      return ok({
        verdict,
        outcome: cached.outcome as EvaluateRubricResult['outcome'],
        stored: stored!,
        cacheHit: true,
        modelOutcome: (cached.modelOutcome as EvaluateRubricResult['modelOutcome']) ?? undefined,
      });
    }
  }

  const hourly = await checkRateLimitWindow(
    `rubric-eval-hour:${item.projectId}`,
    RUBRIC_EVAL_HOURLY_CAP,
    3600,
  );
  if (!hourly.allowed) {
    const id = newId();
    const stored = await persistErrorVerdict(ctx, {
      id,
      rubric,
      workItemId: input.workItemId,
      gateEvaluationId: input.gateEvaluationId,
      targetKind: artefact.value.targetKind,
      targetRef: artefact.value.targetRef,
      contentHash: INFRA_CONTENT_HASH.rate_limited,
      headline: 'Evaluation rate limit reached',
      errorCode: 'rate_limited',
      durationMs: 0,
    });
    return ok({
      verdict: null,
      outcome: 'warn',
      stored,
      cacheHit: false,
      reason: 'rate_limited',
    });
  }

  const criteria = RubricCriteriaSchema.parse(rubric.criteria) as RubricCriterion[];
  const messages = assembleRubricPrompt({
    question: rubric.question,
    criteria,
    passWhen: rubric.passWhen,
    blockWhen: rubric.blockWhen,
    guidance: rubric.guidance,
    target: artefact.value.targetKind,
    artefactJson: artefact.value.json,
  });

  const provider = resolveModelProvider();
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUBRIC_EVAL_TIMEOUT_MS);

  let completionText = '';
  let tokens: { input?: number; output?: number; total?: number } | undefined;
  let raw: unknown = null;
  let timedOut = false;
  let providerError: string | null = null;

  try {
    const completion = await provider.complete({
      model: rubric.model,
      messages,
      maxOutputTokens: rubric.maxOutputTokens,
      temperature: 0,
      signal: controller.signal,
    });
    completionText = completion.text;
    tokens = completion.tokens;
    raw = completion.raw ?? null;
    await recordCircuitSuccess(item.projectId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof Error && e.name === 'AbortError') {
      timedOut = true;
      await recordCircuitFailure(item.projectId);
    } else {
      providerError = msg;
      await recordCircuitFailure(item.projectId);
    }
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - started;
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);

  if (timedOut) {
    const id = newId();
    const stored = await persistErrorVerdict(ctx, {
      id,
      rubric,
      workItemId: input.workItemId,
      gateEvaluationId: input.gateEvaluationId,
      targetKind: artefact.value.targetKind,
      targetRef: artefact.value.targetRef,
      contentHash: INFRA_CONTENT_HASH.evaluator_timeout,
      headline: 'Evaluator timed out',
      errorCode: 'evaluator_timeout',
      durationMs,
      rawResponse: { timedOut: true },
    });
    return ok({
      verdict: null,
      outcome: 'warn',
      stored,
      cacheHit: false,
      reason: 'evaluator_timeout',
    });
  }

  if (providerError) {
    const id = newId();
    const code =
      providerError === 'provider_unavailable'
        ? 'provider_unavailable'
        : 'provider_error';
    const stored = await persistErrorVerdict(ctx, {
      id,
      rubric,
      workItemId: input.workItemId,
      gateEvaluationId: input.gateEvaluationId,
      targetKind: artefact.value.targetKind,
      targetRef: artefact.value.targetRef,
      contentHash:
        code === 'provider_unavailable'
          ? INFRA_CONTENT_HASH.provider_unavailable
          : INFRA_CONTENT_HASH.provider_error,
      headline: 'Evaluator unavailable',
      errorCode: code,
      durationMs,
      rawResponse: { error: providerError },
    });
    return ok({
      verdict: null,
      outcome: 'warn',
      stored,
      cacheHit: false,
      reason: code,
    });
  }

  let validated = validateAndParse(completionText, criteria);
  if (!validated.ok) {
    // One retry with validation error appended
    try {
      const retryMessages = [
        ...messages,
        {
          role: 'user' as const,
          content: `Your previous response failed schema validation: ${validated.error}. Return corrected JSON only.`,
        },
      ];
      const retryController = new AbortController();
      const retryTimer = setTimeout(
        () => retryController.abort(),
        Math.max(1_000, RUBRIC_EVAL_TIMEOUT_MS - durationMs),
      );
      try {
        const retry = await provider.complete({
          model: rubric.model,
          messages: retryMessages,
          maxOutputTokens: rubric.maxOutputTokens,
          temperature: 0,
          signal: retryController.signal,
        });
        completionText = retry.text;
        tokens = retry.tokens;
        raw = retry.raw ?? null;
        validated = validateAndParse(completionText, criteria);
      } finally {
        clearTimeout(retryTimer);
      }
    } catch {
      // fall through to error
    }
  }

  if (!validated.ok) {
    const id = newId();
    const stored = await persistErrorVerdict(ctx, {
      id,
      rubric,
      workItemId: input.workItemId,
      gateEvaluationId: input.gateEvaluationId,
      targetKind: artefact.value.targetKind,
      targetRef: artefact.value.targetRef,
      contentHash: INFRA_CONTENT_HASH.schema_invalid,
      headline: 'Invalid evaluator response',
      errorCode: 'schema_invalid',
      durationMs: Date.now() - started,
      rawResponse: { text: completionText.slice(0, 4_000), error: validated.error },
    });
    return ok({
      verdict: null,
      outcome: 'error',
      stored,
      cacheHit: false,
      reason: 'schema_invalid',
    });
  }

  const modelOutcome = validated.verdict.outcome;
  const finalVerdict = applyUncertaintyPolicy(
    validated.verdict,
    criteria,
    rubric.uncertaintyPolicy,
  );

  const costMicro = estimateMicroFromTokens(rubric.model, tokens, {
    promptChars,
    maxOutputTokens: rubric.maxOutputTokens,
  });
  const runId = await recordInternalLlmRun(ctx, {
    workItemId: input.workItemId,
    projectId: item.projectId,
    model: rubric.model,
    tokens: tokens ?? null,
    costMicro,
    durationMs: Date.now() - started,
    trigger: {
      kind: 'manual',
      by: {
        source: 'rubric_eval',
        gateEvaluationId: input.gateEvaluationId,
        rubricId: rubric.id,
      },
    },
  });

  const id = newId();
  const [stored] = await ctx.db
    .insert(rubricVerdicts)
    .values({
      id,
      rubricId: rubric.id,
      rubricVersion: rubric.version,
      workItemId: input.workItemId,
      gateEvaluationId: input.gateEvaluationId ?? null,
      targetKind: artefact.value.targetKind,
      targetRef: artefact.value.targetRef,
      contentHash: hash,
      outcome: finalVerdict.outcome,
      modelOutcome,
      confidence: String(finalVerdict.confidence),
      headline: finalVerdict.headline,
      criteria: finalVerdict.criteria as unknown as Record<string, unknown>[],
      suggestedRemediation: finalVerdict.suggested_remediation ?? null,
      model: rubric.model,
      tokens: tokens ?? null,
      costMicroUsd: costMicro,
      durationMs: Date.now() - started,
      cacheHit: false,
      rawResponse: (raw as Record<string, unknown>) ?? {
        text: completionText.slice(0, 4_000),
      },
      runId,
    })
    .returning();

  await emit(ctx.db, {
    orgId: ctx.orgId,
    projectId: item.projectId,
    type: 'rubric.evaluated',
    subjectType: 'rubric_verdict',
    subjectId: id,
    actor: ctx.actor,
    payload: {
      rubricId: rubric.id,
      rubricVersion: rubric.version,
      workItemId: input.workItemId,
      outcome: finalVerdict.outcome,
      modelOutcome,
      confidence: finalVerdict.confidence,
      cacheHit: false,
      costMicroUsd: costMicro.toString(),
      model: rubric.model,
    },
  });

  ctx.logger.info(
    {
      rubricId: rubric.id,
      workItemId: input.workItemId,
      outcome: finalVerdict.outcome,
      modelOutcome,
      costMicroUsd: costMicro.toString(),
    },
    'rubric.evaluated',
  );

  return ok({
    verdict: finalVerdict,
    outcome: finalVerdict.outcome,
    stored: stored!,
    cacheHit: false,
    modelOutcome,
  });
}

function validateAndParse(
  text: string,
  expectedCriteria: RubricCriterion[],
): { ok: true; verdict: RubricVerdict } | { ok: false; error: string } {
  try {
    const raw = parseVerdictJson(text);
    return validateVerdict(raw, expectedCriteria);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'invalid JSON',
    };
  }
}

async function persistErrorVerdict(
  ctx: ServiceContext,
  input: {
    id: string;
    rubric: typeof rubrics.$inferSelect;
    workItemId: string;
    gateEvaluationId?: string;
    targetKind: 'spec' | 'stage_report';
    targetRef: string;
    contentHash: string;
    headline: string;
    errorCode: string;
    durationMs: number;
    rawResponse?: Record<string, unknown>;
  },
): Promise<StoredVerdict> {
  // Map infrastructure failures to warn-shaped storage with outcome warn for gate mapping,
  // except schema_invalid which stays error.
  const outcome =
    input.errorCode === 'schema_invalid' ? 'error' : 'warn';
  const [stored] = await ctx.db
    .insert(rubricVerdicts)
    .values({
      id: input.id,
      rubricId: input.rubric.id,
      rubricVersion: input.rubric.version,
      workItemId: input.workItemId,
      gateEvaluationId: input.gateEvaluationId ?? null,
      targetKind: input.targetKind,
      targetRef: input.targetRef,
      contentHash: input.contentHash,
      outcome,
      confidence: '0.00',
      headline: input.headline,
      criteria: [],
      model: input.rubric.model,
      durationMs: input.durationMs,
      cacheHit: false,
      rawResponse: input.rawResponse ?? null,
      errorCode: input.errorCode,
    })
    .returning();
  return stored!;
}

export async function getVerdict(
  ctx: ServiceContext,
  verdictId: string,
): Promise<Result<StoredVerdict, CoreError>> {
  const row = await ctx.db.query.rubricVerdicts.findFirst({
    where: eq(rubricVerdicts.id, verdictId),
  });
  if (!row) return err(coreError('not_found', 'Verdict not found'));

  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, row.workItemId),
  });
  if (!item) return err(coreError('not_found', 'Verdict not found'));

  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'work_item.read', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Verdict not found'));
  }
  return ok(row);
}

export async function listVerdictsForItem(
  ctx: ServiceContext,
  workItemId: string,
  limit = 20,
): Promise<Result<StoredVerdict[], CoreError>> {
  const item = await ctx.db.query.workItems.findFirst({
    where: eq(workItems.id, workItemId),
  });
  if (!item) return err(coreError('not_found', 'Work item not found'));
  const role = await getProjectRole(ctx, item.projectId);
  if (
    !can(ctx.actor, 'work_item.read', {
      type: 'work_item',
      projectId: item.projectId,
      role,
    })
  ) {
    return err(coreError('not_found', 'Work item not found'));
  }
  const rows = await ctx.db.query.rubricVerdicts.findMany({
    where: eq(rubricVerdicts.workItemId, workItemId),
    orderBy: [desc(rubricVerdicts.createdAt)],
    limit,
  });
  return ok(rows);
}
