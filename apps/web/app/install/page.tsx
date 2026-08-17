import type { Metadata } from 'next';
import { CopyButton } from '@/src/components/CopyButton';
import { buildInstaller, type HookPlatform } from '@/src/server/installers';
import { currentAdmin } from '@/src/server/identity';

export const metadata: Metadata = { title: 'Install hooks' };
export const dynamic = 'force-dynamic';

const platforms: Array<{ key: HookPlatform; title: string; command: string }> = [
  {
    key: 'linux',
    title: 'Linux',
    command: 'sh install-cursor-monitor-linux.sh /path/to/repository',
  },
  {
    key: 'macos',
    title: 'macOS',
    command: 'sh install-cursor-monitor-macos.sh /path/to/repository',
  },
  {
    key: 'windows',
    title: 'Windows',
    command:
      'powershell.exe -ExecutionPolicy Bypass -File .\\install-cursor-monitor-windows.ps1 C:\\path\\to\\repository',
  },
];

export default async function InstallPage() {
  const admin = await currentAdmin();
  if (!admin) {
    return (
      <section className="panel empty">
        <h1>Admin sign-in required</h1>
        <p>Hook installers contain the ingestion credential.</p>
      </section>
    );
  }
  const artifacts = platforms.map((platform) => ({
    ...platform,
    artifact: buildInstaller(platform.key)!,
  }));
  const ready = artifacts.every(({ artifact }) => artifact.ready);

  return (
    <div className="stack">
      <header>
        <p className="eyebrow">Administrator setup</p>
        <h1>Install project hooks</h1>
        <p className="lede">
          Download the installer for the target operating system and run it from
          any repository. It writes only <span className="mono">.cursor/hooks.json</span>{' '}
          and two hook scripts. No package manager, language runtime, or helper
          library is installed.
        </p>
      </header>

      {!ready ? (
        <div className="callout">
          Hook authentication is not configured. Add{' '}
          <span className="mono">CURSOR_MONITOR_HOOK_TOKEN</span> or make the
          platform-provided <span className="mono">VERCEL_PROTECTION_BYPASS</span>{' '}
          available, then redeploy.
        </div>
      ) : null}

      <section className="panel">
        <h2>What gets installed</h2>
        <ol className="muted small">
          <li>
            A <span className="mono">beforeSubmitPrompt</span> hook records the
            request start time locally.
          </li>
          <li>
            A <span className="mono">stop</span> hook enriches Cursor metadata
            with repository and branch details, then POSTs it to this app.
          </li>
          <li>
            Every hook failure is non-blocking and appended to{' '}
            <span className="mono">~/.cursor/cursor-monitor/hook.log</span>.
          </li>
          <li>
            Commit the generated <span className="mono">.cursor</span> directory
            only in private repositories whose readers may submit events. This
            applies the hook to local IDEs and Cloud Agents using that repository.
          </li>
          <li>
            Existing <span className="mono">hooks.json</span> files are preserved.
            Merge the generated{' '}
            <span className="mono">hooks.cursor-monitor.example.json</span> arrays
            into the existing configuration.
          </li>
        </ol>
      </section>

      <section className="platform-grid">
        {artifacts.map(({ key, title, command, artifact }) => (
          <article className="panel stack" key={key}>
            <div className="platform-header">
              <div>
                <h2>{title}</h2>
                <p className="small muted">{artifact.requirements}</p>
              </div>
              <div className="code-actions">
                <CopyButton value={artifact.content} />
                <a
                  className="button button-primary"
                  download={artifact.filename}
                  href={`/api/install/${key}`}
                >
                  Download installer
                </a>
              </div>
            </div>
            <div>
              <p className="small subtle">Run after downloading</p>
              <pre>{command}</pre>
            </div>
            <details>
              <summary className="small muted">Review generated installer</summary>
              <pre>{artifact.content}</pre>
            </details>
          </article>
        ))}
      </section>

      <section className="panel">
        <h2>Team-wide installation</h2>
        <p className="small muted">
          The generated files are ordinary Cursor project hooks. For centrally
          managed Team Hooks, upload the matching start and stop scripts with the
          exact filenames from the installer and copy the two command entries from{' '}
          <span className="mono">hooks.json</span>. Keep the scripts private:
          their endpoint credential grants event-ingestion access.
        </p>
      </section>
    </div>
  );
}
