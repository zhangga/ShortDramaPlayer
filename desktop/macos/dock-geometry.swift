// SPDX-License-Identifier: GPL-3.0-only
import AppKit
import CoreGraphics

let dockPID = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first?.processIdentifier
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
let dockLayer = Int(CGWindowLevelForKey(.dockWindow))
let rectangles = windows.compactMap { window -> [String: Double]? in
    guard let dockPID,
          window[kCGWindowOwnerPID as String] as? Int32 == dockPID,
          window[kCGWindowLayer as String] as? Int == dockLayer,
          (window[kCGWindowAlpha as String] as? Double ?? 0) > 0,
          let properties = window[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: properties as CFDictionary) else { return nil }
    return ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
}
let result: [String: Any] = ["windows": rectangles, "doubleClickMs": NSEvent.doubleClickInterval * 1000]
let output = try JSONSerialization.data(withJSONObject: result)
FileHandle.standardOutput.write(output)
