import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

let cached: Record<string, unknown> | null = null;

const bearerAuth = {
  type: 'http' as const,
  scheme: 'bearer',
  bearerFormat: 'nxpat_',
  description: 'Project-scoped API token',
};

function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'bearerAuth', bearerAuth);

  const ProblemSchema = registry.register(
    'Problem',
    z.object({
      type: z.string().optional(),
      title: z.string(),
      status: z.number().int(),
      detail: z.string().optional(),
      instance: z.string().optional(),
      request_id: z.string().optional(),
    }),
  );

  const WorkItemSchema = registry.register(
    'WorkItem',
    z.object({
      id: z.string().uuid(),
      key: z.string(),
      title: z.string(),
      complexity: z.union([z.string(), z.null()]).optional(),
      currentStageId: z.string().uuid(),
      version: z.number().int(),
    }),
  );

  const secured = { security: [{ bearerAuth: [] }] };

  registry.registerPath({
    method: 'get',
    path: '/api/v1/openapi.json',
    summary: 'OpenAPI document',
    responses: {
      200: { description: 'OpenAPI 3.1 document' },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/projects',
    summary: 'List projects visible to the token',
    ...secured,
    responses: {
      200: {
        description: 'Projects',
        content: {
          'application/json': {
            schema: z.object({
              projects: z.array(
                z.object({
                  id: z.string().uuid(),
                  key: z.string(),
                  name: z.string(),
                }),
              ),
            }),
          },
        },
      },
      403: {
        description: 'Missing scope',
        content: { 'application/json': { schema: ProblemSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/projects/{projectKey}',
    summary: 'Get project by key',
    ...secured,
    request: { params: z.object({ projectKey: z.string() }) },
    responses: {
      200: {
        description: 'Project',
        content: {
          'application/json': {
            schema: z.object({
              id: z.string().uuid(),
              key: z.string(),
              name: z.string(),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/projects/{projectKey}/stages',
    summary: 'List pipeline stages',
    ...secured,
    request: { params: z.object({ projectKey: z.string() }) },
    responses: {
      200: {
        description: 'Stages',
        content: {
          'application/json': {
            schema: z.object({
              stages: z.array(
                z.object({
                  id: z.string().uuid(),
                  key: z.string(),
                  name: z.string(),
                  position: z.number().int(),
                }),
              ),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/projects/{projectKey}/work-items',
    summary: 'List work items (paginated)',
    ...secured,
    request: {
      params: z.object({ projectKey: z.string() }),
      query: z.object({
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Work items',
        content: {
          'application/json': {
            schema: z.object({
              work_items: z.array(WorkItemSchema),
              pagination: z.object({
                limit: z.number().int(),
                offset: z.number().int(),
                total: z.number().int(),
              }),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/projects/{projectKey}/work-items',
    summary: 'Create work item',
    ...secured,
    request: {
      params: z.object({ projectKey: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              title: z.string(),
              description: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Created',
        content: { 'application/json': { schema: WorkItemSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/work-items/{itemKey}',
    summary: 'Get work item',
    ...secured,
    request: { params: z.object({ itemKey: z.string() }) },
    responses: {
      200: {
        description: 'Work item',
        content: { 'application/json': { schema: WorkItemSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/work-items/{itemKey}',
    summary: 'Update work item',
    ...secured,
    request: {
      params: z.object({ itemKey: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              title: z.string().optional(),
              description: z.string().optional(),
              complexity: z.enum(['low', 'medium', 'high']).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Updated',
        content: { 'application/json': { schema: WorkItemSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/work-items/{itemKey}/transition',
    summary: 'Transition work item to a stage',
    ...secured,
    request: {
      params: z.object({ itemKey: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              to_stage: z.string(),
              reason_code: z.string().optional(),
              note: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Transitioned',
        content: { 'application/json': { schema: WorkItemSchema } },
      },
      409: {
        description: 'Gate or budget blocked',
        content: {
          'application/json': {
            schema: ProblemSchema.extend({ blocking: z.unknown().optional() }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/work-items/{itemKey}/runs',
    summary: 'Launch a run for the work item',
    ...secured,
    request: { params: z.object({ itemKey: z.string() }) },
    responses: {
      201: {
        description: 'Run launched',
        content: {
          'application/json': {
            schema: z.object({
              run: z.object({ id: z.string().uuid() }).passthrough(),
            }),
          },
        },
      },
    },
  });

  return registry;
}

export function getOpenApiV1Document(): Record<string, unknown> {
  if (cached) return cached;
  const generator = new OpenApiGeneratorV3(buildRegistry().definitions);
  const doc = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Nexus API',
      version: '1.0.0',
      description:
        'Public REST API v1 (zod-generated). PoC scope: project/work-item/run surfaces; webhooks/gates/attention HTTP routes are UI-only until a later phase.',
    },
    servers: [{ url: '/' }],
  }) as unknown as Record<string, unknown>;
  doc.security = [{ bearerAuth: [] }];
  cached = doc;
  return cached;
}

/** @internal tests */
export function resetOpenApiV1Cache(): void {
  cached = null;
}
