'use strict'

const crypto = require('crypto')
const { ImapFlow } = require('imapflow')
const { simpleParser } = require('mailparser')
const { PublicError } = require('./api-utils')

const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0'
const IMAP_HOST = 'outlook.office365.com'
const ALLOWED_MAILBOXES = new Set(['INBOX', 'Junk'])
const TOKEN_CACHE_MAX = 100
const TOKEN_EXPIRY_MARGIN_MS = 90 * 1000
const tokenCache = new Map()
const pendingTokenRequests = new Map()

function parseUpstreamError(text) {
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { code: '', message: '' }
    const code = typeof data.error === 'string' ? data.error.trim() : ''
    const rawMessage = data.error_description || data.error?.message || ''
    const message = typeof rawMessage === 'string' ? rawMessage.trim().slice(0, 300) : ''
    return { code, message }
  } catch (_) {
    return { code: '', message: '' }
  }
}

function upstreamMessage(text, fallback) {
  const { message } = parseUpstreamError(text)
  return message || fallback
}

function tokenRequestError(text, responseStatus) {
  const { code, message } = parseUpstreamError(text)
  const details = `${code} ${message}`

  if (responseStatus === 400 || responseStatus === 401) {
    if (/invalid_client|unauthorized_client|AADSTS700016|AADSTS7000215|application[^.]*not found/i.test(details)) {
      return new PublicError('Client ID 不正确或应用不可用', 401)
    }
    if (/invalid_grant|interaction_required|consent_required|login_required|AADSTS(?:70000|700082|50173|50076|50079)|refresh token[^.]*?(?:expired|revoked|invalid)/i.test(details)) {
      return new PublicError('Refresh Token 不正确、已过期或已失效', 401)
    }
    if (/AADSTS90023|No applicable permissions were found/i.test(details)) {
      return new PublicError('Refresh Token 不包含 Microsoft Graph 邮件权限', 403)
    }
    return new PublicError('Client ID 或 Refresh Token 验证失败', 401)
  }

  if (responseStatus === 429) {
    return new PublicError('Microsoft 验证请求过于频繁，请稍后重试', 503)
  }
  if (responseStatus >= 500) {
    return new PublicError('Microsoft 验证服务暂时不可用，请稍后重试', 502)
  }
  return new PublicError(message || `Microsoft 令牌请求失败（${responseStatus}）`, 502)
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await response.text()
    return { response, text }
  } catch (error) {
    if (timedOut || error?.name === 'AbortError') {
      throw new PublicError('Microsoft 服务请求超时，请稍后重试', 504)
    }
    if (error instanceof PublicError) throw error
    throw new PublicError('无法连接 Microsoft 服务，请稍后重试', 502)
  } finally {
    clearTimeout(timer)
  }
}

function tokenCacheKey(refreshToken, clientId, scope) {
  return crypto
    .createHash('sha256')
    .update(clientId)
    .update('\0')
    .update(scope)
    .update('\0')
    .update(refreshToken)
    .digest('base64url')
}

function readCachedToken(key) {
  const cached = tokenCache.get(key)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    tokenCache.delete(key)
    return null
  }
  // Map 同时作为简单的 LRU，避免长期运行的实例无限保存账号令牌。
  tokenCache.delete(key)
  tokenCache.set(key, cached)
  return cached.data
}

function storeCachedToken(key, data) {
  const rawExpiresIn = Number(data.expires_in)
  const expiresIn = rawExpiresIn === 0 || rawExpiresIn < 0
    ? 0
    : (Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
      ? Math.min(rawExpiresIn, 86400)
      : 3600)
  const lifetimeMs = expiresIn * 1000
  // Never extend an upstream lifetime. For short-lived tokens, keep a 10% margin
  // instead of the normal 90 seconds so a still-valid token can be reused safely.
  const expiryMarginMs = Math.min(TOKEN_EXPIRY_MARGIN_MS, Math.max(1000, lifetimeMs * 0.1))
  tokenCache.set(key, {
    data,
    expiresAt: Date.now() + Math.max(0, lifetimeMs - expiryMarginMs)
  })
  while (tokenCache.size > TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value)
}

async function requestAccessToken(refreshToken, clientId, scope = '', options = {}) {
  refreshToken = String(refreshToken || '').trim()
  clientId = String(clientId || '').trim()
  if (!refreshToken) throw new PublicError('请填写 Refresh Token')
  if (!clientId) throw new PublicError('请填写 Client ID')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    throw new PublicError('Client ID 格式不正确，请填写 Microsoft 应用的 GUID')
  }

  const bypassCache = options?.bypassCache === true
  const requestedTimeout = Number(options?.timeoutMs)
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, 60000)
    : 20000
  const cacheKey = tokenCacheKey(refreshToken, clientId, scope)
  if (!bypassCache) {
    const cached = readCachedToken(cacheKey)
    if (cached) return cached
    const pending = pendingTokenRequests.get(cacheKey)
    if (pending) return pending
  }

  const request = (async () => {
    const body = {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }
    if (scope) body.scope = scope

    const { response, text } = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString()
    }, timeoutMs)
    if (!response.ok) throw tokenRequestError(text, response.status)

    let data
    try { data = JSON.parse(text) } catch (_) { throw new PublicError('Microsoft 返回了无效的令牌响应', 502) }
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      typeof data.access_token !== 'string' ||
      !data.access_token.trim()
    ) {
      throw new PublicError('Microsoft 未返回 Access Token', 502)
    }
    data.access_token = data.access_token.trim()
    if (!bypassCache) storeCachedToken(cacheKey, data)
    return data
  })()

  if (!bypassCache) pendingTokenRequests.set(cacheKey, request)
  try {
    return await request
  } finally {
    if (!bypassCache && pendingTokenRequests.get(cacheKey) === request) pendingTokenRequests.delete(cacheKey)
  }
}

function normalizeGraphMessage(item, fallbackRecipient = '', summaryOnly = false) {
  const body = item?.body && typeof item.body === 'object' && !Array.isArray(item.body) ? item.body : {}
  const recipients = Array.isArray(item?.toRecipients) ? item.toRecipients : []
  const isHtml = String(body.contentType || '').toLowerCase() === 'html'
  const base = {
    id: String(item?.id || ''),
    provider: 'graph',
    send: item?.from?.emailAddress?.address || '',
    to: recipients.map(entry => entry?.emailAddress?.address).filter(Boolean).join(', ') || fallbackRecipient,
    subject: item?.subject || '',
    preview: item?.bodyPreview || '',
    date: item?.receivedDateTime || item?.createdDateTime || ''
  }
  if (summaryOnly) return base
  return {
    ...base,
    text: isHtml ? (item?.bodyPreview || '') : (body.content || item?.bodyPreview || ''),
    html: isHtml ? (body.content || '') : ''
  }
}

async function graphJson(url, accessToken, fallbackMessage) {
  const { response, text } = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      Prefer: 'outlook.body-content-type="html"'
    }
  })
  if (!response.ok) {
    const status = response.status === 401 ? 401 : (response.status === 404 ? 404 : 502)
    throw new PublicError(upstreamMessage(text, `${fallbackMessage}（${response.status}）`), status)
  }
  try {
    return JSON.parse(text)
  } catch (_) {
    throw new PublicError('Microsoft Graph 返回了无效响应', 502)
  }
}

async function getGraphEmails(accessToken, mailbox, limit, email, summaryOnly = false) {
  const folder = mailbox === 'Junk' ? 'junkemail' : 'inbox'
  const fields = ['id', 'from', 'toRecipients', 'subject', 'bodyPreview', 'receivedDateTime', 'createdDateTime']
  if (!summaryOnly) fields.push('body')
  const query = new URLSearchParams({
    '$top': String(limit),
    '$orderby': 'receivedDateTime desc',
    '$select': fields.join(',')
  })
  const data = await graphJson(
    `${GRAPH_ROOT}/me/mailFolders/${folder}/messages?${query}`,
    accessToken,
    'Microsoft Graph 请求失败'
  )
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.value)) {
    throw new PublicError('Microsoft Graph 返回了无效响应', 502)
  }
  const messages = data.value
    .map(item => normalizeGraphMessage(item, email, summaryOnly))
    .filter(message => message.id)
  if (data.value.length > 0 && messages.length === 0) {
    throw new PublicError('Microsoft Graph 返回了无效的邮件列表', 502)
  }
  return messages
}

async function getGraphMessage(accessToken, id, email) {
  const query = new URLSearchParams({
    '$select': 'id,from,toRecipients,subject,bodyPreview,body,receivedDateTime,createdDateTime'
  })
  const data = await graphJson(
    `${GRAPH_ROOT}/me/messages/${encodeURIComponent(id)}?${query}`,
    accessToken,
    '读取邮件正文失败'
  )
  if (!data || typeof data !== 'object' || Array.isArray(data) || !String(data.id || '').trim()) {
    throw new PublicError('Microsoft Graph 返回了无效的邮件正文', 502)
  }
  return normalizeGraphMessage(data, email, false)
}

function createImapClient(email, accessToken) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    servername: IMAP_HOST,
    auth: { user: email, accessToken },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }
  })
  // ImapFlow 同时通过 Promise 和 error 事件报告故障。Promise 负责向 API
  // 返回错误，这个监听器只防止连接关闭期间产生未处理的 EventEmitter 错误。
  client.on('error', () => {})
  return client
}

async function closeImapClient(client) {
  if (!client) return
  try {
    if (client.usable) await client.logout()
    else client.close()
  } catch (_) {
    try { client.close() } catch (_) {}
  }
}

function imapErrorMessage(error) {
  return String(error?.responseText || error?.message || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/[A-Za-z0-9+/_=-]{120,}/g, '<redacted>')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300)
}

function toImapPublicError(error, action = 'IMAP 请求失败') {
  if (error instanceof PublicError) return error
  const code = String(error?.code || error?.responseStatus || '')
  const message = imapErrorMessage(error)
  const details = `${code} ${message}`

  if (/AUTHENTICATIONFAILED|authentication failed|invalid credentials|access token.*(?:invalid|expired)|oauth.*(?:invalid|failed)/i.test(details)) {
    return new PublicError('IMAP OAuth 登录失败，请确认邮箱地址与 Refresh Token 属于同一账号，并包含 IMAP.AccessAsUser.All 权限', 401)
  }
  if (/ETIMEOUT|CONNECT_TIMEOUT|GREETING_TIMEOUT|timed?\s*out|timeout/i.test(details)) {
    return new PublicError('IMAP 服务请求超时，请稍后重试', 504)
  }
  return new PublicError(`${action}：${message || 'IMAP 服务请求失败'}`, 502)
}

function formatImapAddresses(entries) {
  if (!Array.isArray(entries)) return ''
  return entries.map(entry => {
    const name = String(entry?.name || '').trim()
    const address = String(entry?.address || '').trim()
    if (name && address) return `${name} <${address}>`
    return address || name
  }).filter(Boolean).join(', ')
}

function normalizeImapEnvelope(message, email) {
  const envelope = message?.envelope && typeof message.envelope === 'object' ? message.envelope : {}
  return {
    id: String(message?.uid || ''),
    provider: 'imap',
    send: formatImapAddresses(envelope.from),
    to: formatImapAddresses(envelope.to) || email,
    subject: envelope.subject || '',
    preview: '',
    date: envelope.date || message?.internalDate || ''
  }
}

function normalizeImapMessage(mail, email, id) {
  const text = typeof mail?.text === 'string' ? mail.text : ''
  const html = typeof mail?.html === 'string' ? mail.html : ''
  return {
    id: String(id || ''),
    provider: 'imap',
    send: mail?.from?.text || '',
    to: mail?.to?.text || email,
    subject: mail?.subject || '',
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 300),
    date: mail?.date || '',
    text,
    html
  }
}

async function fetchImapMessages({ accessToken, email, mailbox, ids = null, limit = 100, summaryOnly = false }) {
  const client = createImapClient(email, accessToken)
  let lock
  let action = 'IMAP 连接失败'

  try {
    await client.connect()
    action = '无法打开邮箱文件夹'
    lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: 15000 })

    let range
    let fetchOptions
    if (ids) {
      const selectedIds = [...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
      if (!selectedIds.length) return []
      range = selectedIds.join(',')
      fetchOptions = { uid: true }
    } else {
      const messageCount = Number(client.mailbox?.exists) || 0
      if (messageCount === 0) return []
      range = `${Math.max(1, messageCount - limit + 1)}:*`
    }

    action = '读取邮件失败'
    const query = summaryOnly
      ? { uid: true, envelope: true, internalDate: true }
      : { uid: true, source: true }
    const messages = []

    for await (const message of client.fetch(range, query, fetchOptions)) {
      if (!Number.isSafeInteger(message?.uid) || message.uid <= 0) {
        throw new Error('邮件 UID 无效')
      }
      if (summaryOnly) {
        messages.push(normalizeImapEnvelope(message, email))
        continue
      }
      if (!Buffer.isBuffer(message.source)) throw new Error('邮件内容为空')
      let mail
      try {
        mail = await simpleParser(message.source, {
          skipHtmlToText: true,
          skipTextToHtml: true,
          skipImageLinks: true,
          maxHtmlLengthToParse: 2 * 1024 * 1024
        })
      } catch (error) {
        throw new PublicError(`解析邮件失败：${imapErrorMessage(error) || '邮件格式无效'}`, 502)
      }
      messages.push(normalizeImapMessage(mail, email, message.uid))
    }

    messages.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    return messages
  } catch (error) {
    throw toImapPublicError(error, action)
  } finally {
    try { lock?.release() } catch (_) {}
    await closeImapClient(client)
  }
}

function getImapEmails({ accessToken, email, mailbox, limit, summaryOnly = false }) {
  return fetchImapMessages({ accessToken, email, mailbox, limit, summaryOnly })
}

async function getImapMessage({ accessToken, email, mailbox, id }) {
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new PublicError('Invalid IMAP message id')
  }
  const messages = await fetchImapMessages({
    accessToken,
    email,
    mailbox,
    ids: [Number(id)],
    limit: 1,
    summaryOnly: false
  })
  if (!messages[0]) throw new PublicError('邮件不存在或已被删除', 404)
  return messages[0]
}

async function loadMailbox({ refreshToken, clientId, email, mailbox, limit = 100, summaryOnly = false }) {
  if (!ALLOWED_MAILBOXES.has(mailbox)) throw new PublicError('Invalid mailbox. Allowed: INBOX, Junk')
  const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 100)

  try {
    const graphToken = await requestAccessToken(refreshToken, clientId, 'https://graph.microsoft.com/.default')
    return await getGraphEmails(graphToken.access_token, mailbox, safeLimit, email, summaryOnly)
  } catch (_) { /* Token 可能仅授权 Outlook IMAP，继续使用 IMAP 回退。 */ }

  const imapToken = await requestAccessToken(refreshToken, clientId)
  return getImapEmails({ accessToken: imapToken.access_token, email, mailbox, limit: safeLimit, summaryOnly })
}

async function loadMessage({ refreshToken, clientId, email, mailbox, provider, id }) {
  if (!ALLOWED_MAILBOXES.has(mailbox)) throw new PublicError('Invalid mailbox. Allowed: INBOX, Junk')
  if (provider === 'graph') {
    const token = await requestAccessToken(refreshToken, clientId, 'https://graph.microsoft.com/.default')
    return getGraphMessage(token.access_token, id, email)
  }
  if (provider === 'imap') {
    const token = await requestAccessToken(refreshToken, clientId)
    return getImapMessage({ accessToken: token.access_token, email, mailbox, id })
  }
  throw new PublicError('Invalid message provider')
}

async function deleteImapMailbox({ accessToken, email, mailbox }) {
  const client = createImapClient(email, accessToken)
  let lock
  let action = 'IMAP 连接失败'

  try {
    await client.connect()
    action = '无法打开邮箱文件夹'
    lock = await client.getMailboxLock(mailbox, { acquireTimeout: 15000 })
    const messageCount = Number(client.mailbox?.exists) || 0
    if (messageCount === 0) return 0

    action = '无法删除邮件'
    const deleted = await client.messageDelete('1:*')
    if (!deleted) throw new Error('服务器未确认删除操作')
    return messageCount
  } catch (error) {
    throw toImapPublicError(error, action)
  } finally {
    try { lock?.release() } catch (_) {}
    await closeImapClient(client)
  }
}

async function clearMailbox({ refreshToken, clientId, email, mailbox }) {
  if (!ALLOWED_MAILBOXES.has(mailbox)) throw new PublicError('Invalid mailbox. Allowed: INBOX, Junk')
  const token = await requestAccessToken(refreshToken, clientId)
  return deleteImapMailbox({ accessToken: token.access_token, email, mailbox })
}

module.exports = {
  ALLOWED_MAILBOXES,
  clearMailbox,
  loadMailbox,
  loadMessage,
  requestAccessToken
}
