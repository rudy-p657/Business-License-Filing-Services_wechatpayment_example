const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadOrderDetailPage(t, orderOverrides = {}, paymentMocks = {}) {
  const pagePath = require.resolve("../pages/order-detail/index");
  const originalLoad = Module._load;
  const previousPage = global.Page;
  const previousWx = global.wx;
  let definition;
  let reconcileCalls = 0;
  let startPaymentCalls = 0;
  let prepareCalls = 0;
  const toasts = [];

  global.Page = (page) => { definition = page; };
  global.wx = { showToast: (options) => toasts.push(options) };
  Module._load = function load(request, parent, isMain) {
    if (parent && parent.filename === pagePath && request === "../../utils/api") {
      return {
        isIOSPlatform: () => Boolean(paymentMocks.isIOS),
        isIOSVirtualPaymentVersionSupported: () => paymentMocks.iosVersionSupported !== false,
        cloudGetOrderById: async (id) => ({
          id,
          orderNo: "test-order-1",
          orderStatus: "pending_payment",
          paymentStatus: "unpaid",
          paymentQrUrl: "https://example.com/payment-qr.png",
          paymentQrAvailable: true,
          ...orderOverrides,
        }),
        cloudReconcileVirtualPayOrder: async () => { reconcileCalls += 1; throw new Error("unexpected automatic refund reconciliation"); },
        cloudPrepareVirtualPayment: async () => {
          prepareCalls += 1;
          return paymentMocks.prepareResult;
        },
        cloudStartVirtualPayment: async () => {
          startPaymentCalls += 1;
          return paymentMocks.startResult || {};
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[pagePath];
  t.after(() => {
    Module._load = originalLoad;
    if (previousPage === undefined) delete global.Page;
    else global.Page = previousPage;
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
    delete require.cache[pagePath];
  });

  require(pagePath);
  return {
    definition,
    getReconcileCalls: () => reconcileCalls,
    getPrepareCalls: () => prepareCalls,
    getStartPaymentCalls: () => startPaymentCalls,
    toasts,
  };
}

test("order detail opens the configured QR code for an unpaid order", async (t) => {
  const { definition } = loadOrderDetailPage(t);
  const page = {
    ...definition,
    data: { ...definition.data },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    },
  };

  definition.onLoad.call(page, {
    id: "order-1",
    pay: "1",
  });
  definition.onShow.call(page);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.showPayModal, true);
  assert.equal(page.data.order.paymentQrAvailable, true);
  assert.equal(page.data.paymentStatusText, "未支付");
});

test("confirmed refund cannot render or reconcile as processing on page load", async (t) => {
  const { definition, getReconcileCalls } = loadOrderDetailPage(t, {
    orderStatus: "processing",
    paymentStatus: "paid",
    refundStatus: "processing",
    refundSucceededAt: "2026-10-30T21:03:58.000Z",
  });
  const page = {
    ...definition,
    data: { ...definition.data },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    },
  };

  definition.onLoad.call(page, { id: "order-1" });
  definition.onShow.call(page);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.order.paymentStatus, "refunded");
  assert.equal(page.data.order.orderStatus, "refunded");
  assert.equal(page.data.order.refundStatus, "succeeded");
  assert.equal(page.data.paymentStatusText, "已退款");
  assert.equal(page.data.refundPending, false);
  assert.equal(getReconcileCalls(), 0);
});

test("payment state conflict refreshes order and does not open the payment cashier", async (t) => {
  const latestOrder = {
    id: "order-1",
    orderNo: "test-order-1",
    payMode: "virtual",
    orderStatus: "cancelled",
    paymentStatus: "cancelled",
  };
  const { definition, getStartPaymentCalls, toasts } = loadOrderDetailPage(t, {
    payMode: "virtual",
  }, {
    prepareResult: { stateChanged: true, order: latestOrder },
  });
  const page = {
    ...definition,
    data: { ...definition.data, order: { ...latestOrder, orderStatus: "pending_payment", paymentStatus: "unpaid" } },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    },
  };

  definition.startVirtualPayment.call(page, page.data.order);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.order.paymentStatus, "cancelled");
  assert.equal(page.data.order.orderStatus, "cancelled");
  assert.equal(getStartPaymentCalls(), 0);
  assert.equal(toasts.at(-1).title, "订单已取消，请重新下单");
});

test("an unpaid order continues to the virtual payment call after preparation succeeds", async (t) => {
  const { definition, getStartPaymentCalls } = loadOrderDetailPage(t, {
    payMode: "virtual",
  }, {
    prepareResult: {
      signData: "{}",
      paySig: "test-pay-sig",
      signature: "test-signature",
      mode: "short_series_goods",
    },
  });
  const order = {
    id: "order-1",
    orderNo: "test-order-1",
    payMode: "virtual",
    orderStatus: "pending_payment",
    paymentStatus: "unpaid",
  };
  const page = {
    ...definition,
    data: { ...definition.data, order },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    },
  };

  definition.startVirtualPayment.call(page, order);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getStartPaymentCalls(), 1);
});

test("iOS at the required WeChat version uses the virtual payment flow", async (t) => {
  const { definition, getPrepareCalls, getStartPaymentCalls } = loadOrderDetailPage(t, {
    payMode: "virtual",
  }, {
    isIOS: true,
    prepareResult: { signData: "{}", paySig: "pay", signature: "user", mode: "short_series_goods" },
  });
  const order = {
    id: "order-1",
    orderNo: "test-order-1",
    payMode: "virtual",
    orderStatus: "pending_payment",
    paymentStatus: "unpaid",
  };
  const page = {
    ...definition,
    data: { ...definition.data, order },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    },
  };

  definition.onLoad.call(page, { id: order.id });
  definition.openPay.call(page);
  definition.startVirtualPayment.call(page, order);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.isIOSPlatform, true);
  assert.equal(page.data.showIOSPaymentModal, false);
  assert.equal(getPrepareCalls(), 1);
  assert.equal(getStartPaymentCalls(), 1);
});

test("iOS below the required WeChat version shows the contact fallback without calling payment", async (t) => {
  const { definition, getPrepareCalls, getStartPaymentCalls } = loadOrderDetailPage(t, {
    payMode: "virtual",
  }, { isIOS: true, iosVersionSupported: false });
  const order = {
    id: "order-1",
    orderNo: "test-order-1",
    payMode: "virtual",
    orderStatus: "pending_payment",
    paymentStatus: "unpaid",
  };
  const page = {
    ...definition,
    data: { ...definition.data, order },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    },
  };

  definition.onLoad.call(page, { id: order.id });
  definition.openPay.call(page);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.showIOSPaymentModal, true);
  assert.match(page.data.iosPaymentFallbackMessage, /8\.0\.68/);
  assert.equal(getPrepareCalls(), 0);
  assert.equal(getStartPaymentCalls(), 0);
});

test("iOS virtual payment failure opens the offline contact fallback", async (t) => {
  const order = {
    id: "order-1",
    orderNo: "test-order-1",
    payMode: "virtual",
    orderStatus: "pending_payment",
    paymentStatus: "unpaid",
  };
  const { definition } = loadOrderDetailPage(t, { payMode: "virtual" }, {
    isIOS: true,
    prepareResult: { signData: "{}", paySig: "pay", signature: "user", mode: "short_series_goods" },
    startResult: { order, requestError: { errMsg: "requestVirtualPayment:fail banned" } },
  });
  const page = {
    ...definition,
    data: { ...definition.data, order, isIOSPlatform: true, iosVirtualPaymentSupported: true },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    },
  };

  definition.startVirtualPayment.call(page, order);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(page.data.showIOSPaymentModal, true);
  assert.match(page.data.iosPaymentFallbackMessage, /请联系工作人员/);
});

test("iOS order links that request payment enter the online payment flow after loading", async (t) => {
  const { definition } = loadOrderDetailPage(t, { payMode: "virtual" }, { isIOS: true });
  const page = {
    ...definition,
    data: { ...definition.data },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    },
  };

  definition.onLoad.call(page, { id: "order-1", pay: "1" });
  definition.onShow.call(page);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.showIOSPaymentModal, false);
  assert.equal(page.data.confirmingPayment, false);
});

test("Android continues through payment preparation and the original cashier flow", async (t) => {
  const { definition, getPrepareCalls, getStartPaymentCalls } = loadOrderDetailPage(t, {
    payMode: "virtual",
  }, {
    isIOS: false,
    prepareResult: {
      signData: "{}",
      paySig: "test-pay-sig",
      signature: "test-signature",
      mode: "short_series_goods",
    },
  });
  const order = {
    id: "order-1",
    orderNo: "test-order-1",
    payMode: "virtual",
    orderStatus: "pending_payment",
    paymentStatus: "unpaid",
  };
  const page = {
    ...definition,
    data: { ...definition.data, order },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    },
  };

  definition.onLoad.call(page, { id: order.id });
  definition.openPay.call(page);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.isIOSPlatform, false);
  assert.equal(getPrepareCalls(), 1);
  assert.equal(getStartPaymentCalls(), 1);
});
