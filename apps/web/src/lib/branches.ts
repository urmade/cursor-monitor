export function conversationBranchKey(
  conversation: {
    branch: string | null;
    originatingRepository: string;
  },
  repositoryCount: number,
): string {
  const branch = conversation.branch || 'No branch';
  return repositoryCount > 1
    ? `${conversation.originatingRepository}/${branch}`
    : branch;
}
