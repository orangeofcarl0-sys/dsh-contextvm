/**
 * id 与内容哈希。id 单调可排序（时间前缀 + 计数器），便于按序读取与测试确定性。
 * @module dsh-contextvm/core/ids
 */
import { createHash } from 'node:crypto';

let counter = 0;
let lastMs = 0;

/**
 * 生成单调递增的 id。
 * @param {string} prefix 语义前缀，如 `evt` / `st` / `ep`。
 * @returns {string} `<prefix>_<base36 时间>-<base36 序号>`
 */
export function nextId(prefix) {
  const ms = Date.now();
  if (ms !== lastMs) {
    lastMs = ms;
    counter = 0;
  }
  counter += 1;
  return `${prefix}_${ms.toString(36)}-${counter.toString(36)}`;
}

/**
 * 内容哈希，用于去重检测与完整性校验（§4.1）。
 * @param {string} text
 * @returns {string} `sha256:<hex>`
 */
export function contentHash(text) {
  return 'sha256:' + createHash('sha256').update(String(text), 'utf8').digest('hex');
}
