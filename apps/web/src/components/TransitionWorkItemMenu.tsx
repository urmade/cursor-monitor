'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@nexus/ui';

type Stage = { id: string; name: string };

export function TransitionWorkItemMenu({
  workItemId,
  expectedVersion,
  projectKey,
  itemKey,
  currentStageId,
  stages,
  action,
}: {
  workItemId: string;
  expectedVersion: number;
  projectKey: string;
  itemKey: string;
  currentStageId: string;
  stages: Stage[];
  action: (formData: FormData) => void | Promise<void>;
}) {
  const targets = stages.filter((s) => s.id !== currentStageId);
  if (targets.length === 0) return null;

  return (
    <form action={action} className="mt-2">
      <input type="hidden" name="workItemId" value={workItemId} />
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="itemKey" value={itemKey} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="secondary" size="sm" className="w-full">
            Move to…
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {targets.map((s) => (
            <DropdownMenuItem key={s.id} asChild>
              <button
                type="submit"
                name="toStageId"
                value={s.id}
                className="w-full cursor-default"
              >
                {s.name}
              </button>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </form>
  );
}
