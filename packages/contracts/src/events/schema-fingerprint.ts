import type { z } from 'zod';

/** Stable structural fingerprint for catalogue freeze tests (not runtime validation). */
export function zodSchemaFingerprint(schema: z.ZodTypeAny): string {
  return JSON.stringify(zodTypeToJson(schema));
}

function zodTypeToJson(schema: z.ZodTypeAny): unknown {
  const def = schema._def as {
    typeName?: string;
    type?: z.ZodTypeAny;
    innerType?: z.ZodTypeAny;
    schema?: z.ZodTypeAny;
    value?: unknown;
    values?: unknown[];
    options?: z.ZodTypeAny[];
    shape?: () => Record<string, z.ZodTypeAny>;
    keyType?: z.ZodTypeAny;
    valueType?: z.ZodTypeAny;
    left?: z.ZodTypeAny;
    right?: z.ZodTypeAny;
    items?: z.ZodTypeAny[];
  };

  switch (def.typeName) {
    case 'ZodString':
      return { t: 'string' };
    case 'ZodNumber':
      return { t: 'number' };
    case 'ZodBoolean':
      return { t: 'boolean' };
    case 'ZodNull':
      return { t: 'null' };
    case 'ZodUndefined':
      return { t: 'undefined' };
    case 'ZodLiteral':
      return { t: 'literal', v: def.value };
    case 'ZodEnum':
      return { t: 'enum', v: def.values };
    case 'ZodNativeEnum':
      return { t: 'native_enum', v: def.values };
    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(shape)) {
        props[k] = zodTypeToJson(v);
      }
      return { t: 'object', props };
    }
    case 'ZodArray':
      return { t: 'array', item: def.type ? zodTypeToJson(def.type) : null };
    case 'ZodOptional':
      return { t: 'optional', inner: def.innerType ? zodTypeToJson(def.innerType) : null };
    case 'ZodNullable':
      return { t: 'nullable', inner: def.innerType ? zodTypeToJson(def.innerType) : null };
    case 'ZodDefault':
      return { t: 'default', inner: def.innerType ? zodTypeToJson(def.innerType) : null };
    case 'ZodUnion':
      return {
        t: 'union',
        options: (def.options ?? []).map((o) => zodTypeToJson(o)),
      };
    case 'ZodDiscriminatedUnion':
      return {
        t: 'discriminated_union',
        options: (def.options ?? []).map((o) => zodTypeToJson(o)),
      };
    case 'ZodIntersection':
      return {
        t: 'intersection',
        left: def.left ? zodTypeToJson(def.left) : null,
        right: def.right ? zodTypeToJson(def.right) : null,
      };
    case 'ZodRecord':
      return {
        t: 'record',
        key: def.keyType ? zodTypeToJson(def.keyType) : null,
        value: def.valueType ? zodTypeToJson(def.valueType) : null,
      };
    case 'ZodTuple':
      return { t: 'tuple', items: (def.items ?? []).map((i) => zodTypeToJson(i)) };
    case 'ZodEffects':
      return def.schema ? zodTypeToJson(def.schema) : { t: 'effects' };
    case 'ZodLazy':
      return { t: 'lazy' };
    default:
      return { t: def.typeName ?? 'unknown' };
  }
}
