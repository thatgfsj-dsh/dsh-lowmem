/**
 * Linux 策略：用 malloc_trim(0) 把 glibc 堆顶的空闲页还给内核。
 *
 * 三个容易踩的坑：
 * - glibc 的 malloc_trim 返回值是「有没有真的释放内存」的**标志位**（0/1），不是字节数。
 *   所以这里显式标记 nativeReturnsBytes=false，免得上层把 1 当成「释放了 1 字节」。
 * - **musl 根本没有 malloc_trim 这个符号**，而且 musl 也**没有 libc.so.6**
 *   （它的 soname 是 libc.musl-x86_64.so.1）。所以「加载 libc.so.6 失败」和
 *   「符号不存在」两种失败都要能识别出 musl，否则 Alpine 用户只会看到一句无用的
 *   "加载 libc.so.6 失败"，不知道真正原因是「这台机器用 musl，没有可用的原生回收」。
 * - RSS 差值是**进程级净变化**，不是「本机制释放的字节」；上层要分开报（见 trim/index.mjs）。
 */

import { readdirSync } from 'node:fs'

/** glibc 的共享库名。musl 上没有这个文件。 */
const LIBC = 'libc.so.6'

/**
 * 判断当前进程是否运行在 musl libc 上。
 *
 * 两条独立证据，任一成立即认为是 musl：
 * 1. Node 的 process.report 只有在链接了 glibc 时才会给出 header.glibcVersionRuntime；
 * 2. musl 的动态链接器是 /lib/ld-musl-*.so.1。
 *
 * @returns {boolean} true 表示疑似 musl；检测不出来时返回 false。
 */
export function isMuslRuntime() {
  try {
    const header = process.report?.getReport?.()?.header
    if (header !== undefined && header !== null) {
      return !header.glibcVersionRuntime
    }
  } catch {
    // 取不到 report 就退化到文件判断
  }
  try {
    return readdirSync('/lib').some((name) => name.startsWith('ld-musl-'))
  } catch {
    return false
  }
}

/**
 * 造一条能让用户看懂「为什么这台机器不支持」的说明。
 * @param {string} what - 失败的具体环节。
 * @param {string} detail - 原始错误信息。
 * @returns {string} 可读的说明。
 */
function explainLinuxFailure(what, detail) {
  if (isMuslRuntime()) {
    return `当前是 musl libc（Alpine 等）：${what}，musl 不提供 glibc 的 malloc_trim，本平台暂不支持原生回收`
  }
  return `${what}：${detail}`
}

/**
 * 创建 Linux 回收策略。
 * @param {object} koffi - koffi 模块（由入口注入，方便测试替身）。
 * @returns {{available: boolean, name: string|null, kind: string|null, detail: string,
 *   nativeTrim?: () => unknown, nativeReturnsBytes?: boolean}} 策略描述。
 */
export function createLinuxStrategy(koffi) {
  let lib
  try {
    lib = koffi.load(LIBC)
  } catch (error) {
    return {
      available: false,
      name: null,
      kind: null,
      detail: explainLinuxFailure(`加载 ${LIBC} 失败`, error instanceof Error ? error.message : String(error)),
    }
  }

  let mallocTrim
  try {
    mallocTrim = lib.func('int malloc_trim(size_t)')
  } catch (error) {
    // musl 没有这个符号，这里必须说清楚是 musl，而不是笼统的「不支持」。
    return {
      available: false,
      name: null,
      kind: null,
      detail: explainLinuxFailure(`${LIBC} 中缺少 malloc_trim 符号`, error instanceof Error ? error.message : String(error)),
    }
  }

  return {
    available: true,
    name: 'malloc_trim',
    // 真的把空闲页还给内核。
    kind: 'reclaim',
    detail: 'glibc malloc_trim(0)',
    // pad=0 表示把「所有可释放的空闲页」都还给内核。
    nativeTrim: () => mallocTrim(0),
    // glibc 返回的是标志位，不是字节数。
    nativeReturnsBytes: false,
  }
}
