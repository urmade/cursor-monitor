'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from '@nexus/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { actionRenameMonitoringBranch } from '../server/actions';

export function BranchRenameControl({
  projectRepo,
  branchKey,
  displayName,
}: {
  projectRepo: string;
  /** Original branch group key (never overwritten). */
  branchKey: string;
  displayName?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(displayName?.trim() || '');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-[11px] text-fg-subtle"
        aria-label={`Rename branch ${branchKey}`}
        onClick={() => {
          setLabel(displayName?.trim() || '');
          setError(null);
          setOpen(true);
        }}
      >
        Rename
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename branch</DialogTitle>
            <DialogDescription>
              Set a display label for this branch group. The original branch
              name{' '}
              <span className="font-mono text-fg">{branchKey}</span> is kept
              underneath.
            </DialogDescription>
          </DialogHeader>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData();
              fd.set('projectRepo', projectRepo);
              fd.set('branchKey', branchKey);
              fd.set('displayName', label);
              setOpen(false);
              setError(null);
              startTransition(async () => {
                try {
                  await actionRenameMonitoringBranch(fd);
                  router.refresh();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                  router.refresh();
                }
              });
            }}
          >
            <Field label="Display name">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={branchKey}
                maxLength={120}
                autoFocus
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                Save
              </Button>
            </div>
            {error ? (
              <p className="text-xs text-danger-fg" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
