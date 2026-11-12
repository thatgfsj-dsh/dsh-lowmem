# dsh-lowmem 内部契约（v2 —— 红蓝对抗后修订）

> 唯一事实来源。改动这里列出的形状，必须先改本文件再改代码。
> 本版依据：红队审查 + 蓝队调查 + lead 独立实测（2026-11-13）。

## 0. 本版修订摘要（相对 v1）

| 变更 | 原因 | 证据 |
|---|---|---|
| **撤销** `ptc-runtime.maxOutputBytes` 覆盖 | 它是**硬上限**，超限让整次 `run_code` **失败**（不是截断）。64→8 MiB 等于静默破坏用户的核心工具 | `dsh-ptc-runtime-node/lib/index.js:985-995`（`finish({kind:"output-limit"})`）、`:693-711`（OutputLedger 硬上限，stdout/stderr 都计入，`success()` 也计入） |
| **撤销** `session-projection-cache` 覆盖 | dirty 状态只存 `pending` 计数器和 timer，**不缓存事件体**。收紧只是把 checkpoint 写入频率提高约 4×，零内存收益 | `dsh-session-projection-cache/lib/index.js:293-312`（`dirty = new Map()`，state 只有 `{pending, timer}`） |
| **撤销** `jobs` / `typert-gateway` 覆盖 | 值恰等于 schema 默认，今天是纯 no-op；留着反而让人误以为在防什么 | `dsh-jobs-local/lib/index.js:357-361`、`dsh-api-gateway/lib/index.js:762-766` |
| **新增** `experimental-inspector` 覆盖 | 它默认 `captureFetch: true`，把每个 fetch 的 request/response body 转 base64 存进 journal，上限 **256 MiB / 2000 条 / 8 MiB 请求体 / 32 MiB 响应体**。这些是**活引用**，`malloc_trim` 永远收不回 | `dsh-experimental-inspector/lib/index.js:36`（劫持 globalThis.fetch）、`:1746-1752`（默认上限）、`:2565-2590`（schema）；worker `lib/worker.js:518-521,743,752`（journal/journalBytes） |
| 保留 `ui-trajectory.maxResultsPerSession` | 实测子树 54.68 MiB，且**按条数不按字节**淘汰 | `dsh-client-ui-trajectory/lib/index.js:135`（`.default(1e3)`）、README:70 |
| 回收量口径拆分 | RSS 差值 ≠ "释放给 OS 的字节"；Windows 上语义相反（换出而非释放） | 见 §2.5 |
| 活跃判定改用 `agent.status` | 30 s 工具活动窗口会漏判长流式回合 | `dsh-agent-loop/lib/index.js:554-556`、`dsh-agent/lib/types/runtime-types.d.ts:115`（`'idle'|'running'`） |
| 阈值加下界 | `hardCapBytes=0` 会让 `decideTrim` 恒返回 true（该分支**先于** activeTurn/minInterval 判定），每 15 s 无条件 trim | `src/host/policy.mjs:47` |
| musl 分支重写 | musl **没有 libc.so.6**（soname 是 libc.musl-x86_64.so.1），原来先 load 再判 musl 的写法永远走不到 musl 分支 | `src/host/trim/linux.mjs:41,50-59` |

## 1. 包名与路由

- npm 包名 / 客户端模块 id：`dsh-lowmem`
- 宿主行 id = 行 name = `dsh-lowmem`
- HTTP 前缀：`/api/dsh-lowmem`

## 2. 宿主半边

### 2.1 `src/host/trim/index.mjs`

```js
/**
 * @typedef {object} TrimOutcome
 * @property {boolean} ok
 * @property {number} rssDeltaBytes   - 调用前后 RSS 差值（进程级净变化，>=0）。
 * @property {number|null} nativeReleasedBytes - 原生机制自报的释放字节数；没有则为 null。
 * @property {number} durationMs
 * @property {string} [error]
 *
 * @typedef {object} Trimmer
 * @property {boolean} available
 * @property {string|null} name
 * @property {'reclaim'|'swap-out'|null} kind - reclaim=真的还给 OS；swap-out=换出到页面文件（Windows）。
 * @property {string} detail
 * @property {(opts?: {rssBytes?: number}) => TrimOutcome} trim
 */
export async function createTrimmer(options = {}) {}
```

硬性要求：

1. **永不抛出**。
2. **懒加载 koffi**（`await import('koffi')` 在函数内）。
3. **可注入**：`options.loadKoffi` / `options.platform`。
4. 平台策略：
   - `linux`：`libc.so.6` → `int malloc_trim(size_t)`，调 `trim(0)`；**glibc 返回值是标志位不是字节数**。
   - `darwin`：`/usr/lib/libSystem.B.dylib` → `malloc_default_zone()` + `malloc_zone_pressure_relief(zone, 0)`，**返回值是字节数**。
   - `win32`：`psapi.dll` → `bool EmptyWorkingSet(void*)` + `kernel32.dll` → `void* GetCurrentProcess()`。
     **注意：EmptyWorkingSet 只在 psapi.dll 导出，kernel32.dll 里没有**（Wine 实测：`Cannot find function 'EmptyWorkingSet' in shared library`）。
   - 其它 / musl：`available:false`，detail 必须能区分 musl（musl 没有 libc.so.6，load 就失败）。
5. **回收量**：`rssDeltaBytes` 以调用前后 RSS 差值为准；`nativeReleasedBytes` 只在原生确实返回字节数时填（macOS），否则 null。

### 2.2 `src/host/sampler.mjs`

```js
export function sampleMemory() {
  return {
    rssBytes, heapTotalBytes, heapUsedBytes, externalBytes, arrayBufferBytes,
    uptimeSeconds, pid,
    rssPeakBytes,      // VmHWM
    heapResidentBytes, // glibc [heap] 常驻（Linux 才有，其它平台 null）
  }
}
```

### 2.3 `src/host/policy.mjs`

```js
/**
 * @typedef {object} TrimConfig
 * @property {boolean} enabled
 * @property {number} thresholdBytes
 * @property {number} minIntervalMs
 * @property {number} idleIntervalMs
 * @property {number} hardCapBytes
 * @property {number} sampleIntervalMs
 *
 * @typedef {object} TrimState
 * @property {number} rssBytes
 * @property {number} lastTrimAt
 * @property {number} lastTrimRssBytes
 * @property {boolean} activeTurn
 * @property {number} lastActivityAt
 */
export function decideTrim(state, config, now) {}
```

判定顺序（先命中先返回）：

| # | 条件 | reason |
|---|---|---|
| 1 | `!config.enabled` | `disabled` |
| 2 | `rssBytes >= hardCapBytes` | `hard-cap` |
| 3 | `rss - lastTrimRssBytes >= thresholdBytes` 且 `now - lastTrimAt >= minIntervalMs` 且 `!activeTurn` | `threshold` |
| 4 | `now - lastActivityAt >= idleIntervalMs` 且 `now - lastTrimAt >= minIntervalMs` | `idle` |
| 5 | 其它 | `below-threshold` |

### 2.4 配置下界（`src/host/settings.mjs` 必须强制）

| 键 | 下限 | 上限 | 说明 |
|---|---|---|---|
| `thresholdBytes` | 16 MiB | — | 低于 16 MiB 会被正常增长反复触发 |
| `hardCapBytes` | 256 MiB | — | 且必须 > `thresholdBytes` |
| `minIntervalMs` | 5 s | — | 防止高频反复 trim |
| `idleIntervalMs` | 30 s | — | |
| `sampleIntervalMs` | 1 s | — | |
| `gcMode` | `'minor'` 或 `'major'` | | **禁止 `major-snapshot`**（实测 10.7 s 且把 RSS 顶高 777 MB） |

写盘只写**用户显式改过的键**，不写整份配置（否则上游改默认后被本地旧值粘住）。

### 2.5 HTTP 接口

#### `GET /api/dsh-lowmem/stats`

```json
{
  "ok": true,
  "platform": "linux",
  "mechanism": { "available": true, "name": "malloc_trim", "kind": "reclaim",
                 "detail": "glibc malloc_trim(0)" },
  "memory": { "rssBytes": 0, "heapTotalBytes": 0, "heapUsedBytes": 0,
              "externalBytes": 0, "arrayBufferBytes": 0, "uptimeSeconds": 0, "pid": 0,
              "rssPeakBytes": 0, "heapResidentBytes": 0 },
  "trim": { "count": 0, "totalRssDeltaBytes": 0, "lastRssDeltaBytes": 0,
            "lastNativeReleasedBytes": null, "lastDurationMs": 0, "lastAt": 0,
            "lastReason": null, "lastError": null,
            "byReason": { "threshold": 0, "idle": 0, "hard-cap": 0, "manual": 0 } },
  "activity": { "running": false, "activeAgents": 0, "activeJobs": 0 },
  "allocator": { "mmapThresholdPinned": false,
                 "recommendedEnv": "MALLOC_MMAP_THRESHOLD_=131072",
                 "recommendation": "…" },
  "config": { }
}
```

**`allocator` 段是本版新增**：检测宿主是否以 `MALLOC_MMAP_THRESHOLD_` 启动。
实测：以该变量启动，峰值 RSS 从 726–1097 MiB 降到 **175 MiB**（-80%），
可回收碎片从 543–928 MiB 降到 **8 MiB**，trim 耗时从 22–42 ms 降到 0.7–1.3 ms（5/5 次）。

#### `POST /api/dsh-lowmem/trim`

请求体可选 `{ "force": true }`。并发进行中时返回 `{ "ok": false, "skipped": true, "reason": "in-flight" }`。

```json
{ "ok": true, "rssDeltaBytes": 0, "nativeReleasedBytes": null, "durationMs": 0,
  "before": { "rssBytes": 0 }, "after": { "rssBytes": 0 },
  "mechanism": { "available": true, "name": "malloc_trim", "kind": "reclaim", "detail": "…" } }
```

#### `GET /api/dsh-lowmem/config` → `{ "ok": true, "config": {...} }`
#### `PUT /api/dsh-lowmem/config` → `{ "ok": true, "config": {...}, "persisted": true }`；写盘失败 `ok:false`。

### 2.6 事件订阅（全部是 emit）

| 事件 | 用途 | 证据 |
|---|---|---|
| `tools/pre-execute` | waterfall，**必须 `(_exec, next) => next()`** | `dsh-tools/lib/pipeline.js:386` |
| `tools/result` | 观察者 | `pipeline.js:585` |
| `agent/status` | **精确**的活跃判定，载荷 `{agent, status}`，status ∈ idle/running | `dsh-agent/lib/types/runtime-types.d.ts:279-282`、`dsh-agent-loop/lib/index.js:562` |
| `agent/disposed` | 自然结束 → 延迟 1–2 s 回收 | `dsh-agent/lib/index.js:678-690` |
| `session/disposed` | 同上 | `dsh-session/lib/index.js:1949-1952` |

## 3. 客户端半边

- 只渲染 slot 里的 React 组件；不 iframe；不 `require` 任何 `@deepseek-ai/dsh-client-*`；
  不往 `document.body` 追加；样式只用 `--dsw-alias-*`。
- slot：`settings.section`。
- 文案按 `mechanism.kind` 分：`reclaim` → "已释放"；`swap-out` → "已换出到页面文件（后续访问可能变慢）"。
- locale：`locale/en.json` + `locale/zh.json`，各含 `{ "meta": { "title", "description" } }`。

## 4. 配置层（`cordis.patch.yml`）

只覆盖**顶层行**，**`config` 是整体替换，必须重述该行原有全部键**。

| 行 id | 覆盖 |
|---|---|
| `ui-trajectory` | `{ maxResultsPerSession: 200 }`（该行原本无 config） |
| `experimental-inspector` | `{ captureFetch: true, maxJournalBytes: 67108864, maxRetainedRequests: 200, maxRequestBodyBytes: 1048576, maxResponseBodyBytes: 4194304 }` |

> **profile 层会整块覆盖 bundle 层的 config**（`dsh-app-boot/lib/index.js:551`），
> 且 profile 层最后应用 → 用户自己写过同一行时本插件的覆盖会**静默失效**。
> 因此本覆盖必须是"最后一道"：文档里提示用户若不生效就改自己的 profile。

## 5. 红线

1. **不 import 任何 `@deepseek-ai/*` 包**。只用 Node 内置 + `koffi` + 仓库相对路径。
2. `koffi` 是普通依赖（不是 peer）。
3. 未在 `inject` 声明的 `ctx.<service>` 不可访问；可选服务用 `ctx.get()` 降级。
4. 覆盖官方行时 `config` 整体替换 → 重述全部原有键。
5. 有 `exports` 就必须导出 `./package.json` 与 `./locale/*.json`。
6. 单个代码文件 ≤ 1000 行。
7. **订阅宿主事件前必须先分清 emit 还是 waterfall**。waterfall 监听器签名是
   `(...事件参数, next)`，**必须调用并返回 `next()`**；漏掉会让宿主拿到 `gate=undefined`，
   读 `gate.kind` 抛错，**所有工具调用一起失败**。
   证据：`cordis/lib/index.js:904-915`（`Reflect.apply(callback, thisArg, [...args, next])`）。
8. **绝不通过"收紧官方输出上限"来省内存**：那些上限是**硬上限**，超限是**失败**不是截断
   （`dsh-ptc-runtime-node/lib/index.js:985-995`）。
9. 阈值必须带下界（§2.4），防止 0 值让判定恒真。
10. **失败时不更新阈值基线**：否则一次失败就把"增长量"清零，可能长期不再触发。

## 6. 启动环境层（文档必须写清）

宿主进程 = `node .../dsh web`。`NODE_OPTIONS` / `MALLOC_*` 属 **bootstrap-only** 名，
**不能写进 `.env`**（`dsh-app-boot/lib/index.js:4360`、`:4440 isBootstrapOnly`），
只能由启动环境给。

推荐：

```bash
# 首选：固定 glibc 的 mmap 阈值，阻止 arena 碎片形成（实测 -80% 峰值 RSS）
MALLOC_MMAP_THRESHOLD_=131072 dsh --profile web

# 可选：把 V8 堆上限从 4.19 GiB 压到 3 GiB（降限不会立刻降 RSS，但能给 OOM 设闸）
NODE_OPTIONS=--max-old-space-size=3072
```

**不要**用 `MALLOC_ARENA_MAX`（9 次重复实测：不减少碎片，可回收量中位数 682 vs 618 MiB，在噪声内；
且线程负载下 RSS 反而更高）、`v8.setFlagsFromString('--max-old-space-size=…')`（改不动 limit，实测前后都是 4496293888）、
把 heap limit 降到 512 MiB（OOM 会 abort 宿主）。
