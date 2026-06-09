/**
 * AI Assistant streaming chat handler (ported from the web app's
 * src/app/api/ai/dashboard-chat/route.ts).
 *
 * Runs the agentic dashboard-generation loop with the Vercel AI SDK and pipes
 * the UI-message SSE stream to an Express response. Identity comes from the
 * backend's JWT auth middleware (req.user.id) rather than a Supabase cookie.
 */

import {
  streamText,
  generateText,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import { getModel } from './provider.mjs';
import { getProviderKeys } from './ai-settings.mjs';
import { getModelDef } from './models.mjs';
import { tools } from './tools.mjs';
import { getSystemPrompt } from './system-prompt.mjs';
import { runWithAuditContext } from './audit-log.mjs';
import { supabaseServer } from './_supabase.mjs';

function firstUserMessageText(messages) {
  for (const m of messages || []) {
    if (m.role !== 'user') continue;
    const parts = m.parts;
    if (Array.isArray(parts)) {
      const text = parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join(' ')
        .trim();
      if (text) return text;
    }
  }
  return null;
}

async function generateThreadTitle(question, titleModel) {
  const fallback = question.slice(0, 60);
  try {
    const { text } = await generateText({
      model: titleModel,
      system:
        "You generate short titles for chat threads. Output 4 words or fewer that summarize the user's question. No quotes, no punctuation, no trailing period. Output only the title.",
      prompt: question,
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    });
    const cleaned = text.trim().replace(/^["'\s]+|["'\s.]+$/g, '');
    return cleaned.length > 0 && cleaned.length <= 80 ? cleaned : fallback;
  } catch (err) {
    console.warn('[ai] title generation failed:', err?.message || err);
    return fallback;
  }
}

/**
 * @param {{ messages: any[], threadId?: string|null, modelId?: string, userId: string|null }} body
 * @param {import('express').Response} res
 */
export async function handleDashboardChat(body, res) {
  const { messages, threadId: incomingThreadId, modelId } = body;
  const userId = body.userId ?? null;
  const userType = body.userType ?? null; // 'admin' | 'producer' | 'contractor'
  const allowedCustomerIds = Array.isArray(body.allowedCustomerIds) ? body.allowedCustomerIds : [];
  const question = firstUserMessageText(messages);

  // App-configured provider credentials (decrypted from ai_provider_keys),
  // falling back to env vars — exactly like the web route. Without this the
  // chat would only ever use the env keys and ignore the "Set in app" key.
  const providerKeys = await getProviderKeys(userId);
  // provider.mjs getModel() expects `azureApiKey`; ai_settings stores it as
  // `copilotApiKey` — bridge the two.
  const modelKeys = { ...providerKeys, azureApiKey: providerKeys.copilotApiKey };
  const def = getModelDef(modelId);
  const haveKey =
    def.provider === 'anthropic'
      ? !!providerKeys.anthropicApiKey
      : def.provider === 'azure'
        ? !!(providerKeys.copilotApiKey && providerKeys.azureResourceName)
        : !!providerKeys.googleApiKey;
  if (!haveKey) {
    throw Object.assign(
      new Error(`No API key configured for ${def.label}. Add it in AI settings or pick another model.`),
      { status: 400 },
    );
  }

  // Ensure a thread exists up front so audit-log + persistence can attribute.
  let threadId = incomingThreadId ?? null;
  if (!threadId && userId) {
    const { data: created, error } = await supabaseServer
      .from('ai_chat_threads')
      .insert({ user_id: userId, messages: [] })
      .select('id')
      .single();
    if (!error && created?.id) threadId = created.id;
  }

  const modelMessages = await convertToModelMessages(messages, { tools });

  const result = streamText({
    model: getModel(modelId, modelKeys),
    system: getSystemPrompt({ userType }),
    messages: modelMessages,
    tools,
    toolChoice: 'auto',
    stopWhen: stepCountIs(30),
    providerOptions: { google: { thinkingConfig: { thinkingBudget: 8192 } } },
    prepareStep: ({ steps, stepNumber }) => {
      const called = new Set();
      for (const step of steps ?? []) {
        for (const call of step?.toolCalls ?? []) {
          if (call?.toolName) called.add(call.toolName);
        }
      }
      const force = (toolName) => {
        console.log(
          `[prepareStep #${stepNumber}] called=[${[...called].join(',')}] -> forcing ${toolName}`,
        );
        return { toolChoice: { type: 'tool', toolName }, activeTools: [toolName] };
      };
      const dashboardCommitted =
        called.has('planDashboard') ||
        called.has('suggestTemplate') ||
        called.has('resolveKpi');
      if (dashboardCommitted && !called.has('generateDashboard')) {
        return force('generateDashboard');
      }
      if (called.has('generateDashboard') && !called.has('generateInsights')) {
        return force('generateInsights');
      }
      if (called.has('generateInsights') && !called.has('suggestFollowUps')) {
        return force('suggestFollowUps');
      }
      return undefined;
    },
    onFinish: async (event) => {
      // Persist per-turn token usage for the Truckast AI usage dashboard /
      // budget enforcement. Fire-and-forget — a failed insert must never break
      // the chat turn. (Ported from the web's dashboard-chat route; without it
      // mobile chats were never counted in the usage panel.)
      try {
        const usage = event?.totalUsage ?? event?.usage;
        const inputTokens = usage?.inputTokens ?? 0;
        const outputTokens = usage?.outputTokens ?? 0;
        const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
        const estimatedCost =
          (inputTokens * (def.inputPricePer1M || 0)) / 1_000_000 +
          (outputTokens * (def.outputPricePer1M || 0)) / 1_000_000;
        void supabaseServer
          .from('ai_token_usage')
          .insert({
            user_id: userId,
            thread_id: threadId,
            model_id: def.id ?? modelId,
            question,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: totalTokens,
            estimated_cost: estimatedCost,
          })
          .then(({ error }) => {
            if (error) console.warn('[ai_token_usage] insert failed:', error.message);
          });
      } catch (err) {
        console.warn('[ai_token_usage] usage capture failed:', err?.message || err);
      }

      // Auto-generate a title on the first exchange.
      if (!threadId || !userId || !question) return;
      try {
        const { data: existing } = await supabaseServer
          .from('ai_chat_threads')
          .select('title')
          .eq('id', threadId)
          .single();
        if (!existing || existing.title) return;
        const title = await generateThreadTitle(question, getModel(undefined, modelKeys));
        await supabaseServer
          .from('ai_chat_threads')
          .update({ title, updated_at: new Date().toISOString() })
          .eq('id', threadId);
      } catch (err) {
        console.warn('[ai] title generation failed:', err?.message || err);
      }
    },
  });

  return runWithAuditContext(
    { userId, threadId, question, customerScope: { userType, customerIds: allowedCustomerIds } },
    async () => {
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        if (threadId) {
          writer.write({ type: 'data-thread-id', data: { threadId } });
        }
        writer.merge(
          result.toUIMessageStream({
            messageMetadata: ({ part }) => {
              if (part.type === 'finish') {
                return {
                  threadId,
                  usage: {
                    inputTokens: part.totalUsage?.inputTokens ?? 0,
                    outputTokens: part.totalUsage?.outputTokens ?? 0,
                    totalTokens: part.totalUsage?.totalTokens ?? 0,
                  },
                };
              }
            },
          }),
        );
      },
    });

    const response = createUIMessageStreamResponse({ stream });

    // Pipe the web ReadableStream (already SSE-formatted) to the Express res.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(Buffer.from(value));
          // Force the compression middleware (if any) to flush each SSE chunk
          // instead of buffering the whole stream.
          if (typeof res.flush === 'function') res.flush();
        }
      }
    } catch (err) {
      console.error('[ai] stream piping error:', err?.message || err);
    } finally {
      res.end();
    }
  });
}

export default handleDashboardChat;
