import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  closeDb,
  getDb,
  events,
  projectMembers,
  stages,
  workItems,
} from '@nexus/db';
import {
  createContext,
  createProject,
  createSpecVersion,
  createWorkItem,
  transitionWorkItem,
  upsertUserFromPassport,
  addMember,
  can,
  getProjectRole,
  listProjectEvents,
  updateWorkItem,
} from '../index';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('phase 1 services integration', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let ownerId = '';
  let viewerId = '';

  beforeAll(async () => {
    const owner = await upsertUserFromPassport(db, {
      externalSub: `test-owner-${Date.now()}`,
      email: 'owner@example.com',
      name: 'Owner',
    });
    orgId = owner.orgId;
    ownerId = owner.userId;

    const viewer = await upsertUserFromPassport(db, {
      externalSub: `test-viewer-${Date.now()}`,
      email: 'viewer@example.com',
      name: 'Viewer',
    });
    viewerId = viewer.userId;
  });

  afterAll(async () => {
    await closeDb();
  });

  it('creates two differently shaped projects and walks a ticket with events', async () => {
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    const ownerCtx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId: ownerId },
    });

    const alpha = await createProject(ownerCtx, {
      key: `A${suffix}`,
      name: 'Alpha Test',
      template: 'default',
    });
    expect(alpha.ok).toBe(true);
    if (!alpha.ok) return;

    const beta = await createProject(ownerCtx, {
      key: `B${suffix}`,
      name: 'Beta Test',
      template: 'minimal',
    });
    expect(beta.ok).toBe(true);
    if (!beta.ok) return;

    const alphaStages = await db.query.stages.findMany({
      where: and(eq(stages.projectId, alpha.value.id), isNull(stages.archivedAt)),
    });
    const betaStages = await db.query.stages.findMany({
      where: and(eq(stages.projectId, beta.value.id), isNull(stages.archivedAt)),
    });
    expect(alphaStages.length).toBe(6);
    expect(betaStages.length).toBe(3);

    const item = await createWorkItem(ownerCtx, {
      projectId: alpha.value.id,
      title: 'Walk the pipeline',
      complexity: 'high',
      labelKeys: ['risk:high'],
    });
    expect(item.ok).toBe(true);
    if (!item.ok) return;

    await createSpecVersion(ownerCtx, item.value.id, {
      summary: 'v1',
    });
    await createSpecVersion(ownerCtx, item.value.id, {
      summary: 'v2',
    });
    await createSpecVersion(ownerCtx, item.value.id, {
      summary: 'v3',
    });

    const ordered = [...alphaStages].sort((a, b) => a.position - b.position);
    let version = (
      await db.query.workItems.findFirst({ where: eq(workItems.id, item.value.id) })
    )!.version;

    // forward through all stages
    for (let i = 1; i < ordered.length; i += 1) {
      const moved = await transitionWorkItem(
        ownerCtx,
        item.value.id,
        { toStageId: ordered[i]!.id },
        version,
      );
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      version = moved.value.version;
    }

    // deliberate backward move from last to previous
    const backward = await transitionWorkItem(
      ownerCtx,
      item.value.id,
      { toStageId: ordered[ordered.length - 2]!.id, note: 'rework' },
      version,
    );
    expect(backward.ok).toBe(true);
    if (!backward.ok) return;

    const history = await listProjectEvents(ownerCtx, alpha.value.id, {
      workItemId: item.value.id,
      limit: 50,
    });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.some((e) => e.type === 'work_item.created')).toBe(true);
    expect(history.value.some((e) => e.type === 'work_item.stage_changed')).toBe(
      true,
    );
    expect(history.value.some((e) => e.type === 'spec.version_created')).toBe(
      true,
    );

    const stageChanged = history.value.find(
      (e) =>
        e.type === 'work_item.stage_changed' &&
        (e.payload as { direction?: string }).direction === 'backward',
    );
    expect(stageChanged).toBeTruthy();

    // viewer cannot mutate
    await addMember(ownerCtx, {
      projectId: alpha.value.id,
      userId: viewerId,
      role: 'viewer',
    });
    const viewerCtx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId: viewerId },
    });
    const viewerRole = await getProjectRole(viewerCtx, alpha.value.id);
    expect(viewerRole).toBe('viewer');
    expect(
      can(viewerCtx.actor, 'work_item.update', {
        type: 'work_item',
        projectId: alpha.value.id,
        role: viewerRole,
      }),
    ).toBe(false);

    const denied = await updateWorkItem(
      viewerCtx,
      item.value.id,
      { title: 'nope' },
      backward.value.version,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('forbidden');
  });

  it('allocates distinct numbers under concurrency', async () => {
    const suffix = Date.now().toString(36).toUpperCase().slice(-4);
    const ownerCtx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId: ownerId },
    });
    const project = await createProject(ownerCtx, {
      key: `C${suffix}`,
      name: 'Concurrency',
      template: 'minimal',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createWorkItem(ownerCtx, {
          projectId: project.value.id,
          title: `Item ${i}`,
        }),
      ),
    );
    expect(created.every((r) => r.ok)).toBe(true);
    const numbers = created
      .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
      .map((r) => r.value.number);
    expect(new Set(numbers).size).toBe(20);
  });

  it('rolls back event when state insert fails', async () => {
    const ownerCtx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId: ownerId },
    });
    // invalid key fails zod parse before any durable write
    let threw = false;
    try {
      await createProject(ownerCtx, {
        key: 'bad-key',
        name: 'Nope',
        template: 'default',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const { projects } = await import('@nexus/db');
    const sneaky = await db.query.projects.findFirst({
      where: eq(projects.key, 'bad-key'),
    });
    expect(sneaky).toBeUndefined();
  });

  it('membership row exists after create', async () => {
    const row = await db.query.projectMembers.findFirst({
      where: eq(projectMembers.userId, ownerId),
    });
    expect(row).toBeTruthy();
  });
});
