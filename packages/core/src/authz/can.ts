import type { Actor, ProjectRole } from '@nexus/contracts';
import type { AuthzAction, AuthzResource } from './actions';
import { apiScopeAllowsAction } from '../api-tokens/scopes';

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
 * Phase 2: agents may read/write work-item scoped surfaces; MCP token scope is
 * the real boundary. Humans gain run.launch / run.cancel / binding management.
 */
export function can(
  actor: Actor,
  action: AuthzAction,
  resource: AuthzResource,
): boolean {
  if (actor.kind === 'system') {
    return true;
  }

  if (actor.kind === 'agent') {
    const agentAllowed: AuthzAction[] = [
      'work_item.read',
      'work_item.update',
      'spec.read',
      'spec.write',
      'run.read',
      'project.read',
      'audit.read',
    ];
    return agentAllowed.includes(action);
  }

  if (actor.kind === 'api_token') {
    if (resource.type === 'project' && resource.projectId !== actor.projectId) {
      return false;
    }
    if (resource.type === 'work_item' && resource.projectId !== actor.projectId) {
      return false;
    }
    if (action === 'audit.read') {
      return apiScopeAllowsAction(actor.scopes, 'work_item.read');
    }
    return apiScopeAllowsAction(actor.scopes, action);
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
        case 'project.view_analytics':
        case 'work_item.read':
        case 'spec.read':
        case 'audit.read':
        case 'run.read':
          return hasRole(role, 'viewer');
        case 'work_item.create':
        case 'work_item.update':
        case 'work_item.transition':
        case 'spec.write':
        case 'run.launch':
        case 'run.cancel':
        case 'question.answer':
          return hasRole(role, 'member');
        case 'work_item.archive':
        case 'project.update':
        case 'project.manage_pipeline':
        case 'project.manage_labels':
        case 'project.manage_members':
        case 'project.manage_bindings':
        case 'project.manage_gates':
        case 'status.override':
        case 'gate.override':
          return hasRole(role, 'maintainer');
        case 'project.archive':
          return hasRole(role, 'owner');
        case 'approval.decide':
          return hasRole(role, 'member');
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
