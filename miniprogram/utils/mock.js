// A real collection QR code is configured per service in the Web admin console.
const defaultPaymentQr = "";

const services = [
  {
    id: "annual_1",
    name: "一年期年报补录（不通过退费）",
    shortName: "一年期年报补录",
    price: 298,
    refundNote: "不通过退费",
    paymentQr: defaultPaymentQr,
    description: "适用于一年未按时报送年报的企业或个体工商户",
  },
  {
    id: "annual_2",
    name: "二年期年报补录（不通过退费）",
    shortName: "二年期年报补录",
    price: 398,
    refundNote: "价格待确认",
    paymentQr: defaultPaymentQr,
    description: "价格等待客户最终确认，后台可直接修改",
  },
  {
    id: "annual_cancel",
    name: "年报补录+在线作废（不通过退费）",
    shortName: "年报补录+在线作废",
    price: 498,
    refundNote: "价格待确认",
    paymentQr: defaultPaymentQr,
    description: "适用于年报补录及异常/作废处理类业务",
  },
];

const companies = [
  {
    id: "c001",
    name: "东莞张华服饰有限公司",
    legalPerson: "张华",
    establishDate: "20131126",
    creditCode: "91441900084505793E",
    businessStatus: "正常",
    phone: "15777958382",
  },
  {
    id: "c002",
    name: "中科利华建筑工程股份有限公司",
    legalPerson: "张华",
    establishDate: "20140417",
    creditCode: "9141010009811438X6",
    businessStatus: "正常",
    phone: "13800138000",
  },
  {
    id: "c003",
    name: "河南卓远消防安装工程有限公司",
    legalPerson: "张华",
    establishDate: "20120419",
    creditCode: "914117005948503356",
    businessStatus: "正常",
    phone: "13900139000",
  },
  {
    id: "c004",
    name: "云南大未来置业管理有限公司",
    legalPerson: "张华",
    establishDate: "20130219",
    creditCode: "91530100061573726E",
    businessStatus: "正常",
    phone: "13600136000",
  },
  {
    id: "c005",
    name: "承德高博机械设备安装有限公司",
    legalPerson: "张华",
    establishDate: "20181220",
    creditCode: "91130803MA0D4B8J74",
    businessStatus: "正常",
    phone: "13500135000",
  },
  {
    id: "c006",
    name: "河北张华酿酒集团公司",
    legalPerson: "王凯",
    establishDate: "19920914",
    creditCode: "911301001043280118",
    businessStatus: "正常",
    phone: "13700137000",
  },
];

const annualReports = [
  { year: "2025", submitted: true, label: "已年报" },
  { year: "2024", submitted: true, label: "已年报" },
  { year: "2023", submitted: true, label: "已年报" },
  { year: "2022", submitted: true, label: "已年报" },
  { year: "2021", submitted: true, label: "已年报" },
  { year: "2020", submitted: true, label: "已年报" },
];

const announcements = [
  {
    id: "notice_001",
    title: "未按时年报有何影响？",
    date: "2026-04-10",
    publishedAt: "2026-04-10 16:12",
    visible: true,
    content: "企业、个体工商户未按规定期限报送年度报告，可能会被列入经营异常名录，并向社会公示。\n\n被列入经营异常名录后，企业在贷款、招投标、政府采购、资质办理、合作洽谈等场景中都可能受到影响。建议在规定期限内及时完成申报。",
  },
  {
    id: "notice_002",
    title: "哪些企业需要年报？",
    date: "2026-04-10",
    publishedAt: "2026-04-10 16:01",
    visible: true,
    content: "凡是在上一年度12月31日前登记注册的企业、个体工商户、农民专业合作社等市场主体，通常都需要按规定报送年度报告。\n\n具体申报范围、申报时间和填报要求，以当地市场监督管理部门和国家企业信用信息公示系统提示为准。",
  },
  {
    id: "notice_003",
    title: "什么是年报?为什么要按时申报?",
    date: "2026-04-10",
    publishedAt: "2026-04-10 15:56",
    visible: true,
    content: "—企业年报—\n\n2024年1月1日前登记注册的企业、个体工商户，应当于每年规定时限内向市场监督管理部门报送上一年的年度报告，否则将被列入经营异常名录，并向社会公示。可通过国家企业信息信用公示系统或辖区市监局免费报送。\n\n年报是市监部门组织开展的企业年度报告公示制度。通过年报，可以让社会公众与合作伙伴了解企业的经营情况，保障交易安全；而企业通过年报，可向外界展现企业的实力与诚信经营的形象，利于企业的长远发展。\n\n注：企业及个体工商户等可通过国家企业信息信用公示系统或辖区市监局免费报送!!",
  },
];

const advantages = [
  { title: "服务专业", desc: "执照申报·注销·异常处理" },
  { title: "全程人工", desc: "材料指导·一站式办理" },
  { title: "进度透明", desc: "订单状态实时跟踪" },
  { title: "价格透明", desc: "项目明码标价，服务清晰" },
];

const staffCodes = [
  { code: "5466", name: "默认业务员", enabled: true },
  { code: "1001", name: "测试业务员", enabled: true },
  { code: "8888", name: "演示业务员", enabled: true },
];

module.exports = {
  defaultPaymentQr,
  services,
  companies,
  annualReports,
  announcements,
  advantages,
  staffCodes,
};
