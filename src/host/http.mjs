/**
 * HTTP 小工具：JSON 响应、请求体解析、统一的中文错误响应。
 *
 * 与 dsh-session-delete 的同名模块保持同一种形状，方便同生态的插件互相参照。
 *
 * @module dsh-lowmem/host/http
 */

/** 请求体上限：本插件的接口只带开关和阈值，16 KiB 足够。 */
const MAX_BODY_BYTES = 16 * 1024

/**
 * 构造 JSON 响应。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - 可 JSON 序列化的响应体。
 * @returns {Response} 响应对象。
 */
export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 先看 content-length，再按流读取并在超限时立刻停止，
 * 避免把超大 body 整个读进内存（本插件自己就是来省内存的，不能自己先撑爆）。
 * @param {Request} request - 传入请求。
 * @returns {Promise<object>} 解析后的对象；请求体为空时返回空对象。
 */
export async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(400, '请求体过大')
  }
  let text = ''
  try {
    if (request.body !== null) {
      const reader = request.body.getReader()
      const decoder = new TextDecoder()
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {})
          throw new HttpError(400, '请求体过大')
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, `读取请求体失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new HttpError(400, `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  return parsed
}

/**
 * 带状态码的 HTTP 错误。
 */
export class HttpError extends Error {
  /**
   * @param {number} status - HTTP 状态码。
   * @param {string} message - 人类可读的原因。
   */
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/**
 * 把一个处理函数包成"永远返回 JSON"的 Fetch 路由实现。
 * @param {(request: Request) => Promise<Response>} handler - 业务处理函数。
 * @returns {(request: Request) => Promise<Response>} 包装后的处理函数。
 */
export function withErrors(handler) {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      return json(status, { ok: false, error: message })
    }
  }
}
