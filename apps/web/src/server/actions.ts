'use server';

import {
  addStage,
  answerQuestion,
  archiveBinding,
  archiveGate,
  cancelRun,
  createGate,
  createProject,
  createPromptTemplate,
  createSpecVersion,
  createWorkItem,
  decideApproval,
  dismissWarning,
  evaluateGates,
  launchRun,
  resolveBinding,
  setLabels,
  transitionWorkItem,
  updateGate,
  raiseProjectCap,
  resumeItemBudget,
  updateProject,
  updateStage,
  updateWorkItem,
  upsertBinding,
  upsertLabel,
} from '@nexus/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from './session';

export async function actionCreateProject(formData: FormData) {
  const { ctx } = await requireSession();
  const result = await createProject(ctx, {
    key: String(formData.get('key') ?? '').toUpperCase(),
    name: String(formData.get('name') ?? ''),
    description: String(formData.get('description') ?? ''),
    template: String(formData.get('template') ?? 'default'),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath('/projects');
  redirect(`/projects/${result.value.key}/board`);
}

export async function actionCreateWorkItem(formData: FormData) {
  const { ctx } = await requireSession();
  const projectId = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const labelKeys = String(formData.get('labelKeys') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const complexityRaw = String(formData.get('complexity') ?? '');
  const result = await createWorkItem(ctx, {
    projectId,
    title: String(formData.get('title') ?? ''),
    description: String(formData.get('description') ?? ''),
    complexity: complexityRaw
      ? (complexityRaw as 'low' | 'medium' | 'high')
      : undefined,
    labelKeys,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/board`);
  redirect(`/projects/${projectKey}/items/${result.value.key}`);
}

export async function actionTransitionWorkItem(formData: FormData) {
  const { ctx } = await requireSession();
  const id = String(formData.get('workItemId') ?? '');
  const toStageId = String(formData.get('toStageId') ?? '');
  const expectedVersion = Number(formData.get('expectedVersion') ?? 0);
  const projectKey = String(formData.get('projectKey') ?? '');
  const itemKey = String(formData.get('itemKey') ?? '');
  const note = String(formData.get('note') ?? '') || undefined;
  const overrideReason = String(formData.get('overrideReason') ?? '').trim();
  const kind = String(formData.get('kind') ?? 'advance');
  const reasonCode = String(formData.get('reasonCode') ?? '') || undefined;

  const input =
    kind === 'return'
      ? {
          kind: 'return' as const,
          toStageId,
          reasonCode: reasonCode ?? '',
          note,
          ...(overrideReason ? { override: { reason: overrideReason } } : {}),
        }
      : {
          kind: 'advance' as const,
          toStageId,
          reasonCode,
          note,
          ...(overrideReason ? { override: { reason: overrideReason } } : {}),
        };

  const result = await transitionWorkItem(ctx, id, input, expectedVersion);
  if (!result.ok) {
    if (result.error.code === 'gate_blocked') {
      const blocked = (result.error.details?.blockedBy as Array<{ reason: string }>) ?? [];
      throw new Error(
        `Blocked by gate(s): ${blocked.map((b) => b.reason).join('; ') || result.error.message}`,
      );
    }
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/board`);
  if (itemKey) {
    revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
  }
}

export async function actionDryRunGates(formData: FormData) {
  const { ctx } = await requireSession();
  const workItemId = String(formData.get('workItemId') ?? '');
  const toStageId = String(formData.get('toStageId') ?? '');
  const {
    getWorkItem,
    countPriorVisits,
    isReturnEdge,
    listStages,
  } = await import('@nexus/core');
  const item = await getWorkItem(ctx, workItemId);
  if (!item.ok) {
    return { ok: false as const, error: item.error.message };
  }

  let prospectiveReturn:
    | { fromStageId: string; toStageId: string }
    | undefined;
  const stages = await listStages(ctx, item.value.projectId);
  if (stages.ok && item.value.currentStageId) {
    const from = stages.value.find((s) => s.id === item.value.currentStageId);
    const to = stages.value.find((s) => s.id === toStageId);
    if (from && to) {
      const direction =
        to.position > from.position
          ? 'forward'
          : to.position < from.position
            ? 'backward'
            : 'lateral';
      const prior = await countPriorVisits(ctx.db, workItemId, toStageId);
      if (isReturnEdge({ direction, priorVisitCount: prior })) {
        prospectiveReturn = {
          fromStageId: item.value.currentStageId,
          toStageId,
        };
      }
    }
  }

  const batch = await evaluateGates(ctx, {
    workItemId,
    trigger: {
      kind: 'on_transition',
      fromStageId: item.value.currentStageId,
      toStageId,
    },
    dryRun: true,
    prospectiveReturn,
  });
  if (!batch.ok) {
    return { ok: false as const, error: batch.error.message };
  }
  return {
    ok: true as const,
    outcome: batch.value.outcome,
    blockedBy: batch.value.results
      .filter((r) => r.outcome === 'block' || r.outcome === 'warn' || r.outcome === 'error')
      .map((r) => ({
        gateName: r.gateName,
        reason: r.reason,
        outcome: r.outcome,
      })),
  };
}

export async function actionCreateGate(formData: FormData) {
  const { ctx } = await requireSession();
  const projectId = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const evaluator = String(formData.get('evaluator') ?? 'field_rule') as
    | 'field_rule'
    | 'human_approval'
    | 'budget'
    | 'loop_budget'
    | 'agentic';
  const triggerKind = String(formData.get('triggerKind') ?? 'on_transition');
  const toStageId = String(formData.get('toStageId') ?? '');
  const fromStageId = String(formData.get('fromStageId') ?? '') || undefined;
  const labelKey = String(formData.get('labelKey') ?? '');
  const onFailure = String(formData.get('onFailure') ?? 'block') as 'block' | 'warn';

  let trigger;
  if (triggerKind === 'on_label_added') {
    trigger = { kind: 'on_label_added' as const, labelKey };
  } else if (triggerKind === 'on_run_finished') {
    trigger = { kind: 'on_run_finished' as const };
  } else {
    trigger = {
      kind: 'on_transition' as const,
      toStageId,
      ...(fromStageId ? { fromStageId } : {}),
    };
  }

  let config: Record<string, unknown>;
  if (evaluator === 'human_approval') {
    const rolesRaw = String(formData.get('approverRoles') ?? 'owner,maintainer');
    const approverRoles = rolesRaw
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    config = {
      approverRoles: approverRoles.length ? approverRoles : ['owner', 'maintainer'],
      allowSelfApproval: formData.get('allowSelfApproval') === 'on',
      instructions: String(formData.get('instructions') ?? ''),
    };
  } else if (evaluator === 'field_rule') {
    const field = String(formData.get('field') ?? 'ticket.complexity');
    const op = String(formData.get('op') ?? 'exists');
    const value = String(formData.get('value') ?? '');
    const message = String(formData.get('message') ?? 'Gate failed');
    const code = String(formData.get('code') ?? '') || undefined;
    if (op === 'has_label' || op === 'lacks_label') {
      config = {
        require: { op, value: value || 'risk:high' },
        message,
        code,
      };
    } else if (op === 'exists' || op === 'missing') {
      config = { require: { op, field }, message, code };
    } else if (op === 'count_gte') {
      config = {
        require: { op, field, value: Number(value) || 1 },
        message,
        code,
      };
    } else {
      config = {
        require: { op, field, value: value || null },
        message,
        code,
      };
    }
  } else if (evaluator === 'loop_budget') {
    const scope = String(formData.get('loopScope') ?? 'item') as
      | 'item'
      | 'stage'
      | 'stage_pair';
    const warnAt = Number(formData.get('warnAt') ?? 2);
    const escalateAt = Number(formData.get('escalateAt') ?? 3);
    const blockAtRaw = String(formData.get('blockAt') ?? '').trim();
    config = {
      scope,
      warnAt: Number.isFinite(warnAt) ? warnAt : 2,
      escalateAt: Number.isFinite(escalateAt) ? escalateAt : 3,
      ...(blockAtRaw ? { blockAt: Number(blockAtRaw) } : {}),
      message: String(formData.get('message') ?? 'Loop budget exceeded'),
      ...(formData.get('loopStageId')
        ? { stageId: String(formData.get('loopStageId')) }
        : {}),
      ...(formData.get('loopFromStageId')
        ? { fromStageId: String(formData.get('loopFromStageId')) }
        : {}),
      ...(formData.get('loopToStageId')
        ? { toStageId: String(formData.get('loopToStageId')) }
        : {}),
    };
  } else {
    config = {};
  }

  const result = await createGate(ctx, {
    projectId,
    name: String(formData.get('name') ?? 'Untitled gate'),
    description: String(formData.get('description') ?? ''),
    evaluator,
    trigger,
    config,
    onFailure,
    enabled: formData.get('enabled') === 'on',
  });
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/policies`);
}

export async function actionEnableGate(formData: FormData) {
  const { ctx } = await requireSession();
  const gateId = String(formData.get('gateId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const enabled = formData.get('enabled') === 'on';
  const result = await updateGate(ctx, gateId, { enabled });
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/policies`);
}

export async function actionArchiveGate(formData: FormData) {
  const { ctx } = await requireSession();
  const gateId = String(formData.get('gateId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const result = await archiveGate(ctx, gateId);
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/policies`);
}

export async function actionDecideApproval(formData: FormData) {
  const { ctx } = await requireSession();
  const approvalId = String(formData.get('approvalId') ?? '');
  const decision = String(formData.get('decision') ?? '') as 'approved' | 'rejected';
  const projectKey = String(formData.get('projectKey') ?? '');
  const itemKey = String(formData.get('itemKey') ?? '');
  const comment = String(formData.get('comment') ?? '') || undefined;
  const result = await decideApproval(ctx, approvalId, { decision, comment });
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/policies`);
  revalidatePath(`/projects/${projectKey}/approvals`);
  revalidatePath(`/projects/${projectKey}/board`);
  if (itemKey) revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
}

export async function actionDismissWarning(formData: FormData) {
  const { ctx } = await requireSession();
  const warningId = String(formData.get('warningId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const projectKey = String(formData.get('projectKey') ?? '');
  const itemKey = String(formData.get('itemKey') ?? '');
  if (!reason) {
    throw new Error('Dismissal reason is required');
  }
  const result = await dismissWarning(ctx, warningId, reason);
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
}

export async function actionSetEnforcementMode(formData: FormData) {
  const { ctx } = await requireSession();
  const projectId = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const mode = String(formData.get('enforcement_mode') ?? 'enforce');
  const result = await updateProject(ctx, projectId, {
    settings: { enforcement_mode: mode === 'observe' ? 'observe' : 'enforce' },
  });
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/policies`);
  revalidatePath(`/projects/${projectKey}/settings`);
}

export async function actionSaveSpec(formData: FormData) {
  const { ctx } = await requireSession();
  const workItemId = String(formData.get('workItemId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const itemKey = String(formData.get('itemKey') ?? '');
  const note = String(formData.get('note') ?? '') || undefined;
  const content = {
    summary: String(formData.get('summary') ?? ''),
    context: String(formData.get('context') ?? '') || undefined,
    approach: String(formData.get('approach') ?? '') || undefined,
    openQuestions: String(formData.get('openQuestions') ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  const result = await createSpecVersion(ctx, workItemId, content, note);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
}

export async function actionUpdateWorkItem(formData: FormData) {
  const { ctx } = await requireSession();
  const id = String(formData.get('workItemId') ?? '');
  const expectedVersion = Number(formData.get('expectedVersion') ?? 0);
  const projectKey = String(formData.get('projectKey') ?? '');
  const itemKey = String(formData.get('itemKey') ?? '');
  const complexityRaw = String(formData.get('complexity') ?? '');
  const result = await updateWorkItem(
    ctx,
    id,
    {
      title: String(formData.get('title') ?? '') || undefined,
      description: String(formData.get('description') ?? '') || undefined,
      complexity: complexityRaw
        ? (complexityRaw as 'low' | 'medium' | 'high')
        : null,
    },
    expectedVersion,
  );
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  const add = String(formData.get('addLabels') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const remove = String(formData.get('removeLabels') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (add.length || remove.length) {
    await setLabels(ctx, id, { add, remove });
  }

  revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
  revalidatePath(`/projects/${projectKey}/board`);
}

export async function actionUpdateProject(formData: FormData) {
  const { ctx } = await requireSession();
  const id = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const result = await updateProject(ctx, id, {
    name: String(formData.get('name') ?? '') || undefined,
    description: String(formData.get('description') ?? '') || undefined,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/settings`);
  revalidatePath('/projects');
}

export async function actionAddStage(formData: FormData) {
  const { ctx } = await requireSession();
  const projectId = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const result = await addStage(ctx, {
    projectId,
    key: String(formData.get('key') ?? ''),
    name: String(formData.get('name') ?? ''),
    position: Number(formData.get('position') ?? 500),
    defaultOwnerClass: String(formData.get('defaultOwnerClass') ?? 'human') as
      | 'ai'
      | 'human'
      | 'external',
    isTerminal: formData.get('isTerminal') === 'on',
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/settings`);
  revalidatePath(`/projects/${projectKey}/board`);
}

export async function actionRenameStage(formData: FormData) {
  const { ctx } = await requireSession();
  const stageId = String(formData.get('stageId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const result = await updateStage(ctx, stageId, {
    name: String(formData.get('name') ?? ''),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/settings`);
  revalidatePath(`/projects/${projectKey}/board`);
}

export async function actionUpsertLabel(formData: FormData) {
  const { ctx } = await requireSession();
  const projectId = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const result = await upsertLabel(ctx, {
    projectId,
    key: String(formData.get('key') ?? ''),
    name: String(formData.get('name') ?? ''),
    color: String(formData.get('color') ?? 'gray'),
    category: String(formData.get('category') ?? '') || null,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/settings`);
}

export async function actionLaunchRun(formData: FormData) {
  const { ctx } = await requireSession();
  const workItemId = String(formData.get('workItemId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const itemKey = String(formData.get('itemKey') ?? '');
  const bindingId = String(formData.get('bindingId') ?? '') || undefined;
  const result = await launchRun(ctx, { workItemId, bindingId });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
  revalidatePath(`/projects/${projectKey}/board`);
}

export async function actionCancelRun(formData: FormData) {
  const { ctx } = await requireSession();
  const runId = String(formData.get('runId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const itemKey = String(formData.get('itemKey') ?? '');
  const result = await cancelRun(ctx, runId, 'Cancelled from UI');
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  // Provider cancel may fail (Phase 0); run stays observed — UI shows errorDetail.
  revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
  revalidatePath(`/projects/${projectKey}/board`);
}

export async function actionAnswerQuestion(formData: FormData) {
  const { ctx } = await requireSession();
  const questionId = String(formData.get('questionId') ?? '');
  const answer = String(formData.get('answer') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const itemKey = String(formData.get('itemKey') ?? '');
  const result = await answerQuestion(ctx, questionId, answer, { resume: true });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
  revalidatePath(`/projects/${projectKey}/board`);
  revalidatePath(`/projects/${projectKey}/questions`);
}

export async function actionUpsertBinding(formData: FormData) {
  const { ctx } = await requireSession();
  const projectId = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const adapter = String(formData.get('adapter') ?? 'cloud_agent') as
    | 'cloud_agent'
    | 'automation_webhook';
  const config =
    adapter === 'cloud_agent'
      ? {
          adapter: 'cloud_agent' as const,
          repoUrl: String(formData.get('repoUrl') ?? '') || undefined,
          startingRef: String(formData.get('startingRef') ?? 'main'),
          model: String(formData.get('model') ?? '') || undefined,
          autoCreatePR: formData.get('autoCreatePR') === 'on',
          maxDurationMinutes: Number(formData.get('maxDurationMinutes') ?? 60),
          noRepo: formData.get('noRepo') === 'on' || !formData.get('repoUrl'),
        }
      : {
          adapter: 'automation_webhook' as const,
          webhookUrlSecretKey: String(formData.get('webhookUrlSecretKey') ?? ''),
          maxDurationMinutes: Number(formData.get('maxDurationMinutes') ?? 60),
        };

  const labelFilter = String(formData.get('labelKeysAny') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const result = await upsertBinding(ctx, {
    id: String(formData.get('bindingId') ?? '') || undefined,
    projectId,
    stageId: String(formData.get('stageId') ?? ''),
    name: String(formData.get('name') ?? ''),
    adapter,
    priority: Number(formData.get('priority') ?? 0),
    condition: labelFilter.length ? { labelKeysAny: labelFilter } : null,
    config,
    promptTemplateId: String(formData.get('promptTemplateId') ?? '') || null,
    enabled: formData.get('enabled') !== 'off',
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/settings`);
}

export async function actionArchiveBinding(formData: FormData) {
  const { ctx } = await requireSession();
  const bindingId = String(formData.get('bindingId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const result = await archiveBinding(ctx, bindingId);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/settings`);
}

export async function actionCreateDefaultPrompt(formData: FormData) {
  const { ctx } = await requireSession();
  const projectId = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const result = await createPromptTemplate(ctx, {
    projectId,
    name: String(formData.get('name') ?? 'default'),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/settings`);
}

export async function actionTestResolveBinding(formData: FormData) {
  const { ctx } = await requireSession();
  const workItemId = String(formData.get('workItemId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const result = await resolveBinding(ctx, { workItemId });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  // Stash explanation in a cookie-less flash via redirect query is heavy;
  // revalidate and let settings page show last resolve via searchParams later.
  revalidatePath(`/projects/${projectKey}/settings`);
  redirect(
    `/projects/${projectKey}/settings?resolve=${encodeURIComponent(result.value.reason)}`,
  );
}

export async function actionUpdateBudgetSettings(formData: FormData) {
  const { ctx } = await requireSession();
  const projectId = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');

  function parseUsdField(name: string): number {
    const raw = String(formData.get(name) ?? '').trim();
    if (!raw) {
      throw new Error(`${name} is required`);
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${name} must be a non-negative number`);
    }
    return n;
  }

  const burnCapUsd = parseUsdField('burnCapUsd');
  const lowSoftUsd = parseUsdField('lowSoftUsd');
  const lowHardUsd = parseUsdField('lowHardUsd');
  const mediumSoftUsd = parseUsdField('mediumSoftUsd');
  const mediumHardUsd = parseUsdField('mediumHardUsd');
  const highSoftUsd = parseUsdField('highSoftUsd');
  const highHardUsd = parseUsdField('highHardUsd');

  for (const [soft, hard, label] of [
    [lowSoftUsd, lowHardUsd, 'Low'],
    [mediumSoftUsd, mediumHardUsd, 'Medium'],
    [highSoftUsd, highHardUsd, 'High'],
  ] as const) {
    if (soft >= hard) {
      throw new Error(`${label} soft budget must be less than hard budget`);
    }
  }
  const maxHard = Math.max(lowHardUsd, mediumHardUsd, highHardUsd);
  if (burnCapUsd < maxHard) {
    throw new Error('Project burn cap must be at least the largest item hard budget');
  }

  const { getProjectByKey, fromUsd } = await import('@nexus/core');
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) throw new Error('Project not found');
  const existing = project.value.settings as Record<string, unknown>;
  const result = await updateProject(ctx, projectId, {
    settings: {
      ...existing,
      budget: {
        burnCapMicroUsd: fromUsd(burnCapUsd).toString(),
        complexityDefaults: {
          low: {
            softMicroUsd: fromUsd(lowSoftUsd).toString(),
            hardMicroUsd: fromUsd(lowHardUsd).toString(),
          },
          medium: {
            softMicroUsd: fromUsd(mediumSoftUsd).toString(),
            hardMicroUsd: fromUsd(mediumHardUsd).toString(),
          },
          high: {
            softMicroUsd: fromUsd(highSoftUsd).toString(),
            hardMicroUsd: fromUsd(highHardUsd).toString(),
          },
        },
        reserveMicroUsdPerRun: fromUsd(2).toString(),
        blockOnBurnCap: true,
      },
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/settings`);
}

export async function actionRaiseProjectCap(formData: FormData) {
  const { ctx } = await requireSession();
  const projectId = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const capUsd = Number(formData.get('capUsd') ?? 0);
  const reason = String(formData.get('reason') ?? '').trim();
  const { fromUsd } = await import('@nexus/core');
  const result = await raiseProjectCap(ctx, projectId, {
    micro: fromUsd(capUsd),
    reason,
  });
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/board`);
  revalidatePath(`/projects/${projectKey}/spend`);
}

export async function actionResumeBudgetItem(formData: FormData) {
  const { ctx } = await requireSession();
  const workItemId = String(formData.get('workItemId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const itemKey = String(formData.get('itemKey') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const result = await resumeItemBudget(ctx, workItemId, reason);
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
}

export async function actionSetItemBudget(formData: FormData) {
  const { ctx } = await requireSession();
  const workItemId = String(formData.get('workItemId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const itemKey = String(formData.get('itemKey') ?? '');
  const budgetUsd = Number(formData.get('budgetUsd') ?? 0);
  const reason = String(formData.get('reason') ?? '').trim();
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error('Budget must be a positive USD amount');
  }
  const { setItemBudget, fromUsd } = await import('@nexus/core');
  const result = await setItemBudget(ctx, workItemId, {
    micro: fromUsd(budgetUsd),
    reason,
  });
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
  revalidatePath(`/projects/${projectKey}/board`);
}

export async function actionUpsertReasonCode(formData: FormData) {
  const { ctx } = await requireSession();
  const { upsertReasonCode } = await import('@nexus/core');
  const projectId = String(formData.get('projectId') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const result = await upsertReasonCode(ctx, {
    projectId,
    code: String(formData.get('code') ?? ''),
    label: String(formData.get('label') ?? ''),
    requiresNote: formData.get('requiresNote') === 'on',
    position: Number(formData.get('position') ?? 100),
  });
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/settings`);
}

export async function actionArchiveReasonCode(formData: FormData) {
  const { ctx } = await requireSession();
  const { archiveReasonCode } = await import('@nexus/core');
  const id = String(formData.get('id') ?? '');
  const projectKey = String(formData.get('projectKey') ?? '');
  const result = await archiveReasonCode(ctx, id);
  if (!result.ok) throw new Error(result.error.message);
  revalidatePath(`/projects/${projectKey}/settings`);
}
