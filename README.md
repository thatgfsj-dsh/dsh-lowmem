# dsh-lowmem

**降低 DeepSeek Harness 宿主的常驻内存占用。**

DSH 跑久了 RSS 会一路涨（实测连续运行 10.7 小时后 1.8–2.7 GiB）。第一反应是"内存泄漏"，
但实测下来**不是**——真正的原因是**原生分配器的碎片**，V8 堆只占其中一小块。

| 手段 | 实测收益 | 代价 |
|---|---|---|
| 强制 GC（`--expose-gc`） | **仅 9.3 MiB** | major 140 ms / major-snapshot **10.7 s** 且把 RSS 顶高 777 MB |
| `malloc_trim(0)`（glibc） | **925 MB** | **19 ms** |

## 它做什么（宿主半边）

### L1 · 原生分配器回收

定时在合适的时机把碎片还给操作系统。全部经 **koffi FFI** 调用，**零编译**：

| 平台 | 机制 |
|---|---|
| Linux (glibc) | `malloc_trim(0)` |
| Linux (musl) | 不支持（无该符号）→ 自动降级并说明原因 |
| macOS | `malloc_zone_pressure_relief(malloc_default_zone(), 0)` |
| Windows | `EmptyWorkingSet(GetCurrentProcess())` |

触发路径：硬上限 → 增长阈值（要求会话空闲）→ 空闲兜底，外加最小间隔保护。
任何失败都吞掉降级，**绝不因回收失败影响宿主**。

### L2 · 配置层收紧

覆盖几个官方行里"按条数不按字节"的保留上限：

| 行 | 旋钮 | 原值 | 新值 |
|---|---|---|---|
| `ui-trajectory` | `maxResultsPerSession` | 1000 | 200 |
| `ptc-runtime` | `maxOutputBytes` | 64 MiB/worker | 8 MiB |
| `jobs` | `settledRetainBytes` 等 | schema 默认 | 显式声明 |
| `session-projection-cache` | `writeEveryEvents` / `writeIntervalMs` | 200 / 5000 | 50 / 2000 |

### HTTP 接口

`GET /api/dsh-lowmem/stats`、`POST /api/dsh-lowmem/trim`、`GET|PUT /api/dsh-lowmem/config`。
契约见 [`docs/CONTRACT.md`](docs/CONTRACT.md)。

## 安装

```bash
dsh plugin --profile web add dsh-lowmem
```

装完需重启 DSH。

## 许可证

MIT
