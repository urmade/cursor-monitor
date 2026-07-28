/**
 * Seed demo data for Phase 1.
 * Usage: pnpm db:seed
 *        pnpm db:seed -- --demo
 */
import { eq } from 'drizzle-orm';
import { closeDb, getDb, orgs, stages } from '@nexus/db';
import { createContext } from './context';
import { upsertUserFromPassport } from './identity/upsert';
import { addStage, createProject } from './projects';
import {
  createWorkItem,
  setLabels,
  transitionWorkItem,
} from './workitems';
import { createSpecVersion } from './specs';

async function main(): Promise<void> {
  const demo = process.argv.includes('--demo');
  const db = getDb();

  const { userId, orgId } = await upsertUserFromPassport(db, {
    externalSub: 'local-dev-user',
    email: 'local@example.com',
    name: 'Local Dev',
  });

  const ctx = createContext({
    db,
    orgId,
    actor: { kind: 'human', userId },
  });

  await db.update(orgs).set({ name: 'Anysphere' }).where(eq(orgs.id, orgId));

  // Phase 3 rollout flag — enabled for seeded projects by default.
  const { featureFlags } = await import('@nexus/db');
  await db
    .insert(featureFlags)
    .values({
      key: 'p3.gates',
      enabled: true,
      enabledForProjectIds: [],
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: { enabled: true, updatedAt: new Date() },
    });

  await db
    .insert(featureFlags)
    .values({
      key: 'p4.budgets',
      enabled: true,
      enabledForProjectIds: [],
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: { enabled: true, updatedAt: new Date() },
    });

  await db
    .insert(featureFlags)
    .values({
      key: 'p5.loops',
      enabled: true,
      enabledForProjectIds: [],
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: { enabled: true, updatedAt: new Date() },
    });

  await db
    .insert(featureFlags)
    .values({
      key: 'p6.inbox',
      enabled: true,
      enabledForProjectIds: [],
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: { enabled: true, updatedAt: new Date() },
    });

  // p7.agentic_gates removed (step 7.7) — agentic gates are always available.

  for (const key of ['p8.api', 'p8.webhooks'] as const) {
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

  const alpha = await createProject(ctx, {
    key: 'ALPHA',
    name: 'Alpha',
    description: 'Default six-stage pipeline with risk/touches labels',
    template: 'default',
  });
  if (!alpha.ok) throw new Error(alpha.error.message);

  const { updateProject } = await import('./projects');
  await updateProject(ctx, alpha.value.id, {
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

  const beta = await createProject(ctx, {
    key: 'BETA',
    name: 'Beta',
    description: 'Minimal pipeline with product labels; Design stage added',
    template: 'minimal',
  });
  if (!beta.ok) throw new Error(beta.error.message);

  const betaStages = await db.query.stages.findMany({
    where: eq(stages.projectId, beta.value.id),
  });
  const intake = betaStages.find((s) => s.key === 'intake');
  const impl = betaStages.find((s) => s.key === 'implementation');
  if (intake && impl) {
    await addStage(ctx, {
      projectId: beta.value.id,
      key: 'design',
      name: 'Design',
      position: Math.floor((intake.position + impl.position) / 2),
      defaultOwnerClass: 'human',
    });
  }

  if (demo) {
    const titles = [
      'Add SSO to the admin console',
      'Fix flaky board refresh',
      'Document deploy runbook',
      'Tighten label taxonomy copy',
      'Improve empty states',
      'Wire keyboard create shortcut',
      'Audit trail filters',
      'Spec version diff polish',
      'Member role change UX',
      'Board drag fallback',
      'Health queue depth check',
      'Seed idempotency note',
    ];

    for (let i = 0; i < titles.length; i += 1) {
      const projectId = i % 2 === 0 ? alpha.value.id : beta.value.id;
      const created = await createWorkItem(ctx, {
        projectId,
        title: titles[i]!,
        complexity: (['low', 'medium', 'high'] as const)[i % 3],
      });
      if (!created.ok) throw new Error(created.error.message);

      if (i === 0) {
        await setLabels(ctx, created.value.id, {
          add: ['risk:high', 'touches:auth'],
          remove: [],
        });
        await createSpecVersion(
          ctx,
          created.value.id,
          {
            summary: 'Bring Okta SSO to the admin console.',
            context: 'Operators currently share a break-glass password.',
            approach: 'Use Passport claims already available on the host.',
            openQuestions: ['Which roles map to admin?'],
          },
          'Initial draft',
        );
        await createSpecVersion(
          ctx,
          created.value.id,
          {
            summary: 'Bring Okta SSO to the admin console with role mapping.',
            context: 'Operators currently share a break-glass password.',
            approach: 'Map Passport groups to Nexus project roles.',
            openQuestions: [],
          },
          'Revise role mapping',
        );
        await createSpecVersion(
          ctx,
          created.value.id,
          {
            summary: 'Bring Okta SSO to the admin console with role mapping.',
            context: 'Operators currently share a break-glass password.',
            approach:
              'Map Passport groups to Nexus project roles; viewer default.',
            openQuestions: [],
          },
          'Clarify default role',
        );

        const alphaStages = await db.query.stages.findMany({
          where: eq(stages.projectId, alpha.value.id),
        });
        const ordered = [...alphaStages].sort((a, b) => a.position - b.position);
        let version = created.value.version;
        const next = ordered[1];
        if (next) {
          const moved = await transitionWorkItem(
            ctx,
            created.value.id,
            { toStageId: next.id, note: 'Start scoping' },
            version,
          );
          if (moved.ok) version = moved.value.version;
        }
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        orgId,
        userId,
        projects: [
          { key: alpha.value.key, id: alpha.value.id },
          { key: beta.value.key, id: beta.value.id },
        ],
        demo,
      },
      null,
      2,
    ),
  );

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
