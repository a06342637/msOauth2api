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
    MAX_IMPORT_SIZE: 5 * 1024 * 1024,
    MAX_IMPORT_LINES: 10000
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
    mailDetailCache: new Map(),
    mailDetailRequests: new Map(),
    mailDetailViewId: 0,
    mailPrefetchTimer: null,
    importing: false
  }

  const $ = (sel, ctx = document) => ctx.querySelector(sel)
  const queryAll = (sel, ctx = document) => [...ctx.querySelectorAll(sel)]
  let toastTimer = null
  let lastFocusedElement = null

  const clearMailContent = () => {
    const content = $('#mail-modal-content')
    const iframe = content?.querySelector('iframe')
    iframe?._mailResizeObserver?.disconnect?.()
    iframe?._mailResizeTimers?.forEach?.(timer => clearTimeout(timer))
    content?.replaceChildren()
  }

  const abortMailDetailRequests = () => {
    clearTimeout(state.mailPrefetchTimer)
    state.mailPrefetchTimer = null
    state.mailDetailRequests.forEach(entry => entry.controller.abort())
    state.mailDetailRequests.clear()
    state.mailDetailCache.clear()
    state.mailDetailViewId++
    clearMailContent()
  }

  /* ---------- Loading ---------- */
  const showLoading = () => {
    const overlay = $('#loading-overlay')
    overlay.style.display = 'flex'
    overlay.setAttribute('aria-hidden', 'false')
  }
  const hideLoading = () => {
    const overlay = $('#loading-overlay')
    overlay.style.display = 'none'
    overlay.setAttribute('aria-hidden', 'true')
  }

  /* ---------- 模态框 ---------- */
  const openModal = (id) => {
    const modal = $(`#${id}`)
    if (!modal) return
    lastFocusedElement = document.activeElement
    modal.style.display = 'flex'
    modal.setAttribute('aria-hidden', 'false')
    document.body.classList.add('modal-open')
    requestAnimationFrame(() => modal.querySelector('.modal-close, input, textarea, button')?.focus())
  }
  const closeModal = (id) => {
    const modal = $(`#${id}`)
    if (!modal) return
    modal.style.display = 'none'
    modal.setAttribute('aria-hidden', 'true')
    if (id === 'mail-modal') { state.mailDetailViewId++; clearMailContent() }
    if (![...document.querySelectorAll('.modal-overlay')].some(el => el.style.display === 'flex')) {
      document.body.classList.remove('modal-open')
      lastFocusedElement?.focus?.()
      lastFocusedElement = null
    }
  }
  const closeAllModals = () => {
    document.querySelectorAll('.modal-overlay').forEach(el => { el.style.display = 'none'; el.setAttribute('aria-hidden', 'true') })
    state.mailDetailViewId++
    clearMailContent()
    document.body.classList.remove('modal-open')
    lastFocusedElement?.focus?.()
    lastFocusedElement = null
  }

  /* ---------- localStorage ---------- */
  const getEmailData = () => {
    try {
      const data = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || '[]')
      return Array.isArray(data) ? data : []
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
    toastTimer = setTimeout(() => { toast.style.display = 'none' }, 2600)
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
      if (!token || token.length <= 16) return token || ''
      return `${token.slice(0, 6)}...${token.slice(-10)}`
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
          <td class="text-ellipsis" title="${escapeHtml(item.email)}">${escapeHtml(item.email)}</td>
          <td class="text-ellipsis" title="${escapeHtml(item.clientId)}">${escapeHtml(item.clientId)}</td>
          <td class="refresh-token" title="${escapeHtml(item.refreshToken)}">${escapeHtml(formatRefreshToken(item.refreshToken))}</td>
          <td>
            <div class="actions">
              <button type="button" class="btn btn-sm" data-action="edit">编辑</button>
              <button type="button" class="btn btn-sm" data-action="inbox">收件箱</button>
              <button type="button" class="btn btn-sm" data-action="junk">垃圾箱</button>
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

    state.editingAccountIndex = index
    $('#edit-email').value = account.email || ''
    $('#edit-password').value = account.password || ''
    $('#edit-client-id').value = account.clientId || ''
    $('#edit-refresh-token').value = account.refreshToken || ''
    openModal('edit-account-modal')
  }

  const saveAccountEditor = () => {
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

    const data = getEmailData()
    if (!data[index]) return
    const duplicate = data.some((item, itemIndex) => itemIndex !== index && String(item.email || '').toLowerCase() === email.toLowerCase())
    if (duplicate) {
      showToast('该邮箱已存在，不能重复保存')
      return
    }
    if (email.length > 320 || password.length > 1000 || clientId.length > 200 || refreshToken.length > 20000) {
      showToast('账号字段过长，请缩短后重试')
      return
    }
    data[index] = { ...data[index], email, password, clientId, refreshToken }
    try {
      setEmailData(data)
      state.emailData = data
      state.editingAccountIndex = null
      closeModal('edit-account-modal')
      render()
      showToast('账号信息已更新')
    } catch (error) {
      showToast(error.message)
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

  const resetImportForm = () => {
    $('#import-text').value = ''
    $('#import-file').value = ''
    $('#import-folder').value = ''
    $('#file-info').textContent = '未选择文件'
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
    const totalSize = new Blob([pastedText]).size + files.reduce((sum, file) => sum + file.size, 0)
    if (totalSize > CONFIG.MAX_IMPORT_SIZE) {
      showToast('导入内容不能超过 5 MB')
      return
    }

    const confirmButton = $('#import-confirm')
    state.importing = true
    confirmButton.disabled = true
    confirmButton.textContent = '导入中…'
    try {
      showLoading()
      const fileContents = await Promise.all(files.map(readFileAsText))
      const content = [pastedText, ...fileContents].filter(Boolean).join('\n')
      const lines = content.split(/\r\n?|\n/)
      if (lines.length > CONFIG.MAX_IMPORT_LINES) throw new Error('一次最多导入 10000 行账号')

      const data = getEmailData()
      const existingEmails = new Set(data.map(item => String(item.email || '').trim().toLowerCase()))
      let count = 0
      let skipped = 0
      let duplicates = 0

      lines.forEach(line => {
        const value = line.trim()
        if (!value) return

        const fields = value.split(delimiter).map(field => field.trim())
        if (fields.length < 4) {
          skipped++
          return
        }

        const [email, password, clientId, ...tokenParts] = fields
        const refreshToken = tokenParts.join(delimiter).trim()
        const validEmail = email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        if (!validEmail || !password || password.length > 1000 || !clientId || clientId.length > 200 || !refreshToken || refreshToken.length > 20000) {
          skipped++
          return
        }

        const emailKey = email.toLowerCase()
        if (existingEmails.has(emailKey)) {
          duplicates++
          return
        }

        existingEmails.add(emailKey)
        data.push({ email, password, clientId, refreshToken, delimiter })
        count++
      })

      if (count === 0) {
        showToast(duplicates > 0 && skipped === 0
          ? '检测到 ' + duplicates + ' 条重复账号，未重复导入'
          : '没有可导入的有效账号，请检查分隔符（当前：' + delimiter + '）')
        return
      }

      setEmailData(data)
      state.emailData = data
      state.currentPage = 1
      closeModal('import-modal')
      resetImportForm()
      render()
      const details = [duplicates ? '跳过 ' + duplicates + ' 条重复账号' : '', skipped ? '跳过 ' + skipped + ' 条无效数据' : ''].filter(Boolean).join('，')
      showToast('成功导入 ' + count + ' 条' + (details ? '，' + details : ''))
    } catch (error) {
      showToast(error.message || '读取文件失败')
    } finally {
      state.importing = false
      confirmButton.disabled = false
      confirmButton.textContent = '导入'
      hideLoading()
    }
  }

  /* ---------- 邮件列表 ---------- */
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
    if (status) status.textContent = loading ? ' · 正在加载…' : ''
    if (loading && initial) renderMailSkeleton()
  }

  const loadMailList = async (refreshToken, clientId, email, mailbox, options = {}) => {
    const isRefresh = options.refresh === true
    state.mailRequestController?.abort()
    const controller = new AbortController()
    const requestId = ++state.mailRequestId
    state.mailRequestController = controller

    abortMailDetailRequests()
    state.currentMailbox = { refreshToken, clientId, email, mailbox }
    if (!isRefresh) {
      state.mailData = []
      state.currentMailPage = 1
    }
    $('#current-mailbox-label').textContent = email + ' · ' + (mailbox === 'Junk' ? '垃圾箱' : '收件箱')
    showMailSection()
    setMailListLoading(true, state.mailData.length === 0)

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CONFIG.MAIL_REQUEST_TIMEOUT)

    try {
      const response = await fetch(CONFIG.API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ refresh_token: refreshToken, client_id: clientId, email, mailbox, summary: true }),
        signal: controller.signal
      })
      let data
      try { data = await response.json() } catch (_) { throw new Error('邮件接口返回格式错误') }
      if (!response.ok) throw new Error(data?.error || ('请求失败（' + response.status + '）'))
      if (!Array.isArray(data)) throw new Error('邮件接口返回格式错误')
      if (requestId !== state.mailRequestId) return

      state.mailData = data
      renderMailTable()
      if (isRefresh) showToast('邮件列表已刷新')
    } catch (error) {
      if (error.name === 'AbortError' && !timedOut) return
      if (requestId === state.mailRequestId) {
        const message = timedOut ? '邮件加载超时，请稍后重试' : (error.message || '加载失败')
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
    state.mailRequestId++
    state.mailRequestController?.abort()
    state.mailRequestController = null
    setMailListLoading(false)
    abortMailDetailRequests()
    hideLoading()
    queryAll('.section').forEach(s => s.classList.remove('active'))
    $('#account-section').classList.add('active')
    state.mailData = []
    state.currentMailPage = 1
    state.currentMailbox = null
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
      <tr tabindex="0" data-mail-index="${start + index}" aria-label="打开邮件：${escapeHtml(item.subject || '无主题')}">
        <td class="mail-address" title="${escapeHtml(item.send || '')}">${escapeHtml(item.send || '未知发件人')}</td>
        <td class="mail-address" title="${escapeHtml(item.to || state.currentMailbox?.email || '')}">${escapeHtml(item.to || state.currentMailbox?.email || '未知收件人')}</td>
        <td class="mail-subject">${escapeHtml(item.subject || '(无主题)')}</td>
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

  const mailCacheKey = item => item?.provider && item?.id ? `${item.provider}:${item.id}` : ''
  const hasMailBody = item => item && (
    Object.prototype.hasOwnProperty.call(item, 'html') ||
    Object.prototype.hasOwnProperty.call(item, 'text')
  )

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
      const layoutCss = 'html { color-scheme: light !important; } html, body { max-width: 100% !important; overflow-x: hidden !important; } img, picture, video, canvas, svg, table { max-width: 100% !important; } img, video { height: auto !important; } a, pre { overflow-wrap: anywhere !important; } pre { white-space: pre-wrap !important; }'
      const darkCss = 'img, picture, video, canvas { filter: invert(1) hue-rotate(180deg) !important; }'
      style.textContent = isDark ? `${layoutCss} ${darkCss}` : layoutCss
    } catch (_) { /* 邮件正文无法访问时仍保留 iframe 外层暗色处理 */ }
  }

  const fetchMailDetail = item => {
    if (hasMailBody(item)) return Promise.resolve(item)
    const key = mailCacheKey(item)
    if (!key || !state.currentMailbox) {
      return Promise.resolve({ ...item, text: item?.preview || '', html: '' })
    }
    if (state.mailDetailCache.has(key)) return Promise.resolve(state.mailDetailCache.get(key))
    if (state.mailDetailRequests.has(key)) return state.mailDetailRequests.get(key).promise

    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CONFIG.MAIL_DETAIL_TIMEOUT)
    const box = { ...state.currentMailbox }

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
        if (!response.ok) throw new Error(data?.error || ('请求失败（' + response.status + '）'))
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('邮件正文接口返回格式错误')

        const detail = { ...item, ...data }
        state.mailDetailCache.set(key, detail)
        const currentIndex = state.mailData.findIndex(entry => mailCacheKey(entry) === key)
        if (currentIndex >= 0) state.mailData[currentIndex] = detail
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
            const height = Math.max(doc?.body?.scrollHeight || 0, doc?.documentElement?.scrollHeight || 0, 320)
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
    if (!item || hasMailBody(item) || !mailCacheKey(item)) return
    fetchMailDetail(item).catch(() => {})
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
      if (e.key === 'Escape') closeAllModals()
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
          openModal('import-modal')
          break
        case 'delete':
          batchDelete()
          break
      }
    })

    $('#batch-actions').addEventListener('click', e => {
      const action = e.target.closest('button[data-action]')?.dataset.action
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
        if (e.target === overlay) closeAllModals()
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
    console.log('%c项目地址: https://github.com/a06342637/msOauth2api  版本: 0.5.1', 'color: #007BFF; font-size: 12px;')
  }

  document.addEventListener('DOMContentLoaded', init)
})()
