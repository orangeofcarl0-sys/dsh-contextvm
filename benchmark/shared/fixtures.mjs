/**
 * benchmark 脚本的共享夹具。
 *
 * 此前 11 个脚本各自重复了"解析 profiles 下的 yaml → 读 .credentials.yaml →
 * 声明端点/模型/窗口常量 → 生成伪随机填充文本"这套样板，6 个脚本还各写了一份
 * 相同的 genFiller。集中到这里：同一事实只有一处定义，否则改一处忘一处会直接
 * 让基准数据失去可比性。
 *
 * 密钥只从 .credentials.yaml 读取，不落盘、不打印。
 *
 * @module benchmark/shared/fixtures
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 宿主数据目录；可用 DSH_HOME 覆盖。默认取当前用户家目录下的 .dsh（不写死任何个人路径）。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 从宿主 profiles 解析第三方包（benchmark 脚本不声明 dependencies）。 */
export function loadFromProfiles(pkg) {
  const require = createRequire(path.join(dshHome(), 'profiles', 'node_modules', 'noop.js'));
  return require(pkg);
}

/**
 * 读取凭据引用值（只返回值，不打印）。
 * @param {string} refName 例如 OPENROUTER_API_KEY
 * @returns {string}
 */
export function loadCredential(refName) {
  const file = path.join(dshHome(), '.credentials.yaml');
  const YAML = loadFromProfiles('yaml');
  const refs = YAML.parse(fs.readFileSync(file, 'utf8')).refs ?? {};
  const v = refs[refName];
  if (!v) throw new Error(`凭据 ${refName} 未在 ${file} 的 refs 中注册`);
  return v;
}

/**
 * opencode 路由的会话亲和张量（`x-opencode-session`）。
 *
 * 该值属于**部署方配置**，因此从用户自己的 settings.yaml 读取，MUST NOT 写进仓库
 * （它是一个与账号/路由相关的标识）。可用 OPENCODE_SESSION 环境变量覆盖。
 * 读不到时直接报错，而不是回退到某个默认值 —— 缺失该头的请求会被上游以
 * 400 MissingSessionID 拒掉，静默兜底只会让人误以为参数没问题。
 *
 * @returns {string}
 */
export function loadOpencodeSession() {
  if (process.env.OPENCODE_SESSION) return process.env.OPENCODE_SESSION;
  const YAML = loadFromProfiles('yaml');
  const file = path.join(dshHome(), 'settings.yaml');
  let settings;
  try {
    settings = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`无法读取 ${file}：${err.message}；可改用 OPENCODE_SESSION 环境变量提供`);
  }
  const value = settings?.['llm-pi-ai']?.providers?.['opencode-go']?.headers?.['x-opencode-session'];
  if (!value) {
    throw new Error(
      `${file} 中未找到 llm-pi-ai.providers.opencode-go.headers.x-opencode-session；` +
        '请在该路由的 headers 下声明，或设置 OPENCODE_SESSION 环境变量',
    );
  }
  return value;
}

// ---------------- 目标路由常量（与规范 §2.1 / §2.1.2 一致） ----------------

export const W = 262144;
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_MODEL = 'stealth/union-alpha';
export const OPENCODE_BASE = 'https://opencode.ai/zen/go/v1';

/** 实测的真实分词器 chars/token（伪随机英文词序，见规范 §9.6）。 */
export const FILLER_CHARS_PER_TOKEN = 6.77;

/** 请求超时：低 TPS 下长输出与长 prefill 都需要宽限。 */
export const REQ_TIMEOUT_MS = 900_000;

// ---------------- 填充文本 ----------------

/**
 * 词表放在数据文件里而不是源码字面量：它是 9.4KB 纯数据，且**逐字**决定填充文本
 * 的形态，进而决定 chars/token 与全部 prefill 档位。放进数据文件后可被测试逐字
 * 比对，避免"重构顺手改词表"这类静默失真（本轮就差点踩到：压缩词表会让同 seed
 * 的文本改变，实测的 6.77 与所有 prefill 档位随之失效）。
 */
const VOCAB = fs
  .readFileSync(path.join(import.meta.dirname, 'vocab.txt'), 'utf8')
  .split(/\s+/)
  .filter(Boolean);

/**
 * 生成确定性伪随机填充文本（无长重复子串）。
 *
 * 为什么不能只用重复句：BPE 会把重复文本压到 6.35 chars/token（预期 3.55），
 * 导致 prefill 档位整体打偏——这是实测踩过的坑（规范 §2.3 的方法学说明）。
 *
 * @param {number} chars 目标字符数
 * @param {number} [seed] 定种以保证语料可复现
 * @returns {string}
 */
export function genFiller(chars, seed = 12345) {
  let s = seed >>> 0;
  const out = [];
  let len = 0;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
  while (len < chars) {
    const n = 6 + Math.floor(rnd() * 12);
    const sent = [];
    for (let i = 0; i < n; i += 1) sent.push(VOCAB[Math.floor(rnd() * VOCAB.length)]);
    const line = sent.join(' ') + '. ';
    out.push(line);
    len += line.length;
  }
  return out.join('').slice(0, chars);
}

/** 词表快照，供测试比对（防止静默替换）。 */
export function vocabSnapshot() {
  return { words: VOCAB.length, chars: VOCAB.join(' ').length };
}

// ---------------- 统计小工具 ----------------

/**
 * 百分位（标准最近秩法）：取最小的、使得至少有 p% 数据不超过它的那个值。
 * 即索引 = ceil(p/100 × n) − 1。
 *
 * 注意此前几处实现用的是 `floor(p/100 × n)` 直接当 0 基索引——奇数个样本时两者
 * 等价，偶数个样本时前者偏大（取上中位数）。已统一到文档所述的定义。
 */
export function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/** 定点取整；非有限值返回 null（避免把 NaN 写进报告）。 */
export function round(v, d = 3) {
  return v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(d));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
