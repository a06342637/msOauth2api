'use strict'

const { acceptRequest, sendHandlerError, verifyPassword, PublicError } = require('../lib/api-utils')

const MAX_BODY_LENGTH = 1024 * 1024
const AI_TIMEOUT_MS = 50000

function waitForDrain(res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false)
  return new Promise(resolve => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
    }
    const onDrain = () => { cleanup(); resolve(true) }
    const onClose = () => { cleanup(); resolve(false) }
    res.once('drain', onDrain)
    res.once('close', onClose)
  })
}

function getEndpoint(baseUrl) {
  let url
  try { url = new URL(baseUrl) } catch (_) { throw new PublicError('AI_API_URL 配置无效', 500) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new PublicError('AI_API_URL 配置无效', 500)
  const base = url.toString().replace(/\/+$/, '')
  return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
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
    if (serializedMessages.length > MAX_BODY_LENGTH) throw new PublicError('messages 内容过大', 413)

    const upstream = await fetch(getEndpoint(apiUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: `{"model":${JSON.stringify(model)},"messages":${serializedMessages},"stream":true}`,
      signal: controller.signal
    })

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
      const { done, value } = await reader.read()
      if (done) break
      if (clientClosed) return
      if (!res.write(Buffer.from(value)) && !await waitForDrain(res)) return
    }
    return res.end()
  } catch (error) {
    if (clientClosed) return
    if (error?.name === 'AbortError') error = new PublicError('AI 服务请求超时', 504)
    if (res.headersSent) {
      console.error('AI stream error', error)
      res.write(`event: error\ndata: ${JSON.stringify({ error: error instanceof PublicError ? error.message : 'AI 服务请求失败' })}\n\n`)
      return res.end()
    }
    return sendHandlerError(res, error, 'AI 服务请求失败')
  } finally {
    clearTimeout(timer)
    res.off('close', onClientClose)
  }
}
