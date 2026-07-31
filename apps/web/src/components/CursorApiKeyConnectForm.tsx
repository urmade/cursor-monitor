'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Textarea } from '@nexus/ui';
import {
  actionConnectCursorApiKey,
  actionDisconnectAllCursorApiKeys,
  actionDisconnectCursorApiKey,
} from '../server/cursor-credentials';

export type ConnectedKeyRow = {
  fingerprint: string;
  identity: string;
};

export function CursorApiKeyConnectForm({
  connected,
  connectedKeys,
  identityLabel,
  source,
}: {
  connected: boolean;
  connectedKeys: ConnectedKeyRow[];
  identityLabel: string | null;
  source: 'user_cookie' | 'env' | 'none';
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [multiLine, setMultiLine] = useState(false);

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface p-3">
      <div>
        <h2 className="text-sm font-medium text-fg">Cursor credentials</h2>
        <p className="mt-1 text-xs text-fg-muted">
          Cursor does not offer “Sign in with Cursor” for third-party apps. Paste{' '}
          <strong>personal or service-account</strong> API keys from{' '}
          <a
            href="https://cursor.com/dashboard/api"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            Cursor Dashboard → API Keys
          </a>{' '}
          — one per Cursor organisation — so Monitoring lists conversations
          across those orgs. Stored in httpOnly cookies for this browser only.
        </p>
      </div>

      {source === 'user_cookie' && connectedKeys.length > 0 ? (
        <div className="space-y-2">
          <ul className="divide-y divide-border rounded-md border border-border">
            {connectedKeys.map((key) => (
              <li
                key={key.fingerprint}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
              >
                <span className="min-w-0 truncate text-fg">{key.identity}</span>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    setMessage(null);
                    startTransition(async () => {
                      await actionDisconnectCursorApiKey(key.fingerprint);
                      setMessage('Disconnected API key.');
                      router.refresh();
                    });
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {connectedKeys.length > 1 ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setError(null);
                setMessage(null);
                startTransition(async () => {
                  await actionDisconnectAllCursorApiKeys();
                  setMessage(
                    'Disconnected all personal keys. Falling back to env key if set.',
                  );
                  router.refresh();
                });
              }}
            >
              Disconnect all
            </Button>
          ) : null}
        </div>
      ) : null}

      {source === 'env' && connected ? (
        <p className="text-xs text-warning-fg">
          Currently using the <strong>env / service-account</strong> key (
          {identityLabel}). That only shows agents owned by that key — not your
          desktop Cloud Agents across orgs. Paste personal keys below.
        </p>
      ) : null}

      {source === 'none' || !connected ? (
        <p className="text-xs text-fg-muted">
          No usable Cursor API key yet. Paste one or more personal keys to
          continue.
        </p>
      ) : null}

      <form
        className="flex flex-col gap-2"
        action={(fd) => {
          setError(null);
          setMessage(null);
          startTransition(async () => {
            const result = await actionConnectCursorApiKey(fd);
            if (result.ok) {
              setMessage(
                result.keyCount > 1
                  ? `Connected ${result.keyCount} keys (${result.identity})`
                  : `Connected as ${result.identity}`,
              );
              router.refresh();
            } else {
              setError(result.error);
            }
          });
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <Field
            label={
              multiLine
                ? 'Cursor API keys (one per line)'
                : 'Cursor API key'
            }
            className="min-w-0 flex-1"
          >
            {multiLine ? (
              <Textarea
                name="apiKeys"
                rows={3}
                autoComplete="off"
                spellCheck={false}
                placeholder={'cursor_…\ncursor_…'}
                disabled={pending}
                className="font-mono text-sm"
              />
            ) : (
              <Input
                name="apiKey"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="cursor_…"
                disabled={pending}
              />
            )}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending
              ? 'Connecting…'
              : connectedKeys.length > 0
                ? 'Add key'
                : 'Connect key'}
          </Button>
          <button
            type="button"
            className="text-xs text-accent hover:underline"
            onClick={() => setMultiLine((v) => !v)}
          >
            {multiLine ? 'Single key input' : 'Paste multiple keys'}
          </button>
        </div>
      </form>

      {error ? (
        <p className="text-xs text-danger-fg" role="alert">
          {error}
        </p>
      ) : null}
      {message ? <p className="text-xs text-success-fg">{message}</p> : null}
    </div>
  );
}
