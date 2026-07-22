'use strict'

const nodemailer = require('nodemailer')
const { acceptRequest, getText, isEmail, requestSource, sendHandlerError, verifyPassword, PublicError } = require('../lib/api-utils')
const { requestAccessToken } = require('../lib/mail-service')

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
    if (!text.trim() && !html.trim()) throw new PublicError('Missing required parameter: text or html')

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
      to,
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
