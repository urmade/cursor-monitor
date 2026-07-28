'use client';

import { useActionState } from 'react';
import { Button, Field, Input } from '@nexus/ui';
import { PUBLIC_EVENT_TYPES } from '@nexus/contracts';
import { actionCreateWebhookEndpoint } from '../../../../../src/server/actions';

type FormState = { secret?: string; error?: string } | null;

async function createEndpoint(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await actionCreateWebhookEndpoint(formData);
  if (!result.ok) return { error: result.error };
  return { secret: result.secret };
}

export function WebhookEndpointRegisterForm(props: {
  projectId: string;
  projectKey: string;
}) {
  const [state, formAction, pending] = useActionState(createEndpoint, null);

  return (
    <form action={formAction} className="grid gap-3 rounded-md border border-border p-4">
      <input type="hidden" name="projectId" value={props.projectId} />
      <input type="hidden" name="projectKey" value={props.projectKey} />
      <Field label="HTTPS URL">
        <Input name="url" required placeholder="https://receiver.example.com/hooks/nexus" />
      </Field>
      <Field label="Event types (comma-separated)">
        <Input
          name="eventTypes"
          required
          defaultValue="work_item.created,work_item.stage_changed"
          placeholder={PUBLIC_EVENT_TYPES.slice(0, 3).join(',')}
        />
      </Field>
      <Field label="Description">
        <Input name="description" placeholder="Optional" />
      </Field>
      {state?.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.secret ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">Signing secret (copy now — shown once)</p>
          <code className="mt-1 block break-all font-mono text-xs">{state.secret}</code>
        </div>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        Register endpoint
      </Button>
    </form>
  );
}
