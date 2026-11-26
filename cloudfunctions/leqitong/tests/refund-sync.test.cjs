const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const functionPath = path.resolve(__dirname, "../index.js");
const functionSource = readFileSync(functionPath, "utf8");

function matches(document, filters) {
  return Object.entries(filters).every(([key, expected]) => {
    if (expected && typeof expected === "object" && Object.prototype.hasOwnProperty.call(expected, "exists")) {
      return Object.prototype.hasOwnProperty.call(document, key) === expected.exists;
    }
    return document[key] === expected;
  });
}

function createDatabase(seed, { reportModifiedCount = false } = {}) {
  const collections = new Map(Object.entries(seed).map(([name, records]) => [
    name,
    records.map((record) => ({ ...record })),
  ]));

  function recordsFor(name) {
    if (!collections.has(name)) collections.set(name, []);
    return collections.get(name);
  }

  class Query {
    constructor(name, filters = {}) {
      this.name = name;
      this.filters = filters;
      this.max = Infinity;
      this.sortField = "";
      this.sortDirection = "asc";
    }

    where(filters) {
      this.filters = { ...this.filters, ...filters };
      return this;
    }

    limit(value) {
      this.max = Number(value);
      return this;
    }

    orderBy(field, direction) {
      this.sortField = field;
      this.sortDirection = direction;
      return this;
    }

    async get() {
      let result = recordsFor(this.name).filter((record) => matches(record, this.filters));
      if (this.sortField) {
        const direction = this.sortDirection === "desc" ? -1 : 1;
        result = result.slice().sort((a, b) => String(a[this.sortField] || "").localeCompare(String(b[this.sortField] || "")) * direction);
      }
      return { data: result.slice(0, this.max).map((record) => ({ ...record })) };
    }

    async update({ data }) {
      const changed = recordsFor(this.name).filter((record) => matches(record, this.filters));
      let modified = 0;
      changed.forEach((record) => {
        const didChange = Object.entries(data).some(([key, value]) => record[key] !== value);
        if (didChange) modified += 1;
        Object.assign(record, data);
      });
      return { stats: { updated: reportModifiedCount ? modified : changed.length } };
    }
  }

  return {
    command: { exists: (exists) => ({ exists }) },
    collection(name) {
      return {
        where: (filters) => new Query(name, filters),
        orderBy: (field, direction) => new Query(name).orderBy(field, direction),
        async add({ data }) {
          const document = { ...data, _id: `${name}-${recordsFor(name).length + 1}` };
          recordsFor(name).push(document);
          return { _id: document._id };
        },
        doc(id) {
          return {
            async get() {
              const document = recordsFor(name).find((record) => record._id === id);
              if (!document) throw new Error(`Missing mock document: ${name}/${id}`);
              return { data: { ...document } };
            },
            async update({ data }) {
              const document = recordsFor(name).find((record) => record._id === id);
              if (!document) return { stats: { updated: 0 } };
              Object.assign(document, data);
              return { stats: { updated: 1 } };
            },
          };
        },
      };
    },
    recordsFor,
  };
}

function createHarness({ orders, queryOrders, queryErrors = [], services = [], onRefundRequest = null, onQueryOrder = null, onSessionExchange = null, reportModifiedCount = false, fixedNow = null, refundConfirmPassword = "test-only-refund-confirmation-password" }) {
  const database = createDatabase({
    leqitong_orders: orders,
    leqitong_services: services,
    leqitong_admin_sessions: [{
      _id: "session-1",
      token: "test-admin-token",
      openid: "admin-openid",
      accountId: "admin-1",
      enabled: true,
      expiresAt: Date.now() + 60_000,
    }],
    leqitong_admin_users: [{ _id: "admin-1", role: "admin", enabled: true }],
  }, { reportModifiedCount });
  const pendingPlatformOrders = queryOrders.slice();
  const pendingQueryErrors = queryErrors.slice();
  let refundRequestCount = 0;
  let main = null;
  const cloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-current-env",
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: "admin-openid", APPID: "test-appid" }),
  };
  const https = {
    request(target, options, onResponse) {
      const request = new EventEmitter();
      let body = "";
      request.write = (chunk) => { body += chunk; };
      request.setTimeout = () => request;
      request.destroy = (error) => request.emit("error", error);
      request.end = () => {
        Promise.resolve().then(async () => {
          const url = new URL(String(target));
          let payload;
          if (url.pathname === "/cgi-bin/stable_token") {
            payload = { access_token: "mock-access-token", expires_in: 7200 };
          } else if (url.pathname === "/sns/jscode2session") {
            if (onSessionExchange) await onSessionExchange(database, main);
            payload = { openid: "admin-openid", session_key: "mock-session-key" };
          } else if (url.pathname === "/xpay/query_order") {
            assert.equal(JSON.parse(body).order_id, orders[0].outTradeNo);
            const queryError = pendingQueryErrors.shift();
            payload = queryError
              ? { errcode: queryError.errcode, errmsg: queryError.errmsg || "mock query error" }
              : pendingPlatformOrders.shift();
            assert.ok(payload, "a mock query_order response must be queued");
            if (onQueryOrder) await onQueryOrder(payload, main);
          } else if (url.pathname === "/xpay/refund_order") {
            refundRequestCount += 1;
            const refundRequest = JSON.parse(body);
            if (onRefundRequest) await onRefundRequest(refundRequest, main);
            payload = {
              errcode: 0,
              refund_order_id: refundRequest.refund_order_id,
              refund_wx_order_id: "wx-refund-race",
              pay_wx_order_id: "wx-order-1",
            };
          } else {
            throw new Error(`Unexpected mocked WeChat endpoint: ${url.pathname}`);
          }
          const response = new EventEmitter();
          response.statusCode = 200;
          response.setEncoding = () => {};
          onResponse(response);
          response.emit("data", JSON.stringify(payload));
          response.emit("end");
        }).catch((error) => request.emit("error", error));
      };
      return request;
    },
  };
  const mockRequire = (name) => {
    if (name === "wx-server-sdk") return cloud;
    if (name === "https") return https;
    if (name === "crypto" || name === "querystring") return require(name);
    throw new Error(`Unexpected require in cloud function test: ${name}`);
  };
  const RuntimeDate = fixedNow == null ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  const sandbox = {
    exports: {},
    require: mockRequire,
    process: {
      env: {
        LEQITONG_VPAY_ENABLED: "true",
        LEQITONG_VPAY_ENV: "0",
        LEQITONG_VPAY_APP_KEY: "mock-app-key",
        LEQITONG_VPAY_OFFER_ID: "mock-offer-id",
        LEQITONG_WECHAT_APP_SECRET: "mock-app-secret",
        LEQITONG_REFUND_CONFIRM_PASSWORD: refundConfirmPassword,
      },
    },
    Buffer,
    URL,
    Intl,
    Date: RuntimeDate,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(functionSource, sandbox, { filename: functionPath });
  main = sandbox.exports.main;
  return { main, database, pendingPlatformOrders, get refundRequestCount() { return refundRequestCount; } };
}

function platformOrder(order, status) {
  return {
    order: {
      order_id: order.outTradeNo,
      openid: order.openid,
      status,
      order_type: 1,
      order_fee: order.amountFen,
      paid_fee: order.amountFen,
      refund_fee: status >= 5 ? order.amountFen : 0,
      left_fee: status >= 5 ? 0 : order.amountFen,
      paid_time: Math.floor(Date.now() / 1000),
      wx_order_id: "wx-order-1",
      wxpay_order_id: "wx-transaction-1",
    },
  };
}

test("微信查无虚拟支付订单时允许后台取消，释放改价限制，迟到的支付确认会恢复订单", async () => {
  const order = {
    _id: "order-ios-payment-failed",
    orderNo: "LQT-IOS-PAYMENT-FAILED",
    outTradeNo: "LQT-IOS-PAYMENT-FAILED",
    openid: "buyer-openid",
    serviceId: "annual_1",
    serviceName: "一年期年报补录",
    payMode: "virtual",
    virtualEnv: 0,
    virtualProductId: "annual_1",
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
    amount: 298,
    amountFen: 29800,
    paymentInitiatedAt: new Date().toISOString(),
  };
  const service = {
    _id: "service-annual-1",
    id: "annual_1",
    name: "一年期年报补录",
    price: 298,
    priceFen: 29800,
    virtualProductId: "annual_1",
    virtualPriceFen: 29800,
    enabled: true,
  };
  const harness = createHarness({
    orders: [order],
    services: [service],
    queryOrders: [
      { errcode: 268490002, errmsg: "数据不存在" },
      platformOrder(order, 3),
    ],
  });

  const cancelled = await harness.main({
    action: "adminUpdateOrder",
    id: order._id,
    data: { orderStatus: "cancelled" },
    adminToken: "test-admin-token",
  });
  assert.equal(cancelled.paymentStatus, "cancelled");
  assert.equal(cancelled.orderStatus, "cancelled");

  await harness.main({
    action: "saveServices",
    adminToken: "test-admin-token",
    services: [{ ...service, price: 398, virtualPriceFen: 39800 }],
  });
  assert.equal(harness.database.recordsFor("leqitong_services")[0].price, 398);

  const recovered = await harness.main({
    action: "reconcileVirtualPayOrder",
    id: order._id,
    adminToken: "test-admin-token",
  });
  assert.equal(recovered.paymentStatus, "paid");
  assert.equal(recovered.orderStatus, "pending_confirm");
  assert.equal(recovered.serviceStatus, "queued");
  assert.equal(recovered.amountFen, 29800, "late payment keeps the original order amount snapshot");
});

test("微信订单仍未关闭时拒绝取消且保留改价限制", async () => {
  const order = {
    _id: "order-ios-payment-active",
    orderNo: "LQT-IOS-PAYMENT-ACTIVE",
    outTradeNo: "LQT-IOS-PAYMENT-ACTIVE",
    openid: "buyer-openid",
    serviceId: "annual_1",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
    amount: 298,
    amountFen: 29800,
    paymentInitiatedAt: new Date().toISOString(),
  };
  const service = {
    _id: "service-annual-1",
    id: "annual_1",
    price: 298,
    priceFen: 29800,
    virtualProductId: "annual_1",
    virtualPriceFen: 29800,
    enabled: true,
  };
  const harness = createHarness({
    orders: [order],
    services: [service],
    queryOrders: [platformOrder(order, 1)],
  });

  const cancelResult = await harness.main({
    action: "adminUpdateOrder",
    id: order._id,
    data: { orderStatus: "cancelled" },
    adminToken: "test-admin-token",
  }).catch((error) => error);
  assert.match(cancelResult.message, /尚未关闭/);
  assert.equal(harness.database.recordsFor("leqitong_orders")[0].paymentStatus, "unpaid");
  assert.equal(harness.database.recordsFor("leqitong_orders")[0].orderStatus, "pending_payment");

  const saveResult = await harness.main({
    action: "saveServices",
    adminToken: "test-admin-token",
    services: [{ ...service, price: 398, virtualPriceFen: 39800 }],
  }).catch((error) => error);
  assert.match(saveResult.message, /未支付的虚拟支付订单/);
  assert.equal(harness.database.recordsFor("leqitong_services")[0].price, 298);
});

test("微信查单提示数据不存在时保留未支付订单并允许用户重试", async () => {
  const order = {
    _id: "order-no-platform-record",
    orderNo: "LQT-NO-PLATFORM-RECORD",
    outTradeNo: "LQT-NO-PLATFORM-RECORD",
    openid: "buyer-openid",
    serviceId: "annual_1",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
    amount: 298,
    amountFen: 29800,
  };
  const harness = createHarness({
    orders: [order],
    queryOrders: [],
    queryErrors: [{ errcode: 268490002, errmsg: "data not found" }],
  });

  const result = await harness.main({
    action: "reconcileVirtualPayOrder",
    id: order._id,
    adminToken: "test-admin-token",
  });

  assert.equal(result.paymentStatus, "unpaid");
  assert.equal(result.orderStatus, "pending_payment");
  assert.equal(result.virtualOrderFound, false);
  assert.equal(harness.database.recordsFor("leqitong_orders")[0].paymentStatus, "unpaid");
  assert.equal(harness.database.recordsFor("leqitong_orders")[0].orderStatus, "pending_payment");
});

for (const latestStatus of [
  { name: "cancelled", paymentStatus: "cancelled", orderStatus: "cancelled" },
  { name: "paid", paymentStatus: "paid", orderStatus: "pending_confirm" },
]) {
  test(`准备虚拟支付期间订单变为${latestStatus.name}，返回最新状态而不生成支付参数`, async () => {
    const order = {
      _id: `order-prepare-race-${latestStatus.name}`,
      orderNo: `LQT-PREPARE-RACE-${latestStatus.name}`,
      outTradeNo: `LQT-PREPARE-RACE-${latestStatus.name}`,
      openid: "admin-openid",
      payMode: "virtual",
      virtualEnv: 0,
      virtualOfferId: "mock-offer-id",
      virtualProductId: "annual_1",
      paymentStatus: "unpaid",
      orderStatus: "pending_payment",
      amountFen: 29800,
    };
    const harness = createHarness({
      orders: [order],
      queryOrders: [],
      onSessionExchange: async (database) => {
        Object.assign(database.recordsFor("leqitong_orders")[0], {
          paymentStatus: latestStatus.paymentStatus,
          orderStatus: latestStatus.orderStatus,
        });
      },
    });

    const result = await harness.main({
      action: "prepareVirtualPayment",
      id: order._id,
      loginCode: "mock-login-code",
    });

    assert.equal(result.stateChanged, true);
    assert.equal(result.order.paymentStatus, latestStatus.paymentStatus);
    assert.equal(result.order.orderStatus, latestStatus.orderStatus);
    assert.equal(Object.hasOwn(result, "payData"), false);
    assert.equal(Object.hasOwn(harness.database.recordsFor("leqitong_orders")[0], "paymentInitiatedAt"), false);
  });
}

test("同一分钟重复准备支付时，未变化的分钟时间不会被误判为订单状态变化", async () => {
  const sameMinute = "2026-10-31 02:13";
  const order = {
    _id: "order-prepare-same-minute",
    orderNo: "LQT-PREPARE-SAME-MINUTE",
    outTradeNo: "LQT-PREPARE-SAME-MINUTE",
    openid: "admin-openid",
    payMode: "virtual",
    virtualEnv: 0,
    virtualOfferId: "mock-offer-id",
    virtualProductId: "annual_1",
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
    amountFen: 29800,
    paymentInitiatedAt: sameMinute,
    updatedAt: sameMinute,
  };
  const harness = createHarness({
    orders: [order],
    queryOrders: [],
    reportModifiedCount: true,
    fixedNow: Date.UTC(2026, 9, 30, 18, 13, 49),
  });

  const result = await harness.main({
    action: "prepareVirtualPayment",
    id: order._id,
    loginCode: "mock-login-code",
  });

  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(result.stateChanged, undefined);
  assert.equal(typeof result.signData, "string");
  assert.match(stored.paymentInitiatedAt, /^2026-10-30T18:13:49\.000Z$/);
  assert.match(stored.paymentPrepareId, /^[a-f0-9]{24}$/);
  assert.equal(stored.paymentStatus, "unpaid");
  assert.equal(stored.orderStatus, "pending_payment");
});

test("虚拟支付准备异常由云函数入口捕获并返回业务错误", async () => {
  const order = {
    _id: "order-prepare-invalid-login-code",
    orderNo: "LQT-PREPARE-INVALID-CODE",
    openid: "admin-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
  };
  const harness = createHarness({ orders: [order], queryOrders: [] });

  const result = await harness.main({
    action: "prepareVirtualPayment",
    id: order._id,
    loginCode: "",
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /无法获取微信登录凭证/);
});

test("后台读取不触发退款查单，手动查询会同步退款并扣减净收入", async () => {
  const createdAt = new Date().toISOString();
  const refundingOrder = {
    _id: "order-refund",
    orderNo: "LQT-REFUND-1",
    outTradeNo: "LQT-REFUND-1",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "pending_confirm",
    amount: 298,
    amountFen: 29800,
    paymentAmountFen: 29800,
    paidAt: createdAt,
    createdAt,
    refundStatus: "processing",
    refundAttemptId: "merchant-refund-1",
    refundMchRefundId: "merchant-refund-1",
    refundAttemptAmountFen: 29800,
    refundAmountFen: 29800,
    refundRequestedAt: createdAt,
  };
  const keptOrder = {
    _id: "order-kept",
    orderNo: "LQT-PAID-2",
    outTradeNo: "LQT-PAID-2",
    openid: "another-buyer",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "pending_confirm",
    amount: 398,
    amountFen: 39800,
    paymentAmountFen: 39800,
    paidAt: createdAt,
    createdAt,
  };
  const harness = createHarness({
    orders: [refundingOrder, keptOrder],
    queryOrders: [
      platformOrder(refundingOrder, 5),
      platformOrder(refundingOrder, 8),
    ],
  });
  let stored = harness.database.recordsFor("leqitong_orders").find((item) => item._id === refundingOrder._id);
  assert.equal(stored.refundStatus, "processing");
  assert.equal(stored.paymentStatus, "paid");
  assert.equal(stored.orderStatus, "pending_confirm");

  const ordersResult = await harness.main({ action: "adminGetOrders", adminToken: "test-admin-token" });
  const pendingStats = await harness.main({ action: "adminDashboardStats", adminToken: "test-admin-token" });
  assert.equal(ordersResult.list[0].refundStatus, "processing");
  assert.equal(harness.pendingPlatformOrders.length, 2, "opening the order list and dashboard must not call WeChat");
  stored = harness.database.recordsFor("leqitong_orders").find((item) => item._id === refundingOrder._id);
  assert.equal(stored.paymentStatus, "paid", "refund status 5 must remain pending, not be marked refunded");
  assert.equal(pendingStats.cards.totalAmount, 696, "pending refunds must remain in collected revenue");

  const pendingOrder = await harness.main({ action: "reconcileVirtualPayOrder", id: refundingOrder._id, adminToken: "test-admin-token" });
  assert.equal(pendingOrder.refundStatus, "processing");
  const finalOrder = await harness.main({ action: "reconcileVirtualPayOrder", id: refundingOrder._id, adminToken: "test-admin-token" });
  const finalStats = await harness.main({ action: "adminDashboardStats", adminToken: "test-admin-token" });
  stored = harness.database.recordsFor("leqitong_orders").find((item) => item._id === refundingOrder._id);
  assert.equal(finalOrder.refundStatus, "succeeded");
  assert.equal(stored.paymentStatus, "refunded");
  assert.equal(stored.orderStatus, "refunded");
  assert.equal(stored.refundStatus, "succeeded");
  assert.equal(stored.refundAmountFen, 29800);
  assert.equal(stored.refundMchRefundId, "merchant-refund-1");
  assert.equal(stored.paymentVerifySource, "query_order");
  assert.equal(harness.pendingPlatformOrders.length, 0);
  assert.equal(finalStats.cards.totalAmount, 398, "successful refunds must be subtracted from cumulative net revenue");
  assert.equal(finalStats.cards.todayAmount, 398, "successful refunds must be subtracted from today's net revenue");
  assert.equal(finalStats.series[6].amount, 398, "successful refunds must be subtracted from the latest daily chart value");
  assert.equal(finalStats.serviceBreakdown.length, 1, "refunded orders must leave the paid service breakdown");
});

test("a pending WeChat refund query must not write a stale processing state", async () => {
  const checkedAt = "2026-10-30T12:00:00.000Z";
  const order = {
    _id: "order-refund-pending-read-only",
    orderNo: "LQT-REFUND-PENDING-READ-ONLY",
    outTradeNo: "LQT-REFUND-PENDING-READ-ONLY",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "pending_confirm",
    amount: 1,
    amountFen: 100,
    paymentAmountFen: 100,
    paidAt: checkedAt,
    createdAt: checkedAt,
    refundStatus: "processing",
    refundAttemptId: "merchant-refund-pending-read-only",
    refundMchRefundId: "merchant-refund-pending-read-only",
    refundAttemptAmountFen: 100,
    refundAmountFen: 100,
    paymentCheckedAt: checkedAt,
    paymentVerifySource: "refund_request",
  };
  const harness = createHarness({
    orders: [order],
    queryOrders: [platformOrder(order, 5)],
  });

  const result = await harness.main({ action: "reconcileVirtualPayOrder", id: order._id, adminToken: "test-admin-token" });
  const stored = harness.database.recordsFor("leqitong_orders")[0];

  assert.equal(result.refundStatus, "processing");
  assert.equal(stored.refundStatus, "processing");
  assert.equal(stored.paymentCheckedAt, checkedAt);
  assert.equal(stored.paymentVerifySource, "refund_request");
  assert.equal(harness.pendingPlatformOrders.length, 0);
});

test("refresh after a confirmed refund must return the final state without another WeChat query", async () => {
  const refundedAt = "2026-10-30T12:00:00.000Z";
  const order = {
    _id: "order-refund-refresh-after-success",
    orderNo: "LQT-REFUND-REFRESH-AFTER-SUCCESS",
    outTradeNo: "LQT-REFUND-REFRESH-AFTER-SUCCESS",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "refunded",
    orderStatus: "refunded",
    amount: 1,
    amountFen: 100,
    paymentAmountFen: 100,
    paidAt: refundedAt,
    createdAt: refundedAt,
    refundStatus: "succeeded",
    refundSucceededAt: refundedAt,
    refundedAt,
    refundNotifyAt: refundedAt,
    refundNotifyRetCode: 0,
  };
  const harness = createHarness({
    orders: [order],
    queryOrders: [platformOrder(order, 5)],
  });

  const result = await harness.main({ action: "reconcileVirtualPayOrder", id: order._id, adminToken: "test-admin-token" });
  const stored = harness.database.recordsFor("leqitong_orders")[0];

  assert.equal(result.paymentStatus, "refunded");
  assert.equal(result.orderStatus, "refunded");
  assert.equal(result.refundStatus, "succeeded");
  assert.equal(stored.refundStatus, "succeeded");
  assert.equal(harness.pendingPlatformOrders.length, 1);
});

test("退款成功通知直接将订单置为已退款", async () => {
  const createdAt = new Date().toISOString();
  const order = {
    _id: "order-notify-success",
    orderNo: "LQT-REFUND-NOTIFY",
    outTradeNo: "LQT-REFUND-NOTIFY",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "processing",
    amount: 298,
    amountFen: 29800,
    paymentAmountFen: 29800,
    paidAt: createdAt,
    createdAt,
    refundStatus: "processing",
    refundAttemptId: "merchant-refund-notify-success",
    refundMchRefundId: "merchant-refund-notify-success",
    refundAttemptAmountFen: 29800,
    refundAmountFen: 29800,
    refundRequestedAt: createdAt,
  };
  const harness = createHarness({ orders: [order], queryOrders: [] });
  const result = await harness.main({
    MsgType: "event",
    Event: "xpay_refund_notify",
    MchOrderId: order.outTradeNo,
    OpenId: order.openid,
    Env: 0,
    RetCode: 0,
    WxOrderId: "wx-order-1",
    WxRefundId: "wx-refund-notify-success",
    MchRefundId: "merchant-refund-notify-success",
    RefundFee: order.amountFen,
    RefundSuccTimestamp: Math.floor(Date.now() / 1000),
  });

  assert.equal(result.ErrCode, 0);
  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(stored.paymentStatus, "refunded");
  assert.equal(stored.orderStatus, "refunded");
  assert.equal(stored.refundStatus, "succeeded");
  assert.equal(stored.refundWxRefundId, "wx-refund-notify-success");
});

test("退款通知未提供 Env 时仍按订单环境直接同步退款", async () => {
  const createdAt = new Date().toISOString();
  const order = {
    _id: "order-refund-without-env",
    orderNo: "LQT-REFUND-NO-ENV",
    outTradeNo: "LQT-REFUND-NO-ENV",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "processing",
    amount: 1,
    amountFen: 1,
    paymentAmountFen: 1,
    paidAt: createdAt,
    createdAt,
    refundStatus: "processing",
    refundAttemptId: "merchant-refund-no-env",
    refundMchRefundId: "merchant-refund-no-env",
    refundAttemptAmountFen: 1,
  };
  const harness = createHarness({ orders: [order], queryOrders: [] });
  const result = await harness.main({
    MsgType: "event",
    Event: "xpay_refund_notify",
    MchOrderId: order.outTradeNo,
    OpenId: order.openid,
    RetCode: 0,
    WxOrderId: "wx-order-1",
    WxRefundId: "wx-refund-no-env",
    MchRefundId: "merchant-refund-no-env",
    RefundFee: order.amountFen,
  });

  assert.equal(result.ErrCode, 0);
  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(stored.paymentStatus, "refunded");
  assert.equal(stored.refundStatus, "succeeded");
  assert.equal(stored.refundWxRefundId, "wx-refund-no-env");
});

test("退款通知显式携带错误 Env 时仍拒绝处理", async () => {
  const createdAt = new Date().toISOString();
  const order = {
    _id: "order-refund-wrong-env",
    orderNo: "LQT-REFUND-WRONG-ENV",
    outTradeNo: "LQT-REFUND-WRONG-ENV",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "processing",
    amount: 1,
    amountFen: 1,
    paymentAmountFen: 1,
    paidAt: createdAt,
    createdAt,
    refundStatus: "processing",
    refundAttemptId: "merchant-refund-wrong-env",
    refundMchRefundId: "merchant-refund-wrong-env",
    refundAttemptAmountFen: 1,
  };
  const harness = createHarness({ orders: [order], queryOrders: [] });
  const result = await harness.main({
    MsgType: "event",
    Event: "xpay_refund_notify",
    MchOrderId: order.outTradeNo,
    OpenId: order.openid,
    Env: 1,
    RetCode: 0,
    RefundFee: order.amountFen,
  });

  assert.equal(result.ErrCode, 1);
  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(stored.paymentStatus, "paid");
  assert.equal(stored.refundStatus, "processing");
  assert.equal(stored.paymentCheckedAt, undefined);
});

test("原支付单仍显示状态5时，以成功退款回调为准直接更新已退款", async () => {
  const createdAt = new Date().toISOString();
  const order = {
    _id: "order-refund-pending-fee",
    orderNo: "LQT-REFUND-PENDING-FEE",
    outTradeNo: "LQT-REFUND-PENDING-FEE",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "processing",
    amount: 0.01,
    amountFen: 1,
    paymentAmountFen: 1,
    paidAt: createdAt,
    createdAt,
    refundStatus: "requesting",
    refundAttemptId: "merchant-refund-pending-fee",
    refundMchRefundId: "merchant-refund-pending-fee",
    refundAttemptAmountFen: 1,
  };
  const pendingOrder = platformOrder(order, 5);
  pendingOrder.order.refund_fee = 0;
  const harness = createHarness({
    orders: [order],
    queryOrders: [pendingOrder],
  });
  const result = await harness.main({
    MsgType: "event",
    Event: "xpay_refund_notify",
    MchOrderId: order.outTradeNo,
    MchRefundId: "merchant-refund-pending-fee",
    OpenId: order.openid,
    RetCode: 0,
    RefundFee: 1,
  });

  assert.equal(result.ErrCode, 0);
  let stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(stored.paymentStatus, "refunded");
  assert.equal(stored.refundStatus, "succeeded");
  assert.equal(stored.refundAmountFen, 1);
  assert.equal(harness.pendingPlatformOrders.length, 1, "success callback handling must not query the stale payment order");
  await harness.main({ action: "adminDashboardStats", adminToken: "test-admin-token" });
  stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(stored.paymentStatus, "refunded");
  assert.equal(stored.refundStatus, "succeeded");
});

test("退款回调金额与本地退款申请金额不一致时不更新订单", async () => {
  const createdAt = new Date().toISOString();
  const order = {
    _id: "order-refund-success-wrong-fee",
    orderNo: "LQT-REFUND-SUCCESS-WRONG-FEE",
    outTradeNo: "LQT-REFUND-SUCCESS-WRONG-FEE",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "processing",
    amount: 0.01,
    amountFen: 1,
    paymentAmountFen: 1,
    paidAt: createdAt,
    createdAt,
    refundStatus: "processing",
    refundAttemptId: "merchant-refund-wrong-fee",
    refundMchRefundId: "merchant-refund-wrong-fee",
    refundAttemptAmountFen: 1,
  };
  const harness = createHarness({ orders: [order], queryOrders: [] });
  const result = await harness.main({
    MsgType: "event",
    Event: "xpay_refund_notify",
    MchOrderId: order.outTradeNo,
    MchRefundId: "merchant-refund-wrong-fee",
    OpenId: order.openid,
    RetCode: 0,
    RefundFee: 2,
  });

  assert.equal(result.ErrCode, 1);
  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(stored.paymentStatus, "paid");
  assert.equal(stored.refundStatus, "processing");
  assert.equal(stored.paymentCheckedAt, undefined);
});

test("退款失败通知保留已支付状态并标记退款失败", async () => {
  const createdAt = new Date().toISOString();
  const order = {
    _id: "order-refund-failed",
    orderNo: "LQT-REFUND-FAILED",
    outTradeNo: "LQT-REFUND-FAILED",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "pending_confirm",
    amount: 298,
    amountFen: 29800,
    paymentAmountFen: 29800,
    paidAt: createdAt,
    createdAt,
    refundStatus: "processing",
    refundAttemptId: "merchant-refund-failed",
    refundMchRefundId: "merchant-refund-failed",
    refundAttemptAmountFen: 29800,
    refundAmountFen: 29800,
  };
  const harness = createHarness({ orders: [order], queryOrders: [] });
  const result = await harness.main({
    MsgType: "event",
    Event: "xpay_refund_notify",
    MchOrderId: order.outTradeNo,
    MchRefundId: "merchant-refund-failed",
    OpenId: order.openid,
    RetCode: 123,
    RetMsg: "refund rejected",
    RefundFee: order.amountFen,
  });

  assert.equal(result.ErrCode, 0);
  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(stored.paymentStatus, "paid");
  assert.equal(stored.orderStatus, "pending_confirm");
  assert.equal(stored.refundStatus, "failed");
  assert.equal(stored.refundFailureCode, 123);
  assert.equal(stored.refundFailureMessage, "refund rejected");
});

test("旧退款回调不能覆盖当前退款尝试", async () => {
  const createdAt = new Date().toISOString();
  const order = {
    _id: "order-refund-stale-callback",
    orderNo: "LQT-REFUND-STALE",
    outTradeNo: "LQT-REFUND-STALE",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "pending_confirm",
    amount: 298,
    amountFen: 29800,
    paymentAmountFen: 29800,
    paidAt: createdAt,
    createdAt,
    refundStatus: "processing",
    refundAttemptId: "merchant-refund-current",
    refundMchRefundId: "merchant-refund-current",
    refundAttemptAmountFen: 29800,
    refundAmountFen: 29800,
  };
  const harness = createHarness({ orders: [order], queryOrders: [] });
  const result = await harness.main({
    MsgType: "event",
    Event: "xpay_refund_notify",
    MchOrderId: order.outTradeNo,
    MchRefundId: "merchant-refund-previous",
    OpenId: order.openid,
    RetCode: 0,
    RefundFee: order.amountFen,
  });

  assert.equal(result.ErrCode, 0);
  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(stored.paymentStatus, "paid");
  assert.equal(stored.refundStatus, "processing");
  assert.equal(stored.refundAttemptId, "merchant-refund-current");
});

test("后台退款确认密码错误时不查询或提交微信退款", async () => {
  const order = {
    _id: "order-refund-password-check",
    orderNo: "LQT-REFUND-PASSWORD-CHECK",
    outTradeNo: "LQT-REFUND-PASSWORD-CHECK",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "pending_confirm",
    amount: 1,
    amountFen: 100,
    paidAt: new Date().toISOString(),
  };
  const harness = createHarness({ orders: [order], queryOrders: [] });

  await assert.rejects(harness.main({
    action: "adminRequestVirtualRefund",
    id: order._id,
    adminToken: "test-admin-token",
    refundConfirmPassword: "wrong-password",
  }), /退款确认密码错误/);

  assert.equal(harness.pendingPlatformOrders.length, 0);
  assert.equal(harness.refundRequestCount, 0);
  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(stored.paymentStatus, "paid");
  assert.equal(stored.refundStatus, undefined);
});

test("未配置退款确认密码时默认拒绝发起退款", async () => {
  const order = {
    _id: "order-refund-password-unconfigured",
    orderNo: "LQT-REFUND-PASSWORD-UNCONFIGURED",
    outTradeNo: "LQT-REFUND-PASSWORD-UNCONFIGURED",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "pending_confirm",
    amount: 1,
    amountFen: 100,
    paidAt: new Date().toISOString(),
  };
  const harness = createHarness({ orders: [order], queryOrders: [], refundConfirmPassword: "" });

  await assert.rejects(harness.main({
    action: "adminRequestVirtualRefund",
    id: order._id,
    adminToken: "test-admin-token",
    refundConfirmPassword: "test-only-refund-confirmation-password",
  }), /云函数未配置退款确认密码/);

  assert.equal(harness.pendingPlatformOrders.length, 0);
  assert.equal(harness.refundRequestCount, 0);
});

test("退款回调先于退款接口响应到达时不会被接口响应覆盖", async () => {
  const createdAt = new Date().toISOString();
  const order = {
    _id: "order-refund-response-race",
    orderNo: "LQT-REFUND-RACE",
    outTradeNo: "LQT-REFUND-RACE",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "pending_confirm",
    amount: 1,
    amountFen: 100,
    paymentAmountFen: 100,
    paidAt: createdAt,
    createdAt,
  };
  const harness = createHarness({
    orders: [order],
    queryOrders: [platformOrder(order, 4)],
    onRefundRequest: async (request, main) => {
      const notifyResult = await main({
        MsgType: "event",
        Event: "xpay_refund_notify",
        MchOrderId: order.outTradeNo,
        MchRefundId: request.refund_order_id,
        OpenId: order.openid,
        Env: 0,
        RetCode: 0,
        RefundFee: request.refund_fee,
        RefundSuccTimestamp: Math.floor(Date.now() / 1000),
      });
      assert.equal(notifyResult.ErrCode, 0);
      throw new Error("simulated lost refund API response after successful callback");
    },
  });

  const result = await harness.main({
    action: "adminRequestVirtualRefund",
    id: order._id,
    adminToken: "test-admin-token",
    refundConfirmPassword: "test-only-refund-confirmation-password",
  });

  assert.equal(result.order.paymentStatus, "refunded");
  assert.equal(result.order.orderStatus, "refunded");
  assert.equal(result.order.refundStatus, "succeeded");
  assert.equal(result.order.refundMchRefundId, result.order.refundAttemptId);
  assert.equal(result.message, "微信已确认退款成功");
});

test("查单返回旧的处理中状态时不能覆盖并发到达的成功退款回调", async () => {
  const createdAt = new Date().toISOString();
  const order = {
    _id: "order-refund-query-race",
    orderNo: "LQT-REFUND-QUERY-RACE",
    outTradeNo: "LQT-REFUND-QUERY-RACE",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "pending_confirm",
    amount: 1,
    amountFen: 100,
    paymentAmountFen: 100,
    paidAt: createdAt,
    createdAt,
    refundStatus: "processing",
    refundAttemptId: "merchant-refund-query-race",
    refundMchRefundId: "merchant-refund-query-race",
    refundAttemptAmountFen: 100,
    refundAmountFen: 100,
  };
  const harness = createHarness({
    orders: [order],
    queryOrders: [platformOrder(order, 5)],
    onQueryOrder: async (_response, main) => {
      const notifyResult = await main({
        MsgType: "event",
        Event: "xpay_refund_notify",
        MchOrderId: order.outTradeNo,
        MchRefundId: order.refundAttemptId,
        OpenId: order.openid,
        RetCode: 0,
        RefundFee: order.amountFen,
        RefundSuccTimestamp: Math.floor(Date.now() / 1000),
      });
      assert.equal(notifyResult.ErrCode, 0);
    },
  });

  const result = await harness.main({ action: "reconcileVirtualPayOrder", id: order._id, adminToken: "test-admin-token" });
  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(result.paymentStatus, "refunded");
  assert.equal(result.refundStatus, "succeeded");
  assert.equal(stored.paymentStatus, "refunded");
  assert.equal(stored.orderStatus, "refunded");
  assert.equal(stored.refundStatus, "succeeded");
});

test("成功退款通知记录存在但状态不一致时自动修复为已退款", async () => {
  const succeededAt = new Date().toISOString();
  const order = {
    _id: "order-refund-repair",
    orderNo: "LQT-REFUND-REPAIR",
    outTradeNo: "LQT-REFUND-REPAIR",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "paid",
    orderStatus: "pending_confirm",
    amount: 1,
    amountFen: 100,
    paymentAmountFen: 100,
    paidAt: succeededAt,
    createdAt: succeededAt,
    refundStatus: "processing",
    refundAttemptId: "merchant-refund-repair",
    refundMchRefundId: "merchant-refund-repair",
    refundAttemptAmountFen: 100,
    refundAmountFen: 100,
    refundNotifyAt: succeededAt,
    refundNotifyRetCode: 0,
  };
  const harness = createHarness({ orders: [order], queryOrders: [] });

  const result = await harness.main({ action: "getOrder", id: order._id, adminToken: "test-admin-token" });
  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(result.paymentStatus, "refunded");
  assert.equal(result.orderStatus, "refunded");
  assert.equal(result.refundStatus, "succeeded");
  assert.equal(stored.paymentStatus, "refunded");
  assert.equal(stored.orderStatus, "refunded");
  assert.equal(stored.refundStatus, "succeeded");
  assert.equal(harness.pendingPlatformOrders.length, 0, "repairing a confirmed refund must not call WeChat again");
});

test("成功退款后到达的失败通知不能把订单降回已支付或处理中", async () => {
  const succeededAt = new Date().toISOString();
  const order = {
    _id: "order-refund-success-then-failure",
    orderNo: "LQT-REFUND-SUCCESS-THEN-FAILURE",
    outTradeNo: "LQT-REFUND-SUCCESS-THEN-FAILURE",
    openid: "buyer-openid",
    payMode: "virtual",
    virtualEnv: 0,
    paymentStatus: "refunded",
    orderStatus: "refunded",
    amount: 1,
    amountFen: 100,
    paymentAmountFen: 100,
    paidAt: succeededAt,
    createdAt: succeededAt,
    refundStatus: "succeeded",
    refundAttemptId: "merchant-refund-success-then-failure",
    refundMchRefundId: "merchant-refund-success-then-failure",
    refundAttemptAmountFen: 100,
    refundAmountFen: 100,
    refundSucceededAt: succeededAt,
    refundedAt: succeededAt,
  };
  const harness = createHarness({ orders: [order], queryOrders: [] });

  const result = await harness.main({
    MsgType: "event",
    Event: "xpay_refund_notify",
    MchOrderId: order.outTradeNo,
    MchRefundId: order.refundAttemptId,
    OpenId: order.openid,
    RetCode: 123,
    RetMsg: "late failure notification",
    RefundFee: 0,
  });

  assert.equal(result.ErrCode, 0);
  const stored = harness.database.recordsFor("leqitong_orders")[0];
  assert.equal(stored.paymentStatus, "refunded");
  assert.equal(stored.orderStatus, "refunded");
  assert.equal(stored.refundStatus, "succeeded");
  assert.equal(stored.refundFailureCode, undefined);
});
