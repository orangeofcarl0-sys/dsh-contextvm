/**
 * 装配工厂 —— 全插件唯一的组装点。
 *
 * 生产（lib/index.js）与测试都走这里，因此不会出现"测试用一套、生产用另一套"
 * 的接线差异。端口（llm 等）由调用方注入，见 lib/host/ports.js。
 *
 * @module dsh-contextvm/app/create
 */
import { resolveConfig, validateInvariants } from './config.js';
import { openDb, kvGet, kvSet } from '../storage/sqlite.js';
import { Tokenizer } from '../core/tokenization.js';
import { RawEventStore } from '../storage/raw_events.js';
import { StateStore } from '../storage/state_store.js';
import { ArtifactStore } from '../storage/artifacts.js';
import { LexicalIndex } from '../indexing/lexical.js';
import { Retriever } from '../retrieval/hybrid.js';
import { Compiler } from '../context/compiler.js';
import { LlmClient } from '../llm/client.js';
import { EpisodeManager } from './episodes.js';
import { GlobalScanner } from '../global_scan/scanner.js';
import { Runtime } from './runtime.js';
import { Telemetry } from './telemetry.js';
import { createStandardQueue } from '../maintenance/queue.js';
import { rebuildSearchIndex, verifyRebuildability } from '../maintenance/rebuild.js';
import { auditState } from '../memory/audit.js';
import { assertLlmPort } from '../host/ports.js';

const CALIBRATION_KEY = 'tokenizer_calibration';

/**
 * @param {{
 *   rawConfig?: object,
 *   dbPath?: string|null,
 *   llm: import('../host/ports.js').LlmPort,
 *   onTelemetry?: (rec: object) => void,
 *   semantic?: object|null,
 *   measuredMaxRatio?: number,
 * }} opts
 */
export function createContextVm(opts) {
  const config = resolveConfig(opts.rawConfig ?? {});
  // 遥测：内部持有，同时把事件转发给调用方（若有）
  const telemetry = new Telemetry();
  const onTelemetry = (rec) => {
    telemetry.event(rec);
    opts.onTelemetry?.(rec);
  };
  validateInvariants(config, { measuredMaxRatio: opts.measuredMaxRatio });

  const db = openDb(opts.dbPath ?? config.dbPath ?? ':memory:');
  const tokenizer = new Tokenizer(kvGet(db, CALIBRATION_KEY, {}));

  const raw = new RawEventStore(db, tokenizer);
  const state = new StateStore(db);
  const artifacts = new ArtifactStore(db);
  const lexical = new LexicalIndex(db);
  const llmClient = new LlmClient({
    llm: assertLlmPort(opts.llm),
    tokenizer,
    config,
    route: config.route,
    onTelemetry,
  });
  const episodes = new EpisodeManager({
    raw, db, tokenizer, config, llmClient, onTelemetry,
  });
  const retriever = new Retriever({
    db, raw, tokenizer, lexical, state, config,
    semantic: opts.semantic ?? null,
    // 摘要检索源：让"换个说法"的查询也能召回（关键词检索的平价语义补充）
    episodes: episodes.episodes,
  });
  // 扫描结果共享：Runtime 写入，Compiler 读取（避免二者互相持有）
  const scanState = new Map();
  const scanner = new GlobalScanner({
    raw, tokenizer, llmClient, config, episodes, onTelemetry,
  });
  const compiler = new Compiler({ raw, state, retriever, tokenizer, config, episodes, scanState, artifacts });
  // 队列先于 Runtime 构造并注入：作业经 ctx.runtime 取运行时，
  // 因此不存在"构造后再赋值"的隐式耦合
  const maintenance = createStandardQueue({ verifyRebuildability, auditState });
  const runtime = new Runtime({
    db, raw, state, artifacts, compiler, llmClient, tokenizer, config, episodes, scanner, scanState, lexical,
    retriever,
    maintenance,
    onTelemetry,
  });

  // §22.3：语义索引状态在启动时即记录，缺失时明确标记为降级
  onTelemetry({ event: 'semantic_index_status', ...runtime.semanticStatus() });

  return {
    config,
    db,
    tokenizer,
    raw,
    state,
    artifacts,
    lexical,
    retriever,
    compiler,
    llmClient,
    episodes,
    scanner,
    maintenance,
    telemetry,
    rebuildSearchIndex: (sessionId) => rebuildSearchIndex({ db, sessionId }),
    verifyRebuildability: (sampleSize) => verifyRebuildability({ db, lexical, sampleSize }),
    audit: (sessionId, applySafeFixes) => auditState({ state, raw, sessionId, applySafeFixes }),
    runtime,
    /** 持久化 token 标定（§9.6 的在线校准结果） */
    persistCalibration() {
      kvSet(db, CALIBRATION_KEY, tokenizer.snapshot());
    },
    close() {
      this.persistCalibration();
      db.close();
    },
  };
}
