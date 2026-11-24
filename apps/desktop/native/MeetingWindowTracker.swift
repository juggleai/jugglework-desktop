import AppKit
import ApplicationServices
import CoreGraphics

let args = CommandLine.arguments
guard args.count >= 3, let windowID = UInt32(args[2]), windowID > 0 else { exit(2) }

@Sendable func emit(_ fields: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: fields) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

@Sendable func windowInfo() -> [String: Any]? {
    let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]]
    return rows?.first { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID }
}

@Sendable func ownerPID(_ info: [String: Any]) -> pid_t? {
    (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
}

@Sendable func frame(_ info: [String: Any]) -> CGRect? {
    guard let raw = info[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: raw as CFDictionary),
          !rect.isNull, !rect.isInfinite, rect.width > 0, rect.height > 0 else { return nil }
    return rect
}

if args[1] == "inspect", args.count == 3 {
    guard let info = windowInfo(), let pid = ownerPID(info), pid > 0 else { exit(1) }
    emit(["pid": pid])
    exit(0)
}

guard args[1] == "watch", args.count == 4, let pid = Int32(args[3]), pid > 0 else { exit(2) }
guard AXIsProcessTrusted() else { emit(["status": "needs-accessibility"]); exit(0) }
guard let owner = NSRunningApplication(processIdentifier: pid),
      let initial = windowInfo(), ownerPID(initial) == pid, let initialFrame = frame(initial) else {
    emit(["status": "unavailable"]); exit(0)
}

@Sendable func readAX(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}

@Sendable func axSize(_ element: AXUIElement) -> CGSize? {
    guard let s = readAX(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let p = readAX(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
          let size = axSize(element) else { return nil }
    var position = CGPoint.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &position) else { return nil }
    return CGRect(origin: position, size: size)
}

let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 0.25)
let axWindows = readAX(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
let matches = axWindows.filter { axFrame($0) == initialFrame }
let cgWindows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
// Never guess between windows with the same geometry, even if titles differ.
let matchingCG = cgWindows.filter { ownerPID($0) == pid && frame($0) == initialFrame }
guard matches.count == 1, matchingCG.count == 1 else { emit(["status": "unavailable"]); exit(0) }

let target = matches[0]
var observer: AXObserver?
let callback: AXObserverCallback = { _, _, _, _ in
    emit(["status": "closed"])
    exit(0)
}
guard AXObserverCreate(pid, callback, &observer) == .success, let observer,
      AXObserverAddNotification(observer, target, kAXUIElementDestroyedNotification as CFString, nil) == .success else {
    emit(["status": "unavailable"]); exit(0)
}
CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)

var lastFrame: CGRect?
var lastStatus = ""
var invalidSince: TimeInterval?
var canvasWindowID: CGWindowID = 0
var orderRepairAttempts = 0
var nextOrderRepair: TimeInterval = 0
var attemptedInterlopers = Set<CGWindowID>()
let overlayOwnerPID = getppid()
// One registration from the spawning Electron main process. Keep
// stdin off the sampling run loop; all tracker state belongs to the main queue.
DispatchQueue.global().async {
    if let line = readLine(), line.utf8.count <= 256,
       let command = try? JSONDecoder().decode(OverlayRegistration.self, from: Data(line.utf8)),
       command.overlayWindowIds.count == 1, let id = command.overlayWindowIds.first,
       id != 0, id != windowID {
        DispatchQueue.main.async {
            canvasWindowID = id
        }
    }
}
struct OverlayRegistration: Decodable {
    let overlayWindowIds: [CGWindowID]
}

@Sendable func sampleOrder(_ rows: [[String: Any]], targetInfo: [String: Any]) {
    let targetLevel = targetInfo[kCGWindowLayer as String] as? NSNumber
    var seenTarget = false
    var seenCanvas = false
    var canvasBelowTarget = false
    var interlopers = Set<CGWindowID>()
    var compatibleCanvasBounds: CGRect?
    // Trust actual order for the registered canvas at any level. Other rows can
    // include target-owned surfaces; CG order alone cannot establish that
    // moveAbove can put them above the annotation stack.
    for row in rows {
        guard let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
        let compatible = targetLevel != nil && (row[kCGWindowLayer as String] as? NSNumber) == targetLevel
        if id == windowID {
            seenTarget = true
        } else if id == canvasWindowID, ownerPID(row) == overlayOwnerPID {
            seenCanvas = true
            if seenTarget { canvasBelowTarget = true; break }
            if compatible { compatibleCanvasBounds = frame(row) }
        } else if !seenTarget && compatible,
                  ((row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0,
                  let bounds = frame(row), let canvasBounds = compatibleCanvasBounds,
                  !canvasBounds.intersection(bounds).isEmpty {
            interlopers.insert(id)
        }
        if seenTarget && seenCanvas { break }
    }
    guard seenTarget else { return }
    let now = ProcessInfo.processInfo.systemUptime
    if !canvasBelowTarget {
        // No observable canvas gives no evidence either way.
        guard seenCanvas else { return }
        orderRepairAttempts = 0
        attemptedInterlopers.formIntersection(interlopers)
        // Don't reorder the same stable interloper again, or spend any of the
        // inversion budget on it. Let an outstanding inversion repair settle.
        guard now >= nextOrderRepair, !interlopers.isSubset(of: attemptedInterlopers) else { return }
        attemptedInterlopers = interlopers
        emit(["event": "order-interleaved"])
        return
    }
    // moveAbove is asynchronous from the window server's perspective. Give
    // it time to settle before retrying and stop tracking if it never sticks.
    guard now >= nextOrderRepair else { return }
    if orderRepairAttempts == 3 { emit(["status": "unavailable"]); exit(0) }
    orderRepairAttempts += 1
    nextOrderRepair = now + 0.15
    emit(["event": "order-lost"])
}

@Sendable func reportStatus(_ status: String) {
    if lastStatus != status {
        // Returning from a hidden or minimized target starts a new placement.
        if status == "hidden" || status == "minimized" {
            orderRepairAttempts = 0
            nextOrderRepair = 0
            attemptedInterlopers.removeAll()
        }
        emit(["status": status]); lastStatus = status
    }
}
func sample() {
    if owner.isTerminated { emit(["status": "closed"]); exit(0) }
    let rows = canvasWindowID == 0 ? nil :
        CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    let info = rows?.first { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID } ?? windowInfo()
    if let info, ownerPID(info) != pid { emit(["status": "unavailable"]); exit(0) }
    if lastStatus == "visible", let info, (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true, frame(info) == lastFrame {
        if let rows { sampleOrder(rows, targetInfo: info) }
        return
    }
    if (readAX(target, kAXMinimizedAttribute) as? NSNumber)?.boolValue == true {
        invalidSince = nil
        reportStatus("minimized")
        return
    }
    guard let info, (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true, let rect = frame(info) else {
        reportStatus("hidden")
        if info != nil && info.flatMap(frame) != nil { invalidSince = nil }
        else { expireInvalidSample() }
        return
    }
    // During the Dock animation, CG bounds describe a transformed surface,
    // not the target's logical size. Wait for a trustworthy sample instead.
    guard let size = axSize(target), abs(size.width - rect.width) <= 1, abs(size.height - rect.height) <= 1 else {
        if lastStatus != "minimized" { reportStatus("hidden") }
        expireInvalidSample()
        return
    }
    invalidSince = nil
    if lastStatus != "visible" || lastFrame != rect {
        emit(["status": "visible", "pid": pid, "bounds": ["x": rect.minX, "y": rect.minY, "width": size.width, "height": size.height]])
        lastFrame = rect
        lastStatus = "visible"
    }
}

@Sendable func expireInvalidSample() {
    let now = ProcessInfo.processInfo.systemUptime
    if invalidSince == nil { invalidSince = now }
    if now - (invalidSince ?? now) > 2 {
        emit(["status": "unavailable"])
        exit(0)
    }
}
sample()
let timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { _ in sample() }
RunLoop.current.add(timer, forMode: .default)
RunLoop.current.run()
