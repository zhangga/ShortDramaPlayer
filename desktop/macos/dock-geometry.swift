// SPDX-License-Identifier: GPL-3.0-only
import AppKit
import CoreGraphics
import Darwin

func dockRectangle(_ rect: CGRect, preferred: Bool) -> [String: Double] {
    ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height, "preferred": preferred ? 1 : 0]
}

// Some Dock versions expose only a full-screen input window through Quartz.
// Query the Dock bounds when the WindowServer exports these read-only calls.
func windowServerDockBounds() -> CGRect? {
    guard let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_LOCAL) else {
        return nil
    }
    defer { dlclose(library) }
    guard let connectionSymbol = dlsym(library, "SLSMainConnectionID"),
          let boundsSymbol = dlsym(library, "SLSGetDockRectWithReason") else { return nil }
    let connection = unsafeBitCast(connectionSymbol, to: (@convention(c) () -> Int32).self)
    let bounds = unsafeBitCast(boundsSymbol,
                               to: (@convention(c) (Int32, UnsafeMutablePointer<CGRect>, UnsafeMutablePointer<Int32>) -> Int32).self)
    var rect = CGRect.zero
    var reason: Int32 = 0
    guard bounds(connection(), &rect, &reason) == 0, !rect.isEmpty, !rect.isInfinite else { return nil }
    return rect
}

let dockPID = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first?.processIdentifier
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
let dockLayer = Int(CGWindowLevelForKey(.dockWindow))
var rectangles = windows.compactMap { window -> [String: Double]? in
    guard let dockPID,
          window[kCGWindowOwnerPID as String] as? Int32 == dockPID,
          let layer = window[kCGWindowLayer as String] as? Int,
          (window[kCGWindowAlpha as String] as? Double ?? 0) > 0,
          let properties = window[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: properties as CFDictionary) else { return nil }
    return dockRectangle(rect, preferred: layer == dockLayer)
}.sorted { ($0["preferred"] ?? 0) > ($1["preferred"] ?? 0) }
if let rect = windowServerDockBounds() {
    rectangles.append(dockRectangle(rect, preferred: false))
}
let result: [String: Any] = ["windows": rectangles, "doubleClickMs": NSEvent.doubleClickInterval * 1000]
let output = try JSONSerialization.data(withJSONObject: result)
FileHandle.standardOutput.write(output)
