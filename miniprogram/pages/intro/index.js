const { getShareConfig } = require("../../utils/share");

Page({
  onShareAppMessage() {
    return getShareConfig();
  },
});
