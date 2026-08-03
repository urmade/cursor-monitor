'use client';

import { useMemo, useRef, useState } from 'react';
import { Button, Panel, PanelBody, PanelHeader } from '@nexus/ui';
import { formatRelativeTime } from '../lib/monitoring-format';
import type { HookIngestStatus } from '../server/hook-signals';

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // Fall back when Clipboard API is blocked (unfocused / non-secure contexts).
  }

  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('copy_failed');
}

function CopyBlock({
  title,
  filename,
  downloadName,
  value,
}: {
  title: string;
  filename?: string;
  downloadName: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const downloadHref = useMemo(
    () => `data:text/plain;charset=utf-8,${encodeURIComponent(value)}`,
    [value],
  );

  async function onCopy() {
    try {
      await copyText(value);
      setCopied(true);
      setHint(null);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      const pre = preRef.current;
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setCopied(false);
      setHint('Selected — press Ctrl/Cmd+C');
      window.setTimeout(() => setHint(null), 2500);
    }
  }

  return (
    <Panel>
      <PanelHeader>
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg">{title}</div>
          {filename ? (
            <div className="font-mono text-xs text-fg-muted">{filename}</div>
          ) : null}
          {hint ? (
            <div className="text-xs text-fg-muted" role="status">
              {hint}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="ghost">
            <a href={downloadHref} download={downloadName}>
              Download
            </a>
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={onCopy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </PanelHeader>
      <PanelBody className="p-0">
        <pre
          ref={preRef}
          className="max-h-[28rem] overflow-auto p-3 font-mono text-xs leading-relaxed text-fg whitespace-pre-wrap break-all"
        >
          {value}
        </pre>
      </PanelBody>
    </Panel>
  );
}

export function StopHookCopyPanel({
  hooksJson,
  script,
  scriptFilename,
  endpoint,
  bypassConfigured,
  installSteps,
  logFile,
  environment,
  endpointStable,
  ingest,
  ingestError,
}: {
  hooksJson: string;
  script: string;
  scriptFilename: string;
  endpoint: string;
  bypassConfigured: boolean;
  installSteps: string[];
  logFile: string;
  environment: string | null;
  endpointStable: boolean;
  ingest: HookIngestStatus | null;
  ingestError: string | null;
}) {
  const combined = [
    `# 1) Save as .cursor/hooks/${scriptFilename}`,
    script.trimEnd(),
    '',
    '# 2) Merge into .cursor/hooks.json',
    hooksJson.trimEnd(),
    '',
  ].join('\n');

  return (
    <div className="space-y-4">
      {!bypassConfigured ? (
        <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg">
          Protection bypass is not configured in this environment (
          <code className="font-mono text-xs">NEXUS_VERCEL_BYPASS</code> /{' '}
          <code className="font-mono text-xs">VERCEL_PROTECTION_BYPASS</code>
          ). The script will still POST, but Passport-protected hosts will reject
          it until the secret is set.
        </p>
      ) : (
        <p className="text-sm text-fg-muted">
          Endpoint{' '}
          <code className="font-mono text-xs text-fg">{endpoint}</code> — bypass
          token is hardcoded in the script so projects outside Vercel can write
          through deployment protection into Supabase.
        </p>
      )}

      {environment === 'preview' ? (
        <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg">
          This is a <strong>preview</strong> deployment: turns posted to the
          endpoint above land in the preview database and never appear in
          production Monitoring. Copy the hook from the production URL for
          day-to-day use.
        </p>
      ) : null}

      {!endpointStable ? (
        <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg">
          The endpoint resolves to a single deployment host, which changes on
          every deploy. Set <code className="font-mono text-xs">DEPLOYMENT_URL</code>{' '}
          to a stable domain so already-installed hooks keep reaching the current
          build.
        </p>
      ) : null}

      <p className="text-sm text-fg-muted">
        {ingestError
          ? `Stored turns unavailable: ${ingestError}`
          : ingest == null || ingest.totalEvents === 0
            ? 'No stop-hook turns stored yet in this environment.'
            : `${ingest.totalEvents} turn${ingest.totalEvents === 1 ? '' : 's'} stored · newest ${formatRelativeTime(ingest.latest?.receivedAt)}${ingest.latest?.repo ? ` from ${ingest.latest.repo}` : ''}${ingest.latest?.userEmail ? ` (${ingest.latest.userEmail})` : ''}.`}{' '}
        Local POST outcomes are appended to{' '}
        <code className="font-mono text-xs text-fg">{logFile}</code>.
      </p>

      <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted">
        {installSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <CopyBlock
        title="Copy everything"
        downloadName="nexus-stop-hook-install.txt"
        value={combined}
      />
      <CopyBlock
        title="hooks.json"
        filename=".cursor/hooks.json"
        downloadName="hooks.json"
        value={hooksJson}
      />
      <CopyBlock
        title="Stop hook script"
        filename={`.cursor/hooks/${scriptFilename}`}
        downloadName={scriptFilename}
        value={script}
      />
    </div>
  );
}
