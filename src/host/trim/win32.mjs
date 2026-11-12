/**
 * Windows 策略：用 EmptyWorkingSet(GetCurrentProcess()) 清空当前进程的工作集。
 *
 * 语义和 *nix **完全相反**，必须在 UI 上说清楚：
 * EmptyWorkingSet 不释放任何内存，只是把进程占着的物理页挤回系统（写进页面文件），
 * 下次访问再换回来。所以：
 * - kind = 'swap-out'（换出），不是 'reclaim'（释放）；
 * - 返回值只是 BOOL，不是字节数 → nativeReleasedBytes 必须是 null；
 * - 换出之后访问这些页会变慢（页缺失 → 软缺页 → 磁盘读），所以不能无脑频繁做。
 *
 * 库的选择是实测出来的：**EmptyWorkingSet 只在 psapi.dll 导出**，kernel32.dll 里没有
 * （Wine + Windows Node 24 实测：`Cannot find function 'EmptyWorkingSet' in shared library`）。
 */

/** 进程内存管理 API 所在的库。 */
const PSAPI = 'psapi.dll'
/** GetCurrentProcess 所在的库。 */
const KERNEL32 = 'kernel32.dll'

/**
 * 创建 Windows 回收策略。
 * @param {object} koffi - koffi 模块（由入口注入，方便测试替身）。
 * @returns {{available: boolean, name: string|null, kind: string|null, detail: string,
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
      kind: null,
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
      kind: null,
      detail: `Windows 缺少 EmptyWorkingSet/GetCurrentProcess 符号：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return {
    available: true,
    name: 'EmptyWorkingSet',
    // 只是换出到页面文件，不是释放。
    kind: 'swap-out',
    detail: 'Windows EmptyWorkingSet(GetCurrentProcess())：工作集换出到页面文件（后续访问会变慢）',
    // GetCurrentProcess 返回伪句柄（固定值），不需要关闭。
    nativeTrim: () => emptyWorkingSet(getCurrentProcess()),
    // 返回值只是「成功与否」的布尔量，不是字节数。
    nativeReturnsBytes: false,
  }
}
