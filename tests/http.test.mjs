import test from 'node:test'
import assert from 'node:assert/strict'
import { json, readJsonBody, withErrors, HttpError } from '../src/host/http.mjs'

test('json 响应带正确的 content-type', async () => {
  const response = json(200, { ok: true })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.deepEqual(await response.json(), { ok: true })
})

test('空请求体返回空对象', async () => {
  const request = new Request('http://x/api', { method: 'POST' })
  assert.deepEqual(await readJsonBody(request), {})
})

test('合法 JSON 请求体被解析', async () => {
  const request = new Request('http://x/api', {
    method: 'POST',
    body: JSON.stringify({ force: true }),
    headers: { 'content-type': 'application/json' },
  })
  assert.deepEqual(await readJsonBody(request), { force: true })
})

test('非法 JSON 抛 400', async () => {
  const request = new Request('http://x/api', { method: 'POST', body: '{oops' })
  await assert.rejects(() => readJsonBody(request), (error) => {
    assert.ok(error instanceof HttpError)
    assert.equal(error.status, 400)
    return true
  })
})

test('数组请求体被拒', async () => {
  const request = new Request('http://x/api', { method: 'POST', body: '[1,2]' })
  await assert.rejects(() => readJsonBody(request), (error) => error.status === 400)
})

test('withErrors 把异常转成 JSON', async () => {
  const handler = withErrors(async () => {
    throw new HttpError(418, 'teapot')
  })
  const response = await handler(new Request('http://x/api'))
  assert.equal(response.status, 418)
  assert.deepEqual(await response.json(), { ok: false, error: 'teapot' })
})

test('withErrors 对未知异常返回 500', async () => {
  const handler = withErrors(async () => {
    throw new Error('boom')
  })
  const response = await handler(new Request('http://x/api'))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { ok: false, error: 'boom' })
})
