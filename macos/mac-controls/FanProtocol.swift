// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Open Deck contributors
import Foundation

enum FanControlIdentifiers {
    static let helperID = "app.opendeck.host.fan-control"
    static let plistName = helperID + ".plist"
    #if FAN_DAEMON
    static let appCodeRequirement = FanClientTrust.requirement
    #endif
}

@objc protocol FanControlXPCProtocol {
    func status(withReply reply: @escaping (Data) -> Void)
    func startMaximumCooling(withReply reply: @escaping (Data) -> Void)
    func applyConfiguration(_ configuration: Data, withReply reply: @escaping (Data) -> Void)
    func heartbeat(withReply reply: @escaping (Data) -> Void)
    func restoreAutomatic(withReply reply: @escaping (Data) -> Void)
}

enum FanControlIPC {
    static func encode(_ response: FanControlResponse) -> Data {
        (try? JSONEncoder().encode(response)) ?? Data()
    }
    static func decode(_ data: Data) -> FanControlResponse? {
        try? JSONDecoder().decode(FanControlResponse.self, from: data)
    }
    static func encode(_ configuration: FanControlConfiguration) -> Data? {
        try? JSONEncoder().encode(configuration)
    }
    static func decodeConfiguration(_ data: Data) -> FanControlConfiguration? {
        guard data.count <= 16_384,
              let c = try? JSONDecoder().decode(FanControlConfiguration.self, from: data),
              FanControlPolicy.validConfiguration(c) else { return nil }
        return c
    }
}
