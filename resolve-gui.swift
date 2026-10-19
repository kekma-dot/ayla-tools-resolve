import AppKit
import ApplicationServices
import CoreGraphics

// A Resolve-only helper, not a general desktop/keyboard/shell endpoint.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8)); exit(1)
}
func attribute(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success ? value : nil
}
func windows(_ pid: pid_t) -> [[String: Any]] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.filter {
        ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) &&
        ($0[kCGWindowLayer as String] as? Int) == 0
    }
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count < 4096,
      let args = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
      let action = args["action"] as? String,
      ["status", "screenshot", "menu"].contains(action),
      Set(args.keys).isSubset(of: ["action", "menu", "output", "window_id"]) else { fail("Invalid GUI request") }
let trusted = AXIsProcessTrusted()
let capture = CGPreflightScreenCaptureAccess()
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.blackmagic-design.DaVinciResolve" }) else { fail("Open Resolve manually") }
let root = AXUIElementCreateApplication(app.processIdentifier)
var result: [String: Any] = ["accessibility": trusted, "screen_capture": capture, "pid": Int(app.processIdentifier)]
if action != "status" {
    guard trusted else { fail("Accessibility permission required; no input sent") }
    app.activate(options: [])
    Thread.sleep(forTimeInterval: 0.3)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { fail("Resolve is not frontmost; no input sent") }
}
let visible = windows(app.processIdentifier)
result["windows"] = visible.prefix(20).map { w -> [String: Any] in
    ["id": w[kCGWindowNumber as String] ?? 0,
     "title": w[kCGWindowName as String] ?? "",
     "bounds": w[kCGWindowBounds as String] ?? [:]]
}
if action == "menu" {
    let allowed = ["File", "Edit", "Trim", "Timeline", "Clip", "Mark", "View", "Playback", "Fusion", "Color", "Fairlight", "Workspace", "Help"]
    guard let name = args["menu"] as? String, allowed.contains(name),
          let bar = attribute(root, kAXMenuBarAttribute),
          let children = attribute(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement],
          let item = children.first(where: { attribute($0, kAXTitleAttribute) as? String == name }) else { fail("Allowlisted top-level menu unavailable") }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { fail("Focus changed; no input sent") }
    guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { fail("Menu press failed; inspect UI before another action") }
    Thread.sleep(forTimeInterval: 0.1)
    result["opened_menu"] = name
    // Read only immediate menu items; never press an arbitrary command.
    let menus = attribute(item, kAXChildrenAttribute) as? [AXUIElement] ?? []
    result["menu_items"] = menus.flatMap { attribute($0, kAXChildrenAttribute) as? [AXUIElement] ?? [] }.prefix(60).map { attribute($0, kAXTitleAttribute) as? String ?? "" }
    // No blind Escape: operator may have changed focus/dialog while the menu opened.
}
if action == "screenshot" {
    guard capture, let output = args["output"] as? String, output.hasPrefix("/"), !FileManager.default.fileExists(atPath: output) else { fail("Screen Recording permission and fresh output required") }
    let selected: [String: Any]?
    if let requested = args["window_id"] as? Int {
        selected = visible.first { ($0[kCGWindowNumber as String] as? Int) == requested }
    } else {
        selected = visible.max { a, b in
            let aa = a[kCGWindowBounds as String] as? [String: Double] ?? [:]
            let bb = b[kCGWindowBounds as String] as? [String: Double] ?? [:]
            return (aa["Width"] ?? 0) * (aa["Height"] ?? 0) < (bb["Width"] ?? 0) * (bb["Height"] ?? 0)
        }
    }
    guard let w = selected, let id = w[kCGWindowNumber as String] as? Int,
          windows(app.processIdentifier).contains(where: { ($0[kCGWindowNumber as String] as? Int) == id }) else { fail("No matching visible Resolve window; no desktop fallback") }
    let task = Process(); task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", "-o", "-t", "png", "-l\(id)", output]
    task.standardOutput = FileHandle.nullDevice; task.standardError = FileHandle.nullDevice
    do { try task.run(); task.waitUntilExit() } catch { fail("Window capture could not start") }
    guard task.terminationStatus == 0 else { fail("Window capture failed; no desktop fallback") }
    result["window_id"] = id
    result["provenance"] = "resolve-owned-window-screenshot"
}
guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else { fail("GUI result encoding failed") }
FileHandle.standardOutput.write(data)
