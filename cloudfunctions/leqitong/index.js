const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const https = require("https");
const querystring = require("querystring");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
// OpenID is scoped to a Mini Program AppID, so administrator identities must
// come from the current environment or the current environment's collections.
const LEGACY_ADMIN_COLLECTION = "admins";
const LEGACY_ADMIN_USERS_COLLECTION = "admin_users";
const LEGACY_ADMIN_SETTINGS_COLLECTION = "admin_settings";
const LEGACY_ADMIN_COLLECTIONS = [LEGACY_ADMIN_COLLECTION, "xqw_admins"];
const LEGACY_ADMIN_USERS_COLLECTIONS = [LEGACY_ADMIN_USERS_COLLECTION, "xqw_admin_users"];
const LEGACY_ADMIN_SETTINGS_COLLECTIONS = [LEGACY_ADMIN_SETTINGS_COLLECTION, "xqw_admin_settings"];
const ADMIN_PASSWORD_KEY = "admin_password";
const ADMIN_SESSION_TTL = 365 * 24 * 60 * 60 * 1000;
const WEB_INITIAL_PASSWORD = String(process.env.LEQITONG_WEB_INITIAL_PASSWORD || "").trim();
const OWNER_PHONE = String(process.env.LEQITONG_OWNER_PHONE || "").trim();
const LEGACY_OWNER_PHONE = String(process.env.LEQITONG_LEGACY_OWNER_PHONE || "").trim();
const QUERY_CACHE_COLLECTION = "leqitong_api_query_cache";
const QUERY_CACHE_TTL = 24 * 60 * 60 * 1000;
const ANNUAL_DISPLAY_YEARS = 5;
const ANNUAL_ABNORMAL_MISSING_YEARS = 1;
const inflightQueries = new Map();

const DEFAULT_SERVICES = [
  { id: "annual_1", name: "一年期年报补录（不通过退费）", shortName: "一年期年报补录", price: 298, description: "适用于一年未按时报送年报的企业或个体工商户", paymentQr: "", enabled: true, sort: 1 },
  { id: "annual_2", name: "二年期年报补录（不通过退费）", shortName: "二年期年报补录", price: 398, description: "适用于二年未按时报送年报的企业或个体工商户", paymentQr: "", enabled: true, sort: 2 },
  { id: "annual_cancel", name: "年报补录 + 在线作废（不通过退费）", shortName: "年报补录+在线作废", price: 498, description: "适用于年报补录及异常、作废处理类业务", paymentQr: "", enabled: true, sort: 3 },
];
const LEGACY_PAYMENT_QR = "/images/payment-qr.svg";
const DEFAULT_ANNOUNCEMENTS = [
  { title: "未按时年报有何影响？", content: "企业、个体工商户未按规定期限报送年度报告，可能会被列入经营异常名录，并向社会公示。", publishedAt: "2026-04-10 16:12", visible: true },
  { title: "哪些企业需要年报？", content: "企业、个体工商户、农民专业合作社等市场主体，通常都需要按规定报送年度报告。具体要求以当地市场监督管理部门提示为准。", publishedAt: "2026-04-10 16:01", visible: true },
  { title: "什么是年报？为什么要按时申报？", content: "年报是市场监管部门组织开展的企业年度报告公示制度。建议在规定期限内及时完成申报。", publishedAt: "2026-04-10 15:56", visible: true },
];

function nowText() {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date()).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function context() {
  return cloud.getWXContext();
}

const LEQITONG_APP_ID = "wxea057c4e1a922c05";
let cachedWechatAccessToken = "";
let cachedWechatAccessTokenExpiresAt = 0;

function isVirtualPaymentEnabled() {
  return ["true", "1"].includes(String(process.env.LEQITONG_VPAY_ENABLED || "").trim().toLowerCase());
}

function getVirtualPaymentConfig(options = {}) {
  if (options.requireEnabled !== false && !isVirtualPaymentEnabled()) {
    throw new Error("虚拟支付尚未启用");
  }
  const configuredEnv = options.env == null ? Number(process.env.LEQITONG_VPAY_ENV || 0) : Number(options.env);
  if (![0, 1].includes(configuredEnv)) throw new Error("虚拟支付环境配置无效");
  const appKey = configuredEnv === 1
    ? String(process.env.LEQITONG_VPAY_SANDBOX_APP_KEY || "").trim()
    : String(process.env.LEQITONG_VPAY_APP_KEY || "").trim();
  const config = {
    appId: String(process.env.LEQITONG_WECHAT_APP_ID || LEQITONG_APP_ID).trim(),
    appSecret: String(process.env.LEQITONG_WECHAT_APP_SECRET || "").trim(),
    offerId: String(process.env.LEQITONG_VPAY_OFFER_ID || "").trim(),
    appKey,
    env: configuredEnv,
  };
  if (!config.appId || !config.appSecret || !config.offerId || !config.appKey) {
    throw new Error("虚拟支付服务端配置不完整，请检查 AppSecret、OfferID 和对应环境的 AppKey");
  }
  return config;
}

function requestWechatJson(url, method = "GET", body = "") {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(target, {
      method,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`微信接口 HTTP 状态异常：${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody));
        } catch (error) {
          reject(new Error("微信接口返回格式无效"));
        }
      });
    });
    request.setTimeout(12000, () => request.destroy(new Error("微信接口请求超时")));
    request.on("error", (error) => reject(new Error(error.message || "微信接口请求失败")));
    if (body) request.write(body);
    request.end();
  });
}

async function exchangeWechatLoginCode(code, config) {
  const loginCode = String(code || "").trim();
  if (!loginCode) throw new Error("无法获取微信登录凭证，请返回后重试");
  const url = `https://api.weixin.qq.com/sns/jscode2session?${querystring.stringify({
    appid: config.appId,
    secret: config.appSecret,
    js_code: loginCode,
    grant_type: "authorization_code",
  })}`;
  const result = await requestWechatJson(url);
  if (result.errcode || !result.openid || !result.session_key) {
    throw new Error(`获取微信支付会话失败${result.errcode ? `（${result.errcode}）` : ""}`);
  }
  if (result.openid !== context().OPENID) throw new Error("微信登录身份与当前小程序用户不一致");
  return result;
}

function hmacSha256(key, message) {
  return crypto.createHmac("sha256", key).update(message, "utf8").digest("hex");
}

function makeVirtualPayData(order, sessionKey, config) {
  const signData = JSON.stringify({
    offerId: order.virtualOfferId,
    buyQuantity: 1,
    env: Number(order.virtualEnv),
    currencyType: "CNY",
    productId: order.virtualProductId,
    goodsPrice: Number(order.amountFen),
    outTradeNo: order.outTradeNo,
    attach: order.orderNo,
  });
  return {
    signData,
    paySig: hmacSha256(config.appKey, `requestVirtualPayment&${signData}`),
    signature: hmacSha256(sessionKey, signData),
    mode: "short_series_goods",
  };
}

async function getWechatAccessToken(config) {
  if (cachedWechatAccessToken && cachedWechatAccessTokenExpiresAt > Date.now() + 60000) {
    return cachedWechatAccessToken;
  }
  const url = "https://api.weixin.qq.com/cgi-bin/stable_token";
  const body = JSON.stringify({
    grant_type: "client_credential",
    appid: config.appId,
    secret: config.appSecret,
    force_refresh: false,
  });
  const result = await requestWechatJson(url, "POST", body);
  if (result.errcode || !result.access_token) {
    const message = String(result.errmsg || result.errMsg || "").slice(0, 300);
    throw new Error(`获取微信稳定接口凭证失败${result.errcode ? `（${result.errcode}${message ? `：${message}` : ""}）` : ""}`);
  }
  cachedWechatAccessToken = result.access_token;
  cachedWechatAccessTokenExpiresAt = Date.now() + Math.max(60, Number(result.expires_in || 7200) - 300) * 1000;
  return cachedWechatAccessToken;
}

async function queryWechatVirtualOrder(order, config) {
  const accessToken = await getWechatAccessToken(config);
  const body = JSON.stringify({
    openid: order.openid,
    env: Number(order.virtualEnv),
    order_id: order.outTradeNo,
  });
  const paySig = hmacSha256(config.appKey, `/xpay/query_order&${body}`);
  const url = `https://api.weixin.qq.com/xpay/query_order?${querystring.stringify({ access_token: accessToken, pay_sig: paySig })}`;
  const result = await requestWechatJson(url, "POST", body);
  if (result.errcode) {
    const message = String(result.errmsg || result.errMsg || "").slice(0, 300);
    const error = new Error(`微信支付查单失败（${result.errcode}${message ? `：${message}` : ""}）`);
    error.wechatErrCode = Number(result.errcode);
    throw error;
  }
  const platformOrder = result.order || result;
  if (!platformOrder || platformOrder.order_id !== order.outTradeNo) {
    throw new Error("微信查单返回的订单号不匹配");
  }
  if (platformOrder.openid && platformOrder.openid !== order.openid) throw new Error("微信查单返回的用户不匹配");
  return platformOrder;
}

async function verifyVirtualOrderCanBeCancelled(order, source) {
  let platformOrder;
  try {
    platformOrder = await queryWechatVirtualOrder(order, getVirtualPaymentConfig({ requireEnabled: false, env: order.virtualEnv }));
  } catch (error) {
    if (Number(error && error.wechatErrCode) === 268490002) return order;
    throw error;
  }

  const platformStatus = Number(platformOrder.status);
  const latest = await persistVirtualOrderState(order, platformOrder, source);
  if (platformStatus !== 6 || latest.paymentStatus !== "cancelled") {
    throw new Error("微信侧支付订单尚未关闭，暂不能取消；请先退出收银台，等待微信确认失败后重试");
  }
  return latest;
}

async function requestWechatVirtualRefund(order, attempt, config) {
  const accessToken = await getWechatAccessToken(config);
  const body = JSON.stringify({
    openid: order.openid,
    order_id: order.outTradeNo,
    refund_order_id: attempt.refundOrderId,
    left_fee: Number(attempt.leftFeeFen),
    refund_fee: Number(attempt.refundAmountFen),
    biz_meta: attempt.bizMeta,
    refund_reason: String(attempt.refundReason),
    req_from: "3",
    env: Number(order.virtualEnv),
  });
  const paySig = hmacSha256(config.appKey, `/xpay/refund_order&${body}`);
  const url = `https://api.weixin.qq.com/xpay/refund_order?${querystring.stringify({ access_token: accessToken, pay_sig: paySig })}`;
  return requestWechatJson(url, "POST", body);
}

function paidTimeText(timestamp) {
  const seconds = Number(timestamp || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return nowText();
  const date = new Date(seconds * 1000);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).reduce((result, part) => { result[part.type] = part.value; return result; }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function adminOpenids() {
  const configured = String(process.env.LEQITONG_ADMIN_OPENIDS || "").split(",").map((item) => item.trim()).filter(Boolean);
  const owner = String(process.env.LEQITONG_OWNER_OPENID || "").trim();
  return [...new Set([owner, ...configured].filter(Boolean))];
}

function initialAdminPassword() {
  return String(process.env.ADMIN_INITIAL_PASSWORD || "").trim();
}

async function legacyAdminRecord(openid) {
  for (const collectionName of LEGACY_ADMIN_COLLECTIONS) {
    try {
      const result = await db.collection(collectionName).where({ openid, enabled: true }).limit(1).get();
      if (result.data[0]) return result.data[0];
    } catch (error) {
      // A legacy collection may not exist in a newly created environment.
    }
  }
  return null;
}

async function migrateLegacyAdminRecords() {
  const configured = adminOpenids();
  for (const openid of configured) {
    const exists = await db.collection("leqitong_admins").where({ openid }).limit(1).get();
    if (!exists.data.length) {
      await db.collection("leqitong_admins").add({ data: { openid, role: "admin", enabled: true, source: "legacy_allowlist", createdAt: nowText(), updatedAt: nowText() } });
    }
  }
  for (const collectionName of LEGACY_ADMIN_COLLECTIONS) {
    try {
      const legacy = await db.collection(collectionName).where({ enabled: true }).get();
      for (const item of legacy.data || []) {
        const exists = await db.collection("leqitong_admins").where({ openid: item.openid }).limit(1).get();
        if (!exists.data.length) {
          const { _id, ...legacyData } = item;
          await db.collection("leqitong_admins").add({ data: { ...legacyData, source: "legacy_collection", migratedAt: nowText() } });
        }
      }
    } catch (error) {
      console.warn(`Legacy admin collection ${collectionName} migration skipped`, error.message || error);
    }
  }
}

let legacyManagementMigration;

async function migrateLegacyManagementData() {
  if (!legacyManagementMigration) {
    legacyManagementMigration = (async () => {
      await migrateLegacyAdminRecords();
      for (const collectionName of LEGACY_ADMIN_USERS_COLLECTIONS) {
        try {
          const legacyUsers = await db.collection(collectionName).get();
          for (const item of legacyUsers.data || []) {
            if (!item.phone) continue;
            const exists = await db.collection("leqitong_admin_users").where({ phone: item.phone }).limit(1).get();
            if (!exists.data.length) {
              const { _id, ...legacyData } = item;
              await db.collection("leqitong_admin_users").add({ data: { ...legacyData, source: "legacy_collection", migratedAt: nowText() } });
            }
          }
        } catch (error) {
          console.warn(`Legacy admin users collection ${collectionName} migration skipped`, error.message || error);
        }
      }
      const currentSettings = await db.collection("leqitong_admin_settings").where({ key: ADMIN_PASSWORD_KEY }).limit(1).get();
      if (!currentSettings.data.length) {
        for (const collectionName of LEGACY_ADMIN_SETTINGS_COLLECTIONS) {
          try {
            const legacySettings = await db.collection(collectionName).where({ key: ADMIN_PASSWORD_KEY }).limit(1).get();
            if (legacySettings.data.length) {
              const { _id, ...legacyData } = legacySettings.data[0];
              await db.collection("leqitong_admin_settings").add({ data: { ...legacyData, source: "legacy_collection", migratedAt: nowText() } });
              break;
            }
          } catch (error) {
            console.warn(`Legacy admin settings collection ${collectionName} migration skipped`, error.message || error);
          }
        }
      }
    })().catch((error) => {
      legacyManagementMigration = null;
      throw error;
    });
  }
  return legacyManagementMigration;
}

function isBuiltinAdmin() {
  return adminOpenids().includes(context().OPENID);
}

async function getSecureAdminSession(event) {
  if (!event || !event.adminToken) return null;
  const result = await db.collection("leqitong_admin_sessions").where({
    token: String(event.adminToken),
    openid: context().OPENID,
    enabled: true,
  }).limit(1).get();
  const session = result.data[0];
  if (!session || Number(session.expiresAt || 0) <= Date.now()) return null;
  if (session.accountId) {
    const account = await getAdminUserById(session.accountId);
    if (!account || account.enabled === false) return null;
    return { ...session, role: account.role, account };
  }
  if (session.role === "builtin" && !isBuiltinAdmin()) return null;
  const passwordConfig = await getAdminPasswordConfig();
  if (!passwordConfig) return isBuiltinAdmin() && Number(session.passwordVersion || 0) === 0 ? session : null;
  if (Number(session.passwordVersion || 0) !== Number(passwordConfig.version || 0)) return null;
  if (!session.accountId) return session;
  return session;
}

async function requireSecureAdmin(event) {
  if (!(await getSecureAdminSession(event))) throw new Error("请先登录管理员后台");
}

async function accountAdminLoginV2(event) {
  await migrateLegacyManagementData();
  const phone = String(event.phone || "").trim();
  const name = String(event.name || "").trim();
  const password = String(event.password || "");
  const isPhone = phone.length === 11 && phone[0] === "1" && phone.split("").every((char) => char >= "0" && char <= "9");
  if (!isPhone) throw new Error("请输入正确的手机号作为账号");
  if (!name) throw new Error("请输入姓名");
  const config = await getAdminPasswordConfig();
  const valid = config
    ? passwordMatches(password, config)
    : isBuiltinAdmin() && initialAdminPassword() && password === initialAdminPassword();
  if (!valid) throw new Error("密码错误");
  const role = isBuiltinAdmin() ? "builtin" : "shared";
  const token = crypto.randomBytes(32).toString("hex");
  await db.collection("leqitong_admin_sessions").add({ data: { token, openid: context().OPENID, accountId: "", phone, name, role, passwordVersion: Number(config ? config.version || 0 : 0), enabled: true, expiresAt: Date.now() + ADMIN_SESSION_TTL, createdAt: nowText() } });
  return { isAdmin: true, token, expiresAt: Date.now() + ADMIN_SESSION_TTL, phone, name, role };
}

function publicAdminUser(item) {
  if (!item) return null;
  const { passwordHash, passwordSalt, ...safe } = item;
  return { ...safe, id: item._id };
}

async function getAdminUserById(id) {
  if (!id) return null;
  try {
    const result = await db.collection("leqitong_admin_users").doc(String(id)).get();
    return result.data || null;
  } catch (error) {
    return null;
  }
}

async function getAdminUserByPhone(phone) {
  const result = await db.collection("leqitong_admin_users").where({ phone }).limit(1).get();
  return result.data[0] || null;
}

async function ensureOwnerAccount() {
  if (!/^1\d{10}$/.test(OWNER_PHONE)) throw new Error("请先配置老板手机号 LEQITONG_OWNER_PHONE");
  const existing = await getAdminUserByPhone(OWNER_PHONE);
  const legacyOwner = LEGACY_OWNER_PHONE ? await getAdminUserByPhone(LEGACY_OWNER_PHONE) : null;
  if (legacyOwner && (!existing || legacyOwner._id !== existing._id) && legacyOwner.enabled !== false) {
    await db.collection("leqitong_admin_users").doc(legacyOwner._id).update({ data: { enabled: false, role: "admin", updatedAt: nowText() } });
    await db.collection("leqitong_admin_sessions").where({ accountId: legacyOwner._id, enabled: true }).update({ data: { enabled: false } });
  }
  if (existing) {
    const patch = { role: "owner", enabled: true, updatedAt: nowText() };
    let account = { ...existing, role: "owner", enabled: true };
    if (!existing.passwordHash || !existing.passwordSalt || existing.webPasswordInitialized !== true) {
      if (!WEB_INITIAL_PASSWORD) throw new Error("请先配置后台初始密码 LEQITONG_WEB_INITIAL_PASSWORD");
      const salt = crypto.randomBytes(16).toString("hex");
      patch.passwordHash = passwordHash(WEB_INITIAL_PASSWORD, salt);
      patch.passwordSalt = salt;
      patch.webPasswordInitialized = true;
      account = { ...account, passwordHash: patch.passwordHash, passwordSalt: salt, webPasswordInitialized: true };
    }
    await db.collection("leqitong_admin_users").doc(existing._id).update({ data: patch });
    return account;
  }
  if (!WEB_INITIAL_PASSWORD) throw new Error("请先配置后台初始密码 LEQITONG_WEB_INITIAL_PASSWORD");
  const salt = crypto.randomBytes(16).toString("hex");
  const result = await db.collection("leqitong_admin_users").add({ data: {
    phone: OWNER_PHONE,
    name: "老板",
    role: "owner",
    passwordHash: passwordHash(WEB_INITIAL_PASSWORD, salt),
    passwordSalt: salt,
    enabled: true,
    webPasswordInitialized: true,
    createdAt: nowText(),
    updatedAt: nowText(),
  } });
  return { _id: result._id, phone: OWNER_PHONE, name: "老板", role: "owner", enabled: true };
}

async function webAdminLogin(event) {
  await migrateLegacyManagementData();
  const phone = String(event.phone || "").trim();
  const password = String(event.password || "");
  if (!/^1\d{10}$/.test(phone)) throw new Error("请输入正确的手机号");
  if (!password) throw new Error("请输入登录密码");
  let account = phone === OWNER_PHONE ? await ensureOwnerAccount() : await getAdminUserByPhone(phone);
  if (!account) throw new Error("该手机号尚未被老板添加");
  if (account.enabled === false) throw new Error("该管理员账号已停用");
  if (!passwordMatches(password, account)) throw new Error("密码错误");
  const token = crypto.randomBytes(32).toString("hex");
  const loggedAt = nowText();
  await db.collection("leqitong_admin_sessions").add({ data: {
    token,
    accountId: account._id,
    openid: context().OPENID,
    phone: account.phone,
    name: account.name,
    role: account.role,
    source: "web",
    enabled: true,
    expiresAt: Date.now() + ADMIN_SESSION_TTL,
    createdAt: loggedAt,
    lastUsedAt: loggedAt,
  } });
  await db.collection("leqitong_admin_users").doc(account._id).update({ data: { lastLoginAt: loggedAt, lastLoginOpenid: context().OPENID, updatedAt: loggedAt } });
  return { token, expiresAt: Date.now() + ADMIN_SESSION_TTL, user: publicAdminUser({ ...account, lastLoginAt: loggedAt, lastLoginOpenid: context().OPENID }) };
}

async function getWebSession(event) {
  const session = await getSecureAdminSession(event);
  return session && session.accountId ? session : null;
}

async function requireWebAdmin(event) {
  const session = await getWebSession(event);
  if (!session) throw new Error("请先登录管理后台");
  return session;
}

async function requireWebOwner(event) {
  const session = await requireWebAdmin(event);
  if (session.role !== "owner") throw new Error("只有老板可以管理管理员账号");
  return session;
}

async function webAdminStatus(event) {
  await migrateLegacyManagementData();
  const session = await getWebSession(event);
  return { authenticated: Boolean(session), isOwner: Boolean(session && session.role === "owner"), user: session && publicAdminUser(session.account) };
}

async function adminListUsers(event) {
  await requireWebOwner(event);
  const result = await db.collection("leqitong_admin_users").orderBy("createdAt", "desc").get();
  return { list: result.data.map(publicAdminUser) };
}

async function adminCreateUser(event) {
  const operator = await requireWebOwner(event);
  if (!WEB_INITIAL_PASSWORD) throw new Error("请先配置后台初始密码 LEQITONG_WEB_INITIAL_PASSWORD");
  const phone = String(event.phone || "").trim();
  const name = String(event.name || "").trim();
  if (!/^1\d{10}$/.test(phone)) throw new Error("请输入正确的手机号");
  if (!name) throw new Error("请输入管理员姓名");
  if (await getAdminUserByPhone(phone)) throw new Error("该手机号已存在");
  const salt = crypto.randomBytes(16).toString("hex");
  const createdAt = nowText();
  const result = await db.collection("leqitong_admin_users").add({ data: { phone, name, role: "admin", passwordHash: passwordHash(WEB_INITIAL_PASSWORD, salt), passwordSalt: salt, enabled: true, createdAt, updatedAt: createdAt } });
  return { user: publicAdminUser({ _id: result._id, phone, name, role: "admin", enabled: true, createdAt, updatedAt: createdAt }), operator: publicAdminUser(operator.account), initialPassword: WEB_INITIAL_PASSWORD };
}

async function adminUpdateUser(event) {
  await requireWebOwner(event);
  const id = String(event.id || "");
  const user = await getAdminUserById(id);
  if (!user || user.role === "owner") throw new Error("老板账号不能通过此处修改");
  const phone = String(event.phone || user.phone).trim();
  const name = String(event.name || user.name).trim();
  if (!/^1\d{10}$/.test(phone) || !name) throw new Error("手机号或姓名无效");
  const duplicate = await getAdminUserByPhone(phone);
  if (duplicate && duplicate._id !== id) throw new Error("该手机号已存在");
  await db.collection("leqitong_admin_users").doc(id).update({ data: { phone, name, enabled: event.enabled !== false, updatedAt: nowText() } });
  return { user: publicAdminUser({ ...user, phone, name, enabled: event.enabled !== false }) };
}

async function adminDeleteUser(event) {
  await requireWebOwner(event);
  const user = await getAdminUserById(String(event.id || ""));
  if (!user || user.role === "owner") throw new Error("老板账号不能删除");
  await db.collection("leqitong_admin_users").doc(user._id).remove();
  await db.collection("leqitong_admin_sessions").where({ accountId: user._id }).update({ data: { enabled: false } });
  return { ok: true };
}

async function adminResetUserPassword(event) {
  await requireWebOwner(event);
  if (!WEB_INITIAL_PASSWORD) throw new Error("请先配置后台初始密码 LEQITONG_WEB_INITIAL_PASSWORD");
  const user = await getAdminUserById(String(event.id || ""));
  if (!user || user.role === "owner") throw new Error("老板账号不能重置");
  const salt = crypto.randomBytes(16).toString("hex");
  await db.collection("leqitong_admin_users").doc(user._id).update({ data: { passwordHash: passwordHash(WEB_INITIAL_PASSWORD, salt), passwordSalt: salt, updatedAt: nowText() } });
  await db.collection("leqitong_admin_sessions").where({ accountId: user._id }).update({ data: { enabled: false } });
  return { ok: true, initialPassword: WEB_INITIAL_PASSWORD };
}

async function accountAdminStatus(event) {
  const session = await getSecureAdminSession(event);
  return {
    isAdmin: isBuiltinAdmin() || Boolean(session),
    authenticated: Boolean(session),
    isOwner: isOwner(),
    accountPhone: session && session.phone || "",
    accountRole: session && session.role || "",
    accountName: session && session.name || "",
    passwordInitialized: Boolean(await getAdminPasswordConfig()),
  };
}

function isOwner() {
  const configuredOwner = String(process.env.LEQITONG_OWNER_OPENID || "").trim();
  return Boolean(configuredOwner) && configuredOwner === context().OPENID;
}

function passwordHash(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
}

function passwordMatches(password, record) {
  if (!record || !record.passwordHash || !record.passwordSalt) return false;
  const actual = Buffer.from(passwordHash(password, record.passwordSalt), "hex");
  const expected = Buffer.from(record.passwordHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function getAdminPasswordConfig() {
  const result = await db.collection("leqitong_admin_settings").where({ key: ADMIN_PASSWORD_KEY }).limit(1).get();
  return result.data[0] || null;
}

async function hasAdminSession(event) {
  return Boolean(await getSecureAdminSession(event));
  if (!event || !event.adminToken || !(await isAdmin())) return false;
  const result = await db.collection("leqitong_admin_sessions").where({
    token: String(event.adminToken),
    openid: context().OPENID,
    enabled: true,
  }).limit(1).get();
  const session = result.data[0];
  if (!session || Number(session.expiresAt || 0) <= Date.now()) return false;
  const config = await getAdminPasswordConfig();
  return Number(session.passwordVersion || 0) === Number(config ? config.version || 0 : 0);
}

function validateAdminPassword(password) {
  const value = String(password || "");
  if (value.length < 6 || value.length > 64) throw new Error("管理员密码需为6-64位");
  return value;
}

async function adminLogin(event) {
  await migrateLegacyManagementData();
  if (!(await isAdmin())) throw new Error("当前微信没有管理员权限");
  const password = String(event.password || "");
  const config = await getAdminPasswordConfig();
  const valid = config ? passwordMatches(password, config) : Boolean(initialAdminPassword()) && password === initialAdminPassword();
  if (!valid) throw new Error("管理员密码错误");
  const token = crypto.randomBytes(32).toString("hex");
  await db.collection("leqitong_admin_sessions").add({ data: {
    token,
    openid: context().OPENID,
    passwordVersion: Number(config ? config.version || 0 : 0),
    enabled: true,
    expiresAt: Date.now() + ADMIN_SESSION_TTL,
    createdAt: nowText(),
  } });
  return { isAdmin: true, token, expiresAt: Date.now() + ADMIN_SESSION_TTL, isOwner: isOwner(), passwordInitialized: Boolean(config) };
}

async function initializeAdminPassword(event) {
  if (!isOwner()) throw new Error("只有老板可以初始化管理员密码");
  if (!(await hasAdminSession(event))) throw new Error("请先登录管理员后台");
  if (await getAdminPasswordConfig()) throw new Error("管理员密码已经初始化，请使用修改密码");
  const password = validateAdminPassword(event.password);
  const salt = crypto.randomBytes(16).toString("hex");
  await db.collection("leqitong_admin_settings").add({ data: {
    key: ADMIN_PASSWORD_KEY,
    passwordHash: passwordHash(password, salt),
    passwordSalt: salt,
    version: 1,
    updatedBy: context().OPENID,
    createdAt: nowText(),
    updatedAt: nowText(),
  } });
  const session = await adminLogin({ password });
  return { ok: true, passwordInitialized: true, token: session.token, expiresAt: session.expiresAt };
}

async function changeAdminPassword(event) {
  if (!isOwner()) throw new Error("只有老板可以修改管理员登录密码");
  await requireAdminSession(event);
  const config = await getAdminPasswordConfig();
  if (!config) return initializeAdminPassword(event);
  const password = validateAdminPassword(event.password);
  const salt = crypto.randomBytes(16).toString("hex");
  await db.collection("leqitong_admin_settings").doc(config._id).update({ data: {
    passwordHash: passwordHash(password, salt),
    passwordSalt: salt,
    version: Number(config.version || 0) + 1,
    updatedBy: context().OPENID,
    updatedAt: nowText(),
  } });
  const session = await adminLogin({ password });
  return { ok: true, passwordInitialized: true, token: session.token, expiresAt: session.expiresAt };
}

async function adminStatus(event) {
  await migrateLegacyManagementData();
  const allowed = await isAdmin();
  return {
    isAdmin: allowed,
    authenticated: allowed && await hasAdminSession(event),
    isOwner: isOwner(),
    passwordInitialized: Boolean(await getAdminPasswordConfig()),
  };
}

async function isAdmin() {
  const list = adminOpenids();
  if (list.includes(context().OPENID)) return true;
  const result = await db.collection("leqitong_admins").where({ openid: context().OPENID, enabled: true }).limit(1).get();
  if (result.data.length > 0) return true;
  return Boolean(await legacyAdminRecord(context().OPENID));
}

async function requireAdmin(event) {
  if (!(await isAdmin())) throw new Error("无管理员权限");
}

async function requireAdminSession(event) {
  const session = await getSecureAdminSession(event);
  if (!session) throw new Error("请先登录管理员后台");
  return session;
}

function shuidiConfig() {
  const pname = process.env.SHUIDI_PNAME || "";
  const pkey = process.env.SHUIDI_PKEY || "";
  return pname && pkey ? { pname, pkey } : null;
}

function requestShuidi(path, params) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(params);
    const req = https.request({
      hostname: "api.shuidi.cn",
      path,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      timeout: 8000,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch (error) { reject(new Error("水滴接口返回格式异常")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("水滴接口请求超时")));
    req.write(body);
    req.end();
  });
}

function signedParams(config, params) {
  const ptime = String(Date.now());
  const vkey = crypto.createHash("md5").update(`${config.pkey}_${ptime}_${config.pkey}`).digest("hex");
  return { ...params, pname: config.pname, ptime, vkey };
}

function normalizePhone(value) {
  return String(value || "").trim().replace(/[\s-]/g, "");
}

function detectQueryType(keyword) {
  return /^1[3-9]\d{9}$/.test(normalizePhone(keyword)) ? "phone" : "fuzzy";
}

function queryCacheKey(queryType, keyword) {
  return crypto.createHash("md5").update(`${queryType}:${String(keyword || "").trim().toLowerCase()}`).digest("hex");
}

async function readQueryCache(queryType, keyword) {
  try {
    const key = queryCacheKey(queryType, keyword);
    const result = await db.collection(QUERY_CACHE_COLLECTION).where({ cacheKey: key }).limit(1).get();
    const item = result.data[0];
    if (item && Number(item.expiresAt || 0) > Date.now() && item.payload) return item;
  } catch (error) {
    console.error("Query cache read failed. Please create leqitong_api_query_cache collection.", error);
  }
  return null;
}

async function writeQueryCache(queryType, keyword, payload, ttl = QUERY_CACHE_TTL) {
  try {
    const key = queryCacheKey(queryType, keyword);
    const collection = db.collection(QUERY_CACHE_COLLECTION);
    const existing = await collection.where({ cacheKey: key }).limit(1).get();
    const data = {
      cacheKey: key,
      queryType,
      keywordHash: key,
      payload,
      createdAt: nowText(),
      expiresAt: Date.now() + ttl,
    };
    if (existing.data.length) {
      await collection.doc(existing.data[0]._id).update({ data });
    } else {
      await collection.add({ data });
    }
    return data.expiresAt;
  } catch (error) {
    console.error("Query cache write failed. Please create leqitong_api_query_cache collection.", error);
    return 0;
  }
}

async function cachedQuery(queryType, keyword, loader, ttl = QUERY_CACHE_TTL) {
  const key = queryCacheKey(queryType, keyword);
  const cached = await readQueryCache(queryType, keyword);
  if (cached) return { ...cached.payload, cache: { hit: true, expiresAt: cached.expiresAt } };
  if (inflightQueries.has(key)) return inflightQueries.get(key);
  const request = Promise.resolve().then(loader).then(async (payload) => {
    const expiresAt = await writeQueryCache(queryType, keyword, payload, ttl);
    return { ...payload, cache: { hit: false, expiresAt } };
  }).finally(() => inflightQueries.delete(key));
  inflightQueries.set(key, request);
  return request;
}

function isCancelledCompany(status) {
  return String(status || "").includes("注销");
}

function fuzzyBusinessStatus(item) {
  return item.regStatusNew || item.regStatus || "";
}

function mapCompany(item, businessStatus) {
  return {
    id: item.id || item.creditCode || "",
    name: item.companyName || item.name || "",
    licenseName: item.licenseName || item.companyName || item.name || "",
    legalPerson: item.legalPersonName || "",
    establishDate: item.estiblishTime || "",
    creditCode: item.creditCode || "",
    businessStatus: businessStatus || item.regStatus || item.regStatusNew || item.Status || "",
    registrationNumber: item.regNumber || "",
    organizationCode: item.orgNumber || "",
    regCapital: item.regCapital || "",
    companyType: item.companyType || "",
    matchReason: item.matchType || null,
    source: "shuidi",
  };
}

function removeCancelledCompanies(result) {
  const list = (result.list || []).filter((item) => !isCancelledCompany(item.businessStatus));
  return { ...result, list, total: list.length };
}

async function searchCompany(event) {
  const rawKeyword = String(event.keyword || "").trim();
  const queryType = detectQueryType(rawKeyword);
  const keyword = queryType === "phone" ? normalizePhone(rawKeyword) : rawKeyword;
  if (!keyword) return { list: [] };
  const config = shuidiConfig();
  if (config) {
    const result = await cachedQuery(queryType, keyword, async () => {
    if (queryType === "phone") {
      const response = await requestShuidi("/utn/ic/CompanyPhone", signedParams(config, {
        PhoneNo: keyword,
        pageSize: Math.min(Number(event.pageSize) || 20, 20),
        pageIndex: Number(event.pageIndex) || 1,
        dtype: "json",
      }));
      if (response.statusCode !== 1) return { list: [], total: 0, queryType, source: "shuidi", statusCode: response.statusCode, message: response.statusMessage };
      const data = response.data || {};
      const list = (data.Items || [])
        .filter((item) => !isCancelledCompany(item.Status))
        .map((item) => mapCompany({
          id: item.KeyNo,
          companyName: item.Name,
          legalPersonName: item.OperName,
          regNumber: item.No,
          creditCode: item.CreditCode,
          estiblishTime: item.StartDate,
        }, item.Status));
      return { list, total: list.length, queryType, source: "shuidi" };
    }
    const response = await requestShuidi("/utn/company/Search/V1", signedParams(config, {
      word: keyword,
      pageSize: Math.min(Number(event.pageSize) || 25, 25),
      pageNum: Number(event.pageNum) || 1,
      scope: event.scope || "",
    }));
    if (response.statusCode !== 1) return { list: [], total: 0, queryType, source: "shuidi", statusCode: response.statusCode, message: response.statusMessage };
    const data = response.data || {};
    const list = (data.items || [])
      .filter((item) => !isCancelledCompany(fuzzyBusinessStatus(item)))
      .map((item) => mapCompany(item, fuzzyBusinessStatus(item)));
    return { list, total: list.length, queryType, source: "shuidi" };
  });
    // Filter once more after a cache hit so previously cached results are safe too.
    return removeCancelledCompanies(result);
  }
  return { list: [], total: 0, queryType, source: "mock", message: "未配置水滴信用环境变量" };
}

async function getAnnualReports(event) {
  const config = shuidiConfig();
  const keyword = String(event.keyword || "").trim();
  const annualCacheKey = `${keyword}|${String(event.establishDate || "").trim()}`;
  if (config && keyword) return cachedQuery("annual", annualCacheKey, async () => {
    const response = await requestShuidi("/utn/at/ic/ArList/V3", signedParams(config, { keyword: String(event.keyword || "").trim() }));
    if (response.statusCode !== 1) return { reports: [], missingYears: [], total: 0, businessStatus: "数据暂不可用", source: "shuidi", statusCode: response.statusCode, message: response.statusMessage };
    const result = (response.data && response.data.result) || {};
    const submitted = new Map((result.items || []).map((item) => [String(item.year || ""), {
      year: String(item.year || ""), submitted: true, label: "已年报", hasDetailInfo: item.hasDetailInfo === true || item.hasDetailInfo === "true", publishDate: item.publishDate || "",
    }]));
    const currentYear = new Date().getFullYear();
    const endYear = currentYear - 1;
    const establishYear = Number(String(event.establishDate || "").match(/\d{4}/)?.[0] || 0);
    // Keep all expected years for the detail modal. Only the page preview is limited to five.
    const startYear = establishYear && establishYear <= endYear ? establishYear : endYear - ANNUAL_DISPLAY_YEARS + 1;
    const allReports = [];
    for (let year = endYear; year >= startYear; year -= 1) allReports.push(submitted.get(String(year)) || { year: String(year), submitted: false, label: "未年报", publishDate: "" });
    const missingYears = allReports.filter((item) => !item.submitted).map((item) => item.year);
    const abnormal = missingYears.length >= ANNUAL_ABNORMAL_MISSING_YEARS;
    return {
      businessStatus: abnormal ? "经营异常" : "正常",
      abnormal,
      abnormalReason: abnormal ? `未按规定期限公示企业年度报告，缺失年份：${missingYears.join("、")}` : "已到期应报年份均有年报记录",
      missingYears,
      reports: allReports.slice(0, ANNUAL_DISPLAY_YEARS),
      allReports,
      hasMoreReports: allReports.length > ANNUAL_DISPLAY_YEARS,
      total: allReports.length,
      source: "shuidi",
      queriedAt: nowText(),
      apiTotal: Number(result.total || 0),
    };
  });
  return { businessStatus: "数据暂不可用", abnormal: false, missingYears: [], reports: [], total: 0, source: "mock", message: "未配置水滴信用环境变量" };
}

async function getServices() {
  const result = await db.collection("leqitong_services").orderBy("sort", "asc").get();
  if (result.data.length) {
    // The original SVG was a visual placeholder, not a real collection code.
    // Clear old values so the admin console cannot report a false "configured" state.
    const legacyItems = result.data.filter((item) => item.paymentQr === LEGACY_PAYMENT_QR);
    if (legacyItems.length) {
      await Promise.all(legacyItems.map((item) => db.collection("leqitong_services").doc(item._id).update({ data: { paymentQr: "", updatedAt: nowText() } })));
    }
    return {
      list: result.data.map((item) => ({ ...item, paymentQr: item.paymentQr === LEGACY_PAYMENT_QR ? "" : item.paymentQr, id: item.id || item._id })),
      source: "cloud",
    };
  }
  for (const service of DEFAULT_SERVICES) await db.collection("leqitong_services").add({ data: { ...service, createdAt: nowText(), updatedAt: nowText() } });
  return { list: DEFAULT_SERVICES, source: "cloud" };
}

function amountToFen(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value == null ? "" : value).trim());
  if (!match) return null;
  const amountFen = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(amountFen) ? amountFen : null;
}

async function saveServices(event) {
  await requireAdminSession(event);
  const services = Array.isArray(event.services) ? event.services : [];
  const updates = [];
  for (const service of services) {
    const { _id, ...serviceFields } = service;
    const priceFen = amountToFen(service.price);
    if (priceFen === null) throw new Error("服务价格最多保留两位小数");
    const virtualPriceFen = service.virtualPriceFen == null || service.virtualPriceFen === ""
      ? null
      : Number(service.virtualPriceFen);
    if (virtualPriceFen !== null && (!Number.isSafeInteger(virtualPriceFen) || virtualPriceFen < 0)) {
      throw new Error("微信虚拟商品价格必须是以分为单位的非负整数");
    }
    const data = {
      ...serviceFields,
      virtualProductId: String(service.virtualProductId || "").trim(),
      virtualPriceFen,
      price: priceFen / 100,
      priceFen,
      updatedAt: nowText(),
    };
    const old = await db.collection("leqitong_services").where({ id: service.id }).limit(1).get();
    let previous = old.data[0] || null;
    if (previous) {
      const paymentConfigChanged = Number(previous.priceFen != null ? previous.priceFen : Math.round(Number(previous.price || 0) * 100)) !== priceFen
        || String(previous.virtualProductId || "") !== data.virtualProductId
        || (previous.virtualPriceFen == null ? null : Number(previous.virtualPriceFen)) !== virtualPriceFen;
      if (paymentConfigChanged) {
        const pending = await db.collection("leqitong_orders").where({
          serviceId: service.id,
          payMode: "virtual",
          paymentStatus: "unpaid",
          orderStatus: "pending_payment",
        }).limit(1).get();
        if (pending.data.length) throw new Error("该服务还有未支付的虚拟支付订单，请先确认订单已支付或关闭，再修改商品价格");
      }
    }
    updates.push({ data, previous });
  }
  for (const update of updates) {
    if (update.previous) {
      await db.collection("leqitong_services").doc(update.previous._id).update({ data: update.data });
    } else {
      await db.collection("leqitong_services").add({ data: { ...update.data, createdAt: nowText() } });
    }
  }
  return getServices();
}

function normalizeAnnouncementForClient(item) {
  const fallback = DEFAULT_ANNOUNCEMENTS.find((notice) => (
    (notice.title && notice.title === item.title)
      || (item.id && notice.id === item.id)
  ));
  return {
    ...item,
    id: item.id || item._id,
    content: String(item.content || item.body || item.text || (fallback && fallback.content) || ""),
  };
}

async function getAnnouncements(event) {
  const query = event.includeHidden && await hasAdminSession(event) ? {} : { visible: true };
  const result = await db.collection("leqitong_announcements").where(query).orderBy("publishedAt", "desc").get();
  if (result.data.length || event.includeHidden) return { list: result.data.map(normalizeAnnouncementForClient), source: "cloud" };
  const list = [];
  for (const notice of DEFAULT_ANNOUNCEMENTS) {
    const created = await db.collection("leqitong_announcements").add({ data: { ...notice, createdAt: nowText(), updatedAt: nowText() } });
    list.push(normalizeAnnouncementForClient({ ...notice, id: created._id }));
  }
  return { list, source: "cloud" };
}

async function getAnnouncement(event) {
  const id = String(event.id || "").trim();
  if (!id) return { item: null, source: "cloud" };
  const includeHidden = Boolean(event.includeHidden && await hasAdminSession(event));
  let item = null;
  try {
    const result = await db.collection("leqitong_announcements").doc(id).get();
    item = result.data || null;
  } catch (error) {
    item = null;
  }
  if (!item) {
    const result = await db.collection("leqitong_announcements").where({ id }).limit(1).get();
    item = result.data[0] || null;
  }
  if (!item || (!includeHidden && item.visible === false)) return { item: null, source: "cloud" };
  return { item: normalizeAnnouncementForClient(item), source: "cloud" };
}

async function saveAnnouncement(event) {
  await requireAdminSession(event);
  const data = { title: String(event.title || "").trim(), content: String(event.content || "").trim(), publishedAt: event.publishedAt || nowText(), visible: event.visible !== false, updatedAt: nowText() };
  if (!data.title || !data.content) throw new Error("公告标题和正文不能为空");
  if (event.id) {
    await db.collection("leqitong_announcements").doc(event.id).update({ data });
    return { id: event.id, ...data };
  }
  const result = await db.collection("leqitong_announcements").add({ data: { ...data, createdAt: nowText() } });
  return { id: result._id, ...data };
}

async function deleteAnnouncement(event) { await requireAdminSession(event); await db.collection("leqitong_announcements").doc(event.id).remove(); return { ok: true }; }
async function toggleAnnouncementVisible(event) { await requireAdminSession(event); const item = await db.collection("leqitong_announcements").doc(event.id).get(); await db.collection("leqitong_announcements").doc(event.id).update({ data: { visible: !item.data.visible, updatedAt: nowText() } }); return { ok: true }; }

async function resolvePaymentQrUrl(paymentQr) {
  const source = String(paymentQr || "").trim();
  if (!source || source === LEGACY_PAYMENT_QR) return "";
  if (/^https?:\/\//.test(source)) return source;
  if (!/^cloud:\/\//.test(source)) return "";
  try {
    const result = await cloud.getTempFileURL({ fileList: [source] });
    const item = result.fileList && result.fileList[0];
    return item && item.tempFileURL ? item.tempFileURL : "";
  } catch (error) {
    console.error("Failed to resolve payment QR file", error);
    return "";
  }
}

async function presentOrderPaymentQr(order) {
  order = normalizeConfirmedRefundOrder(order);
  let paymentQrSnapshot = order.paymentQrSnapshot || "";
  // Orders created before QR configuration may still hold the old local SVG
  // placeholder. It is not a collection code, so fall back to the service QR.
  if (paymentQrSnapshot === LEGACY_PAYMENT_QR) paymentQrSnapshot = "";
  if (!paymentQrSnapshot && order.serviceId) {
    const service = await resolveService(order.serviceId);
    paymentQrSnapshot = service && service.paymentQr || "";
  }
  const paymentQrUrl = await resolvePaymentQrUrl(paymentQrSnapshot);
  return {
    ...order,
    paymentQrSnapshot,
    paymentQrUrl,
    paymentQrStatus: !paymentQrSnapshot ? "not_configured" : (paymentQrUrl ? "ready" : "unavailable"),
  };
}

function orderData(event, openid, service, payMode = "qrcode", virtualConfig = null) {
  const order = event.order || {};
  if (!service || service.enabled === false) throw new Error("所选服务当前不可下单");
  const createdAt = nowText();
  const originalAmount = Number(service.price || 0);
  const discountAmount = payMode === "virtual" ? 0 : (crypto.randomBytes(1)[0] % 50 + 1) / 100;
  const amount = Number(Math.max(0, originalAmount - discountAmount).toFixed(2));
  const amountFen = amountToFen(amount);
  if (amountFen === null) throw new Error("服务价格最多保留两位小数");
  const orderNo = `LQT${Date.now()}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  return {
    company: order.company && typeof order.company === "object" ? order.company : {},
    contactPhone: String(order.contactPhone || "").trim(),
    idCardNo: String(order.idCardNo || "").trim(),
    staffNo: String(order.staffNo || "").trim(),
    annualReportSnapshot: order.annualReportSnapshot && typeof order.annualReportSnapshot === "object" ? order.annualReportSnapshot : {},
    legalVerifyResult: order.legalVerifyResult || null,
    orderNo,
    openid,
    serviceId: service.id,
    serviceName: service.name,
    originalAmount,
    discountAmount,
    amount,
    amountFen,
    originalAmountText: originalAmount.toFixed(2),
    discountText: discountAmount.toFixed(2),
    amountText: amount.toFixed(2),
    pricingVersion: payMode === "virtual" ? 3 : 2,
    paymentQrSnapshot: payMode === "virtual" ? "" : (service.paymentQr || ""),
    payMode,
    paymentProvider: payMode === "virtual" ? "wechat_virtual" : "manual_qr",
    virtualProductId: payMode === "virtual" ? String(service.virtualProductId || "").trim() : "",
    virtualOfferId: virtualConfig ? virtualConfig.offerId : "",
    virtualEnv: virtualConfig ? virtualConfig.env : null,
    outTradeNo: payMode === "virtual" ? orderNo : "",
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
    serviceStatus: "queued",
    createdAt,
    updatedAt: createdAt,
  };
}

function customerData(order, openid) {
  return {
    openid,
    orderNo: order.orderNo,
    company: order.company || {},
    contactPhone: order.contactPhone || "",
    idCardNo: order.idCardNo || "",
    staffNo: order.staffNo || "",
    annualReportSnapshot: order.annualReportSnapshot || {},
    extraInfo: order.extraInfo || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

async function resolveService(serviceId) {
  const result = await getServices();
  const service = result.list.find((item) => item.id === serviceId);
  if (!service) throw new Error("所选服务不存在");
  return service;
}

async function createOrder(event) {
  const service = await resolveService(event.order && event.order.serviceId);
  const openid = context().OPENID;
  const useVirtualPayment = isVirtualPaymentEnabled();
  const virtualConfig = useVirtualPayment ? getVirtualPaymentConfig() : null;
  if (useVirtualPayment && !String(service.virtualProductId || "").trim()) {
    throw new Error("所选服务尚未配置已发布的微信虚拟商品 ID");
  }
  if (useVirtualPayment && service.virtualPriceFen !== amountToFen(service.price)) {
    throw new Error("服务售价必须与微信后台已发布的虚拟商品价格一致");
  }
  const wxSession = useVirtualPayment ? await exchangeWechatLoginCode(event.loginCode, virtualConfig) : null;
  const data = orderData(event, openid, service, useVirtualPayment ? "virtual" : "qrcode", virtualConfig);
  data.staffVerifyResult = { ok: true, message: "未进行业务员工号校验" };
  const result = await db.collection("leqitong_orders").add({ data });
  const customerResult = await db.collection("leqitong_customers").add({ data: customerData(data, openid) });
  await db.collection("leqitong_orders").doc(result._id).update({ data: { customerId: customerResult._id } });
  const createdOrder = { ...data, id: result._id, customerId: customerResult._id };
  if (useVirtualPayment) {
    return { ...createdOrder, payData: makeVirtualPayData(createdOrder, wxSession.session_key, virtualConfig) };
  }
  return presentOrderPaymentQr(createdOrder);
}

async function prepareVirtualPayment(event) {
  const order = await getOrder(event);
  if (order.openid !== context().OPENID) throw new Error("无权操作此订单");
  if (order.payMode !== "virtual") throw new Error("该订单不是微信虚拟支付订单");
  if (order.paymentStatus !== "unpaid" || order.orderStatus !== "pending_payment") {
    throw new Error("当前订单状态不能继续支付");
  }
  const config = getVirtualPaymentConfig({ requireEnabled: true, env: order.virtualEnv });
  const wxSession = await exchangeWechatLoginCode(event.loginCode, config);
  const orderId = order._id || order.id || event.id;
  const orderRef = db.collection("leqitong_orders").doc(orderId);
  const latestBeforeWriteResult = await orderRef.get();
  if (!latestBeforeWriteResult.data) throw new Error("订单不存在，无法继续支付");
  const latestBeforeWrite = { ...latestBeforeWriteResult.data, id: latestBeforeWriteResult.data.id || latestBeforeWriteResult.data._id };
  if (latestBeforeWrite.paymentStatus !== "unpaid" || latestBeforeWrite.orderStatus !== "pending_payment") {
    return { stateChanged: true, order: latestBeforeWrite };
  }

  const initiatedAt = new Date().toISOString();
  const prepareId = crypto.randomBytes(12).toString("hex");
  await orderRef.update({ data: { paymentInitiatedAt: initiatedAt, paymentPrepareId: prepareId } });
  const latestResult = await orderRef.get();
  if (!latestResult.data) throw new Error("订单不存在，无法继续支付");
  const latestOrder = { ...latestResult.data, id: latestResult.data.id || latestResult.data._id };
  if (latestOrder.paymentStatus !== "unpaid" || latestOrder.orderStatus !== "pending_payment") {
    console.info("[virtual-payment] prepare aborted after order state changed", {
      orderNo: order.orderNo,
      latestPaymentStatus: latestOrder.paymentStatus,
      latestOrderStatus: latestOrder.orderStatus,
    });
    return { stateChanged: true, order: latestOrder };
  }
  if (latestOrder.paymentPrepareId !== prepareId) throw new Error("支付状态登记失败，请刷新订单后重试");
  return makeVirtualPayData(latestOrder, wxSession.session_key, config);
}

async function persistVirtualOrderState(order, platformOrder, source, notifyEvent = null, retryCount = 0) {
  const platformStatus = Number(platformOrder.status);
  if (hasConfirmedRefund(order)) return ensureConfirmedRefundState(order);
  if (platformStatus === 5) {
    const orderId = order._id || order.id;
    const latest = await db.collection("leqitong_orders").doc(orderId).get();
    if (!latest.data) throw new Error("订单不存在，无法同步微信支付状态");
    const latestOrder = { ...latest.data, id: latest.data.id || latest.data._id };
    return hasConfirmedRefund(latestOrder)
      ? ensureConfirmedRefundState(latestOrder)
      : latestOrder;
  }
  const updatedAt = nowText();
  const data = { paymentCheckedAt: updatedAt, paymentVerifySource: source, updatedAt };
  const leftFee = Number(platformOrder.left_fee);
  if (Number.isSafeInteger(leftFee) && leftFee >= 0) data.virtualLeftFeeFen = leftFee;
  if (platformOrder.order_type != null) data.virtualOrderType = Number(platformOrder.order_type);
  if ([2, 3, 4].includes(platformStatus)) {
    if (order.paymentStatus === "refunded") return order;
    const expectedFee = Number(order.amountFen);
    const paidFee = Number(platformOrder.paid_fee);
    const orderFee = Number(platformOrder.order_fee);
    if (!Number.isSafeInteger(expectedFee) || !Number.isSafeInteger(paidFee) || paidFee !== expectedFee) {
      throw new Error("微信支付订单金额与本地订单不一致");
    }
    if (!Number.isSafeInteger(orderFee) || orderFee !== expectedFee) {
      throw new Error("微信虚拟商品价格与本地订单不一致");
    }
    const notifyPayInfo = notifyEvent && notifyEvent.WeChatPayInfo || {};
    const wxOrderId = String(platformOrder.wx_order_id || notifyPayInfo.MchOrderNo || "");
    if (!wxOrderId) throw new Error("微信查单结果缺少平台订单号");
    data.paymentStatus = "paid";
    data.paymentAmountFen = paidFee;
    data.paymentAmount = paidFee / 100;
    data.paymentAmountText = (paidFee / 100).toFixed(2);
    data.paidAt = order.paidAt || paidTimeText(platformOrder.paid_time);
    data.wxOrderId = wxOrderId;
    data.wxTransactionId = String(platformOrder.wxpay_order_id || notifyPayInfo.TransactionId || "");
    if (order.orderStatus === "pending_payment" || order.orderStatus === "cancelled") {
      data.orderStatus = "pending_confirm";
      data.serviceStatus = "queued";
      if (order.orderStatus === "cancelled") data.cancelledOrderPaymentRecoveredAt = updatedAt;
    }
    if (notifyEvent) {
      data.paymentNotifyAt = updatedAt;
      const previousNotifyId = String(order.paymentNotifyWxOrderId || "");
      data.paymentNotifyCount = Number(order.paymentNotifyCount || 0) + (previousNotifyId === wxOrderId ? 0 : 1);
      data.paymentNotifyWxOrderId = wxOrderId;
    }
  } else if (platformStatus === 8) {
    const notifyPayInfo = notifyEvent || {};
    const refundSucceededAt = notifyEvent && Number(notifyEvent.RefundSuccTimestamp)
      ? paidTimeText(notifyEvent.RefundSuccTimestamp)
      : updatedAt;
    const platformRefundFee = Number(platformOrder.refund_fee);
    data.paymentStatus = "refunded";
    data.orderStatus = "refunded";
    data.refundStatus = "succeeded";
    data.refundedAt = refundSucceededAt;
    data.refundSucceededAt = refundSucceededAt;
    data.refundAmountFen = Number.isSafeInteger(platformRefundFee) && platformRefundFee > 0
      ? platformRefundFee
      : Number(order.amountFen || Math.round(Number(order.amount || 0) * 100));
    data.refundWxOrderId = String(notifyPayInfo.WxOrderId || platformOrder.wx_order_id || "");
    data.refundWxRefundId = String(notifyPayInfo.WxRefundId || order.refundWxRefundId || "");
    data.refundMchRefundId = String(notifyPayInfo.MchRefundId || order.refundMchRefundId || "");
    data.wxOrderId = String(platformOrder.wx_order_id || order.wxOrderId || "");
    data.wxTransactionId = String(platformOrder.wxpay_order_id || order.wxTransactionId || "");
    if (notifyEvent) {
      data.refundNotifyAt = updatedAt;
      data.refundNotifyRetCode = Number(notifyEvent.RetCode);
      data.refundNotifyRetMsg = String(notifyEvent.RetMsg || "");
    }
  } else if (platformStatus === 6 && order.paymentStatus === "unpaid") {
    data.paymentStatus = "cancelled";
    data.orderStatus = "cancelled";
  } else if (platformStatus === 7) {
    if (["unpaid", "cancelled"].includes(order.paymentStatus)) data.paymentStatus = "paid";
    if (order.orderStatus === "pending_payment") data.orderStatus = "pending_confirm";
    data.refundStatus = "failed";
    data.refundFailureAt = updatedAt;
    data.refundFailureFeeFen = Number(platformOrder.refund_fee || 0);
  } else {
    return order;
  }
  data.updatedAt = updatedAt;
  const orderId = order._id || order.id;
  const condition = { _id: orderId, paymentStatus: order.paymentStatus };
  condition.refundStatus = Object.prototype.hasOwnProperty.call(order, "refundStatus")
    ? order.refundStatus
    : _.exists(false);
  addRefundSuccessSnapshot(condition, order);
  const write = await db.collection("leqitong_orders")
    .where(condition)
    .update({ data });
  if (!write.stats || write.stats.updated !== 1) {
    const latest = await db.collection("leqitong_orders").doc(orderId).get();
    if (!latest.data) throw new Error("订单不存在，无法同步微信支付状态");
    const latestOrder = { ...latest.data, id: latest.data.id || latest.data._id };
    if (hasConfirmedRefund(latestOrder)) return ensureConfirmedRefundState(latestOrder);
    const alreadyApplied = Object.entries(data).every(([key, value]) => Object.is(latest.data[key], value));
    if (alreadyApplied) return latestOrder;
    if (retryCount < 1) {
      return persistVirtualOrderState(latestOrder, platformOrder, source, notifyEvent, retryCount + 1);
    }
    if (platformStatus === 8) {
      console.error("Virtual refund is confirmed by WeChat but local state was not persisted", {
        orderNo: latestOrder.orderNo,
        source,
        paymentStatus: latestOrder.paymentStatus,
        refundStatus: latestOrder.refundStatus,
      });
      throw new Error("微信查单显示退款已完成，但本地订单状态未同步成功；请刷新重试，不要再次发起退款");
    }
    if (notifyEvent) throw new Error("订单支付状态仍在更新，等待微信通知重试");
    console.info("Virtual payment state changed during reconciliation; returning latest order", {
      orderNo: latestOrder.orderNo,
      source,
      platformStatus,
      paymentStatus: latestOrder.paymentStatus,
      refundStatus: latestOrder.refundStatus,
    });
    return latestOrder;
  }
  const result = await db.collection("leqitong_orders").doc(orderId).get();
  return { ...result.data, id: result.data.id || result.data._id };
}

async function reconcileVirtualPayOrder(event) {
  const order = await getOrder(event);
  if (order.payMode !== "virtual") return order;
  if (hasConfirmedRefund(order)) return ensureConfirmedRefundState(order);
  if (order.paymentStatus === "cancelled" && !order.paymentInitiatedAt) return order;
  const config = getVirtualPaymentConfig({ requireEnabled: false, env: order.virtualEnv });
  let platformOrder;
  try {
    platformOrder = await queryWechatVirtualOrder(order, config);
  } catch (error) {
    if (Number(error && error.wechatErrCode) === 268490002
      && order.paymentStatus === "unpaid"
      && order.orderStatus === "pending_payment") {
      console.info("[virtual-payment] no platform order found; keeping local order unpaid", {
        orderNo: order.orderNo,
        paymentInitiated: Boolean(order.paymentInitiatedAt),
      });
      return { ...order, virtualOrderFound: false };
    }
    throw error;
  }
  return persistVirtualOrderState(order, platformOrder, "query_order");
}

function hasConfirmedRefund(order) {
  return Boolean(order && (
    order.paymentStatus === "refunded"
    || order.refundStatus === "succeeded"
    || order.orderStatus === "refunded"
    || order.refundSucceededAt
    || order.refundedAt
    || (Number(order.refundNotifyRetCode) === 0 && order.refundNotifyAt)
  ));
}

function normalizeConfirmedRefundOrder(order) {
  if (!hasConfirmedRefund(order)) return order;
  return { ...order, paymentStatus: "refunded", orderStatus: "refunded", refundStatus: "succeeded" };
}

function addRefundSuccessSnapshot(condition, order) {
  for (const field of ["refundSucceededAt", "refundedAt", "refundNotifyRetCode", "refundNotifyAt"]) {
    condition[field] = Object.prototype.hasOwnProperty.call(order, field) ? order[field] : _.exists(false);
  }
  return condition;
}

async function ensureConfirmedRefundState(order) {
  if (!hasConfirmedRefund(order)) return order;
  const normalized = normalizeConfirmedRefundOrder(order);
  if (order.paymentStatus === "refunded" && order.orderStatus === "refunded" && order.refundStatus === "succeeded") {
    return normalized;
  }

  const orderId = order._id || order.id;
  const condition = { _id: orderId };
  for (const field of ["paymentStatus", "orderStatus", "refundStatus", "refundSucceededAt", "refundedAt", "refundNotifyRetCode", "refundNotifyAt"]) {
    condition[field] = Object.prototype.hasOwnProperty.call(order, field) ? order[field] : _.exists(false);
  }
  const result = await db.collection("leqitong_orders").where(condition).update({ data: {
    paymentStatus: "refunded",
    orderStatus: "refunded",
    refundStatus: "succeeded",
  } });
  const latest = await db.collection("leqitong_orders").doc(orderId).get();
  if (!latest.data) return normalized;
  const latestOrder = { ...latest.data, id: latest.data.id || latest.data._id };
  if (result.stats && result.stats.updated === 1) return normalizeConfirmedRefundOrder(latestOrder);
  return hasConfirmedRefund(latestOrder) ? normalizeConfirmedRefundOrder(latestOrder) : normalized;
}

async function findVirtualOrderByOutTradeNo(outTradeNo) {
  const result = await db.collection("leqitong_orders").where({ orderNo: String(outTradeNo || "").trim() }).limit(1).get();
  const order = result.data[0];
  if (!order || order.payMode !== "virtual" || order.outTradeNo !== outTradeNo) {
    throw new Error("找不到对应的微信虚拟支付订单");
  }
  return order;
}

function validateVirtualNotifyBase(event, order, options = {}) {
  if (event.AppId && event.AppId !== LEQITONG_APP_ID) throw new Error("虚拟支付通知 AppID 不匹配");
  if (event.OpenId !== order.openid) throw new Error("虚拟支付通知用户不匹配");
  if (event.Env == null) {
    if (!options.allowMissingEnv) throw new Error("虚拟支付通知缺少环境信息");
  } else if (Number(event.Env) !== Number(order.virtualEnv)) {
    throw new Error("虚拟支付通知环境不匹配");
  }
}

async function handleVirtualGoodsNotify(event) {
  const order = await findVirtualOrderByOutTradeNo(event.OutTradeNo);
  validateVirtualNotifyBase(event, order);
  const goods = event.GoodsInfo || {};
  if (String(goods.ProductId || "") !== String(order.virtualProductId || "") || Number(goods.Quantity) !== 1) {
    throw new Error("虚拟支付通知商品信息不匹配");
  }
  if (Number(goods.ActualPrice) !== Number(order.amountFen)) throw new Error("虚拟支付通知金额不匹配");
  const config = getVirtualPaymentConfig({ requireEnabled: false, env: order.virtualEnv });
  const platformOrder = await queryWechatVirtualOrder(order, config);
  if (![2, 3, 4].includes(Number(platformOrder.status))) throw new Error("微信侧尚未确认该订单已支付");
  const notifyPayInfo = event.WeChatPayInfo || {};
  if (notifyPayInfo.MchOrderNo && platformOrder.wx_order_id && notifyPayInfo.MchOrderNo !== platformOrder.wx_order_id) {
    throw new Error("发货通知中的微信订单号与查单结果不一致");
  }
  if (notifyPayInfo.TransactionId && platformOrder.wxpay_order_id && notifyPayInfo.TransactionId !== platformOrder.wxpay_order_id) {
    throw new Error("发货通知中的交易号与查单结果不一致");
  }
  return persistVirtualOrderState(order, platformOrder, "callback", event);
}

async function persistVirtualRefundNotify(order, event, refundOrderId, retCode, retryCount = 0) {
  const orderId = order._id || order.id;
  const expectedRefundFee = Number(order.refundAttemptAmountFen != null
    ? order.refundAttemptAmountFen
    : order.refundAmountFen != null
      ? order.refundAmountFen
      : order.paymentAmountFen != null
        ? order.paymentAmountFen
        : order.amountFen);
  const refundFee = Number(event.RefundFee);
  if (retCode === 0) {
    if (!Number.isSafeInteger(refundFee) || refundFee <= 0) {
      throw new Error("退款成功通知缺少有效退款金额");
    }
    if (!Number.isSafeInteger(expectedRefundFee) || expectedRefundFee <= 0 || refundFee !== expectedRefundFee) {
      throw new Error("退款通知金额与本地退款申请金额不一致");
    }
  } else if (Number.isSafeInteger(refundFee) && refundFee > 0
    && Number.isSafeInteger(expectedRefundFee) && expectedRefundFee > 0
    && refundFee !== expectedRefundFee) {
    throw new Error("退款失败通知金额与本地退款申请金额不一致");
  }

  if (!["paid", "refunded"].includes(order.paymentStatus)) {
    throw new Error("退款通知对应的订单尚未确认支付");
  }
  if (hasConfirmedRefund(order)) return ensureConfirmedRefundState(order);
  if (retCode !== 0 && order.refundStatus === "failed"
    && Number(order.refundNotifyRetCode) === retCode
    && String(order.refundMchRefundId || "") === refundOrderId) return order;

  const updatedAt = nowText();
  const data = {
    refundNotifyAt: updatedAt,
    refundNotifyRetCode: retCode,
    refundNotifyRetMsg: String(event.RetMsg || "").slice(0, 300),
    refundNotifyRetryTimes: Number(event.RetryTimes || 0),
    refundMchRefundId: refundOrderId,
    refundWxRefundId: String(event.WxRefundId || order.refundWxRefundId || ""),
    refundWxOrderId: String(event.WxOrderId || order.refundWxOrderId || order.wxOrderId || ""),
    refundWxpayTransactionId: String(event.WxpayRefundTransactionId || order.refundWxpayTransactionId || ""),
    refundAmountFen: retCode === 0
      ? refundFee
      : Number.isSafeInteger(expectedRefundFee) && expectedRefundFee > 0 ? expectedRefundFee : 0,
    paymentCheckedAt: updatedAt,
    paymentVerifySource: "refund_callback",
    updatedAt,
  };

  if (retCode === 0) {
    const refundSucceededAt = Number(event.RefundSuccTimestamp) > 0
      ? paidTimeText(event.RefundSuccTimestamp)
      : updatedAt;
    data.paymentStatus = "refunded";
    data.orderStatus = "refunded";
    data.refundStatus = "succeeded";
    data.refundedAt = refundSucceededAt;
    data.refundSucceededAt = refundSucceededAt;
    data.refundRequestMessage = "微信已确认退款成功";
  } else {
    data.paymentStatus = "paid";
    data.refundStatus = "failed";
    data.refundFailureAt = updatedAt;
    data.refundFailureCode = retCode;
    data.refundFailureMessage = String(event.RetMsg || "微信退款失败").slice(0, 300);
    data.refundFailureFeeFen = Number.isSafeInteger(refundFee) && refundFee >= 0 ? refundFee : 0;
    data.refundRequestMessage = data.refundFailureMessage;
  }

  const condition = { _id: orderId, paymentStatus: order.paymentStatus };
  const attemptId = String(order.refundAttemptId || "").trim();
  if (attemptId) condition.refundAttemptId = attemptId;
  else if (order.refundMchRefundId) condition.refundMchRefundId = String(order.refundMchRefundId);
  if (Object.prototype.hasOwnProperty.call(order, "refundStatus")) condition.refundStatus = order.refundStatus;
  else condition.refundStatus = _.exists(false);
  addRefundSuccessSnapshot(condition, order);

  const write = await db.collection("leqitong_orders").where(condition).update({ data });
  if (write.stats && write.stats.updated === 1) {
    const result = await db.collection("leqitong_orders").doc(orderId).get();
    return { ...result.data, id: result.data.id || result.data._id };
  }

  const latest = await db.collection("leqitong_orders").doc(orderId).get();
  if (!latest.data) throw new Error("退款通知对应的订单不存在");
  const latestOrder = { ...latest.data, id: latest.data.id || latest.data._id };
  const latestAttemptId = String(latestOrder.refundAttemptId || latestOrder.refundMchRefundId || "").trim();
  if (retCode === 0 && hasConfirmedRefund(latestOrder)
    && (!latestAttemptId || latestAttemptId === refundOrderId)) return ensureConfirmedRefundState(latestOrder);
  if (retCode !== 0 && hasConfirmedRefund(latestOrder)) return ensureConfirmedRefundState(latestOrder);
  if (retCode !== 0 && latestOrder.refundStatus === "failed"
    && Number(latestOrder.refundNotifyRetCode) === retCode
    && (!latestAttemptId || latestAttemptId === refundOrderId)) return latestOrder;
  if (latestAttemptId && latestAttemptId !== refundOrderId) {
    console.info("[xpay_refund_notify] ignored stale refund notification", {
      orderNo: order.orderNo,
      refundOrderId,
      activeRefundOrderId: latestAttemptId,
    });
    return latestOrder;
  }
  if (retryCount < 2) return persistVirtualRefundNotify(latestOrder, event, refundOrderId, retCode, retryCount + 1);
  throw new Error("退款订单状态仍在更新，等待微信通知重试");
}

async function handleVirtualRefundNotify(event) {
  const outTradeNo = String(event.MchOrderId || "").trim();
  const order = await findVirtualOrderByOutTradeNo(outTradeNo);
  console.info("[xpay_refund_notify] env check", {
    orderNo: order.orderNo || outTradeNo,
    eventEnv: event.Env == null ? null : Number(event.Env),
    eventEnvProvided: event.Env != null,
    orderEnv: order.virtualEnv == null ? null : Number(order.virtualEnv),
  });
  validateVirtualNotifyBase(event, order, { allowMissingEnv: true });
  const refundOrderId = String(event.MchRefundId || "").trim();
  if (!refundOrderId) throw new Error("退款通知缺少商户退款单号");
  const activeRefundId = String(order.refundAttemptId || order.refundMchRefundId || "").trim();
  if (activeRefundId && activeRefundId !== refundOrderId) {
    console.info("[xpay_refund_notify] ignored stale refund notification", {
      orderNo: order.orderNo || outTradeNo,
      refundOrderId,
      activeRefundOrderId: activeRefundId,
    });
    return order;
  }
  const retCode = Number(event.RetCode);
  if (!Number.isSafeInteger(retCode)) throw new Error("退款通知结果码无效");
  const updated = await persistVirtualRefundNotify(order, event, refundOrderId, retCode);
  console.info("[xpay_refund_notify] persisted", {
    orderNo: order.orderNo || outTradeNo,
    refundOrderId,
    retCode,
    paymentStatus: updated.paymentStatus,
    refundStatus: updated.refundStatus,
  });
  return updated;
}

async function getMyOrders() {
  const result = await db.collection("leqitong_orders").where({ openid: context().OPENID }).orderBy("createdAt", "desc").get();
  const orders = result.data || [];
  return { list: orders.map((item) => ({ ...normalizeConfirmedRefundOrder(item), id: item.id || item._id })) };
}
async function getOrder(event) {
  const result = await db.collection("leqitong_orders").doc(event.id).get();
  const isOrderOwner = result.data.openid === context().OPENID;
  const hasAdminAccess = Boolean(await getSecureAdminSession(event));
  if (!isOrderOwner && !hasAdminAccess) throw new Error("无权查看此订单");
  const order = await ensureConfirmedRefundState({ ...result.data, id: result.data.id || result.data._id });
  return presentOrderPaymentQr(order);
}

async function cancelMyOrder(event) {
  let order = await getOrder(event);
  if (order.openid !== context().OPENID) throw new Error("无权操作此订单");
  if (order.orderStatus === "cancelled" || order.paymentStatus === "cancelled") return order;
  if (order.paymentStatus !== "unpaid" || order.orderStatus !== "pending_payment") {
    throw new Error("当前订单状态不能取消");
  }

  if (order.payMode === "virtual" && order.paymentInitiatedAt) {
    order = await verifyVirtualOrderCanBeCancelled(order, "cancel_precheck");
    if (order.paymentStatus === "cancelled") return order;
  }

  const cancelledAt = nowText();
  const result = await db.collection("leqitong_orders")
    .where({ _id: event.id, openid: context().OPENID, paymentStatus: "unpaid", orderStatus: "pending_payment" })
    .update({ data: {
      paymentStatus: "cancelled",
      orderStatus: "cancelled",
      cancelledAt,
      updatedAt: cancelledAt,
    } });
  if (!result.stats || result.stats.updated !== 1) throw new Error("订单状态已变化，请刷新后重试");
  return getOrder(event);
}

async function userConfirmPayment(event) {
  const order = await getOrder(event);
  if (order.openid !== context().OPENID) throw new Error("无权操作此订单");
  if (order.paymentStatus === "confirmed_by_user") return order;
  if (order.paymentStatus !== "unpaid" || order.orderStatus !== "pending_payment") {
    throw new Error("当前订单状态不能提交付款确认");
  }
  if (!order.paymentQrSnapshot) throw new Error("收款二维码尚未配置，无法提交付款确认");

  const confirmedAt = nowText();
  const result = await db.collection("leqitong_orders")
    .where({ _id: event.id, paymentStatus: "unpaid", orderStatus: "pending_payment" })
    .update({ data: {
      paymentStatus: "confirmed_by_user",
      orderStatus: "pending_confirm",
      serviceStatus: "queued",
      userConfirmedAt: confirmedAt,
      updatedAt: confirmedAt,
    } });
  if (!result.stats || result.stats.updated !== 1) {
    const latest = await getOrder(event);
    if (latest.paymentStatus === "confirmed_by_user") return latest;
    throw new Error("订单付款确认状态更新失败，请刷新后重试");
  }
  return getOrder(event);
}
async function updateOrderExtra(event) {
  const order = await getOrder(event);
  if (order.openid !== context().OPENID) throw new Error("无权操作此订单");
  const updatedAt = nowText();
  const extraInfo = event.extraInfo || {};
  await db.collection("leqitong_orders").doc(event.id).update({ data: { extraInfo, updatedAt } });
  if (order.customerId) await db.collection("leqitong_customers").doc(order.customerId).update({ data: { extraInfo, updatedAt } });
  return getOrder(event);
}
async function adminGetOrders(event) {
  await requireAdminSession(event);
  const result = await db.collection("leqitong_orders").orderBy("createdAt", "desc").limit(100).get();
  const orders = result.data || [];
  return { list: orders.map((item) => ({ ...normalizeConfirmedRefundOrder(item), id: item.id || item._id })) };
}
async function adminUpdateOrder(event) {
  const session = await requireAdminSession(event);
  const currentResult = await db.collection("leqitong_orders").doc(event.id).get();
  let current = currentResult.data;
  if (!current) throw new Error("订单不存在");
  const input = event.data || {};
  const data = {};
  if (Object.prototype.hasOwnProperty.call(input, "adminRemark")) data.adminRemark = String(input.adminRemark || "").slice(0, 2000);
  if (Object.prototype.hasOwnProperty.call(input, "orderStatus")) {
    const nextStatus = String(input.orderStatus || "");
    if (!["pending_confirm", "processing", "completed", "refunded", "cancelled"].includes(nextStatus)) throw new Error("无效的订单状态");
    data.orderStatus = nextStatus;
    if (nextStatus === "pending_confirm") {
      if (current.payMode === "virtual" && current.paymentStatus !== "paid") {
        throw new Error("虚拟支付订单必须先由微信服务端确认到账，才能进入待审核");
      }
      data.serviceStatus = "queued";
    }
    if (nextStatus === "processing" || nextStatus === "completed") {
      if (current.payMode === "virtual" && current.paymentStatus !== "paid") {
        throw new Error("虚拟支付订单必须先由微信服务端确认到账，才能开始办理");
      }
      const confirmedAt = nowText();
      const amount = Number(current.amount || 0);
      const amountFen = current.amountFen != null && Number.isSafeInteger(Number(current.amountFen))
        ? Number(current.amountFen)
        : Math.round(amount * 100);
      if (current.payMode !== "virtual") {
        data.paymentStatus = "confirmed_by_admin";
        data.paymentAmount = amount;
        data.paymentAmountFen = amountFen;
        data.paymentAmountText = amount.toFixed(2);
        data.paidAt = current.paidAt || confirmedAt;
        data.paymentConfirmedAt = current.paymentConfirmedAt || confirmedAt;
        data.paymentConfirmedByAdminId = session.accountId || "";
      }
      data.serviceStatus = nextStatus === "completed" ? "completed" : "processing";
    }
    if (nextStatus === "cancelled" && current.payMode === "virtual" && current.paymentStatus === "paid") {
      throw new Error("该虚拟支付订单已到账，请先完成微信平台退款后再关闭订单");
    }
    if (nextStatus === "cancelled" && current.payMode === "virtual" && current.paymentStatus === "unpaid" && current.paymentInitiatedAt) {
      current = await verifyVirtualOrderCanBeCancelled(current, "admin_cancel_precheck");
    }
    if (nextStatus === "cancelled" && !["unpaid", "cancelled"].includes(current.paymentStatus)) {
      throw new Error("订单已有支付或付款确认记录，不能直接取消；请先按原支付方式处理退款或核实");
    }
    if (nextStatus === "cancelled" && current.paymentStatus === "unpaid") {
      data.paymentStatus = "cancelled";
      data.cancelledAt = nowText();
    }
    if (nextStatus === "refunded") {
      if (current.payMode === "virtual") throw new Error("虚拟支付退款状态只能由微信退款推送或服务端查单更新");
      if (!["confirmed_by_admin", "paid"].includes(current.paymentStatus)) {
        throw new Error("只有已确认收款的订单才能标记为已退款");
      }
      const storedAmountFen = current.paymentAmountFen != null
        ? Number(current.paymentAmountFen)
        : current.amountFen != null
          ? Number(current.amountFen)
          : Math.round(Number(current.amount || 0) * 100);
      const refundAt = nowText();
      data.paymentStatus = "refunded";
      data.refundStatus = "succeeded";
      data.refundAmountFen = Number.isSafeInteger(storedAmountFen) && storedAmountFen > 0
        ? storedAmountFen
        : Math.round(Number(current.amount || 0) * 100);
      data.refundedAt = refundAt;
      data.refundSucceededAt = refundAt;
      data.refundConfirmationSource = "admin";
      data.refundConfirmedByAdminId = session.accountId || "";
      data.refundConfirmedByPhone = session.phone || "";
      data.refundConfirmedByName = session.name || "";
      data.refundConfirmedByOpenid = context().OPENID;
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "paymentStatus") && !Object.prototype.hasOwnProperty.call(input, "orderStatus")) {
    throw new Error("请通过订单状态更新并核实收款");
  }
  if (!Object.keys(data).length) throw new Error("没有可更新的订单字段");
  const write = await db.collection("leqitong_orders")
    .where({ _id: event.id, paymentStatus: current.paymentStatus, orderStatus: current.orderStatus })
    .update({ data: { ...data, updatedAt: nowText(), updatedByAdminId: session.accountId || "", updatedByPhone: session.phone || "", updatedByName: session.name || "", updatedByOpenid: context().OPENID, lastOperationAt: nowText() } });
  if (!write.stats || write.stats.updated !== 1) throw new Error("订单状态已被其他请求更新，请刷新后重试");
  const result = await db.collection("leqitong_orders").doc(event.id).get();
  return { ...result.data, id: result.data.id || result.data._id };
}

async function adminBulkUpdateOrderStatus(event) {
  await requireAdminSession(event);
  const ids = [...new Set((Array.isArray(event.ids) ? event.ids : []).map((id) => String(id || "").trim()).filter(Boolean))];
  const status = String(event.orderStatus || "");
  if (!ids.length || ids.length > 100) throw new Error("请选择 1 到 100 个订单");
  if (!["pending_confirm", "processing", "completed", "cancelled"].includes(status)) {
    throw new Error("批量办理状态无效");
  }
  const results = [];
  for (const id of ids) {
    try {
      const order = await adminUpdateOrder({ ...event, id, data: { orderStatus: status } });
      results.push({ id, ok: true, order });
    } catch (error) {
      results.push({ id, ok: false, message: error.message || "更新失败" });
    }
  }
  return {
    results,
    successCount: results.filter((item) => item.ok).length,
    failureCount: results.filter((item) => !item.ok).length,
  };
}

async function adminRequestVirtualRefund(event) {
  const session = await requireAdminSession(event);
  const expectedConfirmPassword = String(process.env.LEQITONG_REFUND_CONFIRM_PASSWORD || "");
  if (!expectedConfirmPassword) throw new Error("云函数未配置退款确认密码");
  if (typeof event.refundConfirmPassword !== "string" || event.refundConfirmPassword !== expectedConfirmPassword) {
    throw new Error("退款确认密码错误");
  }
  let order = await getOrder(event);
  if (order.payMode !== "virtual") throw new Error("当前订单不是微信虚拟支付订单");
  if (hasConfirmedRefund(order)) return { order: await ensureConfirmedRefundState(order), message: "该订单已退款" };

  const config = getVirtualPaymentConfig({ requireEnabled: false, env: order.virtualEnv });
  const platformOrder = await queryWechatVirtualOrder(order, config);
  order = await persistVirtualOrderState(order, platformOrder, "admin_refund_precheck");
  const platformStatus = Number(platformOrder.status);
  if (hasConfirmedRefund(order)) {
    return { order: await ensureConfirmedRefundState(order), message: "微信已确认退款成功" };
  }
  if (platformStatus === 5) return { order, message: "微信退款仍在处理中，请稍后刷新查询" };
  if (platformStatus === 8) {
    if (order.paymentStatus !== "refunded" || order.refundStatus !== "succeeded") {
      throw new Error("微信查单显示退款已完成，但本地订单状态未同步成功；请刷新重试，不要再次发起退款");
    }
    return { order, message: "微信已确认退款成功" };
  }
  if (![2, 3, 4, 7].includes(platformStatus) || order.paymentStatus !== "paid") {
    throw new Error("微信侧尚未确认订单已支付，不能发起退款");
  }
  if (Number(platformOrder.order_type) === 7) {
    return { order, message: "这是 iOS 支付订单，需由用户通过 App Store 申请退款" };
  }

  const paidAtSeconds = Number(platformOrder.paid_time || 0);
  if (!paidAtSeconds || Date.now() - paidAtSeconds * 1000 > 365 * 24 * 60 * 60 * 1000) {
    throw new Error("该订单已超过微信虚拟支付允许的 365 天退款期限");
  }
  const leftFeeFen = Number(platformOrder.left_fee);
  if (!Number.isSafeInteger(leftFeeFen) || leftFeeFen <= 0) throw new Error("微信订单没有可退款余额");

  if (order.refundStatus === "processing") return { order, message: "退款已提交，正在等待微信确认" };
  let attempt;
  if (order.refundStatus === "requesting") {
    attempt = {
      refundOrderId: order.refundAttemptId,
      leftFeeFen: Number(order.refundAttemptLeftFeeFen),
      refundAmountFen: Number(order.refundAttemptAmountFen),
      refundReason: Number(order.refundAttemptReason),
      bizMeta: String(order.refundAttemptBizMeta || ""),
    };
    if (!attempt.refundOrderId || !Number.isSafeInteger(attempt.leftFeeFen) || attempt.leftFeeFen !== leftFeeFen
      || !Number.isSafeInteger(attempt.refundAmountFen) || attempt.refundAmountFen <= 0
      || attempt.refundAmountFen > leftFeeFen) {
      return { order, message: "上次退款请求结果未确认且可退余额已变化，请稍后刷新订单状态" };
    }
  } else {
    const refundAmountFen = leftFeeFen;
    const refundReason = event.refundReason == null ? 5 : Number(event.refundReason);
    if (event.refundAmountFen != null && Number(event.refundAmountFen) !== leftFeeFen) {
      throw new Error("后台当前按微信订单剩余可退金额全额退款");
    }
    if (!Number.isSafeInteger(refundAmountFen) || refundAmountFen <= 0) {
      throw new Error("微信订单没有有效的可退款金额");
    }
    if (![0, 1, 2, 3, 4, 5].includes(refundReason)) throw new Error("退款原因无效");
    const refundOrderId = `LQR${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    attempt = {
      refundOrderId,
      leftFeeFen,
      refundAmountFen,
      refundReason,
      bizMeta: JSON.stringify({ source: "web_admin", orderNo: order.orderNo, refundOrderId }),
    };
    const orderId = order._id || order.id;
    const condition = { _id: orderId, paymentStatus: "paid" };
    condition.refundStatus = Object.prototype.hasOwnProperty.call(order, "refundStatus")
      ? order.refundStatus
      : _.exists(false);
    addRefundSuccessSnapshot(condition, order);
    const reserved = await db.collection("leqitong_orders").where(condition).update({ data: {
      refundStatus: "requesting",
      refundRequestedAt: nowText(),
      refundAttemptId: attempt.refundOrderId,
      refundMchRefundId: attempt.refundOrderId,
      refundWxRefundId: "",
      refundAttemptLeftFeeFen: attempt.leftFeeFen,
      refundAttemptAmountFen: attempt.refundAmountFen,
      refundAttemptReason: attempt.refundReason,
      refundAttemptBizMeta: attempt.bizMeta,
      refundAmountFen: attempt.refundAmountFen,
      refundReason: attempt.refundReason,
      refundRequestedByAdminId: session.accountId || "",
      refundRequestedByPhone: session.phone || "",
      refundRequestedByName: session.name || "",
      refundRequestedByOpenid: context().OPENID,
      virtualLeftFeeFen: leftFeeFen,
      updatedAt: nowText(),
    } });
    if (!reserved.stats || reserved.stats.updated !== 1) {
      throw new Error("订单状态已变化或已有退款请求，请刷新后再试");
    }
    order.refundStatus = "requesting";
  }

  let result;
  try {
    result = await requestWechatVirtualRefund(order, attempt, config);
  } catch (error) {
    const latest = await db.collection("leqitong_orders").doc(order._id || order.id).get();
    const latestOrder = latest.data && { ...latest.data, id: latest.data.id || latest.data._id };
    if (latestOrder && hasConfirmedRefund(latestOrder)) {
      return {
        order: await ensureConfirmedRefundState(latestOrder),
        message: "微信已确认退款成功",
      };
    }
    return {
      order: latestOrder,
      message: "退款请求结果暂未确认，系统已保留本次退款单号，请稍后刷新查询，不要重复创建退款单",
    };
  }

  const code = Number(result.errcode || 0);
  const updatedAt = nowText();
  const updateData = code === 268490014
    ? { refundStatus: "processing", refundRequestMessage: String(result.errmsg || "退款处理中") }
    : code
      ? { refundStatus: "failed", refundFailureAt: updatedAt, refundFailureCode: code, refundRequestMessage: String(result.errmsg || "退款申请失败").slice(0, 300) }
      : {
        refundStatus: "processing",
        refundWxRefundId: String(result.refund_wx_order_id || ""),
        refundMchRefundId: String(result.refund_order_id || attempt.refundOrderId),
        refundPayWxOrderId: String(result.pay_wx_order_id || ""),
        refundRequestMessage: "退款任务已启动，等待微信确认",
      };
  const orderId = order._id || order.id;
  const resultCondition = {
    _id: orderId,
    paymentStatus: "paid",
    refundStatus: "requesting",
    refundAttemptId: attempt.refundOrderId,
  };
  addRefundSuccessSnapshot(resultCondition, order);
  const resultWrite = await db.collection("leqitong_orders")
    .where(resultCondition)
    .update({ data: { ...updateData, updatedAt } });
  const latest = await db.collection("leqitong_orders").doc(orderId).get();
  if (latest.data && hasConfirmedRefund(latest.data)) {
    return {
      order: await ensureConfirmedRefundState({ ...latest.data, id: latest.data.id || latest.data._id }),
      message: "微信已确认退款成功",
    };
  }
  if ((!resultWrite.stats || resultWrite.stats.updated !== 1)
    && latest.data.paymentStatus === "paid"
    && latest.data.refundStatus === "requesting"
    && latest.data.refundAttemptId === attempt.refundOrderId) {
    throw new Error("微信已返回退款结果，但订单状态写入失败，请刷新后重试查询");
  }
  return {
    order: { ...latest.data, id: latest.data.id || latest.data._id },
    message: code && code !== 268490014
      ? `微信退款申请失败（${code}）：${String(result.errmsg || "请稍后重试")}`
      : code === 268490014
        ? "微信已有退款任务处理中，请稍后刷新查询"
        : "微信退款任务已启动，最终结果以微信查单或通知为准",
  };
}

function dateKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isPaidOrder(order) {
  return ["confirmed_by_admin", "paid", "refunded"].includes(order.paymentStatus)
    || ["processing", "completed"].includes(order.orderStatus);
}

function isRefundedOrder(order) {
  return hasConfirmedRefund(order);
}

function orderAmountFen(order) {
  const storedAmountFen = order.paymentAmountFen != null
    ? Number(order.paymentAmountFen)
    : order.amountFen != null
      ? Number(order.amountFen)
      : Math.round(Number(order.amount || 0) * 100);
  return Number.isSafeInteger(storedAmountFen) && storedAmountFen > 0 ? storedAmountFen : 0;
}

function orderRefundAmountFen(order) {
  const refundAmountFen = Number(order.refundAmountFen);
  if (!Number.isSafeInteger(refundAmountFen) || refundAmountFen <= 0) return orderAmountFen(order);
  return Math.min(refundAmountFen, orderAmountFen(order));
}

function orderPaidDateKey(order) {
  return dateKey(order.paidAt || order.createdAt);
}

function orderRefundDateKey(order) {
  const refundAt = order.refundSucceededAt || order.refundedAt;
  if (refundAt && order.paidAt && String(refundAt) === String(order.paidAt) && order.updatedAt) {
    return dateKey(order.updatedAt);
  }
  return dateKey(refundAt || order.updatedAt || order.createdAt);
}

async function adminDashboardStats(event) {
  await requireWebAdmin(event);
  const result = await db.collection("leqitong_orders").orderBy("createdAt", "desc").limit(500).get();
  const orders = result.data || [];
  const today = dateKey(new Date());
  const paidOrders = orders.filter(isPaidOrder);
  const refundedOrders = paidOrders.filter(isRefundedOrder);
  const activePaidOrders = paidOrders.filter((order) => !isRefundedOrder(order));
  const todayOrders = orders.filter((order) => dateKey(order.createdAt) === today);
  const paidTodayFen = paidOrders
    .filter((order) => orderPaidDateKey(order) === today)
    .reduce((sum, order) => sum + orderAmountFen(order), 0);
  const refundedTodayFen = refundedOrders
    .filter((order) => orderRefundDateKey(order) === today)
    .reduce((sum, order) => sum + orderRefundAmountFen(order), 0);
  const series = Array.from({ length: 7 }, (_, index) => {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - (6 - index));
    const key = dateKey(day);
    const dayOrders = orders.filter((order) => dateKey(order.createdAt) === key);
    const dayPaidFen = paidOrders
      .filter((order) => orderPaidDateKey(order) === key)
      .reduce((sum, order) => sum + orderAmountFen(order), 0);
    const dayRefundedFen = refundedOrders
      .filter((order) => orderRefundDateKey(order) === key)
      .reduce((sum, order) => sum + orderRefundAmountFen(order), 0);
    return { date: key.slice(5), orders: dayOrders.length, amount: Number(((dayPaidFen - dayRefundedFen) / 100).toFixed(2)) };
  });
  const serviceMap = {};
  activePaidOrders.forEach((order) => { const key = order.serviceName || "其他服务"; serviceMap[key] = (serviceMap[key] || 0) + 1; });
  const serviceBreakdown = Object.keys(serviceMap).map((name) => ({ name, value: serviceMap[name] })).sort((a, b) => b.value - a.value);
  const totalPaidFen = paidOrders.reduce((sum, order) => sum + orderAmountFen(order), 0);
  const totalRefundedFen = refundedOrders.reduce((sum, order) => sum + orderRefundAmountFen(order), 0);
  return {
    cards: {
      todayAmount: Number(((paidTodayFen - refundedTodayFen) / 100).toFixed(2)),
      todayOrders: todayOrders.length,
      totalAmount: Number(((totalPaidFen - totalRefundedFen) / 100).toFixed(2)),
      totalOrders: orders.length,
    },
    series,
    serviceBreakdown,
    pending: orders.filter((order) => ["pending_confirm", "processing"].includes(order.orderStatus)).slice(0, 8).map((item) => ({ ...item, id: item.id || item._id })),
    recent: orders.slice(0, 8).map((item) => ({ ...item, id: item.id || item._id })),
  };
}

async function adminCopyAudit(event) {
  const session = await requireWebAdmin(event);
  const field = String(event.field || "").trim();
  const orderId = String(event.orderId || "").trim();
  if (!field || !orderId) throw new Error("复制记录参数不完整");
  await db.collection("leqitong_admin_audits").add({ data: { action: "copy_sensitive_field", field, orderId, adminId: session.accountId, phone: session.phone, name: session.name, openid: context().OPENID, createdAt: nowText() } });
  return { ok: true };
}
async function login() { const wxContext = context(); return { openid: wxContext.OPENID, appid: wxContext.APPID, unionid: wxContext.UNIONID, isAdmin: await isAdmin() }; }

async function bindAdmin(event) {
  if (!isOwner()) throw new Error("只有老板可以绑定管理员");
  const bootstrapCode = process.env.LEQITONG_ADMIN_BOOTSTRAP_CODE || "";
  if (!bootstrapCode) throw new Error("管理员绑定码尚未配置");
  if (String(event.code || "").trim() !== bootstrapCode) throw new Error("管理员绑定码不正确");
  const openid = context().OPENID;
  const exists = await db.collection("leqitong_admins").where({ openid }).limit(1).get();
  if (!exists.data.length) {
    await db.collection("leqitong_admins").add({ data: { openid, role: "admin", enabled: true, createdAt: nowText(), updatedAt: nowText() } });
  } else {
    await db.collection("leqitong_admins").doc(exists.data[0]._id).update({ data: { role: "admin", enabled: true, updatedAt: nowText() } });
  }
  return { isAdmin: true, openid };
}

exports.main = async (event) => {
  const isXPayNotify = event && event.MsgType === "event" && typeof event.Event === "string" && event.Event.startsWith("xpay_");
  try {
    if (event && event.MsgType === "event" && event.Event === "xpay_goods_deliver_notify") {
      await handleVirtualGoodsNotify(event);
      return { ErrCode: 0, ErrMsg: "success" };
    }
    if (event && event.MsgType === "event" && event.Event === "xpay_refund_notify") {
      console.info("[xpay_refund_notify] received", {
        orderNo: String(event.MchOrderId || "").trim(),
        refundOrderId: String(event.MchRefundId || "").trim(),
        retCode: Number(event.RetCode),
        refundFee: Number(event.RefundFee || 0),
        eventEnv: event.Env == null ? null : Number(event.Env),
      });
      await handleVirtualRefundNotify(event);
      return { ErrCode: 0, ErrMsg: "success" };
    }
    const action = event.action;
    if (action === "login") return login();
    if (action === "checkAdmin") return accountAdminStatus(event);
    if (action === "adminLogin") return accountAdminLoginV2(event);
    if (action === "initializeAdminPassword") return initializeAdminPassword(event);
    if (action === "changeAdminPassword") return changeAdminPassword(event);
    if (action === "bindAdmin") return bindAdmin(event);
    if (action === "searchCompany") return searchCompany(event);
    if (action === "getAnnualReports") return getAnnualReports(event);
    if (action === "getServices") return getServices();
    if (action === "saveServices") return saveServices(event);
    if (action === "getAnnouncements") return getAnnouncements(event);
    if (action === "getAnnouncement") return getAnnouncement(event);
    if (action === "saveAnnouncement") return saveAnnouncement(event);
    if (action === "deleteAnnouncement") return deleteAnnouncement(event);
    if (action === "toggleAnnouncementVisible") return toggleAnnouncementVisible(event);
    if (action === "createOrder") return createOrder(event);
    if (action === "prepareVirtualPayment") return await prepareVirtualPayment(event);
    if (action === "reconcileVirtualPayOrder") return await reconcileVirtualPayOrder(event);
    if (action === "getMyOrders") return getMyOrders();
    if (action === "getOrder") return getOrder(event);
    if (action === "cancelMyOrder") return cancelMyOrder(event);
    if (action === "userConfirmPayment") return userConfirmPayment(event);
    if (action === "updateOrderExtra") return updateOrderExtra(event);
    if (action === "adminGetOrders") return adminGetOrders(event);
    if (action === "adminUpdateOrder") return adminUpdateOrder(event);
    if (action === "adminBulkUpdateOrderStatus") return adminBulkUpdateOrderStatus(event);
    if (action === "adminRequestVirtualRefund") return adminRequestVirtualRefund(event);
    if (action === "webAdminLogin") return webAdminLogin(event);
    if (action === "webAdminStatus") return webAdminStatus(event);
    if (action === "adminListUsers") return adminListUsers(event);
    if (action === "adminCreateUser") return adminCreateUser(event);
    if (action === "adminUpdateUser") return adminUpdateUser(event);
    if (action === "adminDeleteUser") return adminDeleteUser(event);
    if (action === "adminResetUserPassword") return adminResetUserPassword(event);
    if (action === "adminDashboardStats") return adminDashboardStats(event);
    if (action === "adminCopyAudit") return adminCopyAudit(event);
    return { ok: false, message: "unknown action" };
  } catch (error) {
    if (isXPayNotify) {
      console.error("Virtual payment notification failed", event.Event, error.message || "unknown error");
      return { ErrCode: 1, ErrMsg: "processing failed" };
    }
    console.error(error);
    return { ok: false, message: error.message || "云函数处理失败" };
  }
};
