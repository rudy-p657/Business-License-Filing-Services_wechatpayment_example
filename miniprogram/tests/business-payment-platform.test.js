const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadBusinessPage(t, isIOS, iosVersionSupported = true, startPayment = async () => ({})) {
  const pagePath = require.resolve("../pages/business/index");
  const originalLoad = Module._load;
  const previousPage = global.Page;
  const previousWx = global.wx;
  let definition;
  const redirects = [];
  const paymentStarts = [];

  global.Page = (page) => { definition = page; };
  global.wx = {
    hideLoading() {},
    redirectTo: (options) => redirects.push(options.url),
    showLoading() {},
    showToast() {},
  };
  Module._load = function load(request, parent, isMain) {
    if (parent && parent.filename === pagePath && request === "../../utils/api") {
      return {
        checkIdCard: () => true,
        cloudCreateOrder: async () => ({
          ok: true,
          payMode: "virtual",
          order: { id: "order-1", orderNo: "LQT-ORDER-1" },
          payData: { signData: "{}" },
        }),
        cloudStartVirtualPayment: startPayment,
        isIOSPlatform: () => isIOS,
        isIOSVirtualPaymentVersionSupported: () => iosVersionSupported,
        getCompanyByCreditCode: () => ({ name: "Test Co", creditCode: "test-code" }),
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
    redirects,
    paymentStarts,
  };
}

function makePage(definition, paymentStarts, isIOS) {
  return {
    ...definition,
    data: {
      ...definition.data,
      canSubmit: true,
      company: { name: "Test Co" },
      contactPhone: "13800000000",
      idCardNo: "110101199001011234",
      isIOSPlatform: isIOS,
      privacyAuthorized: true,
      selectedServiceId: "annual_1",
      staffNo: "1001",
    },
    setData(update) { Object.assign(this.data, update); },
    startVirtualPayment(order, payData) { paymentStarts.push({ order, payData }); },
  };
}

test("iOS order submission uses virtual payment when the WeChat version supports it", async (t) => {
  const { definition, redirects, paymentStarts } = loadBusinessPage(t, true);
  const page = makePage(definition, paymentStarts, true);
  page.checkPrivacyAuth = () => {};
  definition.onLoad.call(page, { creditCode: "test-code" });

  definition.submitOrder.call(page);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.isIOSPlatform, true);
  assert.deepEqual(redirects, []);
  assert.equal(paymentStarts.length, 1);
  assert.equal(paymentStarts[0].order.id, "order-1");
});

test("iOS below the supported WeChat version opens the offline contact fallback", async (t) => {
  const { definition, redirects, paymentStarts } = loadBusinessPage(t, true, false);
  const page = makePage(definition, paymentStarts, true);
  page.checkPrivacyAuth = () => {};
  definition.onLoad.call(page, { creditCode: "test-code" });

  definition.submitOrder.call(page);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(redirects, ["/pages/order-detail/index?id=order-1&pay=1"]);
  assert.equal(paymentStarts.length, 0);
});

test("Android order submission continues to the existing virtual payment flow", async (t) => {
  const { definition, redirects, paymentStarts } = loadBusinessPage(t, false);
  const page = makePage(definition, paymentStarts, false);
  page.checkPrivacyAuth = () => {};
  definition.onLoad.call(page, { creditCode: "test-code" });

  definition.submitOrder.call(page);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.isIOSPlatform, false);
  assert.equal(paymentStarts.length, 1);
  assert.equal(paymentStarts[0].order.id, "order-1");
  assert.deepEqual(redirects, []);
});

test("iOS payment failure opens the contact fallback from the new order flow", async (t) => {
  const { definition, redirects, paymentStarts } = loadBusinessPage(t, true, true, async () => ({
    order: { id: "order-1", paymentStatus: "unpaid", virtualOrderFound: false },
    requestError: { errMsg: "requestVirtualPayment:fail banned" },
  }));
  const page = makePage(definition, paymentStarts, true);
  page.startVirtualPayment = definition.startVirtualPayment;
  page.data.currentOrder = { id: "order-1", orderNo: "LQT-ORDER-1" };

  definition.startVirtualPayment.call(page, page.data.currentOrder, { signData: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 750));

  assert.deepEqual(redirects, ["/pages/order-detail/index?id=order-1&contact=1"]);
});
