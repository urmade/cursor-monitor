import type { Actor, ProjectRole } from '@nexus/contracts';
import type { AuthzAction, AuthzResource } from './actions';

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  member: 2,
  maintainer: 3,
  owner: 4,
};

function hasRole(role: ProjectRole | null, minimum: ProjectRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * Single authorisation module. Adapters must not make their own access decisions.
 * Phase 1 matrix (architecture-baseline §6.3):
 * - viewer: read-only
 * - member: create/update work items, write specs, transition
 * - maintainer/owner: project settings, pipeline, labels, members, overrides
 */
export function can(
  actor: Actor,
  action: AuthzAction,
  resource: AuthzResource,
): boolean {
  if (actor.kind === 'system') {
    return true;
  }

  if (actor.kind === 'agent' || actor.kind === 'api_token') {
    // Machine principals are scoped in Phase 2/8; deny product mutations here.
    return action.endsWith('.read') || action === 'audit.read';
  }

  // human
  switch (resource.type) {
    case 'org':
      return action === 'org.create' || action === 'project.create';
    case 'project':
    case 'work_item': {
      const role = resource.role;
      switch (action) {
        case 'project.read':
        case 'work_item.read':
        case 'spec.read':
        case 'audit.read':
          return hasRole(role, 'viewer');
        case 'work_item.create':
        case 'work_item.update':
        case 'work_item.transition':
        case 'spec.write':
          return hasRole(role, 'member');
        case 'work_item.archive':
        case 'project.update':
        case 'project.manage_pipeline':
        case 'project.manage_labels':
        case 'project.manage_members':
        case 'status.override':
          return hasRole(role, 'maintainer');
        case 'project.archive':
          return hasRole(role, 'owner');
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

export function requireCan(
  actor: Actor,
  action: AuthzAction,
  resource: AuthzResource,
): void {
  if (!can(actor, action, resource)) {
    throw new Error(`Forbidden: ${action}`);
  }
}
