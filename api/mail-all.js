'use strict'

const { acceptRequest, getText, isEmail, requestSource, sendHandlerError, verifyPassword, PublicError } = require('../lib/api-utils')
const { loadMailbox } = require('../lib/mail-service')

module.exports = async (req, res) => {
  if (!acceptRequest(req, res, ['GET', 'POST'])) return

  try {
    const source = requestSource(req)
    verifyPassword(source, 'PASSWORD', 'password')

    const refreshToken = getText(source, 'refresh_token', { required: true, max: 20000 })
    const clientId = getText(source, 'client_id', { required: true, max: 200 })
    const email = getText(source, 'email', { required: true, max: 320 })
    const mailbox = getText(source, 'mailbox', { required: true, max: 20 })
    const summary = getText(source, 'summary', { defaultValue: 'false', max: 5 }).toLowerCase()
    const includeJunk = getText(source, 'include_junk', { defaultValue: 'false', max: 5 }).toLowerCase()
    if (!isEmail(email)) throw new PublicError('Invalid email address')
    if (!['true', 'false', '1', '0'].includes(summary)) throw new PublicError('Invalid summary value')
    if (!['true', 'false', '1', '0'].includes(includeJunk)) throw new PublicError('Invalid include_junk value')

    const summaryOnly = summary === 'true' || summary === '1'
    const shouldIncludeJunk = includeJunk === 'true' || includeJunk === '1'
    const load = targetMailbox => loadMailbox({
      refreshToken, clientId, email, mailbox: targetMailbox, limit: 100, summaryOnly
    })

    if (shouldIncludeJunk) {
      if (mailbox !== 'INBOX') throw new PublicError('include_junk is only supported with INBOX')

      // 同一个函数实例内并行加载两个文件夹，让 Access Token 请求能够复用并发缓存，
      // 同时避免前端为收件箱和垃圾箱分别触发两次 Serverless 调用。
      const folders = ['INBOX', 'Junk']
      const settled = await Promise.allSettled(folders.map(load))
      if (settled[0].status === 'rejected') throw settled[0].reason

      const mailboxes = []
      const errors = []
      settled.forEach((result, index) => {
        const targetMailbox = folders[index]
        if (result.status === 'fulfilled') {
          mailboxes.push({ mailbox: targetMailbox, messages: result.value })
        } else {
          errors.push({
            mailbox: targetMailbox,
            error: result.reason instanceof PublicError ? result.reason.message : '读取邮件失败'
          })
        }
      })
      return res.status(200).json({ mailboxes, errors })
    }

    const messages = await load(mailbox)
    return res.status(200).json(messages)
  } catch (error) {
    return sendHandlerError(res, error, '读取邮件失败')
  }
}
