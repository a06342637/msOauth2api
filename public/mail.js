/* ========================================
   邮箱系统 - JavaScript
   极简主义交互设计
======================================== */

;(function () {
  'use strict'

  const CONFIG = {
    STORAGE_KEY: 'emailData',
    MAIL_ITEMS_PER_PAGE: 10,
    DEFAULT_ITEMS_PER_PAGE: 10,
    API_BASE: '/api/mail-all',
    MAIL_DETAIL_API: '/api/mail-detail',
    MAIL_REQUEST_TIMEOUT: 30000,
    MAIL_DETAIL_TIMEOUT: 20000,
    MAIL_DETAIL_CACHE_MAX: 20,
    MAIL_PREFETCH_MAX: 4,
    MAX_IMPORT_SIZE: 5 * 1024 * 1024,
    MAX_IMPORT_LINES: 10000,
    MAX_IMPORT_FILES: 1000,
    IMPORT_FILE_CONCURRENCY: 6,
    ACCOUNT_VALIDATION_API: '/api/refresh-token',
    ACCOUNT_VALIDATION_TIMEOUT: 25000,
    ACCOUNT_VALIDATION_CONCURRENCY: 4
  }

  const state = {
    emailData: [],
    mailData: [],
    currentPage: 1,
    currentMailPage: 1,
    itemsPerPage: CONFIG.DEFAULT_ITEMS_PER_PAGE,
    selectedItems: [],
    searchKeyword: '',
    currentMailbox: null,
    editingAccountIndex: null,
    mailRequestController: null,
    mailRequestId: 0,
    mailListLoading: false,
    mailListWarning: '',
    mailDetailCache: new Map(),
    mailDetailRequests: new Map(),
    mailDetailViewId: 0,
    mailDetailContextId: 0,
    mailPrefetchTimer: null,
    mailPrefetchActive: 0,
    importing: false,
    importOperationId: 0,
    importValidationController: null,
    accountSaveController: null,
    accountSaving: false
  }

  const $ = (sel, ctx = document) => ctx.querySelector(sel)
  const queryAll = (sel, ctx = document) => [...ctx.querySelectorAll(sel)]
  let toastTimer = null
  let lastFocusedElement = null

  const resetAccountEditorForm = () => {
    state.editingAccountIndex = null
    ;['#edit-email', '#edit-password', '#edit-client-id', '#edit-refresh-token'].forEach(selector => {
      const field = $(selector)
      if (field) field.value = ''
    })
  }

  const clearMailContent = () => {
    const content = $('#mail-modal-content')
    const iframe = content?.querySelector('iframe')
    iframe?._mailResizeObserver?.disconnect?.()
    iframe?._mailResizeTimers?.forEach?.(timer => clearTimeout(timer))
    content?.replaceChildren()
  }

  const abortMailDetailRequests = ({ clearCache = false } = {}) => {
    state.mailDetailContextId++
    clearTimeout(state.mailPrefetchTimer)
    state.mailPrefetchTimer = null
    state.mailPrefetchActive = 0
    state.mailDetailRequests.forEach(entry => entry.controller.abort())
    state.mailDetailRequests.clear()
    // 已完成的正文由有界 LRU 缓存管理。刷新列表或暂时返回账号页时保留它，
    // 再次打开同一封邮件无需重新请求；仅在明确要求时才全部清空。
    if (clearCache) state.mailDetailCache.clear()
    state.mailDetailViewId++
    clearMailContent()
  }

  /* ---------- 模态框 ---------- */
  const isModalOpen = modal => modal?.getAttribute('aria-hidden') === 'false'

  const cleanupModalState = id => {
    if (id === 'import-modal') {
      state.importOperationId++
      state.importValidationController?.abort()
      state.importValidationController = null
      state.importing = false
      const confirmButton = $('#import-confirm')
      if (confirmButton) {
        confirmButton.disabled = false
        confirmButton.textContent = '导入'
      }
      resetImportForm()
    } else if (id === 'edit-account-modal') {
      state.accountSaveController?.abort()
      state.accountSaveController = null
      state.accountSaving = false
      const saveButton = $('#edit-account-save')
      if (saveButton) {
        saveButton.disabled = false
        saveButton.textContent = '保存修改'
      }
      clearValidationStatus('#edit-validation-status')
      resetAccountEditorForm()
    } else if (id === 'delete-confirm-modal') {
      const count = $('#delete-confirm-count')
      if (count) count.textContent = '0'
    } else if (id === 'mail-modal') {
      state.mailDetailViewId++
      clearMailContent()
      ;['#mail-modal-title', '#mail-modal-sender', '#mail-modal-recipient', '#mail-modal-date'].forEach(selector => {
        const field = $(selector)
        if (field) field.textContent = ''
      })
    }
  }

  const openModal = (id) => {
    const modal = $(`#${id}`)
    if (!modal || isModalOpen(modal)) return
    lastFocusedElement = document.activeElement
    const modalBody = modal.querySelector('.modal-body')
    if (modalBody) modalBody.scrollTop = 0
    modal.style.display = 'flex'
    modal.setAttribute('aria-hidden', 'false')
    document.body.classList.add('modal-open')
    requestAnimationFrame(() => modal.querySelector('.modal-close, input, textarea, button')?.focus())
  }

  const closeModal = (id) => {
    const modal = $(`#${id}`)
    if (!modal || !isModalOpen(modal)) return
    modal.style.display = 'none'
    modal.setAttribute('aria-hidden', 'true')
    cleanupModalState(id)
    if (!queryAll('.modal-overlay').some(isModalOpen)) {
      document.body.classList.remove('modal-open')
      lastFocusedElement?.focus?.()
      lastFocusedElement = null
    }
  }

  const closeAllModals = () => {
    const visibleModals = queryAll('.modal-overlay').filter(isModalOpen)
    if (!visibleModals.length) return
    visibleModals.forEach(modal => {
      modal.style.display = 'none'
      modal.setAttribute('aria-hidden', 'true')
      cleanupModalState(modal.id)
    })
    document.body.classList.remove('modal-open')
    lastFocusedElement?.focus?.()
    lastFocusedElement = null
  }

  /* ---------- localStorage ---------- */
  const normalizeStoredAccount = item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const rawDelimiter = String(item.delimiter || '----')
    const delimiter = rawDelimiter.length <= 32 && !/[\r\n]/.test(rawDelimiter) ? rawDelimiter : '----'
    return {
      email: String(item.email || '').trim(),
      password: String(item.password || ''),
      clientId: String(item.clientId || '').trim(),
      refreshToken: String(item.refreshToken || '').trim(),
      delimiter
    }
  }

  const getEmailData = () => {
    try {
      const data = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || '[]')
      return Array.isArray(data) ? data.map(normalizeStoredAccount).filter(Boolean) : []
    } catch (_) {
      try { localStorage.removeItem(CONFIG.STORAGE_KEY) } catch (_) {}
      return []
    }
  }
  const setEmailData = (data) => {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data))
    } catch (_) {
      throw new Error('保存失败：浏览器本地存储空间不足或不可用')
    }
  }

  /* ---------- 工具函数 ---------- */
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char])
  const showToast = (message) => {
    const toast = $('#toast')
    if (!toast) return
    toast.textContent = message
    toast.style.display = 'block'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toast.style.display = 'none' }, 3600)
  }

  const clearValidationStatus = selector => {
    const status = $(selector)
    if (!status) return
    status.hidden = true
    status.dataset.tone = ''
    status.replaceChildren()
  }

  const setValidationStatus = (selector, options = {}) => {
    const status = $(selector)
    if (!status) return
    const { tone = 'info', title = '', message = '', details = [], action = null } = options
    status.hidden = false
    status.dataset.tone = tone
    status.replaceChildren()

    if (title || action) {
      const header = document.createElement('div')
      header.className = 'validation-status-header'
      if (title) {
        const heading = document.createElement('strong')
        heading.className = 'validation-status-title'
        heading.textContent = title
        header.appendChild(heading)
      }
      if (action?.label && typeof action.onClick === 'function') {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'btn btn-sm validation-status-action'
        button.textContent = action.label
        if (action.title) button.title = action.title
        button.addEventListener('click', action.onClick)
        header.appendChild(button)
      }
      status.appendChild(header)
    }
    if (message) {
      const copy = document.createElement('p')
      copy.className = 'validation-status-message'
      copy.textContent = message
      status.appendChild(copy)
    }
    if (details.length) {
      const list = document.createElement('ul')
      details.slice(0, 8).forEach(detail => {
        const item = document.createElement('li')
        item.textContent = detail
        list.appendChild(item)
      })
      if (details.length > 8) {
        const item = document.createElement('li')
        item.textContent = `另有 ${details.length - 8} 条未展开`
        list.appendChild(item)
      }
      status.appendChild(list)
    }
  }

  const makeValidationError = (message, validationType = 'invalid', status = 0) => {
    const error = new Error(message)
    error.validationType = validationType
    error.status = status
    return error
  }

  const createValidationAbortError = () => {
    const error = makeValidationError('凭证验证已取消', 'cancelled')
    error.name = 'AbortError'
    return error
  }

  const MICROSOFT_CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  const credentialApiMessage = (status, message, fallback = 'Client ID 或 Refresh Token 验证失败') => {
    const text = String(message || '').trim()
    if (status === 401 && !text) return fallback
    if (status === 401 && !/密码验证失败/.test(text) && !/(Client ID|Refresh Token|凭证|过期|失效|不正确|应用不可用|验证失败)/i.test(text)) {
      return fallback
    }
    return text || fallback
  }

  const validateAccountCredentials = async ({ clientId, refreshToken, signal } = {}) => {
    clientId = String(clientId || '').trim()
    refreshToken = String(refreshToken || '').trim()
    if (!clientId) throw makeValidationError('请填写 Client ID')
    if (!refreshToken) throw makeValidationError('请填写 Refresh Token')
    if (!MICROSOFT_CLIENT_ID_PATTERN.test(clientId)) {
      throw makeValidationError('Client ID 格式不正确，请填写 Microsoft 应用的 GUID')
    }
    if (signal?.aborted) throw createValidationAbortError()

    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = () => controller.abort()
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CONFIG.ACCOUNT_VALIDATION_TIMEOUT)

    try {
      const response = await fetch(CONFIG.ACCOUNT_VALIDATION_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ client_id: clientId, refresh_token: refreshToken }),
        signal: controller.signal
      })
      let data = null
      try { data = await response.json() } catch (_) {}
      if (!response.ok) {
        const message = credentialApiMessage(response.status, data?.error)
        const serviceFailure = response.status >= 500 || response.status === 429 || /密码验证失败/.test(message)
        throw makeValidationError(message, serviceFailure ? 'service' : 'invalid', response.status)
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw makeValidationError('凭证验证接口返回格式错误，请稍后重试', 'service', response.status)
      }

      const rotatedToken = typeof data.refresh_token === 'string' ? data.refresh_token.trim() : ''
      if (data.valid !== true && !rotatedToken) {
        throw makeValidationError('凭证验证接口未确认账号有效，请稍后重试', 'service', response.status)
      }
      return { refreshToken: rotatedToken || refreshToken }
    } catch (error) {
      if (error?.validationType) throw error
      if (signal?.aborted) throw createValidationAbortError()
      if (timedOut || error?.name === 'AbortError') {
        throw makeValidationError('验证 Client ID 和 Refresh Token 超时，请稍后重试', 'service', 504)
      }
      throw makeValidationError('无法连接凭证验证服务，请检查网络后重试', 'service', 502)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  /* ---------- 账号列表相关 ---------- */
  const getFilteredData = () => {
    const data = state.emailData
    const indexedData = data.map((item, index) => ({ ...item, index }))
    if (!state.searchKeyword) return indexedData
    const kw = state.searchKeyword.toLowerCase()
    return indexedData.filter(item =>
      String(item.email || '').toLowerCase().includes(kw)
    )
  }

  const renderTable = () => {
    const tbody = $('#email-table tbody')
    const filtered = getFilteredData()
    const start = (state.currentPage - 1) * state.itemsPerPage
    const end = start + state.itemsPerPage
    const pageData = filtered.slice(start, end)

    const formatRefreshToken = (token) => {
      const value = String(token || '')
      if (!value) return '—'
      if (value.length <= 16) return '••••••••••••'
      return `${value.slice(0, 6)}...${value.slice(-10)}`
    }

    if (pageData.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">暂无数据</td></tr>`
      updateSelectAllState()
      return
    }

    tbody.innerHTML = pageData.map((item) => {
      return `
        <tr data-index="${item.index}">
          <td class="check-col">
            <input type="checkbox" data-index="${item.index}" aria-label="选择 ${escapeHtml(item.email)}" ${state.selectedItems.includes(String(item.index)) ? 'checked' : ''}>
          </td>
          <td class="text-ellipsis account-email-cell">
            <button type="button" class="email-copy-button" data-action="copy-email" title="点击复制邮箱：${escapeHtml(item.email)}" aria-label="复制邮箱 ${escapeHtml(item.email)}">${escapeHtml(item.email)}</button>
          </td>
          <td class="text-ellipsis" title="${escapeHtml(item.clientId)}">${escapeHtml(item.clientId)}</td>
          <td class="refresh-token" title="Refresh Token 已隐藏，点击“编辑”查看完整内容">${escapeHtml(formatRefreshToken(item.refreshToken))}</td>
          <td>
            <div class="actions">
              <button type="button" class="btn btn-sm" data-action="edit">编辑</button>
              <button type="button" class="btn btn-sm" data-action="inbox">收件箱</button>
              <button type="button" class="btn btn-sm btn-danger" data-action="delete">删除</button>
            </div>
          </td>
        </tr>
      `
    }).join('')

    updateSelectAllState()
  }

  const updateSelectAllState = () => {
    const selectAll = $('#select-all')
    if (!selectAll) return

    const filteredIndexes = getFilteredData().map(item => String(item.index))
    const selectedCount = filteredIndexes.filter(index => state.selectedItems.includes(index)).length

    selectAll.checked = filteredIndexes.length > 0 && selectedCount === filteredIndexes.length
    selectAll.indeterminate = selectedCount > 0 && selectedCount < filteredIndexes.length

    const info = $('#pagination-info')
    if (info) {
      info.innerHTML = `共 ${filteredIndexes.length} 条 <span class="selected-count${state.selectedItems.length ? ' is-active' : ''}">已选择 ${state.selectedItems.length} 个</span>`
    }
    const batchActions = $('#batch-actions')
    if (batchActions) batchActions.hidden = state.selectedItems.length === 0
  }

  const getPaginationItems = (current, total) => {
    if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
    const pages = new Set([1, total, current - 1, current, current + 1])
    const ordered = [...pages].filter(page => page >= 1 && page <= total).sort((a, b) => a - b)
    const items = []
    ordered.forEach((page, index) => {
      if (index && page - ordered[index - 1] > 1) items.push('ellipsis')
      items.push(page)
    })
    return items
  }

  const renderPagination = () => {
    const filtered = getFilteredData()
    const total = filtered.length
    const totalPages = Math.ceil(total / state.itemsPerPage)
    const info = $('#pagination-info')
    const btns = $('#pagination-btns')

    info.innerHTML = `共 ${total} 条 <span class="selected-count${state.selectedItems.length ? ' is-active' : ''}">已选择 ${state.selectedItems.length} 个</span>`
    $('#batch-actions').hidden = state.selectedItems.length === 0

    if (totalPages <= 1) {
      btns.innerHTML = ''
      return
    }

    let html = `<button type="button" aria-label="上一页" ${state.currentPage <= 1 ? 'disabled' : ''} data-page="${state.currentPage - 1}">‹</button>`

    getPaginationItems(state.currentPage, totalPages).forEach(item => {
      html += item === 'ellipsis'
        ? '<span class="pagination-ellipsis" aria-hidden="true">…</span>'
        : `<button type="button" class="${item === state.currentPage ? 'active' : ''}" data-page="${item}"${item === state.currentPage ? ' aria-current="page"' : ''}>${item}</button>`
    })

    html += `<button type="button" aria-label="下一页" ${state.currentPage >= totalPages ? 'disabled' : ''} data-page="${state.currentPage + 1}">›</button>`

    btns.innerHTML = html
  }

  const render = () => {
    const maxIndex = state.emailData.length - 1
    state.selectedItems = state.selectedItems.filter(index => Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) <= maxIndex)
    const totalPages = Math.max(1, Math.ceil(getFilteredData().length / state.itemsPerPage))
    state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages)
    renderTable()
    renderPagination()
  }

  /* ---------- 账号操作 ---------- */
  const openAccountEditor = (index) => {
    const account = getEmailData()[index]
    if (!account) return

    state.accountSaveController?.abort()
    state.accountSaveController = null
    state.accountSaving = false
    clearValidationStatus('#edit-validation-status')
    const saveButton = $('#edit-account-save')
    if (saveButton) {
      saveButton.disabled = false
      saveButton.textContent = '保存修改'
    }
    state.editingAccountIndex = index
    $('#edit-email').value = account.email || ''
    $('#edit-password').value = account.password || ''
    $('#edit-client-id').value = account.clientId || ''
    $('#edit-refresh-token').value = account.refreshToken || ''
    openModal('edit-account-modal')
  }

  const saveAccountEditor = async () => {
    if (state.accountSaving) return
    const index = state.editingAccountIndex
    if (index === null) return

    const email = $('#edit-email').value.trim()
    const password = $('#edit-password').value.trim()
    const clientId = $('#edit-client-id').value.trim()
    const refreshToken = $('#edit-refresh-token').value.trim()

    if (!email || !password || !clientId || !refreshToken) {
      showToast('请完整填写邮箱、密码、Client ID 和 Refresh Token')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('请输入有效的邮箱地址')
      return
    }

    const initialData = getEmailData()
    if (!initialData[index]) return
    const duplicate = initialData.some((item, itemIndex) => itemIndex !== index && String(item.email || '').toLowerCase() === email.toLowerCase())
    if (duplicate) {
      showToast('该邮箱已存在，不能重复保存')
      return
    }
    if (email.length > 320 || password.length > 1000 || clientId.length > 200 || refreshToken.length > 20000) {
      showToast('账号字段过长，请缩短后重试')
      return
    }

    const controller = new AbortController()
    const saveButton = $('#edit-account-save')
    state.accountSaveController = controller
    state.accountSaving = true
    saveButton.disabled = true
    saveButton.textContent = '正在验证…'
    setValidationStatus('#edit-validation-status', {
      tone: 'pending',
      title: '正在验证凭证',
      message: '正在向 Microsoft 验证 Client ID 和 Refresh Token，请稍候。'
    })

    try {
      const verified = await validateAccountCredentials({ clientId, refreshToken, signal: controller.signal })
      if (controller.signal.aborted || state.editingAccountIndex !== index || !isModalOpen($('#edit-account-modal'))) return

      const data = getEmailData()
      if (!data[index]) throw new Error('账号已不存在，请关闭窗口后重试')
      const duplicateNow = data.some((item, itemIndex) => itemIndex !== index && String(item.email || '').toLowerCase() === email.toLowerCase())
      if (duplicateNow) throw new Error('该邮箱已存在，不能重复保存')

      data[index] = { ...data[index], email, password, clientId, refreshToken: verified.refreshToken }
      setEmailData(data)
      state.emailData = data
      state.accountSaveController = null
      state.accountSaving = false
      state.editingAccountIndex = null
      closeModal('edit-account-modal')
      render()
      showToast('凭证验证通过，账号信息已更新')
    } catch (error) {
      if (error?.validationType === 'cancelled' || controller.signal.aborted) return
      if (state.accountSaveController !== controller) return
      const message = error.message || 'Client ID 或 Refresh Token 验证失败'
      setValidationStatus('#edit-validation-status', {
        tone: error?.validationType === 'service' ? 'warning' : 'error',
        title: error?.validationType === 'service' ? '暂时无法验证，账号未保存' : '凭证验证失败，账号未保存',
        message
      })
      showToast('账号未保存：' + message)
    } finally {
      if (state.accountSaveController === controller) {
        state.accountSaveController = null
        state.accountSaving = false
        saveButton.disabled = false
        saveButton.textContent = '保存修改'
      }
    }
  }

  const deleteEmail = (index) => {
    const data = getEmailData()
    if (!data[index]) return
    data.splice(index, 1)
    try {
      setEmailData(data)
      state.emailData = data
      state.selectedItems = []
      render()
      showToast('账号已删除')
    } catch (error) {
      showToast(error.message)
    }
  }

  const copyToClipboard = async (text) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        return
      } catch (_) { /* 继续尝试兼容复制方案 */ }
    }
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;'
    textarea.setAttribute('readonly', '')
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    let copied = false
    try { copied = document.execCommand('copy') } finally { textarea.remove() }
    if (!copied) throw new Error('复制失败')
  }

  const createFailedAccountsCopyAction = entries => {
    const rows = [...entries]
      .sort((left, right) => Number(left?.lineNumber || 0) - Number(right?.lineNumber || 0))
      .map(entry => typeof entry === 'string' ? entry : entry?.sourceLine)
      .map(line => String(line || '').trim())
      .filter(Boolean)

    if (!rows.length) return null
    const label = `复制失败账号（${rows.length}）`
    return {
      label,
      title: '按原导入格式复制失败账号',
      onClick: async event => {
        const button = event.currentTarget
        button.disabled = true
        try {
          await copyToClipboard(rows.join('\n'))
          button.textContent = '已复制'
          showToast(`已复制 ${rows.length} 条导入失败的账号，可直接粘贴修改`)
          setTimeout(() => {
            if (!button.isConnected) return
            button.disabled = false
            button.textContent = label
          }, 1400)
        } catch (error) {
          button.disabled = false
          button.textContent = label
          showToast(error.message || '复制失败，请检查浏览器权限')
        }
      }
    }
  }

  const copySelectedAccounts = async () => {
    const data = getEmailData()
    const rows = state.selectedItems
      .map(Number)
      .sort((a, b) => a - b)
      .map(index => data[index])
      .filter(Boolean)
      .map(item => String(item.email || '') + '----' + String(item.password || ''))

    if (!rows.length) return
    try {
      await copyToClipboard(rows.join('\n'))
      showToast(`已复制 ${rows.length} 个账号（邮箱----密码）`)
    } catch (error) {
      showToast(error.message || '复制失败，请检查浏览器权限')
    }
  }

  const copyEmailAddress = async index => {
    const email = String(getEmailData()[index]?.email || '').trim()
    if (!email) return
    try {
      await copyToClipboard(email)
      showToast('已复制邮箱：' + email)
    } catch (error) {
      showToast(error.message || '复制失败，请检查浏览器权限')
    }
  }

  const exportSelectedAccounts = async () => {
    const data = getEmailData()
    const rows = state.selectedItems
      .map(Number)
      .sort((a, b) => a - b)
      .map(index => data[index])
      .filter(Boolean)
      .map(item => [item.email, item.password, item.clientId, item.refreshToken].join(item.delimiter || '----'))

    if (!rows.length) return
    try {
      await copyToClipboard(rows.join('\n'))
      showToast(`已复制 ${rows.length} 条账号，可直接粘贴导入`)
    } catch (err) {
      showToast(err.message || '复制失败，请检查浏览器权限')
    }
  }

  const batchDelete = () => {
    if (state.selectedItems.length === 0) {
      showToast('请先选择要删除的账号')
      return
    }

    $('#delete-confirm-count').textContent = state.selectedItems.length
    openModal('delete-confirm-modal')
  }

  const executeBatchDelete = () => {
    const selectedIndexes = new Set(state.selectedItems.map(Number))
    const data = getEmailData().filter((item, index) => !selectedIndexes.has(index))
    try {
      setEmailData(data)
      state.emailData = data
      state.selectedItems = []
      closeModal('delete-confirm-modal')
      render()
      showToast('删除成功')
    } catch (error) {
      showToast(error.message)
    }
  }

  /* ---------- 导入 ---------- */
  const readFileAsText = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => resolve(e.target.result || '')
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`))
    reader.readAsText(file)
  })

  const readFilesAsText = async (files, operationId) => {
    const contents = new Array(files.length)
    let cursor = 0
    let failed = false
    const worker = async () => {
      while (!failed) {
        if (operationId !== state.importOperationId) return
        const index = cursor++
        if (index >= files.length) return
        try {
          contents[index] = await readFileAsText(files[index])
        } catch (error) {
          failed = true
          throw error
        }
      }
    }
    const workerCount = Math.min(CONFIG.IMPORT_FILE_CONCURRENCY, files.length)
    await Promise.all(Array.from({ length: workerCount }, worker))
    return contents
  }

  const parseImportLines = (lines, delimiter, existingAccounts = []) => {
    const existingEmails = new Set(existingAccounts.map(item => String(item.email || '').trim().toLowerCase()).filter(Boolean))
    const candidates = []
    const invalidRows = []
    const invalidAccounts = []
    let duplicates = 0

    lines.forEach((line, index) => {
      const value = String(line || '').trim()
      if (!value) return
      const rowLabel = `第 ${index + 1} 行`
      const fields = value.split(delimiter).map(field => field.trim())
      if (fields.length < 4) {
        invalidRows.push(rowLabel + '：字段不足，应为邮箱、密码/Key、Client ID、Refresh Token')
        invalidAccounts.push({ lineNumber: index + 1, sourceLine: value })
        return
      }

      const [email, password, clientId, ...tokenParts] = fields
      const refreshToken = tokenParts.join(delimiter).trim()
      let reason = ''
      if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) reason = '邮箱格式不正确'
      else if (!password || password.length > 1000) reason = '密码/Key 为空或过长'
      else if (!clientId || clientId.length > 200) reason = 'Client ID 为空或过长'
      else if (!refreshToken || refreshToken.length > 20000) reason = 'Refresh Token 为空或过长'
      if (reason) {
        invalidRows.push(rowLabel + '：' + reason)
        invalidAccounts.push({ lineNumber: index + 1, sourceLine: value })
        return
      }

      const emailKey = email.toLowerCase()
      if (existingEmails.has(emailKey)) {
        duplicates++
        return
      }
      existingEmails.add(emailKey)
      candidates.push({ email, password, clientId, refreshToken, delimiter, lineNumber: index + 1, sourceLine: value })
    })

    return { candidates, invalidRows, invalidAccounts, duplicates }
  }

  const validateImportCandidates = async (candidates, options = {}) => {
    const { signal, onProgress } = options
    const results = new Array(candidates.length)
    let cursor = 0
    let completed = 0

    const worker = async () => {
      while (true) {
        if (signal?.aborted) throw createValidationAbortError()
        const index = cursor++
        if (index >= candidates.length) return
        const candidate = candidates[index]
        try {
          const verified = await validateAccountCredentials({
            clientId: candidate.clientId,
            refreshToken: candidate.refreshToken,
            signal
          })
          results[index] = { ok: true, candidate, refreshToken: verified.refreshToken }
        } catch (error) {
          if (error?.validationType === 'cancelled' || signal?.aborted) throw createValidationAbortError()
          results[index] = { ok: false, candidate, error }
        } finally {
          completed++
          onProgress?.(completed, candidates.length)
        }
      }
    }

    const workerCount = Math.min(CONFIG.ACCOUNT_VALIDATION_CONCURRENCY, candidates.length)
    await Promise.all(Array.from({ length: workerCount }, worker))
    return results
  }

  const resetImportForm = () => {
    $('#import-text').value = ''
    $('#import-file').value = ''
    $('#import-folder').value = ''
    $('#import-delimiter').value = '----'
    $('#file-info').textContent = '未选择文件'
    clearValidationStatus('#import-validation-status')
  }

  const importEmails = async () => {
    if (state.importing) return

    const delimiter = $('#import-delimiter').value.trim() || '----'
    const pastedText = $('#import-text').value.trim()
    const files = [...$('#import-file').files, ...$('#import-folder').files]

    if (!pastedText && files.length === 0) {
      showToast('请粘贴账号内容，或选择文件/文件夹')
      return
    }
    if (delimiter.length > 32 || /[\r\n]/.test(delimiter)) {
      showToast('分隔符不能包含换行且不能超过 32 个字符')
      return
    }
    if (files.length > CONFIG.MAX_IMPORT_FILES) {
      showToast('一次最多选择 1000 个文件')
      return
    }
    const totalSize = new Blob([pastedText]).size + files.reduce((sum, file) => sum + file.size, 0)
    if (totalSize > CONFIG.MAX_IMPORT_SIZE) {
      showToast('导入内容不能超过 5 MB')
      return
    }

    const confirmButton = $('#import-confirm')
    const operationId = ++state.importOperationId
    const controller = new AbortController()
    state.importValidationController?.abort()
    state.importValidationController = controller
    state.importing = true
    confirmButton.disabled = true
    confirmButton.textContent = '正在读取…'
    setValidationStatus('#import-validation-status', {
      tone: 'pending',
      title: '正在准备导入',
      message: '正在读取并检查账号格式，请稍候。'
    })

    try {
      // 文件读取和凭证验证期间均可通过关闭弹窗安全取消，取消后不会写入任何账号。
      const fileContents = await readFilesAsText(files, operationId)
      if (operationId !== state.importOperationId || controller.signal.aborted) return
      const content = [pastedText, ...fileContents].filter(Boolean).join('\n')
      const lines = content.split(/\r\n?|\n/)
      if (lines.length > CONFIG.MAX_IMPORT_LINES) throw new Error('一次最多导入 10000 行账号')

      const parsed = parseImportLines(lines, delimiter, getEmailData())
      if (parsed.candidates.length === 0) {
        const parts = [
          parsed.duplicates ? `重复账号 ${parsed.duplicates} 条` : '',
          parsed.invalidRows.length ? `格式错误 ${parsed.invalidRows.length} 条` : ''
        ].filter(Boolean)
        const message = parts.length ? parts.join('，') : '没有读取到账号数据'
        setValidationStatus('#import-validation-status', {
          tone: parsed.invalidRows.length ? 'error' : 'warning',
          title: '没有可验证的账号',
          message: message + '，未导入任何数据。',
          details: parsed.invalidRows,
          action: createFailedAccountsCopyAction(parsed.invalidAccounts)
        })
        showToast(message + '，未导入')
        return
      }

      confirmButton.textContent = `正在验证 0/${parsed.candidates.length}…`
      setValidationStatus('#import-validation-status', {
        tone: 'pending',
        title: '正在验证 Microsoft 凭证',
        message: `正在验证 0/${parsed.candidates.length}，只有 Client ID 和 Refresh Token 均有效的账号才会导入。`
      })

      const results = await validateImportCandidates(parsed.candidates, {
        signal: controller.signal,
        onProgress: (completed, total) => {
          if (operationId !== state.importOperationId || controller.signal.aborted) return
          confirmButton.textContent = `正在验证 ${completed}/${total}…`
          const progress = $('.validation-status-message', $('#import-validation-status'))
          if (progress) progress.textContent = `已验证 ${completed}/${total}，请勿关闭页面。`
        }
      })
      if (operationId !== state.importOperationId || controller.signal.aborted) return

      const credentialFailures = results.filter(result => !result.ok && result.error?.validationType !== 'service')
      const serviceFailures = results.filter(result => !result.ok && result.error?.validationType === 'service')
      const verifiedAccounts = results.filter(result => result.ok)
      const data = getEmailData()
      const latestEmails = new Set(data.map(item => String(item.email || '').trim().toLowerCase()).filter(Boolean))
      let duplicateCount = parsed.duplicates
      let importedCount = 0

      verifiedAccounts.forEach(result => {
        const emailKey = result.candidate.email.toLowerCase()
        if (latestEmails.has(emailKey)) {
          duplicateCount++
          return
        }
        latestEmails.add(emailKey)
        const { lineNumber, sourceLine, ...account } = result.candidate
        data.push({ ...account, refreshToken: result.refreshToken })
        importedCount++
      })

      if (importedCount > 0) {
        setEmailData(data)
        state.emailData = data
        state.currentPage = 1
        render()
      }

      const summaryParts = [
        `成功导入 ${importedCount} 条`,
        duplicateCount ? `重复 ${duplicateCount} 条` : '',
        parsed.invalidRows.length ? `格式错误 ${parsed.invalidRows.length} 条` : '',
        credentialFailures.length ? `凭证无效或过期 ${credentialFailures.length} 条` : '',
        serviceFailures.length ? `验证服务异常 ${serviceFailures.length} 条` : ''
      ].filter(Boolean)
      const summary = summaryParts.join('，')
      const failureDetails = [
        ...parsed.invalidRows,
        ...credentialFailures.map(result => `第 ${result.candidate.lineNumber} 行 ${result.candidate.email}：${result.error.message}`),
        ...serviceFailures.map(result => `第 ${result.candidate.lineNumber} 行 ${result.candidate.email}：${result.error.message}`)
      ]
      const failedAccounts = [
        ...parsed.invalidAccounts,
        ...credentialFailures.map(result => result.candidate),
        ...serviceFailures.map(result => result.candidate)
      ]
      const hasIssues = duplicateCount > 0 || parsed.invalidRows.length > 0 || credentialFailures.length > 0 || serviceFailures.length > 0

      if (importedCount > 0 && !hasIssues) {
        state.importValidationController = null
        closeModal('import-modal')
        showToast(summary + '，凭证均验证通过')
        return
      }

      setValidationStatus('#import-validation-status', {
        tone: importedCount > 0 ? 'warning' : 'error',
        title: importedCount > 0 ? '有效账号已导入，部分数据被跳过' : '凭证验证未通过，未导入账号',
        message: summary + '。无效、过期或无法完成验证的账号均未保存。',
        details: failureDetails,
        action: createFailedAccountsCopyAction(failedAccounts)
      })
      showToast(summary)
    } catch (error) {
      if (operationId !== state.importOperationId || controller.signal.aborted || error?.validationType === 'cancelled') return
      const message = error.message || '导入失败，请稍后重试'
      setValidationStatus('#import-validation-status', {
        tone: 'error',
        title: '导入失败，未写入本次数据',
        message
      })
      showToast(message)
    } finally {
      if (operationId === state.importOperationId) {
        if (state.importValidationController === controller) state.importValidationController = null
        state.importing = false
        confirmButton.disabled = false
        confirmButton.textContent = '导入'
      }
    }
  }

  /* ---------- 邮件列表 ---------- */
  const normalizeMailSummary = (item, mailbox = 'INBOX') => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    if (!['string', 'number'].includes(typeof item.id)) return null

    const id = String(item.id).trim()
    const provider = String(item.provider || '').trim().toLowerCase()
    if (!id || id.length > 1000 || !['graph', 'imap'].includes(provider)) return null

    const sourceMailbox = mailbox === 'Junk' ? 'Junk' : 'INBOX'
    const text = (value, max) => String(value ?? '').slice(0, max)
    return {
      id,
      provider,
      mailbox: sourceMailbox,
      send: text(item.send, 2000),
      to: text(item.to, 2000),
      subject: text(item.subject, 1000),
      preview: text(item.preview, 4000),
      date: text(item.date, 200)
    }
  }

  const renderMailSkeleton = () => {
    const tbody = $('#mail-table tbody')
    tbody.innerHTML = Array.from({ length: 6 }, (_, rowIndex) => `
      <tr class="mail-skeleton-row" aria-hidden="true">
        <td><span class="skeleton-line skeleton-address"></span></td>
        <td><span class="skeleton-line skeleton-address"></span></td>
        <td><span class="skeleton-line skeleton-subject"></span></td>
        <td><span class="skeleton-line skeleton-date"></span></td>
        <td><span class="skeleton-line skeleton-action"></span></td>
      </tr>
    `).join('')
    $('#mail-pagination-btns').replaceChildren()
  }

  const renderMailLoadError = message => {
    const tbody = $('#mail-table tbody')
    tbody.innerHTML = '<tr><td colspan="5" class="empty mail-load-error"><strong>邮件加载失败</strong><span></span><small>请点击右上角“刷新邮件”重试</small></td></tr>'
    $('.mail-load-error span', tbody).textContent = message || '请稍后重试'
    $('#mail-pagination-btns').replaceChildren()
  }

  const setMailListLoading = (loading, initial = false) => {
    state.mailListLoading = loading
    const table = $('#mail-table')
    const refreshButton = $('#refresh-mails')
    const status = $('#mail-list-status')
    table?.setAttribute('aria-busy', String(loading))
    if (refreshButton) {
      refreshButton.disabled = loading
      refreshButton.textContent = loading ? '↻ 正在刷新…' : '↻ 刷新邮件'
    }
    if (status) status.textContent = loading ? ' · 正在加载…' : (state.mailListWarning ? ' · ' + state.mailListWarning : '')
    if (loading && initial) renderMailSkeleton()
  }

  const loadMailList = async (refreshToken, clientId, email, mailbox, options = {}) => {
    const isRefresh = options.refresh === true
    if (isModalOpen($('#mail-modal'))) closeModal('mail-modal')
    state.mailRequestController?.abort()
    const controller = new AbortController()
    const requestId = ++state.mailRequestId
    state.mailRequestController = controller

    abortMailDetailRequests()
    state.currentMailbox = { refreshToken, clientId, email, mailbox }
    state.mailListWarning = ''
    if (!isRefresh) {
      state.mailData = []
      state.currentMailPage = 1
    }
    $('#current-mailbox-label').textContent = email + ' · ' + (mailbox === 'Junk' ? '垃圾箱' : '收件箱（含垃圾箱）')
    showMailSection()
    setMailListLoading(true, state.mailData.length === 0)

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CONFIG.MAIL_REQUEST_TIMEOUT)

    try {
      const folders = mailbox === 'INBOX' ? ['INBOX', 'Junk'] : [mailbox]
      const response = await fetch(CONFIG.API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          refresh_token: refreshToken,
          client_id: clientId,
          email,
          mailbox,
          summary: true,
          include_junk: folders.length > 1
        }),
        signal: controller.signal
      })
      let payload
      try { payload = await response.json() } catch (_) { throw new Error('邮件接口返回格式错误') }
      if (!response.ok) {
        const fallback = response.status === 401
          ? 'Client ID 或 Refresh Token 不正确、已过期或已失效，请编辑账号后重新验证'
          : ('请求失败（' + response.status + '）')
        throw new Error(credentialApiMessage(response.status, payload?.error, fallback))
      }
      if (controller.signal.aborted) {
        const abortError = new Error('邮件加载已取消')
        abortError.name = 'AbortError'
        throw abortError
      }

      let rawMailboxes
      let rawErrors
      if (folders.length === 1) {
        if (!Array.isArray(payload)) throw new Error('邮件接口返回格式错误')
        rawMailboxes = [{ mailbox, messages: payload }]
        rawErrors = []
      } else {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.mailboxes) || !Array.isArray(payload.errors)) {
          throw new Error('邮件接口返回格式错误')
        }
        rawMailboxes = payload.mailboxes
        rawErrors = payload.errors
      }

      const successes = []
      const returnedFolders = new Set()
      rawMailboxes.forEach(result => {
        const targetMailbox = result?.mailbox
        if (!folders.includes(targetMailbox) || returnedFolders.has(targetMailbox) || !Array.isArray(result?.messages)) {
          throw new Error('邮件接口返回格式错误')
        }
        const validData = result.messages.map(item => normalizeMailSummary(item, targetMailbox)).filter(Boolean)
        if (result.messages.length > 0 && validData.length === 0) throw new Error('邮件接口返回格式错误')
        returnedFolders.add(targetMailbox)
        successes.push({ mailbox: targetMailbox, data: validData })
      })
      if (!returnedFolders.has(mailbox)) throw new Error('邮件接口返回格式错误')

      const failures = rawErrors.map(result => {
        const targetMailbox = result?.mailbox
        if (!folders.includes(targetMailbox) || returnedFolders.has(targetMailbox)) throw new Error('邮件接口返回格式错误')
        returnedFolders.add(targetMailbox)
        return { mailbox: targetMailbox, error: new Error(String(result?.error || '').trim() || '加载失败') }
      })
      if (returnedFolders.size !== folders.length) throw new Error('邮件接口返回格式错误')

      const mergedData = []
      const seen = new Set()
      successes.forEach(result => {
        result.data.forEach(item => {
          // IMAP 的数字 ID 只在当前文件夹内唯一，不能跨收件箱和垃圾箱去重。
          const key = item.provider === 'imap'
            ? item.provider + ':' + result.mailbox + ':' + item.id
            : item.provider + ':' + item.id
          if (seen.has(key)) return
          seen.add(key)
          mergedData.push(item)
        })
      })
      mergedData.sort((left, right) => {
        const leftTime = Date.parse(left.date)
        const rightTime = Date.parse(right.date)
        if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) return rightTime - leftTime
        if (!Number.isNaN(rightTime)) return 1
        if (!Number.isNaN(leftTime)) return -1
        return 0
      })

      if (requestId !== state.mailRequestId) return
      state.mailData = mergedData
      state.mailListWarning = failures.map(entry => {
        const label = entry.mailbox === 'Junk' ? '垃圾箱' : '收件箱'
        const reason = String(entry.error?.message || '').trim()
        return label + '加载失败' + (reason ? '：' + reason : '')
      }).join('，')
      renderMailTable()
      if (state.mailListWarning) {
        showToast((isRefresh ? '邮件列表已刷新' : '收件箱已加载') + '，但' + state.mailListWarning)
      } else if (isRefresh) {
        showToast('邮件列表已刷新')
      }
    } catch (error) {
      if (error.name === 'AbortError' && !timedOut) return
      if (requestId === state.mailRequestId) {
        const message = timedOut ? '邮件加载超时，请稍后重试' : (error.message || '加载失败')
        state.mailListWarning = message
        if (state.mailData.length === 0) renderMailLoadError(message)
        showToast(message)
      }
    } finally {
      clearTimeout(timeout)
      if (requestId === state.mailRequestId) {
        state.mailRequestController = null
        setMailListLoading(false)
      }
    }
  }

  const scrollPageTop = () => {
    if (window.innerWidth < 768) window.scrollTo({ top: 0, behavior: 'auto' })
  }

  const showMailSection = () => {
    queryAll('.section').forEach(s => s.classList.remove('active'))
    $('#mail-section').classList.add('active')
    scrollPageTop()
  }

  const showAccountSection = () => {
    if (isModalOpen($('#mail-modal'))) closeModal('mail-modal')
    state.mailRequestId++
    state.mailRequestController?.abort()
    state.mailRequestController = null
    setMailListLoading(false)
    abortMailDetailRequests()
    queryAll('.section').forEach(s => s.classList.remove('active'))
    $('#account-section').classList.add('active')
    state.mailData = []
    state.currentMailPage = 1
    state.currentMailbox = null
    state.mailListWarning = ''
    scrollPageTop()
  }

  const formatMailDate = value => {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
  }

  const renderMailTable = () => {
    const tbody = $('#mail-table tbody')
    const total = state.mailData.length
    const totalPages = Math.max(1, Math.ceil(total / CONFIG.MAIL_ITEMS_PER_PAGE))
    state.currentMailPage = Math.min(Math.max(1, state.currentMailPage), totalPages)
    const start = (state.currentMailPage - 1) * CONFIG.MAIL_ITEMS_PER_PAGE
    const end = start + CONFIG.MAIL_ITEMS_PER_PAGE
    const pageData = state.mailData.slice(start, end)

    if (total === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">暂无邮件</td></tr>`
      $('#mail-pagination-btns').innerHTML = ''
      return
    }

    tbody.innerHTML = pageData.map((item, index) => `
      <tr tabindex="0" data-mail-index="${start + index}" aria-label="打开邮件：${escapeHtml(item.subject || '无主题')}${item.mailbox === 'Junk' ? '（垃圾箱）' : ''}">
        <td class="mail-address" title="${escapeHtml(item.send || '')}">${escapeHtml(item.send || '未知发件人')}</td>
        <td class="mail-address" title="${escapeHtml(item.to || state.currentMailbox?.email || '')}">${escapeHtml(item.to || state.currentMailbox?.email || '未知收件人')}</td>
        <td class="mail-subject">${item.mailbox === 'Junk' ? '<span class="mail-folder-badge" title="来自垃圾箱">垃圾箱</span>' : ''}<span class="mail-subject-text">${escapeHtml(item.subject || '(无主题)')}</span></td>
        <td class="mail-date">${escapeHtml(formatMailDate(item.date))}</td>
        <td><button type="button" class="btn btn-sm" data-action="view">查看</button></td>
      </tr>
    `).join('')

    renderMailPagination()
  }

  const renderMailPagination = () => {
    const totalPages = Math.max(1, Math.ceil(state.mailData.length / CONFIG.MAIL_ITEMS_PER_PAGE))
    const btns = $('#mail-pagination-btns')

    if (totalPages <= 1) {
      btns.innerHTML = ''
      return
    }

    let html = `<button type="button" aria-label="上一页" ${state.currentMailPage <= 1 ? 'disabled' : ''} data-page="${state.currentMailPage - 1}">‹</button>`

    getPaginationItems(state.currentMailPage, totalPages).forEach(item => {
      html += item === 'ellipsis'
        ? '<span class="pagination-ellipsis" aria-hidden="true">…</span>'
        : `<button type="button" class="${item === state.currentMailPage ? 'active' : ''}" data-page="${item}"${item === state.currentMailPage ? ' aria-current="page"' : ''}>${item}</button>`
    })

    html += `<button type="button" aria-label="下一页" ${state.currentMailPage >= totalPages ? 'disabled' : ''} data-page="${state.currentMailPage + 1}">›</button>`

    btns.innerHTML = html
  }

  const mailCacheKey = (item, mailbox = state.currentMailbox) => {
    const provider = String(item?.provider || '')
    const id = String(item?.id || '')
    if (!mailbox || !provider || !id) return ''
    const sourceMailbox = item?.mailbox === 'Junk' ? 'Junk' : (item?.mailbox === 'INBOX' ? 'INBOX' : String(mailbox.mailbox || ''))
    if (!sourceMailbox) return ''
    return JSON.stringify([
      String(mailbox.email || '').toLowerCase(),
      String(mailbox.clientId || ''),
      sourceMailbox,
      provider,
      id
    ])
  }

  const hasMailBody = item => item && (
    typeof item.html === 'string' ||
    typeof item.text === 'string'
  )
  const readMailDetailCache = key => {
    const detail = state.mailDetailCache.get(key)
    if (!detail) return null
    state.mailDetailCache.delete(key)
    state.mailDetailCache.set(key, detail)
    return detail
  }
  const storeMailDetailCache = (key, detail) => {
    state.mailDetailCache.delete(key)
    state.mailDetailCache.set(key, detail)
    while (state.mailDetailCache.size > CONFIG.MAIL_DETAIL_CACHE_MAX) {
      state.mailDetailCache.delete(state.mailDetailCache.keys().next().value)
    }
  }

  const syncMailFrameTheme = iframe => {
    if (!iframe) return
    const isDark = document.documentElement.dataset.theme === 'dark'
    iframe.classList.toggle('mail-frame-dark', isDark)

    try {
      const doc = iframe.contentDocument
      if (!doc) return
      let style = doc.getElementById('mail-workbench-theme')
      if (!style) {
        style = doc.createElement('style')
        style.id = 'mail-workbench-theme'
        ;(doc.head || doc.documentElement).appendChild(style)
      }
      // 外层反色让白底邮件变暗；媒体元素再次反色，避免图片和视频颜色失真。
      const layoutCss = 'html { color-scheme: light !important; } html, body { max-width: 100% !important; min-height: 0 !important; height: auto !important; overflow-x: hidden !important; overflow-y: visible !important; } img, picture, video, canvas, svg, table { max-width: 100% !important; } img, video { height: auto !important; } a, pre { overflow-wrap: anywhere !important; } pre { white-space: pre-wrap !important; }'
      const darkCss = 'img, picture, video, canvas { filter: invert(1) hue-rotate(180deg) !important; }'
      style.textContent = isDark ? `${layoutCss} ${darkCss}` : layoutCss
    } catch (_) { /* 邮件正文无法访问时仍保留 iframe 外层暗色处理 */ }
  }

  const fetchMailDetail = item => {
    if (hasMailBody(item)) return Promise.resolve(item)
    const box = state.currentMailbox ? { ...state.currentMailbox, mailbox: item?.mailbox || state.currentMailbox.mailbox } : null
    const key = mailCacheKey(item, box)
    if (!key || !box) {
      return Promise.resolve({ ...item, text: item?.preview || '', html: '' })
    }
    const cached = readMailDetailCache(key)
    if (cached) return Promise.resolve(cached)
    if (state.mailDetailRequests.has(key)) return state.mailDetailRequests.get(key).promise

    const controller = new AbortController()
    const contextId = state.mailDetailContextId
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CONFIG.MAIL_DETAIL_TIMEOUT)

    const promise = (async () => {
      try {
        const response = await fetch(CONFIG.MAIL_DETAIL_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            refresh_token: box.refreshToken,
            client_id: box.clientId,
            email: box.email,
            mailbox: box.mailbox,
            provider: item.provider,
            id: item.id
          }),
          signal: controller.signal
        })
        let data
        try { data = await response.json() } catch (_) { throw new Error('邮件正文接口返回格式错误') }
        if (!response.ok) {
          const fallback = response.status === 401
            ? 'Client ID 或 Refresh Token 不正确、已过期或已失效，请编辑账号后重新验证'
            : ('请求失败（' + response.status + '）')
          throw new Error(credentialApiMessage(response.status, data?.error, fallback))
        }
        if (!data || typeof data !== 'object' || Array.isArray(data) || !hasMailBody(data)) throw new Error('邮件正文接口返回格式错误')
        if ((data.html != null && typeof data.html !== 'string') || (data.text != null && typeof data.text !== 'string')) {
          throw new Error('邮件正文接口返回格式错误')
        }
        if (contextId !== state.mailDetailContextId) throw new Error('邮件正文加载已取消')

        const detail = { ...item, ...data, provider: item.provider, id: item.id, mailbox: item.mailbox }
        storeMailDetailCache(key, detail)
        return detail
      } catch (error) {
        if (error.name === 'AbortError') {
          throw new Error(timedOut ? '邮件正文加载超时，请稍后重试' : '邮件正文加载已取消')
        }
        throw error
      } finally {
        clearTimeout(timeout)
        if (state.mailDetailRequests.get(key)?.controller === controller) state.mailDetailRequests.delete(key)
      }
    })()

    state.mailDetailRequests.set(key, { controller, promise })
    return promise
  }

  const showMailContentLoading = preview => {
    clearMailContent()
    const content = $('#mail-modal-content')
    const loading = document.createElement('div')
    loading.className = 'mail-content-loading'
    loading.setAttribute('role', 'status')
    loading.innerHTML = '<span class="mail-body-spinner" aria-hidden="true"></span><strong>正在加载邮件正文…</strong>'
    if (preview) {
      const previewNode = document.createElement('p')
      previewNode.className = 'mail-preview'
      previewNode.textContent = preview
      loading.appendChild(previewNode)
    }
    content.appendChild(loading)
  }

  const renderMailContent = item => {
    clearMailContent()
    const content = $('#mail-modal-content')

    if (item.html) {
      // 用 sandbox iframe 隔离渲染邮件 HTML，阻止脚本访问 localStorage 等父页面资源。
      const iframe = document.createElement('iframe')
      iframe.className = 'mail-frame'
      iframe.setAttribute('sandbox', 'allow-same-origin')
      iframe.setAttribute('title', '邮件正文')
      iframe.setAttribute('referrerpolicy', 'no-referrer')
      iframe.setAttribute('scrolling', 'no')
      iframe._mailResizeTimers = []
      syncMailFrameTheme(iframe)

      let resizeFrame = 0
      let observedDocument = null
      const resize = () => {
        cancelAnimationFrame(resizeFrame)
        resizeFrame = requestAnimationFrame(() => {
          if (!iframe.isConnected) return
          try {
            const doc = iframe.contentDocument
            const height = Math.max(
              doc?.body?.scrollHeight || 0,
              doc?.body?.offsetHeight || 0,
              doc?.documentElement?.scrollHeight || 0,
              doc?.documentElement?.offsetHeight || 0,
              320
            )
            if (Math.abs((parseFloat(iframe.style.height) || 0) - height) > 1) iframe.style.height = height + 'px'
          } catch (_) {}
        })
      }
      const initialize = () => {
        if (!iframe.isConnected) return
        try {
          const doc = iframe.contentDocument
          if (!doc) return
          syncMailFrameTheme(iframe)
          if (iframe._mailScrollDocument !== doc) {
            iframe._mailScrollDocument = doc
            const scrollParent = iframe.closest('.modal-body')
            if (scrollParent) {
              doc.addEventListener('wheel', event => {
                if (event.ctrlKey) return
                const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? scrollParent.clientHeight : 1)
                const previous = scrollParent.scrollTop
                scrollParent.scrollTop += event.deltaY * unit
                if (scrollParent.scrollTop !== previous) event.preventDefault()
              }, { passive: false })

              let touchY = null
              doc.addEventListener('touchstart', event => {
                touchY = event.touches.length === 1 ? event.touches[0].clientY : null
              }, { passive: true })
              doc.addEventListener('touchmove', event => {
                if (touchY === null || event.touches.length !== 1) return
                const nextY = event.touches[0].clientY
                const previous = scrollParent.scrollTop
                scrollParent.scrollTop += touchY - nextY
                touchY = nextY
                if (scrollParent.scrollTop !== previous) event.preventDefault()
              }, { passive: false })
              const clearTouch = () => { touchY = null }
              doc.addEventListener('touchend', clearTouch, { passive: true })
              doc.addEventListener('touchcancel', clearTouch, { passive: true })
            }
            // iframe 获得焦点后，仍允许通过 Escape 关闭正文弹窗。
            doc.addEventListener('keydown', event => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              closeModal('mail-modal')
            })
          }
          if (observedDocument !== doc) {
            observedDocument = doc
            iframe._mailResizeObserver?.disconnect?.()
            if ('ResizeObserver' in window) {
              iframe._mailResizeObserver = new ResizeObserver(resize)
              if (doc.documentElement) iframe._mailResizeObserver.observe(doc.documentElement)
              if (doc.body) iframe._mailResizeObserver.observe(doc.body)
            }
            doc.querySelectorAll('img').forEach(image => {
              image.decoding = 'async'
              image.addEventListener('load', resize, { once: true })
              image.addEventListener('error', resize, { once: true })
            })
          }
          resize()
        } catch (_) { /* 无法读取时保留安全的默认高度 */ }
      }

      iframe.addEventListener('load', initialize)
      iframe.srcdoc = item.html
      content.appendChild(iframe)
      ;[0, 40, 160, 700].forEach(delay => {
        iframe._mailResizeTimers.push(setTimeout(initialize, delay))
      })
    } else {
      const pre = document.createElement('pre')
      pre.textContent = item.text || item.preview || '（邮件正文为空）'
      content.appendChild(pre)
    }
  }

  const loadMailDetailIntoModal = async (index, viewId) => {
    const item = state.mailData[index]
    if (!item) return
    try {
      const detail = await fetchMailDetail(item)
      if (viewId !== state.mailDetailViewId || $('#mail-modal').style.display !== 'flex') return
      await new Promise(resolve => requestAnimationFrame(resolve))
      if (viewId === state.mailDetailViewId) renderMailContent(detail)
    } catch (error) {
      if (viewId !== state.mailDetailViewId || $('#mail-modal').style.display !== 'flex') return
      clearMailContent()
      const content = $('#mail-modal-content')
      const errorBox = document.createElement('div')
      errorBox.className = 'mail-content-error'
      const message = document.createElement('p')
      message.textContent = error.message || '邮件正文加载失败'
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'btn btn-sm'
      retry.textContent = '重新加载'
      retry.addEventListener('click', () => {
        const key = mailCacheKey(state.mailData[index])
        if (key) state.mailDetailCache.delete(key)
        const nextViewId = ++state.mailDetailViewId
        showMailContentLoading(state.mailData[index]?.preview)
        loadMailDetailIntoModal(index, nextViewId)
      })
      errorBox.append(message, retry)
      content.appendChild(errorBox)
    }
  }

  const prefetchMailDetail = index => {
    const item = state.mailData[index]
    const key = mailCacheKey(item)
    if (!item || hasMailBody(item) || !key || state.mailDetailCache.has(key) || state.mailDetailRequests.has(key)) return
    if (state.mailPrefetchActive >= CONFIG.MAIL_PREFETCH_MAX) return
    const contextId = state.mailDetailContextId
    state.mailPrefetchActive++
    fetchMailDetail(item)
      .catch(() => {})
      .finally(() => {
        if (contextId === state.mailDetailContextId) {
          state.mailPrefetchActive = Math.max(0, state.mailPrefetchActive - 1)
        }
      })
  }

  const viewMailDetail = index => {
    const item = state.mailData[index]
    if (!item) return

    $('#mail-modal-title').textContent = item.subject || '（无主题）'
    $('#mail-modal-sender').textContent = item.send || '未知发件人'
    $('#mail-modal-recipient').textContent = item.to || state.currentMailbox?.email || '未知收件人'
    $('#mail-modal-date').textContent = formatMailDate(item.date)

    const viewId = ++state.mailDetailViewId
    showMailContentLoading(item.preview)
    openModal('mail-modal')
    loadMailDetailIntoModal(index, viewId)
  }

  /* ---------- 文件和文件夹选择 ---------- */
  const initUpload = () => {
    const fileInput = $('#import-file')
    const folderInput = $('#import-folder')
    const info = $('#file-info')

    $('#choose-files').addEventListener('click', () => fileInput.click())
    $('#choose-folder').addEventListener('click', () => folderInput.click())

    const updateFileInfo = () => {
      const files = [...fileInput.files, ...folderInput.files]
      if (files.length === 0) {
        info.textContent = '未选择文件'
      } else if (files.length === 1) {
        info.textContent = files[0].webkitRelativePath || files[0].name
      } else {
        info.textContent = `已选择 ${files.length} 个文件`
      }
    }

    fileInput.addEventListener('change', updateFileInfo)
    folderInput.addEventListener('change', updateFileInfo)
  }

  /* ---------- 事件绑定 ---------- */
  const bindEvents = () => {
    $('#theme-toggle').addEventListener('click', toggleTheme)

    document.addEventListener('click', e => {
      const closeButton = e.target.closest('[data-close-modal]')
      if (closeButton) closeModal(closeButton.closest('.modal-overlay').id)
    })

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return
      const visibleModals = queryAll('.modal-overlay').filter(isModalOpen)
      const modal = visibleModals[visibleModals.length - 1]
      if (!modal) return
      e.preventDefault()
      closeModal(modal.id)
    })


    // 搜索
    $('#search-input').addEventListener('input', e => {
      state.searchKeyword = e.target.value.trim()
      state.currentPage = 1
      render()
    })

    // 工具栏按钮
    $('#toolbar').addEventListener('click', e => {
      const action = e.target.dataset.action
      if (!action) return

      switch (action) {
        case 'import':
          if (state.importing) showToast('正在结束上一次导入，请稍候')
          else openModal('import-modal')
          break
        case 'delete':
          batchDelete()
          break
      }
    })

    $('#batch-actions').addEventListener('click', e => {
      const action = e.target.closest('button[data-action]')?.dataset.action
      if (action === 'copy-account') copySelectedAccounts()
      if (action === 'export') exportSelectedAccounts()
      if (action === 'delete') batchDelete()
    })

    // 账号表格操作
    $('#email-table tbody').addEventListener('click', e => {
      const btn = e.target.closest('button[data-action]')
      if (!btn) return

      const action = btn.dataset.action
      const tr = btn.closest('tr')
      const index = parseInt(tr.dataset.index, 10)

      switch (action) {
        case 'copy-email':
          copyEmailAddress(index)
          break
        case 'edit':
          openAccountEditor(index)
          break
        case 'inbox':
          if (state.emailData[index]) loadMailList(state.emailData[index].refreshToken, state.emailData[index].clientId, state.emailData[index].email, 'INBOX')
          break
        case 'junk':
          if (state.emailData[index]) loadMailList(state.emailData[index].refreshToken, state.emailData[index].clientId, state.emailData[index].email, 'Junk')
          break
        case 'delete':
          deleteEmail(index)
          break
      }
    })

    // 全选
    $('#select-all').addEventListener('change', e => {
      const filteredIndexes = getFilteredData().map(item => String(item.index))

      if (e.target.checked) {
        state.selectedItems = [...new Set([...state.selectedItems, ...filteredIndexes])]
      } else {
        state.selectedItems = state.selectedItems.filter(index => !filteredIndexes.includes(index))
      }

      render()
    })

    // 单选
    $('#email-table tbody').addEventListener('change', e => {
      if (e.target.type !== 'checkbox') return

      if (e.target.checked) {
        state.selectedItems = [...new Set([...state.selectedItems, e.target.dataset.index])]
      } else {
        state.selectedItems = state.selectedItems.filter(index => index !== e.target.dataset.index)
      }

      updateSelectAllState()
    })

    // 分页点击
    $('#pagination-btns').addEventListener('click', e => {
      const btn = e.target.closest('button[data-page]')
      if (btn && !btn.disabled) {
        state.currentPage = parseInt(btn.dataset.page, 10)
        render()
      }
    })

    // 每页条数
    $('#per-page').addEventListener('change', e => {
      state.itemsPerPage = parseInt(e.target.value, 10)
      state.currentPage = 1
      render()
    })

    // 邮件整行可用鼠标或键盘打开
    const openMailRow = target => {
      const tr = target.closest('tr[data-mail-index]')
      if (!tr) return
      viewMailDetail(Number(tr.dataset.mailIndex))
    }
    const mailTableBody = $('#mail-table tbody')
    const scheduleMailPrefetch = (target, delay = 120) => {
      const row = target.closest('tr[data-mail-index]')
      if (!row) return
      clearTimeout(state.mailPrefetchTimer)
      state.mailPrefetchTimer = setTimeout(() => prefetchMailDetail(Number(row.dataset.mailIndex)), delay)
    }
    mailTableBody.addEventListener('pointerdown', e => scheduleMailPrefetch(e.target, 0))
    mailTableBody.addEventListener('pointerover', e => {
      const row = e.target.closest('tr[data-mail-index]')
      if (!row || row.contains(e.relatedTarget)) return
      scheduleMailPrefetch(row)
    })
    mailTableBody.addEventListener('pointerout', e => {
      const row = e.target.closest('tr[data-mail-index]')
      if (!row || row.contains(e.relatedTarget)) return
      clearTimeout(state.mailPrefetchTimer)
    })
    mailTableBody.addEventListener('focusin', e => scheduleMailPrefetch(e.target, 80))
    mailTableBody.addEventListener('click', e => openMailRow(e.target))
    mailTableBody.addEventListener('keydown', e => {
      if (e.target.closest('button')) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      openMailRow(e.target)
    })

    // 邮件分页
    $('#mail-pagination-btns').addEventListener('click', e => {
      const btn = e.target.closest('button[data-page]')
      if (btn && !btn.disabled) {
        state.currentMailPage = parseInt(btn.dataset.page, 10)
        renderMailTable()
      }
    })

    // 返回和刷新当前邮箱
    $('#back-btn').addEventListener('click', showAccountSection)
    $('#refresh-mails').addEventListener('click', () => {
      const box = state.currentMailbox
      if (box && !state.mailListLoading) loadMailList(box.refreshToken, box.clientId, box.email, box.mailbox, { refresh: true })
    })

    // 编辑账号弹窗
    $('#edit-account-cancel').addEventListener('click', () => {
      state.editingAccountIndex = null
      closeModal('edit-account-modal')
    })
    $('#edit-account-save').addEventListener('click', saveAccountEditor)

    // 批量删除确认弹窗
    $('#delete-confirm-cancel').addEventListener('click', () => closeModal('delete-confirm-modal'))
    $('#delete-confirm-submit').addEventListener('click', executeBatchDelete)

    // 导入弹窗按钮
    $('#import-confirm').addEventListener('click', importEmails)

    // 关闭模态框
    queryAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) closeModal(overlay.id)
      })
    })

  }

  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme
    syncMailFrameTheme($('#mail-modal-content iframe'))
    try { localStorage.setItem('mailTheme', theme) } catch (_) {}
    const toggle = $('#theme-toggle')
    if (toggle) toggle.setAttribute('aria-label', theme === 'dark' ? '切换到明亮模式' : '切换到暗色模式')
  }

  const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')

  /* ---------- 初始化 ---------- */
  const init = () => {
    state.emailData = getEmailData()
    render()
    initUpload()
    bindEvents()
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

    // 暴露全局
    window.mailApp = {
      closeModal: closeAllModals
    }

    console.log('%c感谢您使用本项目！', 'color: #666; font-size: 11px;')
    console.log('%c项目地址: https://github.com/a06342637/msOauth2api  版本: 0.5.7', 'color: #007BFF; font-size: 12px;')
  }

  document.addEventListener('DOMContentLoaded', init)
})()
