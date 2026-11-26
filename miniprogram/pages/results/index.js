const api = require("../../utils/api");

Page({
  data: {
    keyword: "",
    companies: [],
  },

  onLoad(options) {
    const keyword = decodeURIComponent(options.keyword || "");
    this.setData({
      keyword,
    });
    wx.showLoading({ title: "正在查询", mask: true });
    api.cloudSearchCompanies(keyword).then((companies) => {
      this.setData({ companies });
    }).finally(() => wx.hideLoading());
  },

  goBusiness(e) {
    const creditCode = e.currentTarget.dataset.code;
    wx.navigateTo({
      url: `/pages/business/index?creditCode=${encodeURIComponent(creditCode)}`,
    });
  },
});
