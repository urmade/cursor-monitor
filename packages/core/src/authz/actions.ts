/** Single source of truth for AuthzAction — matrix reverse-check imports this. */
export const ALL_AUTHZ_ACTIONS = [
  'org.create',
  'project.create',
  'project.read',
  'project.view_analytics',
  'project.update',
  'project.archive',
  'project.manage_members',
  'project.manage_pipeline',
  'project.manage_labels',
  'project.manage_bindings',
  'project.manage_gates',
  'work_item.read',
  'work_item.create',
  'work_item.update',
  'work_item.transition',
  'work_item.archive',
  'spec.read',
  'spec.write',
  'audit.read',
  'status.override',
  'gate.override',
  'run.read',
  'run.launch',
  'run.cancel',
  'question.answer',
  'approval.decide',
] as const;

export type AuthzAction = (typeof ALL_AUTHZ_ACTIONS)[number];

export type AuthzResource =
  | { type: 'org'; orgId: string }
  | { type: 'project'; projectId: string; role: import('@nexus/contracts').ProjectRole | null }
  | {
      type: 'work_item';
      projectId: string;
      role: import('@nexus/contracts').ProjectRole | null;
    };
