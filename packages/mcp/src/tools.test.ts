import { describe, expect, it } from 'vitest';
import {
  mcpErr,
  mcpOk,
  MCP_TOOL_NAMES,
  StageReportSchema,
  PostStageReportArgsSchema,
} from '@nexus/contracts';
import { listToolDefinitions, toolHandlers } from './tools';

describe('MCP tool registry', () => {
  it('registers all nine contract tools', () => {
    expect(Object.keys(toolHandlers).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(listToolDefinitions()).toHaveLength(9);
  });

  it('stage report schema matches post_stage_report args', () => {
    const sample = {
      ticket_id: '00000000-0000-7000-8000-000000000001',
      stage: 'intake',
      outcome: 'complete' as const,
      headline: 'Drafted initial scope',
      summary: 'Enough to proceed',
      assumptions: ['Users export their own data'],
      not_verified: ['Retention policy'],
      questions: [],
      labels_to_set: [],
      acceptance_criteria: ['CSV download works'],
      artifact_refs: [],
    };
    expect(StageReportSchema.parse(sample).headline).toBe(sample.headline);
    expect(PostStageReportArgsSchema.parse(sample).outcome).toBe('complete');
  });

  it('envelope helpers tag nexus-mcp/1', () => {
    expect(mcpOk({ a: 1 })).toEqual({
      ok: true,
      contract: 'nexus-mcp/1',
      data: { a: 1 },
    });
    const err = mcpErr('label_unknown', 'Unknown label(s): x');
    expect(err.ok).toBe(false);
    if (!err.ok) {
      expect(err.error.code).toBe('label_unknown');
      expect(err.contract).toBe('nexus-mcp/1');
    }
  });
});
