import { and, eq, sql } from 'drizzle-orm';
import {
  getDb,
  monitoringBranchPreferences,
  monitoringRepoPreferences,
  newId,
} from '@nexus/db';
import { HOOK_NO_REPO_GROUP } from './hook-signals';

export type MonitoringRepoPref = {
  repo: string;
  displayName: string | null;
  hidden: boolean;
  mergedIntoRepo: string | null;
};

export type MonitoringProjectView = {
  /** Canonical root repo key used in URLs. */
  repo: string;
  /** Label shown on cards / headers. */
  displayName: string;
  /** Canonical repos contributing to this project (root first). */
  memberRepos: string[];
  conversationCount: number;
  eventCount: number;
  totalChargedCents: number | null;
  latestCreatedAt: string | null;
  /** True when this card was hidden by preference (shown only in hidden list). */
  hidden: boolean;
};

export class MonitoringRepoPrefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonitoringRepoPrefError';
  }
}

function normalizeRepoKey(label: string): string {
  return label.trim().toLowerCase();
}

export function prefsByRepo(
  prefs: readonly MonitoringRepoPref[],
): Map<string, MonitoringRepoPref> {
  const map = new Map<string, MonitoringRepoPref>();
  for (const p of prefs) {
    map.set(normalizeRepoKey(p.repo), {
      repo: normalizeRepoKey(p.repo),
      displayName: p.displayName?.trim() || null,
      hidden: p.hidden,
      mergedIntoRepo: p.mergedIntoRepo
        ? normalizeRepoKey(p.mergedIntoRepo)
        : null,
    });
  }
  return map;
}

/**
 * Follow `mergedIntoRepo` until the root. Cycle-safe: stops and returns the
 * last seen repo if a loop is detected.
 */
export function resolveMergeRoot(
  repo: string,
  prefs: Map<string, MonitoringRepoPref>,
): string {
  const start = normalizeRepoKey(repo);
  if (start === HOOK_NO_REPO_GROUP) return start;
  const seen = new Set<string>();
  let current = start;
  while (true) {
    if (seen.has(current)) return current;
    seen.add(current);
    const target = prefs.get(current)?.mergedIntoRepo;
    if (!target || target === HOOK_NO_REPO_GROUP) return current;
    current = target;
  }
}

/** All canonical repos that resolve to `root` (including root itself). */
export function memberReposForRoot(
  root: string,
  allRepos: readonly string[],
  prefs: Map<string, MonitoringRepoPref>,
): string[] {
  const canonicalRoot = normalizeRepoKey(root);
  const members = allRepos
    .map(normalizeRepoKey)
    .filter((r) => resolveMergeRoot(r, prefs) === canonicalRoot);
  // Prefer root first, then alphabetical.
  members.sort((a, b) => {
    if (a === canonicalRoot) return -1;
    if (b === canonicalRoot) return 1;
    return a.localeCompare(b);
  });
  if (!members.includes(canonicalRoot) && canonicalRoot !== HOOK_NO_REPO_GROUP) {
    members.unshift(canonicalRoot);
  }
  return members;
}

type ProjectLike = {
  repo: string;
  conversationCount: number;
  eventCount: number;
  totalChargedCents: number | null;
  latestCreatedAt: string | null;
};

/**
 * Apply hide / rename / merge preferences to raw Monitoring project summaries.
 * Returns visible projects by default; pass `includeHidden: true` to also get
 * hidden roots (tagged `hidden: true`).
 */
export function applyMonitoringRepoPrefs(
  projects: readonly ProjectLike[],
  prefsList: readonly MonitoringRepoPref[],
  options: { includeHidden?: boolean } = {},
): MonitoringProjectView[] {
  const prefs = prefsByRepo(prefsList);

  type Acc = {
    repo: string;
    conversationCount: number;
    eventCount: number;
    totalChargedCents: number | null;
    latestCreatedAt: string | null;
    memberRepos: Set<string>;
  };

  const roots = new Map<string, Acc>();

  for (const project of projects) {
    const repo = normalizeRepoKey(project.repo);
    const root = resolveMergeRoot(repo, prefs);
    let acc = roots.get(root);
    if (!acc) {
      acc = {
        repo: root,
        conversationCount: 0,
        eventCount: 0,
        totalChargedCents: null,
        latestCreatedAt: null,
        memberRepos: new Set(),
      };
      roots.set(root, acc);
    }
    acc.memberRepos.add(repo);
    acc.conversationCount += project.conversationCount;
    acc.eventCount += project.eventCount;
    if (project.totalChargedCents != null) {
      acc.totalChargedCents =
        (acc.totalChargedCents ?? 0) + project.totalChargedCents;
    }
    const latestMs = project.latestCreatedAt
      ? Date.parse(project.latestCreatedAt)
      : 0;
    const accMs = acc.latestCreatedAt ? Date.parse(acc.latestCreatedAt) : 0;
    if (latestMs > accMs) {
      acc.latestCreatedAt = project.latestCreatedAt;
    }
  }

  const views: MonitoringProjectView[] = [];
  for (const acc of roots.values()) {
    const rootPref = prefs.get(acc.repo);
    const hidden = Boolean(rootPref?.hidden);
    if (hidden && !options.includeHidden) continue;

    const members = [...acc.memberRepos].sort((a, b) => {
      if (a === acc.repo) return -1;
      if (b === acc.repo) return 1;
      return a.localeCompare(b);
    });

    views.push({
      repo: acc.repo,
      displayName: rootPref?.displayName?.trim() || acc.repo,
      memberRepos: members,
      conversationCount: acc.conversationCount,
      eventCount: acc.eventCount,
      totalChargedCents: acc.totalChargedCents,
      latestCreatedAt: acc.latestCreatedAt,
      hidden,
    });
  }

  const noRepo = views.filter((v) => v.repo === HOOK_NO_REPO_GROUP);
  const rest = views.filter((v) => v.repo !== HOOK_NO_REPO_GROUP);
  rest.sort((a, b) => {
    const at = a.latestCreatedAt ? Date.parse(a.latestCreatedAt) : 0;
    const bt = b.latestCreatedAt ? Date.parse(b.latestCreatedAt) : 0;
    if (at !== bt) return bt - at;
    return a.displayName.localeCompare(b.displayName);
  });
  return [...rest, ...noRepo];
}

export async function loadMonitoringRepoPrefs(
  orgId: string,
): Promise<MonitoringRepoPref[]> {
  const rows = await getDb()
    .select({
      repo: monitoringRepoPreferences.repo,
      displayName: monitoringRepoPreferences.displayName,
      hidden: monitoringRepoPreferences.hidden,
      mergedIntoRepo: monitoringRepoPreferences.mergedIntoRepo,
    })
    .from(monitoringRepoPreferences)
    .where(eq(monitoringRepoPreferences.orgId, orgId));

  return rows.map((r) => ({
    repo: normalizeRepoKey(r.repo),
    displayName: r.displayName?.trim() || null,
    hidden: r.hidden,
    mergedIntoRepo: r.mergedIntoRepo
      ? normalizeRepoKey(r.mergedIntoRepo)
      : null,
  }));
}

async function upsertPref(
  orgId: string,
  repo: string,
  patch: {
    displayName?: string | null;
    hidden?: boolean;
    mergedIntoRepo?: string | null;
  },
): Promise<MonitoringRepoPref> {
  const canonical = normalizeRepoKey(repo);
  if (!canonical || canonical === HOOK_NO_REPO_GROUP) {
    throw new MonitoringRepoPrefError('Choose a repository.');
  }

  const db = getDb();
  const [existing] = await db
    .select()
    .from(monitoringRepoPreferences)
    .where(
      and(
        eq(monitoringRepoPreferences.orgId, orgId),
        sql`lower(btrim(${monitoringRepoPreferences.repo})) = ${canonical}`,
      ),
    )
    .limit(1);

  const nextDisplayName =
    patch.displayName !== undefined
      ? patch.displayName?.trim() || null
      : (existing?.displayName?.trim() || null);
  const nextHidden =
    patch.hidden !== undefined ? patch.hidden : Boolean(existing?.hidden);
  const nextMerged =
    patch.mergedIntoRepo !== undefined
      ? patch.mergedIntoRepo
        ? normalizeRepoKey(patch.mergedIntoRepo)
        : null
      : existing?.mergedIntoRepo
        ? normalizeRepoKey(existing.mergedIntoRepo)
        : null;

  if (nextMerged === canonical) {
    throw new MonitoringRepoPrefError('A repository cannot merge into itself.');
  }

  // Default row with no meaningful prefs → delete if exists.
  const isDefault =
    nextDisplayName == null && !nextHidden && nextMerged == null;

  if (isDefault) {
    if (existing) {
      await db
        .delete(monitoringRepoPreferences)
        .where(eq(monitoringRepoPreferences.id, existing.id));
    }
    return {
      repo: canonical,
      displayName: null,
      hidden: false,
      mergedIntoRepo: null,
    };
  }

  const now = new Date();
  if (existing) {
    const [updated] = await db
      .update(monitoringRepoPreferences)
      .set({
        displayName: nextDisplayName,
        hidden: nextHidden,
        mergedIntoRepo: nextMerged,
        updatedAt: now,
      })
      .where(eq(monitoringRepoPreferences.id, existing.id))
      .returning();
    return {
      repo: normalizeRepoKey(updated!.repo),
      displayName: updated!.displayName?.trim() || null,
      hidden: updated!.hidden,
      mergedIntoRepo: updated!.mergedIntoRepo
        ? normalizeRepoKey(updated!.mergedIntoRepo)
        : null,
    };
  }

  const [inserted] = await db
    .insert(monitoringRepoPreferences)
    .values({
      id: newId(),
      orgId,
      repo: canonical,
      displayName: nextDisplayName,
      hidden: nextHidden,
      mergedIntoRepo: nextMerged,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return {
    repo: normalizeRepoKey(inserted!.repo),
    displayName: inserted!.displayName?.trim() || null,
    hidden: inserted!.hidden,
    mergedIntoRepo: inserted!.mergedIntoRepo
      ? normalizeRepoKey(inserted!.mergedIntoRepo)
      : null,
  };
}

export async function renameMonitoringRepo(
  orgId: string,
  repo: string,
  displayName: string | null,
): Promise<MonitoringRepoPref> {
  const name = displayName?.trim() || null;
  if (name && name.length > 120) {
    throw new MonitoringRepoPrefError('Display name is too long.');
  }
  return upsertPref(orgId, repo, { displayName: name });
}

export async function setMonitoringRepoHidden(
  orgId: string,
  repo: string,
  hidden: boolean,
): Promise<MonitoringRepoPref> {
  const canonical = normalizeRepoKey(repo);
  if (canonical === HOOK_NO_REPO_GROUP) {
    throw new MonitoringRepoPrefError(
      'The “No repository” bucket cannot be hidden.',
    );
  }
  // Hiding a merged child is meaningless (it already disappears); hide the root.
  const prefs = prefsByRepo(await loadMonitoringRepoPrefs(orgId));
  const root = resolveMergeRoot(canonical, prefs);
  return upsertPref(orgId, root, { hidden });
}

export async function mergeMonitoringRepo(
  orgId: string,
  sourceRepo: string,
  targetRepo: string,
): Promise<MonitoringRepoPref> {
  const source = normalizeRepoKey(sourceRepo);
  const target = normalizeRepoKey(targetRepo);
  if (!source || source === HOOK_NO_REPO_GROUP) {
    throw new MonitoringRepoPrefError('Choose a repository to attach.');
  }
  if (!target || target === HOOK_NO_REPO_GROUP) {
    throw new MonitoringRepoPrefError('Choose a project to merge into.');
  }
  if (source === target) {
    throw new MonitoringRepoPrefError('A repository cannot merge into itself.');
  }

  const prefs = prefsByRepo(await loadMonitoringRepoPrefs(orgId));
  const targetRoot = resolveMergeRoot(target, prefs);
  if (targetRoot === source) {
    throw new MonitoringRepoPrefError(
      'That merge would create a cycle — pick a different target.',
    );
  }
  // If source is already a root with children, refuse (would orphan / confuse).
  for (const pref of prefs.values()) {
    if (
      pref.mergedIntoRepo &&
      resolveMergeRoot(pref.repo, prefs) === source &&
      pref.repo !== source
    ) {
      throw new MonitoringRepoPrefError(
        'Detach attached repositories from this project before merging it into another.',
      );
    }
  }

  return upsertPref(orgId, source, {
    mergedIntoRepo: targetRoot,
    // Attached repos are not listed separately; clear hide on the child.
    hidden: false,
  });
}

export async function unmergeMonitoringRepo(
  orgId: string,
  sourceRepo: string,
): Promise<MonitoringRepoPref> {
  return upsertPref(orgId, sourceRepo, { mergedIntoRepo: null });
}

export type MonitoringBranchPref = {
  projectRepo: string;
  branchKey: string;
  displayName: string;
};

function normalizeBranchKey(branchKey: string): string {
  return branchKey.trim();
}

/** Map of branchKey → displayName for one Monitoring project. */
export async function loadMonitoringBranchPrefs(
  orgId: string,
  projectRepo: string,
): Promise<Record<string, string>> {
  const canonical =
    projectRepo === HOOK_NO_REPO_GROUP
      ? HOOK_NO_REPO_GROUP
      : normalizeRepoKey(projectRepo);
  const rows = await getDb()
    .select({
      branchKey: monitoringBranchPreferences.branchKey,
      displayName: monitoringBranchPreferences.displayName,
    })
    .from(monitoringBranchPreferences)
    .where(
      and(
        eq(monitoringBranchPreferences.orgId, orgId),
        sql`lower(btrim(${monitoringBranchPreferences.projectRepo})) = ${canonical}`,
      ),
    );

  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = normalizeBranchKey(row.branchKey);
    const name = row.displayName.trim();
    if (key && name) out[key] = name;
  }
  return out;
}

/**
 * Set or clear a display label for a branch group. Clearing deletes the row
 * so the UI falls back to the original branch name.
 */
export async function renameMonitoringBranch(
  orgId: string,
  projectRepo: string,
  branchKey: string,
  displayName: string | null,
): Promise<MonitoringBranchPref | null> {
  const project =
    projectRepo === HOOK_NO_REPO_GROUP
      ? HOOK_NO_REPO_GROUP
      : normalizeRepoKey(projectRepo);
  const branch = normalizeBranchKey(branchKey);
  if (!project) {
    throw new MonitoringRepoPrefError('Missing project.');
  }
  if (!branch || branch === 'none') {
    throw new MonitoringRepoPrefError('Choose a branch to rename.');
  }
  const name = displayName?.trim() || null;
  if (name && name.length > 120) {
    throw new MonitoringRepoPrefError('Display name is too long.');
  }

  const db = getDb();
  const [existing] = await db
    .select()
    .from(monitoringBranchPreferences)
    .where(
      and(
        eq(monitoringBranchPreferences.orgId, orgId),
        sql`lower(btrim(${monitoringBranchPreferences.projectRepo})) = ${project}`,
        sql`lower(btrim(${monitoringBranchPreferences.branchKey})) = ${branch.toLowerCase()}`,
      ),
    )
    .limit(1);

  if (!name) {
    if (existing) {
      await db
        .delete(monitoringBranchPreferences)
        .where(eq(monitoringBranchPreferences.id, existing.id));
    }
    return null;
  }

  const now = new Date();
  if (existing) {
    const [updated] = await db
      .update(monitoringBranchPreferences)
      .set({ displayName: name, updatedAt: now })
      .where(eq(monitoringBranchPreferences.id, existing.id))
      .returning();
    return {
      projectRepo: project,
      branchKey: normalizeBranchKey(updated!.branchKey),
      displayName: updated!.displayName.trim(),
    };
  }

  const [inserted] = await db
    .insert(monitoringBranchPreferences)
    .values({
      id: newId(),
      orgId,
      projectRepo: project,
      branchKey: branch,
      displayName: name,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return {
    projectRepo: project,
    branchKey: normalizeBranchKey(inserted!.branchKey),
    displayName: inserted!.displayName.trim(),
  };
}
