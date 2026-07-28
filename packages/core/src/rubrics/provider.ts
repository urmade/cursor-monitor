import type { ModelCompletion, ModelProvider } from './prompt';
import type { RubricVerdict } from '@nexus/contracts';

export type { ModelProvider, ModelCompletion };

export type FixtureResponse =
  | { kind: 'verdict'; verdict: RubricVerdict; tokens?: ModelCompletion['tokens'] }
  | { kind: 'malformed'; text: string }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

/**
 * Deterministic fixture provider for tests / CI.
 * Queue responses in order. Empty queue throws — never silently Pass.
 */
export function createFixtureProvider(
  queue: FixtureResponse[] = [],
): ModelProvider & { queue: FixtureResponse[]; push: (r: FixtureResponse) => void } {
  const q = [...queue];
  const provider: ModelProvider & {
    queue: FixtureResponse[];
    push: (r: FixtureResponse) => void;
  } = {
    name: 'fixture',
    queue: q,
    push(r) {
      q.push(r);
    },
    async complete(input) {
      if (input.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      const next = q.shift();
      if (!next) {
        throw new Error(
          'fixture provider queue empty — enqueue responses explicitly',
        );
      }
      if (next.kind === 'timeout') {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (next.kind === 'error') {
        throw new Error(next.message);
      }
      if (next.kind === 'malformed') {
        return { text: next.text, tokens: { input: 10, output: 5, total: 15 } };
      }
      return {
        text: JSON.stringify(next.verdict),
        tokens: next.tokens ?? { input: 100, output: 50, total: 150 },
        raw: next.verdict,
      };
    },
  };
  return provider;
}

/**
 * OpenAI-compatible chat completions (temperature 0, JSON object).
 * Uses NEXUS_LLM_API_KEY / OPENAI_API_KEY and optional NEXUS_LLM_BASE_URL.
 */
export function createOpenAiCompatibleProvider(): ModelProvider | null {
  const apiKey =
    process.env.NEXUS_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
  if (!apiKey) return null;
  const baseUrl = (
    process.env.NEXUS_LLM_BASE_URL ?? 'https://api.openai.com/v1'
  ).replace(/\/$/, '');

  return {
    name: 'openai_compatible',
    async complete(input) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: input.model,
          temperature: input.temperature,
          max_tokens: input.maxOutputTokens,
          response_format: { type: 'json_object' },
          messages: input.messages,
        }),
        signal: input.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };
      const text = json.choices?.[0]?.message?.content ?? '';
      return {
        text,
        tokens: {
          input: json.usage?.prompt_tokens,
          output: json.usage?.completion_tokens,
          total: json.usage?.total_tokens,
        },
        raw: json,
      };
    },
  };
}

let overrideProvider: ModelProvider | null = null;

/** Test hook — inject a provider for the process. */
export function setModelProviderForTests(provider: ModelProvider | null): void {
  overrideProvider = provider;
}

export function resolveModelProvider(): ModelProvider {
  if (overrideProvider) return overrideProvider;
  if (process.env.NEXUS_LLM_FIXTURE === '1') {
    return createFixtureProvider();
  }
  const live = createOpenAiCompatibleProvider();
  if (live) return live;
  // No key: return a provider that always fails soft — caller maps to Warn.
  return {
    name: 'unavailable',
    async complete() {
      throw new Error('provider_unavailable');
    },
  };
}
