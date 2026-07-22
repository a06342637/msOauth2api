'use strict'

const crypto = require('crypto')

class PublicError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'PublicError'
    this.status = status
  }
}

function setApiHeaders(res, methods = ['POST']) {
  const allow = [...new Set([...methods, 'OPTIONS'])].join(', ')
  res.setHeader('Allow', allow)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', allow)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}

function acceptRequest(req, res, methods = ['POST']) {
  setApiHeaders(res, methods)
  const method = String(req.method || 'GET').toUpperCase()
  if (method === 'OPTIONS') {
    res.status(204).end()
    return false
  }
  if (!methods.includes(method)) {
    res.status(405).json({ error: 'Method not allowed' })
    return false
  }
  return true
}

function requestSource(req) {
  const source = String(req.method || '').toUpperCase() === 'GET' ? req.query : req.body
  return source && typeof source === 'object' && !Array.isArray(source) ? source : {}
}

function getText(source, name, options = {}) {
  const { required = false, max = 10000, defaultValue = '', trim = true } = options
  let value = source?.[name]
  if (Array.isArray(value)) value = value[0]
  value = value == null ? defaultValue : String(value)
  if (trim) value = value.trim()
  if (required && !value) throw new PublicError(`Missing required parameter: ${name}`)
  if (value.length > max) throw new PublicError(`Parameter too long: ${name}`)
  return value
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function verifyPassword(source, envName, fieldName) {
  const expected = process.env[envName]
  if (!expected) return
  const supplied = getText(source, fieldName, { max: 1000, trim: false })
  if (!safeEqual(supplied, expected)) throw new PublicError('密码验证失败', 401)
}

function isEmail(value) {
  return typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function sendHandlerError(res, error, fallback = 'Request failed') {
  const status = error instanceof PublicError ? error.status : 500
  if (status >= 500) console.error(fallback, error)
  const message = error instanceof PublicError ? error.message : fallback
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) {
    try { res.end() } catch (_) {}
    return
  }
  return res.status(status).json({ error: message })
}

module.exports = {
  PublicError,
  acceptRequest,
  getText,
  isEmail,
  requestSource,
  safeEqual,
  sendHandlerError,
  setApiHeaders,
  verifyPassword
}
