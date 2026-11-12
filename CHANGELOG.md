# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-13

### 破坏性修复

- **撤销 `ptc-runtime.maxOutputBytes` 覆盖**（64 MiB → 8 MiB）：
  该值是**硬上限**，超限时宿主会让整次 `run_code` 以 `output-limit` **失败**（不是截断），
  stdout/stderr 与最终返回值都计入同一上限。
  等于用"省内存"静默破坏用户的核心工具。原立论"stderr 缓冲跨 run 不清"也不成立：
  `this.stderr` 是宿主内 PTC runtime 实例的单个字段，且每次 evaluate 开始就被清空。
  证据：`dsh-ptc-runtime-node/lib/index.js:985-995`、`:693-711`、`:950`、`:1137`。

### 修复

- **撤销 `session-projection-cache` 覆盖**（200/5000 → 50/2000）：
  dirty 状态只存 `pending` 计数器和 timer，**不缓存任何事件体**；
  收紧只是把 checkpoint 写入频率提高约 4×，零内存收益、纯 I/O 放大。
  证据：`dsh-session-projection-cache/lib/index.js:293-312`。
- **撤销 `jobs` / `typert-gateway` 覆盖**：值恰等于 schema 默认，纯 no-op。
- **回收量口径拆分**：`reclaimedBytes` → `rssDeltaBytes`（进程级 RSS 净变化）
  与 `nativeReleasedBytes`（原生自报的释放量，仅 macOS 有）。
  旧口径把三件事混成一个数，在 Windows 上语义完全相反。
  新增 `mechanism.kind`：`reclaim`（真的还给 OS）/ `swap-out`（换出到页面文件）。
- **活跃判定改用宿主真实信号**：原先"最近 30 秒有没有工具活动"会把长时间流式回合
  误判成空闲。改用 `agent/status`（`idle`/`running`）并新增 `agent/disposed`、
  `session/disposed` 订阅。
- **配置加下界**：`hardCapBytes` 的判定先于"是否空闲"，`hardCapBytes=0` 会让
  "是否回收"恒为真（每 15 秒无条件 trim）。现要求
  `thresholdBytes ≥ 16 MiB`、`hardCapBytes ≥ 256 MiB`（且必须大于阈值）、
  `minIntervalMs ≥ 5 s`、`idleIntervalMs ≥ 30 s`、`sampleIntervalMs ≥ 1 s`。
- **失败时不更新阈值基线**：否则一次失败就把"增长量"清零，可能长期不再触发。
- **并发保护**：回收进行中时后来的请求返回 `skipped: in-flight`，避免统计重复计入。
- **配置写盘失败时返回 `ok:false`**，UI 不再显示"已保存"。
- **只落盘用户显式改过的键**，上游改行内默认配置后本机仍能拿到新值。
- **musl 分支重写**：原先先 `load('libc.so.6')` 再判 musl，而 musl **没有 libc.so.6**
  （soname 是 `libc.musl-x86_64.so.1`），所以真实 musl 上永远走不到 musl 分支，
  用户只会看到无用的"加载 libc.so.6 失败"。现在加载失败与符号缺失都能识别出 musl。
- **`--expose-gc` flag 用完即还原**（`--no-expose_gc`），不在宿主里留下多余入口。
- **日志改用 `ctx.logger`**，不再直接写 stdout。

### 新增

- **配置层新增 `experimental-inspector` 覆盖**：官方 Inspector 默认 `captureFetch: true`，
  把每个 fetch 的 request/response body 转 base64 存进**进程内**的 journal
  （上限 256 MiB / 2000 条 / 单请求 8 MiB / 单响应 32 MiB）。
  这些是**活引用**，`malloc_trim` 永远收不回来，只能从源头限制。
  现收紧为 64 MiB / 200 条 / 1 MiB / 4 MiB。
  证据：`dsh-experimental-inspector/lib/index.js:36,1746-1752,2565-2590`。
- **新增观测**：峰值 RSS（VmHWM）、glibc `[heap]` 常驻、按触发原因分类的次数、
  活跃 agent 数。
- **新增 `allocator` 段**：检测宿主是否以 `MALLOC_MMAP_THRESHOLD_` 启动，并给出建议。
- **新增 `scripts/wine-win32-smoke.mjs`**：用 Wine + Windows Node 做 Windows 路径实机验证。
  已验证 `EmptyWorkingSet` **只在 psapi.dll 导出**（kernel32.dll 里没有），
  `EmptyWorkingSet(GetCurrentProcess())` 返回 true、耗时 0 ms。

### 文档

- README 补上**启动环境层的根因修复**：
  `MALLOC_MMAP_THRESHOLD_=131072 dsh --profile web`
  实测峰值 RSS 726–1097 MiB → **175 MiB**（-80%）、可回收碎片 543–928 MiB → **8 MiB**（-98%）、
  trim 耗时 22–42 ms → **0.7–1.3 ms**（5 次重复）。
  并明确列出**不要用**的手段及其实测依据
  （`MALLOC_ARENA_MAX` 不减少碎片、运行时 `mallopt` 改不动 arena 上限、
  `v8.setFlagsFromString` 改不动 heap limit、heap limit 降到 512 MiB 会 abort 宿主）。

### 首版能力（本次发布即包含）

- **L1 原生分配器回收**：定时通过 koffi FFI 调用平台原生接口把内存碎片还给操作系统。
  - Linux (glibc)：`malloc_trim(0)`
  - macOS：`malloc_zone_pressure_relief(malloc_default_zone(), 0)`
  - Windows：`EmptyWorkingSet(GetCurrentProcess())`
  - 其它平台（含 musl）自动降级并在设置页说明原因
- **触发策略**：硬上限 / 增长阈值（要求会话空闲）/ 空闲兜底三条路径，外加最小间隔保护。
- **L2 配置层收紧**：覆盖 `ui-trajectory` 的 `maxResultsPerSession`（默认 1000，
  实测在活体宿主里就占 54.68 MiB）。
- **L3 设置页**：显示 RSS / V8 堆 / external、机制可用性、累计回收量，可手动回收。
- 可选的 V8 GC 开关（`gcEnabled` / `gcMode`），默认关闭。
- HTTP 接口 `/api/dsh-lowmem/{stats,trim,config}`，供设置页与自检脚本共用。

### 已知限制

- 覆盖官方行时 `config` 是整体替换：每次升级 DSH 后请跑一次
  `dsh --profile web --dump-config`，确认没有 `patch: entry "x" not found`。
- 预设平面里的 `tool-result-pruner` 阈值**顶层 patch 够不到**，本插件不依赖它。
- 会话驱逐、MCP 工具注销、运行时裁剪工具结果列入二期。
