/**
 * Global Worker（§11.2 / §12 / §20.3）。
 *
 * worker 的输出 MUST 结构化且短：默认 hard cap 300 token（复杂任务 500）。
 * 本模块只负责"跑一个 chunk 并校验其输出"，编排（并发、覆盖校验、归并）
 * 在 lib/global_scan/scanner.js。
 *
 * @module dsh-contextvm/global_scan/worker
 */
import { WORKER_SYSTEM, workerUserMessage } from '../llm/prompts.js';
import { validateWorkerResult, parseJsonLoose } from '../llm/schemas.js';

/**
 * @param {{
 *   chunk: {index: number, startEventId: string, endEventId: string, eventIds: string[]},
 *   raw: import('../storage/raw_events.js').RawEventStore,
 *   query: string,
 *   llmClient: import('../llm/client.js').LlmClient,
 *   maxTokens: number,
 *   signal?: AbortSignal,
 * }} p
 * @returns {Promise<{ok: boolean, result?: object, reason?: string}>}
 */
export async function runWorker(p) {
  const events = p.raw.getMany(p.chunk.eventIds).filter(Boolean);
  if (events.length === 0) return { ok: false, reason: 'chunk_empty' };

  let res;
  try {
    res = await p.llmClient.call({
      purpose: 'global_worker',
      system: WORKER_SYSTEM,
      messages: workerUserMessage({
        query: p.query,
        events: events.map((e) => ({ eventId: e.eventId, eventType: e.eventType, content: e.content })),
      }),
      maxTokens: p.maxTokens,
      temperature: 0,
      signal: p.signal,
    });
  } catch (err) {
    return { ok: false, reason: `llm_failed:${String(err?.message ?? err).slice(0, 160)}` };
  }

  const parsed = parseJsonLoose(res.text);
  if (!parsed.value) return { ok: false, reason: 'unparseable_worker_result' };

  const v = validateWorkerResult(parsed.value);
  if (!v.ok) return { ok: false, reason: `invalid_worker_result:${v.errors.join(',')}` };

  // source_event_ids 必须落在本片段内（§11.2；跨片段引用即幻觉）
  const allowed = new Set(p.chunk.eventIds);
  const foreign = v.result.findings.flatMap((f) => f.sourceEventIds.filter((id) => !allowed.has(id)));
  if (foreign.length > 0) {
    return { ok: false, reason: `source_out_of_chunk:${foreign.slice(0, 3).join(',')}` };
  }
  return { ok: true, result: v.result };
}
