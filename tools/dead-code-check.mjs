/**
 * 死代码与"上帝对象"检查（只读）。
 *
 * 1. 未被引用的导出（在 lib + tests + benchmark + tools 全量文本里只出现一次）
 * 2. 类成员数量（字段 + 方法），用于识别过大的对象
 * 3. 空 catch 的上下文（判断是"有意降级"还是"吞错"）
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', '_superseded']);
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

const libFiles = collect('lib');
const otherFiles = ['tests', 'benchmark', 'tools'].filter((d) => fs.existsSync(d)).flatMap(collect);
const haystack = [...libFiles, ...otherFiles].map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const countOccurrences = (needle) => {
  let n = 0;
  let i = 0;
  for (;;) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) break;
    // 边界检查：前后不能是标识符字符
    const before = haystack[j - 1] ?? ' ';
    const after = haystack[j + needle.length] ?? ' ';
    if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) n += 1;
    i = j + needle.length;
  }
  return n;
};

console.log('═══ 未被引用的导出 ═══');
let dead = 0;
for (const f of libFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/export\s+(?:const|function|async function|class)\s+([A-Za-z0-9_$]+)/g)) {
    const name = m[1];
    const uses = countOccurrences(name);
    if (uses <= 1) {
      console.log(`  ${name.padEnd(30)} ${path.relative(process.cwd(), f)}`);
      dead += 1;
    }
  }
}
console.log(`  小计：${dead} 个（0 表示无死导出）`);

console.log('\n═══ 类成员数量（字段 + 方法）═══');
for (const f of libFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)[^{]*\{/g)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    const body = src.slice(start, i - 1);
    const methods = (body.match(/^\s{2}(?:async\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*\(/gm) ?? []).length;
    const fields = (body.match(/^\s{2}this\.[A-Za-z0-9_$]+\s*=/gm) ?? []).length;
    const lines = body.split('\n').length;
    if (lines > 80) {
      console.log(`  ${m[1].padEnd(18)} 行 ${String(lines).padStart(4)} | 方法 ${String(methods).padStart(2)} | 实例字段 ${String(fields).padStart(2)} | ${path.relative(process.cwd(), f)}`);
    }
  }
}

console.log('\n═══ 空 catch 的上下文 ═══');
for (const f of libFiles) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (/catch\s*(\([^)]*\))?\s*\{/.test(l)) {
      const window = lines.slice(Math.max(0, i - 3), i + 4).map((x, k) => `${k === 3 ? '>' : ' '} ${x.trim()}`).join('\n');
      // 只看 catch 块体内没有语句的（可能吞错）
      const body = lines.slice(i + 1, i + 3).join('\n');
      const isEmpty = /^\s*(\}|})/.test(body.trim()) || /^\s*\/\*/.test(body.trim());
      if (isEmpty) {
        console.log(`\n  ${path.relative(process.cwd(), f)}:${i + 1}${/\/\*|\/\//.test(lines.slice(i + 1, i + 2).join('')) ? '（有注释说明）' : '（无说明）'}`);
        console.log(window.split('\n').map((x) => '    ' + x).join('\n'));
      }
    }
  });
}
