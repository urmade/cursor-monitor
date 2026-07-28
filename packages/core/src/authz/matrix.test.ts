import type { AuthzAction } from './actions';
import { ALL_AUTHZ_ACTIONS } from './actions';
import {
  PROJECT_SCOPED_ACTIONS,
  ROLE_MATRIX,
  type ProjectScopedAction,
} from './matrix';
import { can } from './can';
import type { Actor, ProjectRole } from '@nexus/contracts';
import { describe, expect, it } from 'vitest';

const human: Actor = {
  kind: 'human',
  userId: '00000000-0000-7000-8000-000000000001',
};

describe('generated permission matrix (Q12)', () => {
  const roles = Object.keys(ROLE_MATRIX) as ProjectRole[];

  it('covers every project-scoped AuthzAction', () => {
    const covered = new Set<string>(PROJECT_SCOPED_ACTIONS);
    for (const role of roles) {
      for (const action of Object.keys(ROLE_MATRIX[role]) as ProjectScopedAction[]) {
        expect(covered.has(action)).toBe(true);
      }
    }
    const orgOnly: AuthzAction[] = ['org.create', 'project.create'];
    for (const action of PROJECT_SCOPED_ACTIONS) {
      expect(orgOnly.includes(action as AuthzAction)).toBe(false);
    }
  });

  it('every AuthzAction is either org-only or listed in PROJECT_SCOPED_ACTIONS (M19)', () => {
    // Reverse of the matrix→actions check: adding a new AuthzAction without
    // registering it in PROJECT_SCOPED_ACTIONS must fail CI (§9.5).
    const orgOnly = new Set<string>(['org.create', 'project.create']);
    const covered = new Set<string>(PROJECT_SCOPED_ACTIONS);
    for (const action of ALL_AUTHZ_ACTIONS) {
      if (orgOnly.has(action)) continue;
      expect(covered.has(action)).toBe(true);
    }
  });

  for (const role of roles) {
    for (const action of PROJECT_SCOPED_ACTIONS) {
      it(`${role} ${action} → ${ROLE_MATRIX[role][action]}`, () => {
        const allowed = can(human, action, {
          type: 'work_item',
          projectId: 'proj',
          role,
        });
        expect(allowed).toBe(ROLE_MATRIX[role][action]);
      });
    }
  }

  it('api_token cannot cross projects', () => {
    const token: Actor = {
      kind: 'api_token',
      tokenId: '00000000-0000-7000-8000-0000000000aa',
      projectId: '00000000-0000-7000-8000-0000000000a1',
      scopes: ['projects:read', 'items:read'],
    };
    expect(
      can(token, 'project.read', {
        type: 'project',
        projectId: '00000000-0000-7000-8000-0000000000b1',
        role: null,
      }),
    ).toBe(false);
    expect(
      can(token, 'work_item.read', {
        type: 'work_item',
        projectId: '00000000-0000-7000-8000-0000000000b1',
        role: null,
      }),
    ).toBe(false);
  });

  it('agent cannot launch runs', () => {
    const agent: Actor = {
      kind: 'agent',
      runId: '00000000-0000-7000-8000-0000000000r1',
      workItemId: '00000000-0000-7000-8000-0000000000w1',
    };
    expect(
      can(agent, 'work_item.read', {
        type: 'work_item',
        projectId: '00000000-0000-7000-8000-0000000000a1',
        role: null,
      }),
    ).toBe(true);
    expect(
      can(agent, 'run.launch', {
        type: 'work_item',
        projectId: '00000000-0000-7000-8000-0000000000a1',
        role: null,
      }),
    ).toBe(false);
  });

  it('unauthorised reads return not_found semantics via can() denial', () => {
    expect(
      can(human, 'work_item.read', {
        type: 'work_item',
        projectId: 'proj',
        role: null,
      }),
    ).toBe(false);
  });
});
