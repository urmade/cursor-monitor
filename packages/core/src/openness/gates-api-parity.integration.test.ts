import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDb, getDb, stages, workItems } from '@nexus/db';
import {
  createApiToken,
  createContext,
  createGate,
  createProject,
  createWorkItem,
  transitionWorkItem,
  updateWorkItem,
  upsertUserFromPassport,
} from '../index';

process.env.FLAG_P3_GATES = '1';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('API token vs human gate parity', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let ownerId = '';

  afterAll(async () => {
    await closeDb();
  });

  async function setupProject() {
    const owner = await upsertUserFromPassport(db, {
      externalSub: `p8-gate-owner-${Date.now()}`,
      email: `p8-gate-${Date.now()}@example.com`,
      name: 'P8 Gate',
    });
    orgId = owner.orgId;
    ownerId = owner.userId;

    const ctx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId: ownerId },
      flags: {
        async isEnabled(key: string) {
          return key === 'p3.gates' || process.env.FLAG_P3_GATES === '1';
        },
      },
    });

    const suffix = Date.now().toString(36).toUpperCase().slice(-5);
    const project = await createProject(ctx, {
      key: `P8G${suffix}`,
      name: 'API gate parity',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error('project');

    const { updateProject } = await import('../projects');
    await updateProject(ctx, project.value.id, {
      settings: { enforcement_mode: 'enforce' },
    });

    const stageRows = await db.query.stages.findMany({
      where: and(
        eq(stages.projectId, project.value.id),
        isNull(stages.archivedAt),
      ),
    });
    const find = (key: string) => {
      const s = stageRows.find((x) => x.key === key);
      if (!s) throw new Error(`missing stage ${key}`);
      return s;
    };

    const token = await createApiToken(ctx, {
      projectId: project.value.id,
      name: 'transition',
      scopes: ['items:read', 'items:write', 'items:transition'],
    });
    if (!token.ok) throw new Error('token');

    const apiCtx = createContext({
      db,
      orgId,
      actor: {
        kind: 'api_token',
        tokenId: token.value.tokenId,
        projectId: project.value.id,
        scopes: ['items:read', 'items:write', 'items:transition'],
      },
      flags: ctx.flags,
    });

    return {
      humanCtx: ctx,
      apiCtx,
      project: project.value,
      byKey: {
        intake: find('intake'),
        scoping: find('scoping'),
        plan: find('plan'),
      },
    };
  }

  it('api token transition is gate_blocked with same stage/version invariants as human', async () => {
    const { humanCtx, apiCtx, project, byKey } = await setupProject();

    const gate = await createGate(humanCtx, {
      projectId: project.id,
      name: 'Complexity required',
      evaluator: 'field_rule',
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
      config: {
        require: { op: 'exists', field: 'ticket.complexity' },
        message: 'Complexity must be set before Plan',
      },
      onFailure: 'block',
      enabled: true,
    });
    expect(gate.ok).toBe(true);

    const humanItem = await createWorkItem(humanCtx, {
      projectId: project.id,
      title: 'Human path',
    });
    const apiItem = await createWorkItem(apiCtx, {
      projectId: project.id,
      title: 'API path',
    });
    expect(humanItem.ok && apiItem.ok).toBe(true);
    if (!humanItem.ok || !apiItem.ok) return;

    async function moveToScoping(
      ctx: typeof humanCtx,
      itemId: string,
      version: number,
    ) {
      const row = await db.query.workItems.findFirst({
        where: eq(workItems.id, itemId),
      });
      if (!row) throw new Error('item');
      if (row.currentStageId === byKey.scoping.id) return row;
      const moved = await transitionWorkItem(
        ctx,
        itemId,
        { toStageId: byKey.scoping.id },
        version,
      );
      if (!moved.ok) throw new Error(moved.error.message);
      return moved.value;
    }

    const humanCurrent = await moveToScoping(
      humanCtx,
      humanItem.value.id,
      humanItem.value.version,
    );
    const apiCurrent = await moveToScoping(
      apiCtx,
      apiItem.value.id,
      apiItem.value.version,
    );

    const humanBlocked = await transitionWorkItem(
      humanCtx,
      humanCurrent.id,
      { toStageId: byKey.plan.id },
      humanCurrent.version,
    );
    expect(humanBlocked.ok).toBe(false);
    if (humanBlocked.ok) return;
    expect(humanBlocked.error.code).toBe('gate_blocked');

    const apiBlocked = await transitionWorkItem(
      apiCtx,
      apiCurrent.id,
      { toStageId: byKey.plan.id },
      apiCurrent.version,
    );
    expect(apiBlocked.ok).toBe(false);
    if (apiBlocked.ok) return;
    expect(apiBlocked.error.code).toBe('gate_blocked');

    const humanAfter = await db.query.workItems.findFirst({
      where: eq(workItems.id, humanCurrent.id),
    });
    const apiAfter = await db.query.workItems.findFirst({
      where: eq(workItems.id, apiCurrent.id),
    });
    expect(humanAfter?.currentStageId).toBe(humanCurrent.currentStageId);
    expect(apiAfter?.currentStageId).toBe(apiCurrent.currentStageId);
    expect(humanAfter?.version).toBe(humanCurrent.version);
    expect(apiAfter?.version).toBe(apiCurrent.version);

    await updateWorkItem(apiCtx, apiCurrent.id, { complexity: 'medium' }, apiAfter!.version);
    const apiReady = await db.query.workItems.findFirst({
      where: eq(workItems.id, apiCurrent.id),
    });
    const apiOk = await transitionWorkItem(
      apiCtx,
      apiCurrent.id,
      { toStageId: byKey.plan.id },
      apiReady!.version,
    );
    expect(apiOk.ok).toBe(true);
  });
});
