/**
 * Provider-agnostic chat for the INTERVENTION tier (quest generation + the web
 * socratic proxy).
 *
 * Two backends, one call shape:
 *  - **anthropic** — the official `@anthropic-ai/sdk` (Messages API).
 *  - **openai** — a direct `fetch` to `/v1/chat/completions`. Deliberately not
 *    the OpenAI SDK: this is one well-defined REST call, and the plugin ships as
 *    a single esbuild bundle where an extra SDK is pure weight.
 *
 * Model policy is unchanged: this module is INTERVENTION-only (cheap, repeated).
 * The BUILD tier stays Claude Opus/Fable and never routes through here.
 *
 * The API key comes from {@link resolveKey} (env var first, then the 0600
 * `~/.scale/keys.json`). A missing key throws {@link MissingKeyError} so callers
 * can degrade precisely — quest generation falls back to deterministic items,
 * the socratic proxy returns a clear, actionable error to the browser.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider } from '@scale/core';
import { resolveKey } from './keys.js';

/** Thrown when the selected provider has no key in env or the key file. */
export class MissingKeyError extends Error {
  readonly provider: LlmProvider;
  constructor(provider: LlmProvider) {
    super(
      `no API key for ${provider}. Set ${
        provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
      }, or add one in the map viewer (⚙ API key).`,
    );
    this.name = 'MissingKeyError';
    this.provider = provider;
  }
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  provider: LlmProvider;
  model: string;
  system: string;
  messages: ChatTurn[];
  maxTokens?: number;
}

/** One chat completion → plain text. Throws MissingKeyError / provider errors. */
export async function chatText(req: ChatRequest): Promise<string> {
  const apiKey = resolveKey(req.provider);
  if (!apiKey) throw new MissingKeyError(req.provider);
  const maxTokens = req.maxTokens ?? 1024;

  if (req.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: req.system },
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
    });
    if (!res.ok) {
      // Surface status + a short body slice; never echo the key.
      const body = await res.text().catch(() => '');
      throw new Error(`openai ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = json.choices?.[0];
    const content = (choice?.message?.content ?? '').trim();
    // A reasoning model (o-series, gpt-5) spends max_completion_tokens on hidden
    // reasoning first and can return NOTHING with finish_reason 'length'. Failing
    // loudly beats degrading to a canned tutor line the learner can't explain.
    if (!content && choice?.finish_reason === 'length') {
      throw new Error(
        `openai model "${req.model}" returned no text: the token budget was consumed before ` +
          'any output (typical of reasoning models). Pick a non-reasoning model in Settings.',
      );
    }
    return content;
  }

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: req.model,
    max_tokens: maxTokens,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return msg.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}
