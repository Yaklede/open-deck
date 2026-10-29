// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Open Deck contributors
import AppKit
import CoreAudio
import IOKit.pwr_mgt

enum ControlFailure: Error { case invalid, unavailable, failed }

final class SystemControls {
    private var awakeID: IOPMAssertionID = 0
    private var awakeUntil: Date?
    private var awakeDisplay = false
    private var awakeDeadline: TimeInterval?
    private let displayFramework = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY)
    typealias ReadBrightness = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32
    typealias WriteBrightness = @convention(c) (UInt32, Float) -> Int32

    deinit { stopAwake() }
    private func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    }
    private func uint(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32 {
        var a = address(selector), value: UInt32 = 0, size = UInt32(MemoryLayout<UInt32>.size)
        _ = AudioObjectGetPropertyData(id, &a, 0, nil, &size, &value)
        return value
    }
    private func hasStreams(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Bool {
        var a = address(kAudioDevicePropertyStreams, scope), size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size) == noErr && size > 0
    }
    private func scalar(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ element: UInt32) -> Float32? {
        var a = address(selector, scope, element), value: Float32 = 0, size = UInt32(MemoryLayout<Float32>.size)
        guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, &value) == noErr, value.isFinite else { return nil }
        return value
    }
    private func volume(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Double? {
        if let v = scalar(id, kAudioDevicePropertyVolumeScalar, scope, 0) { return Double(v) }
        let channels = [1, 2].compactMap { scalar(id, kAudioDevicePropertyVolumeScalar, scope, UInt32($0)) }
        return channels.isEmpty ? nil : Double(channels.reduce(0, +) / Float(channels.count))
    }
    private func muted(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Bool? {
        var a = address(kAudioDevicePropertyMute, scope), value: UInt32 = 0, size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &a, 0, nil, &size, &value) == noErr ? value != 0 : nil
    }
    func audio() -> [String: Any] {
        var a = address(kAudioHardwarePropertyDevices), size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr, size <= 4096 else { return ["devices": []] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids)
        let devices: [[String: Any]] = ids.prefix(32).compactMap { id in
            guard uint(id, kAudioDevicePropertyDeviceIsAlive) != 0 else { return nil }
            var name: Unmanaged<CFString>?, a = address(kAudioObjectPropertyName), size = UInt32(MemoryLayout<CFString>.size)
            _ = AudioObjectGetPropertyData(id, &a, 0, nil, &size, &name)
            var d: [String: Any] = ["id": id, "name": name?.takeRetainedValue() as String? ?? "Audio",
                "input": hasStreams(id, kAudioObjectPropertyScopeInput), "output": hasStreams(id, kAudioObjectPropertyScopeOutput)]
            for (key, scope) in [("input", kAudioObjectPropertyScopeInput), ("output", kAudioObjectPropertyScopeOutput)] {
                if let v = volume(id, scope) { d[key + "Volume"] = Int((v * 100).rounded()) }
                if let v = muted(id, scope) { d[key + "Muted"] = v }
            }
            return d
        }
        return ["devices": devices, "outputId": uint(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice),
                "inputId": uint(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice)]
    }
    func setAudio(_ op: String, _ p: [String: Any]) throws {
        guard let id = p["deviceId"] as? UInt32,
              let devices = audio()["devices"] as? [[String: Any]],
              let device = devices.first(where: { ($0["id"] as? UInt32) == id }),
              let direction = p["direction"] as? String, ["input", "output"].contains(direction),
              device[direction] as? Bool == true else { throw ControlFailure.invalid }
        let scope = direction == "input" ? kAudioObjectPropertyScopeInput : kAudioObjectPropertyScopeOutput
        if op == "audio.device" {
            var a = address(direction == "input" ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice), value = id
            guard AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value) == noErr else { throw ControlFailure.failed }
        } else if op == "audio.volume" {
            guard let n = p["value"] as? Int, (0...100).contains(n) else { throw ControlFailure.invalid }
            var wrote = false
            for element: UInt32 in [0, 1, 2] {
                var a = address(kAudioDevicePropertyVolumeScalar, scope, element), settable = DarwinBoolean(false)
                guard AudioObjectIsPropertySettable(id, &a, &settable) == noErr, settable.boolValue else { continue }
                var v = Float32(n) / 100
                if AudioObjectSetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<Float32>.size), &v) == noErr { wrote = true }
                if element == 0 && wrote { break }
            }
            guard wrote else { throw ControlFailure.unavailable }
        } else if op == "audio.mute" {
            guard let value = p["value"] as? Bool else { throw ControlFailure.invalid }
            var a = address(kAudioDevicePropertyMute, scope), v: UInt32 = value ? 1 : 0
            guard AudioObjectSetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v) == noErr else { throw ControlFailure.unavailable }
        } else { throw ControlFailure.invalid }
    }
    func displays() -> [[String: Any]] {
        guard let pointer = displayFramework.flatMap({ dlsym($0, "DisplayServicesGetBrightness") }) else { return [] }
        let get = unsafeBitCast(pointer, to: ReadBrightness.self)
        var ids = [CGDirectDisplayID](repeating: 0, count: 16), count: UInt32 = 0
        guard CGGetOnlineDisplayList(16, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).compactMap { id in
            var value: Float = 0
            guard get(id, &value) == 0, value.isFinite, (0...1).contains(value) else { return nil }
            return ["id": id, "name": CGDisplayIsBuiltin(id) != 0 ? "Mac 내장 디스플레이" : "Display \(id)", "brightness": Int((value * 100).rounded()), "builtIn": CGDisplayIsBuiltin(id) != 0]
        }
    }
    func setBrightness(_ p: [String: Any]) throws {
        guard let id = p["displayId"] as? UInt32, let value = p["value"] as? Int, (1...100).contains(value),
              displays().contains(where: { $0["id"] as? UInt32 == id }),
              let pointer = displayFramework.flatMap({ dlsym($0, "DisplayServicesSetBrightness") }) else { throw ControlFailure.invalid }
        let set = unsafeBitCast(pointer, to: WriteBrightness.self)
        guard set(id, Float(value) / 100) == 0 else { throw ControlFailure.failed }
    }
    func startAwake(_ p: [String: Any]) throws {
        guard let minutes = p["minutes"] as? Int, [0, 15, 30, 60, 120].contains(minutes), let display = p["display"] as? Bool else { throw ControlFailure.invalid }
        stopAwake()
        var id: IOPMAssertionID = 0
        let kind = display ? kIOPMAssertionTypePreventUserIdleDisplaySleep : kIOPMAssertionTypePreventUserIdleSystemSleep
        guard IOPMAssertionCreateWithName(kind as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "Open Deck · Tablet control" as CFString, &id) == kIOReturnSuccess else { throw ControlFailure.failed }
        awakeID = id; awakeDisplay = display
        awakeUntil = minutes == 0 ? nil : Date().addingTimeInterval(Double(minutes * 60))
        awakeDeadline = minutes == 0 ? nil : ProcessInfo.processInfo.systemUptime + Double(minutes * 60)
    }
    func stopAwake() {
        if awakeID != 0 { IOPMAssertionRelease(awakeID) }; awakeID = 0; awakeUntil = nil; awakeDeadline = nil
    }
    func awake() -> [String: Any] {
        if let limit = awakeDeadline, ProcessInfo.processInfo.systemUptime >= limit { stopAwake() }
        var r: [String: Any] = ["active": awakeID != 0, "display": awakeDisplay]
        if let until = awakeUntil { r["until"] = Int(until.timeIntervalSince1970 * 1000) }
        return r
    }
}
