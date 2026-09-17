/**
 * 结构复杂度审计（只读，不改代码）。
 *
 * 用启发式正则解析 JS，输出：
 *   - 每文件：行数、函数数、最长函数、最大嵌套、最大参数个数、外层导出数
 *   - 跨文件：重复代码块、重复出现的字面量、同名函数（疑似重复实现）
 *   - 依赖图：本地模块依赖、环检测
 *   - 坏味道计数：空 catch、吞错、console 残留、TODO、超长参数表
 *
 * 用法：node tools/code-audit.mjs [目录...]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = process.argv.slice(2).length ? process.argv.slice(2) : ['lib', 'tests', 'benchmark'];
const SKIP = new Set(['node_modules', '.git', '_superseded']);

/** @returns {string[]} */
function collect(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) out.push(...collect(p));
    } else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => (fs.existsSync(r) ? collect(r) : []));

/**
 * 统计顶层参数个数。
 *
 * 关键：`{ a, b, c }` 这种**单个解构对象**必须计为 1 个参数 —— 它正是用来替掉
 * 长位置参数表的惯用写法。早期实现按逗号裸切，把 6 个字段算成 6 个参数，
 * 于是"参数表过长"的报告全是假阳性。
 */
function countTopLevelParams(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  let depth = 0;
  let n = 1;
  for (const ch of s) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) n += 1;
  }
  return n;
}

/** 只统计控制流嵌套（if/for/while/switch/try/catch），排除对象字面量的花括号。 */
function controlFlowDepth(lines) {
  let depth = 0;
  let max = 0;
  let maxLine = 0;
  for (const [i, l] of lines.entries()) {
    const opens = (l.match(/\b(if|for|while|switch|try|catch)\s*\(/g) ?? []).length + (/\belse\s*\{/.test(l) ? 1 : 0);
    const leadingClose = (l.match(/^\s*\}/g) ?? []).length;
    depth = Math.max(0, depth - leadingClose);
    depth += opens;
    if (depth > max) {
      max = depth;
      maxLine = i + 1;
    }
    const net = (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
    if (net < 0) depth = Math.max(0, depth + net);
  }
  return { max, line: maxLine };
}

/** 粗略定位函数：声明式、方法、箭头/函数表达式赋值。 */
function findFunctions(src) {
  const lines = src.split('\n');
  const fns = [];
  const re = /(?:^|\s)(?:async\s+)?(?:function\s+([A-Za-z0-9_$]+)|([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{|([A-Za-z0-9_$]+)\s*[:=]\s*(?:async\s*)?\(([^)]*)\)\s*=>|([A-Za-z0-9_$]+)\s*[:=]\s*(?:async\s*)?function)/;
  const braceStack = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = re.exec(line);
    if (m && current === null && !/^\s*(\/\/|\*)/.test(line)) {
      const name = m[1] ?? m[2] ?? m[4] ?? m[6] ?? '(anonymous)';
      const paramsRaw = m[3] ?? m[5] ?? '';
      current = {
        name,
        start: i + 1,
        params: countTopLevelParams(paramsRaw),
        depth: 0,
        maxDepth: 0,
      };
    }
    if (current) {
      for (const ch of line) {
        if (ch === '{') {
          current.depth += 1;
          current.maxDepth = Math.max(current.maxDepth, current.depth);
        } else if (ch === '}') current.depth -= 1;
      }
      if (current.depth <= 0) {
        current.end = i + 1;
        current.length = current.end - current.start + 1;
        fns.push(current);
        current = null;
      }
    }
  }
  return fns;
}

const perFile = [];
/** @type {Map<string, string[]>} 模块 → 本地依赖 */
const graph = new Map();
/** @type {Map<string, Set<string>>} 函数名 → 出现文件 */
const fnIndex = new Map();
const literals = new Map();
const smell = { emptyCatch: 0, console: 0, todo: 0, longParam: 0, deepNest: 0, longFn: 0, exported: 0 };
const offenders = { longFn: [], deepNest: [], longParam: [], bigFile: [] };

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  const fns = findFunctions(src);
  const deps = [];
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) deps.push(m[1]);
  for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)) deps.push(m[1]);
  graph.set(f, deps);

  const exports = [...src.matchAll(/export\s+(?:const|function|class|async function)\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]);
  smell.exported += exports.length;

  for (const fn of fns) {
    if (!fnIndex.has(fn.name)) fnIndex.set(fn.name, new Set());
    fnIndex.get(fn.name).add(f);
    if (fn.length > 40) {
      smell.longFn += 1;
      offenders.longFn.push({ file: f, fn: fn.name, lines: fn.length, start: fn.start });
    }
    if (fn.maxDepth >= 4) {
      smell.deepNest += 1;
      offenders.deepNest.push({ file: f, fn: fn.name, depth: fn.maxDepth });
    }
    if (fn.params > 4) {
      smell.longParam += 1;
      offenders.longParam.push({ file: f, fn: fn.name, params: fn.params });
    }
  }

  const emptyCatch = (src.match(/catch\s*(?:\([^)]*\))?\s*\{\s*\/\*[^*]*\*\/\s*\}/g) ?? []).length
    + (src.match(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g) ?? []).length;
  const consoleUses = (src.match(/\bconsole\.(log|warn|error|debug)\b/g) ?? []).length;
  const todos = (src.match(/\b(TODO|FIXME|XXX|HACK)\b/g) ?? []).length;
  smell.emptyCatch += emptyCatch;
  smell.console += consoleUses;
  smell.todo += todos;

  // 字面量重复（长度 ≥6 的字符串，排除纯路径/正则）
  for (const m of src.matchAll(/'([^'\\\n]{6,})'|"([^"\\\n]{6,})"/g)) {
    const v = m[1] ?? m[2];
    if (!v || /^[.\-/@]/.test(v)) continue;
    if (!literals.has(v)) literals.set(v, new Set());
    literals.get(v).add(f);
  }

  perFile.push({
    file: f,
    lines: lines.length,
    codeLines: lines.filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)).length,
    commentLines: lines.filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l)).length,
    fns: fns.length,
    longestFn: fns.reduce((a, b) => Math.max(a, b.length ?? 0), 0),
    // 两个嵌套指标分开报：花括号版含对象字面量（会虚高），控制流版才是真复杂度
    maxBraceNest: fns.reduce((a, b) => Math.max(a, b.maxDepth), 0),
    cfDepth: controlFlowDepth(lines),
    exports: exports.length,
    deps: deps.length,
  });
  if (lines.length > 250) offenders.bigFile.push({ file: f, lines: lines.length });
}

// ---- 依赖环检测（DFS） ----
const cycles = [];
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map();
const norm = (from, spec) => {
  const r = path.resolve(path.dirname(from), spec);
  for (const cand of [r, r + '.js', r + '.mjs']) if (fs.existsSync(cand)) return cand;
  return null;
};
function dfs(node, stack) {
  color.set(node, GRAY);
  stack.push(node);
  for (const spec of graph.get(node) ?? []) {
    const next = norm(node, spec);
    if (!next || !graph.has(next)) continue;
    const c = color.get(next) ?? WHITE;
    if (c === GRAY) cycles.push([...stack.slice(stack.indexOf(next)), next].map((p) => path.relative(process.cwd(), p)));
    else if (c === WHITE) dfs(next, stack);
  }
  stack.pop();
  color.set(node, BLACK);
}
for (const f of graph.keys()) if ((color.get(f) ?? WHITE) === WHITE) dfs(f, []);

// ---- 重复代码块（连续 5 行非平凡代码） ----
const blocks = new Map();
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim());
  for (let i = 0; i + 5 <= lines.length; i += 1) {
    const win = lines.slice(i, i + 5);
    if (win.some((l) => l.length < 8 || /^(\/\/|\*|\/\*|\}|\)|else|import|export)/.test(l))) continue;
    const key = win.join('\n');
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(`${path.relative(process.cwd(), f)}:${i + 1}`);
  }
}
const dupBlocks = [...blocks.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);

// ---- 同名函数出现在多个文件（疑似重复实现） ----
const dupFns = [...fnIndex.entries()]
  .filter(([name, set]) => set.size > 1 && !['constructor', '(anonymous)', 'map', 'filter', 'reduce', 'run', 'trim', 'sql'].includes(name))
  .map(([name, set]) => ({ name, files: [...set].map((f) => path.relative(process.cwd(), f)) }));

const repeatLiterals = [...literals.entries()]
  .filter(([, set]) => set.size >= 3)
  .sort((a, b) => b[1].size - a[1].size)
  .slice(0, 15)
  .map(([v, set]) => ({ literal: v.slice(0, 60), files: set.size }));

// ---------------- 输出 ----------------
const totalLines = perFile.reduce((a, f) => a + f.lines, 0);
const codeLines = perFile.reduce((a, f) => a + f.codeLines, 0);
const commentLines = perFile.reduce((a, f) => a + f.commentLines, 0);

console.log('═══ 总量 ═══');
console.log(`文件 ${files.length} | 总行 ${totalLines} | 代码行 ${codeLines} | 注释行 ${commentLines} | 注释占比 ${((commentLines / totalLines) * 100).toFixed(1)}%`);
console.log(`函数 ${perFile.reduce((a, f) => a + f.fns, 0)} | 导出符号 ${smell.exported}`);

console.log('\n═══ 最大的 12 个文件 ═══');
for (const f of [...perFile].sort((a, b) => b.lines - a.lines).slice(0, 12)) {
  console.log(
    `  ${String(f.lines).padStart(4)} 行 (代码 ${String(f.codeLines).padStart(4)}) | 函数 ${String(f.fns).padStart(2)} | 最长函数 ${String(f.longestFn).padStart(3)} | 控制流嵌套 ${f.cfDepth.max}@${f.cfDepth.line} | 导出 ${String(f.exports).padStart(2)} | ${path.relative(process.cwd(), f.file)}`,
  );
}

console.log('\n═══ 坏味道计数 ═══');
console.log(`  超长函数(>40 行) ${smell.longFn} | 超长参数表(>4，仅计顶层参数) ${smell.longParam}`);
console.log('  嵌套：下方"深嵌套（花括号/含对象字面量）"仅作参考，真复杂度看"控制流嵌套"一节');
console.log(`  空 catch ${smell.emptyCatch} | console 残留 ${smell.console} | TODO/FIXME ${smell.todo}`);

console.log('\n═══ 超长函数 TOP 10 ═══');
for (const o of offenders.longFn.sort((a, b) => b.lines - a.lines).slice(0, 10)) {
  console.log(`  ${String(o.lines).padStart(4)} 行  ${o.fn}  ${path.relative(process.cwd(), o.file)}:${o.start}`);
}

console.log('\n═══ 控制流嵌套（lib 内，已排除对象字面量）═══');
{
  const libs = perFile
    .filter((x) => x.file.replace(/\\/g, '/').startsWith('lib/'))
    .sort((a, b) => b.cfDepth.max - a.cfDepth.max)
    .slice(0, 10);
  for (const f of libs) {
    console.log(`  深度 ${f.cfDepth.max}  行 ${f.cfDepth.line}  ${path.relative(process.cwd(), f.file)}`);
  }
  if (libs.length === 0) console.log('  （lib 下无文件）');
}

console.log('\n═══ 深嵌套（花括号计数，含对象字面量，仅作参考）═══');
for (const o of offenders.deepNest.sort((a, b) => b.depth - a.depth).slice(0, 10)) {
  console.log(`  深度 ${o.depth}  ${o.fn}  ${path.relative(process.cwd(), o.file)}`);
}

console.log('\n═══ 超长参数表 ═══');
for (const o of offenders.longParam) console.log(`  ${o.params} 个参数  ${o.fn}  ${path.relative(process.cwd(), o.file)}`);

console.log('\n═══ 依赖环 ═══');
if (cycles.length === 0) console.log('  无环');
else for (const c of cycles) console.log('  ' + c.join(' → '));

console.log(`\n═══ 重复代码块（连续 5 行，共 ${dupBlocks.length} 组）═══`);
for (const [key, locs] of dupBlocks.slice(0, 8)) {
  console.log(`  ×${locs.length}: ${locs.slice(0, 4).join(' , ')}`);
  console.log(`       ${key.split('\n')[0].slice(0, 90)}`);
}

console.log('\n═══ 同名函数出现在多个文件（疑似重复实现）═══');
for (const d of dupFns.slice(0, 20)) console.log(`  ${d.name}  →  ${d.files.join(' , ')}`);

console.log('\n═══ 高频重复字面量 ═══');
for (const r of repeatLiterals) console.log(`  ×${r.files} 文件  "${r.literal}"`);

console.log('\n═══ 依赖最多的模块（被依赖 / 依赖）═══');
const inbound = new Map();
for (const [f, deps] of graph) {
  for (const spec of deps) {
    const t = norm(f, spec);
    if (t) inbound.set(t, (inbound.get(t) ?? 0) + 1);
  }
}
const rows = [...graph.entries()].map(([f, d]) => ({
  file: path.relative(process.cwd(), f),
  out: d.length,
  in: inbound.get(f) ?? 0,
}));
for (const r of rows.sort((a, b) => b.in - a.in).slice(0, 10)) {
  console.log(`  被依赖 ${String(r.in).padStart(2)} | 依赖 ${String(r.out).padStart(2)} | ${r.file}`);
}
