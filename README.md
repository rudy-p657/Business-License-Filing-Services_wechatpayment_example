# 营业执照代办小程序

这是已部署上线的企业服务微信小程序，提供企业信息查询、年报信息展示、服务下单、订单跟踪和公告浏览等功能。项目使用微信云开发承载业务云函数与数据访问，并接入微信支付虚拟支付能力。

## 功能

- 企业名称模糊查询和企业电话匹配，并展示企业年报信息。
- 企业服务目录、下单、订单列表和订单详情。
- 微信支付虚拟支付下单；服务端生成支付参数，并通过微信支付订单查询及退款接口同步支付状态。
- 订单支付状态校验与对账，处理支付、取消和退款状态。
- 公告列表与详情、服务分享，以及云环境诊断页面。
- 保留扫码支付入口相关的数据模型，用于未启用虚拟支付的服务配置。

## 技术栈

- **客户端**：微信小程序原生框架，JavaScript、WXML、WXSS。
- **云端**：CloudBase 云函数，Node.js、`wx-server-sdk` 和 CloudBase 文档数据库。
- **支付**：微信小程序虚拟支付接口，包括登录态换取、签名参数生成、订单查询、退款和状态通知处理。
- **质量保障**：Node.js 内置测试运行器覆盖支付状态同步、退款及小程序订单支付交互场景。

## 项目结构

```text
miniprogram/                 小程序页面、组件、资源和 API 封装
miniprogram/tests/            小程序侧支付与订单测试
cloudfunctions/leqitong/      乐企通业务云函数
cloudfunctions/leqitong/tests/ 云函数支付和退款测试
web-admin/                    管理端静态页面与冒烟测试
virtual-payment-assets/       微信虚拟支付商品素材
```

## 开发配置

1. 使用微信开发者工具导入项目根目录，并在微信公众平台和 CloudBase 控制台配置自己的小程序与云环境。
2. 在 `project.config.json` 中配置本地 AppID；个人开发设置保存在 `project.private.config.json`，该文件不会提交。
3. 在微信开发者工具中部署 `cloudfunctions/leqitong`，并按需配置虚拟支付所需的云函数环境变量和商品信息。管理后台还需配置 `LEQITONG_OWNER_PHONE` 与 `LEQITONG_WEB_INITIAL_PASSWORD`；旧老板账号迁移时可配置 `LEQITONG_LEGACY_OWNER_PHONE`。
4. 按 `web-admin/README.md` 中的集合清单配置云数据库。订单和客户资料应由云函数访问，不要开放普通用户直接读写权限。不要将商户密钥、API 证书、私钥或真实用户数据提交到仓库。

主要云函数环境变量：

- `LEQITONG_OWNER_PHONE`、`LEQITONG_WEB_INITIAL_PASSWORD`：Web 管理后台账号初始化。
- `LEQITONG_LEGACY_OWNER_PHONE`：可选，旧老板账号迁移。
- `LEQITONG_WECHAT_APP_ID`、`LEQITONG_WECHAT_APP_SECRET`：微信小程序身份信息。
- `LEQITONG_VPAY_ENABLED`、`LEQITONG_VPAY_ENV`、`LEQITONG_VPAY_OFFER_ID`、`LEQITONG_VPAY_APP_KEY`：虚拟支付配置；测试环境可使用 `LEQITONG_VPAY_SANDBOX_APP_KEY`。
- `SHUIDI_PNAME`、`SHUIDI_PKEY`：企业信息查询接口配置。

## 本地验证

在项目根目录运行：

```bash
node --test cloudfunctions/leqitong/tests/*.test.cjs
node --test miniprogram/tests/*.test.js
node --test web-admin/tests/*.mjs
```

微信支付实际交易还需要有效的微信平台配置、已审核的商品和对应运行环境；本地测试不能代替真实支付验收。

## 部署说明

项目已按实际业务场景部署。代码包含云函数和微信支付虚拟支付的接入实现；复用本仓库时仍需自行完成云环境、支付商户、商品审核和域名等平台配置。本仓库不包含生产凭据。
