import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MCP_CONTRACT_VERSION } from './version';
import { StageReportSchema } from './stage-report';
import {
  AskQuestionArgsSchema,
  AttachArtifactRefArgsSchema,
  GetGateContextArgsSchema,
  GetSpecArgsSchema,
  GetTicketArgsSchema,
  ListQuestionsArgsSchema,
  MCP_TOOL_NAMES,
  PostStageReportArgsSchema,
  SetLabelsArgsSchema,
  UpdateSpecArgsSchema,
} from './tools';
import { mcpErr, mcpOk } from './envelope';

/**
 * Golden fingerprint of the frozen nexus-mcp/1 surface.
 * If this hash changes, bump the contract version (or add a VERSIONING.md note
 * documenting an additive-only change) before updating the expected value.
 */
const EXPECTED_FINGERPRINT =
  'd3887d71100f69b4489348558072a2a63b90e7751f57c70b93e19c23b754d1d4';

function schemaShape(schema: { _def?: unknown }): unknown {
  return JSON.parse(JSON.stringify(schema._def ?? schema));
}

function fingerprint(): string {
  const payload = JSON.stringify({
    version: MCP_CONTRACT_VERSION,
    tools: MCP_TOOL_NAMES,
    schemas: {
      get_ticket: schemaShape(GetTicketArgsSchema),
      get_spec: schemaShape(GetSpecArgsSchema),
      update_spec: schemaShape(UpdateSpecArgsSchema),
      post_stage_report: schemaShape(PostStageReportArgsSchema),
      set_labels: schemaShape(SetLabelsArgsSchema),
      ask_question: schemaShape(AskQuestionArgsSchema),
      attach_artifact_ref: schemaShape(AttachArtifactRefArgsSchema),
      get_gate_context: schemaShape(GetGateContextArgsSchema),
      list_questions: schemaShape(ListQuestionsArgsSchema),
      stage_report: schemaShape(StageReportSchema),
    },
  });
  return createHash('sha256').update(payload).digest('hex');
}

describe('MCP contract nexus-mcp/1', () => {
  it('exposes exactly nine tools', () => {
    expect(MCP_TOOL_NAMES).toHaveLength(9);
  });

  it('envelope includes contract version', () => {
    expect(mcpOk({ x: 1 }).contract).toBe('nexus-mcp/1');
    expect(mcpErr('validation', 'bad').contract).toBe('nexus-mcp/1');
  });

  it('stage report rejects unknown outcome', () => {
    expect(() =>
      StageReportSchema.parse({
        ticket_id: '00000000-0000-7000-8000-000000000001',
        stage: 'scoping',
        outcome: 'success',
        headline: 'x',
      }),
    ).toThrow();
  });

  it('golden fingerprint is stable (update EXPECTED_FINGERPRINT + version note if intentional)', () => {
    expect(fingerprint()).toBe(EXPECTED_FINGERPRINT);
  });
});
