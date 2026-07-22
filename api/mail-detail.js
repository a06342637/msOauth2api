'use strict'

const { acceptRequest, getText, isEmail, requestSource, sendHandlerError, verifyPassword, PublicError } = require('../lib/api-utils')
const { loadMessage } = require('../lib/mail-service')

module.exports = async (req, res) => {
  if (!acceptRequest(req, res, ['GET', 'POST'])) return

  try {
    const source = requestSource(req)
    verifyPassword(source, 'PASSWORD', 'password')

    const refreshToken = getText(source, 'refresh_token', { required: true, max: 20000 })
    const clientId = getText(source, 'client_id', { required: true, max: 200 })
    const email = getText(source, 'email', { required: true, max: 320 })
    const mailbox = getText(source, 'mailbox', { required: true, max: 20 })
    const provider = getText(source, 'provider', { required: true, max: 10 }).toLowerCase()
    const id = getText(source, 'id', { required: true, max: 1000 })

    if (!isEmail(email)) throw new PublicError('Invalid email address')
    if (!['graph', 'imap'].includes(provider)) throw new PublicError('Invalid message provider')

    const message = await loadMessage({ refreshToken, clientId, email, mailbox, provider, id })
    return res.status(200).json(message)
  } catch (error) {
    return sendHandlerError(res, error, '读取邮件正文失败')
  }
}
