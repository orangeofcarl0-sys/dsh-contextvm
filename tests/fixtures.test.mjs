/**
 * 基准夹具的"金标准"回归（防止重构静默改变被测语料）。
 *
 * 为什么值得单独锁住：填充文本的**形态**决定 chars/token，进而决定 prefill 档位与
 * 规范 §9.6 的全部标定值。本轮把 6 份重复的 genFiller 合并为单一实现时就差点踩到
 * ——压缩词表会让同 seed 产出完全不同的文本，而实测的 6.77 chars/token 与
 * prefill 结果（27.3s@8k / 32.8s@32k）都基于原文本。
 *
 * 因此这里用内容哈希锁定语料：任何会改变语料的改动都会让本测试失败，
 * 迫使改动者显式确认（而不是让基准数据静默失效）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { genFiller, vocabSnapshot, pct, round, W, FILLER_CHARS_PER_TOKEN } from '../benchmark/shared/fixtures.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

/** 迁移前由旧实现产出并逐字比对确认过的哈希。 */
const GOLDEN = {
  'genFiller(2000, 12345)': '6a5798c16ff57b01',
  'genFiller(30000, 12345)': 'd29ae1f5890aad76',
  'genFiller(50000, 4242)': '4aed8b9ddd0e878a',
};

test('词表快照未被静默替换', () => {
  assert.deepEqual(vocabSnapshot(), { words: 1281, chars: 9440 });
});

test('填充文本与金标准逐字一致（改动语料必须在此显式更新）', () => {
  assert.equal(sha(genFiller(2000, 12345)), GOLDEN['genFiller(2000, 12345)']);
  assert.equal(sha(genFiller(30000, 12345)), GOLDEN['genFiller(30000, 12345)']);
  assert.equal(sha(genFiller(50000, 4242)), GOLDEN['genFiller(50000, 4242)']);
});

test('生成器性质：定种可复现、无长重复子串、长度精确', () => {
  assert.equal(genFiller(5000, 7), genFiller(5000, 7), '同 seed 必须完全可复现');
  assert.notEqual(genFiller(5000, 7), genFiller(5000, 8), '不同 seed 应产出不同文本');
  const a = genFiller(3000, 12345);
  assert.equal(a.length, 3000, '长度应精确等于请求值');
  // 无长重复子串：重复句会被 BPE 大幅压缩，使 chars/token 失真
  const repeated = a.slice(0, 200).repeat(15);
  assert.ok(!a.includes(repeated), '不得出现整段重复');
  assert.ok(sha(repeated) !== sha(a.slice(0, 3000)), '语料不应由重复片段构成');
});

test('常量与规范一致', () => {
  assert.equal(W, 262144);
  assert.equal(FILLER_CHARS_PER_TOKEN, 6.77);
});

test('统计小工具：pct 用最近秩法、round 不把 NaN 写进报告', () => {
  assert.equal(pct([5, 1, 3, 2, 4], 50), 3, '5 个样本的中位数');
  assert.equal(pct([1, 2, 3, 4], 50), 2, '偶数样本取下中位数（标准最近秩）');
  assert.equal(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9, 'p90 取第 9 个而非最大');
  assert.equal(pct([1, 2, 3], 100), 3, 'p100 取最大值');
  assert.equal(pct([1, 2, 3], 1), 1, '极小 p 仍取最小值');
  assert.equal(pct([], 50), null);
  assert.equal(round(1.23456), 1.235);
  assert.equal(round(NaN), null);
  assert.equal(round(null), null);
  assert.equal(round(undefined), null);
});

test('脚本卫生：使用内部符号必须有对应 import（防止机械重构删掉仍在用的 import）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dirs = ['benchmark', 'benchmark/shared', 'tools', 'lib'];
  const files = dirs.flatMap((d) =>
    fs
      .readdirSync(d)
      .filter((f) => /\.mjs$/.test(f) && fs.statSync(path.join(d, f)).isFile())
      .map((f) => path.join(d, f)),
  );
  const problems = [];
  const needs = [
    ['fs.', 'node:fs'],
    ['path.', 'node:path'],
    ['createRequire', 'node:module'],
    ['createHash', 'node:crypto'],
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const imports = src.split('\n').filter((l) => l.startsWith('import ')).join('\n');
    for (const [sym, mod] of needs) {
      const uses = src.split(sym).length - 1;
      if (uses > 0 && !imports.includes(mod)) problems.push(`${f}: 用了 ${sym} 但未 import ${mod}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('脚本卫生：基准脚本不得再从他脚本源码里正则抽取常量（隐式耦合）', async () => {
  const fs = await import('node:fs');
  const files = fs.readdirSync('benchmark').filter((f) => f.endsWith('.mjs'));
  const coupled = [];
  for (const f of files) {
    const src = fs.readFileSync(`benchmark/${f}`, 'utf8');
    // 曾经的坏味道：读另一个 .mjs 的源码再 match 出词表
    if (/readFileSync\([^)]*\.mjs'/.test(src)) coupled.push(f);
  }
  assert.deepEqual(coupled, [], `以下脚本仍在解析他脚本源码：${coupled.join(', ')}`);
});

test('隐私守卫：仓库内不得出现个人路径、会话标识或硬编码密钥', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const SKIP = new Set(['node_modules', '.git', '_superseded']);
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|md|json|yml|yaml|txt|cjs)$/.test(e.name)) files.push(p);
    }
  };
  walk('.');

  const patterns = [
    // Windows 用户目录：C:/Users/<name> 或 C:\Users\<name>
    [/[A-Za-z]:[\/]Users[\/][^\/\s'"`]+/g, '个人路径'],
    // 形如 UUID 的会话/账号标识（本文件自身除外，它需要写出这些模式）
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID 标识'],
    // 常见密钥前缀
    [/\bsk-[A-Za-z0-9_-]{12,}/g, '密钥'],
    [/\beyJ[A-Za-z0-9_-]{20,}/g, 'JWT'],
  ];

  const hits = [];
  for (const f of files) {
    if (f.endsWith('fixtures.test.mjs')) continue; // 守卫自身必然包含这些模式
    const text = fs.readFileSync(f, 'utf8');
    for (const [re, label] of patterns) {
      for (const m of text.matchAll(re)) hits.push(`${f}: ${label} ${m[0].slice(0, 24)}…`);
    }
  }
  assert.deepEqual(hits, [], `发现可能不该发布的个人数据：\n${hits.join('\n')}`);
});
