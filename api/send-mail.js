'use strict'

const nodemailer = require('nodemailer')
const addressparser = require('nodemailer/lib/addressparser')
const { acceptRequest, getText, isEmail, requestSource, sendHandlerError, verifyPassword, PublicError } = require('../lib/api-utils')
const { requestAccessToken } = require('../lib/mail-service')

function parseRecipients(value) {
  if (/[\r\n\0]/.test(value)) throw new PublicError('Invalid recipient address')

  let parsed
  try { parsed = addressparser(value) } catch (_) { throw new PublicError('Invalid recipient address') }
  const recipients = []
  let invalid = false
  const visit = entries => {
    for (const entry of entries || []) {
      if (Array.isArray(entry?.group)) {
        if (entry.group.length === 0) invalid = true
        visit(entry.group)
        continue
      }
      const address = String(entry?.address || '').trim()
      if (!isEmail(address)) {
        invalid = true
        continue
      }
      recipients.push({ name: String(entry?.name || '').trim(), address })
    }
  }
  visit(parsed)

  if (invalid || recipients.length === 0) throw new PublicError('Invalid recipient address')
  const unique = [...new Map(recipients.map(recipient => [recipient.address.toLowerCase(), recipient])).values()]
  if (unique.length > 50) throw new PublicError('Too many recipients. Maximum: 50')
  return unique
}

module.exports = async (req, res) => {
  if (!acceptRequest(req, res, ['GET', 'POST'])) return

  let transporter
  try {
    const source = requestSource(req)
    verifyPassword(source, 'SEND_PASSWORD', 'send_password')

    const refreshToken = getText(source, 'refresh_token', { required: true, max: 20000 })
    const clientId = getText(source, 'client_id', { required: true, max: 200 })
    const email = getText(source, 'email', { required: true, max: 320 })
    const to = getText(source, 'to', { required: true, max: 2000 })
    const subject = getText(source, 'subject', { required: true, max: 998 })
    const text = getText(source, 'text', { max: 1024 * 1024, trim: false })
    const html = getText(source, 'html', { max: 1024 * 1024, trim: false })

    if (!isEmail(email)) throw new PublicError('Invalid sender email address')
    if (/[\r\n\0]/.test(subject)) throw new PublicError('Invalid subject')
    if (!text.trim() && !html.trim()) throw new PublicError('Missing required parameter: text or html')
    const recipients = parseRecipients(to)

    const token = await requestAccessToken(refreshToken, clientId)
    transporter = nodemailer.createTransport({
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      requireTLS: true,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      auth: {
        type: 'OAuth2',
        user: email,
        clientId,
        accessToken: token.access_token
      },
      tls: { servername: 'smtp.office365.com', rejectUnauthorized: true }
    })

    const info = await transporter.sendMail({
      from: email,
      to: recipients,
      subject,
      ...(text ? { text } : {}),
      ...(html ? { html } : {})
    })
    return res.status(200).json({ message: 'Email sent successfully', messageId: info.messageId })
  } catch (error) {
    return sendHandlerError(res, error, '发送邮件失败')
  } finally {
    try { transporter?.close() } catch (_) {}
  }
}
