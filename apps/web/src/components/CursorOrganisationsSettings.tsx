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
  actionAddCursorOrganisationApiKey,
  actionDiscoverOrganizationId,
  actionRemoveAllCursorOrganisations,
  actionRemoveCursorOrganisation,
  actionRemoveCursorOrganisationApiKey,
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
  keyLabel: string;
  keyKind: 'user' | 'service_account';
  orgApiKey: string;
  hasExistingOrgApiKey: boolean;
  clearOrgApiKey: boolean;
};

type KeyEditorState = {
  open: boolean;
  organisationId: string;
  organisationLabel: string;
  label: string;
  keyKind: 'user' | 'service_account';
  apiKey: string;
};

const emptyEditor = (): EditorState => ({
  open: false,
  mode: 'create',
  id: '',
  label: '',
  baseUrl: DEFAULT_BASE_URL,
  organizationId: '',
  apiKey: '',
  keyLabel: '',
  keyKind: 'user',
  orgApiKey: '',
  hasExistingOrgApiKey: false,
  clearOrgApiKey: false,
});

const emptyKeyEditor = (): KeyEditorState => ({
  open: false,
  organisationId: '',
  organisationLabel: '',
  label: '',
  keyKind: 'user',
  apiKey: '',
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
  const [keyEditor, setKeyEditor] = useState<KeyEditorState>(emptyKeyEditor);
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
      keyLabel: '',
      keyKind: 'user',
      orgApiKey: '',
      hasExistingOrgApiKey: org.hasOrgApiKey,
      clearOrgApiKey: false,
    });
  }

  function openAddKey(org: CursorOrganisationView) {
    setError(null);
    setMessage(null);
    setKeyEditor({
      open: true,
      organisationId: org.id,
      organisationLabel: org.label,
      label: '',
      keyKind: 'user',
      apiKey: '',
    });
  }

  function closeEditor() {
    setEditor(emptyEditor());
  }

  function closeKeyEditor() {
    setKeyEditor(emptyKeyEditor());
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <p className="text-sm text-fg-muted">
            Connect Cursor organisations in the Nexus database. Each organisation
            can hold many user and service-account API keys — Cloud Agents are
            only listable in that key&apos;s identity context. Keys are encrypted
            at rest (AES-256-GCM) and never sent back to the browser.
          </p>
        </div>
        <Button type="button" onClick={openCreate}>
          Add organisation
        </Button>
      </div>

      {envFallbackLabel && organisations.length === 0 ? (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-warning-fg">
          Currently falling back to the env / service-account key (
          {envFallbackLabel}). Add a Cursor organisation and attach team keys
          below to monitor Cloud Agents across identities.
        </p>
      ) : null}

      {organisations.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm font-medium text-fg">No organisations connected</p>
          <p className="mt-1 text-xs text-fg-muted">
            Add a Cursor organisation, then attach every user and service-account
            token that should contribute Cloud Agents to Monitoring.
          </p>
          <Button type="button" className="mt-4" onClick={openCreate}>
            Set up organisation
          </Button>
        </div>
      ) : (
        <ul className="space-y-3">
          {organisations.map((org) => (
            <li
              key={org.id}
              className="rounded-md border border-border bg-surface px-3 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
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
                    {org.source === 'cookie' ? (
                      <span className="text-xs text-warning-fg">
                        · browser cookie (save again to move to DB)
                      </span>
                    ) : null}
                  </div>
                  <p className="truncate font-mono text-xs text-fg-muted">
                    {org.baseUrl}
                  </p>
                  <p className="text-xs text-fg-muted">
                    {org.hasOrgApiKey ? (
                      <span className="text-success-fg">
                        Org Admin key saved
                        {org.orgApiKeyHint ? ` (${org.orgApiKeyHint})` : ''}
                      </span>
                    ) : (
                      <span className="text-warning-fg">
                        No Org Admin key — usage verification unavailable
                      </span>
                    )}
                    {` · ${org.keys.length} team key${org.keys.length === 1 ? '' : 's'}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {org.source === 'db' ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => openAddKey(org)}
                    >
                      Add API key
                    </Button>
                  ) : null}
                  {org.canManage ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => openEdit(org)}
                    >
                      Edit
                    </Button>
                  ) : null}
                  {org.canRemove ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        setError(null);
                        setMessage(null);
                        startTransition(async () => {
                          const result = await actionRemoveCursorOrganisation(
                            org.id,
                          );
                          if (!result.ok) {
                            setError(result.error);
                            return;
                          }
                          setMessage(`Removed “${org.label}”.`);
                          router.refresh();
                        });
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>
              {org.source === 'cookie' ? (
                <p className="mt-2 text-xs text-warning-fg">
                  Browser-cookie connection (legacy). Use “Add organisation” to
                  reconnect and store encrypted credentials in the database —
                  edit/remove from this row is disabled.
                </p>
              ) : null}

              {org.keys.length === 0 ? (
                <p className="mt-3 text-xs text-warning-fg">
                  No team API keys yet — Cloud Agents cannot be listed until a
                  user or service-account key is attached.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                  {org.keys.map((key) => (
                    <li
                      key={key.id}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-fg">{key.label}</p>
                        <p className="text-xs text-fg-muted">
                          {key.keyKind === 'service_account'
                            ? 'Service account'
                            : 'User'}{' '}
                          · {key.identityLabel ?? 'identity unknown'} ·{' '}
                          <span className="font-mono">{key.hint}</span>
                        </p>
                      </div>
                      {key.canRemove ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={pending}
                          onClick={() => {
                            setError(null);
                            setMessage(null);
                            startTransition(async () => {
                              const result =
                                await actionRemoveCursorOrganisationApiKey(
                                  key.id,
                                );
                              if (!result.ok) {
                                setError(result.error);
                                return;
                              }
                              setMessage(`Removed key “${key.label}”.`);
                              router.refresh();
                            });
                          }}
                        >
                          Remove key
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {organisations.filter((org) => org.canRemove).length > 1 ? (
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setError(null);
            setMessage(null);
            startTransition(async () => {
              const result = await actionRemoveAllCursorOrganisations();
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setMessage(
                'Disconnected your organisations. Falling back to env key if none remain.',
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
              Organisation metadata and the optional Org Admin key are stored
              encrypted in the database. Attach user / service-account keys to
              list Cloud Agents.
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
              if (editor.apiKey) {
                fd.set('apiKey', editor.apiKey);
                fd.set('keyLabel', editor.keyLabel);
                fd.set('keyKind', editor.keyKind);
              }
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
                }
                if (result.cost?.note) {
                  bits.push(result.cost.note);
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

            {editor.mode === 'create' ? (
              <>
                <Field label="First team API key (optional)">
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={editor.apiKey}
                    onChange={(e) =>
                      setEditor((prev) => ({ ...prev, apiKey: e.target.value }))
                    }
                    placeholder="cursor_… user or service-account key"
                    disabled={pending}
                    className="font-mono text-sm"
                  />
                </Field>
                <Field label="Key label">
                  <Input
                    value={editor.keyLabel}
                    onChange={(e) =>
                      setEditor((prev) => ({
                        ...prev,
                        keyLabel: e.target.value,
                      }))
                    }
                    placeholder="Alice / cloud-agent"
                    disabled={pending}
                  />
                </Field>
                <Field label="Key kind">
                  <select
                    className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg"
                    value={editor.keyKind}
                    disabled={pending}
                    onChange={(e) =>
                      setEditor((prev) => ({
                        ...prev,
                        keyKind:
                          e.target.value === 'service_account'
                            ? 'service_account'
                            : 'user',
                      }))
                    }
                  >
                    <option value="user">User</option>
                    <option value="service_account">Service account</option>
                  </select>
                </Field>
              </>
            ) : null}

            <Field
              label={
                editor.hasExistingOrgApiKey
                  ? 'Organisation API key (leave blank to keep current)'
                  : 'Organisation API key (required for cost)'
              }
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={editor.orgApiKey}
                onChange={(e) =>
                  setEditor((prev) => ({ ...prev, orgApiKey: e.target.value }))
                }
                placeholder="Organisation Admin key with usage:* scope"
                disabled={pending}
                className="font-mono text-sm"
              />
            </Field>
            <p className="text-xs text-fg-subtle">
              Verifies pooled usage and recent events while saving (
              <span className="font-mono">filtered-usage-events</span>). Team /
              user keys cannot call Organization cost APIs. Stop-hook cost uses
              deployment credentials until hook requests carry a trusted Nexus
              organisation identity.
            </p>
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

      <Dialog
        open={keyEditor.open}
        onOpenChange={(open) => {
          if (!open) closeKeyEditor();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attach team API key</DialogTitle>
            <DialogDescription>
              Add a user or service-account key to “
              {keyEditor.organisationLabel}”. Each identity can only see its own
              Cloud Agents, so attach every token you want Monitoring to cover.
            </DialogDescription>
          </DialogHeader>
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              setMessage(null);
              const fd = new FormData();
              fd.set('organisationId', keyEditor.organisationId);
              fd.set('apiKey', keyEditor.apiKey);
              fd.set('label', keyEditor.label);
              fd.set('keyKind', keyEditor.keyKind);
              startTransition(async () => {
                const result = await actionAddCursorOrganisationApiKey(fd);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setMessage(
                  `Attached ${result.keyKind === 'service_account' ? 'service-account' : 'user'} key${result.identity ? ` · ${result.identity}` : ''}`,
                );
                closeKeyEditor();
                router.refresh();
              });
            }}
          >
            <Field label="Label">
              <Input
                value={keyEditor.label}
                onChange={(e) =>
                  setKeyEditor((prev) => ({ ...prev, label: e.target.value }))
                }
                placeholder="Alice / cloud-agent"
                disabled={pending}
              />
            </Field>
            <Field label="Key kind">
              <select
                className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg"
                value={keyEditor.keyKind}
                disabled={pending}
                onChange={(e) =>
                  setKeyEditor((prev) => ({
                    ...prev,
                    keyKind:
                      e.target.value === 'service_account'
                        ? 'service_account'
                        : 'user',
                  }))
                }
              >
                <option value="user">User</option>
                <option value="service_account">Service account</option>
              </select>
            </Field>
            <Field label="Cloud Agents API key">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                value={keyEditor.apiKey}
                onChange={(e) =>
                  setKeyEditor((prev) => ({ ...prev, apiKey: e.target.value }))
                }
                placeholder="cursor_…"
                disabled={pending}
                className="font-mono text-sm"
              />
            </Field>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={closeKeyEditor}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Attach key'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
