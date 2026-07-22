# MS OAuth2API

Microsoft OAuth2 邮件 API 与本地邮箱工作台。当前版本：**0.5.7**。

账号数据仅保存在浏览器的 localStorage 中，不会写入仓库或服务端数据库。

## 一键部署到 Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/a06342637/msOauth2api)

部署完成后访问站点根地址，会直接进入邮箱工作台（`/mail.html`）。

> Vercel 域名在部分网络环境下可能无法直接访问，可以绑定自己的域名。

## 邮箱工作台

导入格式为每行一个账号：

```text
邮箱----密码或Key----Client ID----Refresh Token
```

- 默认分隔符为 `----`，导入时可以自定义。
- 支持粘贴文本、选择文件或选择文件夹。
- 同一邮箱地址不会重复导入。
- 导入验证失败后可一键复制失败账号，修改后可直接重新导入。
- 支持搜索、分页、编辑、单个/批量删除和复制导出。
- 点击收件箱会合并加载收件箱和垃圾箱，垃圾箱邮件会显示“垃圾箱”标记。
- 支持刷新当前邮箱以及查看邮件详情。
- 邮件列表先加载轻量摘要，正文按需加载并在当前邮箱中缓存，减少等待和重复请求。
- 支持明亮/暗色主题。

## 环境变量

| 变量名 | 必填 | 说明 |
| --- | --- | --- |
| `PASSWORD` | 否 | 保护取件、清空邮箱、刷新 Token 和 AI API。配置后，直接调用这些 API 时必须传入 `password`。邮箱工作台不提供密码输入，因此使用工作台时请不要配置此变量。 |
| `SEND_PASSWORD` | 否 | 保护 `/api/send-mail`；配置后必须传入 `send_password`。 |
| `AI_API_KEY` | 否 | 独立 AI 代理接口使用的 API Key。 |
| `AI_API_URL` | 否 | OpenAI 兼容接口地址，例如 `https://api.example.com`。 |
| `AI_MODEL` | 否 | AI 代理接口使用的模型名称。 |

## API

所有邮件类接口都支持 `GET` 和 `POST`；推荐使用 `POST` JSON，避免 Token 出现在 URL 和访问日志中。

### 获取最新邮件

- `GET/POST /api/mail-new`
- 必填：`refresh_token`、`client_id`、`email`、`mailbox`
- `mailbox`：`INBOX` 或 `Junk`
- 可选：`response_type`（`json` 或 `html`，默认 `json`）、`password`
- JSON 响应会尝试从邮件中提取 6 位验证码。

### 获取邮件列表

- `GET/POST /api/mail-all`
- 必填：`refresh_token`、`client_id`、`email`、`mailbox`
- 可选：`password`、`summary`（`true`/`1` 时只返回列表摘要，不下载正文）、`include_junk`（与 `INBOX` 一起使用，`true`/`1` 时在一次请求中同时读取收件箱和垃圾箱）
- 普通请求返回邮件数组；`include_junk=true` 时返回 `{ mailboxes, errors }`，每个文件夹最多返回最新 100 封邮件。

### 获取单封邮件正文

- `GET/POST /api/mail-detail`
- 必填：`refresh_token`、`client_id`、`email`、`mailbox`、`provider`、`id`
- `provider` 与 `id` 来自 `/api/mail-all?summary=true` 返回的同名字段。
- 可选：`password`
- 邮箱工作台使用此接口按需加载正文；普通 API 调用仍可不传 `summary`，保持原有完整列表响应。

### 刷新 Refresh Token

- `GET/POST /api/refresh-token`
- 必填：`refresh_token`、`client_id`
- 可选：`password`

### 清空邮箱

- `GET/POST /api/process-inbox`：清空收件箱
- `GET/POST /api/process-junk`：清空垃圾箱
- 必填：`refresh_token`、`client_id`、`email`
- 可选：`password`

### 发送邮件

- `GET/POST /api/send-mail`
- 必填：`refresh_token`、`client_id`、`email`、`to`、`subject`
- `text` 与 `html` 至少填写一个
- 可选：`send_password`

### AI 流式代理（可选）

- `POST /api/ai`
- 必填：`messages`
- 需要同时配置 `AI_API_KEY`、`AI_API_URL` 和 `AI_MODEL`
- 返回 OpenAI 兼容的 SSE 流；该接口独立存在，邮箱工作台不使用 AI 功能。

## 安全建议

- 不要把 Refresh Token、邮箱密码或环境变量提交到 GitHub。
- 正式使用时优先通过 HTTPS 和 POST 请求调用 API。
- 如果服务公开在互联网上，请按实际使用方式配置访问保护与 Vercel 防护规则。

## 项目地址

[a06342637/msOauth2api](https://github.com/a06342637/msOauth2api)
