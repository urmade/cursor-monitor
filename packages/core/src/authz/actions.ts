export type AuthzAction =
  | 'org.create'
  | 'project.create'
  | 'project.read'
  | 'project.update'
  | 'project.archive'
  | 'project.manage_members'
  | 'project.manage_pipeline'
  | 'project.manage_labels'
  | 'work_item.read'
  | 'work_item.create'
  | 'work_item.update'
  | 'work_item.transition'
  | 'work_item.archive'
  | 'spec.read'
  | 'spec.write'
  | 'audit.read'
  | 'status.override';

export type AuthzResource =
  | { type: 'org'; orgId: string }
  | { type: 'project'; projectId: string; role: import('@nexus/contracts').ProjectRole | null }
  | {
      type: 'work_item';
      projectId: string;
      role: import('@nexus/contracts').ProjectRole | null;
    };
