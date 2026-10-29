import AppKit
import Security

// Installation requires the user's macOS administrator approval. The daemon exposes
// only the fan protocol and authenticates an exact client binary plus console UID.
final class MacFanAccess {
    static let shared = MacFanAccess()
    static let label = "app.opendeck.host.fan-control"
    private var lastStatus = ""
    private var installing = false
    private var error = ""
    private let dataDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/OpenDeck")
    private var source: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/Library/LaunchServices/" + Self.label) }
    private var installed: URL { URL(fileURLWithPath: "/Library/PrivilegedHelperTools/" + Self.label) }

    private func codeHash(_ url: URL) -> String? {
        var code: SecStaticCode?, info: CFDictionary?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let value = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data else { return nil }
        return value.map { String(format: "%02x", $0) }.joined()
    }
    func refresh() {
        let attributes = try? FileManager.default.attributesOfItem(atPath: installed.path)
        let protected = attributes?[.ownerAccountID] as? Int == 0 && ((attributes?[.posixPermissions] as? Int ?? 0) & 0o022) == 0
        let expected = codeHash(source), current = codeHash(installed)
        let status = installing ? "installing" : !error.isEmpty ? "failed" : expected != nil && expected == current && protected ? "enabled" : current == nil ? "not-registered" : "update-required"
        let stamp = status + error
        guard stamp != lastStatus else { return }; lastStatus = stamp
        try? FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let bytes = try? JSONSerialization.data(withJSONObject: ["status": status, "error": error], options: [.sortedKeys]) {
            let url = dataDirectory.appendingPathComponent("mac-control-access.json")
            try? bytes.write(to: url, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }
    private func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    func authorize() {
        guard !installing, let expected = codeHash(source), expected.count == 40 else { return }
        installing = true; error = ""; refresh()
        let plist: [String: Any] = [
            "Label": Self.label, "ProgramArguments": [installed.path],
            "MachServices": [Self.label: true], "RunAtLoad": true,
            "KeepAlive": ["Crashed": true], "ThrottleInterval": 5, "ExitTimeOut": 60,
        ]
        guard let bytes = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0), let xml = String(data: bytes, encoding: .utf8) else { installing = false; refresh(); return }
        let requirement = "cdhash H\"" + expected + "\""
        let script = """
        set -eu
        test ! -L /Library/PrivilegedHelperTools
        test ! -L /Library/LaunchDaemons
        /bin/mkdir -p /Library/PrivilegedHelperTools /Library/LaunchDaemons
        task_fan_stage=$(/usr/bin/mktemp /Library/PrivilegedHelperTools/.opendeck-fan.XXXXXX)
        trap '/bin/rm -f "$task_fan_stage"' EXIT
        /usr/bin/install -o root -g wheel -m 755 \(quote(source.path)) "$task_fan_stage"
        /usr/bin/codesign --verify --strict -R \(quote(requirement)) "$task_fan_stage"
        /bin/launchctl bootout system/\(Self.label) >/dev/null 2>&1 || true
        /bin/mv -f "$task_fan_stage" \(quote(installed.path))
        /bin/cat > /Library/LaunchDaemons/\(Self.label).plist <<'OPEN_DECK_FAN_PLIST'
        \(xml)
        OPEN_DECK_FAN_PLIST
        /usr/sbin/chown root:wheel /Library/LaunchDaemons/\(Self.label).plist
        /bin/chmod 644 /Library/LaunchDaemons/\(Self.label).plist
        /bin/launchctl bootstrap system /Library/LaunchDaemons/\(Self.label).plist
        """
        let escaped = script.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        DispatchQueue.global(qos: .userInitiated).async {
            var failure: NSDictionary?
            let result = NSAppleScript(source: "do shell script \"" + escaped + "\" with administrator privileges")?.executeAndReturnError(&failure)
            DispatchQueue.main.async {
                self.installing = false
                self.error = result == nil || failure != nil ? "FAN_AUTHORIZATION_FAILED" : ""
                self.refresh()
            }
        }
    }
}
