# dsh-lowmem

**降低 DeepSeek Harness 宿主的常驻内存占用。**

DSH 跑久了 RSS 会一路涨（实测连续运行 10.7 小时后 1.8–2.7 GiB）。第一反应是"内存泄漏"，
但实测下来**不是**——真正的原因是**原生分配器的碎片**，V8 堆只占其中一小块。

| 手段 | 实测收益 | 代价 |
|---|---|---|
| 强制 GC（`--expose-gc`） | **仅 9.3 MiB** | major 140 ms / major-snapshot **10.7 s** 且把 RSS 顶高 777 MB |
| `malloc_trim(0)`（glibc） | **925 MB** | **19 ms** |
| **`MALLOC_MMAP_THRESHOLD_=131072` 启动** | **峰值 RSS -80%** | **0**（见下） |

---

## ⚠️ 先看这个：更根本的办法在启动环境层

本插件的"定时 trim"是**治症状**。真正的根因是 **glibc 的动态 mmap 阈值**：
glibc 释放 mmap 块时会动态抬高 `mmap_threshold`（最高 32 MiB），
于是后续"本该走 mmap 的大块"改为从堆顶切走，在堆里堆出碎片。

**把阈值钉死，碎片就不会形成**：

```bash
MALLOC_MMAP_THRESHOLD_=131072 dsh --profile web
```

实测（同一工作负载，5 次重复，方差极小）：

| 指标 | 默认 | `MALLOC_MMAP_THRESHOLD_=131072` | 变化 |
|---|---|---|---|
| 峰值 RSS | 726–1097 MiB | **175 MiB** | **-80%** |
| 可回收碎片 | 543–928 MiB | **8 MiB** | **-98%** |
| 每次 trim 耗时 | 22–42 ms | **0.7–1.3 ms** | -97% |

也就是说：**开了这个变量之后，本插件的周期 trim 基本无事可做**（只剩 ~8 MiB）。

⚠️ 两个约束：

- 这个变量属 **bootstrap-only** 名，**不能写进 `.env`**（`dsh-app-boot/lib/index.js:4360`、`:4440 isBootstrapOnly`），
  只能由**启动环境**给（systemd `Environment=` 或 shell export）；
- 它必须在**进程启动前**生效。运行时用 `mallopt(M_MMAP_THRESHOLD, …)` 只能在
  "进程几乎没分配过"时才有效（实测 warm=0 时 780→156 MiB；一旦宿主已分配就失效），
  而插件加载时宿主早已分配过——所以插件自己吃不到这个红利，只能靠启动环境。

本插件会在设置页里检测这个变量并提示。

### 不要用这些

| 手段 | 为什么不用 |
|---|---|
| `MALLOC_ARENA_MAX=1` | 9 次重复实测**不减少碎片**（可回收量中位数 682 vs 618 MiB，在噪声内）；线程负载下 RSS 反而更高 |
| `mallopt(M_ARENA_MAX, …)` 运行时 | glibc 在首次建 arena 时就锁定了上限，运行期改不动（arena 数 10→11 继续涨） |
| `mallopt(M_TRIM_THRESHOLD, …)` 运行时 | 只治"堆顶空闲"，治不了内部碎片 |
| `v8.setFlagsFromString('--max-old-space-size=…')` | **改不动** heap limit（实测前后都是 4496293888） |
| 把 V8 heap limit 降到 512 MiB | OOM 会直接 abort 宿主进程 |

可选（要谨慎）：`NODE_OPTIONS=--max-old-space-size=3072` 能把宿主的上限从 4.19 GiB 压到 3 GiB，
给 OOM 设一道闸。降限**不会立刻降 RSS**（V8 只在逼近上限时才还页），所以只是保险，不是省内存。

---

## 它做什么

### L1 · 原生分配器回收

定时在合适的时机把碎片还给操作系统。全部经 **koffi FFI** 调用，**零编译**
（安装不需要 node-gyp / 编译器 / Rust 工具链）：

| 平台 | 机制 | 语义 |
|---|---|---|
| Linux (glibc) | `malloc_trim(0)` | **reclaim**：真的还给 OS |
| Linux (musl) | 不支持（无该符号）→ 自动降级并说明原因 | — |
| macOS | `malloc_zone_pressure_relief(malloc_default_zone(), 0)` | **reclaim** |
| Windows | `EmptyWorkingSet(GetCurrentProcess())` | **swap-out**：只是换出到页面文件，后续访问会变慢 |

> Windows 的语义与其它平台**相反**，设置页会分别用"已释放"和"已换出"措辞，
> 不会把"换出"说成"释放"。

**触发路径**：硬上限 → 增长阈值（要求**当前没有 agent 在跑**）→ 空闲兜底，外加最小间隔保护。
活跃判定用宿主真实的 `agent/status`（`idle` / `running`），
不是"最近有没有工具活动"——后者会把长时间流式回合误判成空闲。

失败一律吞掉降级，**绝不因回收失败影响宿主**。并发进行中时后来的请求直接返回 `skipped: in-flight`。

### L2 · 配置层收紧

只覆盖**实测有收益**的官方行：

| 行 | 旋钮 | 原值 | 新值 | 依据 |
|---|---|---|---|---|
| `ui-trajectory` | `maxResultsPerSession` | 1000 | 200 | 该子树实测占 **54.68 MiB**（按**条数**不按字节淘汰） |
| `experimental-inspector` | `maxJournalBytes` | 256 MiB | 64 MiB | 它把每个 fetch 的 body 转 base64 存进进程内 journal |
| `experimental-inspector` | `maxRetainedRequests` | 2000 | 200 | 同上 |
| `experimental-inspector` | `maxRequestBodyBytes` | 8 MiB | 1 MiB | 同上 |
| `experimental-inspector` | `maxResponseBodyBytes` | 32 MiB | 4 MiB | 同上 |

> Inspector 的 journal 是**活引用**，`malloc_trim` **永远收不回来**——只能从源头限制。

**刻意不覆盖**的（红蓝对抗后撤销）：

| 行 | 为什么不动 |
|---|---|
| `ptc-runtime.maxOutputBytes` | 它是**硬上限**，超限让整次 `run_code` **失败**（不是截断）。为了省内存把它从 64 MiB 压到 8 MiB 等于静默破坏用户的核心工具 |
| `session-projection-cache` | dirty 状态只存计数器不存事件体，收紧只是把 checkpoint 写入频率提高约 4×，零内存收益 |
| `jobs` / `typert-gateway` | 值恰等于 schema 默认，纯 no-op |

> ⚠️ profile 层最后应用且同名 `config` 会整块覆盖 bundle 层（`dsh-app-boot/lib/index.js:551`）。
> 如果你自己在 profile 里写过同一行，本插件的覆盖会**静默失效**——这时要改你自己那份。

### L3 · 设置页

显示 RSS / 峰值 RSS / V8 堆 / glibc `[heap]` 常驻、原生机制与语义、
累计 RSS 变化、按触发原因分类的次数、当前是否有 agent 在跑；
提供"立即回收"按钮与策略阈值表单；并提示上面那条启动环境建议。

---

## 安装

```bash
dsh plugin --profile web add dsh-lowmem
# 本机开发：
dsh plugin --profile web add /path/to/dsh-lowmem
```

装完 `dsh.profile.bundles` 会自动对齐。**重启 DSH 后生效。**

验证：

```bash
dsh --profile web --dump-config | grep -E 'lowmem|maxResultsPerSession|maxJournalBytes'
```

> `--profile` 必须写在转发给 pnpm 的参数**之前**；相对路径锚定在**你调用命令的目录**。
> 不要手写 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录里跑 pnpm。

---

## 设置

宿主半边的配置写在 `~/.dsh/dsh-lowmem/settings.json`（设置页改的就是它）。
**只落盘用户显式改过的键**，上游改默认值时本机仍能拿到新值。

| 键 | 默认值 | 下限 | 含义 |
|---|---|---|---|
| `enabled` | `true` | — | 是否启用自动回收 |
| `thresholdBytes` | 268435456（256 MiB） | 16 MiB | 相对上次回收后增长多少才回收 |
| `minIntervalMs` | 60000 | 5 s | 两次回收的最小间隔 |
| `idleIntervalMs` | 300000 | 30 s | 空闲多久兜底回收 |
| `hardCapBytes` | 3221225472（3 GiB） | 256 MiB | 超过就立即回收 |
| `sampleIntervalMs` | 15000 | 1 s | 采样周期 |
| `gcEnabled` | `false` | — | 顺带做一次 V8 GC（minor / major） |
| `gcMode` | `minor` | — | GC 类型；**不要用 major-snapshot**（实测 10.7 s 且顶高 RSS） |

> 下界是**必须的**：判定顺序里 `hardCapBytes` 先于"是否空闲"判定，
> 所以 `hardCapBytes=0` 会让"是否回收"恒为真——每 15 秒无条件 trim 一次。

---

## 跨平台

| 目标 | 覆盖方式 |
|---|---|
| Windows x64 / arm64 | koffi 预编译二进制（`@koromix/koffi-win32-*`） |
| Linux x64 / arm64 | koffi 预编译二进制（`@koromix/koffi-linux-*`） |
| macOS x64 / arm64 | koffi 预编译二进制（`@koromix/koffi-darwin-*`） |

koffi 已被 7 个官方 DSH 包依赖，宿主自身已加载 `koffi.node`，**不会多背一份原生依赖**。

**构建零编译**：CI 只跑 `node --test`。Windows 路径可用 Wine + Windows Node 做实机验证
（`node scripts/wine-win32-smoke.mjs`）——本机已验证 `EmptyWorkingSet` **只在 psapi.dll 导出**，
kernel32.dll 里没有，所以策略必须从 psapi.dll 取符号。

---

## 不做什么（以及为什么）

| 不做 | 原因 |
|---|---|
| 驱逐会话的内存状态 | 0.2.2-rc.1 的 `ctx.sessions` **没有** evict/dispose 公开 API |
| 注销 MCP 工具 | `ctx.tools` **没有** unregister |
| 运行时裁剪工具结果 | 会改写用户会话数据，需要单独的可回退设计，列入二期 |
| 收紧官方输出上限 | 那些上限是**硬上限**，超限是**失败**不是截断（见上文撤销说明） |
| WS 下行背压 / SSE 背压 / peers 剪枝 | 官方没有对应旋钮，需要自己补 |

---

## 开发

```bash
npm install
node --test 'tests/*.test.mjs'     # 单元测试
node scripts/build-client.mjs      # 生成 client.js（生成物，提交在仓库里）
node scripts/build-client.mjs --check
node scripts/selftest.mjs          # 起一个临时 DSH 实例，验证真实回收效果
node scripts/ui-smoke.mjs          # 浏览器 UI 冒烟 + 截图
node scripts/wine-win32-smoke.mjs  # Windows 路径实机验证（Wine）
```

内部契约见 [`docs/CONTRACT.md`](docs/CONTRACT.md)。

---

## 许可证

MIT
