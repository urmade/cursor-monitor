'use server';

import {
  addStage,
  createProject,
  createSpecVersion,
  createWorkItem,
  setLabels,
  transitionWorkItem,
  updateProject,
  updateStage,
  updateWorkItem,
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
  const result = await transitionWorkItem(
    ctx,
    id,
    { toStageId, note },
    expectedVersion,
  );
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/projects/${projectKey}/board`);
  if (itemKey) {
    revalidatePath(`/projects/${projectKey}/items/${itemKey}`);
  }
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
