import { describe, expect, it } from 'vitest';
import { worstOutcome } from './evaluate';
import { canDecideApproval } from '../approvals';
import { triggerMatches } from './evaluators';
import type { GateTrigger } from '@nexus/contracts';

describe('worstOutcome', () => {
  it('selects block over warn over pass', () => {
    expect(worstOutcome(['pass', 'warn', 'pass'])).toBe('warn');
    expect(worstOutcome(['pass', 'block', 'warn'])).toBe('block');
    expect(worstOutcome(['pass', 'skipped', 'pass'])).toBe('pass');
    expect(worstOutcome(['error'])).toBe('block');
    expect(worstOutcome([])).toBe('pass');
  });
});

describe('triggerMatches', () => {
  const to = '00000000-0000-7000-8000-000000000010';
  const from = '00000000-0000-7000-8000-000000000011';

  it('matches on_transition by toStageId', () => {
    const gate: GateTrigger = { kind: 'on_transition', toStageId: to };
    const ev: GateTrigger = {
      kind: 'on_transition',
      fromStageId: from,
      toStageId: to,
    };
    expect(triggerMatches(gate, ev)).toBe(true);
  });

  it('rejects mismatched toStageId', () => {
    const gate: GateTrigger = { kind: 'on_transition', toStageId: to };
    const ev: GateTrigger = {
      kind: 'on_transition',
      toStageId: from,
    };
    expect(triggerMatches(gate, ev)).toBe(false);
  });

  it('matches on_label_added exactly', () => {
    expect(
      triggerMatches(
        { kind: 'on_label_added', labelKey: 'risk:high' },
        { kind: 'on_label_added', labelKey: 'risk:high' },
      ),
    ).toBe(true);
    expect(
      triggerMatches(
        { kind: 'on_label_added', labelKey: 'risk:high' },
        { kind: 'on_label_added', labelKey: 'risk:low' },
      ),
    ).toBe(false);
  });
});

describe('canDecideApproval', () => {
  it('allows maintainer when approverRoles includes maintainer', () => {
    expect(
      canDecideApproval({
        actorRole: 'maintainer',
        approverRoles: ['maintainer'],
        allowSelfApproval: true,
        requesterUserId: 'a',
        actorUserId: 'b',
      }),
    ).toBe(true);
  });

  it('rejects member when only maintainer may approve', () => {
    expect(
      canDecideApproval({
        actorRole: 'member',
        approverRoles: ['maintainer'],
        allowSelfApproval: true,
        requesterUserId: null,
        actorUserId: 'b',
      }),
    ).toBe(false);
  });

  it('allows owner as implicit approver even when only maintainer listed', () => {
    expect(
      canDecideApproval({
        actorRole: 'owner',
        approverRoles: ['maintainer'],
        allowSelfApproval: true,
        requesterUserId: null,
        actorUserId: 'b',
      }),
    ).toBe(true);
  });

  it('rejects viewer when only viewer would pass via old rank semantics but owner-only list', () => {
    expect(
      canDecideApproval({
        actorRole: 'member',
        approverRoles: ['viewer'],
        allowSelfApproval: true,
        requesterUserId: null,
        actorUserId: 'b',
      }),
    ).toBe(false);
  });

  it('rejects owner self-approval when disallowed', () => {
    expect(
      canDecideApproval({
        actorRole: 'owner',
        approverRoles: ['owner'],
        allowSelfApproval: false,
        requesterUserId: 'same',
        actorUserId: 'same',
      }),
    ).toBe(false);
  });

  it('allows self-approval when enabled', () => {
    expect(
      canDecideApproval({
        actorRole: 'owner',
        approverRoles: ['owner'],
        allowSelfApproval: true,
        requesterUserId: 'same',
        actorUserId: 'same',
      }),
    ).toBe(true);
  });
});
