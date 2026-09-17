/**
 * 会话级开关（显式直接模式）。
 *
 * 设计取舍（真机审计的结论）：插件此前**全局注册 8 个工具**（实测 schema 合计约 1433 token），
 * 而它们随注册进入该 profile 下**每一个会话**的请求 —— 与用户是否用 ContextVM 无关。
 * 这比插件注入的上下文（82–257 token）贵一个量级，是最大的一处上下文污染。
 *
 * 故改为**默认休眠、显式开启**：
 *   - 休眠（默认）：不注册任何工具、不注入任何内容、不做后台抽取 —— 请求零足迹；
 *   - 开启（用户在该会话执行 `/contextvm on`）：工具注册进**该会话自己的 agent 作用域**
 *     （不是全局），注入与轮末抽取同时生效。
 *
 * 这样"污染隔离"是结构性的：没开启的会话根本看不到这些工具，也不为它们的 schema 付费。
 * 唯一新增的用户操作就是这一次显式开启 —— 这是有意的取舍。
 *
 * 模式按会话持久化（kv），使长会话跨重启保持开启；工具是 agent 作用域的，
 * 重启后由首次请求时的懒注册补回（见 seams.ensureActivated）。
 *
 * @module dsh-contextvm/app/session_mode
 */
import { kvGet, kvSet } from '../storage/sqlite.js';

/** 模式取值。 */
export const MODE_ACTIVE = 'active';
export const MODE_DORMANT = 'dormant';

/** @param {string} sessionId */
export const modeKey = (sessionId) => `session_mode:${sessionId}`;

/**
 * 该会话是否已开启。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {'dormant'|'active'} [fallback] 会话没有显式记录时的默认（来自 config.sessionMode）
 */
export function isSessionActive(db, sessionId, fallback = MODE_DORMANT) {
  return kvGet(db, modeKey(sessionId), fallback) === MODE_ACTIVE;
}

/**
 * 设置会话模式。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {boolean} active
 */
export function setSessionActive(db, sessionId, active) {
  kvSet(db, modeKey(sessionId), active ? MODE_ACTIVE : MODE_DORMANT);
  return active ? MODE_ACTIVE : MODE_DORMANT;
}

/**
 * 解析命令输入里的子命令。
 * 裸命令 = status（保持既有语义，不产生副作用）。
 * @param {string} rawInput
 * @returns {'status'|'on'|'off'|'invalid'}
 */
export function parseSubcommand(rawInput) {
  const t = String(rawInput ?? '').trim().toLowerCase();
  if (t === '') return 'status';
  if (t === 'on') return 'on';
  if (t === 'off') return 'off';
  return 'invalid';
}
