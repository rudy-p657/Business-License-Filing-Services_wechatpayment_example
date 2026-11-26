const api = require("../../utils/api");

Page({
  data: {
    keyword: "",
    announcements: [],
    advantages: api.advantages,
    services: [],
    showPrivacy: false,
    pendingSearch: false,
  },

  onLoad() {
    Promise.all([api.cloudGetServices(), api.cloudGetAnnouncements()]).then(([services, announcements]) => {
      this.setData({ services, announcements: announcements.slice(0, 3) });
    });
  },

  onShow() {
    Promise.all([api.cloudGetServices(), api.cloudGetAnnouncements()]).then(([services, announcements]) => {
      this.setData({ services, announcements: announcements.slice(0, 3) });
    });
    this.checkPrivacyAuth();
  },

  onInput(e) {
    this.setData({
      keyword: e.detail.value,
    });
  },

  onSearch() {
    if (wx.getPrivacySetting) {
      wx.getPrivacySetting({
        success: (res) => {
          if (res.needAuthorization) {
            this.setData({
              pendingSearch: true,
              showPrivacy: true,
            });
            return;
          }
          this.proceedSearch();
        },
        fail: () => this.proceedSearch(),
      });
      return;
    }
    this.proceedSearch();
  },

  proceedSearch() {
    const keyword = this.data.keyword.trim();
    if (!keyword) {
      wx.showToast({ title: "请输入查询内容", icon: "none" });
      return;
    }
    if (!/^1\d{10}$/.test(keyword) && keyword.length < 2) {
      wx.showToast({ title: "关键词过短", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/results/index?keyword=${encodeURIComponent(keyword)}`,
    });
  },

  checkPrivacyAuth() {
    if (!wx.getPrivacySetting) {
      return;
    }
    wx.getPrivacySetting({
      success: (res) => {
        if (res.needAuthorization) {
          this.setData({ showPrivacy: true });
        }
      },
    });
  },

  openPrivacyContract() {
    if (!wx.openPrivacyContract) {
      return;
    }
    wx.openPrivacyContract({
      fail: () => wx.showToast({ title: "未能打开隐私协议", icon: "none" }),
    });
  },

  handleAgree() {
    const shouldSearch = this.data.pendingSearch;
    this.setData({
      showPrivacy: false,
      pendingSearch: false,
    });
    if (shouldSearch) {
      this.proceedSearch();
    }
  },

  handleDisagree() {
    this.setData({
      showPrivacy: false,
      pendingSearch: false,
    });
    wx.showToast({ title: "需要同意隐私指引后使用业务", icon: "none" });
  },

  goAnnouncementList() {
    wx.navigateTo({
      url: "/pages/announcement-list/index",
    });
  },

  goAnnouncementDetail(e) {
    wx.navigateTo({
      url: `/pages/announcement-detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },
});
