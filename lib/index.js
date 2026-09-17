/**
 * dsh-contextvm 插件入口（§21.1）。
 *
 * 注意：本插件**不导出 Config schema**。配置的校验只有一处 ——
 * `lib/app/config.js` 的 resolveConfig + validateInvariants（§19.1）。
 * 再叠一层宿主侧 schema 会形成两份可能不一致的校验逻辑，正是要避免的东西。
 * 宿主把 cordis.patch.yml 的 config 原样传入，我们在这里校验并拒绝非法配置。
 *
 * @module dsh-contextvm
 */
import { createContextVm } from './app/create.js';
import { applySeams } from './host/seams.js';
import { createLlmPort } from './host/llm.js';
import { schemaVersion } from './storage/sqlite.js';

export const name = 'dsh-contextvm';

/** 工具注册是必需能力；其它服务一律用 ctx.get() 探测（缺失即如实降级）。 */
export const inject = ['tools'];

/**
 * @param {any} ctx Cordis 上下文
 * @param {object} [rawConfig] cordis.patch.yml 的 config 段
 */
export function apply(ctx, rawConfig = {}) {
  const logger = (level, msg) => {
    const log = ctx.logger ?? console;
    (log[level] ?? log.info ?? console.log).call(log, msg);
  };

  const telemetry = [];
  const llm = createLlmPort(ctx, { logger });

  let vm;
  try {
    vm = createContextVm({
      rawConfig,
      dbPath: rawConfig?.dbPath ?? null,
      llm,
      onTelemetry: (rec) => {
        telemetry.push(rec);
        if (telemetry.length > 500) telemetry.shift();
        logger('debug', `contextvm telemetry: ${JSON.stringify(rec)}`);
      },
    });
  } catch (err) {
    // §19.1：配置不变量失败即拒绝启动，MUST NOT 以默认值静默继续
    logger('error', `contextvm: 启动失败（配置或数据库）：${String(err?.message ?? err)}`);
    throw err;
  }

  const seams = applySeams(ctx, vm, { logger });
  for (const w of seams.warnings) logger('warn', `contextvm: ${w}`);

  // 工具定义器来自宿主包，只能异步解析；解析失败即如实降级为文本 JSON 路径
  void (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-tools');
      const r = seams.registerTool(mod.defineTool);
      for (const w of r.warnings) logger('warn', `contextvm: ${w}`);
      if (r.registered.length) logger('info', `contextvm: 已注册工具 ${r.registered.join(',')}`);
    } catch (err) {
      logger('warn', `contextvm: 未注册状态提交工具（delta 走文本 JSON 路径）：${String(err?.message ?? err)}`);
    }
  })();

  logger(
    'info',
    `contextvm: 已挂载（路由 ${vm.config.route.provider}/${vm.config.route.model}；` +
      `schema v${schemaVersion(vm.db)}）`,
  );

  return {
    vm,
    seams,
    telemetry,
    dispose() {
      vm.close();
    },
  };
}

export default { name, inject, apply };
