'use strict'

const { acceptRequest, sendHandlerError, verifyPassword, PublicError } = require('../lib/api-utils')

const MAX_BODY_LENGTH = 1024 * 1024
const AI_TIMEOUT_MS = 50000

function waitForDrain(res, signal) {
  if (res.destroyed || res.writableEnded || signal?.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      res.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = value => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const onDrain = () => finish(true)
    const onClose = () => finish(false)
    const onError = () => finish(false)
    const onAbort = () => finish(false)
    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })

    // Close the small races between the initial state check and listener setup.
    if (res.destroyed || res.writableEnded || signal?.aborted) finish(false)
    else if (res.writableNeedDrain === false) finish(true)
  })
}

function getEndpoint(baseUrl) {
  let url
  try { url = new URL(baseUrl) } catch (_) { throw new PublicError('AI_API_URL 配置无效', 500) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new PublicError('AI_API_URL 配置无效', 500)

  const path = url.pathname.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(path)) url.pathname = path
  else if (/\/v1$/i.test(path)) url.pathname = `${path}/chat/completions`
  else url.pathname = `${path}/v1/chat/completions`
  url.hash = ''
  return url.toString()
}

module.exports = async (req, res) => {
  if (!acceptRequest(req, res, ['POST'])) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)
  let clientClosed = false
  const onClientClose = () => {
    clientClosed = true
    controller.abort()
  }
  res.once('close', onClientClose)

  try {
    const apiKey = process.env.AI_API_KEY
    const apiUrl = process.env.AI_API_URL
    const model = process.env.AI_MODEL
    if (!apiKey || !apiUrl || !model) throw new PublicError('AI 服务未完整配置', 503)

    const source = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    verifyPassword(source, 'PASSWORD', 'password')
    const { messages } = source
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) {
      throw new PublicError('messages 必须是包含 1 到 100 条消息的数组')
    }
    if (messages.some(message => !message || typeof message !== 'object' || typeof message.role !== 'string' || !('content' in message))) {
      throw new PublicError('messages 格式无效')
    }
    let serializedMessages
    try { serializedMessages = JSON.stringify(messages) } catch (_) { throw new PublicError('messages 内容无法序列化') }
    if (Buffer.byteLength(serializedMessages, 'utf8') > MAX_BODY_LENGTH) throw new PublicError('messages 内容过大', 413)

    const endpoint = getEndpoint(apiUrl)
    let upstream
    try {
      upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: `{"model":${JSON.stringify(model)},"messages":${serializedMessages},"stream":true}`,
        signal: controller.signal
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      throw new PublicError('无法连接 AI 服务，请稍后重试', 502)
    }

    if (!upstream.ok || !upstream.body) {
      try { await upstream.body?.cancel() } catch (_) {}
      throw new PublicError(`AI 服务请求失败（${upstream.status}）`, 502)
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    res.write(': connected\n\n')

    const reader = upstream.body.getReader()
    while (true) {
      if (clientClosed || res.destroyed || res.writableEnded) return
      const { done, value } = await reader.read()
      if (done) break
      if (clientClosed || res.destroyed || res.writableEnded) return
      if (!res.write(Buffer.from(value)) && !await waitForDrain(res, controller.signal)) return
    }
    if (clientClosed || res.destroyed || res.writableEnded) return
    return res.end()
  } catch (error) {
    if (clientClosed || res.destroyed || res.writableEnded) return
    if (error?.name === 'AbortError') error = new PublicError('AI 服务请求超时', 504)
    if (res.headersSent) {
      console.error('AI stream error', error)
      try {
        if (!res.destroyed && !res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: error instanceof PublicError ? error.message : 'AI 服务请求失败' })}\n\n`)
        }
      } catch (_) {}
      try { if (!res.destroyed && !res.writableEnded) res.end() } catch (_) {}
      return
    }
    return sendHandlerError(res, error, 'AI 服务请求失败')
  } finally {
    clearTimeout(timer)
    controller.abort()
    res.off('close', onClientClose)
  }
}
