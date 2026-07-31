'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
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
import {
  actionDiscoverOrganizationId,
  actionRemoveAllCursorOrganisations,
  actionRemoveCursorOrganisation,
  actionUpsertCursorOrganisation,
} from '../server/cursor-organisations';
import type { CursorOrganisationView } from '../server/cursor-org-store';

const DEFAULT_BASE_URL = 'https://api.cursor.com';

type EditorState = {
  open: boolean;
  mode: 'create' | 'edit';
  id: string;
  label: string;
  baseUrl: string;
  organizationId: string;
  apiKey: string;
  orgApiKey: string;
  hasExistingApiKey: boolean;
  hasExistingOrgApiKey: boolean;
  clearOrgApiKey: boolean;
};

const emptyEditor = (): EditorState => ({
  open: false,
  mode: 'create',
  id: '',
  label: '',
  baseUrl: DEFAULT_BASE_URL,
  organizationId: '',
  apiKey: '',
  orgApiKey: '',
  hasExistingApiKey: false,
  hasExistingOrgApiKey: false,
  clearOrgApiKey: false,
});

export function CursorOrganisationsSettings({
  organisations,
  envFallbackLabel,
}: {
  organisations: CursorOrganisationView[];
  envFallbackLabel: string | null;
}) {
  const router = useRouter();
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openCreate() {
    setError(null);
    setMessage(null);
    setEditor({ ...emptyEditor(), open: true, mode: 'create' });
  }

  function openEdit(org: CursorOrganisationView) {
    setError(null);
    setMessage(null);
    setEditor({
      open: true,
      mode: 'edit',
      id: org.id,
      label: org.label,
      baseUrl: org.baseUrl || DEFAULT_BASE_URL,
      organizationId: org.organizationId ?? '',
      apiKey: '',
      orgApiKey: '',
      hasExistingApiKey: true,
      hasExistingOrgApiKey: org.hasOrgApiKey,
      clearOrgApiKey: false,
    });
  }

  function closeEditor() {
    setEditor(emptyEditor());
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <p className="text-sm text-fg-muted">
            Connect one or more Cursor organisations so Nexus can list Cloud
            Agents, Automations, and usage for each. Every connection stores its
            own API endpoint, API key, and organisation id in an httpOnly cookie
            for this browser only.
          </p>
        </div>
        <Button type="button" onClick={openCreate}>
          Add organisation
        </Button>
      </div>

      {envFallbackLabel && organisations.length === 0 ? (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-warning-fg">
          Currently falling back to the env / service-account key (
          {envFallbackLabel}). Add a personal or organisation connection below
          to monitor desktop Cloud Agents across orgs.
        </p>
      ) : null}

      {organisations.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm font-medium text-fg">No organisations connected</p>
          <p className="mt-1 text-xs text-fg-muted">
            Add a Cursor organisation to start monitoring conversations and
            spend.
          </p>
          <Button type="button" className="mt-4" onClick={openCreate}>
            Set up organisation
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {organisations.map((org) => (
            <li
              key={org.id}
              className="flex flex-wrap items-start justify-between gap-3 px-3 py-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium text-fg">{org.label}</span>
                  {org.organizationId ? (
                    <span className="font-mono text-xs text-fg-subtle">
                      {org.organizationId}
                    </span>
                  ) : (
                    <span className="text-xs text-warning-fg">
                      Organisation id not set
                    </span>
                  )}
                </div>
                <p className="truncate font-mono text-xs text-fg-muted">
                  {org.baseUrl}
                </p>
                <p className="text-xs text-fg-muted">
                  {org.identity ?? 'Key identity unavailable'} · {org.apiKeyHint}
                  {org.hasOrgApiKey ? ' · Org Admin key saved' : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => openEdit(org)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    setMessage(null);
                    startTransition(async () => {
                      await actionRemoveCursorOrganisation(org.id);
                      setMessage(`Removed “${org.label}”.`);
                      router.refresh();
                    });
                  }}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {organisations.length > 1 ? (
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setError(null);
            setMessage(null);
            startTransition(async () => {
              await actionRemoveAllCursorOrganisations();
              setMessage(
                'Disconnected all organisations. Falling back to env key if set.',
              );
              router.refresh();
            });
          }}
        >
          Disconnect all
        </Button>
      ) : null}

      {error ? (
        <p className="text-xs text-danger-fg" role="alert">
          {error}
        </p>
      ) : null}
      {message ? <p className="text-xs text-success-fg">{message}</p> : null}

      <Dialog
        open={editor.open}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor.mode === 'create'
                ? 'Connect Cursor organisation'
                : 'Edit organisation connection'}
            </DialogTitle>
            <DialogDescription>
              Enter the values from the Cursor organisation dashboard. Nexus
              will try to resolve the organisation id from an Organization API
              key when possible.
            </DialogDescription>
          </DialogHeader>

          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              setMessage(null);
              const fd = new FormData();
              if (editor.id) fd.set('id', editor.id);
              fd.set('label', editor.label);
              fd.set('baseUrl', editor.baseUrl);
              fd.set('organizationId', editor.organizationId);
              if (editor.apiKey) fd.set('apiKey', editor.apiKey);
              if (editor.orgApiKey) fd.set('orgApiKey', editor.orgApiKey);
              if (editor.clearOrgApiKey) fd.set('clearOrgApiKey', '1');
              startTransition(async () => {
                const result = await actionUpsertCursorOrganisation(fd);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                const bits = [
                  result.identity
                    ? `Connected as ${result.identity}`
                    : 'Organisation saved',
                ];
                if (result.organizationId) {
                  bits.push(`org id ${result.organizationId}`);
                } else if (result.discoveryNote) {
                  bits.push(result.discoveryNote);
                }
                setMessage(bits.join(' · '));
                closeEditor();
                router.refresh();
              });
            }}
          >
            <Field label="Display name">
              <Input
                required
                value={editor.label}
                onChange={(e) =>
                  setEditor((prev) => ({ ...prev, label: e.target.value }))
                }
                placeholder="Acme production"
                disabled={pending}
              />
            </Field>

            <Field label="API endpoint">
              <Input
                value={editor.baseUrl}
                onChange={(e) =>
                  setEditor((prev) => ({ ...prev, baseUrl: e.target.value }))
                }
                placeholder={DEFAULT_BASE_URL}
                disabled={pending}
                className="font-mono text-sm"
              />
            </Field>

            <Field
              label={
                editor.hasExistingApiKey
                  ? 'Cloud Agents API key (leave blank to keep current)'
                  : 'Cloud Agents API key'
              }
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={editor.apiKey}
                onChange={(e) =>
                  setEditor((prev) => ({ ...prev, apiKey: e.target.value }))
                }
                placeholder="cursor_…"
                disabled={pending}
                className="font-mono text-sm"
              />
            </Field>

            <Field label="Organisation API key (optional)">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={editor.orgApiKey}
                onChange={(e) =>
                  setEditor((prev) => ({ ...prev, orgApiKey: e.target.value }))
                }
                placeholder="Organisation Admin key — used to look up org id"
                disabled={pending}
                className="font-mono text-sm"
              />
            </Field>
            {editor.hasExistingOrgApiKey ? (
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked={editor.clearOrgApiKey}
                  onChange={(e) =>
                    setEditor((prev) => ({
                      ...prev,
                      clearOrgApiKey: e.target.checked,
                    }))
                  }
                />
                Remove saved Organisation API key
              </label>
            ) : null}

            <div className="space-y-2">
              <Field label="Organisation id">
                <Input
                  value={editor.organizationId}
                  onChange={(e) =>
                    setEditor((prev) => ({
                      ...prev,
                      organizationId: e.target.value,
                    }))
                  }
                  placeholder="org_…"
                  disabled={pending}
                  className="font-mono text-sm"
                />
              </Field>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setError(null);
                  setMessage(null);
                  startTransition(async () => {
                    const fd = new FormData();
                    fd.set('baseUrl', editor.baseUrl);
                    if (editor.orgApiKey) fd.set('orgApiKey', editor.orgApiKey);
                    if (editor.apiKey) fd.set('apiKey', editor.apiKey);
                    const result = await actionDiscoverOrganizationId(fd);
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    if (result.organizationId) {
                      setEditor((prev) => ({
                        ...prev,
                        organizationId: result.organizationId!,
                      }));
                      setMessage(
                        `Found organisation id ${result.organizationId}`,
                      );
                    } else {
                      setMessage(
                        result.note ??
                          'Could not resolve organisation id from this key.',
                      );
                    }
                  });
                }}
              >
                Look up from API key
              </Button>
              <p className="text-xs text-fg-subtle">
                Cursor’s documented APIs usually do not return the public org id.
                If lookup fails, copy it from the organisation dashboard URL.
              </p>
            </div>

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={closeEditor}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending
                  ? 'Saving…'
                  : editor.mode === 'create'
                    ? 'Connect organisation'
                    : 'Save changes'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
