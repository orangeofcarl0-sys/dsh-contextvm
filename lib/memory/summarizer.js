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
import { isInjectableContent } from '../core/injectability.js';
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

  // 只摘要**真实内容**：宿主注入的运行时快照 / 技能目录不是对话内容、也没有信息量，
  // 却会把输入撑到上限。真机实测：一个真实内容仅 3,631 字符的会话，摘要输入 60,565 token、
  // 输出 4,800 token 撞 max-tokens → `unparseable_summary`，**长期层因此永远是空的**。
  const events = raw
    .range(episode.sessionId, { fromSeq: start.seq, toSeq: end.seq })
    .filter((e) => isInjectableContent(e.eventType, e.metadata));
  if (events.length === 0) {
    // 纯样板区间没有可摘要的内容：落一条标记，避免它永远停在 pending
    const marker = '（该区间只有宿主注入的环境信息，无对话内容）';
    episodes.setSummary(episode.episodeId, { summary: marker, summaryTokenCount: tokenizer.estimate(marker) });
    return { ok: true, summaryText: marker };
  }
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
