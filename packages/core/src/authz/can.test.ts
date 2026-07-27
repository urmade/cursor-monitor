import { describe, expect, it } from 'vitest';
import type { Actor, ProjectRole } from '@nexus/contracts';
import { can } from './can';
import type { AuthzAction } from './actions';

const human: Actor = {
  kind: 'human',
  userId: '00000000-0000-7000-8000-000000000001',
};

const actions: AuthzAction[] = [
  'project.read',
  'work_item.read',
  'spec.read',
  'audit.read',
  'work_item.create',
  'work_item.update',
  'work_item.transition',
  'spec.write',
  'work_item.archive',
  'project.update',
  'project.manage_pipeline',
  'project.manage_labels',
  'project.manage_members',
  'status.override',
  'project.archive',
];

const expected: Record<ProjectRole, Partial<Record<AuthzAction, boolean>>> = {
  viewer: {
    'project.read': true,
    'work_item.read': true,
    'spec.read': true,
    'audit.read': true,
    'work_item.create': false,
    'work_item.update': false,
    'work_item.transition': false,
    'spec.write': false,
    'work_item.archive': false,
    'project.update': false,
    'project.manage_pipeline': false,
    'project.manage_labels': false,
    'project.manage_members': false,
    'status.override': false,
    'project.archive': false,
  },
  member: {
    'project.read': true,
    'work_item.read': true,
    'spec.read': true,
    'audit.read': true,
    'work_item.create': true,
    'work_item.update': true,
    'work_item.transition': true,
    'spec.write': true,
    'work_item.archive': false,
    'project.update': false,
    'project.manage_pipeline': false,
    'project.manage_labels': false,
    'project.manage_members': false,
    'status.override': false,
    'project.archive': false,
  },
  maintainer: {
    'project.read': true,
    'work_item.read': true,
    'spec.read': true,
    'audit.read': true,
    'work_item.create': true,
    'work_item.update': true,
    'work_item.transition': true,
    'spec.write': true,
    'work_item.archive': true,
    'project.update': true,
    'project.manage_pipeline': true,
    'project.manage_labels': true,
    'project.manage_members': true,
    'status.override': true,
    'project.archive': false,
  },
  owner: {
    'project.read': true,
    'work_item.read': true,
    'spec.read': true,
    'audit.read': true,
    'work_item.create': true,
    'work_item.update': true,
    'work_item.transition': true,
    'spec.write': true,
    'work_item.archive': true,
    'project.update': true,
    'project.manage_pipeline': true,
    'project.manage_labels': true,
    'project.manage_members': true,
    'status.override': true,
    'project.archive': true,
  },
};

describe('authz matrix', () => {
  for (const role of Object.keys(expected) as ProjectRole[]) {
    describe(role, () => {
      for (const action of actions) {
        it(`${action} => ${String(expected[role][action])}`, () => {
          expect(
            can(human, action, {
              type: 'project',
              projectId: '00000000-0000-7000-8000-000000000099',
              role,
            }),
          ).toBe(expected[role][action]);
        });
      }
    });
  }

  it('null role cannot read', () => {
    expect(
      can(human, 'project.read', {
        type: 'project',
        projectId: '00000000-0000-7000-8000-000000000099',
        role: null,
      }),
    ).toBe(false);
  });

  it('system can do anything', () => {
    expect(
      can(
        { kind: 'system', reason: 'test' },
        'project.archive',
        {
          type: 'project',
          projectId: '00000000-0000-7000-8000-000000000099',
          role: null,
        },
      ),
    ).toBe(true);
  });
});
