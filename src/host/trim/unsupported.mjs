/**
 * 降级实现：平台不支持，或 koffi 不可用。
 *
 * trim() 直接返回 ok=false —— 上层据此把它显示为「本平台暂不支持原生回收」，
 * 而不是反复尝试、反复失败。
 */

/**
 * 创建一个不可用的回收器。
 * @param {string} detail - 人类可读的原因。
 * @returns {{available: false, name: null, kind: null, detail: string,
 *   trim: () => {ok: false, error: string, rssDeltaBytes: number, nativeReleasedBytes: null, durationMs: number}}} 回收器。
 */
export function createUnsupportedTrimmer(detail) {
  return {
    available: false,
    name: null,
    kind: null,
    detail,
    trim: () => ({
      ok: false,
      error: detail,
      rssDeltaBytes: 0,
      nativeReleasedBytes: null,
      durationMs: 0,
    }),
  }
}
