const api = require("../../utils/api");

const STATUS_TEXT = { pending_payment: "待支付", pending_confirm: "待审核", processing: "处理中", completed: "已完成", cancelled: "已取消", refunded: "已退款" };
const SERVICE_TEXT = { queued: "排队待处理", processing: "正在处理中", completed: "办理已完成" };
const REFUND_STATUS_TEXT = { requesting: "退款结果待确认", processing: "退款处理中", succeeded: "已退款", failed: "退款失败" };

function presentOrder(item) {
  if (item.paymentStatus === "refunded" || item.refundStatus === "succeeded" || item.orderStatus === "refunded" || item.refundSucceededAt || item.refundedAt || (Number(item.refundNotifyRetCode) === 0 && item.refundNotifyAt)) {
    item = { ...item, paymentStatus: "refunded", orderStatus: "refunded", refundStatus: "succeeded" };
  }
  return {
    ...item,
    statusText: STATUS_TEXT[item.orderStatus] || item.orderStatus,
    serviceText: SERVICE_TEXT[item.serviceStatus] || SERVICE_TEXT.queued,
    refundStatusText: REFUND_STATUS_TEXT[item.refundStatus] || "",
    refundPending: item.payMode === "virtual" && item.paymentStatus === "paid" && ["requesting", "processing"].includes(item.refundStatus),
    needExtra: ["confirmed_by_admin", "paid"].includes(item.paymentStatus) && !item.extraInfo,
    remarkText: item.adminRemark || "暂无备注",
  };
}

Page({
  data: { orders: [], isLoading: false, loadError: "", showExtraModal: false, currentOrderId: "", cancellingOrderId: "", refreshingRefundId: "", extraForm: { revenue: "", tax: "", employeeCount: "" } },

  onShow() {
    this.loadOrders();
  },
  loadOrders() {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true, loadError: "" });
    api.cloudGetMyOrders().then((list) => {
      this.setData({ orders: list.map(presentOrder) });
    }).catch(() => {
      this.setData({ loadError: "订单加载失败，请重新加载" });
    }).finally(() => this.setData({ isLoading: false }));
  },
  goDetail(e) { wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}` }); },
  goService() { wx.switchTab({ url: "/pages/service/index" }); },
  goPay(e) { wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&pay=1` }); },
  refreshRefundState(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.refreshingRefundId) return;
    this.setData({ refreshingRefundId: id });
    api.cloudReconcileVirtualPayOrder(id).then((updated) => {
      this.setData({ orders: this.data.orders.map((item) => String(item.id || item._id) === String(id) ? presentOrder(updated) : item) });
      const message = updated.paymentStatus === "refunded" || updated.refundStatus === "succeeded"
        ? "微信已确认退款成功"
        : updated.refundStatus === "failed"
          ? "微信返回退款失败"
          : "退款仍在处理中";
      wx.showToast({ title: message, icon: "none" });
    }).catch((error) => wx.showToast({ title: error.message || "查询失败，请稍后重试", icon: "none" }))
      .finally(() => this.setData({ refreshingRefundId: "" }));
  },
  cancelOrder(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.cancellingOrderId) return;
    wx.showModal({
      title: "取消订单",
      content: "确定取消这笔未支付订单吗？取消后不能继续支付。",
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ cancellingOrderId: id });
        api.cloudCancelMyOrder(id).then((updated) => {
          const orders = this.data.orders.map((item) => item.id === id ? { ...presentOrder(updated), needExtra: false } : item);
          this.setData({ orders });
          wx.showToast({ title: "订单已取消", icon: "success" });
        }).catch((error) => wx.showToast({ title: error.message || "取消失败，请刷新重试", icon: "none" }))
          .finally(() => this.setData({ cancellingOrderId: "" }));
      },
    });
  },
  openExtraModal(e) { this.setData({ currentOrderId: e.currentTarget.dataset.id, showExtraModal: true, extraForm: { revenue: "", tax: "", employeeCount: "" } }); },
  closeExtraModal() { this.setData({ showExtraModal: false, currentOrderId: "" }); },
  onExtraInput(e) { this.setData({ [`extraForm.${e.currentTarget.dataset.field}`]: e.detail.value }); },
  submitExtraInfo() {
    const { revenue, tax, employeeCount } = this.data.extraForm;
    if (revenue === "" || tax === "" || employeeCount === "") { wx.showToast({ title: "请填写完整信息", icon: "none" }); return; }
    api.cloudUpdateOrderExtra(this.data.currentOrderId, this.data.extraForm).then(() => { wx.showToast({ title: "资料补充成功" }); this.closeExtraModal(); this.loadOrders(); });
  },
  noop() {},
});
