const EXPECTED_APP_ID = "wxea057c4e1a922c05";
const EXPECTED_ENV_ID = "leqitong-d6g6jkxhza53a818e";

Page({
  data: {
    appId: "读取中",
    envId: "读取中",
    appIdCheck: "",
    envIdCheck: "",
    cloudInitStatus: "等待初始化",
    cloudAvailable: false,
    status: "尚未测试",
    detail: "",
    testing: false,
  },

  onLoad() {
    let appId = "读取失败";
    try {
      appId = wx.getAccountInfoSync().miniProgram.appId;
    } catch (error) {
      appId = error.message || String(error);
    }

    const app = getApp();
    const envId = app.globalData && app.globalData.env || "未配置";
    this.setData({
      appId,
      envId,
      appIdCheck: appId === EXPECTED_APP_ID ? "一致" : `不一致，预期 ${EXPECTED_APP_ID}`,
      envIdCheck: envId === EXPECTED_ENV_ID ? "一致" : `不一致，预期 ${EXPECTED_ENV_ID}`,
      cloudInitStatus: app.globalData && app.globalData.cloudInitStatus || "未知",
      cloudAvailable: Boolean(app.globalData && app.globalData.cloud && app.globalData.cloud.callFunction),
    });
  },

  runProbe() {
    if (this.data.testing) return;

    this.setData({ testing: true, status: "正在调用云函数", detail: "" });
    const app = getApp();
    const cloud = app.globalData && app.globalData.cloud;
    if (!cloud || !cloud.callFunction) {
      this.setData({
        testing: false,
        status: "云开发不可用",
        detail: "当前小程序云环境客户端未初始化，请检查 app.js 中的 wx.cloud.init 配置。",
      });
      return;
    }

    this.setData({ status: "正在调用当前云环境", detail: `环境：${EXPECTED_ENV_ID}\n正在发送只读探针。` });
    cloud.callFunction({
      name: "leqitong",
      data: { action: "__leqitong_environment_probe__" },
    }).then((response) => {
      const result = response && response.result;
      const message = result && result.message;
      if (message === "unknown action") {
        this.setData({
          testing: false,
          status: "环境与函数调用已通",
          detail: "探针 action 被云函数正常接收；unknown action 是预期返回，没有修改数据。",
        });
        return;
      }

      this.setData({
        testing: false,
        status: "请求已到达函数，但返回内容不同",
        detail: JSON.stringify(result || response),
      });
    }).catch((error) => {
      const code = error && (error.errCode || error.code);
      const message = error && (error.errMsg || error.message) || String(error);
      let status = "云函数调用失败";
      if (String(code) === "-501000" || /Environment not found/i.test(message)) {
        status = "当前云环境无法访问：请求未到达云函数";
      } else if (/function.*not found|未找到.*function|未找到云函数/i.test(message)) {
        status = "环境可达，但当前环境未找到 leqitong";
      }

      this.setData({
        testing: false,
        status,
        detail: `${code ? `${code}: ` : ""}${message}`,
      });
      console.error("Cloud environment probe failed", error);
    });
  },
});
