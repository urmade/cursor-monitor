export const DEFAULT_PROMPT_TEMPLATE = `You are working on ticket {{ticket.key}} ({{ticket.id}}) at stage "{{stage.name}}".

Use the \`nexus\` MCP server for all context and all output:
  1. Call get_ticket and get_spec first. Do not assume anything not returned there.
  2. Do the stage's work as defined by your automation's own instructions and the repository's rules.
  3. If you are blocked on a human decision, call ask_question with blocking: true and stop.
  4. Before finishing, call post_stage_report exactly once. A run without a report is treated as a failure.

Run correlation nonce: {{run.nonce}} (include it if a tool asks for it).`;

export const FAILING_PROMPT_TEMPLATE = `You are working on ticket {{ticket.key}} ({{ticket.id}}) at stage "{{stage.name}}".

This is a deliberately failing automation for Nexus demos.
Call get_ticket once, then stop without posting a stage report.
Do not call post_stage_report.

Run correlation nonce: {{run.nonce}}.`;

export function renderPromptTemplate(
  body: string,
  vars: {
    ticket: { id: string; key: string; title?: string };
    stage: { name: string; key?: string };
    run: { nonce: string; id?: string };
  },
): string {
  return body
    .replaceAll('{{ticket.id}}', vars.ticket.id)
    .replaceAll('{{ticket.key}}', vars.ticket.key)
    .replaceAll('{{ticket.title}}', vars.ticket.title ?? '')
    .replaceAll('{{stage.name}}', vars.stage.name)
    .replaceAll('{{stage.key}}', vars.stage.key ?? '')
    .replaceAll('{{run.nonce}}', vars.run.nonce)
    .replaceAll('{{run.id}}', vars.run.id ?? '');
}
