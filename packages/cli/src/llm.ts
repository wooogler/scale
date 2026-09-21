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
import { agentViewerBase } from './serve-state.js';

/** Thrown when the selected provider has no key in env or the key file. */
export class MissingKeyError extends Error {
  readonly provider: LlmProvider;
  constructor(provider: LlmProvider) {
    // Name both routes that do not require a terminal: the chat command, and
    // the viewer's own URL (read from the state file — sync, no probe, and a
    // default when nothing is recorded). "Add it in the map viewer" without a
    // URL is an instruction the reader cannot follow.
    // `agentViewerBase`: the recorded URL without its `?token=`, because this
    // message is surfaced to Claude and into the transcript.
    const viewer = agentViewerBase();
    super(
      `no API key for ${provider}. Set ${
        provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
      }, or add one with /scale-settings in chat, or in the map viewer at ` +
        `${viewer} (⚙ API key).`,
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
  /**
   * Wall-clock ceiling for this one request, in ms. The OpenAI path applies it
   * through `AbortSignal.timeout`; the Anthropic path passes it as the SDK's
   * per-request `timeout` option. Absent, each branch keeps its own default —
   * {@link OPENAI_TIMEOUT_MS} for OpenAI, the SDK's for Anthropic.
   *
   * It is per-request because the jobs are not the same size: a quiz item is a
   * few hundred tokens and must fail fast on the detached quest path, while
   * translating a whole component doc is thousands of tokens and a 60 s ceiling
   * would abort the work that was going to succeed.
   */
  timeoutMs?: number;
}

/**
 * Default wall-clock ceiling for the OpenAI request. Callers on the detached
 * quest path treat any throw as "fall back to deterministic items", so a bounded
 * failure is always better than an unbounded wait.
 */
const OPENAI_TIMEOUT_MS = 60_000;

/** One chat completion → plain text. Throws MissingKeyError / provider errors. */
export async function chatText(req: ChatRequest): Promise<string> {
  const apiKey = resolveKey(req.provider);
  if (!apiKey) throw new MissingKeyError(req.provider);
  const maxTokens = req.maxTokens ?? 1024;
  const timeoutMs = req.timeoutMs ?? OPENAI_TIMEOUT_MS;

  if (req.provider === 'openai') {
    // The Anthropic branch below inherits the SDK's timeout and retries; this
    // hand-rolled fetch had neither, so a hung connection left `quest generate`
    // — which runs DETACHED off SessionEnd — alive indefinitely with no quests
    // and nobody watching. A bounded failure that falls back beats a live
    // process that never finishes.
    let res: Response;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        signal: AbortSignal.timeout(timeoutMs),
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
    } catch (err) {
      // AbortSignal.timeout rejects with a TimeoutError DOMException; anything
      // else here is a transport failure. Either way, name it plainly.
      const why = (err as Error)?.name === 'TimeoutError'
        ? `no response in ${timeoutMs / 1000}s`
        : ((err as Error)?.message ?? 'network error');
      throw new Error(`openai request failed: ${why}`);
    }
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
  const params = {
    model: req.model,
    max_tokens: maxTokens,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  // The per-request `timeout` option is passed ONLY when the caller set one.
  // The SDK's own default is a sensible ceiling for a quiz item; a doc
  // translation is thousands of tokens and asks for its own. Passing the
  // option unconditionally would mean handing the SDK a number this module
  // invented, rather than inheriting the default it was built with.
  const msg =
    req.timeoutMs !== undefined
      ? await client.messages.create(params, { timeout: req.timeoutMs })
      : await client.messages.create(params);
  return msg.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}
