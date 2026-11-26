const mock = require("./mock");

const ORDERS_KEY = "leqitong_orders";
const SERVICES_KEY = "leqitong_services";
const STAFF_CODES_KEY = "leqitong_staff_codes";
const ANNOUNCEMENTS_KEY = "leqitong_announcements";
const ANNOUNCEMENT_CACHE_KEY = "leqitong_announcement_detail_cache";
const COMPANY_CACHE_KEY = "leqitong_company_cache";
const LEGACY_PAYMENT_QR = "/images/payment-qr.svg";

function getCloudClient() {
  const app = getApp();
  return app && app.globalData && app.globalData.cloud || null;
}

function nowText() {
  const d = new Date();
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalizeOrder(order) {
  return {
    serviceStatus: "queued",
    staffVerifyResult: { ok: true, message: "旧订单未记录员工号校验结果" },
    legalVerifyResult: { ok: true, message: "旧订单未记录法人校验结果" },
    extraInfo: null,
    ...order,
    originalAmountText: order.originalAmountText || (Number.isFinite(Number(order.originalAmount || order.amount)) ? Number(order.originalAmount || order.amount).toFixed(2) : "0.00"),
    discountText: order.discountText || (Number.isFinite(Number(order.discountAmount)) ? Number(order.discountAmount).toFixed(2) : "0.00"),
    amountText: order.amountText || (Number.isFinite(Number(order.amount)) ? Number(order.amount).toFixed(2) : "0.00"),
  };
}

function resolvePaymentQrUrl(source) {
  const value = String(source || "").trim();
  // SVG was only a development placeholder. It is not reliable in a Mini Program image component.
  if (!value || value === LEGACY_PAYMENT_QR) {
    return Promise.resolve("");
  }
  if (!/^cloud:\/\//.test(value)) {
    return Promise.resolve(value);
  }
  const cloud = getCloudClient();
  if (!cloud || !cloud.getTempFileURL) {
    return Promise.resolve("");
  }
  return cloud.getTempFileURL({ fileList: [value] })
    .then((result) => {
      const item = result.fileList && result.fileList[0];
      return item && item.tempFileURL ? item.tempFileURL : "";
    })
    .catch(() => "");
}

function withPaymentQr(order, paymentQrUrl) {
  return {
    ...order,
    paymentQrUrl,
    paymentQrAvailable: Boolean(paymentQrUrl),
  };
}

function hydratePaymentQr(order) {
  const normalized = normalizeOrder(order || {});
  // Prefer the temporary URL produced by the cloud function. This avoids
  // Mini Program client-side file permission differences for cloud:// files.
  return resolvePaymentQrUrl(normalized.paymentQrUrl || normalized.paymentQrSnapshot)
    .then((paymentQrUrl) => {
      if (paymentQrUrl || !normalized.serviceId) {
        return withPaymentQr(normalized, paymentQrUrl);
      }
      // Orders created before a QR code was configured have an empty snapshot.
      // In that case, use the current service QR so the customer can still pay.
      return cloudGetServices()
        .then((services) => {
          const service = services.find((item) => item.id === normalized.serviceId);
          return resolvePaymentQrUrl(service && service.paymentQr);
        })
        .then((fallbackUrl) => withPaymentQr(normalized, fallbackUrl))
        .catch(() => withPaymentQr(normalized, ""));
    });
}

function getOrders() {
  return (wx.getStorageSync(ORDERS_KEY) || []).map(normalizeOrder);
}

function saveOrders(orders) {
  wx.setStorageSync(ORDERS_KEY, orders);
}

function getServices() {
  const stored = wx.getStorageSync(SERVICES_KEY);
  if (!stored) {
    return mock.services;
  }
  return stored.map((item) => {
    const base = mock.services.find((service) => service.id === item.id) || {};
    return {
      ...base,
      ...item,
      price: Number(item.price) > 0 ? Number(item.price) : Number(base.price || 0),
    };
  });
}

function saveServices(services) {
  wx.setStorageSync(SERVICES_KEY, services);
}

function getStaffCodes() {
  return wx.getStorageSync(STAFF_CODES_KEY) || mock.staffCodes;
}

function saveStaffCodes(staffCodes) {
  wx.setStorageSync(STAFF_CODES_KEY, staffCodes);
}

function normalizeAnnouncement(item, index = 0) {
  const publishedAt = item.publishedAt || `${item.date || nowText().slice(0, 10)} 09:00`;
  return {
    id: item.id || `notice_${Date.now()}_${index}`,
    title: item.title || "未命名公告",
    date: item.date || publishedAt.slice(0, 10),
    publishedAt,
    visible: item.visible !== false,
    content: item.content || "",
  };
}

function getAnnouncements(options = {}) {
  const source = wx.getStorageSync(ANNOUNCEMENTS_KEY) || mock.announcements;
  const list = source.map(normalizeAnnouncement);
  const filtered = options.includeHidden ? list : list.filter((item) => item.visible);
  return filtered.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

function saveAnnouncements(announcements) {
  wx.setStorageSync(ANNOUNCEMENTS_KEY, announcements.map(normalizeAnnouncement));
}

function getAnnouncementById(id, options = {}) {
  return getAnnouncements({ includeHidden: options.includeHidden }).find((item) => item.id === id);
}

function saveAnnouncement(data) {
  const list = getAnnouncements({ includeHidden: true });
  const normalized = normalizeAnnouncement({
    ...data,
    publishedAt: data.publishedAt || nowText(),
  });
  const exists = list.some((item) => item.id === normalized.id);
  const savedItem = exists
    ? normalized
    : { ...normalized, id: `notice_${Date.now()}` };
  const next = exists
    ? list.map((item) => (item.id === normalized.id ? savedItem : item))
    : [savedItem, ...list];
  saveAnnouncements(next);
  return savedItem;
}

function deleteAnnouncement(id) {
  const next = getAnnouncements({ includeHidden: true }).filter((item) => item.id !== id);
  saveAnnouncements(next);
}

function toggleAnnouncementVisible(id) {
  const list = getAnnouncements({ includeHidden: true });
  const next = list.map((item) => (item.id === id ? { ...item, visible: !item.visible } : item));
  saveAnnouncements(next);
  return getAnnouncementById(id, { includeHidden: true });
}

function verifyStaffCode(code) {
  const value = (code || "").trim();
  const staff = getStaffCodes().find((item) => item.code === value && item.enabled);
  return {
    ok: Boolean(staff),
    staff,
    message: staff ? "员工号校验通过" : "业务员工号不存在或已停用",
  };
}

function checkIdCard(idCardNo) {
  const value = String(idCardNo || "").trim();
  if (!/^\d{17}[\dXx]$/.test(value)) {
    return false;
  }
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = weights.reduce((total, weight, index) => total + Number(value.charAt(index)) * weight, 0);
  return value.charAt(17).toUpperCase() === codes[sum % 11];
}

function verifyLegalPerson(payload) {
  const idCardNo = String(payload.idCardNo || "").trim();
  if (!checkIdCard(idCardNo)) {
    return {
      ok: false,
      message: "身份证号码不正确",
    };
  }
  return {
    ok: true,
    provider: "mock",
    message: "法人身份格式校验通过，真实四要素接口待接入",
  };
}

function getCompanyByCreditCode(creditCode) {
  const cached = wx.getStorageSync(COMPANY_CACHE_KEY) || [];
  return cached.find((item) => item.creditCode === creditCode)
    || mock.companies.find((item) => item.creditCode === creditCode)
    || mock.companies[0];
}

function cloudCall(action, data = {}) {
  const cloud = getCloudClient();
  if (!cloud || !cloud.callFunction) {
    return Promise.reject(new Error("共享云环境不可用，请确认云环境已授权"));
  }
  return cloud.callFunction({
    name: "leqitong",
    data: { action, ...data },
  }).then((response) => {
    const result = response.result || {};
    if (result.ok === false) {
      return Promise.reject(new Error(result.message || "云函数处理失败"));
    }
    return result;
  });
}

function getWechatLoginCode() {
  return new Promise((resolve) => {
    if (!wx.login) return resolve("");
    wx.login({
      success: (result) => resolve(String(result.code || "")),
      fail: () => resolve(""),
    });
  });
}

function cacheCompanies(list) {
  if (Array.isArray(list) && list.length) {
    wx.setStorageSync(COMPANY_CACHE_KEY, list);
  }
  return list;
}

function cloudSearchCompanies(keyword) {
  const normalized = String(keyword || "").trim().replace(/[\s-]/g, "");
  const queryType = /^1[3-9]\d{9}$/.test(normalized) ? "phone" : "fuzzy";
  return cloudCall("searchCompany", { keyword, queryType }).then((result) => cacheCompanies(result.list || []));
}

function cloudGetAnnualReports(keyword, establishDate) {
  return cloudCall("getAnnualReports", { keyword, establishDate });
}

function cloudGetServices() {
  return cloudCall("getServices").then((result) => result.list || []);
}

function cloudGetAnnouncements(options = {}) {
  return cloudCall("getAnnouncements", options).then((result) => {
    const list = (result.list || []).map(normalizeCloudAnnouncement);
    if (!options.includeHidden && list.length) {
      wx.setStorageSync(ANNOUNCEMENT_CACHE_KEY, list);
    }
    return list;
  });
}

function cloudGetAnnouncementById(id) {
  return cloudCall("getAnnouncement", { id }).then((result) => {
    return result.item ? normalizeCloudAnnouncement(result.item) : null;
  });
}

function normalizeCloudAnnouncement(item) {
  const source = item || {};
  const fallback = mock.announcements.find((notice) => (
    String(notice.id || "") === String(source.id || source._id || "")
      || (notice.title && notice.title === source.title)
  ));
  const content = String(source.content || source.body || source.text || fallback && fallback.content || "").trim();
  return {
    ...source,
    id: source.id || source._id,
    content: content || "公告正文暂未配置",
  };
}

function getCachedAnnouncementById(id) {
  const list = wx.getStorageSync(ANNOUNCEMENT_CACHE_KEY) || [];
  const item = list.find((entry) => String(entry.id || entry._id) === String(id));
  return item ? normalizeCloudAnnouncement(item) : null;
}

function cloudCreateOrder(payload) {
  return getWechatLoginCode().then((loginCode) => cloudCall("createOrder", { order: payload, loginCode }))
    .then((result) => {
      const order = normalizeOrder({ ...result, id: result.id || result._id });
      if (result.payMode === "virtual") {
        if (result.pricingVersion !== 3 || !result.payData) {
          throw new Error("虚拟支付订单参数不完整，请检查云函数部署版本");
        }
        return { ok: true, payMode: "virtual", order, payData: result.payData };
      }
      if (result.pricingVersion !== 2) {
        throw new Error("云函数未更新扫码支付优惠金额逻辑，请重新部署 leqitong");
      }
      return hydratePaymentQr(order).then((hydratedOrder) => ({
        ok: true,
        payMode: "qrcode",
        qrcodeUrl: hydratedOrder.paymentQrUrl,
        order: hydratedOrder,
      }));
    });
}

function cloudGetMyOrders() {
  return cloudCall("getMyOrders")
    .then((result) => Promise.all((result.list || []).map(hydratePaymentQr)));
}

function cloudGetOrderById(id) {
  return cloudCall("getOrder", { id })
    .then((result) => {
      const order = { ...result, id: result.id || result._id };
      const initiatedAt = Date.parse(order.paymentInitiatedAt || "");
      const attemptIsStale = Number.isFinite(initiatedAt) && Date.now() - initiatedAt >= 15000;
      if (order.payMode === "virtual" && order.paymentStatus === "unpaid" && attemptIsStale) {
        return cloudCall("reconcileVirtualPayOrder", { id }).catch(() => order);
      }
      return order;
    })
    .then((order) => hydratePaymentQr({ ...order, id: order.id || order._id }));
}

function cloudReconcileVirtualPayOrder(id) {
  return cloudCall("reconcileVirtualPayOrder", { id })
    .then((order) => hydratePaymentQr({ ...order, id: order.id || order._id }));
}

function cloudPrepareVirtualPayment(id) {
  const runtime = virtualPaymentRuntimeInfo();
  if (runtime.platform === "ios" && !isIOSVirtualPaymentVersionSupported()) {
    return Promise.reject(new Error("iOS 虚拟支付要求微信客户端 8.0.68 及以上，请升级微信或联系工作人员"));
  }
  return getWechatLoginCode()
    .then((loginCode) => cloudCall("prepareVirtualPayment", { id, loginCode }))
    .then((payData) => {
      console.info("[virtual-payment] preparation result", {
        ...runtime,
        stateChanged: Boolean(payData && payData.stateChanged),
        hasSignData: Boolean(payData && payData.signData),
        hasPaySig: Boolean(payData && payData.paySig),
        hasSignature: Boolean(payData && payData.signature),
        mode: payData && payData.mode || "",
      });
      return payData;
    })
    .catch((error) => {
      console.error("[virtual-payment] preparation failed", {
        ...runtime,
        errCode: error && error.errCode,
        errMsg: error && (error.errMsg || error.message),
      });
      throw error;
    });
}

function virtualPaymentRuntimeInfo() {
  try {
    const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    return {
      platform: String(info.platform || "unknown").toLowerCase(),
      osVersion: info.system || "",
      wechatVersion: info.version || "",
      sdkVersion: info.SDKVersion || "",
    };
  } catch (error) {
    return { platform: "unknown" };
  }
}

function isIOSPlatform() {
  return virtualPaymentRuntimeInfo().platform === "ios";
}

function isIOSVirtualPaymentVersionSupported() {
  const runtime = virtualPaymentRuntimeInfo();
  if (runtime.platform !== "ios") return true;
  const version = String(runtime.wechatVersion || "").match(/\d+/g);
  if (!version || version.length < 3) return false;
  const actual = version.slice(0, 3).map(Number);
  const minimum = [8, 0, 68];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cloudStartVirtualPayment(id, payData) {
  const runtime = virtualPaymentRuntimeInfo();
  if (runtime.platform === "ios" && !isIOSVirtualPaymentVersionSupported()) {
    return Promise.reject(new Error("iOS 虚拟支付要求微信客户端 8.0.68 及以上，请升级微信或联系工作人员"));
  }
  const invokePayment = new Promise((resolve, reject) => {
    if (!wx.requestVirtualPayment) {
      console.error("[virtual-payment] wx.requestVirtualPayment is unavailable", runtime);
      reject(new Error("当前微信客户端不支持小程序虚拟支付"));
      return;
    }
    console.info("[virtual-payment] invoking wx.requestVirtualPayment", {
      ...runtime,
      hasSignData: Boolean(payData && payData.signData),
      hasPaySig: Boolean(payData && payData.paySig),
      hasSignature: Boolean(payData && payData.signature),
      mode: payData && payData.mode || "",
    });
    wx.requestVirtualPayment({
      ...payData,
      success: (result) => {
        console.info("[virtual-payment] wx.requestVirtualPayment succeeded", runtime);
        resolve(result);
      },
      fail: (error) => {
        console.error("[virtual-payment] wx.requestVirtualPayment failed", {
          ...runtime,
          errCode: error && error.errCode,
          errMsg: error && error.errMsg,
        });
        reject(error);
      },
    });
  });
  let requestError = null;
  return invokePayment.then(
    () => undefined,
    (error) => { requestError = error; },
  ).then(() => {
    const delays = [500, 1200, 2500];
    const query = (attempt) => cloudCall("reconcileVirtualPayOrder", { id }).then((order) => {
      if (order.virtualOrderFound === false || ["paid", "refunded", "cancelled"].includes(order.paymentStatus) || attempt >= delays.length) return order;
      return wait(delays[attempt]).then(() => query(attempt + 1));
    });
    return query(0).then((order) => {
      console.info("[virtual-payment] reconciliation result", {
        ...runtime,
        paymentStatus: order.paymentStatus || "unknown",
        requestFailed: Boolean(requestError),
      });
      return { order, requestError };
    }).catch((error) => {
      console.error("[virtual-payment] reconciliation failed", {
        ...runtime,
        requestErrCode: requestError && requestError.errCode,
        requestErrMsg: requestError && requestError.errMsg,
        reconcileErrMsg: error && (error.errMsg || error.message),
      });
      throw error;
    });
  });
}

function cloudConfirmPayment(id) {
  return cloudCall("userConfirmPayment", { id })
    .then((result) => hydratePaymentQr({ ...result, id: result.id || result._id }));
}

function cloudCancelMyOrder(id) {
  return cloudCall("cancelMyOrder", { id })
    .then((result) => hydratePaymentQr({ ...result, id: result.id || result._id }));
}

function cloudUpdateOrderExtra(id, extraInfo) {
  return cloudCall("updateOrderExtra", { id, extraInfo })
    .then((result) => normalizeOrder(result));
}

function searchCompanies(keyword) {
  const value = (keyword || "").trim();
  if (!value) {
    return [];
  }
  const isPhone = /^1\d{10}$/.test(value);
  const source = mock.companies.filter((item) => {
    if (isPhone) {
      return item.phone === value;
    }
    return item.name.includes(value) || item.legalPerson.includes(value) || item.creditCode.includes(value);
  });
  return source.length ? source : mock.companies;
}

function getAnnualReports() {
  return {
    businessStatus: "正常",
    reports: mock.annualReports,
    total: 13,
  };
}

function createOrder(payload) {
  const services = getServices();
  const service = services.find((item) => item.id === payload.serviceId) || services[0];
  const legalResult = verifyLegalPerson(payload);
  if (!legalResult.ok) {
    return {
      ok: false,
      message: legalResult.message,
    };
  }
  const order = {
    id: `order_${Date.now()}`,
    orderNo: `LEQITONG${Date.now()}`,
    company: payload.company,
    contactPhone: payload.contactPhone,
    idCardNo: payload.idCardNo,
    staffNo: payload.staffNo,
    annualReportSnapshot: payload.annualReportSnapshot,
    serviceId: service.id,
    serviceName: service.name,
    amount: Number(service.price || 0),
    paymentQrSnapshot: service.paymentQr || mock.defaultPaymentQr,
    payMode: "qrcode",
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
    serviceStatus: "queued",
    staffName: "",
    staffVerifyResult: { ok: true, message: "未进行业务员工号校验" },
    legalVerifyResult: legalResult,
    extraInfo: null,
    adminRemark: "",
    createdAt: nowText(),
    updatedAt: nowText(),
  };
  const orders = getOrders();
  orders.unshift(order);
  saveOrders(orders);
  return {
    ok: true,
    payMode: "qrcode",
    qrcodeUrl: order.paymentQrSnapshot,
    order,
  };
}

function getOrderById(id) {
  return getOrders().find((item) => item.id === id);
}

function updateOrderExtra(id, extraInfo) {
  return updateOrderRecord(id, { extraInfo });
}

function updateOrderRecord(id, data) {
  const orders = getOrders();
  const next = orders.map((item) => {
    if (item.id !== id) {
      return item;
    }
    return {
      ...item,
      ...data,
      updatedAt: nowText(),
    };
  });
  saveOrders(next);
  return getOrderById(id);
}

module.exports = {
  announcements: mock.announcements,
  advantages: mock.advantages,
  checkIdCard,
  cloudGetAnnualReports,
  cloudGetAnnouncements,
  cloudGetAnnouncementById,
  getCachedAnnouncementById,
  cloudGetMyOrders,
  cloudGetOrderById,
  cloudReconcileVirtualPayOrder,
  cloudPrepareVirtualPayment,
  cloudStartVirtualPayment,
  cloudConfirmPayment,
  cloudCancelMyOrder,
  cloudGetServices,
  isIOSPlatform,
  isIOSVirtualPaymentVersionSupported,
  cloudCreateOrder,
  cloudSearchCompanies,
  cloudUpdateOrderExtra,
  createOrder,
  deleteAnnouncement,
  getAnnualReports,
  getAnnouncementById,
  getAnnouncements,
  getCompanyByCreditCode,
  getOrderById,
  getOrders,
  getServices,
  getStaffCodes,
  normalizeAnnouncement,
  saveAnnouncement,
  saveAnnouncements,
  saveStaffCodes,
  saveServices,
  searchCompanies,
  toggleAnnouncementVisible,
  updateOrderExtra,
  verifyLegalPerson,
  verifyStaffCode,
};
