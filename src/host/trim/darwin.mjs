/**
 * macOS 策略：用 malloc_zone_pressure_relief() 压缩默认 malloc zone 的空闲页。
 *
 * 为什么不用 malloc_trim：macOS 上没有 malloc_trim；对应的接口是
 * malloc_zone_pressure_relief(zone, goal)，goal=0 表示「尽量多地释放」。
 * 它返回释放掉的字节数，所以这里是唯一「原生返回值即字节数」的平台。
 */

/** macOS 的系统库。 */
const LIB_SYSTEM = '/usr/lib/libSystem.B.dylib'

/**
 * 创建 macOS 回收策略。
 * @param {object} koffi - koffi 模块（由入口注入，方便测试替身）。
 * @returns {{available: boolean, name: string|null, detail: string,
 *   nativeTrim?: () => unknown, nativeReturnsBytes?: boolean}} 策略描述。
 */
export function createDarwinStrategy(koffi) {
  let lib
  try {
    lib = koffi.load(LIB_SYSTEM)
  } catch (error) {
    return {
      available: false,
      name: null,
      detail: `加载 ${LIB_SYSTEM} 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let mallocDefaultZone
  let pressureRelief
  try {
    mallocDefaultZone = lib.func('void* malloc_default_zone()')
    pressureRelief = lib.func('size_t malloc_zone_pressure_relief(void*, size_t)')
  } catch (error) {
    return {
      available: false,
      name: null,
      detail: `${LIB_SYSTEM} 缺少 malloc_zone_pressure_relief 符号：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return {
    available: true,
    name: 'malloc_zone_pressure_relief',
    detail: 'macOS malloc_zone_pressure_relief(malloc_default_zone(), 0)',
    // goal=0：把能释放的空闲页都释放掉；返回值就是释放的字节数。
    nativeTrim: () => pressureRelief(mallocDefaultZone(), 0),
    nativeReturnsBytes: true,
  }
}
