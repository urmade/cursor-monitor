import type { OwnerClass } from '@nexus/contracts';

export type StageTemplate = {
  key: string;
  name: string;
  position: number;
  defaultOwnerClass: OwnerClass;
  isInitial: boolean;
  isTerminal: boolean;
};

/** Copied into project-owned rows at creation — never referenced live. */
export const PIPELINE_TEMPLATES = {
  default: [
    {
      key: 'intake',
      name: 'Intake',
      position: 100,
      defaultOwnerClass: 'human',
      isInitial: true,
      isTerminal: false,
    },
    {
      key: 'scoping',
      name: 'Scoping',
      position: 200,
      defaultOwnerClass: 'ai',
      isInitial: false,
      isTerminal: false,
    },
    {
      key: 'plan',
      name: 'Plan',
      position: 300,
      defaultOwnerClass: 'ai',
      isInitial: false,
      isTerminal: false,
    },
    {
      key: 'implementation',
      name: 'Implementation',
      position: 400,
      defaultOwnerClass: 'ai',
      isInitial: false,
      isTerminal: false,
    },
    {
      key: 'review',
      name: 'Review',
      position: 500,
      defaultOwnerClass: 'human',
      isInitial: false,
      isTerminal: false,
    },
    {
      key: 'deploy',
      name: 'Deploy',
      position: 600,
      defaultOwnerClass: 'human',
      isInitial: false,
      isTerminal: true,
    },
  ] satisfies StageTemplate[],
  minimal: [
    {
      key: 'intake',
      name: 'Intake',
      position: 100,
      defaultOwnerClass: 'human',
      isInitial: true,
      isTerminal: false,
    },
    {
      key: 'implementation',
      name: 'Implementation',
      position: 200,
      defaultOwnerClass: 'ai',
      isInitial: false,
      isTerminal: false,
    },
    {
      key: 'deploy',
      name: 'Deploy',
      position: 300,
      defaultOwnerClass: 'human',
      isInitial: false,
      isTerminal: true,
    },
  ] satisfies StageTemplate[],
  empty: [] satisfies StageTemplate[],
} as const;

export type LabelTemplate = {
  key: string;
  name: string;
  color: string;
  category: string | null;
  agentSettable: boolean;
};

export const LABEL_TAXONOMY_TEMPLATES = {
  risk_touches: [
    { key: 'risk:low', name: 'Risk: Low', color: 'green', category: 'risk', agentSettable: true },
    {
      key: 'risk:medium',
      name: 'Risk: Medium',
      color: 'amber',
      category: 'risk',
      agentSettable: true,
    },
    { key: 'risk:high', name: 'Risk: High', color: 'red', category: 'risk', agentSettable: true },
    {
      key: 'touches:auth',
      name: 'Touches: Auth',
      color: 'blue',
      category: 'area',
      agentSettable: true,
    },
    {
      key: 'touches:billing',
      name: 'Touches: Billing',
      color: 'blue',
      category: 'area',
      agentSettable: true,
    },
    {
      key: 'touches:ui',
      name: 'Touches: UI',
      color: 'blue',
      category: 'area',
      agentSettable: true,
    },
  ] satisfies LabelTemplate[],
  product: [
    {
      key: 'type:feature',
      name: 'Feature',
      color: 'violet',
      category: 'type',
      agentSettable: true,
    },
    { key: 'type:bug', name: 'Bug', color: 'red', category: 'type', agentSettable: true },
    {
      key: 'priority:p0',
      name: 'P0',
      color: 'red',
      category: 'priority',
      agentSettable: false,
    },
    {
      key: 'priority:p1',
      name: 'P1',
      color: 'amber',
      category: 'priority',
      agentSettable: false,
    },
    {
      key: 'surface:api',
      name: 'API',
      color: 'slate',
      category: 'surface',
      agentSettable: true,
    },
    {
      key: 'surface:web',
      name: 'Web',
      color: 'slate',
      category: 'surface',
      agentSettable: true,
    },
  ] satisfies LabelTemplate[],
} as const;
