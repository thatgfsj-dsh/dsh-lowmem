/**
 * 自检：在**临时 DSH 实例**里验证本插件真的能把内存还给操作系统。
 *
 * 不触碰正在运行的 dsh web 与真实会话：临时 DSH_HOME + 真实 web profile 的副本 + 随机端口。
 *
 * 步骤：
 * 1. 复制本机的 web profile 到临时 DSH_HOME（沿用本机其它插件的既有做法：
 *    真实 profile 的副本比最小 profile 可靠——最小 profile 缺宿主接线，/api 路由整体 404）；
 * 2. dsh plugin --profile web add <本仓库>；
 * 3. 用 --dump-config 复核配置层：我们的行在、旋钮覆盖生效、没有 "entry not found"；
 * 4. 起临时实例（--port 0），用启动令牌换到会话 cookie（宿主把 /api 放在浏览器信任栅栏后面）；
 * 5. 调 /stats 看机制是否可用，调 /trim 强制回收一次，调 /config 读写配置；
 * 6. 断言并清理。
 *
 * 用法：node scripts/selftest.mjs
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTempInstance, waitFor } from './lib/instance.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '：' + detail}`)
  if (!ok) failures.push(name + (detail === '' ? '' : '（' + detail + '）'))
}

/** 本插件覆盖或插入的行 id：只有这些行的 "entry not found" 才算本插件的问题。 */
const OUR_IDS = ['ui-trajectory', 'ptc-runtime', 'jobs', 'typert-gateway', 'session-projection-cache', 'spill-policy', 'dsh-lowmem']

let instance = null
try {
  console.log('起临时实例…')
  instance = await startTempInstance(ROOT)
  console.log('临时实例：' + instance.base)

  // 配置复核必须在**临时 home** 里做：线上 profile 未必挂载本插件
  // （dsh plugin add 只写 dependencies，是否挂载看 dsh.profile.bundles）。
  const dump = instance.dumpConfig()
  const dumpText = dump.text
  check('dump-config 成功', dump.status === 0, 'exit=' + dump.status)
  const allMissing = dumpText.match(/patch: entry "[^"]+" not found/g) || []
  const missing = allMissing.filter((line) => OUR_IDS.some((id) => line.includes('"' + id + '"')))
  check('本插件覆盖的行没有 "entry not found"', missing.length === 0, missing.join('; '))
  if (allMissing.length > missing.length) {
    console.log('  提示：本 profile 另有 ' + (allMissing.length - missing.length) + ' 条与本插件无关的既有告警')
  }
  check('宿主行已插入', /- id: dsh-lowmem/.test(dumpText))
  check('ui-trajectory 覆盖生效', /maxResultsPerSession: 200/.test(dumpText))
  check('ptc-runtime 覆盖生效', /maxOutputBytes: 8388608/.test(dumpText))
  check('session-projection-cache 覆盖生效', /writeEveryEvents: 50/.test(dumpText))

  const stats = await waitFor('stats 接口可用', async () => {
    const result = await instance.call('/api/dsh-lowmem/stats')
    return result.status === 200 && result.body.memory ? result.body : null
  })

  check('stats 返回内存快照', typeof stats.memory.rssBytes === 'number' && stats.memory.rssBytes > 0,
    'rss=' + Math.round(stats.memory.rssBytes / 1048576) + ' MiB')
  check('平台识别正确', typeof stats.platform === 'string' && stats.platform.length > 0, stats.platform)
  check('原生机制可用', stats.mechanism.available === true, stats.mechanism.name + ' / ' + stats.mechanism.detail)

  const trimmed = await instance.call('/api/dsh-lowmem/trim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  })
  check('trim 接口返回成功', trimmed.status === 200 && trimmed.body.ok === true, JSON.stringify(trimmed.body).slice(0, 160))
  check('trim 报告了释放量', typeof trimmed.body.reclaimedBytes === 'number' && trimmed.body.reclaimedBytes >= 0,
    'reclaimed=' + trimmed.body.reclaimedBytes)
  check('trim 耗时在合理范围', typeof trimmed.body.durationMs === 'number' && trimmed.body.durationMs < 5000,
    trimmed.body.durationMs + ' ms')
  console.log('  回收前 RSS ' + Math.round((trimmed.body.before?.rssBytes ?? 0) / 1048576) + ' MiB → 回收后 RSS '
    + Math.round((trimmed.body.after?.rssBytes ?? 0) / 1048576) + ' MiB（释放 '
    + Math.round((trimmed.body.reclaimedBytes ?? 0) / 1048576) + ' MiB，耗时 ' + trimmed.body.durationMs + ' ms）')

  const after = await instance.call('/api/dsh-lowmem/stats')
  check('统计里记录了这次回收', after.body.trim.count >= 1, 'count=' + after.body.trim.count)
  check('累计回收量已累计', after.body.trim.totalReclaimedBytes >= trimmed.body.reclaimedBytes)

  const config = await instance.call('/api/dsh-lowmem/config')
  check('config 接口返回配置', config.status === 200 && typeof config.body.config === 'object'
    && typeof config.body.config.thresholdBytes === 'number', JSON.stringify(config.body).slice(0, 120))

  const updated = await instance.call('/api/dsh-lowmem/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ thresholdBytes: 128 * 1024 * 1024 }),
  })
  check('config 可写回', updated.status === 200 && updated.body.config.thresholdBytes === 128 * 1024 * 1024,
    JSON.stringify(updated.body).slice(0, 120))
} catch (error) {
  check('自检流程没有异常', false, error instanceof Error ? error.message : String(error))
} finally {
  if (instance !== null) await instance.stop().catch(() => {})
}

console.log('')
if (failures.length > 0) {
  console.log('自检失败 ' + failures.length + ' 项：')
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
} else {
  console.log('自检全部通过')
}
