const { test } = require("node:test");
const assert = require("node:assert/strict");

function loadApi(t, order, platform = "android", paymentRequest = null, version = "8.0.68") {
  const apiPath = require.resolve("../utils/api");
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  const previousConsoleInfo = console.info;
  const previousConsoleError = console.error;
  const actions = [];
  const cloud = {
    callFunction({ data }) {
      actions.push(data.action);
      if (data.action === "getOrder") return Promise.resolve({ result: { ...order, id: order.id || order._id } });
      if (data.action === "reconcileVirtualPayOrder") {
        return Promise.resolve({ result: { ...order, id: order.id || order._id, virtualOrderFound: false } });
      }
      return Promise.reject(new Error(`Unexpected action: ${data.action}`));
    },
  };

  global.getApp = () => ({ globalData: { cloud } });
  global.wx = {
    getSystemInfoSync: () => ({ platform, version }),
    requestVirtualPayment: paymentRequest,
  };
  console.info = () => {};
  console.error = () => {};
  delete require.cache[apiPath];
  const api = require(apiPath);
  t.after(() => {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
    if (previousGetApp === undefined) delete global.getApp;
    else global.getApp = previousGetApp;
    console.info = previousConsoleInfo;
    console.error = previousConsoleError;
    delete require.cache[apiPath];
  });
  return { api, actions };
}

test("新建的安卓未支付订单详情不提前查询微信支付单", async (t) => {
  const { api, actions } = loadApi(t, {
    id: "new-order",
    payMode: "virtual",
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
  });

  await api.cloudGetOrderById("new-order");

  assert.deepEqual(actions, ["getOrder"]);
});

test("已发起且超过等待窗口的安卓订单会查询微信支付状态", async (t) => {
  const { api, actions } = loadApi(t, {
    id: "stale-order",
    payMode: "virtual",
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
    paymentInitiatedAt: new Date(Date.now() - 60_000).toISOString(),
  });

  await api.cloudGetOrderById("stale-order");

  assert.deepEqual(actions, ["getOrder", "reconcileVirtualPayOrder"]);
});

test("已发起且超过等待窗口的 iOS 订单也会查询微信支付状态", async (t) => {
  const { api, actions } = loadApi(t, {
    id: "stale-ios-order",
    payMode: "virtual",
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
    paymentInitiatedAt: new Date(Date.now() - 60_000).toISOString(),
  }, "ios");

  await api.cloudGetOrderById("stale-ios-order");

  assert.deepEqual(actions, ["getOrder", "reconcileVirtualPayOrder"]);
});

test("iOS virtual payment requires WeChat 8.0.68 or later", async (t) => {
  const { api, actions } = loadApi(t, {}, "ios", null, "8.0.67");

  assert.equal(api.isIOSVirtualPaymentVersionSupported(), false);
  await assert.rejects(api.cloudPrepareVirtualPayment("ios-order"), /8\.0\.68/);
  assert.deepEqual(actions, []);
});

test("iOS 8.0.68 invokes wx.requestVirtualPayment", async (t) => {
  let invoked = false;
  const { api } = loadApi(t, {
    id: "ios-pay-order",
    payMode: "virtual",
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
  }, "ios", (options) => {
    invoked = true;
    options.success({});
  }, "8.0.68");

  const result = await api.cloudStartVirtualPayment("ios-pay-order", {
    signData: "{}",
    paySig: "test-pay-sig",
    signature: "test-signature",
    mode: "short_series_goods",
  });

  assert.equal(invoked, true);
  assert.equal(result.requestError, null);
});

test("微信侧尚无支付单时停止重复查单", async (t) => {
  const { api, actions } = loadApi(t, {
    id: "no-platform-order",
    payMode: "virtual",
    paymentStatus: "unpaid",
    orderStatus: "pending_payment",
  }, "android", (options) => options.fail({ errMsg: "requestVirtualPayment:fail system error" }));

  const result = await api.cloudStartVirtualPayment("no-platform-order", {
    signData: "{}",
    paySig: "test-pay-sig",
    signature: "test-signature",
    mode: "short_series_goods",
  });

  assert.deepEqual(actions, ["reconcileVirtualPayOrder"]);
  assert.equal(result.order.virtualOrderFound, false);
  assert.equal(result.order.paymentStatus, "unpaid");
});
