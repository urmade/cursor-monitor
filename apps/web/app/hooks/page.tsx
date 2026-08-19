import type { Metadata } from 'next';
import { CopyButton } from '@/src/components/CopyButton';
import {
  buildHookScripts,
  type HookPlatform,
} from '@/src/server/hook-scripts';
import { currentAdmin } from '@/src/server/identity';

export const metadata: Metadata = { title: 'Team hooks' };
export const dynamic = 'force-dynamic';

const platforms: Array<{ key: HookPlatform; title: string }> = [
  { key: 'linux', title: 'Linux' },
  { key: 'macos', title: 'macOS' },
  { key: 'windows', title: 'Windows' },
];

export default async function HooksPage() {
  const admin = await currentAdmin();
  if (!admin) {
    return (
      <section className="panel empty">
        <h1>Admin sign-in required</h1>
        <p>Team hook scripts contain the ingestion credential.</p>
      </section>
    );
  }
  const bundles = platforms.map((platform) => ({
    ...platform,
    bundle: buildHookScripts(platform.key)!,
  }));
  const ready = bundles.every(({ bundle }) => bundle.ready);

  return (
    <div className="stack">
      <header>
        <p className="eyebrow">Administrator setup</p>
        <h1>Configure Cursor Team Hooks</h1>
        <p className="lede">
          Download the two scripts for the operating system used by your team,
          then upload them directly in Cursor&apos;s Team Hooks settings. Nothing
          is written to repositories or installed through an installer wrapper;
          hooks only maintain local timing state under{' '}
          <span className="mono">~/.cursor/cursor-monitor</span>.
        </p>
      </header>

      {!ready ? (
        <div className="callout">
          Hook authentication is not configured. Add{' '}
          <span className="mono">CURSOR_MONITOR_HOOK_TOKEN</span>, then redeploy.
          Script preview, copy, and download stay disabled until the token is
          configured. See <span className="mono">docs/hooks.md</span> for why this
          credential exists.
        </div>
      ) : null}

      <section className="panel">
        <h2>Team Hook setup</h2>
        <ol className="muted small">
          <li>
            Add a <span className="mono">beforeSubmitPrompt</span> Team Hook and
            upload the matching start script with a five-second timeout.
          </li>
          <li>
            Add a <span className="mono">stop</span> Team Hook and upload the
            matching stop script with a fifteen-second timeout.
          </li>
          <li>
            Apply the hooks to the intended team scope. Do not commit these
            scripts to repositories; the stop script contains an ingestion
            credential.
          </li>
        </ol>
      </section>

      <section className="platform-grid">
        {bundles.map(({ key, title, bundle }) => (
          <article className="panel stack" key={key}>
            <div>
              <h2>{title}</h2>
              <p className="small muted">{bundle.requirements}</p>
            </div>
            {bundle.scripts.map((script) => (
              <section className="stack" key={script.kind}>
                <div className="platform-header">
                  <div>
                    <h3>{script.eventName}</h3>
                    <p className="small subtle">
                      {script.filename} · {script.timeout}s timeout
                    </p>
                  </div>
                  {ready ? (
                    <div className="code-actions">
                      <CopyButton value={script.content} />
                      <a
                        className="button button-primary"
                        download={script.filename}
                        href={`/api/hooks/${key}/${script.kind}`}
                      >
                        Download script
                      </a>
                    </div>
                  ) : (
                    <p className="small muted">
                      Preview, copy, and download unlock after hook token
                      configuration.
                    </p>
                  )}
                </div>
                {ready ? (
                  <details>
                    <summary className="small muted">Review hook script</summary>
                    <pre>{script.content}</pre>
                  </details>
                ) : null}
              </section>
            ))}
          </article>
        ))}
      </section>

      <section className="panel">
        <h2>Credential handling</h2>
        <p className="small muted">
          Fresh downloads contain the current app endpoint and hook credential.
          Centrally managed Team Hook environment variables may override{' '}
          <span className="mono">CURSOR_MONITOR_ENDPOINT</span> and{' '}
          <span className="mono">CURSOR_MONITOR_HOOK_TOKEN</span> for rotation.
        </p>
      </section>
    </div>
  );
}
