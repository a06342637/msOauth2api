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
    editingAccountIndex: null
  }

  const $ = (sel, ctx = document) => ctx.querySelector(sel)
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)]

  /* ---------- Loading ---------- */
  const showLoading = () => $('#loading-overlay').style.display = 'flex'
  const hideLoading = () => $('#loading-overlay').style.display = 'none'

  /* ---------- 模态框 ---------- */
  const openModal = (id) => {
    $(`#${id}`).style.display = 'flex'
    document.body.classList.add('modal-open')
  }
  const closeModal = (id) => {
    $(`#${id}`).style.display = 'none'
    if (![...document.querySelectorAll('.modal-overlay')].some(el => el.style.display === 'flex')) document.body.classList.remove('modal-open')
  }
  const closeAllModals = () => {
    document.querySelectorAll('.modal-overlay').forEach(el => { el.style.display = 'none' })
    document.body.classList.remove('modal-open')
  }

  /* ---------- localStorage ---------- */
  const getEmailData = () => {
    try {
      const data = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || '[]')
      return Array.isArray(data) ? data : []
    } catch (_) {
      localStorage.removeItem(CONFIG.STORAGE_KEY)
      return []
    }
  }
  const setEmailData = (data) => localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data))

  /* ---------- 工具函数 ---------- */
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char])
  const showToast = (message) => {
    const toast = $('#toast')
    if (!toast) return
    toast.textContent = message
    toast.style.display = 'block'
    setTimeout(() => toast.style.display = 'none', 2000)
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
            <input type="checkbox" data-index="${item.index}" ${state.selectedItems.includes(String(item.index)) ? 'checked' : ''}>
          </td>
          <td class="text-ellipsis" title="${escapeHtml(item.email)}">${escapeHtml(item.email)}</td>
          <td class="text-ellipsis" title="${escapeHtml(item.clientId)}">${escapeHtml(item.clientId)}</td>
          <td class="refresh-token" title="${escapeHtml(item.refreshToken)}">${escapeHtml(formatRefreshToken(item.refreshToken))}</td>
          <td>
            <div class="actions">
              <button class="btn btn-sm" data-action="edit">编辑</button>
              <button class="btn btn-sm" data-action="inbox">收件箱</button>
              <button class="btn btn-sm" data-action="junk">垃圾箱</button>
              <button class="btn btn-sm btn-danger" data-action="delete">删除</button>
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

    let html = `<button ${state.currentPage <= 1 ? 'disabled' : ''} data-page="${state.currentPage - 1}">‹</button>`

    for (let i = 1; i <= totalPages; i++) {
      html += `<button class="${i === state.currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`
    }

    html += `<button ${state.currentPage >= totalPages ? 'disabled' : ''} data-page="${state.currentPage + 1}">›</button>`

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

    const data = getEmailData()
    if (!data[index]) return
    const duplicate = data.some((item, itemIndex) => itemIndex !== index && String(item.email || '').toLowerCase() === email.toLowerCase())
    if (duplicate) {
      showToast('该邮箱已存在，不能重复保存')
      return
    }
    data[index] = { email, password, clientId, refreshToken }
    setEmailData(data)
    state.emailData = data
    state.editingAccountIndex = null
    closeModal('edit-account-modal')
    render()
    showToast('账号信息已更新')
  }

  const deleteEmail = (index) => {
    const data = getEmailData()
    data.splice(index, 1)
    setEmailData(data)
    state.emailData = data
    state.selectedItems = []
    render()
  }

  const copyToClipboard = async (text) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none;'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    if (!copied) throw new Error('复制失败')
  }

  const exportSelectedAccounts = async () => {
    const data = getEmailData()
    const rows = state.selectedItems
      .map(Number)
      .sort((a, b) => a - b)
      .map(index => data[index])
      .filter(Boolean)
      .map(item => [item.email, item.password, item.clientId, item.refreshToken].join('----'))

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
    setEmailData(data)
    state.emailData = data
    state.selectedItems = []
    closeModal('delete-confirm-modal')
    render()
    showToast('删除成功')
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
    const delimiter = $('#import-delimiter').value.trim() || '----'
    const pastedText = $('#import-text').value.trim()
    const files = [...$('#import-file').files, ...$('#import-folder').files]

    if (!pastedText && files.length === 0) {
      showToast('请粘贴账号内容，或选择文件/文件夹')
      return
    }

    try {
      showLoading()
      const fileContents = await Promise.all(files.map(readFileAsText))
      const content = [pastedText, ...fileContents].filter(Boolean).join('\n')
      const lines = content.split(/\r?\n/)
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
        if (!email || !password || !clientId || !refreshToken) {
          skipped++
          return
        }

        const emailKey = email.toLowerCase()
        if (existingEmails.has(emailKey)) {
          duplicates++
          return
        }

        existingEmails.add(emailKey)
        data.push({ email, password, clientId, refreshToken })
        count++
      })

      if (count === 0) {
        showToast(duplicates > 0 && skipped === 0
          ? `检测到 ${duplicates} 条重复账号，未重复导入`
          : `没有可导入的有效账号，请检查分隔符（当前：${delimiter}）`)
        return
      }

      setEmailData(data)
      state.emailData = data
      state.currentPage = 1
      closeModal('import-modal')
      resetImportForm()
      render()
      const details = [duplicates ? `跳过 ${duplicates} 条重复账号` : '', skipped ? `跳过 ${skipped} 条无效数据` : ''].filter(Boolean).join('，')
      showToast(`成功导入 ${count} 条${details ? `，${details}` : ''}`)
    } catch (err) {
      showToast(err.message || '读取文件失败')
    } finally {
      hideLoading()
    }
  }

  /* ---------- 邮件列表 ---------- */
  const loadMailList = (refreshToken, clientId, email, mailbox) => {
    state.currentMailbox = { refreshToken, clientId, email, mailbox }
    state.currentMailPage = 1
    $('#current-mailbox-label').textContent = `${email} · ${mailbox === 'Junk' ? '垃圾箱' : '收件箱'}`
    showLoading()
    const params = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      email,
      mailbox,
      response_type: 'json'
    })
    const apiUrl = `${CONFIG.API_BASE}?${params.toString()}`

    fetch(apiUrl)
      .then(r => {
        if (!r.ok) {
          if (r.status === 500) {
            return r.json().then(d => {
              if (d.error === 'Nothing to fetch') {
                state.mailData = []
                showMailSection()
                renderMailTable()
                return Promise.resolve()
              }
              throw new Error(d.error || '服务器错误')
            })
          }
          throw new Error(`请求失败: ${r.status}`)
        }
        return r.json()
      })
      .then(d => {
        if (d) {
          state.mailData = d
          showMailSection()
          renderMailTable()
        }
      })
      .catch(err => showToast(err.message || '加载失败'))

      .finally(() => hideLoading())
  }

  const showMailSection = () => {
    $$('.section').forEach(s => s.classList.remove('active'))
    $('#mail-section').classList.add('active')
  }

  const showAccountSection = () => {
    $$('.section').forEach(s => s.classList.remove('active'))
    $('#account-section').classList.add('active')
    state.mailData = []
    state.currentMailPage = 1
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

    tbody.innerHTML = pageData.map(item => `
      <tr>
        <td class="mail-address" title="${escapeHtml(item.send || '')}">${escapeHtml(item.send || '未知发件人')}</td>
        <td class="mail-address" title="${escapeHtml(item.to || state.currentMailbox?.email || '')}">${escapeHtml(item.to || state.currentMailbox?.email || '未知收件人')}</td>
        <td class="mail-subject">${escapeHtml(item.subject || '(无主题)')}</td>
        <td class="mail-date">${escapeHtml(item.date || '')}</td>
        <td><button class="btn btn-sm" data-action="view">查看</button></td>
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

    let html = `<button ${state.currentMailPage <= 1 ? 'disabled' : ''} data-page="${state.currentMailPage - 1}">‹</button>`

    for (let i = 1; i <= totalPages; i++) {
      html += `<button class="${i === state.currentMailPage ? 'active' : ''}" data-page="${i}">${i}</button>`
    }

    html += `<button ${state.currentMailPage >= totalPages ? 'disabled' : ''} data-page="${state.currentMailPage + 1}">›</button>`

    btns.innerHTML = html
  }

  const syncMailFrameTheme = (iframe) => {
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
      style.textContent = isDark
        ? 'img, picture, video, canvas { filter: invert(1) hue-rotate(180deg) !important; }'
        : ''
    } catch (_) { /* 邮件正文无法访问时仍保留 iframe 外层暗色处理 */ }
  }

  const viewMailDetail = (index) => {
    const item = state.mailData[index]
    if (!item) return

    $('#mail-modal-title').textContent = item.subject
    $('#mail-modal-sender').textContent = item.send || '未知发件人'
    $('#mail-modal-recipient').textContent = item.to || state.currentMailbox?.email || '未知收件人'
    $('#mail-modal-date').textContent = item.date || ''

    const content = $('#mail-modal-content')
    content.replaceChildren()

    if (item.html) {
      // 用 sandbox iframe 隔离渲染邮件 HTML，阻止脚本访问 localStorage 等父页面资源
      const iframe = document.createElement('iframe')
      iframe.setAttribute('sandbox', 'allow-same-origin')
      iframe.setAttribute('referrerpolicy', 'no-referrer')
      iframe.srcdoc = item.html
      iframe.setAttribute('scrolling', 'no')
      iframe.style.cssText = 'width:100%;border:0;min-height:400px;overflow:hidden;display:block;'
      content.appendChild(iframe)
      iframe.addEventListener('load', () => {
        try {
          const doc = iframe.contentDocument
          syncMailFrameTheme(iframe)
          const resize = () => {
            const h = Math.max(doc?.body?.scrollHeight || 0, doc?.documentElement?.scrollHeight || 0, 400)
            iframe.style.height = h + 'px'
          }
          resize()
          doc?.querySelectorAll('img').forEach(img => img.addEventListener('load', resize, { once: true }))
          requestAnimationFrame(resize)
          setTimeout(resize, 250)
          setTimeout(resize, 1000)
        } catch (e) { /* 无法读取时保留安全的默认高度 */ }
      })
    } else {
      const pre = document.createElement('pre')
      pre.textContent = item.text || ''
      pre.style.cssText = 'white-space:pre-wrap;word-wrap:break-word;margin:0;'
      content.appendChild(pre)
    }

    openModal('mail-modal')
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

    // 邮件表格操作
    $('#mail-table tbody').addEventListener('click', e => {
      const tr = e.target.closest('tr')
      if (!tr || tr.querySelector('.empty')) return

      const rows = [...tr.parentNode.children]
      const index = rows.indexOf(tr)
      const globalIndex = (state.currentMailPage - 1) * CONFIG.MAIL_ITEMS_PER_PAGE + index
      viewMailDetail(globalIndex)
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
      if (box) loadMailList(box.refreshToken, box.clientId, box.email, box.mailbox)
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
    $$('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) closeAllModals()
      })
    })

  }

  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme
    syncMailFrameTheme($('#mail-modal-content iframe'))
    localStorage.setItem('mailTheme', theme)
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

    // 暴露全局
    window.mailApp = {
      closeModal: closeAllModals
    }

    console.log('%c感谢您使用本项目！', 'color: #666; font-size: 11px;')
    console.log('%c项目地址: https://github.com/a06342637/msOauth2api  版本: 0.5.1', 'color: #007BFF; font-size: 12px;')
  }

  document.addEventListener('DOMContentLoaded', init)
})()
