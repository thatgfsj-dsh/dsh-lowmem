# dsh-lowmem 内部契约

> 所有参与者（宿主半边 / 客户端半边 / 测试）以本文件为唯一事实来源。
> 任何一方改动了这里列出的形状，必须先改本文件再改代码。

## 1. 包名与路由

- npm 包名 / 客户端模块 id：`dsh-lowmem`
- 宿主行 id = 行 name = `dsh-lowmem`（见 `cordis.patch.yml`）
- HTTP 前缀：`/api/dsh-lowmem`

## 2. 宿主半边模块

### 2.1 `src/host/trim/index.mjs`

```js
/**
 * @typedef {object} TrimOutcome
 * @property {boolean} ok           - 本次调用是否成功。
 * @property {number} reclaimedBytes - 释放/归还的字节数（>=0）。
 * @property {number} durationMs    - 调用耗时（毫秒）。
 * @property {string} [error]       - 失败原因（仅 ok=false 时）。
 *
 * @typedef {object} Trimmer
 * @property {boolean} available - 当前平台是否支持原生回收。
 * @property {string|null} name  - 机制名：'malloc_trim' | 'malloc_zone_pressure_relief' | 'EmptyWorkingSet' | null。
 * @property {string} detail     - 人类可读的状态说明（不支持时说明原因）。
 * @property {(opts?: {rssBytes?: number}) => TrimOutcome} trim - 执行一次回收。
 */

/**
 * 创建原生回收器。
 * @param {{platform?: string, loadKoffi?: () => Promise<object>, logger?: object}} [options]
 * @returns {Promise<Trimmer>}
 */
export async function createTrimmer(options = {}) { /* ... */ }
```

硬性要求：

1. **永不抛出**：`trim()` 的任何异常都必须被吞掉并转成 `{ ok:false, error, reclaimedBytes:0, durationMs }`。
2. **懒加载 koffi**：`import('koffi')` 必须在 `createTrimmer` 内部 await，不在模块顶层；
   加载失败 → `available:false`、`name:null`、`detail` 说明原因。
3. **可注入**：`options.loadKoffi` 允许测试注入假 koffi；`options.platform` 允许模拟平台。
4. **平台策略**：
   - `linux`：`libc.so.6` → `int malloc_trim(size_t)`，调用 `trim(0)`
   - `darwin`：`/usr/lib/libSystem.B.dylib` → `void* malloc_default_zone()` + `size_t malloc_zone_pressure_relief(void*, size_t)`
   - `win32`：`psapi.dll` → `bool EmptyWorkingSet(void*)` + `kernel32.dll` → `void* GetCurrentProcess()`
   - 其它平台：`available:false`，detail 写明"本平台暂不支持原生回收"
   - musl：`malloc_trim` 符号不存在（koffi 抛错）→ 走"不支持"分支，detail 区分 musl
5. **回收量**：以调用前后 `process.memoryUsage().rss` 差值为主；若差值为 0 但原生返回了字节数
   （darwin 的 `malloc_zone_pressure_relief` 返回释放字节数），用原生返回值。

### 2.2 `src/host/sampler.mjs`

```js
/**
 * 采一份内存快照。
 * @returns {{rssBytes:number, heapTotalBytes:number, heapUsedBytes:number,
 *   externalBytes:number, arrayBufferBytes:number, uptimeSeconds:number, pid:number}}
 */
export function sampleMemory() { /* ... */ }
```

### 2.3 `src/host/policy.mjs`（纯函数，必须可单测）

```js
/**
 * @typedef {object} TrimConfig
 * @property {boolean} enabled
 * @property {number} thresholdBytes   - 相对上次回收后 RSS 增长超过该值才回收。
 * @property {number} minIntervalMs    - 两次回收之间的最小间隔。
 * @property {number} idleIntervalMs   - 空闲多久后兜底回收。
 * @property {number} hardCapBytes     - RSS 超过该值立即回收（不看空闲）。
 * @property {number} sampleIntervalMs - 采样周期。
 *
 * @typedef {object} TrimState
 * @property {number} rssBytes
 * @property {number} lastTrimAt       - 上次回收时间戳（epoch ms），没有则 0。
 * @property {number} lastTrimRssBytes - 上次回收后的 RSS。
 * @property {boolean} activeTurn      - 当前是否有正在跑的会话轮次。
 * @property {number} lastActivityAt   - 上次活动时间戳（epoch ms）。
 *
 * @returns {{should:boolean, reason:string}}
 */
export function decideTrim(state, config, now) { /* ... */ }
```

判定顺序（先命中先返回）：

| # | 条件 | reason |
|---|---|---|
| 1 | `!config.enabled` | `disabled` |
| 2 | `state.rssBytes >= config.hardCapBytes` | `hard-cap` |
| 3 | `rss - lastTrimRssBytes >= thresholdBytes` 且 `now - lastTrimAt >= minIntervalMs` 且 `!activeTurn` | `threshold` |
| 4 | `now - lastActivityAt >= idleIntervalMs` 且 `now - lastTrimAt >= minIntervalMs` | `idle` |
| 5 | 其它 | `below-threshold` |

### 2.4 HTTP 接口（客户端与自检脚本共用）

所有响应 `Content-Type: application/json; charset=utf-8`。

#### `GET /api/dsh-lowmem/stats`

```json
{
  "ok": true,
  "platform": "linux",
  "mechanism": { "available": true, "name": "malloc_trim", "detail": "glibc malloc_trim(0)" },
  "memory": {
    "rssBytes": 1562000000, "heapTotalBytes": 665174016, "heapUsedBytes": 517361360,
    "externalBytes": 50926115, "arrayBufferBytes": 38197831,
    "uptimeSeconds": 38664, "pid": 1427847
  },
  "trim": {
    "count": 3, "totalReclaimedBytes": 925000000,
    "lastReclaimedBytes": 168000000, "lastDurationMs": 19, "lastAt": 1786545516616,
    "lastReason": "threshold", "lastError": null
  },
  "config": { "enabled": true, "thresholdBytes": 268435456, "minIntervalMs": 60000,
              "idleIntervalMs": 300000, "hardCapBytes": 3221225472, "sampleIntervalMs": 15000 }
}
```

#### `POST /api/dsh-lowmem/trim`

请求体可选：`{ "force": true }`（`force:true` 忽略阈值/空闲判定，立即回收）。
不带 `force` 时按策略判定，若判定不回收则返回 `{ "ok": false, "skipped": true, "reason": "..." }`。

```json
{ "ok": true, "reclaimedBytes": 168000000, "durationMs": 19,
  "before": { "rssBytes": 1730200000 }, "after": { "rssBytes": 1562200000 },
  "mechanism": { "available": true, "name": "malloc_trim", "detail": "glibc malloc_trim(0)" } }
```

#### `GET /api/dsh-lowmem/config`

→ `{ "ok": true, "config": {...} }`。

#### `PUT /api/dsh-lowmem/config`

请求体为 `config` 的**部分字段**；服务端合并后返回 `{ "ok": true, "config": {...}, "persisted": true }`。
只接受白名单键，其余忽略。写盘到 `~/.dsh/dsh-lowmem/settings.json`（写盘失败则只留内存态，`persisted:false`）。

> **同一个 path 只能注册一条路由**：宿主对同一 path 重复注册会抛错，而这个 effect 一抛错，
> 整个 scoped fiber 会被拆掉，连带把前面已注册的路由一起注销（表现为**全部路由 404**）。
> 所以 GET 与 PUT 合并进同一条路由的 `methods: ['GET', 'PUT']`，由 method 分派。

## 3. 客户端半边

- `src/client/*.js` 为源码，`client.js` 是 `scripts/build-client.mjs` 的**生成物**（提交生成物，不手改）。
- 构建产物形态与 `dsh-session-delete` 一致：`window.__ModuleLoader__.load({ id: 'dsh-lowmem', factory(require) { ... } })`。
- 客户端只通过上表的 HTTP 接口取数，**不得**直接读宿主进程。
- 组件只能渲染在 slot 里；样式只用 `--dsw-alias-*` 主题 token；不往 `document.body` 追加 DOM；
  不 `require` 任何 `@deepseek-ai/dsh-client-*`。
- slot：`settings.section`（设置页一个分区）。
- locale：`locale/en.json` + `locale/zh.json`，各含 `{ "meta": { "title", "description" } }`。

## 4. 配置层（`cordis.patch.yml`）

只覆盖**顶层行**，且 **`config` 是整体替换，必须重述该行原有全部键**。

| 行 id | 覆盖内容 |
|---|---|
| `ui-trajectory` | 新增 `config: { maxResultsPerSession: 200 }`（该行原本无 config） |
| `ptc-runtime` | 新增 `config: { maxOutputBytes: 8388608 }`（原本无 config） |
| `jobs` | 新增 `config: { maxConcurrentJobsPerOwner: 10, retainBytes: 262144, settledRetainBytes: 16384 }` |
| `typert-gateway` | 新增 `config: { streamInboxBytes: 262144 }`（原本无 config） |
| `session-projection-cache` | 重述 `writeEveryEvents: 50` + `writeIntervalMs: 2000` |
| `spill-policy` | 重述 `maxInlineTokens: 12500`（保持不变，显式写出防上游漂移） |

> **刻意不覆盖 `connection` 行**：`dsh-client-connection` 的 `maxRequestBodyBytes` 默认 300 MiB，
> 源码注释写明这是为「默认 200 MiB 图片总量经 base64 膨胀后的包络」预留的（需要 ~267.7 MiB）。
> 把它压到 16 MiB 会直接打断大图/附件上传，属于功能回退，因此**保持原值不动**。
>
> 覆盖不存在的 id 会被**静默跳过**，只有 `--dump-config` 会打印 `patch: entry "x" not found`。
> 每次升级上游后必须跑一次 `dsh --profile web --dump-config` 复核。

## 5. 红线

1. **不 import 任何 `@deepseek-ai/*` 包**（避免 `ERR_MODULE_NOT_FOUND` 且静默不加载）。只用 Node 内置 + `koffi` + 仓库相对路径。
2. `koffi` 是普通依赖，放 `dependencies`（不是 peer）。它的 optionalDependencies 已覆盖 win/linux/macos x x86/arm。
3. 访问未在 `inject` 声明的 `ctx.<service>` 会抛错并中止插件 → 必需服务进 `inject`，可选服务一律 `ctx.get()` 降级。
4. 覆盖官方行时 `config` 整体替换 → 必须重述全部原有键。
5. 有 `exports` 就必须导出 `./package.json` 与 `./locale/*.json`，否则图标与标题静默丢失。
6. 单个代码文件 ≤ 1000 行。
7. **订阅宿主事件前必须先分清 emit 还是 waterfall。**
   - `emit`（观察者）：返回值被忽略，可以随便返回。
   - `waterfall`（中间件）：监听器签名是 **`(...事件参数, next)`**，**必须调用并返回 `next()`**。
     漏掉 `next()` 会否决整条链与内置行为：宿主拿到的 `gate` 变成 `undefined`，
     随后读 `gate.kind` 抛 `Cannot read properties of undefined (reading 'kind')`，
     表现为**所有工具调用一起失败**（连 `run_code` 里的纯计算也跑不了），而且
     报错不指向插件本身，极难定位。
   - 已知归属：`tools/result` = emit；`tools/pre-execute` / `tools/execute` / `tools/post-execute` = waterfall。
   - 证据：`dsh-tools/lib/pipeline.js:386,492,673`（waterfall 调用点）、
     `:585`（`dispatch("emit", ...)`）、
     `cordis/lib/index.js:904-915`（`Reflect.apply(callback, thisArg, [...args, next])`）。
   - 守卫：`tests/hooks.test.mjs` 有三重检查——行为断言、**事件分级白名单**
     （订阅未分级事件直接失败）、waterfall 订阅必须出现 `next(`。新增订阅
     必须先把事件分类补进 `KNOWN_EVENT_MODES`。
