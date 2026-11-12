/**
 * Linux（glibc）策略：用 malloc_trim(0) 把 glibc 堆顶的空闲页还给内核。
 *
 * 两个容易踩的坑：
 * - glibc 的 malloc_trim 返回值是「有没有真的释放内存」的标志位（0/1），不是字节数。
 *   所以这里显式标记 nativeReturnsBytes=false，免得上层把 1 当成「释放了 1 字节」。
 * - musl libc 根本没有 malloc_trim 这个符号，koffi 在 lib.func() 阶段就会抛错。
 *   这时不能笼统地说「不支持」，要明确告诉用户这是 musl（§2.1 要求 detail 能区分 musl）。
 */

/** glibc 的共享库名。 */
const LIBC = 'libc.so.6'

/**
 * 判断当前进程是否运行在 musl libc 上。
 *
 * Node 的 process.report 只有在链接了 glibc 时才会给出 header.glibcVersionRuntime；
 * musl 构建的 Node 上这个字段缺失，用它来区分两种 libc。
 *
 * @returns {boolean} true 表示疑似 musl；检测不出来时返回 false。
 */
export function isMuslRuntime() {
  try {
    const header = process.report?.getReport?.()?.header
    if (header === undefined || header === null) return false
    return !header.glibcVersionRuntime
  } catch {
    return false
  }
}

/**
 * 创建 Linux 回收策略。
 * @param {object} koffi - koffi 模块（由入口注入，方便测试替身）。
 * @returns {{available: boolean, name: string|null, detail: string,
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
      detail: `加载 ${LIBC} 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let mallocTrim
  try {
    mallocTrim = lib.func('int malloc_trim(size_t)')
  } catch (error) {
    // musl 没有这个符号，这里必须说清楚是 musl，而不是笼统的「不支持」。
    const detail = isMuslRuntime()
      ? `musl libc 不提供 malloc_trim 符号（${LIBC} 中找不到），本平台暂不支持原生回收`
      : `${LIBC} 缺少 malloc_trim 符号：${error instanceof Error ? error.message : String(error)}`
    return { available: false, name: null, detail }
  }

  return {
    available: true,
    name: 'malloc_trim',
    detail: 'glibc malloc_trim(0)',
    // pad=0 表示把「所有可释放的空闲页」都还给内核。
    nativeTrim: () => mallocTrim(0),
    // glibc 返回的是标志位，不是字节数。
    nativeReturnsBytes: false,
  }
}
