'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nexus/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { formatHookCostUsd, formatRelativeTime } from '../lib/monitoring-format';
import {
  actionHideMonitoringRepo,
  actionMergeMonitoringRepo,
  actionRenameMonitoringRepo,
} from '../server/actions';
import type { MonitoringProjectView } from '../server/monitoring-repo-prefs';

const NO_REPO_LABEL = 'No repository';

function MoreIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className="size-4"
      aria-hidden
    >
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}

export function MonitoringProjectCard({
  project,
  mergeTargets,
  manageEnabled = true,
}: {
  project: MonitoringProjectView;
  /** Other visible project roots this card can merge into. */
  mergeTargets: Array<{ repo: string; displayName: string }>;
  manageEnabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [displayName, setDisplayName] = useState(
    project.displayName === project.repo ? '' : project.displayName,
  );
  const [targetRepo, setTargetRepo] = useState('');

  const isNoRepo = project.repo === NO_REPO_LABEL;
  const title = isNoRepo ? 'No repository' : project.displayName;
  const showCanonical =
    !isNoRepo && project.displayName !== project.repo;
  const memberCount = project.memberRepos.length;

  function runAction(fn: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        router.refresh();
      }
    });
  }

  return (
    <div className="relative rounded-md border border-border bg-surface transition-colors hover:bg-[var(--nx-hover)]">
      <Link
        href={`/monitoring/${encodeURIComponent(project.repo)}`}
        className="group block p-3 pr-10"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-mono text-sm font-medium text-fg group-hover:underline">
            {title}
          </span>
          <span className="shrink-0 text-xs text-fg-subtle">
            {project.latestCreatedAt
              ? formatRelativeTime(project.latestCreatedAt)
              : '—'}
          </span>
        </div>
        {showCanonical ? (
          <div className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle">
            {project.repo}
          </div>
        ) : null}
        {memberCount > 1 ? (
          <div className="mt-1 text-[11px] text-fg-muted">
            {memberCount} repositories combined
          </div>
        ) : null}
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="text-xl font-medium tabular-nums text-fg">
            {formatHookCostUsd(project.totalChargedCents)}
          </span>
          <span className="text-xs text-fg-subtle">charged</span>
        </div>
        <div className="mt-1 text-xs text-fg-muted">
          {project.conversationCount} conversation
          {project.conversationCount === 1 ? '' : 's'}
          {' · '}
          {project.eventCount} turn
          {project.eventCount === 1 ? '' : 's'}
        </div>
      </Link>

      {!isNoRepo && manageEnabled ? (
        <div className="absolute right-2 top-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-7 px-0"
                aria-label={`Manage ${title}`}
                disabled={pending}
              >
                <MoreIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  setDisplayName(
                    project.displayName === project.repo
                      ? ''
                      : project.displayName,
                  );
                  setRenameOpen(true);
                }}
              >
                Rename…
              </DropdownMenuItem>
              {mergeTargets.length > 0 ? (
                <DropdownMenuItem
                  onSelect={() => {
                    setTargetRepo('');
                    setMergeOpen(true);
                  }}
                >
                  Merge into…
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  const fd = new FormData();
                  fd.set('repo', project.repo);
                  fd.set('hidden', project.hidden ? 'false' : 'true');
                  runAction(() => actionHideMonitoringRepo(fd));
                }}
              >
                {project.hidden ? 'Unhide' : 'Hide'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      {error ? (
        <p className="border-t border-border px-3 py-2 text-xs text-danger-fg" role="alert">
          {error}
        </p>
      ) : null}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename repository</DialogTitle>
            <DialogDescription>
              Choose a display name for{' '}
              <span className="font-mono text-fg">{project.repo}</span>. Leave
              blank to use the canonical repository name.
            </DialogDescription>
          </DialogHeader>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData();
              fd.set('repo', project.repo);
              fd.set('displayName', displayName);
              setRenameOpen(false);
              runAction(() => actionRenameMonitoringRepo(fd));
            }}
          >
            <Field label="Display name">
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={project.repo}
                maxLength={120}
                autoFocus
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRenameOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge into another project</DialogTitle>
            <DialogDescription>
              Attach{' '}
              <span className="font-mono text-fg">{project.repo}</span> to
              another Monitoring project. Branches in the combined view are
              prefixed with each originating repository name.
            </DialogDescription>
          </DialogHeader>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!targetRepo) return;
              const fd = new FormData();
              fd.set('sourceRepo', project.repo);
              fd.set('targetRepo', targetRepo);
              setMergeOpen(false);
              runAction(() => actionMergeMonitoringRepo(fd));
            }}
          >
            <div className="space-y-1">
              <label className="block text-xs text-fg-subtle">
                Merge into
              </label>
              <Select
                value={targetRepo || undefined}
                onValueChange={setTargetRepo}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select project…" />
                </SelectTrigger>
                <SelectContent>
                  {mergeTargets.map((t) => (
                    <SelectItem key={t.repo} value={t.repo}>
                      {t.displayName === t.repo
                        ? t.repo
                        : `${t.displayName} (${t.repo})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setMergeOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={pending || !targetRepo}
              >
                Merge
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
