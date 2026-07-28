import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  closeDb,
  getDb,
  gateEvaluations,
  interventions,
  stages,
  warnings,
  workItems,
} from '@nexus/db';
import {
  createContext,
  createGate,
  createProject,
  createWorkItem,
  decideApproval,
  dismissWarning,
  evaluateGates,
  listWarnings,
  transitionWorkItem,
  updateGate,
  updateWorkItem,
  upsertUserFromPassport,
  setLabels,
} from '../index';

process.env.FLAG_P3_GATES = '1';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('phase 3 gates integration', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let ownerId = '';
  let memberId = '';

  beforeAll(async () => {
    const owner = await upsertUserFromPassport(db, {
      externalSub: `p3-owner-${Date.now()}`,
      email: 'p3-owner@example.com',
      name: 'P3 Owner',
    });
    orgId = owner.orgId;
    ownerId = owner.userId;

    const member = await upsertUserFromPassport(db, {
      externalSub: `p3-member-${Date.now()}`,
      email: 'p3-member@example.com',
      name: 'P3 Member',
    });
    memberId = member.userId;
  });

  afterAll(async () => {
    await closeDb();
  });

  async function setupProject() {
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
      key: `P3${suffix}`,
      name: 'Phase3 Test',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error('project failed');

    // Enable enforcement
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
    const byKey = {
      intake: find('intake'),
      scoping: find('scoping'),
      plan: find('plan'),
      implementation: find('implementation'),
      review: find('review'),
      deploy: find('deploy'),
    };
    return { ctx, project: project.value, byKey };
  }

  it('blocks transition without mutating stage when complexity missing', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'No complexity',
    });
    expect(item.ok).toBe(true);
    if (!item.ok) return;

    const gate = await createGate(ctx, {
      projectId: project.id,
      name: 'Complexity required',
      evaluator: 'field_rule',
      trigger: {
        kind: 'on_transition',
        toStageId: byKey.plan.id,
      },
      config: {
        require: { op: 'exists', field: 'ticket.complexity' },
        message: 'Complexity must be set before Plan',
      },
      onFailure: 'block',
      enabled: true,
    });
    expect(gate.ok).toBe(true);

    let current = item.value;
    // Move intake → scoping if needed
    if (current.currentStageId !== byKey.scoping.id) {
      const toScoping = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey.scoping.id },
        current.version,
      );
      if (toScoping.ok) current = toScoping.value;
    }

    const beforeStage = current.currentStageId;
    const beforeVersion = current.version;
    const blocked = await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: byKey.plan.id },
      current.version,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.code).toBe('gate_blocked');

    const refreshed = await db.query.workItems.findFirst({
      where: eq(workItems.id, current.id),
    });
    expect(refreshed?.currentStageId).toBe(beforeStage);
    expect(refreshed?.version).toBe(beforeVersion);

    await updateWorkItem(ctx, current.id, { complexity: 'medium' }, current.version);
    const afterUpdate = await db.query.workItems.findFirst({
      where: eq(workItems.id, current.id),
    });
    const okMove = await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: byKey.plan.id },
      afterUpdate!.version,
    );
    expect(okMove.ok).toBe(true);
  });

  it('human approval holds then completes original transition', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'Needs approval',
      complexity: 'low',
    });
    if (!item.ok) return;

    const impl = byKey.implementation;
    const gate = await createGate(ctx, {
      projectId: project.id,
      name: 'Implementation requires Pass',
      evaluator: 'human_approval',
      trigger: { kind: 'on_transition', toStageId: impl.id },
      config: {
        approverRoles: ['owner', 'maintainer'],
        allowSelfApproval: true,
        instructions: 'Confirm ready for implementation',
      },
      onFailure: 'block',
      enabled: true,
    });
    expect(gate.ok).toBe(true);

    let current = item.value;
    for (const key of ['scoping', 'plan'] as const) {
      if (current.currentStageId === byKey[key].id) continue;
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey[key].id },
        current.version,
      );
      if (r.ok) current = r.value;
    }

    const blocked = await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: impl.id },
      current.version,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.code).toBe('gate_blocked');
    const details = blocked.error.details as {
      blockedBy: Array<{ approvalId?: string }>;
    };
    const approvalId = details.blockedBy[0]?.approvalId;
    expect(approvalId).toBeTruthy();

    const decided = await decideApproval(ctx, approvalId!, {
      decision: 'approved',
      comment: 'LGTM',
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.value.transitionCompleted).toBe(true);

    const refreshed = await db.query.workItems.findFirst({
      where: eq(workItems.id, current.id),
    });
    expect(refreshed?.currentStageId).toBe(impl.id);
  });

  it('warn creates durable warning; later gate consumes it', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'Warn then block',
      complexity: 'high',
    });
    if (!item.ok) return;

    const warnGate = await createGate(ctx, {
      projectId: project.id,
      name: 'Thin spec',
      evaluator: 'field_rule',
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
      config: {
        require: { op: 'exists', field: 'spec.exists' },
        message: 'spec missing — warning',
        code: 'spec.thin',
      },
      onFailure: 'warn',
      enabled: true,
    });
    expect(warnGate.ok).toBe(true);

    const consume = await createGate(ctx, {
      projectId: project.id,
      name: 'No open warnings on deploy',
      evaluator: 'field_rule',
      trigger: {
        kind: 'on_transition',
        toStageId: byKey.deploy.id,
      },
      config: {
        require: {
          op: 'not',
          of: { op: 'count_gte', field: 'warnings.open.count', value: 1 },
        },
        message: 'Open warnings must be cleared',
      },
      onFailure: 'block',
      enabled: true,
    });
    expect(consume.ok).toBe(true);

    let current = item.value;
    if (current.currentStageId !== byKey.scoping.id) {
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey.scoping.id },
        current.version,
      );
      if (r.ok) current = r.value;
    }
    const move = await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: byKey.plan.id },
      current.version,
    );
    if (move.ok) current = move.value;

    const open = await listWarnings(ctx, current.id, { status: 'open' });
    expect(open.ok).toBe(true);
    if (open.ok) {
      expect(open.value.some((w) => w.code === 'spec.thin')).toBe(true);
    }

    const batch = await evaluateGates(ctx, {
      workItemId: current.id,
      trigger: { kind: 'on_transition', toStageId: byKey.deploy.id },
      dryRun: true,
    });
    expect(batch.ok).toBe(true);
    if (batch.ok) {
      expect(batch.value.outcome).toBe('block');
    }
  });

  it('override records intervention and gate edit does not rewrite history', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'Override me',
    });
    if (!item.ok) return;

    const gate = await createGate(ctx, {
      projectId: project.id,
      name: 'Always block',
      evaluator: 'field_rule',
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
      config: {
        require: { op: 'eq', field: 'ticket.complexity', value: 'impossible' },
        message: 'Impossible',
      },
      onFailure: 'block',
      enabled: true,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;

    let current = item.value;
    if (current.currentStageId !== byKey.scoping.id) {
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey.scoping.id },
        current.version,
      );
      if (r.ok) current = r.value;
    }

    const blocked = await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: byKey.plan.id },
      current.version,
    );
    expect(blocked.ok).toBe(false);

    const overridden = await transitionWorkItem(
      ctx,
      current.id,
      {
        toStageId: byKey.plan.id,
        override: { reason: 'Demo override — shipping anyway' },
      },
      current.version,
    );
    expect(overridden.ok).toBe(true);

    const ints = await db.query.interventions.findMany({
      where: eq(interventions.workItemId, current.id),
    });
    expect(ints.some((i) => i.kind === 'gate_override')).toBe(true);

    const evalsBefore = await db.query.gateEvaluations.findMany({
      where: eq(gateEvaluations.gateId, gate.value.id),
    });
    const storedVersion = evalsBefore[0]?.gateVersion;
    const storedConfig = evalsBefore[0]?.gateConfig;

    await updateGate(ctx, gate.value.id, {
      config: {
        require: { op: 'exists', field: 'ticket.complexity' },
        message: 'Changed later',
      },
    });

    const evalsAfter = await db.query.gateEvaluations.findMany({
      where: eq(gateEvaluations.id, evalsBefore[0]!.id),
    });
    expect(evalsAfter[0]?.gateVersion).toBe(storedVersion);
    expect(evalsAfter[0]?.gateConfig).toEqual(storedConfig);
  });

  it('dismiss warning records intervention', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'Dismiss warn',
    });
    if (!item.ok) return;

    await createGate(ctx, {
      projectId: project.id,
      name: 'Warn always',
      evaluator: 'field_rule',
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
      config: {
        require: { op: 'exists', field: 'ticket.complexity' },
        message: 'complexity missing',
        code: 'complexity.missing',
      },
      onFailure: 'warn',
      enabled: true,
    });

    let current = item.value;
    if (current.currentStageId !== byKey.scoping.id) {
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey.scoping.id },
        current.version,
      );
      if (r.ok) current = r.value;
    }

    await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: byKey.plan.id },
      current.version,
    );

    const open = await listWarnings(ctx, current.id, { status: 'open' });
    expect(open.ok && open.value.length > 0).toBe(true);
    if (!open.ok || !open.value[0]) return;

    const dismissed = await dismissWarning(ctx, open.value[0].id, 'Accepted risk');
    expect(dismissed.ok).toBe(true);

    const still = await db.query.warnings.findFirst({
      where: eq(warnings.id, open.value[0].id),
    });
    expect(still?.status).toBe('dismissed');
  });

  it('on_label_added gate fires from setLabels', async () => {
    const { ctx, project } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'Label gate',
      complexity: 'low',
    });
    if (!item.ok) return;

    await createGate(ctx, {
      projectId: project.id,
      name: 'Risk label warning',
      evaluator: 'field_rule',
      trigger: { kind: 'on_label_added', labelKey: 'risk:high' },
      config: {
        require: { op: 'lacks_label', value: 'risk:high' },
        message: 'risk:high was added',
        code: 'risk.high',
      },
      onFailure: 'warn',
      enabled: true,
    });

    await setLabels(ctx, item.value.id, { add: ['risk:high'], remove: [] });

    const open = await listWarnings(ctx, item.value.id, { status: 'open' });
    expect(open.ok && open.value.some((w) => w.code === 'risk.high')).toBe(true);
  });

  it('B1: allowSelfApproval false forbids same actor decideApproval', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'Self approve blocked',
      complexity: 'low',
    });
    if (!item.ok) return;

    const impl = byKey.implementation;
    const gate = await createGate(ctx, {
      projectId: project.id,
      name: 'No self approve',
      evaluator: 'human_approval',
      trigger: { kind: 'on_transition', toStageId: impl.id },
      config: {
        approverRoles: ['owner', 'maintainer'],
        allowSelfApproval: false,
        instructions: 'Someone else must approve',
      },
      onFailure: 'block',
      enabled: true,
    });
    expect(gate.ok).toBe(true);

    let current = item.value;
    for (const key of ['scoping', 'plan'] as const) {
      if (current.currentStageId === byKey[key].id) continue;
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey[key].id },
        current.version,
      );
      if (r.ok) current = r.value;
    }

    const blocked = await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: impl.id },
      current.version,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    const details = blocked.error.details as {
      blockedBy: Array<{ approvalId?: string }>;
    };
    const approvalId = details.blockedBy[0]?.approvalId;
    expect(approvalId).toBeTruthy();

    const decided = await decideApproval(ctx, approvalId!, {
      decision: 'approved',
      comment: 'same person',
    });
    expect(decided.ok).toBe(false);
    if (!decided.ok) {
      expect(decided.error.code).toBe('forbidden');
    }
  });

  it('B3: approved attempt does not mint duplicate pending on re-eval', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'Approval dedupe',
      complexity: 'low',
    });
    if (!item.ok) return;

    const impl = byKey.implementation;
    await createGate(ctx, {
      projectId: project.id,
      name: 'Approve once',
      evaluator: 'human_approval',
      trigger: { kind: 'on_transition', toStageId: impl.id },
      config: {
        approverRoles: ['owner'],
        allowSelfApproval: true,
        instructions: 'ok',
      },
      onFailure: 'block',
      enabled: true,
    });

    let current = item.value;
    for (const key of ['scoping', 'plan'] as const) {
      if (current.currentStageId === byKey[key].id) continue;
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey[key].id },
        current.version,
      );
      if (r.ok) current = r.value;
    }

    const blocked = await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: impl.id },
      current.version,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    const approvalId = (
      blocked.error.details as { blockedBy: Array<{ approvalId?: string }> }
    ).blockedBy[0]?.approvalId!;

    const decided = await decideApproval(ctx, approvalId, {
      decision: 'approved',
    });
    expect(decided.ok && decided.value.transitionCompleted).toBe(true);

    const { approvals } = await import('@nexus/db');
    const rows = await db.query.approvals.findMany({
      where: eq(approvals.workItemId, current.id),
    });
    const pending = rows.filter((r) => r.status === 'pending');
    const approved = rows.filter((r) => r.status === 'approved');
    expect(approved.length).toBeGreaterThanOrEqual(1);
    expect(pending.length).toBe(0);
  });

  it('B5: override clears blocked_by_gate status', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'Status after override',
    });
    if (!item.ok) return;

    await createGate(ctx, {
      projectId: project.id,
      name: 'Always block',
      evaluator: 'field_rule',
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
      config: {
        require: { op: 'eq', field: 'ticket.complexity', value: 'impossible' },
        message: 'Impossible',
      },
      onFailure: 'block',
      enabled: true,
    });

    let current = item.value;
    if (current.currentStageId !== byKey.scoping.id) {
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey.scoping.id },
        current.version,
      );
      if (r.ok) current = r.value;
    }

    await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: byKey.plan.id },
      current.version,
    );

    const { deriveWorkItemStatus } = await import('../status/facts');
    const before = await deriveWorkItemStatus(ctx, current.id);
    expect(before).toBe('blocked_by_gate');

    const overridden = await transitionWorkItem(
      ctx,
      current.id,
      {
        toStageId: byKey.plan.id,
        override: { reason: 'Ship anyway for status test' },
      },
      current.version,
    );
    expect(overridden.ok).toBe(true);

    const after = await deriveWorkItemStatus(ctx, current.id);
    expect(after).not.toBe('blocked_by_gate');
  });

  it('dismissed warning is not recreated while still failing', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'Dismiss sticks',
    });
    if (!item.ok) return;

    await createGate(ctx, {
      projectId: project.id,
      name: 'Warn always',
      evaluator: 'field_rule',
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
      config: {
        require: { op: 'exists', field: 'ticket.complexity' },
        message: 'complexity missing',
        code: 'complexity.missing',
      },
      onFailure: 'warn',
      enabled: true,
    });

    let current = item.value;
    if (current.currentStageId !== byKey.scoping.id) {
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey.scoping.id },
        current.version,
      );
      if (r.ok) current = r.value;
    }

    const moved = await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: byKey.plan.id },
      current.version,
    );
    if (moved.ok) current = moved.value;

    const open = await listWarnings(ctx, current.id, { status: 'open' });
    expect(open.ok && open.value[0]).toBeTruthy();
    if (!open.ok || !open.value[0]) return;

    await dismissWarning(ctx, open.value[0].id, 'Accepted risk');

    await evaluateGates(ctx, {
      workItemId: current.id,
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
    });

    const openAgain = await listWarnings(ctx, current.id, { status: 'open' });
    expect(openAgain.ok && openAgain.value.length).toBe(0);
  });

  it('D1: slug-derived warning code resolves when gate later passes', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'No explicit code',
    });
    if (!item.ok) return;

    // No config.code — evaluator mints slug from gate name ("Spec recommended" → spec.recommended)
    await createGate(ctx, {
      projectId: project.id,
      name: 'Spec recommended',
      evaluator: 'field_rule',
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
      config: {
        require: { op: 'exists', field: 'ticket.complexity' },
        message: 'set complexity',
      },
      onFailure: 'warn',
      enabled: true,
    });

    let current = item.value;
    if (current.currentStageId !== byKey.scoping.id) {
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey.scoping.id },
        current.version,
      );
      if (r.ok) current = r.value;
    }

    await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: byKey.plan.id },
      current.version,
    );

    const afterWarn = await listWarnings(ctx, current.id, { status: 'open' });
    expect(afterWarn.ok).toBe(true);
    if (!afterWarn.ok) return;
    expect(afterWarn.value.some((w) => w.code === 'spec.recommended')).toBe(
      true,
    );

    const refreshed = await db.query.workItems.findFirst({
      where: eq(workItems.id, current.id),
    });
    await updateWorkItem(
      ctx,
      current.id,
      { complexity: 'medium' },
      refreshed!.version,
    );

    await evaluateGates(ctx, {
      workItemId: current.id,
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
    });

    const afterPass = await listWarnings(ctx, current.id, { status: 'open' });
    expect(afterPass.ok && afterPass.value.length).toBe(0);
  });

  it('D4: dismissed warning can raise again after gate passes then regresses', async () => {
    const { ctx, project, byKey } = await setupProject();
    const item = await createWorkItem(ctx, {
      projectId: project.id,
      title: 'Dismiss then re-raise',
    });
    if (!item.ok) return;

    await createGate(ctx, {
      projectId: project.id,
      name: 'Complexity check',
      evaluator: 'field_rule',
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
      config: {
        require: { op: 'exists', field: 'ticket.complexity' },
        message: 'complexity missing',
        code: 'complexity.missing',
      },
      onFailure: 'warn',
      enabled: true,
    });

    let current = item.value;
    if (current.currentStageId !== byKey.scoping.id) {
      const r = await transitionWorkItem(
        ctx,
        current.id,
        { toStageId: byKey.scoping.id },
        current.version,
      );
      if (r.ok) current = r.value;
    }

    await transitionWorkItem(
      ctx,
      current.id,
      { toStageId: byKey.plan.id },
      current.version,
    );

    const open = await listWarnings(ctx, current.id, { status: 'open' });
    expect(open.ok && open.value[0]).toBeTruthy();
    if (!open.ok || !open.value[0]) return;
    await dismissWarning(ctx, open.value[0].id, 'temp accept');

    // Pass: set complexity → resolves dismissed row
    let row = await db.query.workItems.findFirst({
      where: eq(workItems.id, current.id),
    });
    await updateWorkItem(ctx, current.id, { complexity: 'low' }, row!.version);
    await evaluateGates(ctx, {
      workItemId: current.id,
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
    });
    const resolved = await listWarnings(ctx, current.id, { status: 'all' });
    expect(
      resolved.ok &&
        resolved.value.every(
          (w) => w.code !== 'complexity.missing' || w.status === 'resolved',
        ),
    ).toBe(true);

    // Regress: clear complexity → fresh open warning
    row = await db.query.workItems.findFirst({
      where: eq(workItems.id, current.id),
    });
    await updateWorkItem(ctx, current.id, { complexity: null }, row!.version);
    await evaluateGates(ctx, {
      workItemId: current.id,
      trigger: { kind: 'on_transition', toStageId: byKey.plan.id },
    });

    const raised = await listWarnings(ctx, current.id, { status: 'open' });
    expect(
      raised.ok && raised.value.some((w) => w.code === 'complexity.missing'),
    ).toBe(true);
  });
});
