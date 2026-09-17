/**
 * 两个"上下文被压死"的真机缺陷回归。
 *
 * 长跑实测（CDDA 复刻，sessionMode=active）暴露的：注入中位 1,459 token 并不小，
 * 但 agent 的记忆层几乎是空的 —— 因为
 *   1) **工具活动一条都没进记忆**（整个库 0 条 tool 事件）：`tool/result` 的负载在
 *      `data.message`，我们按 `data.content` 读 → 空 → 镜像跳过；
 *   2) **长期层（episode 摘要）永远为空**：摘要输入把宿主样板也算进去，实测一个真实内容
 *      仅 3,631 字符的会话，摘要输入 60,565 token、输出 4,800 token 撞 max-tokens
 *      → unparseable_summary。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextVm } from '../lib/app/create.js';
import { mapSessionEvent } from '../lib/host/seams.js';
import { setSessionActive } from '../lib/app/session_mode.js';

const S = 'sess-tools-summary';
const W = 262144;

test('tool/result：负载在 data.message（不是 data.content）—— 否则工具活动全部丢失', () => {
  const event = {
    type: 'tool/result',
    seq: 42,
    data: {
      turn: 1,
      step: 2,
      message: {
        role: 'tool',
        // 权威形状：块类型是 'tool-result'（连字符），正文在嵌套 content 里
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '测试输出：Ran 14 tests — OK' }] }],
      },
    },
  };
  const mapped = mapSessionEvent(event);
  assert.ok(mapped, 'tool/result 必须被映射');
  assert.equal(mapped.eventType, 'tool_result');
  assert.ok(
    mapped.content.includes('Ran 14 tests'),
    `工具结果内容必须被取出，实际：${JSON.stringify(mapped.content)}`,
  );

  // 阳性对照：旧写法（只给 data.content）取不到任何东西 —— 说明这个字段位置是关键
  const wrongShape = { type: 'tool/result', seq: 43, data: { turn: 1, step: 2, content: [{ type: 'text', text: 'x' }] } };
  assert.equal(mapSessionEvent(wrongShape).content, '', '负载不在 data.content，按旧写法必为空');

  // 反向对照：块类型写成下划线（我们曾经的错法）→ 取不到正文
  const wrongBlock = {
    type: 'tool/result', seq: 44,
    data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'y' }] }] } },
  };
  assert.equal(
    mapSessionEvent(wrongBlock).content, '',
    '块类型必须是 tool-result（连字符）；写成 tool_result 会静默取到空',
  );
});

test('摘要输入：MUST NOT 把宿主样板喂给摘要器（真机缺陷回归）', async () => {
  const calls = [];
  const llm = {
    async complete(req) {
      calls.push(req);
      return { text: '{}', toolCalls: [], usage: null, stopReason: { kind: 'stop' } };
    },
  };
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm });
  vm.runtime.setWindow(S, W);
  setSessionActive(vm.db, S, true);
  try {
    vm.raw.append({ sessionId: S, role: 'user', eventType: 'user_message', content: '真实问题：负坐标怎么算' });
    vm.raw.append({ sessionId: S, role: 'assistant', eventType: 'assistant_message', content: '真实回答：用 floor 除法' });
    // 宿主样板：又多又大（真机上单个快照可达数千 token）
    for (let i = 0; i < 6; i += 1) {
      vm.raw.append({
        sessionId: S, role: 'system', eventType: 'system_note',
        content: `Current runtime context. ${'样板内容'.repeat(200)}`,
        metadata: { sourceKind: 'plugin', contextForm: 'snapshot' },
      });
    }

    await vm.runtime.syncEpisodes({ sessionId: S, force: true });
    const call = calls.find((c) => c.purpose === 'episode_summary');
    assert.ok(call, '应发起摘要调用');
    const sent = call.messages.map((m) => String(m.content ?? '')).join('\n');
    assert.ok(sent.includes('真实问题'), '摘要输入必须包含真实内容');
    assert.ok(sent.includes('真实回答'), '摘要输入必须包含真实回答');
    assert.ok(
      !sent.includes('Current runtime context'),
      `摘要输入 MUST NOT 含宿主样板（实测它会把输入撑到 60k token 并导致摘要永远失败）`,
    );
  } finally {
    vm.close();
  }
});

test('摘要：纯样板区间不会永远停在 pending（落一条标记并出队）', async () => {
  const calls = [];
  const llm = { async complete(req) { calls.push(req); return { text: '{}', toolCalls: [], usage: null, stopReason: { kind: 'stop' } }; } };
  const vm = createContextVm({ rawConfig: {}, dbPath: ':memory:', llm });
  vm.runtime.setWindow(S, W);
  setSessionActive(vm.db, S, true);
  try {
    for (let i = 0; i < 6; i += 1) {
      vm.raw.append({
        sessionId: S, role: 'system', eventType: 'system_note',
        content: `Current runtime context. 样板 ${i}`,
        metadata: { sourceKind: 'plugin', contextForm: 'snapshot' },
      });
    }
    await vm.runtime.syncEpisodes({ sessionId: S, force: true });
    assert.equal(
      calls.filter((c) => c.purpose === 'episode_summary').length, 0,
      '纯样板区间 MUST NOT 发起摘要调用（没有内容可摘要，白烧一次慢调用）',
    );
    assert.equal(
      vm.episodes.episodes.pendingSummaries(S).length, 0,
      '应落标记出队，不得永远 pending',
    );
  } finally {
    vm.close();
  }
});
