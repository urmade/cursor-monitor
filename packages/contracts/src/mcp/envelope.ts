import { z } from 'zod';
import { MCP_CONTRACT_VERSION } from './version';

export const McpErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'ticket_mismatch',
  'not_found',
  'validation',
  'conflict',
  'already_posted',
  'rate_limited',
  'payload_too_large',
  'label_unknown',
  'label_not_agent_settable',
  'stale_version',
  'internal',
]);

export type McpErrorCode = z.infer<typeof McpErrorCodeSchema>;

export const McpErrorSchema = z.object({
  code: McpErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().default(false),
  hint: z.string().optional(),
});

export type McpError = z.infer<typeof McpErrorSchema>;

export function mcpOk<T>(data: T) {
  return {
    ok: true as const,
    contract: MCP_CONTRACT_VERSION,
    data,
  };
}

export function mcpErr(
  code: McpErrorCode,
  message: string,
  opts?: { retryable?: boolean; hint?: string },
) {
  return {
    ok: false as const,
    contract: MCP_CONTRACT_VERSION,
    error: {
      code,
      message,
      retryable: opts?.retryable ?? false,
      ...(opts?.hint ? { hint: opts.hint } : {}),
    },
  };
}

export type McpOk<T> = ReturnType<typeof mcpOk<T>>;
export type McpErr = ReturnType<typeof mcpErr>;
export type McpResult<T> = McpOk<T> | McpErr;
