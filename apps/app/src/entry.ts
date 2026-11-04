// TIPS: 使用与主窗口完全相同的页面来源读取已有偏好，但初始化分支不加载任何会话消费者。
if (new URLSearchParams(window.location.search).get("file-context") === "1") {
  void import("./file-context");
} else {
  void import("./index.react");
}
