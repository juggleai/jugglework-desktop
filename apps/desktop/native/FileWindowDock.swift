import AppKit

private struct DocumentWindow: Decodable {
    let id: Int
    let title: String
}
private struct WindowState: Decodable { let windows: [DocumentWindow] }

/// 文档 Dock 入口：只将激活和关闭请求交给主进程，不加载编辑器。
private final class DocumentDock: NSObject, NSApplicationDelegate {
    private var windows: [DocumentWindow] = []
    private var parentExited = false

    private func send(_ action: String, windowID: Int? = nil) {
        var event: [String: Any] = ["action": action]
        if let id = windowID { event["windowId"] = id }
        if let data = try? JSONSerialization.data(withJSONObject: event) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let root = NSMenuItem()
        let appMenu = NSMenu()
        let show = NSMenuItem(title: "显示 JuggleWork 文件浏览器", action: #selector(showDocuments), keyEquivalent: "")
        show.target = self
        appMenu.addItem(show)
        appMenu.addItem(.separator())
        let quit = NSMenuItem(title: "退出 JuggleWork 文件浏览器", action: #selector(closeDocuments), keyEquivalent: "q")
        quit.target = self
        appMenu.addItem(quit)
        root.submenu = appMenu
        menu.addItem(root)
        NSApp.mainMenu = menu
        // TIPS: 父进程退出会关闭管道，入口随即退出，避免残留 Dock 图标。
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let state = try? JSONDecoder().decode(WindowState.self, from: data) else { continue }
                DispatchQueue.main.async { self?.windows = state.windows }
            }
            DispatchQueue.main.async {
                self?.parentExited = true
                NSApp.terminate(nil)
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        send("activate")
        return false
    }

    func applicationDidBecomeActive(_ notification: Notification) { send("activate") }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        for window in windows {
            let item = NSMenuItem(title: window.title, action: #selector(selectDocument(_:)), keyEquivalent: "")
            item.tag = window.id
            item.target = self
            menu.addItem(item)
        }
        return menu
    }

    @objc private func showDocuments() { send("activate") }
    @objc private func selectDocument(_ sender: NSMenuItem) { send("activate", windowID: sender.tag) }
    @objc private func closeDocuments() { send("close") }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if parentExited { return .terminateNow }
        // TIPS: Dock“退出”仍须经过原窗口的保存/放弃/取消，取消后保留入口。
        send("close")
        return .terminateCancel
    }
}

let application = NSApplication.shared
private let delegate = DocumentDock()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
