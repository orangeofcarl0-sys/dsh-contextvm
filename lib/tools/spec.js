/**
 * JSON Schema → 宿主参数规格的转换（§13.2）。
 *
 * 为什么需要它：`contextvm_commit_state` 的参数此前有**两份手写定义** ——
 * 提示词里的 JSON schema（`DELTA_TOOL.parameters`，也是文本 JSON 路径的校验依据）
 * 与工具注册用的宿主参数规格。二者已经漂移过一次，而且是真机才发现的：
 *
 *   提示词要求空增量写 `"next_action": null`，但宿主规格写的是 `{type:'string'}`，
 *   于是模型照着提示词调用时被宿主的参数校验拒绝：
 *     Error: invalid arguments: "next_action" must be a string
 *
 * 假宿主测试发现不了（假 defineTool 只做透传，从不校验）。因此改为**单一来源**：
 * 宿主规格一律由 JSON schema 派生，两侧不可能再不一致。
 *
 * 宿主词汇（dsh-tools `ValueSchemaSpec`）与 JSON Schema 的对应：
 *   `{}`（任意 JSON）      → `{ type: 'json' }`
 *   `{ type: ['T', 'null'] }` → `{ oneOf: [{ type: 'T' }, { type: 'null' }] }`（oneOf 至少两支）
 *   其余基本一一对应；object 必须显式声明 additionalProperties。
 *
 * @module dsh-contextvm/tools/spec
 */

/** 宿主支持的标量类型。 */
const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/**
 * 把一个 JSON Schema 节点转成宿主的值规格。
 * @param {any} node
 * @returns {object}
 */
function toValueSpec(node) {
  // 无约束（JSON Schema 里写作 `{}`）→ 宿主用 type:'json' 表达"任意无损 JSON"
  if (!node || typeof node !== 'object' || Object.keys(node).length === 0) return { type: 'json' };

  if (node.description !== undefined && Object.keys(node).length === 1) return { type: 'json' };
  const base = {};
  if (node.description !== undefined) base.description = node.description;
  if (node.enum !== undefined) base.enum = node.enum;

  // 可空类型：JSON Schema 的数组形式 type 对应宿主的 oneOf 联合
  if (Array.isArray(node.type)) {
    const branches = node.type.map((t) =>
      t === 'null' ? { type: 'null' } : toValueSpec({ ...node, type: t }),
    );
    if (branches.length < 2) throw new Error('oneOf 至少需要两支');
    return { ...base, oneOf: branches };
  }

  if (node.type === 'array') {
    return { ...base, type: 'array', ...(node.items ? { items: toValueSpec(node.items) } : {}) };
  }

  if (node.type === 'object' || node.properties) {
    // 宿主要求 object 显式声明 additionalProperties（缺省会直接拒绝编译）
    const additionalProperties = node.additionalProperties === undefined ? false : node.additionalProperties;
    const props = node.properties ? jsonSchemaToParameterSpec({ ...node, type: 'object' }) : undefined;
    return { ...base, type: 'object', additionalProperties, ...(props ? { properties: props } : {}) };
  }

  if (!node.type) return { type: 'json' };
  if (!SCALARS.has(node.type)) throw new Error(`宿主不支持的类型: ${node.type}`);
  return { ...base, type: node.type };
}

/**
 * 把对象型 JSON Schema 的 `properties` 转成宿主的参数规格（隐式 object 根）。
 * @param {{properties?: object, required?: string[]}} jsonSchema
 * @returns {Record<string, object>}
 */
export function jsonSchemaToParameterSpec(jsonSchema) {
  const required = new Set(jsonSchema?.required ?? []);
  const out = {};
  for (const [key, node] of Object.entries(jsonSchema?.properties ?? {})) {
    const spec = toValueSpec(node);
    out[key] = required.has(key) ? { ...spec, required: true } : spec;
  }
  return out;
}
