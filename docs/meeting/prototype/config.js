// 仅为 UI 原型的配置占位。用户提供 AppID 后再接入正式配置系统。
// AppID 是公开应用标识；ServerSecret / AppSign 必须仅保存在服务端。
window.MEETING_CONFIG = Object.freeze({
  demo: true,
  zego: { appId: null },
  // 正式开发时配置业务服务，由服务端鉴权后签发短期 RTC token。
  meetingApiBaseUrl: '',
});
