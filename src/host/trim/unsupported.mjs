/**
 * 降级实现：本平台（或本 libc）没有可用的原生回收入口时的占位回收器。
 *
 * 这里必须保证两件事：
 * - available=false、name=null，上层一眼能看出「这台机器没这个能力」。
 * - trim() 不抛异常，直接返回一次「失败」的回收结果——上层逻辑不用区分「不支持」和「出错」。
 */

/**
 * 创建一个不可用的回收器。
 * @param {string} detail - 说明为什么不可用（会原样出现在 detail 与 trim().error 里）。
 * @returns {{available: boolean, name: string|null, detail: string,
 *   trim: (opts?: {rssBytes?: number}) => {ok: boolean, error: string, reclaimedBytes: number, durationMs: number}}}
 *   降级回收器。
 */
export function createUnsupportedTrimmer(detail) {
  return {
    available: false,
    name: null,
    detail,
    trim() {
      return {
        ok: false,
        error: detail,
        reclaimedBytes: 0,
        durationMs: 0,
      }
    },
  }
}
