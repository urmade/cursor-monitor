import type { ApiScope } from '@nexus/contracts';
import type { AuthzAction } from '../authz/actions';

const SCOPE_ACTIONS: Record<ApiScope, AuthzAction[]> = {
  'projects:read': ['project.read'],
  'items:read': ['work_item.read', 'spec.read', 'run.read', 'audit.read'],
  'items:write': ['work_item.create', 'work_item.update', 'spec.write'],
  'items:transition': ['work_item.transition'],
  'runs:write': ['run.launch', 'run.cancel'],
  'questions:write': ['question.answer'],
  'webhooks:manage': ['project.update'],
};

export function apiScopeAllowsAction(scopes: string[], action: AuthzAction): boolean {
  for (const scope of scopes) {
    const actions = SCOPE_ACTIONS[scope as ApiScope];
    if (!actions) continue;
    if (actions.includes(action)) return true;
  }
  return false;
}

export function missingScopeForAction(
  scopes: string[],
  action: AuthzAction,
): ApiScope | null {
  for (const [scope, actions] of Object.entries(SCOPE_ACTIONS) as [ApiScope, AuthzAction[]][]) {
    if (actions.includes(action) && !scopes.includes(scope)) {
      return scope;
    }
  }
  return null;
}
