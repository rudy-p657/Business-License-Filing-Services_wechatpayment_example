# 乐企通 Web 管理后台

静态网站部署文件位于 `dist` 目录。当前实现使用原生 HTML/CSS/JavaScript、CloudBase Web SDK 和 ECharts CDN，不需要 Node 构建步骤。

## 本地检查

在 `leqitong` 目录执行：

```text
node --check web-admin/dist/app.js
node --check cloudfunctions/leqitong/index.js
node web-admin/tests/smoke-test.mjs
```

最后一条会检查静态文件、云环境、匿名登录、弹窗事件、复制入口、订单支付状态界面和管理员功能入口。

## 上传

将 `dist` 目录内部的 `index.html`、`app.css`、`app.js` 上传到云开发静态网站根目录，并把索引文档设置为 `index.html`。不要把 `dist` 这一层目录再套一层上传，否则索引路径会变成 `dist/index.html`。

## 云端准备

部署 `cloudfunctions/leqitong`，并创建以下集合：

- `leqitong_admin_users`
- `leqitong_admin_sessions`
- `leqitong_admin_audits`
- `leqitong_admin_settings`
- `leqitong_admins`
- `leqitong_orders`
- `leqitong_customers`
- `leqitong_services`
- `leqitong_announcements`
- `leqitong_api_query_cache`

网页老板账号使用云函数环境变量 `LEQITONG_OWNER_PHONE` 指定的手机号；如需停用旧账号，可选配 `LEQITONG_LEGACY_OWNER_PHONE`。首次创建老板账号及新建或重置管理员账号时，使用 `LEQITONG_WEB_INITIAL_PASSWORD` 配置的初始密码。请使用独立的高强度密码，并在交付给管理员后及时修改。

网页不会直接访问数据库，所有数据请求都通过 `leqitong` 云函数。网页不使用公众号授权，但需要在 CloudBase 身份认证中开启“匿名登录”，让 Web SDK 通过 `signInAnonymously()` 获得调用云函数的凭证；登录成功后再使用云函数生成的管理员会话令牌。水滴信用配置放在当前环境的 `SHUIDI_PNAME` 和 `SHUIDI_PKEY` 中。新环境的数据和后台配置需要重新初始化；管理员身份需确认新小程序 AppID 下的 OpenID，并更新云函数中的 `LEQITONG_OWNER_OPENID` 或 `LEQITONG_ADMIN_OPENIDS`。

后台发起退款前必须输入退款确认密码。请在 CloudBase 云函数 `leqitong` 的环境变量中设置 `LEQITONG_REFUND_CONFIRM_PASSWORD`，并保存函数配置；密码仅由云函数校验，不要写入网页静态文件或代码仓库。网页端更新时，上传 `dist` 中的新 `app.js` 和 `app.css`。
