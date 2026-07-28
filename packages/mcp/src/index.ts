import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { MCP_CONTRACT_VERSION } from '@nexus/contracts';
import { z } from 'zod';
import {
  authenticateBearer,
  invokeTool,
  listToolDefinitions,
  toolHandlers,
} from './tools';

/** Register all nine nexus-mcp/1 tools on an MCP server instance. */
export function registerNexusTools(
  server: McpServer,
  auth: {
    ctx: import('@nexus/core').ServiceContext;
    tokenId: string;
    runId: string | null;
  },
): void {
  for (const name of Object.keys(toolHandlers)) {
    const description = listToolDefinitions().find((t) => t.name === name)
      ?.description;
    // SDK generics are strict around zod shapes; cast registration for our
    // envelope-returning handlers (args are re-validated in invokeTool).
    (server.registerTool as (n: string, c: object, h: (a: Record<string, unknown>) => Promise<unknown>) => void)(
      name,
      {
        title: name,
        description,
        // Passthrough — tool handlers re-validate with the frozen contract schemas.
        inputSchema: z.object({}).passthrough(),
      },
      async (args) => {
        const result = await invokeTool(name, args, auth);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: !result.ok,
        };
      },
    );
  }
}

/**
 * Handle a stateless streamable-HTTP MCP request (Next.js App Router).
 * Auth via Bearer run token; tools return nexus-mcp/1 envelopes as text+structured.
 */
export async function handleMcpHttpRequest(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json({
      ok: true,
      transport: 'streamable-http',
      stateless: true,
      contract: MCP_CONTRACT_VERSION,
      tools: listToolDefinitions().map((t) => t.name),
    });
  }

  if (req.method === 'DELETE') {
    return new Response(null, { status: 405 });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const auth = await authenticateBearer(req.headers.get('authorization'));
  if (!auth.ok) {
    return Response.json(auth.body, { status: auth.status });
  }

  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const cloned = req.clone();
    let body: unknown;
    try {
      body = await cloned.json();
    } catch {
      body = null;
    }
    if (body && typeof body === 'object' && 'method' in body) {
      const method = (body as { method: string }).method;
      const id = (body as { id?: unknown }).id ?? null;

      if (method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'nexus', version: MCP_CONTRACT_VERSION },
          },
        });
      }

      if (method === 'notifications/initialized' || method === 'ping') {
        return Response.json({ jsonrpc: '2.0', id, result: {} });
      }

      if (method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            tools: listToolDefinitions().map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        });
      }

      if (method === 'tools/call') {
        const params = (
          body as { params?: { name?: string; arguments?: unknown } }
        ).params;
        const name = params?.name;
        if (!name) {
          return Response.json({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Missing tool name' },
          });
        }
        const result = await invokeTool(name, params?.arguments ?? {}, auth);
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            isError: !result.ok,
          },
        });
      }
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = new McpServer({
    name: 'nexus',
    version: MCP_CONTRACT_VERSION,
  });
  registerNexusTools(server, auth);
  await server.connect(transport);
  return transport.handleRequest(req);
}

export {
  authenticateBearer,
  invokeTool,
  listToolDefinitions,
  toolHandlers,
} from './tools';
