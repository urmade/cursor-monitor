'use client';

import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nexus/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { actionAssignHookConversationToRepo } from '../server/actions';

export function AssignHookConversationRepoForm({
  conversationId,
  knownRepos,
}: {
  conversationId: string;
  knownRepos: string[];
}) {
  const router = useRouter();
  const [targetRepo, setTargetRepo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (knownRepos.length === 0) {
    return (
      <p className="text-xs text-fg-muted">
        No other repositories in Monitoring yet — assign appears once hook events
        exist for a repository.
      </p>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData();
        fd.set('conversationId', conversationId);
        fd.set('targetRepo', targetRepo);
        startTransition(async () => {
          try {
            await actionAssignHookConversationToRepo(fd);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            router.refresh();
          }
        });
      }}
    >
      <div className="min-w-[12rem] flex-1 space-y-1">
        <label
          htmlFor={`assign-repo-${conversationId}`}
          className="block text-xs text-fg-subtle"
        >
          Assign to repository
        </label>
        <Select
          value={targetRepo || undefined}
          onValueChange={setTargetRepo}
          disabled={pending}
        >
          <SelectTrigger id={`assign-repo-${conversationId}`}>
            <SelectValue placeholder="Select repository…" />
          </SelectTrigger>
          <SelectContent>
            {knownRepos.map((repo) => (
              <SelectItem key={repo} value={repo}>
                {repo}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        type="submit"
        size="sm"
        disabled={pending || !targetRepo}
        aria-busy={pending || undefined}
      >
        {pending ? 'Assigning…' : 'Assign'}
      </Button>
      {error ? (
        <p className="w-full text-xs text-danger-fg" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
