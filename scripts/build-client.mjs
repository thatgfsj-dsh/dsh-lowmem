/**
 * 客户端 bundle 构建：把 src/client/*.js 部件拼接成单文件 client.js。
 *
 * 为什么要拼：DSH 的 dsh.client 只支持一个浏览器 bundle 文件（exports["./client"]），
 * 而单文件太长不好维护。源码按职责拆成多个部件，构建时合并；
 * 提交的 client.js 是生成物（带文件头注释），不要手改。
 *
 * 用法：
 *   node scripts/build-client.mjs           # 生成并写入 client.js
 *   node scripts/build-client.mjs --check   # 只校验 client.js 是否与源码同步
 *
 * 同时导出 buildClient()，供单测比对生成结果。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PARTS = ['base.js', 'settings.js', 'entry.js']

const HEADER = `/**
 * 本文件由 scripts/build-client.mjs 从 src/client/*.js 自动生成，请勿直接修改。
 * 修改请改 src/client/ 下的源码，然后运行：node scripts/build-client.mjs
 */
window.__ModuleLoader__.load({
  id: 'dsh-lowmem',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

`

const FOOTER = `  },
})
`

/**
 * 保守压缩：去掉空行与整行注释（保留块注释内的内容），再把短行合并，减少生成物体积。
 * 不改变语义；模板字符串与块注释内部不参与合并。
 * @param {string} source - 拼接后的源码。
 * @returns {string} 压缩结果。
 */
export function compact(source) {
  const lines = source.split('\n')
  const kept = []
  let inBlockComment = false
  let inTemplate = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inBlockComment && !inTemplate && (trimmed === '' || trimmed.startsWith('//'))) continue
    const opens = (line.match(/\/\*/g) ?? []).length
    const closes = (line.match(/\*\//g) ?? []).length
    if (!inBlockComment && opens > closes) inBlockComment = true
    else if (inBlockComment && closes > 0) inBlockComment = false
    const ticks = (line.match(/(?<!\\)`/g) ?? []).length
    if (ticks % 2 === 1) inTemplate = !inTemplate
    kept.push(line)
  }
  const SAFE_TAIL = /[,\{(\[:./=+\-*%&|<>!?;]$/
  const merged = []
  let pending = ''
  let blocks = false
  let template = false
  for (const line of kept) {
    const text = line.trim()
    const isCommentLine = text.startsWith('/*') || text.startsWith('*')
    const ticks = (line.match(/(?<!\\)`/g) ?? []).length
    const startsTemplate = template
    const candidate = pending === '' ? text : `${pending} ${text}`
    const canJoin = pending !== ''
      && !blocks
      && !startsTemplate
      && !template
      && !isCommentLine
      && !pending.trim().startsWith('/*')
      && !pending.trim().startsWith('*')
      && SAFE_TAIL.test(pending)
      && candidate.length <= 220
    if (canJoin) {
      pending = candidate
    } else {
      if (pending !== '') merged.push(pending)
      pending = text
    }
    if (!blocks && !template) {
      if (ticks % 2 === 1) template = true
    } else if (template) {
      if (ticks % 2 === 1) template = false
    }
    const opens = (line.match(/\/\*/g) ?? []).length
    const closes = (line.match(/\*\//g) ?? []).length
    if (!blocks && opens > closes) blocks = true
    else if (blocks && closes > 0) blocks = false
  }
  if (pending !== '') merged.push(pending)
  return merged.join('\n') + '\n'
}

/**
 * 构建客户端 bundle。
 * @param {{compact?: boolean}} [options] - compact=false 时输出未合并的源码（测试用）。
 * @returns {Promise<string>} 生成的源码。
 */
export async function buildClient(options = {}) {
  const parts = []
  for (const part of PARTS) parts.push(await readFile(join(ROOT, 'src', 'client', part), 'utf8'))
  const joined = `${HEADER}${parts.join('\n')}\n${FOOTER}`
  return options.compact === false ? joined : compact(joined)
}

const target = join(ROOT, 'client.js')
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  const built = await buildClient()
  if (process.argv.includes('--check')) {
    const current = await readFile(target, 'utf8')
    if (current !== built) {
      console.error('client.js 与 src/client/*.js 不同步，请运行：node scripts/build-client.mjs')
      process.exitCode = 1
    } else {
      console.log('client.js 与源码同步')
    }
  } else {
    await writeFile(target, built, 'utf8')
    console.log(`已生成 client.js（${built.split('\n').length} 行）`)
  }
}
