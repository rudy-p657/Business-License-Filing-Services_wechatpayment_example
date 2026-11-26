const ENV_ID = "leqitong-d6g6jkxhza53a818e";

App({
  globalData: {
    env: ENV_ID,
    cloud: null,
    cloudInitStatus: "\u7b49\u5f85\u521d\u59cb\u5316",
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error("\u8bf7\u4f7f\u7528 2.2.3 \u6216\u4ee5\u4e0a\u7684\u57fa\u7840\u5e93\u4ee5\u4f7f\u7528\u4e91\u80fd\u529b");
    } else {
      try {
        wx.cloud.init({
          env: ENV_ID,
          traceUser: true,
        });
        this.globalData.cloud = wx.cloud;
        this.globalData.cloudInitStatus = "\u5f53\u524d\u5c0f\u7a0b\u5e8f\u4e91\u73af\u5883\u5df2\u521d\u59cb\u5316";
      } catch (error) {
        this.globalData.cloudInitStatus = "wx.cloud.init \u5931\u8d25";
        console.error("\u4e91\u5f00\u53d1\u521d\u59cb\u5316\u5931\u8d25", error);
      }
    }
    this.configureTabBar();
  },

  configureTabBar() {
    if (wx.setTabBarStyle) {
      wx.setTabBarStyle({
        color: "#8A94A6",
        selectedColor: "#1677D2",
        backgroundColor: "#FFFFFF",
        borderStyle: "white",
      });
    }
    if (!wx.setTabBarItem) return;
    [
      ["pages/intro/index", "\u7b80\u4ecb", "images/icons/home.png", "images/icons/home-active-blue.png"],
      ["pages/service/index", "\u670d\u52a1", "images/icons/goods.png", "images/icons/goods-active-blue.png"],
      ["pages/mine/index", "\u6211\u7684", "images/icons/usercenter.png", "images/icons/usercenter-active-blue.png"],
    ].forEach((item, index) => wx.setTabBarItem({
      index,
      pagePath: item[0],
      text: item[1],
      iconPath: item[2],
      selectedIconPath: item[3],
    }));
  },
});
