// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Open Deck contributors
import AppKit
import Foundation
import Security

private final class ReplyBox {
    let lock = NSLock()
    var data: Data?
    func set(_ value: Data?) { lock.lock(); data = value; lock.unlock() }
    func get() -> Data? { lock.lock(); defer { lock.unlock() }; return data }
}

final class MacControlAgent {
    let queue = DispatchQueue(label: "app.opendeck.mac-control-client")
    let system = SystemControls()
    private var connection: NSXPCConnection?
    private var hardware = FanControlHardware()
    private var fanResponse: FanControlResponse?
    private var fanAccess = "not-registered"
    private var lastConnectionAttempt = Date.distantPast
    private var timer: DispatchSourceTimer?
    private var coolingActivity: NSObjectProtocol?

    func output(_ object: [String: Any]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
    }
    private func access() -> String {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/OpenDeck/mac-control-access.json")
        guard let data = try? Data(contentsOf: url), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "not-registered" }
        return value["status"] as? String ?? "not-registered"
    }
    private func connect() {
        fanAccess = access()
        guard connection == nil, fanAccess == "enabled", Date().timeIntervalSince(lastConnectionAttempt) > 4 else { return }
        lastConnectionAttempt = Date()
        let helper = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Library/LaunchServices/" + FanControlIdentifiers.helperID)
        var code: SecStaticCode?, info: CFDictionary?
        guard SecStaticCodeCreateWithPath(helper as CFURL, [], &code) == errSecSuccess, let code,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let hash = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data else { return }
        let requirement = "cdhash H\"" + hash.map { String(format: "%02x", $0) }.joined() + "\""
        let c = NSXPCConnection(machServiceName: FanControlIdentifiers.helperID, options: .privileged)
        c.remoteObjectInterface = NSXPCInterface(with: FanControlXPCProtocol.self)
        c.setCodeSigningRequirement(requirement)
        c.invalidationHandler = { [weak self, weak c] in self?.queue.async { [weak self] in
            if self?.connection === c { self?.connection = nil; self?.fanResponse = nil }
        } }
        c.interruptionHandler = { [weak c] in c?.invalidate() }
        connection = c; c.activate()
    }
    private func call(timeout: TimeInterval = 3, _ action: (FanControlXPCProtocol, @escaping (Data) -> Void) -> Void) -> FanControlResponse? {
        connect()
        guard let c = connection else { return nil }
        let box = ReplyBox(), semaphore = DispatchSemaphore(value: 0)
        guard let proxy = c.remoteObjectProxyWithErrorHandler({ _ in box.set(nil); semaphore.signal() }) as? FanControlXPCProtocol else { return nil }
        action(proxy) { value in box.set(value); semaphore.signal() }
        guard semaphore.wait(timeout: .now() + timeout) == .success, let data = box.get(), let response = FanControlIPC.decode(data) else {
            c.invalidate(); connection = nil; return nil
        }
        return response
    }
    private func keepHeartbeatActive() {
        if fanResponse?.snapshot.isCooling == true {
            if coolingActivity == nil { coolingActivity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Open Deck fan control heartbeat") }
        } else if let activity = coolingActivity { ProcessInfo.processInfo.endActivity(activity); coolingActivity = nil }
    }
    private func refreshFan() {
        if fanResponse?.snapshot.isCooling == true {
            fanResponse = call { $0.heartbeat(withReply: $1) }
        } else { fanResponse = call { $0.status(withReply: $1) } }
        keepHeartbeatActive()
    }
    private func fan() -> [String: Any] {
        let snapshot = fanResponse?.snapshot ?? (try? hardware?.readOnlySnapshot()) ?? (try? hardware?.telemetrySnapshot()) ?? .empty
        var result: [String: Any] = [
            "access": fanAccess, "controllable": connection != nil && fanAccess == "enabled" && fanResponse?.succeeded == true,
            "mode": snapshot.configuration?.mode.rawValue ?? (snapshot.fans.contains(where: \.isManuallyControlled) ? "external" : "system"),
            "fans": snapshot.fans.map { ["index": $0.index, "actualRPM": $0.actualRPM, "minimumRPM": $0.minimumRPM, "maximumRPM": $0.maximumRPM, "targetRPM": $0.targetRPM, "manual": $0.isManuallyControlled] as [String: Any] },
            "temperatures": (snapshot.temperatures ?? []).map { ["source": $0.source.rawValue, "celsius": $0.celsius] as [String: Any] },
            "active": snapshot.isCooling,
        ]
        if let level = snapshot.coolingLevel { result["level"] = level }
        if let configuration = snapshot.configuration, let data = try? JSONEncoder().encode(configuration), let value = try? JSONSerialization.jsonObject(with: data) { result["configuration"] = value }
        if let reason = snapshot.stopReason { result["stopReason"] = reason.rawValue }
        if let error = fanResponse?.error { result["error"] = error.rawValue }
        return result
    }
    func snapshot() -> [String: Any] {
        ["available": true, "at": Int(Date().timeIntervalSince1970 * 1000), "fan": fan(), "audio": system.audio(), "displays": system.displays(), "awake": system.awake()]
    }
    private func applyFan(_ operation: String, _ parameters: [String: Any]) throws {
        let response: FanControlResponse?
        if operation == "fan.system" {
            response = call(timeout: 12) { $0.restoreAutomatic(withReply: $1) }
        } else {
            let configuration: FanControlConfiguration
            if operation == "fan.manual", let level = parameters["level"] as? Int, FanControlPolicy.validCoolingLevel(level) {
                configuration = .manual(level: level)
            } else if operation == "fan.curve", let curves = parameters["curves"],
                      let data = try? JSONSerialization.data(withJSONObject: curves), data.count <= 8192,
                      let value = try? JSONDecoder().decode([FanControlCurve].self, from: data), FanControlPolicy.validCurves(value) {
                configuration = .curve(value)
            } else { throw ControlFailure.invalid }
            guard let data = FanControlIPC.encode(configuration) else { throw ControlFailure.invalid }
            response = call(timeout: 12) { $0.applyConfiguration(data, withReply: $1) }
        }
        guard let response else { throw NSError(domain: "MacControls", code: 1, userInfo: [NSLocalizedDescriptionKey: fanAccess == "enabled" ? "HELPER_UNAVAILABLE" : "FAN_AUTHORIZATION_REQUIRED"]) }
        fanResponse = response
        keepHeartbeatActive()
        guard response.succeeded else { throw NSError(domain: "MacControls", code: 2, userInfo: [NSLocalizedDescriptionKey: response.error?.rawValue ?? "FAN_CONTROL_FAILED"]) }
    }
    func request(_ input: [String: Any]) {
        guard let id = input["id"] as? String, id.count <= 128, let op = input["op"] as? String,
              let p = input["parameters"] as? [String: Any] else { return }
        guard let deadline = input["deadline"] as? Double,
              deadline >= Date().timeIntervalSince1970 * 1000 else {
            output(["id": id, "ok": false, "error": "STALE_ACTION"]); return
        }
        do {
            switch op {
            case "read": refreshFan()
            case "fan.system", "fan.manual", "fan.curve": try applyFan(op, p)
            case "fan.authorize":
                let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/open"); process.arguments = ["-g", "opendeck://authorize-fan"]
                process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                try process.run()
            case "audio.device", "audio.volume", "audio.mute": try system.setAudio(op, p)
            case "display.brightness": try system.setBrightness(p)
            case "awake.start": try system.startAwake(p)
            case "awake.stop": system.stopAwake()
            default: throw ControlFailure.invalid
            }
            let value = snapshot(); output(["id": id, "ok": true, "state": value]); output(["event": "state", "state": value])
        } catch {
            output(["id": id, "ok": false, "error": (error as NSError).domain == "MacControls" ? error.localizedDescription : String(describing: error)])
        }
    }
    func start() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 2, leeway: .milliseconds(150))
        timer.setEventHandler { [weak self] in guard let self else { return }; self.refreshFan(); self.output(["event": "state", "state": self.snapshot()]) }
        self.timer = timer; timer.resume()
        DispatchQueue.global(qos: .utility).async {
            while let line = readLine() {
                guard line.utf8.count <= 16_384, let data = line.data(using: .utf8), let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                self.queue.async { self.request(input) }
            }
            self.queue.async { self.shutdown() }
        }
    }
    func shutdown() {
        system.stopAwake(); connection?.invalidate(); connection = nil
        exit(EXIT_SUCCESS)
    }
}

@main struct ControlMain {
    static func main() {
        if CommandLine.arguments.contains("--selftest") {
            guard FanControlPolicy.validConfiguration(.manual(level: 100)), !FanControlPolicy.validConfiguration(.manual(level: 101)), !FanControlPolicy.validCoolingLevel(-5), FanControlPolicy.validConfiguration(.curve([FanControlConfiguration.defaultCurve])) else { exit(1) }
            print("mac-control-client: ok"); return
        }
        let agent = MacControlAgent(); agent.start()
        signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: agent.queue)
        termination.setEventHandler { agent.shutdown() }; termination.resume()
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: agent.queue)
        interrupt.setEventHandler { agent.shutdown() }; interrupt.resume()
        RunLoop.main.run()
    }
}
