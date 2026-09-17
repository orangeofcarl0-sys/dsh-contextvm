/**
 * 测试公共设施。所有测试使用内存库与假端口，不依赖 DSH 宿主。
 * @module tests/helpers
 */
import { openDb } from '../lib/storage/sqlite.js';
import { Tokenizer } from '../lib/core/tokenization.js';
import { RawEventStore } from '../lib/storage/raw_events.js';
import { StateStore } from '../lib/storage/state_store.js';

/**
 * 新建一套内存后端。
 * @returns {{db, tokenizer, raw, state, close: () => void}}
 */
export function makeBackend() {
  const db = openDb(':memory:');
  const tokenizer = new Tokenizer();
  const raw = new RawEventStore(db, tokenizer);
  const state = new StateStore(db);
  return { db, tokenizer, raw, state, close: () => db.close() };
}

/**
 * 假 llm 端口：按脚本返回响应，并记录调用。
 * 与真实端口（lib/host/seams.js 的 llm 适配）签名一致 —— 单一契约。
 * @param {Array<{text?: string, toolCalls?: Array<{name: string, args: object}>, usage?: object}>} script
 */
export function fakeLlm(script = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    /** @type {import('../lib/host/ports.js').LlmPort['complete']} */
    async complete(req) {
      calls.push(req);
      const step = script[Math.min(i, script.length - 1)] ?? { text: '' };
      i += 1;
      return {
        text: step.text ?? '',
        toolCalls: step.toolCalls ?? [],
        usage: step.usage ?? { input_tokens: 0, output_tokens: 0 },
        stopReason: step.stopReason ?? 'end_turn',
      };
    },
  };
}

/**
 * 假 sessionLog 端口：内存事件列表。
 */
export function fakeSessionLog() {
  /** @type {Array<object>} */
  const events = [];
  return {
    events,
    async read() {
      return events.map((e) => ({ ...e }));
    },
    push(e) {
      events.push(e);
    },
  };
}

/** 造一条 user/assistant 交替的合成历史。 */
export function synthHistory({ turns = 10, filler = 'filler words here', facts = [] } = {}) {
  const out = [];
  for (let i = 0; i < turns; i += 1) {
    out.push({ role: 'user', eventType: 'user_message', content: `请求 ${i}：${filler}` });
    out.push({ role: 'assistant', eventType: 'assistant_message', content: `回答 ${i}：${filler}` });
  }
  for (const f of facts) out.push({ role: 'user', eventType: 'user_message', content: f });
  return out;
}
