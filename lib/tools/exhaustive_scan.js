/**
 * 穷举扫描工具（§11 / §21.5 / §8.3）。
 *
 * 为什么做成工具而不是自动触发：扫描是分钟级的并行作业（分块 × worker），
 * 而 system prompt 装配路径是同步的、绝不能阻塞。由模型在需要完整性结论时
 * 显式调用，是唯一"不阻塞、也不假装"的接法。
 *
 * 返回文本必须**如实**给出覆盖情况：不完整就写明不完整（§23.3）。
 *
 * @module dsh-contextvm/tools/exhaustive_scan
 */

import { toolOutput } from './output.js';
import { sessionIdOf } from './exec.js';

const MAX_LINES = 40;

/**
 * @param {import('../app/runtime.js').Runtime} runtime
 * @param {{defineTool: Function}} deps
 */
export function exhaustiveScanTool(runtime, deps) {
  const { defineTool } = deps;
  return defineTool({
    name: 'contextvm_exhaustive_scan',
    description:
      '对**全部历史**做分块并行穷举扫描，用于"全部/所有/无遗漏/检查是否矛盾/逐一核对"这类要求完整性的问题。' +
      '普通问题不要调用（按需检索已足够）。返回每条发现及其来源事件 id，以及覆盖情况；' +
      '若覆盖不完整，你必须在回答里说明未覆盖全部历史。',
    parameters: {
      question: { type: 'string', required: true, description: '要穷举核对的具体问题，尽量具体（例如"列出所有关于波长的约束"）。' },
      concurrency: { type: 'number', description: '并发 worker 数，默认取配置值。' },
      complex: { type: 'boolean', description: '发现项较多时可设 true，worker 输出上限放宽到 500 token。' },
    },
    output: toolOutput({
      coverage_complete: { type: 'boolean' },
      findings: { type: 'number' },
      chunks: { type: 'number' },
    }),
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (!sessionId) {
        return { ok: false, result: '无法确定会话，未执行扫描。', coverage_complete: false, findings: 0, chunks: 0 };
      }
      try {
        const scan = await runtime.exhaustiveScan({
          sessionId,
          query: String(args.question ?? ''),
          concurrency: typeof args.concurrency === 'number' ? args.concurrency : undefined,
          complex: args.complex === true,
          signal: exec?.signal,
        });
        const lines = [];
        lines.push(
          `覆盖：${scan.coverage.coveredChunks}/${scan.coverage.chunks} 块，` +
            `complete=${scan.coverage.complete}${scan.coverage.complete ? '' : `（原因：${scan.coverage.reason}）`}`,
        );
        lines.push(`扫描范围 token≈${scan.tokens.scope}，发现 ${scan.findings.length} 条，用时 ${Math.round(scan.stats.elapsedMs / 1000)}s`);
        for (const f of scan.findings.slice(0, MAX_LINES)) {
          lines.push(`- [${f.category}] ${f.claim} (src=${f.sourceEventIds.join(',')})`);
        }
        if (scan.findings.length > MAX_LINES) lines.push(`（另有 ${scan.findings.length - MAX_LINES} 条未在此列出）`);
        for (const c of scan.conflicts.slice(0, 8)) {
          lines.push(`冲突：A「${c.a.claim}」(src=${c.a.sourceEventIds.join(',')}) vs B「${c.b.claim}」(src=${c.b.sourceEventIds.join(',')})`);
        }
        if (scan.coverage.failedChunks?.length) {
          lines.push(`未完成的块：${scan.coverage.failedChunks.map((x) => `#${x.chunkIndex}(${x.reason})`).join(', ')}`);
        }
        if (!scan.coverage.complete) {
          lines.push('注意：覆盖不完整，回答时必须明说未覆盖全部历史，不得声称"已检查全部"。');
        }
        return {
          ok: true,
          result: lines.join('\n'),
          coverage_complete: scan.coverage.complete,
          findings: scan.findings.length,
          chunks: scan.chunks.length,
        };
      } catch (err) {
        return {
          ok: false,
          result: `扫描失败：${String(err?.message ?? err)}`,
          coverage_complete: false,
          findings: 0,
          chunks: 0,
        };
      }
    },
  });
}
