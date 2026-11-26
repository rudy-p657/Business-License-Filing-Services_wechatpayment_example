const api = require("../../utils/api");
const STATUS_TEXT = { pending_payment: "待支付", pending_confirm: "待审核", processing: "处理中", completed: "已完成", cancelled: "已取消", refunded: "已退款" };
const PAYMENT_TEXT = { unpaid: "未支付", paid: "已支付", confirmed_by_user: "待管理员核实", confirmed_by_admin: "已人工核实", refunded: "已退款", cancelled: "已关闭" };
const REFUND_STATUS_TEXT = { requesting: "退款结果待确认", processing: "退款处理中", succeeded: "已退款", failed: "退款失败" };

function presentOrder(order) {
  if (order.paymentStatus === "refunded" || order.refundStatus === "succeeded" || order.orderStatus === "refunded" || order.refundSucceededAt || order.refundedAt || (Number(order.refundNotifyRetCode) === 0 && order.refundNotifyAt)) {
    order = { ...order, paymentStatus: "refunded", orderStatus: "refunded", refundStatus: "succeeded" };
  }
  const refundStatusText = REFUND_STATUS_TEXT[order.refundStatus] || "";
  return {
    order,
    statusText: STATUS_TEXT[order.orderStatus] || order.orderStatus,
    paymentStatusText: refundStatusText || PAYMENT_TEXT[order.paymentStatus] || order.paymentStatus || "未记录",
    refundStatusText,
    refundPending: order.payMode === "virtual" && order.paymentStatus === "paid" && ["requesting", "processing"].includes(order.refundStatus),
  };
}

Page({
  data: { id: "", order: null, statusText: "", paymentStatusText: "", refundStatusText: "", refundPending: false, refreshingRefund: false, showPayModal: false, showIOSPaymentModal: false, iosPaymentFallbackMessage: "线上支付暂不可用，请联系工作人员核对订单后确认线下付款方式。若您已扣款，请先不要重复支付。", confirmingPayment: false, cancellingOrder: false, autoOpenPay: false, autoOpenContactModal: false, isIOSPlatform: false, iosVirtualPaymentSupported: true },
  onLoad(options) { this.setData({ id: options.id || "", autoOpenPay: options.pay === "1", autoOpenContactModal: options.contact === "1", isIOSPlatform: api.isIOSPlatform(), iosVirtualPaymentSupported: api.isIOSVirtualPaymentVersionSupported() }); },
  onShow() { this._isVisible = true; this.loadOrder(); },
  onHide() { this._isVisible = false; },
  onUnload() { this._isVisible = false; },
  loadOrder() {
    if (!this.data.id) return;
    api.cloudGetOrderById(this.data.id).then((order) => {
      this.setData(presentOrder(order), () => {
        if (this.data.autoOpenPay) {
          this.setData({ autoOpenPay: false });
          this.openPay();
        } else if (this.data.autoOpenContactModal) {
          this.setData({ autoOpenContactModal: false, showIOSPaymentModal: true });
        }
      });
    }).catch(() => wx.showToast({ title: "订单加载失败，请重试", icon: "none" }));
  },
  queryRefundState() {
    if (!this.data.order || !this.data.refundPending) return Promise.resolve(this.data.order);
    if (this._refundQueryInFlight) return Promise.resolve(this.data.order);
    this._refundQueryInFlight = true;
    this.setData({ refreshingRefund: true });
    return api.cloudReconcileVirtualPayOrder(this.data.id).then((updated) => {
      this.setData(presentOrder(updated));
      const message = updated.paymentStatus === "refunded" || updated.refundStatus === "succeeded"
        ? "微信已确认退款成功"
        : updated.refundStatus === "failed"
          ? "微信返回退款失败"
          : "退款仍在处理中";
      wx.showToast({ title: message, icon: "none" });
      return updated;
    }).catch((error) => {
      wx.showToast({ title: error.message || "查询失败，请稍后重试", icon: "none" });
      throw error;
    }).finally(() => {
      this._refundQueryInFlight = false;
      this.setData({ refreshingRefund: false });
    });
  },
  refreshRefundState() { this.queryRefundState().catch(() => null); },
  applyOrder(order) { this.setData(presentOrder(order)); },
  openPay() {
    if (!this.data.order || this.data.order.orderStatus !== "pending_payment") return;
    if (this.data.isIOSPlatform && this.data.order.payMode === "virtual" && !this.data.iosVirtualPaymentSupported) {
      this.setData({
        showIOSPaymentModal: true,
        iosPaymentFallbackMessage: "iOS 虚拟支付要求微信客户端 8.0.68 及以上版本。请升级微信后重试，或联系工作人员确认线下付款方式。",
      });
      return;
    }
    if (this.data.order.payMode === "virtual") {
      this.startVirtualPayment(this.data.order);
      return;
    }
    this.setData({ showPayModal: true });
  },
  closeIOSPaymentModal() { this.setData({ showIOSPaymentModal: false }); },
  noop() {},
  cancelOrder() {
    const order = this.data.order;
    if (!order || order.orderStatus !== "pending_payment" || this.data.cancellingOrder) return;
    wx.showModal({
      title: "取消订单",
      content: "确定取消这笔未支付订单吗？取消后不能继续支付。",
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ cancellingOrder: true });
        api.cloudCancelMyOrder(order.id).then((updated) => {
          this.setData({
            order: updated,
            statusText: STATUS_TEXT[updated.orderStatus] || updated.orderStatus,
            paymentStatusText: PAYMENT_TEXT[updated.paymentStatus] || updated.paymentStatus || "未记录",
          });
          wx.showToast({ title: "订单已取消", icon: "success" });
        }).catch((error) => wx.showToast({ title: error.message || "取消失败，请刷新重试", icon: "none" }))
          .finally(() => this.setData({ cancellingOrder: false }));
      },
    });
  },
  startVirtualPayment(order) {
    if (this.data.confirmingPayment) return;
    this.setData({ confirmingPayment: true });
    api.cloudPrepareVirtualPayment(order.id)
      .then((payData) => payData && payData.stateChanged
        ? payData
        : api.cloudStartVirtualPayment(order.id, payData))
      .then((result) => {
        const latestOrder = result.order || order;
        this.applyOrder(latestOrder);
        if (result.stateChanged && latestOrder.paymentStatus === "cancelled") {
          wx.showToast({ title: "订单已取消，请重新下单", icon: "none" });
        } else if (result.stateChanged && latestOrder.paymentStatus === "paid") {
          wx.showToast({ title: "订单已支付，无需重复支付", icon: "none" });
        } else if (result.stateChanged) {
          wx.showToast({ title: "订单状态已更新，请重新打开订单", icon: "none" });
        } else if (latestOrder.paymentStatus === "paid") {
          wx.showToast({ title: "支付成功", icon: "success" });
        } else if (result.requestError && /cancel/i.test(String(result.requestError.errMsg || result.requestError.message || ""))) {
          wx.showToast({ title: "已取消支付，订单仍可继续支付", icon: "none" });
        } else if (this.data.isIOSPlatform && result.requestError) {
          this.setData({
            showIOSPaymentModal: true,
            iosPaymentFallbackMessage: "本次线上支付未能完成。请联系工作人员核对订单后确认线下付款方式；若您已扣款，请先不要重复支付。",
          });
        } else if (latestOrder.virtualOrderFound === false && result.requestError) {
          wx.showToast({ title: "微信未生成支付单，请确认未扣款后重试", icon: "none" });
        } else if (latestOrder.virtualOrderFound === false) {
          wx.showToast({ title: "微信暂未返回支付单，请勿重复支付，稍后刷新订单", icon: "none" });
        } else {
          wx.showToast({ title: "支付结果暂未确认，请稍后刷新", icon: "none" });
        }
      })
      .catch((error) => {
        if (this.data.isIOSPlatform) {
          this.setData({
            showIOSPaymentModal: true,
            iosPaymentFallbackMessage: "本次线上支付状态暂未确认。请联系工作人员核对订单；若您已扣款，请先不要重复支付。",
          });
        }
        wx.showToast({ title: error.message || "暂时无法发起支付", icon: "none" });
      })
      .finally(() => this.setData({ confirmingPayment: false }));
  },
  closePay() { this.setData({ showPayModal: false }); },
  previewQr() {
    const src = this.data.order && this.data.order.paymentQrUrl;
    if (!src) return wx.showToast({ title: "收款二维码尚未配置", icon: "none" });
    wx.previewImage({ current: src, urls: [src] });
  },
  saveQr() {
    const src = this.data.order && this.data.order.paymentQrUrl;
    if (!src) return wx.showToast({ title: "收款二维码尚未配置", icon: "none" });
    wx.getImageInfo({
      src,
      success: (res) => wx.saveImageToPhotosAlbum({
        filePath: res.path,
        success: () => wx.showToast({ title: "已保存" }),
        fail: () => wx.showToast({ title: "请在预览图片中保存", icon: "none" }),
      }),
      fail: () => wx.showToast({ title: "请在预览图片中保存", icon: "none" }),
    });
  },
  onQrError() {
    this.setData({ "order.paymentQrAvailable": false });
    wx.showToast({ title: "收款二维码加载失败，请联系客服", icon: "none" });
  },
  confirmPaid() {
    const order = this.data.order;
    if (!order || !order.paymentQrAvailable || this.data.confirmingPayment) {
      if (order && !order.paymentQrAvailable) wx.showToast({ title: "收款二维码暂不可用", icon: "none" });
      return;
    }
    this.setData({ confirmingPayment: true });
    api.cloudConfirmPayment(order.id)
      .then((updated) => {
        this.setData({
          order: updated,
          statusText: STATUS_TEXT[updated.orderStatus] || updated.orderStatus,
          paymentStatusText: REFUND_STATUS_TEXT[updated.refundStatus] || PAYMENT_TEXT[updated.paymentStatus] || updated.paymentStatus || "未记录",
          refundStatusText: REFUND_STATUS_TEXT[updated.refundStatus] || "",
          refundPending: updated.payMode === "virtual" && updated.paymentStatus === "paid" && ["requesting", "processing"].includes(updated.refundStatus),
          showPayModal: false,
        });
        wx.showToast({ title: "已提交付款信息，等待管理员核实", icon: "none" });
      })
      .catch((error) => wx.showToast({ title: error.message || "提交失败，请重试", icon: "none" }))
      .finally(() => this.setData({ confirmingPayment: false }));
  },
});
