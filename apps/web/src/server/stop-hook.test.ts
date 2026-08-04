import { afterEach, describe, expect, it } from 'vitest';
import {
  AssignHookConversationError,
  buildHookSignalsTree,
  projectsFromHookSummaries,
  resolveHookConversationAssignTarget,
  summarizeHookRepos,
  type HookSignalEvent,
} from './hook-signals';
import {
  authorizeStopHookRequest,
  buildStopHookArtifact,
  calculateHookDurationMs,
  extractBranchFromPayload,
  extractRepoFromPayload,
  normalizeRepoLabel,
  parseHookTimestamp,
  readProtectionBypass,
  resolvePublicBaseUrl,
  resolvePublicBaseUrlDetailed,
  STOP_HOOK_LOG_FILE,
  STOP_HOOK_START_FILE,
} from './stop-hook';

describe('stop-hook helpers', () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env = { ...prev };
  });

  it('prefers NEXUS_VERCEL_BYPASS over VERCEL_PROTECTION_BYPASS', () => {
    process.env.NEXUS_VERCEL_BYPASS = 'cloud-bypass-token-value!!';
    process.env.VERCEL_PROTECTION_BYPASS = 'vercel-bypass-token-value';
    expect(readProtectionBypass()).toBe('cloud-bypass-token-value!!');
  });

  it('falls back to VERCEL_PROTECTION_BYPASS', () => {
    delete process.env.NEXUS_VERCEL_BYPASS;
    process.env.VERCEL_PROTECTION_BYPASS = 'vercel-only-token-value!!';
    expect(readProtectionBypass()).toBe('vercel-only-token-value!!');
  });

  it('authorizes matching bypass header', () => {
    process.env.NEXUS_VERCEL_BYPASS = 'exact-match-bypass-secret';
    const req = new Request('http://localhost/api/hooks/stop', {
      headers: { 'x-vercel-protection-bypass': 'exact-match-bypass-secret' },
    });
    expect(authorizeStopHookRequest(req)).toBe(true);
  });

  it('rejects missing or mismatched bypass', () => {
    process.env.NEXUS_VERCEL_BYPASS = 'exact-match-bypass-secret';
    expect(
      authorizeStopHookRequest(new Request('http://localhost/api/hooks/stop')),
    ).toBe(false);
    expect(
      authorizeStopHookRequest(
        new Request('http://localhost/api/hooks/stop', {
          headers: { 'x-vercel-protection-bypass': 'wrong' },
        }),
      ),
    ).toBe(false);
  });

  it('resolves public base URL from DEPLOYMENT_URL', () => {
    process.env.DEPLOYMENT_URL = 'https://nexus.example/';
    expect(resolvePublicBaseUrl()).toBe('https://nexus.example');
  });

  it('prefers the stable production domain over the deployment host', () => {
    delete process.env.DEPLOYMENT_URL;
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'nexus.example.com';
    process.env.VERCEL_URL = 'nexus-abc123.example.com';

    const resolved = resolvePublicBaseUrlDetailed(
      new Request('https://nexus-abc123.example.com/hooks/setup', {
        headers: { 'x-forwarded-host': 'nexus-abc123.example.com' },
      }),
    );
    expect(resolved.baseUrl).toBe('https://nexus.example.com');
    expect(resolved.source).toBe('production_domain');
    expect(resolved.stable).toBe(true);
  });

  it('uses the branch domain on preview so redeploys keep the endpoint', () => {
    delete process.env.DEPLOYMENT_URL;
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'nexus.example.com';
    process.env.VERCEL_BRANCH_URL = 'nexus-git-feat-x.example.com';
    process.env.VERCEL_URL = 'nexus-xyz789.example.com';

    const resolved = resolvePublicBaseUrlDetailed();
    expect(resolved.baseUrl).toBe('https://nexus-git-feat-x.example.com');
    expect(resolved.source).toBe('branch_domain');
    expect(resolved.environment).toBe('preview');
    expect(resolved.stable).toBe(true);
  });

  it('flags a deployment-scoped endpoint as unstable', () => {
    delete process.env.DEPLOYMENT_URL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_BRANCH_URL;
    process.env.VERCEL_URL = 'nexus-abc123.example.com';

    const resolved = resolvePublicBaseUrlDetailed(
      new Request('https://nexus-abc123.example.com/hooks/setup', {
        headers: { 'x-forwarded-host': 'nexus-abc123.example.com' },
      }),
    );
    expect(resolved.baseUrl).toBe('https://nexus-abc123.example.com');
    expect(resolved.source).toBe('vercel_deployment');
    expect(resolved.stable).toBe(false);
  });

  it('records POST outcomes so rejected hooks are not silent', () => {
    const artifact = buildStopHookArtifact({
      baseUrl: 'https://nexus.example',
      bypass: 'hardcoded-bypass-token',
    });
    expect(artifact.logFile).toBe(STOP_HOOK_LOG_FILE);
    expect(artifact.script).toContain("-w '%{http_code}'");
    expect(artifact.script).toContain('FAILED status=');
    expect(artifact.script).toContain(
      'LOG_FILE="${NEXUS_STOP_HOOK_LOG:-$HOME/.cursor/nexus-stop-hook.log}"',
    );
    expect(artifact.startFile).toBe(STOP_HOOK_START_FILE);
    expect(artifact.startScript).toContain('nexus-stop-hook-started-at');
    expect(artifact.script).toContain('started_at');
    expect(artifact.script).toContain('finished_at');
    // stdout must stay a bare hook response, whatever the POST did.
    expect(artifact.script).toContain("printf '%s\\n' '{}'");
    expect(artifact.script.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('embeds endpoint and bypass into a POSIX sh script for Linux and macOS', () => {
    const artifact = buildStopHookArtifact({
      baseUrl: 'https://nexus.example',
      bypass: 'hardcoded-bypass-token',
    });
    expect(artifact.endpoint).toBe('https://nexus.example/api/hooks/stop');
    expect(artifact.bypassConfigured).toBe(true);
    expect(artifact.scriptFilename).toBe('nexus-stop-to-supabase.sh');
    expect(artifact.script.startsWith('#!/bin/sh')).toBe(true);
    expect(artifact.script).toContain('Native Linux + macOS');
    expect(artifact.script).toContain('CURSOR_PROJECT_DIR');
    expect(artifact.script).toContain('hardcoded-bypass-token');
    expect(artifact.script).toContain('https://nexus.example/api/hooks/stop');
    expect(artifact.script).toContain('x-vercel-protection-bypass');
    expect(artifact.script).toContain('curl ');
    expect(artifact.script).toContain('detect_git');
    expect(artifact.script).toContain('nexus-cursor-stop-hook/1.5');
    expect(artifact.script).toContain('NEXUS_VERCEL_BYPASS');
    expect(artifact.script).toContain('NEXUS_STOP_HOOK_ENDPOINT');
    expect(artifact.startScriptFilename).toBe('nexus-start-timestamp.sh');
    expect(artifact.startScript.startsWith('#!/bin/sh')).toBe(true);
    expect(artifact.startScript).toContain('printf \'{"continue":true}\\n\'');
    expect(artifact.script.trimEnd().endsWith('exit 0')).toBe(true);
    // No bash-only arrays / locals — must parse under Linux /bin/sh (dash).
    expect(artifact.script).not.toMatch(/CURL_ARGS=|\$\{CURL_ARGS\[@\]\}|local /);
    expect(artifact.script).not.toMatch(/python3|urllib|#!\/usr\/bin\/env python|#!\/bin\/bash/i);
    expect(artifact.installSteps.some((s) => /Cloud Agents/i.test(s))).toBe(
      true,
    );
    expect(artifact.installSteps.some((s) => /project hooks/i.test(s))).toBe(
      true,
    );
    expect(JSON.parse(artifact.hooksJson)).toMatchObject({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [
          {
            command: `./${artifact.startScriptFilename}`,
            timeout: 5,
          },
        ],
        stop: [
          {
            command: `./${artifact.scriptFilename}`,
            timeout: 15,
          },
        ],
      },
    });
    expect(JSON.parse(artifact.projectHooksJson)).toMatchObject({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [
          {
            command: `.cursor/hooks/${artifact.startScriptFilename}`,
            timeout: 5,
          },
        ],
        stop: [
          {
            command: `.cursor/hooks/${artifact.scriptFilename}`,
            timeout: 15,
          },
        ],
      },
    });
  });

  it('generated script runs under dash and bash without syntax errors', async () => {
    const {
      writeFileSync,
      chmodSync,
      mkdirSync,
      mkdtempSync,
      rmSync,
      readFileSync,
      existsSync,
    } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawnSync } = await import('node:child_process');

    const artifact = buildStopHookArtifact({
      baseUrl: 'https://example.test',
      bypass: 'tok',
    });
    const dir = mkdtempSync(join(tmpdir(), 'nexus-stop-hook-'));
    const scriptPath = join(dir, artifact.scriptFilename);
    const startScriptPath = join(dir, artifact.startScriptFilename);
    const logPath = join(dir, 'hook.log');
    const curlDir = join(dir, 'bin');
    const curlBodyPath = join(dir, 'curl-body.json');
    mkdirSync(curlDir);
    const fakeProject = mkdtempSync(join(tmpdir(), 'nexus-project-'));
    writeFileSync(
      join(curlDir, 'curl'),
      [
        '#!/bin/sh',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --data-binary) shift; printf "%s" "$1" >"$CURL_BODY_PATH" ;;',
        '    -o) shift; printf "ok" >"$1" ;;',
        '    -w) shift; printf "200" ;;',
        '  esac',
        '  shift',
        'done',
      ].join('\n'),
      { mode: 0o755 },
    );
    writeFileSync(scriptPath, artifact.script, { mode: 0o755 });
    writeFileSync(startScriptPath, artifact.startScript, { mode: 0o755 });
    chmodSync(scriptPath, 0o755);
    chmodSync(startScriptPath, 0o755);

    const payload = JSON.stringify({
      conversation_id: 'c1',
      status: 'completed',
      workspace_roots: [process.cwd()],
    });

    for (const shell of ['sh', 'bash'] as const) {
      const statePath = join(dir, `${shell}.started-at`);
      const start = spawnSync(shell, [startScriptPath], {
        input: JSON.stringify({ prompt: 'start the request' }),
        encoding: 'utf8',
        env: {
          ...process.env,
          NEXUS_STOP_HOOK_START_FILE: statePath,
        },
        cwd: dir,
      });
      expect(start.status, `${shell} start exit`).toBe(0);
      expect(start.stdout.trim(), `${shell} start stdout`).toBe(
        '{"continue":true}',
      );
      expect(readFileSync(statePath, 'utf8')).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/,
      );

      const result = spawnSync(shell, [scriptPath], {
        input: payload,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${curlDir}:${process.env.PATH ?? ''}`,
          CURL_BODY_PATH: curlBodyPath,
          NEXUS_STOP_HOOK_LOG: logPath,
          NEXUS_STOP_HOOK_START_FILE: statePath,
        },
        // Team hooks: cwd is the managed hooks directory, not the project.
        cwd: dir,
      });
      expect(result.status, `${shell} exit`).toBe(0);
      expect(result.stdout.trim(), `${shell} stdout`).toBe('{}');
      expect(result.stderr ?? '', `${shell} stderr`).toBe('');
      const sent = JSON.parse(readFileSync(curlBodyPath, 'utf8')) as Record<
        string,
        unknown
      >;
      expect(sent.started_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
      expect(sent.finished_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
      expect(existsSync(statePath)).toBe(false);
    }

    // Simulate team/cloud cwd outside the repo; CURSOR_PROJECT_DIR must win.
    const teamLog = join(dir, 'team.log');
    const teamRun = spawnSync('sh', [scriptPath], {
      input: JSON.stringify({
        conversation_id: 'c2',
        status: 'completed',
      }),
      encoding: 'utf8',
      cwd: dir,
      env: {
        ...process.env,
        NEXUS_STOP_HOOK_LOG: teamLog,
        CURSOR_PROJECT_DIR: process.cwd(),
        HOME: fakeProject,
      },
    });
    expect(teamRun.status).toBe(0);
    expect(teamRun.stdout.trim()).toBe('{}');
    const teamBody = readFileSync(teamLog, 'utf8');
    expect(teamBody).toMatch(/FAILED status=/);

    const log = readFileSync(logPath, 'utf8');
    expect(log).toMatch(/ok https:\/\/example\.test\/api\/hooks\/stop/);
    expect(log).toContain('https://example.test/api/hooks/stop');

    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeProject, { recursive: true, force: true });
  });

  it('calculates durations only from valid, ordered timestamps', () => {
    const start = parseHookTimestamp('2026-08-04T14:00:00.000Z');
    const finish = parseHookTimestamp('2026-08-04T14:00:02.500Z');
    expect(calculateHookDurationMs(start, finish)).toBe(2500);
    expect(calculateHookDurationMs(null, finish)).toBeNull();
    expect(calculateHookDurationMs(finish, start)).toBeNull();
    expect(parseHookTimestamp('not-a-date')).toBeNull();
  });

  it('normalizes git remotes into owner/repo', () => {
    expect(normalizeRepoLabel('nina.v@example.com:acme/widgets.git')).toBe(
      'acme/widgets',
    );
    expect(normalizeRepoLabel('https://github.com/acme/widgets.git')).toBe(
      'acme/widgets',
    );
    expect(extractRepoFromPayload({ repository: 'acme/widgets' })).toBe(
      'acme/widgets',
    );
    expect(extractBranchFromPayload({ git_branch: 'feat/x' })).toBe('feat/x');
  });
});

describe('hook signals tree', () => {
  it('groups events by repository → conversation', () => {
    const events: HookSignalEvent[] = [
      {
        id: '1',
        userEmail: 'a@example.com',
        repo: 'Acme/One',
        gitBranch: 'main',
        workspaceRoot: '/tmp/one',
        conversationId: 'c1',
        generationId: 'g1',
        model: 'm',
        modelId: null,
        hookEventName: 'stop',
        status: 'completed',
        loopCount: 0,
        cursorVersion: '3',
        transcriptPath: null,
        workspaceRoots: ['/tmp/one'],
        modelParams: null,
        chargedCents: 1.5,
        costSource: 'organizations.filtered-usage-events',
        costLookupError: null,
        usageEvent: { chargedCents: 1.5 },
        payload: { status: 'completed' },
        startedAt: '2026-07-31T11:59:00.000Z',
        finishedAt: '2026-07-31T12:00:00.000Z',
        durationMs: 60000,
        receivedAt: '2026-07-31T12:00:00.000Z',
      },
      {
        id: '2',
        userEmail: 'a@example.com',
        repo: 'acme/one',
        gitBranch: null,
        workspaceRoot: '/tmp/one',
        conversationId: 'c1',
        generationId: 'g2',
        model: 'm',
        modelId: null,
        hookEventName: 'stop',
        status: 'error',
        loopCount: 1,
        cursorVersion: '3',
        transcriptPath: null,
        workspaceRoots: ['/tmp/one'],
        modelParams: null,
        chargedCents: null,
        costSource: null,
        costLookupError: 'no match',
        usageEvent: null,
        payload: { status: 'error' },
        startedAt: null,
        finishedAt: '2026-07-31T11:00:00.000Z',
        durationMs: null,
        receivedAt: '2026-07-31T11:00:00.000Z',
      },
      {
        id: '3',
        userEmail: 'b@example.com',
        repo: null,
        gitBranch: null,
        workspaceRoot: null,
        conversationId: null,
        generationId: null,
        model: null,
        modelId: null,
        hookEventName: 'stop',
        status: 'aborted',
        loopCount: 0,
        cursorVersion: null,
        transcriptPath: null,
        workspaceRoots: [],
        modelParams: null,
        chargedCents: null,
        costSource: null,
        costLookupError: null,
        usageEvent: null,
        payload: {},
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        receivedAt: '2026-07-31T10:00:00.000Z',
      },
      {
        id: '4',
        userEmail: 'c@example.com',
        repo: 'acme/two',
        gitBranch: 'feat',
        workspaceRoot: '/tmp/two',
        conversationId: 'c2',
        generationId: 'g3',
        model: 'm',
        modelId: null,
        hookEventName: 'stop',
        status: 'completed',
        loopCount: 0,
        cursorVersion: '3',
        transcriptPath: null,
        workspaceRoots: [],
        modelParams: null,
        chargedCents: 250,
        costSource: 'teams.filtered-usage-events',
        costLookupError: null,
        usageEvent: null,
        payload: {},
        startedAt: '2026-07-31T12:59:00.000Z',
        finishedAt: '2026-07-31T13:00:00.000Z',
        durationMs: 60000,
        receivedAt: '2026-07-31T13:00:00.000Z',
      },
    ];

    const tree = buildHookSignalsTree(events);
    expect(tree.totalEvents).toBe(4);
    expect(tree.repos.map((r) => r.repo)).toEqual([
      'acme/two',
      'acme/one',
      'No repository',
    ]);
    expect(tree.repos[1]!.branches).toEqual(['main']);
    expect(tree.repos[1]!.conversations[0]!.events).toHaveLength(2);
    expect(tree.repos[1]!.conversations[0]!.chargedCentsTotal).toBe(1.5);
    expect(tree.repos[1]!.conversations[0]!.userEmail).toBe('a@example.com');
    // Conversation branch comes from the newest event that reported one.
    expect(tree.repos[1]!.conversations[0]!.gitBranch).toBe('main');
    expect(tree.repos[0]!.conversations[0]!.gitBranch).toBe('feat');
    expect(tree.repos[2]!.conversations[0]!.gitBranch).toBeNull();
    expect(tree.repos[0]!.chargedCentsTotal).toBe(250);
    expect(tree.repos[2]!.conversations[0]!.conversationId).toBe(
      'Unknown conversation',
    );
  });

  it('builds monitoring projects from hook repo summaries', () => {
    const projects = projectsFromHookSummaries([
      {
        repo: 'acme/one',
        eventCount: 3,
        conversationCount: 1,
        totalChargedCents: 50,
        latestAt: '2026-07-31T10:00:00.000Z',
      },
      {
        repo: 'acme/hooks-only',
        eventCount: 2,
        conversationCount: 2,
        totalChargedCents: 12.34,
        latestAt: '2026-07-29T10:00:00.000Z',
      },
      {
        repo: 'No repository',
        eventCount: 1,
        conversationCount: 1,
        totalChargedCents: null,
        latestAt: '2026-07-28T10:00:00.000Z',
      },
    ]);
    expect(projects.map((p) => p.repo)).toEqual([
      'acme/one',
      'acme/hooks-only',
      'No repository',
    ]);
    expect(projects[0]).toMatchObject({
      conversationCount: 1,
      eventCount: 3,
      totalChargedCents: 50,
      latestCreatedAt: '2026-07-31T10:00:00.000Z',
    });
    expect(projects[1]!.conversationCount).toBe(2);
    expect(summarizeHookRepos(buildHookSignalsTree([])).length).toBe(0);
  });

  it('validates assign-repo targets against known Monitoring repos', () => {
    const known = ['acme/one', 'acme/two'];
    expect(resolveHookConversationAssignTarget('acme/one', known)).toBe(
      'acme/one',
    );
    expect(resolveHookConversationAssignTarget('  ACME/Two  ', known)).toBe(
      'acme/two',
    );
    expect(() =>
      resolveHookConversationAssignTarget('acme/unknown', known),
    ).toThrow(AssignHookConversationError);
    expect(() =>
      resolveHookConversationAssignTarget('', known),
    ).toThrow(AssignHookConversationError);
    expect(() =>
      resolveHookConversationAssignTarget('No repository', known),
    ).toThrow(AssignHookConversationError);
  });
});
