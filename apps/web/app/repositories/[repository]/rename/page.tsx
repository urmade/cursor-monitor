import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  canonicalConversation,
  canonicalRepository,
  displayConversationKey,
  displayRepositoryKey,
  NO_REPOSITORY_KEY,
  UNKNOWN_CONVERSATION_KEY,
} from '@cursor-monitor/core';
import { RenameForm } from '@/src/components/RenameForm';
import { conversationBranchKey } from '@/src/lib/branches';
import { renamePath, repositoryPath } from '@/src/lib/paths';
import {
  renameBranch,
  renameConversation,
  renameRepository,
} from '@/src/server/actions';
import {
  loadBranchNames,
  loadConversationNames,
  loadRepositoryPreferences,
  loadRepositoryProject,
} from '@/src/server/data';
import { currentAdmin } from '@/src/server/identity';

export const dynamic = 'force-dynamic';

function renameBreadcrumbs(
  projectName: string,
  projectHref: string,
  current: string,
) {
  return (
    <div className="breadcrumbs">
      <Link href="/">Repositories</Link>
      <span>/</span>
      <Link href={projectHref}>{projectName}</Link>
      <span>/</span>
      <span>{current}</span>
    </div>
  );
}

type RenameSearchParams = {
  conversation?: string;
  branch?: string;
};

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<RenameSearchParams>;
}): Promise<Metadata> {
  const { conversation, branch } = await searchParams;
  if (conversation) return { title: 'Rename conversation' };
  if (branch) return { title: 'Rename branch' };
  return { title: 'Rename repository' };
}

export default async function RenamePage({
  params,
  searchParams,
}: {
  params: Promise<{ repository: string }>;
  searchParams: Promise<RenameSearchParams>;
}) {
  const { repository: rawRepository } = await params;
  const { conversation: rawConversation, branch: rawBranch } = await searchParams;
  const requested = canonicalRepository(decodeURIComponent(rawRepository));
  const [data, admin] = await Promise.all([
    loadRepositoryProject(requested),
    currentAdmin(),
  ]);
  let project = data.project;
  if (!project) {
    const merged = data.tree.projects.find((candidate) =>
      candidate.sourceRepositories.includes(requested),
    );
    if (merged) {
      redirect(
        renamePath(merged.key, {
          conversation: rawConversation,
          branch: rawBranch,
        }),
      );
    }
    notFound();
  }
  project = project!;
  const cancelHref = repositoryPath(project.key);

  if (!admin) {
    return (
      <section className="panel empty">
        <h1>Admin sign-in required</h1>
        <p>Display names can only be changed by a signed-in administrator.</p>
        <Link className="button button-secondary" href={cancelHref}>
          Back to project
        </Link>
      </section>
    );
  }

  const conversationKey = rawConversation
    ? canonicalConversation(rawConversation)
    : null;
  const branchKey = rawBranch?.trim() || null;

  if (conversationKey) {
    if (conversationKey === UNKNOWN_CONVERSATION_KEY) notFound();
    const conversation = project.conversations.find(
      (candidate) => candidate.key === conversationKey,
    );
    if (!conversation) notFound();
    const names = await loadConversationNames();
    const currentName = names.get(conversation.key)?.trim() ?? '';
    const placeholder =
      conversation.userEmail?.trim() ||
      displayConversationKey(conversation.key);
    return (
      <RenameForm
        action={renameConversation}
        breadcrumbs={renameBreadcrumbs(
          project.displayName,
          cancelHref,
          'Rename conversation',
        )}
        cancelHref={cancelHref}
        currentName={currentName}
        eyebrow="Display preference"
        hiddenFields={{
          conversationKey: conversation.key,
          repositoryKey: project.key,
          returnTo: cancelHref,
        }}
        lede="This label appears on the project page. Conversation identity, usage joins, and raw payloads stay on the original Cursor conversation ID."
        placeholder={placeholder}
        stableLabel="Conversation ID"
        stableValue={conversation.id ?? conversation.key}
        title={`Rename ${conversation.displayName}`}
      />
    );
  }

  if (branchKey) {
    const groups = new Set(
      project.conversations.map((conversation) =>
        conversationBranchKey(conversation, project.sourceRepositories.length),
      ),
    );
    if (!groups.has(branchKey)) notFound();
    const names = await loadBranchNames(project.key);
    const currentName = names.get(branchKey)?.trim() ?? '';
    return (
      <RenameForm
        action={renameBranch}
        breadcrumbs={renameBreadcrumbs(
          project.displayName,
          cancelHref,
          'Rename branch',
        )}
        cancelHref={cancelHref}
        currentName={currentName}
        eyebrow="Display preference"
        hiddenFields={{
          repositoryKey: project.key,
          branchKey,
          returnTo: cancelHref,
        }}
        lede="This label groups conversations on the project page. The underlying git branch name is unchanged."
        placeholder={branchKey}
        stableLabel="Branch key"
        stableValue={branchKey}
        title={`Rename ${currentName || branchKey}`}
      />
    );
  }

  if (project.key === NO_REPOSITORY_KEY) {
    notFound();
  }

  const preferences = await loadRepositoryPreferences();
  const currentName =
    preferences
      .find((preference) => preference.repositoryKey === project.key)
      ?.displayName?.trim() ?? '';
  const placeholder = displayRepositoryKey(project.key);

  return (
    <RenameForm
      action={renameRepository}
      breadcrumbs={renameBreadcrumbs(
        project.displayName,
        cancelHref,
        'Rename repository',
      )}
      cancelHref={cancelHref}
      currentName={currentName}
      eyebrow="Display preference"
      hiddenFields={{
        repositoryKey: project.key,
        returnTo: cancelHref,
      }}
      lede="This label appears on the dashboard and project page. The canonical repository key, URLs, and raw hook payloads stay the same."
      placeholder={placeholder}
      stableLabel="Repository key"
      stableValue={project.key}
      title={`Rename ${project.displayName}`}
    />
  );
}
