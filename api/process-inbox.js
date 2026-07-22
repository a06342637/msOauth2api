'use strict'

const { acceptRequest, getText, isEmail, requestSource, sendHandlerError, verifyPassword, PublicError } = require('../lib/api-utils')
const { clearMailbox } = require('../lib/mail-service')

module.exports = async (req, res) => {
  if (!acceptRequest(req, res, ['GET', 'POST'])) return

  try {
    const source = requestSource(req)
    verifyPassword(source, 'PASSWORD', 'password')
    const refreshToken = getText(source, 'refresh_token', { required: true, max: 20000 })
    const clientId = getText(source, 'client_id', { required: true, max: 200 })
    const email = getText(source, 'email', { required: true, max: 320 })
    if (!isEmail(email)) throw new PublicError('Invalid email address')

    const deleted = await clearMailbox({ refreshToken, clientId, email, mailbox: 'INBOX' })
    return res.status(200).json({ message: 'Inbox processed successfully', deleted })
  } catch (error) {
    return sendHandlerError(res, error, '清空收件箱失败')
  }
}
