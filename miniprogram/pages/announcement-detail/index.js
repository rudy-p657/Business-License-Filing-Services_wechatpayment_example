const api = require("../../utils/api");

Page({
  data: {
    announcement: null,
    isLoading: true,
    loadError: "",
  },

  onLoad(options) {
    const id = String(options.id || "").trim();
    if (!id) {
      this.setData({ isLoading: false, loadError: "公告参数无效，请返回后重新打开" });
      return;
    }
    this.noticeId = id;
    this.loadAnnouncement();
  },

  loadAnnouncement() {
    const id = this.noticeId;
    const cached = api.getCachedAnnouncementById(id);
    if (cached) this.renderAnnouncement(cached);
    this.setData({ isLoading: !cached, loadError: "" });

    api.cloudGetAnnouncementById(id).then((announcement) => {
      if (announcement) return announcement;
      return api.cloudGetAnnouncements().then((list) => list.find((item) => String(item.id) === id) || null);
    }).then((announcement) => {
      if (!announcement) {
        if (this.data.announcement) {
          this.setData({ isLoading: false });
          return;
        }
        this.setData({ isLoading: false, loadError: "公告不存在或已下线" });
        return;
      }
      this.renderAnnouncement(announcement);
      this.setData({ isLoading: false, loadError: "" });
    }).catch((error) => {
      console.error("公告详情加载失败", error);
      this.setData({
        isLoading: false,
        loadError: this.data.announcement ? "网络刷新失败，当前显示已缓存内容" : "公告加载失败，请检查网络后重试",
      });
    });
  },

  retryLoad() {
    this.loadAnnouncement();
  },

  renderAnnouncement(announcement) {
    const title = String(announcement.title || "公告");
    wx.setNavigationBarTitle({
      title: title.length > 10 ? `${title.slice(0, 10)}...` : title,
    });
    this.setData({
      announcement: {
        ...announcement,
        title,
        content: String(announcement.content || "公告正文暂未配置").trim() || "公告正文暂未配置",
      },
    });
  },
});
