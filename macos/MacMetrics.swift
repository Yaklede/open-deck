import Darwin
import Foundation
import IOKit
import IOKit.ps

let hostPort = mach_host_self()
let cpuTimebase: Double = {
  var info = mach_timebase_info_data_t()
  guard mach_timebase_info(&info) == KERN_SUCCESS, info.denom > 0 else { return .nan }
  return Double(info.numer) / Double(info.denom)
}()

func number(_ name: String) -> Int32? {
  var value: Int32 = 0
  var size = MemoryLayout<Int32>.size
  return sysctlbyname(name, &value, &size, nil, 0) == 0 ? value : nil
}
func cpuTicks() -> [[UInt64]]? {
  var cores: natural_t = 0
  var count: mach_msg_type_number_t = 0
  var values: processor_info_array_t?
  guard
    host_processor_info(hostPort, PROCESSOR_CPU_LOAD_INFO, &cores, &values, &count)
      == KERN_SUCCESS, let values
  else { return nil }
  defer {
    vm_deallocate(
      mach_task_self_, vm_address_t(UInt(bitPattern: values)),
      vm_size_t(count) * vm_size_t(MemoryLayout<integer_t>.size))
  }
  return (0..<Int(cores)).map { core in
    (0..<Int(CPU_STATE_MAX)).map {
      UInt64(UInt32(bitPattern: values[core * Int(CPU_STATE_MAX) + $0]))
    }
  }
}
func memory() -> [String: Any]? {
  var stats = vm_statistics64()
  var count = mach_msg_type_number_t(
    MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
  let result = withUnsafeMutablePointer(to: &stats) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      host_statistics64(hostPort, HOST_VM_INFO64, $0, &count)
    }
  }
  guard result == KERN_SUCCESS else { return nil }
  let page = UInt64(vm_kernel_page_size)
  let availableApp =
    Int64(stats.active_count) + Int64(stats.inactive_count) - Int64(stats.purgeable_count)
    - Int64(stats.external_page_count)
  let app = UInt64(max(0, availableApp)) * page
  let wired = UInt64(stats.wire_count) * page
  let compressed = UInt64(stats.compressor_page_count) * page
  var swap = xsw_usage()
  var size = MemoryLayout<xsw_usage>.size
  let hasSwap = sysctlbyname("vm.swapusage", &swap, &size, nil, 0) == 0
  let pressure = number("kern.memorystatus_vm_pressure_level")
  return [
    "totalBytes": ProcessInfo.processInfo.physicalMemory,
    "usedBytes": min(ProcessInfo.processInfo.physicalMemory, app + wired + compressed),
    "appBytes": app, "wiredBytes": wired, "compressedBytes": compressed,
    "swapBytes": hasSwap ? swap.xsu_used as Any : NSNull(),
    "pressure": pressure == 1
      ? "normal" : pressure == 2 ? "warning" : pressure == 4 ? "critical" : "unknown",
  ]
}
func disk() -> [String: Any]? {
  var value = statfs()
  guard statfs("/System/Volumes/Data", &value) == 0 else { return nil }
  return [
    "totalBytes": UInt64(value.f_blocks) * UInt64(value.f_bsize),
    "freeBytes": UInt64(value.f_bfree) * UInt64(value.f_bsize),
    "availableBytes": UInt64(value.f_bavail) * UInt64(value.f_bsize),
  ]
}
func networkCounters() -> [String: (UInt64, UInt64)]? {
  var mib: [Int32] = [CTL_NET, PF_ROUTE, 0, AF_UNSPEC, NET_RT_IFLIST2, 0]
  var size = 0
  guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size > 0 else { return nil }
  var bytes = [UInt8](repeating: 0, count: size)
  let ok = bytes.withUnsafeMutableBytes {
    sysctl(&mib, u_int(mib.count), $0.baseAddress, &size, nil, 0) == 0
  }
  guard ok else { return nil }
  var counters: [String: (UInt64, UInt64)] = [:]
  bytes.withUnsafeBytes { buffer in
    var offset = 0
    while offset + 4 <= size {
      let ptr = buffer.baseAddress!.advanced(by: offset)
      let length = Int(ptr.loadUnaligned(as: UInt16.self))
      guard length >= 4, offset + length <= size else { break }
      if ptr.loadUnaligned(fromByteOffset: 3, as: UInt8.self) == RTM_IFINFO2
        && length >= MemoryLayout<if_msghdr2>.size
      {
        var info = if_msghdr2()
        memcpy(&info, ptr, MemoryLayout<if_msghdr2>.size)
        var name = [CChar](repeating: 0, count: Int(IFNAMSIZ))
        if if_indextoname(UInt32(info.ifm_index), &name) != nil {
          let label = String(cString: name)
          if label.hasPrefix("en"), info.ifm_flags & IFF_UP != 0, info.ifm_flags & IFF_RUNNING != 0
          {
            counters[label] = (info.ifm_data.ifi_ibytes, info.ifm_data.ifi_obytes)
          }
        }
      }
      offset += length
    }
  }
  return counters
}
func ioCounters() -> (UInt64, UInt64)? {
  var iterator: io_iterator_t = 0
  guard
    IOServiceGetMatchingServices(
      kIOMainPortDefault, IOServiceMatching("IOBlockStorageDriver"), &iterator) == KERN_SUCCESS
  else { return nil }
  defer { IOObjectRelease(iterator) }
  var read: UInt64 = 0
  var written: UInt64 = 0
  var found = false
  while case let service = IOIteratorNext(iterator), service != 0 {
    defer { IOObjectRelease(service) }
    if let data = IORegistryEntryCreateCFProperty(
      service, "Statistics" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
      as? [String: Any], let r = data["Bytes (Read)"] as? NSNumber,
      let w = data["Bytes (Write)"] as? NSNumber
    {
      read &+= r.uint64Value
      written &+= w.uint64Value
      found = true
    }
  }
  return found ? (read, written) : nil
}
func power() -> [String: Any] {
  let thermal: String
  switch ProcessInfo.processInfo.thermalState {
  case .nominal: thermal = "normal"
  case .fair: thermal = "fair"
  case .serious: thermal = "serious"
  case .critical: thermal = "critical"
  @unknown default: thermal = "unknown"
  }
  var value: [String: Any] = [
    "thermal": thermal,
    "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
  ]
  if let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
    let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef]
  {
    for source in list {
      guard
        let data = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue()
          as? [String: Any], data[kIOPSTypeKey] as? String == kIOPSInternalBatteryType
      else { continue }
      if let current = data[kIOPSCurrentCapacityKey] as? NSNumber,
        let maximum = data[kIOPSMaxCapacityKey] as? NSNumber, maximum.doubleValue > 0
      {
        value["batteryPercent"] = current.doubleValue / maximum.doubleValue * 100
      }
      value["charging"] = data[kIOPSIsChargingKey]
      value["pluggedIn"] = data[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue
      value["batteryPresent"] = true
    }
  }
  return value
}
struct ProcessSample {
  let cpu: UInt64
  let started: UInt64
}
var previousProcesses: [Int32: ProcessSample] = [:]
var processAt = ProcessInfo.processInfo.systemUptime
var processData: [String: Any] = [:]
func processes(_ now: Double) -> [String: Any] {
  let count = max(4096, Int(proc_listallpids(nil, 0)) + 256)
  var pids = [Int32](repeating: 0, count: count)
  let actual = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
  var rows: [[String: Any]] = []
  var next: [Int32: ProcessSample] = [:]
  for pid in pids.prefix(max(0, min(Int(actual), count))) where pid > 0 {
    var usage = rusage_info_v2()
    let result = withUnsafeMutablePointer(to: &usage) { ptr in
      ptr.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
        proc_pid_rusage(pid, RUSAGE_INFO_V2, $0)
      }
    }
    guard result == 0 else { continue }
    let cpu = usage.ri_user_time + usage.ri_system_time
    next[pid] = ProcessSample(cpu: cpu, started: usage.ri_proc_start_abstime)
    let previous = previousProcesses[pid]
    let percent: Any
    if let previous, previous.started == usage.ri_proc_start_abstime,
      cpu >= previous.cpu, now > processAt, cpuTimebase.isFinite
    {
      // proc_pid_rusage CPU times use Mach absolute ticks, including on Apple Silicon.
      percent = Double(cpu - previous.cpu) * cpuTimebase / ((now - processAt) * 1e9) * 100
    } else {
      percent = NSNull()
    }
    var path = [CChar](repeating: 0, count: Int(4 * MAXPATHLEN))
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { continue }
    let name = URL(fileURLWithPath: String(cString: path)).lastPathComponent
    rows.append([
      "pid": pid, "name": String(name.prefix(80)), "cpuPercent": percent,
      "memoryBytes": usage.ri_phys_footprint,
    ])
  }
  previousProcesses = next
  processAt = now
  return [
    "capturedAt": Date().timeIntervalSince1970 * 1000, "count": rows.count,
    "cpu": Array(
      rows.filter { $0["cpuPercent"] is Double }.sorted {
        ($0["cpuPercent"] as? Double ?? 0) > ($1["cpuPercent"] as? Double ?? 0)
      }.prefix(5)),
    "memory": Array(
      rows.sorted { ($0["memoryBytes"] as? UInt64 ?? 0) > ($1["memoryBytes"] as? UInt64 ?? 0) }
        .prefix(5)),
  ]
}
var brandSize = 0
sysctlbyname("machdep.cpu.brand_string", nil, &brandSize, nil, 0)
var brandBytes = [CChar](repeating: 0, count: max(1, brandSize))
sysctlbyname("machdep.cpu.brand_string", &brandBytes, &brandSize, nil, 0)
let brand = String(cString: brandBytes)
var previousCPU: [[UInt64]]?
var previousNetwork: [String: (UInt64, UInt64)]?
var previousIO: (UInt64, UInt64)?
var previousAt = ProcessInfo.processInfo.systemUptime
var iteration = 0
repeat {
  autoreleasepool {
    let now = ProcessInfo.processInfo.systemUptime
    let elapsed = max(0.001, now - previousAt)
    var output: [String: Any] = [
      "schemaVersion": 1, "model": brand, "capturedAt": Date().timeIntervalSince1970 * 1000,
      "uptimeSeconds": now, "logicalCores": ProcessInfo.processInfo.processorCount,
    ]
    if let ticks = cpuTicks() {
      if let old = previousCPU, old.count == ticks.count {
        let cores = ticks.enumerated().map { i, values -> Double in
          let delta = values.enumerated().map { n, v in v >= old[i][n] ? v - old[i][n] : 0 }
          let total = delta.reduce(UInt64(0), +)
          return total > 0 ? (1 - Double(delta[Int(CPU_STATE_IDLE)]) / Double(total)) * 100 : 0
        }
        output["cpu"] = [
          "percent": cores.reduce(0, +) / Double(max(1, cores.count)), "cores": cores,
        ]
      }
      previousCPU = ticks
    }
    output["memory"] = memory()
    output["disk"] = disk()
    output["power"] = power()
    if let counters = networkCounters() {
      if let old = previousNetwork {
        var rx: Double = 0
        var tx: Double = 0
        for (name, value) in counters {
          if let prev = old[name], value.0 >= prev.0, value.1 >= prev.1 {
            rx += Double(value.0 - prev.0) / elapsed
            tx += Double(value.1 - prev.1) / elapsed
          }
        }
        output["network"] = [
          "rxBytesPerSecond": rx, "txBytesPerSecond": tx, "interfaces": counters.keys.sorted(),
        ]
      }
      previousNetwork = counters
    }
    if let counters = ioCounters() {
      if let old = previousIO, counters.0 >= old.0, counters.1 >= old.1 {
        output["io"] = [
          "readBytesPerSecond": Double(counters.0 - old.0) / elapsed,
          "writeBytesPerSecond": Double(counters.1 - old.1) / elapsed,
        ]
      }
      previousIO = counters
    }
    if iteration % 3 == 0 { processData = processes(now) }
    output["processes"] = processData
    var loads = [Double](repeating: 0, count: 3)
    if getloadavg(&loads, 3) == 3 { output["loadAverage"] = loads }
    if let bytes = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) {
      FileHandle.standardOutput.write(bytes)
      FileHandle.standardOutput.write(Data([10]))
    }
    previousAt = now
    iteration += 1
  }
  if CommandLine.arguments.contains("--once") { break }
  Thread.sleep(forTimeInterval: 2)
} while true
