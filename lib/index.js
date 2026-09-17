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
import { registerStatusCommand, CONTEXTVM_COMMAND } from './commands/status.js';

export const name = 'dsh-contextvm';

/** 工具注册是必需能力；其它服务一律用 ctx.get() 探测（缺失即如实降级）。 */
export const inject = ['tools'];

/**
 * 诊断输出。
 *
 * 走 **stderr** 而非 stdout：headless 模式把 stdout 当作"最终回答"的输出通道，
 * 往那里写会污染用户看到的结果。同时也不只依赖 `ctx.logger` —— 实测宿主并不把
 * 它转发到任何用户可见的地方（同一次运行里其他插件用 console 打的日志出现在
 * `web-latest.err.log` 与 headless 的 stderr，我们的却完全不出现）。
 * 因此既调用 ctx.logger（宿主若转发更好），也直接写 stderr 并带 `[contextvm]` 前缀，
 * 与生态既有约定一致。
 *
 * @param {any} ctx
 * @returns {(level: string, msg: string) => void}
 */
export function makeLogger(ctx) {
  return (level, msg) => {
    const line = msg.startsWith('[contextvm]') ? msg : `[contextvm] ${msg}`;
    try {
      const log = ctx?.logger;
      if (log?.[level]) log[level].call(log, line);
      else if (log?.info) log.info.call(log, line);
    } catch {
      /* 宿主 logger 抛错不影响主流程 */
    }
    try {
      process.stderr.write(line + '\n');
    } catch {
      /* 无处可写时静默；诊断失败 MUST NOT 影响插件 */
    }
  };
}

/**
 * @param {any} ctx Cordis 上下文
 * @param {object} [rawConfig] cordis.patch.yml 的 config 段
 */
export function apply(ctx, rawConfig = {}) {
  const logger = makeLogger(ctx);

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
  for (const w of seams.warnings) logger('warn', w);

  // 人读入口：在此之前 ContextVM 对人是完全不可见的（工具面向模型、遥测在内存、日志在 headless 下看不到）。
  //
  // 命令经 `ctx.inject(['commands'], ...)` 等服务就绪后再注册，而**不**把 'commands' 列进
  // 插件级 inject：后者是**必需**语义，会让整个插件等待该服务 —— 在没有 commands 的宿主上
  // 插件会完全不加载，而命令只是可选的人读能力，不该有这种代价。
  let command = { registered: false, reason: 'commands 服务尚未就绪' };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (c) => {
      command = registerStatusCommand(c, vm);
      if (command.registered) logger('info', `已注册命令 /${CONTEXTVM_COMMAND}（进入全局命令列表）`);
      else logger('warn', `未注册 /${CONTEXTVM_COMMAND} 命令（${command.reason}）`);
    });
  } else {
    // 宿主 cordis 没有 ctx.inject：如实报告，不做"看起来能用"的兜底
    command = { registered: false, reason: '宿主 cordis 未提供 ctx.inject' };
    logger('warn', `未注册 /${CONTEXTVM_COMMAND} 命令（${command.reason}）`);
  }

  // 工具定义器来自宿主包，只能异步解析；解析失败即如实降级为文本 JSON 路径。
  //
  // 这里曾写 `for (const w of r.warnings)`，而 registerTool 当时只返回 { registered } ——
  // 于是每次挂载都抛 "r.warnings is not iterable"，被下面的 catch 吞成
  // "未注册状态提交工具"，**无论工具是否真的注册成功**都报同一条降级告警：
  // 诊断会说谎，比没有诊断更坏。现在 registerTool 回传本次新增的 warnings。
  void (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-tools');
      const r = seams.registerTool(mod.defineTool);
      for (const w of r.warnings) logger('warn', w);
      if (r.registered.length) {
        logger('info', `已注册 ${r.registered.length} 个工具：${r.registered.join(', ')}`);
      } else if (r.warnings.length === 0) {
        logger('warn', '状态提交工具一个都没注册：delta 走文本 JSON 路径（可用，但更慢、更易解析失败）');
      }
    } catch (err) {
      logger('warn', `状态提交工具注册异常：${String(err?.message ?? err)}（delta 走文本 JSON 路径）`);
    }
  })();

  logger('info', `已挂载 · schema v${schemaVersion(vm.db)}`);
  logger('info', `库: ${vm.db.prepare('PRAGMA database_list').get()?.file || '(内存库)'}`);
  logger('info', `路由配置（W 解析失败时的回退）: ${vm.config.route.provider}/${vm.config.route.model}`);

  // 注意：此处**不要**去探测配置里的回退路由是否可解析。真机实测挂载期适配器尚未注册，
  // `resolveModelInfo` 会抛 "no adapter registered for provider ..."，而同一路由在会话期
  // 解析正常 —— 那样只会打出一条假警报。真实路由的窗口与推理档位由 seams 在首次解析时
  // 逐路由记录（那里才知道实际的 provider/model）。

  return {
    vm,
    seams,
    telemetry,
    command,
    dispose() {
      command.dispose?.();
      vm.close();
    },
  };
}

export default { name, inject, apply };
