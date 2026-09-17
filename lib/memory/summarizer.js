/**
 * Episode 摘要生成（§6.2 / §6.3 / §20.1 / §22.2）。
 *
 * 纪律：
 *   - 摘要**不是**真相源，失败 MUST NOT 影响原始事件（§22.2）；
 *   - 输出必须过 validateEpisodeSummary（§27.3）；
 *   - 摘要可引用 state id，但不重复全文（§6.3）。
 *
 * @module dsh-contextvm/memory/summarizer
 */
import { EPISODE_SYSTEM, episodeUserMessage } from '../llm/prompts.js';
import { validateEpisodeSummary, renderEpisodeSummary, parseJsonLoose } from '../llm/schemas.js';

/**
 * 为一段 episode 生成并保存摘要。
 *
 * @param {{
 *   episode: object,
 *   raw: import('../storage/raw_events.js').RawEventStore,
 *   episodes: import('../storage/episodes.js').EpisodeStore,
 *   llmClient: import('../llm/client.js').LlmClient,
 *   tokenizer: import('../core/tokenization.js').Tokenizer,
 *   budgets: object,
 *   signal?: AbortSignal,
 * }} p
 * @returns {Promise<{ok: boolean, summaryText?: string, reason?: string}>}
 */
export async function summarizeEpisode(p) {
  const { episode, raw, episodes, llmClient, tokenizer, budgets } = p;

  const start = raw.get(episode.startEventId);
  const end = raw.get(episode.endEventId);
  if (!start || !end) return { ok: false, reason: 'episode_boundary_events_missing' };

  const events = raw.range(episode.sessionId, { fromSeq: start.seq, toSeq: end.seq });
  // 输入按 §6.1 的上限裁剪（从尾部保留，因为尾部含结论）
  let toSend = events;
  let text = toSend.map((e) => e.content).join('\n');
  while (tokenizer.estimate(text) > budgets.episode.maxRaw && toSend.length > 4) {
    toSend = toSend.slice(1);
    text = toSend.map((e) => e.content).join('\n');
  }

  let res;
  try {
    res = await llmClient.call({
      purpose: 'episode_summary',
      system: EPISODE_SYSTEM,
      messages: episodeUserMessage({
        events: toSend.map((e) => ({ eventId: e.eventId, eventType: e.eventType, content: e.content })),
      }),
      maxTokens: budgets.episode.summaryHardMaxTokens,
      temperature: 0,
      signal: p.signal,
    });
  } catch (err) {
    // §22.2：保持 summary_pending，不阻塞新 episode
    return { ok: false, reason: `llm_failed:${String(err?.message ?? err).slice(0, 200)}` };
  }

  const parsed = parseJsonLoose(res.text);
  if (!parsed.value) return { ok: false, reason: 'unparseable_summary' };

  const v = validateEpisodeSummary(parsed.value);
  if (!v.ok) return { ok: false, reason: `invalid_summary:${v.errors.join(',')}` };

  const summaryText = renderEpisodeSummary(v.summary);
  episodes.setSummary(episode.episodeId, {
    summary: summaryText,
    summaryTokenCount: tokenizer.estimate(summaryText),
  });
  return { ok: true, summaryText };
}
