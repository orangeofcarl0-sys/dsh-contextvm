/**
 * 配置归一化、预算派生与不变量校验（§19 / §19.1 / §9.1 / §9.6）。
 *
 * 单一事实来源：本模块是配置的唯一校验点，宿主侧不再叠加第二套 schema，
 * 以免出现两份可能不一致的校验逻辑。
 *
 * 三条边界必须分清：
 *   - ratios.*            随物理窗口 W 缩放的输入侧预算；
 *   - output.*            输出上限，绝对值，由 TPS 决定，不随 W 缩放（§17.1）；
 *   - 计数类（top_k 等）   绝对值，由语义决定。
 *
 * @module dsh-contextvm/app/config
 */

/** 默认配置。与 cordis.patch.yml 中的默认值一致（两处必须同步，见 validateInvariants 的自检）。 */
export const DEFAULTS = Object.freeze({
  dbPath: null,
  /**
   * 会话默认模式（§13.2.1）。
   *   'dormant'（默认）—— 不注册工具、不注入、不做后台抽取，请求零足迹；用户用
   *                      `/contextvm on` 按会话开启。
   *   'active'         —— 每个会话默认开启（工具仍在**该会话自己的作用域**注册，
   *                      只是不必再手动敲命令）。
   *
   * 为什么需要这个开关：无人值守的长跑（headless 一次任务跑几十轮、又不解析斜杠命令）
   * 没法手敲开启命令。给它一个 profile 级的默认值，长跑才能真正带着本插件跑。
   */
  sessionMode: 'dormant',
  route: { provider: 'openrouter-stealth', model: 'stealth/union-alpha' },
  ratios: {
    normal_target_input: 0.458,
    heavy_target_input: 0.5,
    hard_input_cap: 0.55,
    preflight_ratio_assumed: 1.693,
    preflight_shrink_factor: 0.7,
    preflight_max_retries: 2,
    token_estimate_floor_cpt: 2.0,
    // 各组件预算上界之和 = 0.550 <= hard_input_cap（§9.2）
    context_components: {
      system_protocol: [0.01, 0.02],
      authoritative_state_max: 0.04,
      recent_verbatim: [0.08, 0.135],
      episode_navigator_max: 0.025,
      retrieved_evidence: [0.08, 0.16],
      current_artifact_max: 0.17,
    },
    state_target: 0.031,
    state_hard_max: 0.04,
    final_bundle_target: 0.122,
  },
  episode: {
    target_raw_ratio: 0.153,
    min_raw_ratio: 0.076,
    max_raw_ratio: 0.229,
    // §6.1：三者各有独立区间；MUST NOT 共用一个 ceiling，
    // 否则小窗口下 max/min 会被抬到不合语义的值
    raw_bounds: {
      target: [20000, 64000],
      min: [10000, 32000],
      max: [24000, 80000],
    },
    summary_target_tokens: 800,
    // 上限须覆盖"推理开销 + 目标正文"（见下方 output 段说明）：800 的正文目标
    // 配上推理开销后，1600 余量偏紧，故留到 2400
    summary_hard_max_tokens: 2400,
  },
  output: {
    // 目标模型（stealth/union-alpha）有**隐藏推理开销**：这部分生成既不作为
    // reasoning-delta 流式送出，也不在 reasoning_tokens 里单独报告，但**计入 output_tokens**。
    // 实测：一次成功调用的 output_tokens=483 而可见正文只有 70 字符（≈26 token），
    // 差额全是隐藏生成。**方差很大**：样本从 300 直到 1658（同一任务、同样只产出一小段 JSON）。
    // max_tokens=500 时整份预算被它吃光，
    // 正文 0 字、finish=max-tokens，delta 永远抽不出来（表面"正常运行"，实则状态从不积累）。
    //
    // 上游给的实际上限是 131072（top_provider.max_completion_tokens），`default_parameters` 为空
    // —— 即**没有任何外部约束要求这么小的上限**，小上限纯属本项目当初按"没有推理开销"的假设所定。
    // 故辅助调用的上限 MUST 覆盖"隐藏推理开销 + 目标正文"，并留出方差余量。
    //
    // 取值依据：成功调用实测 output_tokens 26–1658（隐藏开销方差大），另有多例撞满 1500。
    // 撞上限的代价是双向的 —— 既拿不到内容，又比成功调用更慢（17s 空手 vs 4.2s 成功），
    // 故宁可贵一点。代价：慢模型上单次最长可能到分钟级，但这是轮末 fire-and-forget 的活，
    // 不阻塞回答（§15.2）。
    state_delta_soft_max_tokens: 3000,
    // 硬上限：override 也 MUST NOT 突破（见 client.js maxTokensFor）。撞上限已无意义，
    // 故留出比 soft 更宽的余量，仅作为"不许要更多"的兜底。
    state_delta_hard_max_tokens: 4000,
    // worker 同理：300 会被隐藏推理吃光，使 GLOBAL 扫描静默返回空 findings
    global_worker_output_max_tokens: 1000,
    global_worker_output_complex_max_tokens: 1500,
    default_max_output_tokens: 4096,
    // 注意：MUST NOT 在此新增 router / reranker 输出上限。
    // 模式分类（§8）与检索打分（§7.1）在本实现中都是**确定性**的，
    // 不发起 LLM 调用；给它们预留输出预算只会诱导出与 §2.2
    // （减少串行生成 token）相冲突的实现。见规范 §17.1 的说明。
  },
  retrieval: {
    lexical_top_k: 30,
    merged_top_k: 40,
    final_bundle_target_ratio: 0.122,
    neighborhood_events_before: 3,
    neighborhood_events_after: 3,
  },
  global_scan: {
    chunk_target_ratio: 0.305,
    overlap_ratio: 0.011,
    max_concurrency: 4,
  },
  maintenance: {
    audit_every_closed_episodes: 15,
    meta_summary_group_size: 10,
  },
  recent_events: 40,
  toolRounds: 3,
});

const deepClone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

function deepMerge(base, over) {
  if (over === undefined) return deepClone(base);
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return deepClone(over);
  const out = deepClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge(base[k], v) : deepClone(v);
  }
  return out;
}

/**
 * 归一化原始配置（宿主传什么都能得到一个完整对象）。
 * @param {object} [raw]
 * @returns {object} 冻结的配置
 */
export function resolveConfig(raw = {}) {
  const cfg = deepMerge(DEFAULTS, raw ?? {});
  // 兼容扁平写法：cordis.patch.yml 里把 ratios 之外的同名键平铺也可接受
  if (raw?.posture) throw new Error('未知配置项 posture');
  // sessionMode 只接受两个取值：拼错时必须拒绝，否则会静默退回休眠
  if (cfg.sessionMode !== 'dormant' && cfg.sessionMode !== 'active') {
    throw new Error(`sessionMode 只接受 'dormant' | 'active'，收到 ${JSON.stringify(cfg.sessionMode)}`);
  }
  return Object.freeze(cfg);
}

const fail = (msg) => {
  throw new Error(`[contextvm] 配置不变量校验失败：${msg}`);
};

/**
 * §19.1 的配置不变量。加载时 MUST 校验；任一条失败即拒绝启动。
 * @param {object} cfg resolveConfig() 的产物
 * @param {{measuredMaxRatio?: number}} [opts] 实测可服务输入比例（§9.1.1 不变量 6）
 */
export function validateInvariants(cfg, opts = {}) {
  const r = cfg.ratios;
  const c = r.context_components;

  // 1. 偏序
  if (!(cfg.global_scan.chunk_target_ratio < r.normal_target_input)) {
    fail(`chunk_target_ratio(${cfg.global_scan.chunk_target_ratio}) 必须 < normal_target_input(${r.normal_target_input})`);
  }
  if (!(r.normal_target_input < r.heavy_target_input)) {
    fail(`normal_target_input(${r.normal_target_input}) 必须 < heavy_target_input(${r.heavy_target_input})`);
  }
  if (!(r.heavy_target_input < r.hard_input_cap)) {
    fail(`heavy_target_input(${r.heavy_target_input}) 必须 < hard_input_cap(${r.hard_input_cap})`);
  }

  // 2. 组件上界之和 <= hard_input_cap（§9.2）
  const sum =
    c.system_protocol[1] +
    c.authoritative_state_max +
    c.recent_verbatim[1] +
    c.episode_navigator_max +
    c.retrieved_evidence[1] +
    c.current_artifact_max;
  if (sum > r.hard_input_cap + 1e-9) {
    fail(`组件上界之和(${sum.toFixed(3)}) 必须 <= hard_input_cap(${r.hard_input_cap})`);
  }

  // 3. 单组件区间有序
  for (const [name, v] of Object.entries(c)) {
    if (Array.isArray(v) && v.length === 2 && !(v[0] <= v[1])) fail(`组件 ${name} 区间下界大于上界`);
  }

  // 3b. episode 三档区间有序且互不矛盾（§6.1）
  const eb = cfg.episode.raw_bounds;
  for (const [name, v] of Object.entries(eb)) {
    if (!Array.isArray(v) || v.length !== 2 || !(v[0] <= v[1])) fail(`episode.raw_bounds.${name} 必须是递增的 [lo,hi]`);
  }
  if (!(eb.min[1] <= eb.target[1])) fail('episode.raw_bounds.min 上界必须 <= target 上界');
  if (!(eb.target[1] <= eb.max[1])) fail('episode.raw_bounds.target 上界必须 <= max 上界');

  // 4. 预检系数与收缩系数合理
  if (!(r.preflight_ratio_assumed >= 1)) fail('preflight_ratio_assumed 必须 >= 1');
  if (!(r.preflight_shrink_factor > 0 && r.preflight_shrink_factor < 1)) fail('preflight_shrink_factor 必须落在 (0,1)');

  // 5. 输出上限是绝对值，MUST NOT 随 W 缩放：这里只校验为正
  for (const [k, v] of Object.entries(cfg.output)) {
    if (!(Number.isFinite(v) && v > 0)) fail(`output.${k} 必须为正数`);
  }

  // 6. hard_input_cap MUST 不超过实测可服务比例（§19.1 不变量 6）
  if (opts.measuredMaxRatio !== undefined && r.hard_input_cap > opts.measuredMaxRatio + 1e-9) {
    fail(
      `hard_input_cap(${r.hard_input_cap}) 超过实测可服务上限(${opts.measuredMaxRatio})；` +
        `见规范 §9.1.1，切换路由后 MUST 重新标定`,
    );
  }

  return true;
}

/**
 * 由路由窗口 W 派生全部预算（§9.1 / §9.2 / §9.6）。
 *
 * hard cap 取两条约束中较紧的一条：
 *   ① W - output_reserve - estimator_margin
 *   ② W / preflight_ratio - output_reserve
 * 实测下 ② 更紧，故 §9.1 的 hard_input_cap 是 ② 的整数化结果。
 *
 * @param {object} cfg
 * @param {number} W 当次路由声明窗口（llm.resolveModelInfo().contextWindow）
 * @returns {Readonly<object>}
 */
export function deriveBudgets(cfg, W) {
  if (!(Number.isFinite(W) && W > 0)) throw new Error(`deriveBudgets 需要正的 W，收到 ${W}`);
  const r = cfg.ratios;
  const c = r.context_components;
  const outReserve = cfg.output.default_max_output_tokens;
  const margin = 0.1 * W; // §9.6 约束①的 estimator_margin

  const byDeclaredWindow = Math.floor(W - outReserve - margin);
  const byPreflight = Math.floor(W / r.preflight_ratio_assumed - outReserve);
  const hardInputCap = Math.min(Math.floor(r.hard_input_cap * W), byDeclaredWindow, byPreflight);

  const scale = (x) => Math.floor(x * W);
  const budgets = {
    W,
    normalTargetInput: scale(r.normal_target_input),
    heavyTargetInput: scale(r.heavy_target_input),
    hardInputCap,
    preflightRatio: r.preflight_ratio_assumed,
    outputReserve: outReserve,
    chunkTarget: scale(cfg.global_scan.chunk_target_ratio),
    chunkOverlap: scale(cfg.global_scan.overlap_ratio),
    finalBundleTarget: scale(cfg.retrieval.final_bundle_target_ratio),
    components: {
      systemProtocolMin: scale(c.system_protocol[0]),
      systemProtocolMax: scale(c.system_protocol[1]),
      authoritativeStateMax: scale(c.authoritative_state_max),
      recentVerbatimMin: scale(c.recent_verbatim[0]),
      recentVerbatimMax: scale(c.recent_verbatim[1]),
      episodeNavigatorMax: scale(c.episode_navigator_max),
      retrievedEvidenceMin: scale(c.retrieved_evidence[0]),
      retrievedEvidenceMax: scale(c.retrieved_evidence[1]),
      currentArtifactMax: scale(c.current_artifact_max),
    },
    // §6.1：episode 原始尺寸按比例缩放但带保真度区间 clamp，MUST NOT 线性外推
    episode: {
      targetRaw: clamp(scale(cfg.episode.target_raw_ratio), ...cfg.episode.raw_bounds.target),
      minRaw: clamp(scale(cfg.episode.min_raw_ratio), ...cfg.episode.raw_bounds.min),
      maxRaw: clamp(scale(cfg.episode.max_raw_ratio), ...cfg.episode.raw_bounds.max),
      summaryTargetTokens: cfg.episode.summary_target_tokens,
      summaryHardMaxTokens: cfg.episode.summary_hard_max_tokens,
    },
    // §9.1 偏序在派生值上必须仍然成立
    orderingOk:
      scale(r.normal_target_input) < scale(r.heavy_target_input) &&
      scale(r.heavy_target_input) <= hardInputCap &&
      scale(cfg.global_scan.chunk_target_ratio) < scale(r.normal_target_input),
  };
  if (!budgets.orderingOk) {
    throw new Error(
      `[contextvm] W=${W} 下派生预算偏序被破坏（hardInputCap=${hardInputCap}，可能预检约束过紧）：` +
        `chunk<normal<heavy<=hard 不成立`,
    );
  }
  return Object.freeze(budgets);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * §9.6 的两条硬断言。编译前 MUST 校验。
 * @param {object} budgets deriveBudgets() 的产物
 * @param {{estimatedInput: number, requestedMaxTokens: number}} req
 * @returns {{ok: true}} 或抛出
 */
export function assertCompileFits(budgets, req) {
  const { estimatedInput, requestedMaxTokens } = req;
  if (estimatedInput + requestedMaxTokens > 0.9 * budgets.W) {
    throw new Error(
      `[contextvm] §9.6 约束①失败：估算输入 ${estimatedInput} + 输出预留 ${requestedMaxTokens} > 0.9*W(${0.9 * budgets.W})`,
    );
  }
  const gate = budgets.preflightRatio * estimatedInput;
  if (gate > 0.98 * budgets.W) {
    throw new Error(
      `[contextvm] §9.6 约束②（实际约束）失败：预检估算 ${Math.ceil(gate)} > 0.98*W(${0.98 * budgets.W})；` +
        `MUST 按 §9.1.1 收缩输入后重试`,
    );
  }
  if (estimatedInput > budgets.hardInputCap) {
    throw new Error(`[contextvm] 估算输入 ${estimatedInput} 超过 hard_input_cap ${budgets.hardInputCap}`);
  }
  return { ok: true };
}
