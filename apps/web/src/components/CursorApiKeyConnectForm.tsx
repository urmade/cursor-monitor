'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input } from '@nexus/ui';
import {
  actionConnectCursorApiKey,
  actionDisconnectCursorApiKey,
} from '../server/cursor-credentials';

export function CursorApiKeyConnectForm({
  connected,
  identityLabel,
  source,
}: {
  connected: boolean;
  identityLabel: string | null;
  source: 'user_cookie' | 'env' | 'none';
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface p-3">
      <div>
        <h2 className="text-sm font-medium text-fg">Cursor credentials</h2>
        <p className="mt-1 text-xs text-fg-muted">
          Cursor does not offer “Sign in with Cursor” for third-party apps. Paste a{' '}
          <strong>personal</strong> API key from{' '}
          <a
            href="https://cursor.com/dashboard/api"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            Cursor Dashboard → API Keys
          </a>{' '}
          so Monitoring lists <em>your</em> conversations (Cursor Cloud Agents). Stored
          in an httpOnly cookie for this browser only — not the org service-account key.
        </p>
      </div>

      {source === 'user_cookie' && connected ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <span>
            Using personal key: <span className="text-fg">{identityLabel}</span>
          </span>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setError(null);
              setMessage(null);
              startTransition(async () => {
                await actionDisconnectCursorApiKey();
                setMessage('Disconnected personal key. Falling back to env key if set.');
                router.refresh();
              });
            }}
          >
            Disconnect
          </Button>
        </div>
      ) : null}

      {source === 'env' && connected ? (
        <p className="text-xs text-warning-fg">
          Currently using the <strong>env / service-account</strong> key (
          {identityLabel}). That only shows agents owned by that key — not your desktop
          Cloud Agents. Paste your personal key below.
        </p>
      ) : null}

      {source === 'none' || !connected ? (
        <p className="text-xs text-fg-muted">
          No usable Cursor API key yet. Paste a personal key to continue.
        </p>
      ) : null}

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        action={(fd) => {
          setError(null);
          setMessage(null);
          startTransition(async () => {
            const result = await actionConnectCursorApiKey(fd);
            if (result.ok) {
              setMessage(`Connected as ${result.identity}`);
              router.refresh();
            } else {
              setError(result.error);
            }
          });
        }}
      >
        <Field label="Personal Cursor API key" className="min-w-0 flex-1">
          <Input
            name="apiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="cursor_…"
            disabled={pending}
          />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? 'Connecting…' : 'Connect key'}
        </Button>
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
