'use strict'

const { acceptRequest, getText, requestSource, sendHandlerError, verifyPassword } = require('../lib/api-utils')
const { requestAccessToken } = require('../lib/mail-service')

module.exports = async (req, res) => {
  if (!acceptRequest(req, res, ['GET', 'POST'])) return

  try {
    const source = requestSource(req)
    verifyPassword(source, 'PASSWORD', 'password')
    const refreshToken = getText(source, 'refresh_token', { required: true, max: 20000 })
    const clientId = getText(source, 'client_id', { required: true, max: 200 })
    const data = await requestAccessToken(refreshToken, clientId, '', { bypassCache: true })
    return res.status(200).json({ valid: true, refresh_token: data.refresh_token || refreshToken })
  } catch (error) {
    return sendHandlerError(res, error, '刷新 Token 失败')
  }
}
