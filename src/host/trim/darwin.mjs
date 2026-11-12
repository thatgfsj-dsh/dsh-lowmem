/**
 * macOS 策略：用 malloc_zone_pressure_relief 把默认 zone 的空闲页压回内核。
 *
 * 与 *nix 的区别：macOS 的 malloc_zone_pressure_relief **返回释放的字节数**，
 * 所以这里 nativeReturnsBytes = true —— 这是三个平台里唯一能自报字节数的。
 * 但要注意：它报告的是「分配器释放了多少」，这些页可能只是回到 zone 的 free list
 * （可被复用），未必立刻变成进程 RSS 的下降。所以上层要把它与 RSS 差值分开报。
 */

/** libSystem 所在路径。 */
const LIBSYSTEM = '/usr/lib/libSystem.B.dylib'

/**
 * 创建 macOS 回收策略。
 * @param {object} koffi - koffi 模块（由入口注入，方便测试替身）。
 * @returns {{available: boolean, name: string|null, kind: string|null, detail: string,
 *   nativeTrim?: () => unknown, nativeReturnsBytes?: boolean}} 策略描述。
 */
export function createDarwinStrategy(koffi) {
  let lib
  try {
    lib = koffi.load(LIBSYSTEM)
  } catch (error) {
    return {
      available: false,
      name: null,
      kind: null,
      detail: `加载 ${LIBSYSTEM} 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let defaultZone
  let pressureRelief
  try {
    defaultZone = lib.func('void* malloc_default_zone()')
    pressureRelief = lib.func('size_t malloc_zone_pressure_relief(void*, size_t)')
  } catch (error) {
    return {
      available: false,
      name: null,
      kind: null,
      detail: `${LIBSYSTEM} 缺少 malloc_default_zone / malloc_zone_pressure_relief 符号：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return {
    available: true,
    name: 'malloc_zone_pressure_relief',
    kind: 'reclaim',
    detail: 'macOS malloc_zone_pressure_relief(malloc_default_zone(), 0)',
    // size=0 表示把 zone 里所有可释放的页都压回内核。
    nativeTrim: () => pressureRelief(defaultZone(), 0),
    // macOS 这一家确实返回字节数。
    nativeReturnsBytes: true,
  }
}
