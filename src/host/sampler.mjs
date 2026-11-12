/**
 * 内存采样：把 Node 暴露的内存指标整理成插件内部统一使用的形状。
 *
 * 为什么单独一个模块：宿主与客户端都只认这一份字段名，
 * 采样逻辑（尤其是"哪些字段是字节、哪些是秒"）集中在一处，避免各处各写一遍。
 *
 * @module dsh-lowmem/host/sampler
 */
import { readFileSync } from 'node:fs'

/**
 * 读 /proc/<pid>/status 里的 VmHWM（进程生命周期内的 RSS 峰值）。
 * @returns {number|null} 峰值字节数；读不到时返回 null。
 */
function readPeakRssBytes() {
  try {
    const status = readFileSync('/proc/self/status', 'utf8')
    const match = /^VmHWM:\s+(\d+) kB$/m.exec(status)
    return match === null ? null : Number(match[1]) * 1024
  } catch {
    return null
  }
}

/**
 * 读 glibc 主 arena 的常驻字节数（/proc/self/smaps 里的 [heap]）。
 *
 * 这个数字能区分两种情况：RSS 高是因为**分配器碎片**（[heap] 常驻远大于活对象），
 * 还是因为**真的还活着的对象多**。前者才值得 trim。
 * @returns {number|null} 常驻字节数；非 Linux 或读不到时返回 null。
 */
function readHeapResidentBytes() {
  try {
    const smaps = readFileSync('/proc/self/smaps', 'utf8')
    // 按映射段切开，逐段找带 [heap] 标记的那一段，再取它的 Rss。
    const sections = smaps.split(/\n(?=[0-9a-f]+-[0-9a-f]+ )/)
    for (const section of sections) {
      if (!section.includes('[heap]')) continue
      const rss = /^Rss:\s+(\d+) kB$/m.exec(section)
      if (rss !== null) return Number(rss[1]) * 1024
    }
    return null
  } catch {
    return null
  }
}

/**
 * 采一份内存快照。
 *
 * `process.memoryUsage()` 的字段：
 * - `rss`：进程常驻集大小（用户真正关心的"占用"）；
 * - `heapTotal`：V8 已向系统申请的堆空间；
 * - `heapUsed`：V8 堆里真正存着对象的字节数；
 * - `external`：堆外的原生对象（ArrayBuffer 等）；
 * - `arrayBuffers`：`external` 里属于 ArrayBuffer/Buffer 的部分。
 * @returns {{rssBytes: number, heapTotalBytes: number, heapUsedBytes: number,
 *   externalBytes: number, arrayBufferBytes: number, uptimeSeconds: number, pid: number,
 *   rssPeakBytes: number|null, heapResidentBytes: number|null}} 快照。
 */
export function sampleMemory() {
  const usage = process.memoryUsage()
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBufferBytes: usage.arrayBuffers,
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    rssPeakBytes: readPeakRssBytes(),
    heapResidentBytes: readHeapResidentBytes(),
  }
}
