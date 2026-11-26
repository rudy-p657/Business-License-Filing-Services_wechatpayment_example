import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const js = readFileSync(resolve(root, "app.js"), "utf8");
const functionSource = readFileSync(resolve(root, "../../cloudfunctions/leqitong/index.js"), "utf8");

const tests = [];
function test(name, callback) {
  tests.push({ name, callback });
}

test("静态部署文件齐全", () => {
  assert.ok(existsSync(resolve(root, "index.html")));
  assert.ok(existsSync(resolve(root, "app.js")));
  assert.ok(existsSync(resolve(root, "app.css")));
  assert.ok(existsSync(resolve(root, "order-actions.css")));
  assert.match(html, /order-actions\.css/);
});

test("网页使用正确的云环境和 SDK", () => {
  assert.match(html, /cloudbase-js-sdk\/2\.32\.0\/cloudbase\.full\.js/);
  assert.match(js, /leqitong-d6g6jkxhza53a818e/);
  assert.match(js, /leqitong/);
  assert.match(functionSource, /leqitong_orders/);
  assert.match(js, /signInAnonymously\(\)/);
});

test("弹窗点击事件没有被 inline stopPropagation 拦截", () => {
  assert.doesNotMatch(js, /class="modal" onclick="event\.stopPropagation\(\)"/);
  assert.match(js, /data-action="close-modal"/);
  assert.match(js, /data-action="copy"/);
  assert.match(js, /data-action="save-remark"/);
  assert.match(js, /action === "close-modal" && \(\(target\.classList\.contains\("modal-backdrop"\) && event\.target === target\) \|\| target\.closest\("\.modal"\)\)/);
});

test("登录页不展示账号密码提醒", () => {
  assert.doesNotMatch(html, /login-note/);
});

test("订单后台支持批量办理状态和安全取消", () => {
  assert.match(js, /<th>支付状态<\/th>/);
  assert.match(js, /data-order-select/);
  assert.match(js, /adminBulkUpdateOrderStatus/);
  assert.match(js, /微信确认已关闭或查无此单时才会取消/);
  assert.match(js, /if \(state\.page === "orders" && \$\("#orders-table"\)\) filterOrders\(\)/);

  const updateOrderBody = functionSource.match(/async function adminUpdateOrder\(event\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(updateOrderBody, "adminUpdateOrder handler should exist");
  assert.match(updateOrderBody[1], /input, "adminRemark"/);
  assert.match(updateOrderBody[1], /input, "orderStatus"/);
  assert.match(updateOrderBody[1], /虚拟支付订单必须先由微信服务端确认到账，才能进入待审核/);
  assert.match(updateOrderBody[1], /订单已有支付或付款确认记录，不能直接取消/);
  assert.match(functionSource, /async function adminBulkUpdateOrderStatus\(event\)/);
});

test("后台可主动申请虚拟支付退款并记录处理状态", () => {
  assert.match(js, /adminRequestVirtualRefund/);
  assert.match(js, /data-action="refund-order"/);
  assert.match(js, /type="password"/);
  assert.match(js, /refundConfirmPassword: password/);
  assert.match(js, /App Store/);
  assert.match(functionSource, /https:\/\/api\.weixin\.qq\.com\/xpay\/refund_order/);
  assert.match(functionSource, /refundRequestedByAdminId/);
  assert.match(functionSource, /refundRequestedByOpenid/);
  assert.match(functionSource, /async function adminRequestVirtualRefund\(event\)/);
  assert.match(functionSource, /LEQITONG_REFUND_CONFIRM_PASSWORD/);
  assert.match(functionSource, /退款确认密码错误/);
  assert.match(functionSource, /Number\(platformOrder\.order_type\) === 7/);
  assert.match(functionSource, /退款任务已启动，最终结果以微信查单或通知为准/);
});

test("已确认退款优先于处理中状态，后台只在手动操作时查退款", () => {
  assert.match(js, /function isRefundConfirmed\(order\).*refundSucceededAt.*refundedAt/);
  assert.match(js, /refundSucceeded \? "微信已确认退款完成。" : refundInProgress/);
  assert.match(js, /data-action="refresh-refund"/);
  assert.doesNotMatch(js, /setInterval\s*\(/);

  const loadOrdersBody = js.match(/function loadOrders\(\)\s*\{([\s\S]*?)\n  function renderOrders/);
  assert.ok(loadOrdersBody, "loadOrders should be present for refund polling verification");
  assert.doesNotMatch(loadOrdersBody[1], /reconcileVirtualPayOrder/);
  assert.match(js, /function refreshRefundStatus\(id, trigger\)[\s\S]*?call\("reconcileVirtualPayOrder", \{ id: id \}\)/);

  assert.match(functionSource, /function hasConfirmedRefund\(order\)/);
  assert.match(functionSource, /function addRefundSuccessSnapshot\(condition, order\)/);
  assert.match(functionSource, /async function ensureConfirmedRefundState\(order\)/);
});

test("老板和普通管理员功能入口存在", () => {
  assert.match(js, /webAdminLogin/);
  assert.match(js, /adminCreateUser/);
  assert.match(js, /adminDeleteUser/);
  assert.match(js, /adminDashboardStats/);
  assert.match(js, /adminCopyAudit/);
});

test("订单更新会拿到已校验的管理员会话", () => {
  assert.match(functionSource, /async function requireAdminSession\(event\)\s*\{[\s\S]*?const session = await getSecureAdminSession\(event\);[\s\S]*?return session;\s*\}/);
  assert.match(functionSource, /const session = await requireAdminSession\(event\);[\s\S]*?adminUpdateOrder/);
});

let failed = 0;
for (const item of tests) {
  try {
    item.callback();
    console.log(`ok - ${item.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${item.name}`);
    console.error(error.stack || error.message || error);
  }
}
console.log(`${tests.length - failed}/${tests.length} tests passed`);
process.exitCode = failed ? 1 : 0;
