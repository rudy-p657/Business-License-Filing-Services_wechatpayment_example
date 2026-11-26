const api = require("../../utils/api");

Page({
  data: {
    company: {},
    annual: { reports: [], total: 0, businessStatus: "" },
    topReports: [],
    contactPhone: "",
    idCardNo: "",
    staffNo: "",
    isIOSPlatform: false,
    services: [],
    selectedServiceId: "",
    agreement: false,
    showAgreement: false,
    showAllReports: false,
    privacyAuthorized: false,
    businessDataLoaded: false,
    total: 0,
    totalText: "0.00",
    canSubmit: false,
    creatingOrder: false,
    showPayModal: false,
    currentOrder: null,
    confirmingPayment: false,
  },

  onLoad(options) {
    const creditCode = decodeURIComponent(options.creditCode || "");
    const company = api.getCompanyByCreditCode(creditCode);
    this.setData({ company, isIOSPlatform: api.isIOSPlatform() });
    this.checkPrivacyAuth();
  },

  checkPrivacyAuth() {
    if (!wx.getPrivacySetting) {
      this.setData({ privacyAuthorized: true }, () => this.loadBusinessData());
      return;
    }
    wx.getPrivacySetting({
      success: (res) => {
        const privacyAuthorized = !res.needAuthorization;
        this.setData({ privacyAuthorized }, () => {
          if (privacyAuthorized) this.loadBusinessData();
        });
      },
      fail: () => this.setData({ privacyAuthorized: false }),
    });
  },

  loadBusinessData() {
    if (this.data.businessDataLoaded) return;
    this.setData({ businessDataLoaded: true });
    wx.showLoading({ title: "正在加载", mask: true });
    Promise.all([api.cloudGetServices(), api.cloudGetAnnualReports(this.data.company.creditCode, this.data.company.establishDate)])
      .then(([services, annual]) => this.setData({
        services: services.map((service) => ({ ...service, priceText: Number(service.price || 0).toFixed(2) })),
        annual,
        topReports: annual.reports.slice(0, 3),
      }))
      .catch(() => wx.showToast({ title: "业务数据加载失败，请重试", icon: "none" }))
      .finally(() => wx.hideLoading());
  },

  openPrivacyContract() {
    if (!wx.openPrivacyContract) {
      wx.showToast({ title: "隐私指引暂不可用", icon: "none" });
      return;
    }
    wx.openPrivacyContract({
      fail: () => wx.showToast({ title: "隐私指引暂不可用", icon: "none" }),
    });
  },

  handlePrivacyAuthorization() {
    this.setData({ privacyAuthorized: true }, () => this.loadBusinessData());
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
    this.updateCanSubmit();
  },

  selectService(e) {
    const selectedServiceId = e.currentTarget.dataset.id;
    const service = this.data.services.find((item) => item.id === selectedServiceId);
    const total = Number(service ? service.price : 0);
    this.setData({ selectedServiceId, total, totalText: Number.isFinite(total) ? total.toFixed(2) : "0.00" });
    this.updateCanSubmit();
  },

  toggleAgreement() {
    this.setData({ agreement: !this.data.agreement });
    this.updateCanSubmit();
  },

  openAgreement() { this.setData({ showAgreement: true }); },
  closeAgreement() { this.setData({ showAgreement: false }); },
  openReportModal() { this.setData({ showAllReports: true }); },
  closeReportModal() { this.setData({ showAllReports: false }); },

  updateCanSubmit() {
    const { contactPhone, idCardNo, staffNo, selectedServiceId, agreement, total } = this.data;
    this.setData({ canSubmit: Boolean(contactPhone && idCardNo && staffNo && selectedServiceId && agreement && total > 0) });
  },

  submitOrder() {
    if (this.data.creatingOrder) return;
    if (!this.data.privacyAuthorized) {
      wx.showToast({ title: "请先阅读并同意隐私指引", icon: "none" });
      return;
    }
    if (!this.data.canSubmit) {
      wx.showToast({ title: "请补全资料并选择已定价服务", icon: "none" });
      return;
    }
    if (!/^1\d{10}$/.test(String(this.data.contactPhone))) {
      wx.showToast({ title: "请输入正确的手机号", icon: "none" });
      return;
    }
    const idCardNo = String(this.data.idCardNo || "").trim();
    if (!/^\d{17}[\dXx]$/.test(idCardNo)) {
      wx.showToast({ title: "身份证需填写18位，最后一位可为X", icon: "none" });
      return;
    }
    if (!api.checkIdCard(idCardNo)) {
      wx.showToast({ title: "身份证校验码不正确，请检查最后一位", icon: "none" });
      return;
    }
    this.setData({ creatingOrder: true });
    wx.showLoading({ title: "正在创建订单...", mask: true });
    api.cloudCreateOrder({
      company: this.data.company,
      contactPhone: this.data.contactPhone,
      idCardNo: this.data.idCardNo,
      staffNo: this.data.staffNo,
      serviceId: this.data.selectedServiceId,
      annualReportSnapshot: this.data.annual,
    }).then((result) => {
      if (!result.ok) {
        wx.showToast({ title: result.message || "下单失败", icon: "none" });
        return;
      }
      if (result.payMode === "virtual" && this.data.isIOSPlatform && !api.isIOSVirtualPaymentVersionSupported()) {
        this.setData({ currentOrder: result.order, showPayModal: false });
        wx.hideLoading();
        wx.redirectTo({ url: `/pages/order-detail/index?id=${result.order.id}&pay=1` });
        return;
      }
      if (result.payMode === "virtual") {
        this.setData({ currentOrder: result.order, showPayModal: false });
        wx.hideLoading();
        this.startVirtualPayment(result.order, result.payData);
        return;
      }
      this.setData({ currentOrder: result.order, showPayModal: true });
    }).catch((error) => {
      wx.showToast({ title: error.message || "下单失败，请重试", icon: "none" });
    }).finally(() => {
      wx.hideLoading();
      this.setData({ creatingOrder: false });
    });
  },

  startVirtualPayment(order, payData) {
    api.cloudStartVirtualPayment(order.id, payData).then((result) => {
      const latestOrder = result.order || order;
      this.setData({ currentOrder: latestOrder, showPayModal: false });
      const requestError = result.requestError;
      const wasCancelled = Boolean(requestError && /cancel/i.test(String(requestError.errMsg || requestError.message || "")));
      const needsOfflineContact = this.data.isIOSPlatform && latestOrder.paymentStatus !== "paid" && requestError && !wasCancelled;
      if (latestOrder.paymentStatus === "paid") {
        wx.showToast({ title: "支付成功", icon: "success" });
      } else if (wasCancelled) {
        wx.showToast({ title: "已取消支付，订单仍可继续支付", icon: "none" });
      } else if (needsOfflineContact) {
        wx.showToast({ title: "线上支付暂不可用，请联系工作人员", icon: "none" });
      } else if (latestOrder.virtualOrderFound === false && result.requestError) {
        wx.showToast({ title: "微信未生成支付单，请确认未扣款后重试", icon: "none" });
      } else if (latestOrder.virtualOrderFound === false) {
        wx.showToast({ title: "微信暂未返回支付单，请勿重复支付，稍后刷新订单", icon: "none" });
      } else {
        wx.showToast({ title: "支付结果暂未确认，请在订单详情查看", icon: "none" });
      }
      const contactParam = needsOfflineContact ? "&contact=1" : "";
      setTimeout(() => wx.redirectTo({ url: `/pages/order-detail/index?id=${order.id}${contactParam}` }), 700);
    }).catch((error) => {
      if (this.data.isIOSPlatform) {
        wx.showToast({ title: "线上支付暂不可用，请联系工作人员", icon: "none" });
        setTimeout(() => wx.redirectTo({ url: `/pages/order-detail/index?id=${order.id}&contact=1` }), 700);
      } else {
        wx.showToast({ title: error.message || "支付结果暂未确认，请在订单详情查看", icon: "none" });
        setTimeout(() => wx.redirectTo({ url: `/pages/order-detail/index?id=${order.id}` }), 700);
      }
    });
  },

  previewQr() {
    const order = this.data.currentOrder;
    const src = order && order.paymentQrUrl;
    if (!src) {
      wx.showToast({ title: "收款二维码尚未配置", icon: "none" });
      return;
    }
    wx.previewImage({ current: src, urls: [src] });
  },

  saveQr() {
    const order = this.data.currentOrder;
    const src = order && order.paymentQrUrl;
    if (!src) {
      wx.showToast({ title: "收款二维码尚未配置", icon: "none" });
      return;
    }
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
    this.setData({ "currentOrder.paymentQrAvailable": false });
    wx.showToast({ title: "收款二维码加载失败，请联系客服", icon: "none" });
  },

  confirmPaid() {
    const order = this.data.currentOrder;
    if (!order || !order.paymentQrAvailable || this.data.confirmingPayment) {
      if (order && !order.paymentQrAvailable) wx.showToast({ title: "收款二维码暂不可用", icon: "none" });
      return;
    }
    this.setData({ confirmingPayment: true });
    api.cloudConfirmPayment(order.id)
      .then(() => {
        wx.showToast({ title: "已提交付款信息，等待管理员核实", icon: "none" });
        setTimeout(() => wx.redirectTo({ url: `/pages/order-detail/index?id=${order.id}` }), 600);
      })
      .catch((error) => wx.showToast({ title: error.message || "提交失败，请重试", icon: "none" }))
      .finally(() => this.setData({ confirmingPayment: false }));
  },

  closePay() { this.setData({ showPayModal: false }); },
});
