import {
  AskQuestionArgsSchema,
  AttachArtifactRefArgsSchema,
  GetGateContextArgsSchema,
  GetSpecArgsSchema,
  GetTicketArgsSchema,
  ListQuestionsArgsSchema,
  MCP_CONTRACT_VERSION,
  MCP_LIMITS,
  PostStageReportArgsSchema,
  SetLabelsArgsSchema,
  UpdateSpecArgsSchema,
  mcpErr,
  mcpOk,
  type McpResult,
} from '@nexus/contracts';
import {
  askQuestion,
  attachArtifactRef,
  checkRateLimit,
  createContext,
  createFlagReader,
  getSpec,
  getGateContextForAgent,
  getTicketForAgent,
  listQuestions,
  logMcpCall,
  postStageReport,
  setAgentLabels,
  updateSpecFromAgent,
  verifyMcpToken,
  type ServiceContext,
} from '@nexus/core';
import { getDb, projects, workItems } from '@nexus/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

export type ToolHandler = (
  args: unknown,
  ctx: ServiceContext,
) => Promise<McpResult<unknown>>;

const TOOL_DESCRIPTIONS: Record<string, string> = {
  get_ticket: `Read ticket core fields, stage, labels, status. Limits: single ticket per call. Always pass ticket_id matching your run token.`,
  get_spec: `Read current spec (or a historical version). Spec size limit ${MCP_LIMITS.specBytes} bytes.`,
  update_spec: `Merge or replace spec content; creates a new version. Optional base_version for conflict detection. Spec ≤ ${MCP_LIMITS.specBytes} bytes.`,
  post_stage_report: `Post the structured stage report exactly once per run. Summary ≤ ${MCP_LIMITS.reportSummaryChars} chars; ≤ ${MCP_LIMITS.labelsPerCall} labels; ≤ ${MCP_LIMITS.artifactRefsPerRun} artifacts. Invalid labels reject the whole call.`,
  set_labels: `Add/remove labels against the project taxonomy (agent-settable only). Max ${MCP_LIMITS.labelsPerCall} per call.`,
  ask_question: `Ask a human a question. blocking:true marks the ticket needs_answer. Text ≤ ${MCP_LIMITS.questionChars} chars.`,
  attach_artifact_ref: `Attach a URL reference (pr/branch/preview/artifact/link). Max ${MCP_LIMITS.artifactRefsPerRun} per run.`,
  get_gate_context: `Recent gate results, open warnings with codes, and pending approvals for this ticket.`,
  list_questions: `List this ticket's questions (most recent ${MCP_LIMITS.listQuestionsLimit}) and any answers.`,
};

function mapCoreError(code: string, message: string): McpResult<never> {
  switch (code) {
    case 'forbidden':
      return mcpErr('forbidden', message);
    case 'not_found':
      return mcpErr('not_found', message);
    case 'stale_version':
      return mcpErr('stale_version', message, { hint: 'Re-read get_spec and retry' });
    case 'validation':
      if (message.toLowerCase().includes('unknown label')) {
        return mcpErr('label_unknown', message);
      }
      if (message.toLowerCase().includes('not agent-settable')) {
        return mcpErr('label_not_agent_settable', message);
      }
      return mcpErr('validation', message);
    case 'conflict':
      return mcpErr('conflict', message);
    default:
      return mcpErr('internal', message);
  }
}

export const toolHandlers: Record<string, ToolHandler> = {
  async get_ticket(args, ctx) {
    const input = GetTicketArgsSchema.parse(args);
    const r = await getTicketForAgent(ctx, input.ticket_id);
    if (!r.ok) return mapCoreError(r.error.code, r.error.message);
    return mcpOk(r.value);
  },

  async get_spec(args, ctx) {
    const input = GetSpecArgsSchema.parse(args);
    if (ctx.actor.kind === 'agent' && ctx.actor.workItemId !== input.ticket_id) {
      return mcpErr('ticket_mismatch', 'ticket_id does not match token scope');
    }
    const r = await getSpec(ctx, input.ticket_id, input.version);
    if (!r.ok) return mapCoreError(r.error.code, r.error.message);
    return mcpOk({
      version: r.value.version,
      content: r.value.content,
      authored_by: r.value.authoredBy,
      note: r.value.note,
      created_at: r.value.createdAt.toISOString(),
    });
  },

  async update_spec(args, ctx) {
    const input = UpdateSpecArgsSchema.parse(args);
    const r = await updateSpecFromAgent(ctx, {
      ticketId: input.ticket_id,
      content: input.content,
      mode: input.mode,
      baseVersion: input.base_version,
      note: input.note,
    });
    if (!r.ok) return mapCoreError(r.error.code, r.error.message);
    return mcpOk(r.value);
  },

  async post_stage_report(args, ctx) {
    const input = PostStageReportArgsSchema.parse(args);
    const r = await postStageReport(ctx, input);
    if (!r.ok) return mapCoreError(r.error.code, r.error.message);
    return mcpOk({
      report_id: r.value.report.id,
      already_posted: r.value.alreadyPosted,
      applied: {
        labels_added: r.value.applied.labelsAdded,
        questions_created: r.value.applied.questionsCreated,
        artifacts: r.value.applied.artifacts,
      },
      rejected: { labels_unknown: [] },
    });
  },

  async set_labels(args, ctx) {
    const input = SetLabelsArgsSchema.parse(args);
    const r = await setAgentLabels(ctx, input.ticket_id, {
      add: input.add,
      remove: input.remove,
    });
    if (!r.ok) return mapCoreError(r.error.code, r.error.message);
    return mcpOk(r.value);
  },

  async ask_question(args, ctx) {
    const input = AskQuestionArgsSchema.parse(args);
    const r = await askQuestion(ctx, {
      ticketId: input.ticket_id,
      text: input.text,
      blocking: input.blocking,
      options: input.options,
    });
    if (!r.ok) return mapCoreError(r.error.code, r.error.message);
    return mcpOk({
      question_id: r.value.question.id,
      ticket_status: r.value.ticketStatusHint,
    });
  },

  async attach_artifact_ref(args, ctx) {
    const input = AttachArtifactRefArgsSchema.parse(args);
    const r = await attachArtifactRef(ctx, {
      ticketId: input.ticket_id,
      kind: input.kind,
      url: input.url,
      title: input.title,
    });
    if (!r.ok) return mapCoreError(r.error.code, r.error.message);
    return mcpOk({ artifact_id: r.value.id });
  },

  async get_gate_context(args, ctx) {
    const input = GetGateContextArgsSchema.parse(args);
    if (ctx.actor.kind === 'agent' && ctx.actor.workItemId !== input.ticket_id) {
      return mcpErr('ticket_mismatch', 'ticket_id does not match token scope');
    }
    const r = await getGateContextForAgent(ctx, input.ticket_id);
    if (!r.ok) return mapCoreError(r.error.code, r.error.message);
    return mcpOk(r.value);
  },

  async list_questions(args, ctx) {
    const input = ListQuestionsArgsSchema.parse(args);
    if (ctx.actor.kind === 'agent' && ctx.actor.workItemId !== input.ticket_id) {
      return mcpErr('ticket_mismatch', 'ticket_id does not match token scope');
    }
    const r = await listQuestions(ctx, input.ticket_id, {
      limit: MCP_LIMITS.listQuestionsLimit,
    });
    if (!r.ok) return mapCoreError(r.error.code, r.error.message);
    return mcpOk({
      questions: r.value.questions.map((q) => ({
        id: q.id,
        text: q.text,
        blocking: q.blocking,
        status: q.status,
        options: q.options,
        answer: q.answer,
        answered_at: q.answeredAt?.toISOString() ?? null,
      })),
      total: r.value.total,
    });
  },
};

export function listToolDefinitions() {
  return Object.keys(toolHandlers).map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name] ?? name,
    inputSchema: toolInputJsonSchema(name),
  }));
}

function toolInputJsonSchema(name: string): Record<string, unknown> {
  const schemas: Record<string, z.ZodType> = {
    get_ticket: GetTicketArgsSchema,
    get_spec: GetSpecArgsSchema,
    update_spec: UpdateSpecArgsSchema,
    post_stage_report: PostStageReportArgsSchema,
    set_labels: SetLabelsArgsSchema,
    ask_question: AskQuestionArgsSchema,
    attach_artifact_ref: AttachArtifactRefArgsSchema,
    get_gate_context: GetGateContextArgsSchema,
    list_questions: ListQuestionsArgsSchema,
  };
  // Minimal JSON Schema for MCP list_tools — zod-to-json not required for agents.
  return {
    type: 'object',
    description: `Arguments for ${name} (${MCP_CONTRACT_VERSION})`,
    properties: {},
    additionalProperties: true,
  };
}

export async function authenticateBearer(
  authorization: string | null,
): Promise<
  | { ok: true; ctx: ServiceContext; tokenId: string; runId: string | null }
  | { ok: false; status: number; body: McpResult<never> }
> {
  if (!authorization?.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      body: mcpErr('unauthorized', 'Bearer token required'),
    };
  }
  const raw = authorization.slice('Bearer '.length).trim();
  const db = getDb();
  const verified = await verifyMcpToken(db, raw);
  if (!verified.ok) {
    return {
      ok: false,
      status: verified.code === 'unauthorized' ? 401 : 403,
      body: mcpErr(verified.code, verified.message),
    };
  }

  const token = verified.token;
  const item = await db.query.workItems.findFirst({
    where: eq(workItems.id, token.workItemId),
  });
  if (!item) {
    return {
      ok: false,
      status: 403,
      body: mcpErr('forbidden', 'Token work item missing'),
    };
  }
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, token.projectId),
  });
  if (!project) {
    return {
      ok: false,
      status: 403,
      body: mcpErr('forbidden', 'Token project missing'),
    };
  }

  if (!(await createFlagReader(db).isEnabled('p2.mcp', token.projectId))) {
    return {
      ok: false,
      status: 403,
      body: mcpErr('forbidden', 'p2.mcp disabled for this project'),
    };
  }

  const rl = await checkRateLimit(`mcp:${token.id}`, 120);
  if (!rl.allowed) {
    return {
      ok: false,
      status: 429,
      body: mcpErr('rate_limited', 'Rate limit exceeded (120/min)', {
        retryable: true,
        hint: `Retry after ${rl.retryAfterSec}s`,
      }),
    };
  }

  if (!token.runId) {
    return {
      ok: false,
      status: 403,
      body: mcpErr('forbidden', 'Token is not bound to a run'),
    };
  }

  const ctx = createContext({
    db,
    orgId: project.orgId,
    actor: {
      kind: 'agent',
      runId: token.runId,
      workItemId: token.workItemId,
    },
    flags: createFlagReader(db),
  });

  return { ok: true, ctx, tokenId: token.id, runId: token.runId };
}

export async function invokeTool(
  name: string,
  args: unknown,
  auth: { ctx: ServiceContext; tokenId: string; runId: string | null },
): Promise<McpResult<unknown>> {
  const handler = toolHandlers[name];
  if (!handler) {
    return mcpErr('not_found', `Unknown tool: ${name}`);
  }

  const started = Date.now();
  const reqBytes = Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8');
  if (reqBytes > 256_000) {
    return mcpErr('payload_too_large', 'Request exceeds 256KB');
  }

  try {
    const result = await handler(args, auth.ctx);
    const resBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    await logMcpCall(auth.ctx.db, {
      tokenId: auth.tokenId,
      runId: auth.runId,
      workItemId:
        auth.ctx.actor.kind === 'agent' ? auth.ctx.actor.workItemId : null,
      tool: name,
      ok: result.ok,
      errorCode: result.ok ? null : result.error.code,
      durationMs: Date.now() - started,
      requestBytes: reqBytes,
      responseBytes: resBytes,
    });
    return result;
  } catch (e) {
    if (e instanceof z.ZodError) {
      const body = mcpErr('validation', e.message);
      await logMcpCall(auth.ctx.db, {
        tokenId: auth.tokenId,
        runId: auth.runId,
        workItemId:
          auth.ctx.actor.kind === 'agent' ? auth.ctx.actor.workItemId : null,
        tool: name,
        ok: false,
        errorCode: 'validation',
        durationMs: Date.now() - started,
        requestBytes: reqBytes,
      });
      return body;
    }
    const message = e instanceof Error ? e.message : String(e);
    await logMcpCall(auth.ctx.db, {
      tokenId: auth.tokenId,
      runId: auth.runId,
      workItemId:
        auth.ctx.actor.kind === 'agent' ? auth.ctx.actor.workItemId : null,
      tool: name,
      ok: false,
      errorCode: 'internal',
      durationMs: Date.now() - started,
      requestBytes: reqBytes,
    });
    return mcpErr('internal', message);
  }
}

export { MCP_CONTRACT_VERSION, TOOL_DESCRIPTIONS };
