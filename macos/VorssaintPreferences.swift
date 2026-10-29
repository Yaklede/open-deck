import Foundation
import AppKit
import CryptoKit

let domain = "com.vorssaint.utils" as CFString
let appPath = "/Applications/Vorssaint.app"
struct Failure: Error { let code: String }
func fail(_ code: String) throws -> Never { throw Failure(code: code) }
func output(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
}
func main() throws {
    guard CommandLine.arguments.count == 3 else { try fail("INVALID_ARGUMENT") }
    let operation = CommandLine.arguments[1]
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
    guard let catalog = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          catalog["domain"] as? String == domain as String,
          let features = catalog["features"] as? [[String: Any]] else { try fail("INVALID_CATALOG") }
    let fields = features.flatMap { $0["fields"] as? [[String: Any]] ?? [] }
    let definitions = Dictionary(uniqueKeysWithValues: fields.compactMap { f in
        (f["key"] as? String).map { ($0, f) }
    })
    func running() -> [NSRunningApplication] {
        NSRunningApplication.runningApplications(withBundleIdentifier: domain as String).filter {
            $0.bundleURL?.standardizedFileURL.path == appPath
        }
    }
    func valid(_ value: Any, _ field: [String: Any]) -> Bool {
        switch field["kind"] as? String {
        case "boolean":
            return CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID()
        case "integer":
            guard let number = value as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
            let n = number.doubleValue
            guard n.isFinite, n.rounded() == n,
                  n >= (field["min"] as? NSNumber)?.doubleValue ?? -Double.infinity,
                  n <= (field["max"] as? NSNumber)?.doubleValue ?? Double.infinity else { return false }
            if let choices = field["choices"] as? [NSNumber] { return choices.contains(number) }
            return true
        case "enum":
            guard let string = value as? String, let choices = field["choices"] as? [String] else { return false }
            return choices.contains(string)
        default: return false
        }
    }
    func values() -> [String: Any] {
        CFPreferencesAppSynchronize(domain)
        var result: [String: Any] = [:]
        for field in fields {
            let key = field["key"] as! String
            let raw = CFPreferencesCopyAppValue(key as CFString, domain)
            result[key] = raw.flatMap { valid($0, field) ? $0 : nil } ?? field["default"]!
        }
        return result
    }
    func revision(_ values: [String: Any]) -> String {
        let bytes = try! JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    let installed = FileManager.default.fileExists(atPath: appPath)
    let plist = NSDictionary(contentsOfFile: appPath + "/Contents/Info.plist")
    if operation == "read" {
        let v = values()
        output(["ok": true, "installed": installed, "running": !running().isEmpty,
                "version": plist?["CFBundleShortVersionString"] as? String ?? "",
                "values": v, "revision": revision(v)])
        return
    }
    guard installed else { try fail("NOT_INSTALLED") }
    if operation == "quit" {
        let apps = running()
        guard apps.allSatisfy({ $0.terminate() }) else { try fail("QUIT_REFUSED") }
        let until = Date().addingTimeInterval(6)
        while !running().isEmpty && Date() < until {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        guard running().isEmpty else { try fail("QUIT_TIMEOUT") }
        output(["ok": true, "stopped": true]); return
    }
    if operation == "bootstrap" {
        // A fresh installation starts with the upstream Essential preset. Never replace existing choices.
        guard CFPreferencesCopyAppValue("hasOnboarded" as CFString, domain) == nil else {
            output(["ok": true, "changed": false]); return
        }
        let essential: Set<String> = ["mixer", "keepAwake", "monitorCPU", "monitorGPU", "monitorMemory", "monitorNetwork", "monitorDisk", "monitorPower"]
        for feature in features {
            guard let id = feature["id"] as? String, id != "general" else { continue }
            CFPreferencesSetAppValue(("featureAvailable." + id) as CFString,
                                     essential.contains(id) as CFPropertyList, domain)
        }
        CFPreferencesSetAppValue("hasOnboarded" as CFString, true as CFPropertyList, domain)
        CFPreferencesSetAppValue("appLanguage" as CFString, "ko" as CFString, domain)
        guard CFPreferencesAppSynchronize(domain) else { try fail("WRITE_FAILED") }
        output(["ok": true, "changed": true]); return
    }
    guard operation == "write" else { try fail("INVALID_OPERATION") }
    let requestData = FileHandle.standardInput.readDataToEndOfFile()
    guard requestData.count <= 131072,
          let input = try JSONSerialization.jsonObject(with: requestData) as? [String: Any],
          let patch = input["patch"] as? [String: Any], !patch.isEmpty, patch.count <= definitions.count,
          let expected = input["revision"] as? String else { try fail("INVALID_PATCH") }
    let current = values()
    guard revision(current) == expected else { try fail("CONFLICT") }
    for (key, value) in patch {
        guard let field = definitions[key], valid(value, field) else { try fail("INVALID_VALUE") }
    }
    let old = Dictionary(uniqueKeysWithValues: patch.keys.map { key in
        (key, CFPreferencesCopyAppValue(key as CFString, domain))
    })
    for (key, value) in patch { CFPreferencesSetAppValue(key as CFString, value as CFPropertyList, domain) }
    guard CFPreferencesAppSynchronize(domain) else {
        for (key, value) in old { CFPreferencesSetAppValue(key as CFString, value, domain) }
        CFPreferencesAppSynchronize(domain)
        try fail("WRITE_FAILED")
    }
    let updated = values()
    output(["ok": true, "values": updated, "revision": revision(updated)])
}
do { try main() }
catch let error as Failure { output(["ok": false, "code": error.code]); exit(1) }
catch { output(["ok": false, "code": "PREFERENCES_UNAVAILABLE"]); exit(1) }
