'use strict'

const crypto = require('crypto')
const Imap = require('node-imap')
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

function upstreamMessage(text, fallback) {
  try {
    const data = JSON.parse(text)
    const message = data.error_description || data.error?.message || data.error
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300)
  } catch (_) {}
  return fallback
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw new PublicError('Microsoft 服务请求超时，请稍后重试', 504)
    throw error
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
  const expiresIn = Math.max(Number(data.expires_in) || 3600, 120)
  tokenCache.set(key, {
    data,
    expiresAt: Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_MARGIN_MS
  })
  while (tokenCache.size > TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value)
}

async function requestAccessToken(refreshToken, clientId, scope = '', options = {}) {
  const bypassCache = options?.bypassCache === true
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

    const response = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString()
    })
    const text = await response.text()
    if (!response.ok) {
      const status = response.status === 400 || response.status === 401 ? 401 : 502
      throw new PublicError(upstreamMessage(text, `Microsoft 令牌请求失败（${response.status}）`), status)
    }

    let data
    try { data = JSON.parse(text) } catch (_) { throw new PublicError('Microsoft 返回了无效的令牌响应', 502) }
    if (!data.access_token) throw new PublicError('Microsoft 未返回 Access Token', 502)
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
  const body = item?.body || {}
  const isHtml = String(body.contentType || '').toLowerCase() === 'html'
  const base = {
    id: String(item?.id || ''),
    provider: 'graph',
    send: item?.from?.emailAddress?.address || '',
    to: (item?.toRecipients || []).map(entry => entry?.emailAddress?.address).filter(Boolean).join(', ') || fallbackRecipient,
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
  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      Prefer: 'outlook.body-content-type="html"'
    }
  })
  const text = await response.text()
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
  return (Array.isArray(data.value) ? data.value : []).map(item => normalizeGraphMessage(item, email, summaryOnly))
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
  return normalizeGraphMessage(data, email, false)
}

function createImap(email, accessToken) {
  const xoauth2 = Buffer.from(`user=${email}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64')
  return new Imap({
    user: email,
    xoauth2,
    host: IMAP_HOST,
    port: 993,
    tls: true,
    connTimeout: 15000,
    authTimeout: 15000,
    socketTimeout: 30000,
    tlsOptions: { servername: IMAP_HOST, rejectUnauthorized: true }
  })
}

function normalizeImapMessage(mail, email, id, summaryOnly) {
  const text = typeof mail?.text === 'string' ? mail.text : ''
  const html = typeof mail?.html === 'string' ? mail.html : ''
  const base = {
    id: String(id || ''),
    provider: 'imap',
    send: mail?.from?.text || '',
    to: mail?.to?.text || email,
    subject: mail?.subject || '',
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 300),
    date: mail?.date || ''
  }
  return summaryOnly ? base : { ...base, text, html }
}

function fetchImapMessages({ accessToken, email, mailbox, ids = null, limit = 100, summaryOnly = false }) {
  return new Promise((resolve, reject) => {
    const imap = createImap(email, accessToken)
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      try { imap.end() } catch (_) {}
      error ? reject(error) : resolve(value)
    }

    const fetchSelected = selectedIds => {
      if (!selectedIds.length) return finish(null, [])
      const parsed = []
      let fetcher
      const bodies = summaryOnly ? 'HEADER.FIELDS (FROM TO SUBJECT DATE)' : ''
      try {
        fetcher = imap.fetch(selectedIds, { bodies, markSeen: false })
      } catch (error) {
        return finish(new PublicError(`读取邮件失败：${error.message}`, 502))
      }

      fetcher.on('message', msg => {
        let uid = ''
        let parsedMail = null
        msg.once('attributes', attributes => { uid = String(attributes?.uid || '') })
        msg.on('body', stream => {
          parsedMail = simpleParser(stream, {
            skipHtmlToText: true,
            skipTextToHtml: true,
            skipImageLinks: true,
            maxHtmlLengthToParse: 2 * 1024 * 1024
          })
        })
        msg.once('end', () => {
          if (!parsedMail) {
            parsed.push(Promise.reject(new Error('邮件内容为空')))
            return
          }
          parsed.push(parsedMail.then(mail => normalizeImapMessage(mail, email, uid, summaryOnly)))
        })
      })
      fetcher.once('error', error => finish(new PublicError(`读取邮件失败：${error.message}`, 502)))
      fetcher.once('end', async () => {
        try {
          const messages = await Promise.all(parsed)
          messages.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
          finish(null, messages)
        } catch (error) {
          finish(new PublicError(`解析邮件失败：${error.message}`, 502))
        }
      })
    }

    imap.once('error', error => finish(new PublicError(`IMAP 连接失败：${error.message}`, 502)))
    imap.once('ready', () => {
      imap.openBox(mailbox, true, openError => {
        if (openError) return finish(new PublicError(`无法打开邮箱文件夹：${openError.message}`, 502))
        if (ids) return fetchSelected(ids)
        imap.search(['ALL'], (searchError, foundIds) => {
          if (searchError) return finish(new PublicError(`无法搜索邮件：${searchError.message}`, 502))
          fetchSelected((foundIds || []).slice(-limit))
        })
      })
    })
    imap.connect()
  })
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
  let graphError

  try {
    const graphToken = await requestAccessToken(refreshToken, clientId, 'https://graph.microsoft.com/.default')
    return await getGraphEmails(graphToken.access_token, mailbox, safeLimit, email, summaryOnly)
  } catch (error) {
    graphError = error
  }

  try {
    const imapToken = await requestAccessToken(refreshToken, clientId)
    return await getImapEmails({ accessToken: imapToken.access_token, email, mailbox, limit: safeLimit, summaryOnly })
  } catch (imapError) {
    if (imapError instanceof PublicError && imapError.status === 401) throw imapError
    if (graphError instanceof PublicError && graphError.status === 401) throw graphError
    throw imapError
  }
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

function deleteImapMailbox({ accessToken, email, mailbox }) {
  return new Promise((resolve, reject) => {
    const imap = createImap(email, accessToken)
    let settled = false
    const finish = (error, count = 0) => {
      if (settled) return
      settled = true
      try { imap.end() } catch (_) {}
      error ? reject(error) : resolve(count)
    }

    imap.once('error', error => finish(new PublicError(`IMAP 连接失败：${error.message}`, 502)))
    imap.once('ready', () => {
      imap.openBox(mailbox, false, openError => {
        if (openError) return finish(new PublicError(`无法打开邮箱文件夹：${openError.message}`, 502))
        imap.search(['ALL'], (searchError, ids) => {
          if (searchError) return finish(new PublicError(`无法搜索邮件：${searchError.message}`, 502))
          if (!ids?.length) return finish(null, 0)
          imap.addFlags(ids, ['\\Deleted'], flagError => {
            if (flagError) return finish(new PublicError(`无法标记邮件：${flagError.message}`, 502))
            imap.expunge(expungeError => {
              if (expungeError) return finish(new PublicError(`无法删除邮件：${expungeError.message}`, 502))
              finish(null, ids.length)
            })
          })
        })
      })
    })
    imap.connect()
  })
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
