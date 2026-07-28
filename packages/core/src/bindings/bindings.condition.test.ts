import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@nexus/db';
import {
  BindingConditionSchema,
} from '@nexus/contracts';
import {
  createContext,
  createProject,
  upsertBinding,
  upsertUserFromPassport,
} from '../index';
import { and, eq, isNull } from 'drizzle-orm';
import { stages } from '@nexus/db';

const hasDb = Boolean(process.env.DB_POSTGRES_URL);

describe.runIf(hasDb)('binding condition envelope round-trip', () => {
  const db = hasDb ? getDb() : (null as unknown as ReturnType<typeof getDb>);
  let orgId = '';
  let userId = '';

  beforeAll(async () => {
    const u = await upsertUserFromPassport(db, {
      externalSub: `bind-env-${Date.now()}`,
      email: 'bind@example.com',
      name: 'Bind',
    });
    orgId = u.orgId;
    userId = u.userId;
  });

  afterAll(async () => {
    await closeDb();
  });

  it('preserves { v:1, ast } through BindingConditionSchema and upsertBinding', async () => {
    const envelope = {
      v: 1 as const,
      ast: { op: 'has_label' as const, value: 'risk:high' },
    };
    const parsed = BindingConditionSchema.parse(envelope);
    expect(parsed).toEqual(envelope);
    expect(parsed).not.toEqual({});

    const ctx = createContext({
      db,
      orgId,
      actor: { kind: 'human', userId },
      flags: { async isEnabled() { return true; } },
    });
    const project = await createProject(ctx, {
      key: `BE${Date.now().toString(36).toUpperCase().slice(-4)}`,
      name: 'Binding Envelope',
      template: 'default',
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const stage = await db.query.stages.findFirst({
      where: and(
        eq(stages.projectId, project.value.id),
        isNull(stages.archivedAt),
      ),
    });
    expect(stage).toBeTruthy();

    const binding = await upsertBinding(ctx, {
      projectId: project.value.id,
      stageId: stage!.id,
      name: 'Scoped binding',
      adapter: 'cloud_agent',
      condition: envelope,
      config: {
        adapter: 'cloud_agent',
        noRepo: true,
      },
      enabled: false,
    });
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(binding.value.condition).toEqual(envelope);
  });
});
