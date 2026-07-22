'use strict'

const { acceptRequest, getText, isEmail, requestSource, sendHandlerError, verifyPassword, PublicError } = require('../lib/api-utils')
const { loadMailbox } = require('../lib/mail-service')

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character])
}

function extractCode(message) {
  const content = `${message.subject || ''}\n${message.text || ''}\n${String(message.html || '').replace(/<[^>]*>/g, ' ')}`
  const match = content.match(/(?:^|\D)(\d{6})(?!\d)/)
  return match?.[1] || ''
}

module.exports = async (req, res) => {
  if (!acceptRequest(req, res, ['GET', 'POST'])) return

  try {
    const source = requestSource(req)
    verifyPassword(source, 'PASSWORD', 'password')

    const refreshToken = getText(source, 'refresh_token', { required: true, max: 20000 })
    const clientId = getText(source, 'client_id', { required: true, max: 200 })
    const email = getText(source, 'email', { required: true, max: 320 })
    const mailbox = getText(source, 'mailbox', { required: true, max: 20 })
    const responseType = getText(source, 'response_type', { defaultValue: 'json', max: 10 }).toLowerCase()
    if (!isEmail(email)) throw new PublicError('Invalid email address')
    if (!['json', 'html'].includes(responseType)) throw new PublicError('Invalid response_type. Allowed: json, html')

    const messages = await loadMailbox({ refreshToken, clientId, email, mailbox, limit: 1 })
    const message = messages[0] ? { ...messages[0], code: extractCode(messages[0]) } : {}

    if (responseType === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (!messages[0]) return res.status(200).send('<p>暂无邮件</p>')
      const safeText = escapeHtml(message.text || '').replace(/\n/g, '<br>')
      return res.status(200).send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(message.subject || '邮件')}</title></head><body><h2>${escapeHtml(message.subject || '（无主题）')}</h2><p><strong>发件人：</strong>${escapeHtml(message.send)}</p><p><strong>收件人：</strong>${escapeHtml(message.to)}</p><p><strong>时间：</strong>${escapeHtml(message.date)}</p>${message.code ? `<p><strong>验证码：</strong>${escapeHtml(message.code)}</p>` : ''}<hr><p>${safeText}</p></body></html>`)
    }

    return res.status(200).json(message)
  } catch (error) {
    return sendHandlerError(res, error, '读取最新邮件失败')
  }
}
