# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-12

### 新增

- **L1 原生分配器回收**：定时通过 koffi FFI 调用平台原生接口把内存碎片还给操作系统。
  - Linux (glibc)：`malloc_trim(0)`
  - macOS：`malloc_zone_pressure_relief(malloc_default_zone(), 0)`
  - Windows：`EmptyWorkingSet(GetCurrentProcess())`
  - 其它平台（含 musl）自动降级并在设置页说明原因
- **触发策略**：硬上限 / 增长阈值（要求会话空闲）/ 空闲兜底三条路径，外加最小间隔保护。
- **L2 配置层收紧**：覆盖 `ui-trajectory`、`ptc-runtime`、`jobs`、`session-projection-cache`、
  `typert-gateway`、`spill-policy` 六个顶层行的保留上限。
- **L3 观测与手动回收**：设置页显示 RSS / V8 堆 / external、机制可用性、累计回收量，
  并提供"立即回收"按钮。
- 可选的 V8 GC 开关（`gcEnabled` / `gcMode`），默认关闭。
- HTTP 接口 `/api/dsh-lowmem/{stats,trim,config}`，供设置页与自检脚本共用。

### 已知限制

- 覆盖官方行时 `config` 是整体替换：每次升级 DSH 后请跑一次
  `dsh --profile web --dump-config`，确认没有 `patch: entry "x" not found`。
- 预设平面里的 `tool-result-pruner` 阈值**顶层 patch 够不到**，本插件不依赖它。
- 会话驱逐、MCP 工具注销、运行时裁剪工具结果列入二期。
