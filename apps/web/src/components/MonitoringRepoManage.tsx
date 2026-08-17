'use client';

import { Button, Panel } from '@nexus/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  actionHideMonitoringRepo,
  actionUnmergeMonitoringRepo,
} from '../server/actions';

export function MonitoringHiddenRepos({
  projects,
}: {
  projects: Array<{ repo: string; displayName: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (projects.length === 0) return null;

  return (
    <Panel className="p-3">
      <h2 className="text-sm font-medium text-fg">
        Hidden repositories{' '}
        <span className="text-xs font-normal text-fg-subtle">
          {projects.length}
        </span>
      </h2>
      <ul className="mt-2 divide-y divide-border">
        {projects.map((p) => (
          <li
            key={p.repo}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-sm text-fg">
                {p.displayName}
              </div>
              {p.displayName !== p.repo ? (
                <div className="truncate font-mono text-[11px] text-fg-subtle">
                  {p.repo}
                </div>
              ) : null}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => {
                setError(null);
                const fd = new FormData();
                fd.set('repo', p.repo);
                fd.set('hidden', 'false');
                startTransition(async () => {
                  try {
                    await actionHideMonitoringRepo(fd);
                    router.refresh();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                    router.refresh();
                  }
                });
              }}
            >
              Unhide
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="mt-2 text-xs text-danger-fg" role="alert">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}

export function MonitoringMergedMembers({
  parentRepo,
  members,
}: {
  parentRepo: string;
  /** Attached repos excluding the parent itself. */
  members: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (members.length === 0) return null;

  return (
    <Panel className="p-3">
      <h2 className="text-sm font-medium text-fg">
        Attached repositories{' '}
        <span className="text-xs font-normal text-fg-subtle">
          Branches are prefixed with each originating repo name
        </span>
      </h2>
      <ul className="mt-2 divide-y divide-border">
        {members.map((repo) => (
          <li
            key={repo}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <span className="truncate font-mono text-sm text-fg">{repo}</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => {
                setError(null);
                const fd = new FormData();
                fd.set('sourceRepo', repo);
                fd.set('parentRepo', parentRepo);
                startTransition(async () => {
                  try {
                    await actionUnmergeMonitoringRepo(fd);
                    router.refresh();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                    router.refresh();
                  }
                });
              }}
            >
              Detach
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="mt-2 text-xs text-danger-fg" role="alert">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}
