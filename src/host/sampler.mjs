/**
 * 内存采样：把 Node 暴露的内存指标整理成插件内部统一使用的形状。
 *
 * 为什么单独一个模块：宿主与客户端都只认这一份字段名，
 * 采样逻辑（尤其是"哪些字段是字节、哪些是秒"）集中在一处，避免各处各写一遍。
 *
 * @module dsh-lowmem/host/sampler
 */

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
 *   externalBytes: number, arrayBufferBytes: number, uptimeSeconds: number, pid: number}} 快照。
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
  }
}
