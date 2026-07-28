'use client';

import { useState } from 'react';
import { Button, Field, Input } from '@nexus/ui';
import { EstimatePreview } from './EstimatePreview';

export function QuickCreateWithEstimate({
  projectId,
  projectKey,
  labelPlaceholder,
  action,
}: {
  projectId: string;
  projectKey: string;
  labelPlaceholder: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [complexity, setComplexity] = useState('');
  const [labelKeys, setLabelKeys] = useState('');

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="projectKey" value={projectKey} />
      <Field label="Quick create" className="min-w-[16rem] flex-1">
        <Input name="title" required placeholder="New work item title" />
      </Field>
      <Field label="Complexity">
        <select
          name="complexity"
          value={complexity}
          onChange={(e) => setComplexity(e.target.value)}
          className="flex h-[var(--nx-control-md)] rounded-md border border-border bg-surface px-2.5 text-sm"
        >
          <option value="">—</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </Field>
      <Field label="Labels (comma keys)" className="min-w-[12rem]">
        <Input
          name="labelKeys"
          placeholder={labelPlaceholder}
          className="font-mono text-xs"
          value={labelKeys}
          onChange={(e) => setLabelKeys(e.target.value)}
        />
      </Field>
      <Button type="submit">Create</Button>
      <div className="w-full">
        <EstimatePreview
          projectKey={projectKey}
          complexity={complexity}
          labelKeys={labelKeys
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)}
        />
      </div>
    </form>
  );
}
