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
  actionUpdateCursorOrganisationApiKey,
  actionUpsertCursorOrganisation,
  actionValidateOrganisationApiKey,
  actionValidateUserTeamApiKey,
} from '../server/cursor-organisations';
import type { CursorOrganisationView } from '../server/cursor-org-store';

const DEFAULT_BASE_URL = 'https://api.cursor.com';

type KeyKind = 'user' | 'service_account';

type KeyCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; note: string }
  | { status: 'error'; note: string };

type EditorState = {
  open: boolean;
  mode: 'create' | 'edit';
  id: string;
  label: string;
  baseUrl: string;
  organizationId: string;
  apiKey: string;
  keyLabel: string;
  keyKind: KeyKind;
  orgApiKey: string;
  hasExistingOrgApiKey: boolean;
  clearOrgApiKey: boolean;
  orgKeyCheck: KeyCheckState;
  teamKeyCheck: KeyCheckState;
};

type KeyEditorState = {
  open: boolean;
  mode: 'create' | 'edit';
  organisationId: string;
  organisationLabel: string;
  organisationBaseUrl: string;
  apiKeyId: string;
  label: string;
  keyKind: KeyKind;
  apiKey: string;
  hasExistingSecret: boolean;
  keyCheck: KeyCheckState;
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
  orgKeyCheck: { status: 'idle' },
  teamKeyCheck: { status: 'idle' },
});

const emptyKeyEditor = (): KeyEditorState => ({
  open: false,
  mode: 'create',
  organisationId: '',
  organisationLabel: '',
  organisationBaseUrl: DEFAULT_BASE_URL,
  apiKeyId: '',
  label: '',
  keyKind: 'user',
  apiKey: '',
  hasExistingSecret: false,
  keyCheck: { status: 'idle' },
});

function keyKindLabel(kind: KeyKind): string {
  return kind === 'service_account' ? 'Team' : 'User';
}

function KeyCheckFeedback({ state }: { state: KeyCheckState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'checking') {
    return <p className="text-xs text-fg-muted">Checking key with Cursor…</p>;
  }
  if (state.status === 'ok') {
    return (
      <p className="text-xs text-success-fg" role="status">
        {state.note}
      </p>
    );
  }
  return (
    <p className="text-xs text-danger-fg" role="alert">
      {state.note}
    </p>
  );
}

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
      ...emptyEditor(),
      open: true,
      mode: 'edit',
      id: org.id,
      label: org.label,
      baseUrl: org.baseUrl || DEFAULT_BASE_URL,
      organizationId: org.organizationId ?? '',
      hasExistingOrgApiKey: org.hasOrgApiKey,
    });
  }

  function openAddKey(org: CursorOrganisationView) {
    setError(null);
    setMessage(null);
    setKeyEditor({
      ...emptyKeyEditor(),
      open: true,
      mode: 'create',
      organisationId: org.id,
      organisationLabel: org.label,
      organisationBaseUrl: org.baseUrl || DEFAULT_BASE_URL,
    });
  }

  function openEditKey(
    org: CursorOrganisationView,
    key: CursorOrganisationView['keys'][number],
  ) {
    setError(null);
    setMessage(null);
    setKeyEditor({
      ...emptyKeyEditor(),
      open: true,
      mode: 'edit',
      organisationId: org.id,
      organisationLabel: org.label,
      organisationBaseUrl: org.baseUrl || DEFAULT_BASE_URL,
      apiKeyId: key.id,
      label: key.label,
      keyKind: key.keyKind,
      hasExistingSecret: true,
    });
  }

  function closeEditor() {
    setEditor(emptyEditor());
  }

  function closeKeyEditor() {
    setKeyEditor(emptyKeyEditor());
  }

  function checkOrgApiKey(orgApiKey = editor.orgApiKey) {
    const fd = new FormData();
    fd.set('baseUrl', editor.baseUrl);
    fd.set('orgApiKey', orgApiKey);
    if (editor.organizationId) {
      fd.set('organizationId', editor.organizationId);
    }
    setEditor((prev) => ({
      ...prev,
      orgKeyCheck: { status: 'checking' },
    }));
    startTransition(async () => {
      const result = await actionValidateOrganisationApiKey(fd);
      setEditor((prev) => ({
        ...prev,
        orgKeyCheck: result.ok
          ? { status: 'ok', note: result.note }
          : { status: 'error', note: result.error },
      }));
    });
  }

  function checkUserTeamApiKey(opts: {
    apiKey: string;
    baseUrl: string;
    keyKind: KeyKind;
    onResult: (state: KeyCheckState) => void;
  }) {
    const fd = new FormData();
    fd.set('baseUrl', opts.baseUrl);
    fd.set('apiKey', opts.apiKey);
    fd.set('keyKind', opts.keyKind);
    opts.onResult({ status: 'checking' });
    startTransition(async () => {
      const result = await actionValidateUserTeamApiKey(fd);
      opts.onResult(
        result.ok
          ? { status: 'ok', note: result.note }
          : { status: 'error', note: result.error },
      );
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <p className="text-sm text-fg-muted">
            Connect Cursor organisations and attach named User and Team API
            keys. Team API keys are tested against the Team usage API and
            power Monitoring cost. User keys remain available for Cloud Agents
            identity. Keys are encrypted at rest and never sent back to the
            browser.
          </p>
        </div>
        <Button type="button" onClick={openCreate}>
          Add organisation
        </Button>
      </div>

      {envFallbackLabel && organisations.length === 0 ? (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-warning-fg">
          Currently falling back to the env / service-account key (
          {envFallbackLabel}). Add a Cursor organisation and attach User / Team
          API keys below to monitor agents across identities.
        </p>
      ) : null}

      {organisations.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm font-medium text-fg">No organisations connected</p>
          <p className="mt-1 text-xs text-fg-muted">
            Add a Cursor organisation, then attach every User and Team API key
            that should contribute agents to Monitoring.
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
                      <span>
                        Organisation API key saved
                        {org.orgApiKeyHint ? ` (${org.orgApiKeyHint})` : ''}
                      </span>
                    ) : (
                      <span>No Organisation API key</span>
                    )}
                    {` · ${org.keys.filter((k) => k.keyKind === 'service_account').length} Team key${org.keys.filter((k) => k.keyKind === 'service_account').length === 1 ? '' : 's'} for cost`}
                    {` · ${org.keys.length} User/Team key${org.keys.length === 1 ? '' : 's'} total`}
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
                  No User or Team API keys yet. Attach a Team API key to price
                  Monitoring requests from the usage API.
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
                          {keyKindLabel(key.keyKind)} ·{' '}
                          {key.identityLabel ?? 'identity unknown'} ·{' '}
                          <span className="font-mono">{key.hint}</span>
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {key.canEdit ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={() => openEditKey(org, key)}
                          >
                            Edit
                          </Button>
                        ) : null}
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
                            Remove
                          </Button>
                        ) : null}
                      </div>
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
              Organisation Admin key and org id first, then an optional User /
              Team key. Dialog scrolls when content is tall.
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

            <div className="space-y-2 rounded-md border border-border px-3 py-3">
              <Field
                label={
                  editor.hasExistingOrgApiKey
                    ? 'Organisation API key (leave blank to keep current)'
                    : 'Organisation API key (optional)'
                }
              >
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={editor.orgApiKey}
                  onChange={(e) =>
                    setEditor((prev) => ({
                      ...prev,
                      orgApiKey: e.target.value,
                      orgKeyCheck: { status: 'idle' },
                    }))
                  }
                  onBlur={(e) => {
                    if (e.target.value.trim().length < 20) return;
                    checkOrgApiKey(e.target.value);
                  }}
                  placeholder="Organisation Admin key with usage:* scope"
                  disabled={pending}
                  className="font-mono text-sm"
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={pending || editor.orgApiKey.trim().length < 20}
                  onClick={() => checkOrgApiKey()}
                >
                  Check key
                </Button>
                <KeyCheckFeedback state={editor.orgKeyCheck} />
              </div>
              <p className="text-xs text-fg-subtle">
                Non-mutating check via{' '}
                <span className="font-mono">/organizations/members</span>
                {editor.organizationId ? (
                  <>
                    {' '}
                    and <span className="font-mono">pooled-usage</span>
                  </>
                ) : null}
                .
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
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    setMessage(null);
                    startTransition(async () => {
                      const fd = new FormData();
                      fd.set('baseUrl', editor.baseUrl);
                      if (editor.orgApiKey) {
                        fd.set('orgApiKey', editor.orgApiKey);
                      }
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
              </div>
              <p className="text-xs text-fg-subtle">
                If lookup fails, copy <span className="font-mono">org_…</span>{' '}
                from the organisation dashboard URL.
              </p>
            </div>

            {editor.mode === 'create' ? (
              <div className="space-y-2 rounded-md border border-border px-3 py-3">
                <p className="text-xs font-medium text-fg">
                  First User / Team API key (optional)
                </p>
                <Field label="Key type">
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
                        teamKeyCheck: { status: 'idle' },
                      }))
                    }
                  >
                    <option value="user">User</option>
                    <option value="service_account">Team (usage / cost)</option>
                  </select>
                </Field>
                <p className="text-xs text-fg-subtle">
                  {editor.keyKind === 'service_account'
                    ? 'Team keys are proven against the Team usage API before save.'
                    : 'User keys are proven against GET /v1/me.'}
                </p>
                <Field label="API key">
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={editor.apiKey}
                    onChange={(e) =>
                      setEditor((prev) => ({
                        ...prev,
                        apiKey: e.target.value,
                        teamKeyCheck: { status: 'idle' },
                      }))
                    }
                    onBlur={(e) => {
                      if (e.target.value.trim().length < 20) return;
                      checkUserTeamApiKey({
                        apiKey: e.target.value,
                        baseUrl: editor.baseUrl,
                        keyKind: editor.keyKind,
                        onResult: (teamKeyCheck) =>
                          setEditor((prev) => ({ ...prev, teamKeyCheck })),
                      });
                    }}
                    placeholder={
                      editor.keyKind === 'service_account'
                        ? 'Team API key from Cursor Dashboard'
                        : 'User API key'
                    }
                    disabled={pending}
                    className="font-mono text-sm"
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pending || editor.apiKey.trim().length < 20}
                    onClick={() =>
                      checkUserTeamApiKey({
                        apiKey: editor.apiKey,
                        baseUrl: editor.baseUrl,
                        keyKind: editor.keyKind,
                        onResult: (teamKeyCheck) =>
                          setEditor((prev) => ({ ...prev, teamKeyCheck })),
                      })
                    }
                  >
                    Check key
                  </Button>
                  <KeyCheckFeedback state={editor.teamKeyCheck} />
                </div>
                <Field label="Key name">
                  <Input
                    value={editor.keyLabel}
                    onChange={(e) =>
                      setEditor((prev) => ({
                        ...prev,
                        keyLabel: e.target.value,
                      }))
                    }
                    placeholder={
                      editor.keyKind === 'service_account'
                        ? 'Team usage key'
                        : 'Alice · personal'
                    }
                    disabled={pending}
                  />
                </Field>
              </div>
            ) : null}

            <div className="sticky bottom-0 z-[1] -mx-4 -mb-4 flex flex-wrap justify-end gap-2 border-t border-border bg-overlay px-4 py-3">
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
            <DialogTitle>
              {keyEditor.mode === 'create'
                ? 'Add User / Team API key'
                : 'Edit User / Team API key'}
            </DialogTitle>
            <DialogDescription>
              {keyEditor.mode === 'create'
                ? `Attach a named User or Team API key to “${keyEditor.organisationLabel}”. Each identity only sees its own agents.`
                : `Update the name, type, or secret for a key under “${keyEditor.organisationLabel}”.`}
            </DialogDescription>
          </DialogHeader>
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              setMessage(null);
              const fd = new FormData();
              startTransition(async () => {
                if (keyEditor.mode === 'create') {
                  fd.set('organisationId', keyEditor.organisationId);
                  fd.set('apiKey', keyEditor.apiKey);
                  fd.set('label', keyEditor.label);
                  fd.set('keyKind', keyEditor.keyKind);
                  const result = await actionAddCursorOrganisationApiKey(fd);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setMessage(
                    `Attached ${keyKindLabel(result.keyKind).toLowerCase()} key${result.identity ? ` · ${result.identity}` : ''}`,
                  );
                } else {
                  fd.set('apiKeyId', keyEditor.apiKeyId);
                  fd.set('label', keyEditor.label);
                  fd.set('keyKind', keyEditor.keyKind);
                  if (keyEditor.apiKey) fd.set('apiKey', keyEditor.apiKey);
                  const result = await actionUpdateCursorOrganisationApiKey(fd);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setMessage(
                    `Updated key “${result.label}”${result.identity ? ` · ${result.identity}` : ''}`,
                  );
                }
                closeKeyEditor();
                router.refresh();
              });
            }}
          >
            <Field label="Name">
              <Input
                required
                value={keyEditor.label}
                onChange={(e) =>
                  setKeyEditor((prev) => ({ ...prev, label: e.target.value }))
                }
                placeholder="Alice · personal"
                disabled={pending}
              />
            </Field>
            <Field label="Key type">
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
                <option value="service_account">Team (usage / cost)</option>
              </select>
            </Field>
            <Field
              label={
                keyEditor.mode === 'edit'
                  ? 'API key (leave blank to keep current)'
                  : 'API key'
              }
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                required={keyEditor.mode === 'create'}
                value={keyEditor.apiKey}
                onChange={(e) =>
                  setKeyEditor((prev) => ({
                    ...prev,
                    apiKey: e.target.value,
                    keyCheck: { status: 'idle' },
                  }))
                }
                onBlur={(e) => {
                  if (e.target.value.trim().length < 20) return;
                  checkUserTeamApiKey({
                    apiKey: e.target.value,
                    baseUrl: keyEditor.organisationBaseUrl,
                    keyKind: keyEditor.keyKind,
                    onResult: (keyCheck) =>
                      setKeyEditor((prev) => ({ ...prev, keyCheck })),
                  });
                }}
                placeholder="cursor_…"
                disabled={pending}
                className="font-mono text-sm"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pending || keyEditor.apiKey.trim().length < 20}
                onClick={() =>
                  checkUserTeamApiKey({
                    apiKey: keyEditor.apiKey,
                    baseUrl: keyEditor.organisationBaseUrl,
                    keyKind: keyEditor.keyKind,
                    onResult: (keyCheck) =>
                      setKeyEditor((prev) => ({ ...prev, keyCheck })),
                  })
                }
              >
                Check key
              </Button>
              <KeyCheckFeedback state={keyEditor.keyCheck} />
            </div>
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
                {pending
                  ? 'Saving…'
                  : keyEditor.mode === 'create'
                    ? 'Attach key'
                    : 'Save key'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
