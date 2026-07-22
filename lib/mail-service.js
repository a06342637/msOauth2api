'use strict'

const Imap = require('node-imap')
const { simpleParser } = require('mailparser')
const { PublicError } = require('./api-utils')

const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0'
const IMAP_HOST = 'outlook.office365.com'
const ALLOWED_MAILBOXES = new Set(['INBOX', 'Junk'])

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

async function requestAccessToken(refreshToken, clientId, scope = '') {
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
  return data
}

function normalizeGraphMessage(item, fallbackRecipient = '') {
  const body = item?.body || {}
  const isHtml = String(body.contentType || '').toLowerCase() === 'html'
  return {
    send: item?.from?.emailAddress?.address || '',
    to: (item?.toRecipients || []).map(entry => entry?.emailAddress?.address).filter(Boolean).join(', ') || fallbackRecipient,
    subject: item?.subject || '',
    text: isHtml ? (item?.bodyPreview || '') : (body.content || item?.bodyPreview || ''),
    html: isHtml ? (body.content || '') : '',
    date: item?.receivedDateTime || item?.createdDateTime || ''
  }
}

async function getGraphEmails(accessToken, mailbox, limit, email) {
  const folder = mailbox === 'Junk' ? 'junkemail' : 'inbox'
  const query = new URLSearchParams({
    '$top': String(limit),
    '$orderby': 'receivedDateTime desc',
    '$select': 'from,toRecipients,subject,bodyPreview,body,receivedDateTime,createdDateTime'
  })
  const response = await fetchWithTimeout(`${GRAPH_ROOT}/me/mailFolders/${folder}/messages?${query}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  })
  const text = await response.text()
  if (!response.ok) throw new PublicError(upstreamMessage(text, `Microsoft Graph 请求失败（${response.status}）`), response.status === 401 ? 401 : 502)

  let data
  try { data = JSON.parse(text) } catch (_) { throw new PublicError('Microsoft Graph 返回了无效响应', 502) }
  return (Array.isArray(data.value) ? data.value : []).map(item => normalizeGraphMessage(item, email))
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

function getImapEmails({ accessToken, email, mailbox, limit }) {
  return new Promise((resolve, reject) => {
    const imap = createImap(email, accessToken)
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      try { imap.end() } catch (_) {}
      error ? reject(error) : resolve(value)
    }

    imap.once('error', error => finish(new PublicError(`IMAP 连接失败：${error.message}`, 502)))
    imap.once('ready', () => {
      imap.openBox(mailbox, true, openError => {
        if (openError) return finish(new PublicError(`无法打开邮箱文件夹：${openError.message}`, 502))
        imap.search(['ALL'], (searchError, ids) => {
          if (searchError) return finish(new PublicError(`无法搜索邮件：${searchError.message}`, 502))
          const selectedIds = (ids || []).slice(-limit)
          if (!selectedIds.length) return finish(null, [])

          const parsed = []
          let fetcher
          try { fetcher = imap.fetch(selectedIds, { bodies: '' }) } catch (error) { return finish(error) }
          fetcher.on('message', msg => {
            msg.on('body', stream => {
              parsed.push(simpleParser(stream, {
                skipHtmlToText: true,
                skipTextToHtml: true,
                skipImageLinks: true,
                maxHtmlLengthToParse: 2 * 1024 * 1024
              }).then(mail => ({
                send: mail.from?.text || '',
                to: mail.to?.text || email,
                subject: mail.subject || '',
                text: mail.text || '',
                html: mail.html || '',
                date: mail.date || ''
              })))
            })
          })
          fetcher.once('error', error => finish(new PublicError(`读取邮件失败：${error.message}`, 502)))
          fetcher.once('end', async () => {
            try {
              const emails = await Promise.all(parsed)
              emails.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
              finish(null, emails)
            } catch (error) {
              finish(new PublicError(`解析邮件失败：${error.message}`, 502))
            }
          })
        })
      })
    })
    imap.connect()
  })
}

async function loadMailbox({ refreshToken, clientId, email, mailbox, limit = 100 }) {
  if (!ALLOWED_MAILBOXES.has(mailbox)) throw new PublicError('Invalid mailbox. Allowed: INBOX, Junk')
  const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 100)
  let graphError

  try {
    const graphToken = await requestAccessToken(refreshToken, clientId, 'https://graph.microsoft.com/.default')
    return await getGraphEmails(graphToken.access_token, mailbox, safeLimit, email)
  } catch (error) {
    graphError = error
  }

  try {
    const imapToken = await requestAccessToken(refreshToken, clientId)
    return await getImapEmails({ accessToken: imapToken.access_token, email, mailbox, limit: safeLimit })
  } catch (imapError) {
    if (imapError instanceof PublicError && imapError.status === 401) throw imapError
    if (graphError instanceof PublicError && graphError.status === 401) throw graphError
    throw imapError
  }
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
  requestAccessToken
}
