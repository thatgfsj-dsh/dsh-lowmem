/**
 * Windows 策略：用 EmptyWorkingSet(GetCurrentProcess()) 把当前进程的工作集清空。
 *
 * 语义和 *nix 不太一样：EmptyWorkingSet 是把进程占着的物理页全部挤回系统，
 * 下次访问再从页文件换回来——所以 RSS 会掉，但不代表有内存被「释放」，只是换出去了。
 * 因此这里不把返回值当字节数（它只是个 bool）。
 */

/** 进程内存管理 API 所在的库。 */
const PSAPI = 'psapi.dll'
/** GetCurrentProcess 所在的库。 */
const KERNEL32 = 'kernel32.dll'

/**
 * 创建 Windows 回收策略。
 * @param {object} koffi - koffi 模块（由入口注入，方便测试替身）。
 * @returns {{available: boolean, name: string|null, detail: string,
 *   nativeTrim?: () => unknown, nativeReturnsBytes?: boolean}} 策略描述。
 */
export function createWin32Strategy(koffi) {
  let psapi
  let kernel32
  try {
    psapi = koffi.load(PSAPI)
    kernel32 = koffi.load(KERNEL32)
  } catch (error) {
    return {
      available: false,
      name: null,
      detail: `加载 ${PSAPI}/${KERNEL32} 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let emptyWorkingSet
  let getCurrentProcess
  try {
    emptyWorkingSet = psapi.func('bool EmptyWorkingSet(void*)')
    getCurrentProcess = kernel32.func('void* GetCurrentProcess()')
  } catch (error) {
    return {
      available: false,
      name: null,
      detail: `Windows 缺少 EmptyWorkingSet/GetCurrentProcess 符号：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return {
    available: true,
    name: 'EmptyWorkingSet',
    detail: 'Windows EmptyWorkingSet(GetCurrentProcess())',
    // GetCurrentProcess 返回伪句柄（固定值），不需要关闭。
    nativeTrim: () => emptyWorkingSet(getCurrentProcess()),
    // 返回值只是「成功与否」的布尔量，不是字节数。
    nativeReturnsBytes: false,
  }
}
