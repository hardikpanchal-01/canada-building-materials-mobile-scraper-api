/** Suggest a fix when a widget returns 0 rows (ported from /api/ai/empty-hint). */
import { generateText } from 'ai';
import { getModel } from './provider.mjs';
import { getProviderKeys } from './ai-settings.mjs';

export async function emptyHint(body = {}, userId) {
  if (!body.widgetTitle || !body.query?.table) {
    throw Object.assign(new Error('widgetTitle and query.table required'), { status: 400 });
  }
  const keys = await getProviderKeys(userId);
  const model = getModel(undefined, keys);
  const { text } = await generateText({
    model,
    system:
      'You help users when their dashboard widget query returns no data. Given the widget\'s intent and filters, suggest the SINGLE most likely fix in one sentence (≤22 words). Reference the specific filter to relax. No greetings, no markdown, no quotes.',
    prompt: [
      body.originalQuestion ? `User asked: "${body.originalQuestion}"` : null,
      `Widget: "${body.widgetTitle}" (${body.query.table})`,
      body.query.filters && body.query.filters.length > 0
        ? `Filters: ${JSON.stringify(body.query.filters)}`
        : 'No filters.',
      body.aggregate
        ? `Aggregate: ${body.aggregate.method}${body.aggregate.valueColumn ? `(${body.aggregate.valueColumn})` : ''}${body.aggregate.groupBy ? ` grouped by ${body.aggregate.groupBy}` : ''}`
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
    providerOptions: { google: { thinkingConfig: { thinkingBudget: 256 } } },
  });
  return { hint: text.trim() };
}
