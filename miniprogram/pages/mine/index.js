const { getShareConfig } = require("../../utils/share");

Page({
  goOrders() {
    wx.navigateTo({
      url: "/pages/orders/index",
    });
  },

  onShareAppMessage() {
    return getShareConfig();
  },
});
