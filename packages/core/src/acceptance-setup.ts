/**
 * Acceptance fixture: clean project with pipeline, labels, budgets, gates
 * for the VISION.md §16 walkthrough.
 *
 * Usage: pnpm acceptance:setup
 *
 * B7: projects are visible to the local-dev operator (membership), and history
 * seeding invalidates the estimate cache so later creates get real ranges.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  closeDb,
  featureFlags,
  getDb,
  orgs,
  projectMembers,
  workItems,
} from '@nexus/db';
import {
  addStage,
  createContext,
  createGate,
  createProject,
  createWorkItem,
  invalidateEstimateCacheForProject,
  upsertLabel,
  upsertUserFromPassport,
  updateProject,
} from './index';

async function ensureFlag(
  db: ReturnType<typeof getDb>,
  key: string,
  userId: string,
) {
  await db
    .insert(featureFlags)
    .values({
      key,
      enabled: true,
      enabledForProjectIds: [],
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: { enabled: true, updatedAt: new Date() },
    });
}

async function main() {
  const db = getDb();
  // Operator (Passport local-dev) and fixture actor share the default org.
  const operator = await upsertUserFromPassport(db, {
    externalSub: 'local-dev-user',
    email: 'dev@localhost',
    name: 'Local Dev',
  });
  const { userId, orgId } = await upsertUserFromPassport(db, {
    externalSub: 'acceptance-user',
    email: 'acceptance@example.com',
    name: 'Acceptance',
  });
  await db.update(orgs).set({ name: 'Acceptance Org' }).where(eq(orgs.id, orgId));

  const ctx = createContext({
    db,
    orgId,
    actor: { kind: 'human', userId },
  });

  for (const key of [
    'p3.gates',
    'p4.budgets',
    'p5.loops',
    'p6.inbox',
    'p7.agentic_gates',
    'p8.api',
    'p8.webhooks',
    'p9.estimates',
  ]) {
    await ensureFlag(db, key, userId);
  }

  const suffix = Date.now().toString(36).toUpperCase().slice(-4);
  const project = await createProject(ctx, {
    key: `POC${suffix}`,
    name: 'PoC Acceptance',
    description: 'Clean-environment §16 walkthrough project',
    template: 'default',
  });
  if (!project.ok) throw new Error(project.error.message);

  // B7: operator must see the project via listProjects membership filter.
  await db
    .insert(projectMembers)
    .values({
      projectId: project.value.id,
      userId: operator.userId,
      role: 'owner',
    })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role: 'owner', updatedAt: new Date() },
    });

  await updateProject(ctx, project.value.id, {
    settings: {
      budget: {
        burnCapMicroUsd: String(100_000_000n),
        complexityDefaults: {
          low: { softMicroUsd: '2000000', hardMicroUsd: '5000000' },
          medium: { softMicroUsd: '5000000', hardMicroUsd: '15000000' },
          high: { softMicroUsd: '15000000', hardMicroUsd: '50000000' },
        },
        reserveMicroUsdPerRun: '2000000',
        blockOnBurnCap: true,
      },
    },
  });

  const stages = await db.query.stages.findMany({
    where: (s, { eq: e }) => e(s.projectId, project.value.id),
  });
  const ready = stages.find((s) => s.key === 'ready');
  const plan = stages.find((s) => s.key === 'plan');
  if (ready) {
    const humanGate = await createGate(ctx, {
      projectId: project.value.id,
      name: 'Ready human approval',
      evaluator: 'human_approval',
      trigger: { kind: 'on_transition', toStageId: ready.id },
      config: {
        approverRoles: ['owner', 'maintainer', 'member'],
        instructions: 'Approve Ready for acceptance walkthrough',
      },
      onFailure: 'block',
      enabled: true,
    });
    if (!humanGate.ok) {
      console.warn('human gate:', humanGate.error.message);
    }
  }

  if (plan) {
    const fieldGate = await createGate(ctx, {
      projectId: project.value.id,
      name: 'Complexity required',
      evaluator: 'field_rule',
      trigger: { kind: 'on_transition', toStageId: plan.id },
      config: {
        require: { op: 'exists', field: 'ticket.complexity' },
        message: 'Complexity must be set before Plan',
      },
      onFailure: 'block',
      enabled: true,
    });
    if (!fieldGate.ok) {
      console.warn('field gate:', fieldGate.error.message);
    }
  }

  const deploy = stages.find((s) => s.isTerminal);
  for (let i = 0; i < 6; i++) {
    const item = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: `History High ${i}`,
      complexity: 'high',
      labelKeys: ['risk:high'],
    });
    if (!item.ok || !deploy) continue;
    await db
      .update(workItems)
      .set({
        spendMicroUsd: BigInt((i + 2) * 8_000_000),
        spendSource: 'provider',
        currentStageId: deploy.id,
        updatedAt: new Date(Date.UTC(2026, 5, i + 1)),
      })
      .where(eq(workItems.id, item.value.id));
  }

  // B7 / M24: raw UPDATEs skip transition hooks — invalidate so the next
  // creates see the completed history instead of the cold-start cache entry.
  await invalidateEstimateCacheForProject(ctx, project.value.id);

  // Seed two more completed items *after* history so estimate_at_creation is a
  // ranged snapshot — EstimateVersusActual has something to render.
  for (let i = 0; i < 2; i++) {
    const item = await createWorkItem(ctx, {
      projectId: project.value.id,
      title: `Ranged High ${i}`,
      complexity: 'high',
      labelKeys: ['risk:high'],
    });
    if (!item.ok || !deploy) continue;
    await db
      .update(workItems)
      .set({
        spendMicroUsd: BigInt((i + 8) * 8_000_000),
        spendSource: 'provider',
        currentStageId: deploy.id,
        updatedAt: new Date(Date.UTC(2026, 5, 10 + i)),
      })
      .where(eq(workItems.id, item.value.id));
  }
  await invalidateEstimateCacheForProject(ctx, project.value.id);

  const cold = await createProject(ctx, {
    key: `COLD${suffix}`,
    name: 'Cold Start',
    template: 'empty',
  });
  if (cold.ok) {
    await db
      .insert(projectMembers)
      .values({
        projectId: cold.value.id,
        userId: operator.userId,
        role: 'owner',
      })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: 'owner', updatedAt: new Date() },
      });
    await addStage(ctx, {
      projectId: cold.value.id,
      key: 'start',
      name: 'Start',
      position: 0,
      defaultOwnerClass: 'human',
      isInitial: true,
    });
    await addStage(ctx, {
      projectId: cold.value.id,
      key: 'end',
      name: 'End',
      position: 1,
      defaultOwnerClass: 'human',
      isTerminal: true,
    });
    await upsertLabel(ctx, {
      projectId: cold.value.id,
      key: 'risk:high',
      name: 'Risk High',
      color: 'red',
    });
  }

  const fixture = {
    orgId,
    acceptanceProjectKey: project.value.key,
    coldProjectKey: cold.ok ? cold.value.key : null,
    operatorUserId: operator.userId,
  };

  const outPath = resolve(
    process.cwd().endsWith('packages/core')
      ? '../../apps/web/e2e/.acceptance-fixture.json'
      : 'apps/web/e2e/.acceptance-fixture.json',
  );
  writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');

  console.log(JSON.stringify(fixture, null, 2));

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
