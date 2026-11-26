const api = require("../../utils/api");

Page({
  data: {
    announcements: [],
    isLoading: true,
    loadError: "",
  },

  onShow() {
    this.setData({ isLoading: true, loadError: "" });
    api.cloudGetAnnouncements().then((announcements) => {
      this.setData({ announcements, isLoading: false });
    }).catch((error) => {
      console.error("公告列表加载失败", error);
      this.setData({ isLoading: false, loadError: "公告加载失败，请检查网络后重试" });
    });
  },

  retryLoad() {
    this.onShow();
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/announcement-detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },
});
