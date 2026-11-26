(function () {
  "use strict";
  var ENV_ID = "leqitong-d6g6jkxhza53a818e";
  var LEGACY_PAYMENT_QR = "/images/payment-qr.svg";
  var TOKEN_KEY = "leqitong_web_admin_token";
  var STATUS = { pending_payment: "待支付", pending_confirm: "待审核", processing: "处理中", completed: "已完成", cancelled: "已取消", refunded: "已退款" };
  var PAYMENT_STATUS = { unpaid: "未支付", paid: "已支付", confirmed_by_user: "待管理员核实", confirmed_by_admin: "已人工核实", refunded: "已退款", cancelled: "已关闭" };
  var state = { page: "dashboard", user: null, orders: [], selectedOrderIds: [], bulkUpdating: false, services: [], announcements: [], users: [], stats: null, selectedOrder: null };
  var app = null;
  var toastTimer = null;
  var refundQueries = Object.create(null);
  var ordersLoadVersion = 0;

  function $(selector) { return document.querySelector(selector); }
  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]; }); }
  function money(value) { return Number(value || 0).toFixed(2); }
  function priceToFen(value) { var text = String(value == null ? "" : value).trim(); if (!text) return null; if (!/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.test(text)) return NaN; var parts = text.split("."); return Number(parts[0]) * 100 + Number(((parts[1] || "") + "00").slice(0, 2)); }
  function showToast(message) { var node = $("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(function () { node.classList.remove("show"); }, 2200); }
  function setError(message) { $("#login-error").textContent = message || ""; }
  function setNotice(message) { var node = $("#notice-bar"); node.textContent = message || ""; node.classList.toggle("hidden", !message); }
  function fmtStatus(value) { return STATUS[value] || value || "-"; }
  function fmtPaymentStatus(value) { return PAYMENT_STATUS[value] || value || "-"; }
  function fmtRefundStatus(value) { return ({ requesting: "退款请求待确认", processing: "退款处理中", succeeded: "退款成功", failed: "退款失败" })[value] || value || "未申请"; }
  function orderPaymentLabel(order) { if (isRefundConfirmed(order)) return "已退款"; if (order.refundStatus === "requesting") return "退款结果待确认"; if (order.refundStatus === "processing") return "退款处理中"; if (order.refundStatus === "failed") return "退款失败（已支付）"; return fmtPaymentStatus(order.paymentStatus); }
  function isRefundConfirmed(order) { return Boolean(order && (order.paymentStatus === "refunded" || order.refundStatus === "succeeded" || order.orderStatus === "refunded" || order.refundSucceededAt || order.refundedAt || (Number(order.refundNotifyRetCode) === 0 && order.refundNotifyAt))); }
  function preserveConfirmedRefund(order, previous) {
    if (!order || (!isRefundConfirmed(previous) && !isRefundConfirmed(order))) return order;
    return Object.assign({}, previous || {}, order, {
      paymentStatus: "refunded",
      orderStatus: "refunded",
      refundStatus: "succeeded",
      refundAmountFen: order.refundAmountFen == null && previous ? previous.refundAmountFen : order.refundAmountFen,
      refundedAt: order.refundedAt || (previous && previous.refundedAt),
      refundSucceededAt: order.refundSucceededAt || (previous && previous.refundSucceededAt) || (previous && previous.refundedAt),
      refundConfirmationSource: order.refundConfirmationSource || (previous && previous.refundConfirmationSource),
      refundRequestMessage: (previous && previous.refundRequestMessage) || order.refundRequestMessage
    });
  }
  function isRefundPending(order) { return Boolean(order && !isRefundConfirmed(order) && order.payMode === "virtual" && order.paymentStatus === "paid" && ["requesting", "processing"].indexOf(order.refundStatus) >= 0); }
  function refreshRefundStatus(id, trigger) {
    if (refundQueries[id]) {
      showToast("退款状态查询正在进行");
      return refundQueries[id];
    }
    if (trigger) { trigger.disabled = true; trigger.textContent = "正在查询..."; }
    var request = call("reconcileVirtualPayOrder", { id: id }).then(function (updated) {
      var previous = state.orders.find(function (order) { return String(order.id || order._id) === String(id); });
      if (state.selectedOrder && String(state.selectedOrder.id || state.selectedOrder._id) === String(id) && isRefundConfirmed(state.selectedOrder)) previous = state.selectedOrder;
      updated = preserveConfirmedRefund(updated, previous);
      var changed = !previous || previous.paymentStatus !== updated.paymentStatus || previous.orderStatus !== updated.orderStatus || previous.refundStatus !== updated.refundStatus || previous.refundRequestMessage !== updated.refundRequestMessage;
      state.orders = state.orders.map(function (order) { return String(order.id || order._id) === String(id) ? updated : order; });
      if (state.page === "orders" && $("#orders-table")) filterOrders();
      if (state.selectedOrder && String(state.selectedOrder.id || state.selectedOrder._id) === String(id)) {
        state.selectedOrder = updated;
        if (changed && $("#modal-root").innerHTML) openOrderModal(updated);
      }
      showToast(isRefundConfirmed(updated)
        ? "微信已确认退款成功"
        : updated.refundStatus === "failed"
          ? "微信返回退款失败"
          : "退款仍在处理中");
      return updated;
    }).catch(function (error) {
      showToast(error && error.message ? error.message : "查询失败，请稍后重试");
      throw error;
    }).finally(function () {
      if (refundQueries[id] === request) delete refundQueries[id];
      if (trigger && trigger.isConnected) { trigger.disabled = false; trigger.textContent = "刷新退款状态"; }
    });
    refundQueries[id] = request;
    return request;
  }
  function hasPaymentQr(service) { return Boolean(service && service.paymentQr && service.paymentQr !== LEGACY_PAYMENT_QR); }
  function statusTag(value) { var type = value === "completed" ? "green" : (value === "pending_confirm" || value === "processing" ? "orange" : (value === "refunded" || value === "cancelled" ? "red" : "")); return '<span class="tag ' + type + '">' + esc(fmtStatus(value)) + '</span>'; }

  function initCloud() {
    if (!window.cloudbase) throw new Error("云开发 Web SDK 加载失败，请检查静态网站网络访问");
    app = window.cloudbase.init({ env: ENV_ID });
    // The admin account is separate from the Web SDK identity. Anonymous auth
    // only supplies the CloudBase credential needed to invoke the function.
    // Refresh the anonymous CloudBase credential on each page load. A cached
    // anonymous user object can outlive its credential and cause credentials
    // not found errors when invoking the cloud function.
    return app.auth().signInAnonymously();
  }
  function call(action, data) {
    data = data || {};
    var token = localStorage.getItem(TOKEN_KEY);
    return app.callFunction({ name: "leqitong", data: Object.assign({ action: action }, data, token ? { adminToken: token } : {}) }).then(function (response) {
      var result = response && response.result ? response.result : response;
      if (typeof result === "string") {
        try { result = JSON.parse(result); } catch (error) { throw new Error(result); }
      }
      if (result && result.result) result = result.result;
      if (typeof result === "string") {
        try { result = JSON.parse(result); } catch (error) { throw new Error(result); }
      }
      if (result && result.data && result.data.token) result = result.data;
      if (!result || result.ok === false) throw new Error((result && result.message) || "云函数处理失败");
      return result;
    });
  }
  function login(phone, password) { return call("webAdminLogin", { phone: phone, password: password }).then(function (result) { localStorage.setItem(TOKEN_KEY, result.token); state.user = result.user; return result; }); }
  function status() { return call("webAdminStatus"); }
  function logout() { localStorage.removeItem(TOKEN_KEY); state.user = null; state.page = "dashboard"; $("#shell-view").classList.add("hidden"); $("#login-view").classList.remove("hidden"); }

  function renderShell() {
    $("#login-view").classList.add("hidden"); $("#shell-view").classList.remove("hidden");
    $("#account-label").textContent = (state.user && state.user.name ? state.user.name + " · " : "") + (state.user && state.user.role === "owner" ? "老板" : "管理员");
    document.querySelectorAll(".owner-only").forEach(function (node) { node.classList.toggle("hidden", !state.user || state.user.role !== "owner"); });
    renderPage();
  }
  function renderPage() {
    var titles = { dashboard: "数据概览", orders: "订单管理", announcements: "公告管理", services: "服务配置", users: "管理员账号" };
    $("#page-title").textContent = titles[state.page] || "数据概览";
    document.querySelectorAll(".nav-item").forEach(function (node) { node.classList.toggle("active", node.dataset.page === state.page); });
    if (state.page === "dashboard") loadDashboard();
    if (state.page === "orders") loadOrders();
    if (state.page === "announcements") loadAnnouncements();
    if (state.page === "services") loadServices();
    if (state.page === "users") loadUsers();
    $("#sidebar").classList.remove("open");
  }
  function loadDashboard() { $("#page-content").innerHTML = '<div class="empty-state">正在加载概览...</div>'; call("adminDashboardStats").then(function (stats) { state.stats = stats; renderDashboard(); }).catch(handleError); }
  function renderDashboard() {
    var s = state.stats || { cards: {}, series: [], serviceBreakdown: [], pending: [], recent: [] }, c = s.cards || {};
    $("#page-content").innerHTML = '<div class="stats-grid">' + statBox("今日净实收", c.todayAmount, true) + statBox("今日新增订单", c.todayOrders) + statBox("累计净实收", c.totalAmount, true) + statBox("累计总单量", c.totalOrders) + '</div><div class="dashboard-grid"><section class="panel"><div class="panel-title"><h3>近 7 日业务趋势</h3><span>收款减去已完成退款</span></div><div id="trend-chart" class="chart"></div></section><section class="panel"><div class="panel-title"><h3>服务成交占比</h3><span>已确认且未退款订单</span></div><div id="service-chart" class="chart"></div></section></div><section class="panel" style="margin-top:18px"><div class="panel-title"><h3>最新待办订单</h3><button class="text-button" data-action="go-orders">查看全部</button></div>' + orderTable(s.pending, false) + '</section>';
    drawCharts(s);
  }
  function statBox(label, value, isMoney) { return '<div class="stat-box"><div class="stat-label">' + esc(label) + '</div><div class="stat-value ' + (isMoney ? "money" : "") + '">' + esc(isMoney ? money(value) : (value || 0)) + '</div></div>'; }
  function drawCharts(stats) {
    if (!window.echarts) return;
    var trend = window.echarts.init($("#trend-chart")); trend.setOption({ color: ["#1769aa", "#4bb38a"], tooltip: { trigger: "axis" }, grid: { left: 30, right: 16, top: 20, bottom: 25 }, xAxis: { type: "category", data: stats.series.map(function (item) { return item.date; }), axisLine: { lineStyle: { color: "#dce5eb" } } }, yAxis: [{ type: "value", splitLine: { lineStyle: { color: "#edf2f5" } } }, { type: "value", show: false }], series: [{ name: "金额", type: "line", smooth: true, data: stats.series.map(function (item) { return item.amount; }) }, { name: "订单", type: "bar", yAxisIndex: 1, data: stats.series.map(function (item) { return item.orders; }) }] });
    var pie = window.echarts.init($("#service-chart")); pie.setOption({ color: ["#1769aa", "#4bb38a", "#e4a34f", "#9aaec0"], tooltip: { trigger: "item" }, legend: { bottom: 0, type: "scroll", textStyle: { fontSize: 11 } }, series: [{ type: "pie", radius: ["40%", "68%"], center: ["50%", "42%"], data: stats.serviceBreakdown.length ? stats.serviceBreakdown : [{ name: "暂无数据", value: 1 }], label: { show: false } }] });
  }
  function orderTable(orders, selectable) {
    if (!orders || !orders.length) return '<div class="empty-state">暂无订单数据</div>';
    var selectionHeader = selectable ? '<th class="selection-cell"><input type="checkbox" data-select-visible aria-label="选择当前显示的订单"></th>' : "";
    return '<div class="table-wrap"><table class="data-table"><thead><tr>' + selectionHeader + '<th>订单编号</th><th>企业名称</th><th>服务项目</th><th>应付金额</th><th>支付方式</th><th>支付状态</th><th>办理状态</th><th>提交时间</th></tr></thead><tbody>' + orders.map(function (order) { var id = String(order.id || order._id); var selectionCell = selectable ? '<td class="selection-cell"><input type="checkbox" data-order-select="' + esc(id) + '" aria-label="选择订单 ' + esc(order.orderNo) + '" ' + (state.selectedOrderIds.indexOf(id) >= 0 ? "checked" : "") + '></td>' : ""; return '<tr data-order-id="' + esc(id) + '">' + selectionCell + '<td class="strong">' + esc(order.orderNo) + '</td><td>' + esc(order.company && order.company.name) + '</td><td>' + esc(order.serviceName) + '</td><td class="money-text">¥' + money(order.amount) + '</td><td>' + (order.payMode === "virtual" ? "微信虚拟支付" : "扫码支付") + '</td><td>' + esc(orderPaymentLabel(order)) + '</td><td>' + statusTag(order.orderStatus) + '</td><td>' + esc(order.createdAt) + '</td></tr>'; }).join("") + '</tbody></table></div>';
  }
  function loadOrders() { var loadVersion = ++ordersLoadVersion; $("#page-content").innerHTML = '<div class="empty-state">正在加载订单...</div>'; call("adminGetOrders").then(function (result) { if (loadVersion !== ordersLoadVersion || state.page !== "orders") return; var previousOrders = state.orders; state.orders = (result.list || []).map(function (order) { var id = String(order.id || order._id); var previous = previousOrders.find(function (item) { return String(item.id || item._id) === id; }); if (state.selectedOrder && String(state.selectedOrder.id || state.selectedOrder._id) === id && isRefundConfirmed(state.selectedOrder)) previous = state.selectedOrder; return preserveConfirmedRefund(order, previous); }); if (state.selectedOrder) { var selectedId = String(state.selectedOrder.id || state.selectedOrder._id); var refreshedSelected = state.orders.find(function (order) { return String(order.id || order._id) === selectedId; }); if (refreshedSelected) state.selectedOrder = refreshedSelected; } state.selectedOrderIds = state.selectedOrderIds.filter(function (id) { return state.orders.some(function (order) { return String(order.id || order._id) === id; }); }); renderOrders(); }).catch(function (error) { if (loadVersion === ordersLoadVersion && state.page === "orders") handleError(error); }); }
  function renderOrders() { $("#page-content").innerHTML = '<div class="section-row"><div><h3>全部订单</h3><span class="muted">共 ' + state.orders.length + ' 条</span></div><button class="secondary-button" data-action="refresh">刷新数据</button></div><div class="filter-bar"><input id="order-search" placeholder="搜索订单号、企业名称、法人姓名、联系电话"><select id="status-filter"><option value="">全部办理状态</option><option value="pending_payment">待支付</option><option value="pending_confirm">待审核</option><option value="processing">处理中</option><option value="completed">已完成</option><option value="cancelled">已取消</option><option value="refunded">已退款</option></select></div><div class="order-bulk-toolbar"><span id="selected-order-count" class="muted">已选 0 单</span><div class="bulk-actions"><select id="bulk-order-status" aria-label="批量设置办理状态"><option value="">选择办理状态</option><option value="pending_confirm">待审核</option><option value="processing">处理中</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select><button class="secondary-button" data-action="apply-bulk-status" disabled>批量更新</button></div></div><section class="panel"><div id="orders-table">' + orderTable(state.orders, true) + '</div></section>'; bindOrderFilters(); syncOrderSelection(); }
  function bindOrderFilters() { $("#order-search").addEventListener("input", filterOrders); $("#status-filter").addEventListener("change", filterOrders); $("#bulk-order-status").addEventListener("change", syncOrderSelection); }
  function filterOrders() { var keyword = ($("#order-search").value || "").toLowerCase(), statusValue = $("#status-filter").value; var result = state.orders.filter(function (order) { var text = [order.orderNo, order.contactPhone, order.openid, order.company && order.company.name, order.company && order.company.legalPerson].join(" ").toLowerCase(); return (!keyword || text.indexOf(keyword) >= 0) && (!statusValue || order.orderStatus === statusValue); }); $("#orders-table").innerHTML = orderTable(result, true); syncOrderSelection(); }
  function syncOrderSelection() { var checkboxes = Array.from(document.querySelectorAll("[data-order-select]")), selectedVisible = checkboxes.filter(function (input) { return state.selectedOrderIds.indexOf(input.dataset.orderSelect) >= 0; }).length, selectAll = $("[data-select-visible]"); if (selectAll) { selectAll.checked = checkboxes.length > 0 && selectedVisible === checkboxes.length; selectAll.indeterminate = selectedVisible > 0 && selectedVisible < checkboxes.length; } var count = $("#selected-order-count"), apply = $("[data-action='apply-bulk-status']"), status = $("#bulk-order-status"); if (count) count.textContent = "已选 " + state.selectedOrderIds.length + " 单"; if (apply) apply.disabled = !state.selectedOrderIds.length || !status.value || state.bulkUpdating; if (status) status.disabled = Boolean(state.bulkUpdating); }
  function toggleOrderSelection(id, checked) { var selected = state.selectedOrderIds.filter(function (item) { return item !== id; }); if (checked) selected.push(id); state.selectedOrderIds = selected; syncOrderSelection(); }
  function applyBulkOrderStatus() {
    var status = $("#bulk-order-status").value, ids = state.selectedOrderIds.slice();
    if (state.bulkUpdating) return;
    if (!status || !ids.length) return showToast("请选择订单和目标状态");
    if (ids.length > 100) return showToast("一次最多选择 100 笔订单");
    var label = ({ pending_confirm: "待审核", processing: "处理中", completed: "已完成", cancelled: "已取消" })[status];
    var message = status === "cancelled"
      ? "确定将选中的 " + ids.length + " 笔订单设为已取消吗？虚拟支付订单只有在微信确认已关闭或查无此单时才会取消；已支付或仍可支付的订单不会被取消。"
      : "确定将选中的 " + ids.length + " 笔订单设为“" + label + "”吗？";
    confirmAction(message, function () {
      state.bulkUpdating = true;
      syncOrderSelection();
      call("adminBulkUpdateOrderStatus", { ids: ids, orderStatus: status }).then(function (result) {
        var byId = {};
        (result.results || []).forEach(function (item) {
          if (item.ok && item.order) byId[String(item.id)] = item.order;
        });
        state.orders = state.orders.map(function (order) { return byId[String(order.id || order._id)] || order; });
        var failures = (result.results || []).filter(function (item) { return !item.ok; });
        state.selectedOrderIds = failures.map(function (item) { return String(item.id); });
        if (state.page === "orders" && $("#orders-table")) filterOrders();
        if (failures.length) {
          var first = failures[0];
          if (state.page === "orders") setNotice(result.successCount + " 笔已更新，" + result.failureCount + " 笔失败：" + (first.message || "请刷新后重试"));
          showToast("批量更新完成，部分订单失败");
        } else {
          if (state.page === "orders") setNotice("");
          showToast("已将 " + result.successCount + " 笔订单设为" + label);
        }
      }).catch(handleError).finally(function () {
        state.bulkUpdating = false;
        syncOrderSelection();
      });
    });
  }

  function loadAnnouncements() { $("#page-content").innerHTML = '<div class="empty-state">正在加载公告...</div>'; call("getAnnouncements", { includeHidden: true }).then(function (result) { state.announcements = result.list || []; renderAnnouncements(); }).catch(handleError); }
  function renderAnnouncements() { $("#page-content").innerHTML = '<div class="two-column"><section class="panel"><div class="panel-title"><h3>发布公告</h3><span>发布时间自动取当前时间</span></div><form id="announcement-form"><div class="form-grid"><div class="form-field full"><label>公告标题<input id="notice-title" required placeholder="请输入公告标题"></label></div><div class="form-field full"><label>公告正文<textarea id="notice-content" required placeholder="请输入公告正文"></textarea></label></div></div><div class="form-actions"><button class="secondary-button" type="reset">清空</button><button class="primary-button" type="submit">发布公告</button></div></form></section><section class="panel"><div class="panel-title"><h3>公告列表</h3><span>' + state.announcements.length + ' 条</span></div><div class="announcement-list">' + (state.announcements.length ? state.announcements.map(announcementRow).join("") : '<div class="empty-state">暂无公告</div>') + '</div></section></div>'; $("#announcement-form").addEventListener("submit", saveAnnouncement); }
  function announcementRow(item) { return '<div class="announcement-row"><div class="announcement-copy"><strong>' + esc(item.title) + '</strong><p>' + esc(item.publishedAt) + ' · ' + (item.visible ? "已显示" : "已隐藏") + '</p></div><div class="row-actions"><button class="small-button" data-action="edit-notice" data-id="' + esc(item.id) + '">编辑</button><button class="small-button" data-action="toggle-notice" data-id="' + esc(item.id) + '">' + (item.visible ? "隐藏" : "显示") + '</button><button class="danger-button small-button" data-action="delete-notice" data-id="' + esc(item.id) + '">删除</button></div></div>'; }
  function saveAnnouncement(event) { event.preventDefault(); var title = $("#notice-title").value.trim(), content = $("#notice-content").value.trim(); if (!title || !content) return showToast("请填写完整公告内容"); call("saveAnnouncement", { title: title, content: content, visible: true }).then(function () { showToast("公告已发布"); loadAnnouncements(); }).catch(handleError); }

  function loadServices() { $("#page-content").innerHTML = '<div class="empty-state">正在加载服务配置...</div>'; call("getServices").then(function (result) { state.services = result.list || []; renderServices(); }).catch(handleError); }
  function renderServices() { $("#page-content").innerHTML = '<div class="section-row"><div><h3>服务与收款码</h3><span class="muted">价格和二维码保存后同步到小程序</span></div><button class="primary-button" data-action="save-services">保存配置</button></div><p class="muted">虚拟支付审核通过后才可使用。改价时先在微信后台更新并发布道具，再把对应价格填入下方；微信后台商品价、这里的服务价和商品价必须相同。</p><div class="service-grid">' + state.services.map(function (service, index) { var virtualPriceSet = service.virtualPriceFen != null && service.virtualPriceFen !== "" && Number.isSafeInteger(Number(service.virtualPriceFen)); return '<div class="service-card" data-service-index="' + index + '"><div><h4>' + esc(service.name) + '</h4><p>' + esc(service.description) + '</p></div><div class="form-field"><label>服务价格（元）<input class="service-price" type="number" min="0" step="0.01" value="' + esc(service.price) + '"></label></div><div class="form-field"><label>微信虚拟商品 ID<input class="service-product-id" type="text" maxlength="128" value="' + esc(service.virtualProductId || "") + '" placeholder="审核通过并创建道具后填写"></label></div><div class="form-field"><label>微信已发布商品价格（元）<input class="virtual-product-price" type="number" min="0" step="0.01" value="' + (virtualPriceSet ? (Number(service.virtualPriceFen) / 100).toFixed(2) : "") + '" placeholder="与微信后台当前售价一致"></label></div><div class="service-state"><label><input class="service-enabled" type="checkbox" ' + (service.enabled !== false ? "checked" : "") + '> 启用</label></div><div class="qr-actions"><img class="qr-preview" alt="收款二维码"><input class="qr-file" type="file" accept="image/*" hidden><button class="secondary-button" data-action="choose-qr">更换二维码</button><span class="muted qr-name">' + (hasPaymentQr(service) ? "已配置真实二维码" : "未配置二维码") + '</span></div></div>'; }).join("") + '</div>'; loadQrPreviews(); }
  function loadQrPreviews() { state.services.forEach(function (service, index) { if (!hasPaymentQr(service)) return; app.getTempFileURL({ fileList: [service.paymentQr] }).then(function (result) { var item = result.fileList && result.fileList[0]; if (item && item.tempFileURL) $("[data-service-index='" + index + "'] .qr-preview").src = item.tempFileURL; }).catch(handleError); }); }
  function saveServices() { var cards = Array.from(document.querySelectorAll(".service-card")); var next = state.services.map(function (service, index) { var card = cards[index], virtualPriceFen = priceToFen(card.querySelector(".virtual-product-price").value); return Object.assign({}, service, { price: Number(card.querySelector(".service-price").value || 0), virtualProductId: card.querySelector(".service-product-id").value.trim(), virtualPriceFen: virtualPriceFen, enabled: card.querySelector(".service-enabled").checked }); }); if (next.some(function (service) { return Number.isNaN(service.virtualPriceFen); })) return showToast("微信商品价格最多保留两位小数"); call("saveServices", { services: next }).then(function (result) { state.services = result.list || next; renderServices(); showToast("服务配置已保存"); }).catch(handleError); }
  function chooseQr(button) { var card = button.closest(".service-card"), input = card.querySelector(".qr-file"); input.value = ""; input.onchange = function () { var file = input.files[0]; if (!file) return; showToast("正在上传二维码..."); var index = Number(card.dataset.serviceIndex); app.uploadFile({ cloudPath: "payment-qr/web-" + Date.now() + "-" + index + "." + (file.name.split(".").pop() || "png"), filePath: file }).then(function (result) { state.services[index].paymentQr = result.fileID; card.querySelector(".qr-name").textContent = "已上传，待保存"; app.getTempFileURL({ fileList: [result.fileID] }).then(function (urlResult) { var item = urlResult.fileList && urlResult.fileList[0]; if (item && item.tempFileURL) card.querySelector(".qr-preview").src = item.tempFileURL; }).catch(handleError); showToast("二维码上传成功，请保存配置"); }).catch(handleError); }; input.click(); }

  function loadUsers() { if (!state.user || state.user.role !== "owner") return renderNoPermission(); $("#page-content").innerHTML = '<div class="empty-state">正在加载管理员...</div>'; call("adminListUsers").then(function (result) { state.users = result.list || []; renderUsers(); }).catch(handleError); }
  function renderUsers() { $("#page-content").innerHTML = '<div class="section-row"><div><h3>管理员账号</h3><span class="muted">新账号初始密码由云函数环境变量配置</span></div><button class="primary-button" data-action="add-user">添加管理员</button></div><section class="panel"><div class="user-list">' + (state.users.length ? state.users.map(userRow).join("") : '<div class="empty-state">暂无管理员账号</div>') + '</div></section>'; }
  function userRow(user) { var owner = user.role === "owner"; return '<div class="user-row"><div class="user-main"><div class="user-avatar">' + esc((user.name || "管").slice(0, 1)) + '</div><div><strong>' + esc(user.name) + ' <span class="tag ' + (owner ? "owner-badge" : "") + '">' + (owner ? "老板" : "管理员") + '</span></strong><span>' + esc(user.phone) + ' · ' + (user.enabled === false ? "已停用" : "正常") + '</span></div></div><div class="row-actions">' + (owner ? '<span class="muted">系统账号</span>' : '<button class="small-button" data-action="edit-user" data-id="' + esc(user.id) + '">编辑</button><button class="small-button" data-action="reset-user" data-id="' + esc(user.id) + '">重置密码</button><button class="danger-button small-button" data-action="delete-user" data-id="' + esc(user.id) + '">删除</button>') + '</div></div>'; }
  function renderNoPermission() { $("#page-content").innerHTML = '<section class="panel empty-state">只有老板可以管理管理员账号</section>'; }

  function orderById(id) { return state.orders.find(function (item) { return String(item.id || item._id) === String(id); }); }
  function openOrder(id) { var local = orderById(id); call("getOrder", { id: id }).then(function (order) { if (order && order.payMode === "virtual" && order.paymentStatus === "unpaid") return call("reconcileVirtualPayOrder", { id: id }).catch(function () { return order; }); return order; }).then(function (order) { openOrderModal(preserveConfirmedRefund(order || local, local)); }).catch(function () { if (local) openOrderModal(local); else handleError(new Error("订单加载失败")); }); }
  function detailItem(label, value, orderId, sensitive) { var text = value == null || value === "" ? "-" : value; return '<div class="detail-item"><span class="label">' + esc(label) + '</span><span class="value">' + esc(text) + '</span><button class="copy-button" data-action="copy" data-value="' + esc(text) + '" data-order-id="' + esc(orderId) + '" data-field="' + esc(label) + '">复制</button></div>'; }
  function flattenExtra(extra) { return Object.keys(extra || {}).map(function (key) { return [key === "revenue" ? "营业额" : key === "tax" ? "纳税额" : key === "employeeCount" ? "从业人数" : key, extra[key]]; }); }
  function copyValue(button) { var value = button.dataset.value; var write = navigator.clipboard && typeof navigator.clipboard.writeText === "function" ? navigator.clipboard.writeText(value).catch(function () { fallbackCopy(value); }) : Promise.resolve().then(function () { fallbackCopy(value); }); write.then(function () { if (button.dataset.field === "法人身份证号码") call("adminCopyAudit", { orderId: button.dataset.orderId, field: button.dataset.field }).catch(function () {}); showToast("已复制"); }).catch(function () { showToast("复制失败，请手动复制"); }); }
  function fallbackCopy(value) { var input = document.createElement("textarea"); input.value = value; document.body.appendChild(input); input.select(); document.execCommand("copy"); input.remove(); }

  function openNoticeEdit(id) { var item = state.announcements.find(function (notice) { return String(notice.id) === String(id); }); if (!item) return; $("#modal-root").innerHTML = '<div class="modal-backdrop" data-action="close-modal"><div class="modal"><div class="modal-header"><h3>编辑公告</h3><button class="close-button" data-action="close-modal">×</button></div><form id="edit-notice-form" style="padding-top:18px"><div class="form-grid"><div class="form-field full"><label>公告标题<input id="edit-notice-title" value="' + esc(item.title) + '" required></label></div><div class="form-field full"><label>公告正文<textarea id="edit-notice-content" required>' + esc(item.content) + '</textarea></label></div></div><div class="form-actions"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button class="primary-button" type="submit">保存修改</button></div></form></div></div>'; $("#edit-notice-form").addEventListener("submit", function (event) { event.preventDefault(); call("saveAnnouncement", { id: item.id, title: $("#edit-notice-title").value.trim(), content: $("#edit-notice-content").value.trim(), visible: item.visible }).then(function () { $("#modal-root").innerHTML = ""; showToast("公告已保存"); loadAnnouncements(); }).catch(handleError); }); }
  function openUserForm(user) { var edit = Boolean(user); $("#modal-root").innerHTML = '<div class="modal-backdrop" data-action="close-modal"><div class="modal"><div class="modal-header"><h3>' + (edit ? "编辑管理员" : "添加管理员") + '</h3><button class="close-button" data-action="close-modal">×</button></div><form id="user-form" style="padding-top:18px"><div class="form-grid"><div class="form-field"><label>手机号<input id="user-phone" inputmode="numeric" maxlength="11" value="' + (edit ? esc(user.phone) : "") + '" required></label></div><div class="form-field"><label>姓名<input id="user-name" value="' + (edit ? esc(user.name) : "") + '" required></label></div></div><div class="form-actions"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button class="primary-button" type="submit">保存</button></div></form></div></div>'; $("#user-form").addEventListener("submit", function (event) { event.preventDefault(); var payload = { phone: $("#user-phone").value.trim(), name: $("#user-name").value.trim() }; var action = edit ? "adminUpdateUser" : "adminCreateUser"; if (edit) payload.id = user.id; call(action, payload).then(function (result) { $("#modal-root").innerHTML = ""; showToast(edit ? "管理员已更新" : "管理员已添加"); if (!edit && result.initialPassword) window.alert("新管理员初始密码：" + result.initialPassword + "。请安全地告知管理员并及时修改。"); loadUsers(); }).catch(handleError); }); }
  function confirmAction(message, callback) { if (window.confirm(message)) callback(); }
  function handleError(error) { var message = error && error.message ? error.message : "操作失败"; if (/登录|会话/.test(message)) logout(); else { setNotice(message); showToast(message); } }

  document.addEventListener("click", function (event) {
    var target = event.target.closest("[data-action]");
    if (!target) {
      if (event.target.closest("input[data-order-select], input[data-select-visible]")) return;
      var row = event.target.closest("tr[data-order-id]");
      if (row) openOrder(row.dataset.orderId);
      return;
    }
    var action = target.dataset.action;
    if (action === "go-orders") { state.page = "orders"; renderPage(); }
    if (action === "refresh") renderPage();
    if (action === "close-modal" && ((target.classList.contains("modal-backdrop") && event.target === target) || target.closest(".modal"))) $("#modal-root").innerHTML = "";
    if (action === "copy") copyValue(target);
    if (action === "order-status") updateOrderStatus(target.dataset.id, target.dataset.status);
    if (action === "apply-bulk-status") applyBulkOrderStatus();
    if (action === "refund-order") requestVirtualRefund(target.dataset.id);
    if (action === "refresh-refund") refreshRefundStatus(target.dataset.id, target).catch(function () {});
    if (action === "save-remark") call("adminUpdateOrder", { id: target.dataset.id, data: { adminRemark: $("#order-remark").value } }).then(function (order) { showToast("备注已保存"); openOrderModal(order); }).catch(handleError);
    if (action === "edit-notice") openNoticeEdit(target.dataset.id);
    if (action === "toggle-notice") call("toggleAnnouncementVisible", { id: target.dataset.id }).then(function () { loadAnnouncements(); }).catch(handleError);
    if (action === "delete-notice") confirmAction("确认删除这条公告吗？", function () { call("deleteAnnouncement", { id: target.dataset.id }).then(function () { showToast("公告已删除"); loadAnnouncements(); }).catch(handleError); });
    if (action === "save-services") saveServices();
    if (action === "choose-qr") chooseQr(target);
    if (action === "add-user") openUserForm();
    if (action === "edit-user") { var user = state.users.find(function (item) { return String(item.id) === String(target.dataset.id); }); if (user) openUserForm(user); }
    if (action === "reset-user") confirmAction("确认重置该管理员密码？", function () { call("adminResetUserPassword", { id: target.dataset.id }).then(function (result) { showToast("密码已重置"); if (result.initialPassword) window.alert("重置后的密码：" + result.initialPassword + "。请安全地告知管理员并及时修改。"); }).catch(handleError); });
    if (action === "delete-user") confirmAction("确认删除这个管理员账号吗？", function () { call("adminDeleteUser", { id: target.dataset.id }).then(function () { showToast("管理员已删除"); loadUsers(); }).catch(handleError); });
  });
  document.addEventListener("change", function (event) {
    var target = event.target;
    if (target.matches("[data-order-select]")) {
      toggleOrderSelection(target.dataset.orderSelect, target.checked);
    } else if (target.matches("[data-select-visible]")) {
      var checked = target.checked;
      document.querySelectorAll("[data-order-select]").forEach(function (input) { input.checked = checked; toggleOrderSelection(input.dataset.orderSelect, checked); });
    }
  });
  $("#login-form").addEventListener("submit", function (event) { event.preventDefault(); setError(""); var phone = $("#login-phone").value.trim(), password = $("#login-password").value; if (!/^1\d{10}$/.test(phone)) return setError("请输入正确的手机号"); login(phone, password).then(renderShell).catch(function (error) { console.error("乐企通后台登录失败", error); var detail = error && (error.message || error.errMsg || error.errorMessage || error.code); if (!detail && typeof error === "string") detail = error; if (!detail && error) { try { detail = JSON.stringify(error); } catch (jsonError) {} } setError(detail ? String(detail) : "登录失败，请确认云函数已部署到当前环境"); }); });
  $("#logout-button").addEventListener("click", logout); $("#menu-toggle").addEventListener("click", function () { $("#sidebar").classList.toggle("open"); }); $("#nav-list").addEventListener("click", function (event) { var item = event.target.closest(".nav-item"); if (!item || item.classList.contains("hidden")) return; state.page = item.dataset.page; setNotice(""); renderPage(); });
  initCloud().then(status).then(function (result) { if (result.authenticated && result.user) { state.user = result.user; renderShell(); } }).catch(function (error) { setNotice(error.message || "云开发初始化失败"); });
  function openOrderModal(order) {
    order = preserveConfirmedRefund(order, null);
    state.selectedOrder = order;
    var id = order.id || order._id, company = order.company || {}, annual = order.annualReportSnapshot || {}, extra = flattenExtra(order.extraInfo);
    var companyRows = [["企业名称", company.name], ["营业执照名称", company.licenseName || company.name], ["统一社会信用代码", company.creditCode], ["法定代表人/经营者", company.legalPerson], ["法人手机号", order.contactPhone || company.phone], ["企业注册地址", company.address], ["成立日期", company.establishDate], ["登记状态", company.businessStatus], ["注册资本", company.regCapital], ["所属行业", company.industry], ["注册号", company.registrationNumber], ["组织机构代码", company.organizationCode]].map(function (row) { return detailItem(row[0], row[1], id); }).join("");
    var annualRows = [["年报状态", annual.businessStatus || order.businessStatus], ["年报年份", (annual.reports || []).map(function (item) { return item.year + " " + (item.label || ""); }).join("、")]].map(function (row) { return detailItem(row[0], row[1], id); }).join("");
    var paymentDetails = [["支付方式", order.payMode === "virtual" ? "微信虚拟支付" : "收款二维码（人工核实）"], ["支付状态", orderPaymentLabel(order)], ["应付金额", "¥" + money(order.amount)], ["下单用户 OpenID", order.openid], ["业务单号", order.outTradeNo || order.orderNo], ["微信内部订单号", order.wxOrderId || order.refundWxOrderId], ["微信支付交易单号", order.wxTransactionId || order.wxpayOrderId], ["支付确认时间", order.paidAt], ["到账确认来源", order.paymentVerifySource], ["用户提交付款时间", order.userConfirmedAt]];
    if (order.payMode === "virtual" || order.paymentStatus === "refunded" || order.refundStatus) {
      paymentDetails.push(["退款状态", fmtRefundStatus(order.refundStatus)]);
      paymentDetails.push(["退款金额", order.refundAmountFen == null ? "-" : "¥" + money(Number(order.refundAmountFen) / 100)]);
      paymentDetails.push(["退款申请时间", order.refundRequestedAt]);
      paymentDetails.push(["退款完成时间", order.refundSucceededAt || order.refundedAt]);
      paymentDetails.push(["退款确认来源", order.refundConfirmationSource || (order.refundSucceededAt ? "微信回调/查单" : "")]);
      paymentDetails.push(["退款发起人", order.refundRequestedByName || order.refundRequestedByPhone]);
      paymentDetails.push(["退款单号", order.refundWxRefundId || order.refundMchRefundId || order.refundAttemptId]);
      paymentDetails.push(["退款处理说明", order.refundRequestMessage || order.refundNotifyRetMsg]);
      if (order.refundFailureCode) paymentDetails.push(["退款失败代码", order.refundFailureCode]);
    }
    var paymentRows = paymentDetails.map(function (row) { return detailItem(row[0], row[1], id); }).join("");
    var extraRows = extra.map(function (row) { return detailItem(row[0], row[1], id); }).join("");
    var statusLabels = { pending_confirm: "待审核", processing: "处理中", completed: "已完成", refunded: "已退款", cancelled: "已取消" };
    if (order.payMode === "virtual") delete statusLabels.refunded;
    var statusActions = '<div class="status-actions" style="margin-top:14px">' + Object.keys(statusLabels).map(function (status) { return '<button data-action="order-status" data-status="' + status + '" data-id="' + esc(id) + '">' + statusLabels[status] + '</button>'; }).join("") + '</div>';
    var refundInProgress = order.refundStatus === "processing" && !isRefundConfirmed(order);
    var refundRequestUnknown = order.refundStatus === "requesting";
    var refundPending = isRefundPending(order);
    var refundSucceeded = isRefundConfirmed(order);
    var iosVirtualOrder = order.payMode === "virtual" && Number(order.virtualOrderType) === 7;
    var canRequestRefund = order.payMode === "virtual" && !iosVirtualOrder && order.paymentStatus === "paid" && !refundInProgress && !refundSucceeded;
    var refundReasons = [[0, "暂无描述"], [1, "产品问题，影响使用或效果不佳"], [2, "售后问题，无法满足需求"], [3, "用户主动退款"], [4, "价格问题"], [5, "其他原因"]];
    var currentRefundReason = order.refundReason == null ? 5 : Number(order.refundReason);
    var refundGuidance = iosVirtualOrder
      ? "该订单为 iOS 虚拟支付订单，后台不能发起退款；请引导用户通过 App Store 购买记录申请。"
      : refundRequestUnknown
        ? "退款请求结果待确认。点击重试会复用原退款单号，不会新建重复退款单。最终状态以微信通知或手动查询为准。"
        : "后台按微信当前剩余可退金额全额发起退款。退款任务受理不代表已到账；最终结果以微信通知或手动查询为准。";
    var refundControls = order.payMode === "virtual" ? '<div class="refund-controls"><p class="refund-guidance">' + refundGuidance + '</p>' + (canRequestRefund ? '<div class="refund-actions"><label for="refund-reason">退款原因</label><select id="refund-reason" ' + (refundRequestUnknown ? "disabled" : "") + '>' + refundReasons.map(function (reason) { return '<option value="' + reason[0] + '" ' + (reason[0] === currentRefundReason ? "selected" : "") + '>' + esc(reason[1]) + '</option>'; }).join("") + '</select><button class="danger-button" data-action="refund-order" data-id="' + esc(id) + '">' + (refundRequestUnknown ? "重试并核对退款请求" : "发起全额退款") + '</button></div>' : '<p class="refund-state">' + (iosVirtualOrder ? "请由用户通过 App Store 申请退款。" : refundSucceeded ? "微信已确认退款完成。" : refundInProgress ? "微信退款处理中，点击下方按钮查询最新结果。" : order.refundStatus === "failed" ? (order.refundRequestMessage || "上次退款申请失败，可根据微信返回状态重试。") : refundRequestUnknown ? "退款请求结果待确认，请稍后刷新或使用原退款单号重试。" : "仅微信服务端确认已支付的虚拟支付订单可发起退款。") + '</p>') + '</div>' : "";
    if (refundPending) refundControls = refundControls.replace(/<\/div>$/, '<button class="secondary-button" data-action="refresh-refund" data-id="' + esc(id) + '">刷新退款状态</button></div>');
    $("#modal-root").innerHTML = '<div class="modal-backdrop" data-action="close-modal"><div class="modal"><div class="modal-header"><div><h3>' + esc(company.name || "订单详情") + '</h3><p class="muted">' + esc(order.orderNo) + ' · ' + esc(order.createdAt) + '</p></div><button class="close-button" data-action="close-modal" aria-label="关闭">×</button></div><div class="detail-section"><h4>订单与支付</h4><div class="detail-grid">' + paymentRows + detailItem("办理状态", fmtStatus(order.orderStatus), id) + '</div>' + refundControls + statusActions + '</div><div class="detail-section"><h4>企业与客户资料</h4><div class="detail-grid">' + companyRows + detailItem("法人身份证号码", order.idCardNo, id, true) + detailItem("业务员工号", order.staffNo, id) + detailItem("员工号校验", order.staffVerifyResult && order.staffVerifyResult.message, id) + detailItem("法人校验", order.legalVerifyResult && order.legalVerifyResult.message, id) + '</div></div><div class="detail-section"><h4>年报记录与申报数据</h4><div class="detail-grid">' + annualRows + extraRows + '</div></div><div class="detail-section"><h4>管理员备注</h4><textarea id="order-remark" class="form-field" style="width:100%;min-height:100px;padding:11px;border:1px solid var(--line);border-radius:4px" placeholder="填写办理备注">' + esc(order.adminRemark || "") + '</textarea><div class="form-actions"><button class="primary-button" data-action="save-remark" data-id="' + esc(id) + '">保存备注</button></div></div></div></div>';
  }
  function updateOrderStatus(id, statusValue) {
    if (!["pending_confirm", "processing", "completed", "refunded", "cancelled"].includes(statusValue)) return showToast("无效的订单状态");
    call("adminUpdateOrder", { id: id, data: { orderStatus: statusValue } }).then(function (updated) {
      state.orders = state.orders.map(function (order) { return String(order.id || order._id) === String(id) ? updated : order; });
      if (state.page === "orders" && $("#orders-table")) filterOrders();
      showToast("办理状态已更新");
      openOrderModal(updated);
    }).catch(handleError);
  }
  function requestVirtualRefund(id) {
    var order = state.selectedOrder, reason = Number($("#refund-reason").value), button = $("[data-action='refund-order']");
    if (!order || String(order.id || order._id) !== String(id) || !button || button.disabled) return;
    openRefundConfirmModal(id, reason, order);
  }
  function openRefundConfirmModal(id, reason, order) {
    $("#modal-root").innerHTML = '<div class="modal-backdrop" data-action="close-modal"><div class="modal refund-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="refund-confirm-title"><div class="modal-header"><div><h3 id="refund-confirm-title">确认发起退款</h3><p class="muted">' + esc(order.orderNo) + '</p></div><button class="close-button" data-action="close-modal" aria-label="关闭">×</button></div><div class="refund-confirm-summary">将按微信当前剩余可退金额全额退款，提交后退款还需等待微信处理。</div><form id="refund-confirm-form"><div class="form-field"><label for="refund-confirm-password">退款确认密码<input id="refund-confirm-password" type="password" inputmode="numeric" autocomplete="off" maxlength="64" required></label></div><p id="refund-confirm-error" class="refund-confirm-error" aria-live="polite"></p><div class="form-actions"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button id="refund-confirm-submit" class="danger-button" type="submit">确认退款</button></div></form></div></div>';
    $("#refund-confirm-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var passwordInput = $("#refund-confirm-password"), submitButton = $("#refund-confirm-submit");
      if (!passwordInput.value || submitButton.disabled) return;
      submitButton.disabled = true;
      submitButton.textContent = "正在核验并提交...";
      submitVirtualRefund(id, reason, passwordInput.value, order, passwordInput, submitButton);
    });
    $("#refund-confirm-password").focus();
  }
  function submitVirtualRefund(id, reason, password, order, passwordInput, button) {
    call("adminRequestVirtualRefund", { id: id, refundReason: reason, refundConfirmPassword: password }).then(function (result) {
      var updated = preserveConfirmedRefund(result.order || order, state.orders.find(function (item) { return String(item.id || item._id) === String(id); }));
      state.selectedOrder = updated;
      state.orders = state.orders.map(function (item) { return String(item.id || item._id) === String(id) ? updated : item; });
      if (state.page === "orders" && $("#orders-table")) filterOrders();
      showToast(result.message || "退款请求已提交");
      openOrderModal(updated);
    }).catch(function (error) {
      var detail = String(error && (error.message || error.msg || error) || "");
      if (detail.indexOf("FUNCTIONS_TIME_LIMIT_EXCEEDED") < 0) {
        var errorNode = $("#refund-confirm-error");
        if (errorNode) errorNode.textContent = detail || "退款请求失败";
        if (detail.indexOf("退款确认密码错误") >= 0) {
          passwordInput.value = "";
          passwordInput.focus();
        }
        if (/登录|会话/.test(detail)) handleError(error);
        return;
      }
      showToast("退款请求超时，正在核对退款状态");
      return call("getOrder", { id: id }).then(function (updated) {
        updated = preserveConfirmedRefund(updated, state.orders.find(function (item) { return String(item.id || item._id) === String(id); }));
        state.selectedOrder = updated;
        state.orders = state.orders.map(function (item) { return String(item.id || item._id) === String(id) ? updated : item; });
        if (state.page === "orders" && $("#orders-table")) filterOrders();
        openOrderModal(updated);
        showToast(updated && (updated.paymentStatus === "refunded" || updated.refundStatus === "succeeded")
          ? "微信已确认退款完成"
          : isRefundPending(updated)
            ? "退款仍在处理中，可稍后手动刷新；不要重复发起退款"
            : "退款结果暂未确认，请手动刷新；不要重复发起退款");
      }).catch(function () {
        $("#modal-root").innerHTML = "";
        showToast("退款请求超时，结果待核对。请刷新订单，不要再次发起退款");
      });
    }).finally(function () {
      if (button.isConnected) { button.disabled = false; button.textContent = "确认退款"; }
    });
  }
}());
