import AppKit
import WebKit
import Darwin

// Product text only. Deck labels, provider data and file contents are never translated.
enum OpenDeckLocale {
    static var code = "ko"
    static var catalog: [String:String] = [:]
    static func configure(_ requested: String?) -> Bool {
        var next = requested == nil || requested == "system" ? (Locale.preferredLanguages.first ?? "en") : requested!
        if next.hasPrefix("zh-Hant") || ["zh-TW","zh-HK","zh-MO"].contains(next) { next = "zh-TW" }
        else if next.hasPrefix("pt") { next = "pt-BR" }
        else { next = String(next.split(separator:"-").first ?? "en") }
        if !["ar","pt-BR","cs","nl","en","fr","de","hi","id","it","ja","ko","pl","ru","zh","es","zh-TW","tr","uk"].contains(next) { next = "en" }
        let changed = next != code; code = next
        if let url = Bundle.main.resourceURL?.appendingPathComponent("host/public/locales/\(next).json"), let data = try? Data(contentsOf:url), let parsed = try? JSONSerialization.jsonObject(with:data) as? [String:String] { catalog = parsed }
        else { catalog = [:] }
        return changed
    }
}
func t(_ source: String) -> String { OpenDeckLocale.code == "ko" ? source : OpenDeckLocale.catalog[source] ?? source }
func tf(_ source: String, _ values: String...) -> String {
    var result = t(source)
    for (index,value) in values.enumerated() { result = result.replacingOccurrences(of:"{\(index)}",with:value) }
    return result
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var host: Process?
    var adoptedHostPID: Int32?
    var menuItem: NSStatusItem!
    var poll: Timer?
    var usbTimer: Timer?
    var attempts = 0
    var settingsTimer: Timer?
    var previousSettings: Data?
    var usbConnecting = false
    let usbQueue = DispatchQueue(label:"app.opendeck.usb",qos:.utility)
    var nativeStatus: [String: Any] = [:]
    var recovery: DispatchWorkItem?
    var lastRecovery = Date.distantPast
    let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/OpenDeck")

    func applicationDidFinishLaunching(_ notification: Notification) {
        _ = OpenDeckLocale.configure(settingsSection("appearance")["language"] as? String)
        let appMenu = NSMenu(); let root = NSMenuItem(); appMenu.addItem(root)
        let submenu = NSMenu(); submenu.addItem(withTitle:t("Open Deck 정보"), action: #selector(about), keyEquivalent: "")
        submenu.addItem(NSMenuItem.separator()); submenu.addItem(withTitle:t("Open Deck 종료"), action: #selector(quit), keyEquivalent: "q"); root.submenu = submenu
        let editRoot = NSMenuItem(); appMenu.addItem(editRoot); let edit = NSMenu(title: t("편집"))
        edit.addItem(withTitle:t("잘라내기"), action: Selector(("cut:")), keyEquivalent: "x"); edit.addItem(withTitle:t("복사"), action: Selector(("copy:")), keyEquivalent: "c"); edit.addItem(withTitle:t("붙여넣기"), action: Selector(("paste:")), keyEquivalent: "v"); edit.addItem(withTitle:t("모두 선택"), action: Selector(("selectAll:")), keyEquivalent: "a"); editRoot.submenu = edit; NSApp.mainMenu = appMenu
        window = NSWindow(contentRect: NSRect(x:0,y:0,width:1440,height:900),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title = "Open Deck"; window.center(); window.delegate = self; window.isReleasedWhenClosed = false
        window.minSize = NSSize(width:1050,height:680)
        let configuration=WKWebViewConfiguration();configuration.userContentController.add(self,name:"exportConfig");configuration.userContentController.add(self,name:"exportFile");configuration.userContentController.add(self,name:"nativeSettings")
        web = WKWebView(frame: .zero,configuration:configuration); web.uiDelegate = self; window.contentView = web
        menuItem = NSStatusBar.system.statusItem(withLength:NSStatusItem.variableLength); menuItem.button?.title = "◈"
        let menu = NSMenu(); menu.addItem(withTitle:t("Open Deck 열기"),action:#selector(show),keyEquivalent:"")
        menu.addItem(withTitle:t("USB 다시 연결"),action:#selector(connectUSB),keyEquivalent:"")
        menu.addItem(NSMenuItem.separator()); menu.addItem(withTitle:t("종료"),action:#selector(quit),keyEquivalent:""); menuItem.menu=menu
        applySettings()
        let startup = settingsSection("startup")
        if startup["openMinimized"] as? Bool != true { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true) }
        startHost()
        settingsTimer=Timer.scheduledTimer(withTimeInterval:2,repeats:true){[weak self] _ in self?.applySettings()}
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(self, selector:#selector(appFocusChanged), name:NSWorkspace.didActivateApplicationNotification, object:nil)
        workspace.addObserver(self, selector:#selector(resumeConnection), name:NSWorkspace.didWakeNotification, object:nil)
        workspace.addObserver(self, selector:#selector(resumeConnection), name:NSWorkspace.screensDidWakeNotification, object:nil)
        workspace.addObserver(self, selector:#selector(resumeConnection), name:NSWorkspace.sessionDidBecomeActiveNotification, object:nil)
        DistributedNotificationCenter.default().addObserver(self, selector:#selector(resumeConnection), name:NSNotification.Name("com.apple.screenIsUnlocked"), object:nil)
        connectUSB(); usbTimer=Timer.scheduledTimer(withTimeInterval:15,repeats:true){[weak self] _ in guard let self=self else{return};if self.settingsSection("usb")["autoConnect"] as? Bool != false {self.connectUSB()}}
    }
    func beginEditorPolling(){
        attempts=0
        poll=Timer.scheduledTimer(withTimeInterval:0.3,repeats:true){[weak self] _ in self?.loadEditor()}
    }
    func startHost() {
        let runtime=directory.appendingPathComponent("runtime.json")
        if let data=try? Data(contentsOf:runtime),let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let port=json["port"] as? Int,let pid=json["pid"] as? Int32,let key=json["adminKey"] as? String,port==8840,kill(pid,0)==0 {
            var request=URLRequest(url:URL(string:"http://127.0.0.1:\(port)/api/admin/lock-status")!);request.timeoutInterval=1;request.setValue(key,forHTTPHeaderField:"X-Open-Deck-Admin")
            URLSession.shared.dataTask(with:request){[weak self] _,response,_ in
                DispatchQueue.main.async {
                    guard let self=self else{return}
                    if (response as? HTTPURLResponse)?.statusCode==200 {self.adoptedHostPID=pid;self.beginEditorPolling()}
                    else {self.launchHost()}
                }
            }.resume()
            return
        }
        launchHost()
    }
    func launchHost() {
        guard let resources=Bundle.main.resourceURL else{return}
        try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        let runtime=directory.appendingPathComponent("runtime.json"); try? FileManager.default.removeItem(at:runtime)
        let p=Process(); p.executableURL=resources.appendingPathComponent("node"); p.arguments=[resources.appendingPathComponent("host/server.mjs").path]
        var env=ProcessInfo.processInfo.environment; env["OPEN_DECK_DATA"]=directory.path; p.environment=env
        let logfile=directory.appendingPathComponent("host.log"); if !FileManager.default.fileExists(atPath:logfile.path){FileManager.default.createFile(atPath:logfile.path,contents:nil,attributes:[.posixPermissions:0o600])}
        if let handle=try? FileHandle(forWritingTo:logfile){try? handle.seekToEnd();p.standardOutput=handle;p.standardError=handle}
        do{try p.run();host=p;beginEditorPolling()}catch{showError(tf("호스트를 시작하지 못했습니다: {0}",error.localizedDescription))}
    }
    func loadEditor(){
        attempts += 1
        if let data=try? Data(contentsOf:directory.appendingPathComponent("runtime.json")),let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let port=json["port"] as? Int,let key=json["adminKey"] as? String {
            poll?.invalidate();var request=URLRequest(url:URL(string:"http://127.0.0.1:\(port)/")!);request.setValue(key,forHTTPHeaderField:"X-Open-Deck-Admin");web.load(request)
        } else if attempts>80{poll?.invalidate();showError(tf("호스트가 준비되지 않았습니다. 다른 앱이 포트 8840을 사용 중인지 확인하세요. 로그: {0}",directory.appendingPathComponent("host.log").path))}
    }
    func showError(_ message:String){let alert=NSAlert();alert.messageText="Open Deck";alert.informativeText=message;alert.runModal()}
    func adbExecutable(_ usb:[String:Any])->String? {
        var candidates=["/opt/homebrew/bin/adb","/usr/local/bin/adb",FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Android/sdk/platform-tools/adb").path]
        if let custom=usb["executablePath"] as? String,!custom.isEmpty {candidates.insert(custom,at:0)}
        return candidates.first(where:{FileManager.default.isExecutableFile(atPath:$0)})
    }
    func runADB(_ executable:String,_ arguments:[String])->String? {
        let process=Process();process.executableURL=URL(fileURLWithPath:executable);process.arguments=arguments
        let pipe=Pipe();process.standardOutput=pipe;process.standardError=FileHandle.nullDevice
        do {
            try process.run()
            let timeout=DispatchWorkItem {if process.isRunning {process.terminate()}}
            DispatchQueue.global(qos:.utility).asyncAfter(deadline:.now()+8,execute:timeout)
            let data=pipe.fileHandleForReading.readDataToEndOfFile();process.waitUntilExit();timeout.cancel()
            return process.terminationStatus==0 ? String(data:data,encoding:.utf8) : nil
        } catch {return nil}
    }
    func attachedUSBDevices(_ adb:String)->[String] {
        guard let listing=runADB(adb,["devices"]) else{return []}
        return listing.split(separator:"\n").compactMap {line in
            let parts=line.split(whereSeparator:{$0==" "||$0=="\t"})
            guard parts.count==2,parts[1]=="device",!parts[0].hasPrefix("emulator-") else{return nil}
            return String(parts[0])
        }
    }
    @objc func connectUSB(){
        let usb=settingsSection("usb")
        guard usb["enabled"] as? Bool != false,!usbConnecting else{return}
        usbConnecting=true
        usbQueue.async {
            defer {DispatchQueue.main.async {self.usbConnecting=false}}
            guard let adb=self.adbExecutable(usb) else{return}
            let serial=usb["defaultDeviceSerial"] as? String ?? ""
            for device in self.attachedUSBDevices(adb) where serial.isEmpty || device==serial {
                _=self.runADB(adb,["-s",device,"reverse","tcp:8840","tcp:8840"])
            }
        }
    }
    func disconnectUSB(){
        let usb=settingsSection("usb")
        usbQueue.async {
            guard let adb=self.adbExecutable(usb) else{return}
            for device in self.attachedUSBDevices(adb) {
                guard let listing=self.runADB(adb,["-s",device,"reverse","--list"]) else{continue}
                let ownsTunnel=listing.split(separator:"\n").contains {line in
                    let parts=line.split(whereSeparator:{$0==" "||$0=="\t"})
                    return parts.count>=2 && parts.suffix(2).map(String.init)==["tcp:8840","tcp:8840"]
                }
                // Remove only Open Deck's exact reverse mapping, preserving unrelated tunnels and the shared ADB server.
                if ownsTunnel {_=self.runADB(adb,["-s",device,"reverse","--remove","tcp:8840"])}
            }
        }
    }
    @objc func resumeConnection(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self=self, Date().timeIntervalSince(self.lastRecovery)>2 else{return}
            self.lastRecovery=Date(); self.recovery?.cancel(); self.recoverConnection(attempt:0)
        }
    }
    func recoverConnection(attempt:Int) {
        connectUSB()
        let runtime=directory.appendingPathComponent("runtime.json")
        guard let data=try? Data(contentsOf:runtime), let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
              let port=json["port"] as? Int,port==8840,let key=json["adminKey"] as? String else { retryRecovery(attempt:attempt);return }
        var request=URLRequest(url:URL(string:"http://127.0.0.1:\(port)/api/admin/resume")!)
        request.httpMethod="POST";request.timeoutInterval=3;request.setValue(key,forHTTPHeaderField:"X-Open-Deck-Admin")
        URLSession.shared.dataTask(with:request){[weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self=self else{return}
                if (response as? HTTPURLResponse)?.statusCode != 200 { self.retryRecovery(attempt:attempt) }
            }
        }.resume()
    }
    func retryRecovery(attempt:Int) {
        guard attempt<5 else{return}
        let job=DispatchWorkItem{[weak self] in self?.recoverConnection(attempt:attempt+1)}
        recovery=job;DispatchQueue.main.asyncAfter(deadline:.now()+min(15,Double(2 << attempt)),execute:job)
    }
    @objc func show(){window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)}
    @objc func about(){showError("Open Deck " + (Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "") + "\n" + t("맥 호스트 + 네이티브 Android 컨트롤 패널") + "\nMIT · " + t("무료 · 오픈소스") + "\nhttps://github.com/Yaklede/open-deck")}
    @objc func quit(){NSApp.terminate(nil)}
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage){
        if message.name=="nativeSettings" {
            guard message.frameInfo.isMainFrame,let url=message.frameInfo.request.url,url.scheme=="http",url.host=="127.0.0.1",url.port==8840,let body=message.body as? [String:Any],let operation=body["operation"] as? String else{return}
            switch operation {
            case "applySettings": applySettings()
            case "reconnectUSB": connectUSB()
            case "openDataDirectory", "openLogs": NSWorkspace.shared.open(directory)
            case "openBackups": let folder=directory.appendingPathComponent("backups");try? FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true);NSWorkspace.shared.open(folder)
            case "openRelease": if let value=body["url"] as? String,let url=URL(string:value),url.scheme=="https",url.host=="github.com",url.path.hasPrefix("/Yaklede/open-deck/releases/"){NSWorkspace.shared.open(url)}
            case "openPlatformTools": if let url=URL(string:"https://developer.android.com/tools/releases/platform-tools"){NSWorkspace.shared.open(url)}
            case "openLicense": if let value=body["url"] as? String,let url=URL(string:value),url.scheme=="https",let host=url.host,["github.com","nodejs.org","opensource.org","spdx.org","scripts.sil.org","openfontlicense.org","fonts.google.com"].contains(host){NSWorkspace.shared.open(url)}
            case "openSystemPermissions": if let url=URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"){NSWorkspace.shared.open(url)}
            default: break
            };return
        }
        if message.name == "exportFile" {
            guard message.frameInfo.isMainFrame, let origin=message.frameInfo.request.url,
                  origin.scheme=="http", origin.host=="127.0.0.1", origin.port==8840,
                  let body=message.body as? [String:Any], let requested=body["filename"] as? String,
                  requested.utf8.count<=240 else { return }
            let filename=(requested as NSString).lastPathComponent
            let ext=(filename as NSString).pathExtension.lowercased()
            guard !filename.isEmpty, !filename.unicodeScalars.contains(where:{CharacterSet.controlCharacters.contains($0)}),
                  ["json","pem","txt","macrodeckprofile","macrodeckfolder","macrodeckwidget","macrodeckbackup"].contains(ext) else { return }
            let limit=96*1024*1024
            let data:Data
            if let text=body["text"] as? String, body["dataBase64"] == nil, text.utf8.count<=limit { data=Data(text.utf8) }
            else if let encoded=body["dataBase64"] as? String, body["text"] == nil, encoded.utf8.count<=(limit+2)/3*4,
                    let decoded=Data(base64Encoded:encoded), decoded.count<=limit { data=decoded }
            else { return }
            let panel=NSSavePanel();panel.nameFieldStringValue=filename
            panel.beginSheetModal(for:window){response in
                if response == .OK, let url=panel.url { do { try data.write(to:url,options:.atomic); try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path) } catch { self.showError(error.localizedDescription) } }
            }
            return
        }
        guard message.name=="exportConfig",message.frameInfo.isMainFrame,message.frameInfo.request.url?.host=="127.0.0.1",let body=message.body as? String,body.utf8.count<100663296 else{return}
        let panel=NSSavePanel();panel.nameFieldStringValue="open-deck.json";panel.beginSheetModal(for:window){response in if response == .OK,let url=panel.url{do{try body.write(to:url,atomically:true,encoding:.utf8)}catch{self.showError(error.localizedDescription)}}}
    }
    func webView(_ webView:WKWebView,runOpenPanelWith parameters:WKOpenPanelParameters,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping([URL]?)->Void){let p=NSOpenPanel();p.allowsMultipleSelection=false;p.canChooseDirectories=false;p.beginSheetModal(for:window){r in completionHandler(r == .OK ? p.urls:nil)}}
    func refreshMenuLanguage() {
        let titles:[String:String] = ["about":"Open Deck 정보","quit":"종료","show":"Open Deck 열기","connectUSB":"USB 다시 연결","cut:":"잘라내기","copy:":"복사","paste:":"붙여넣기","selectAll:":"모두 선택"]
        func update(_ menu:NSMenu?) {
            for item in menu?.items ?? [] {
                if let action=item.action, let source=titles[NSStringFromSelector(action)] { item.title=t(source) }
                if item.submenu?.items.first?.action == Selector(("cut:")) { item.submenu?.title=t("편집") }
                update(item.submenu)
            }
        }
        update(NSApp.mainMenu);update(menuItem?.menu)
    }
    func settingsSection(_ name:String)->[String:Any] {
        guard let data=try? Data(contentsOf:directory.appendingPathComponent("preferences.json")),let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else{return [:]}
        return json[name] as? [String:Any] ?? [:]
    }
    func applySettings() {
        guard let data=try? Data(contentsOf:directory.appendingPathComponent("preferences.json")), data != previousSettings,
              let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else{return}
        previousSettings=data
        let appearance=json["appearance"] as? [String:Any] ?? [:]
        if OpenDeckLocale.configure(appearance["language"] as? String) { refreshMenuLanguage() }
        let usb=json["usb"] as? [String:Any] ?? [:]
        if usb["enabled"] as? Bool == false {disconnectUSB()} else if usb["autoConnect"] as? Bool != false {connectUSB()}
        let startup=json["startup"] as? [String:Any] ?? [:]
        let showDock=startup["showDockIcon"] as? Bool ?? true
        NSApp.setActivationPolicy(showDock ? .regular : .accessory)
        var status:[String:Any]=["updatedAt":Date().timeIntervalSince1970*1000,"showDockIcon":showDock,"autostart":false,"error":""]
        let agents=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
        let destination=agents.appendingPathComponent("app.opendeck.host.plist")
        do {
            if startup["autostart"] as? Bool == true {
                try FileManager.default.createDirectory(at:agents,withIntermediateDirectories:true)
                let plist:[String:Any]=["Label":"app.opendeck.host","ProgramArguments":["/usr/bin/open","-g","-a",Bundle.main.bundlePath],"RunAtLoad":true,"ProcessType":"Background"]
                let encoded=try PropertyListSerialization.data(fromPropertyList:plist,format:.xml,options:0)
                try encoded.write(to:destination,options:.atomic)
                try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:destination.path)
                status["autostart"]=true
            } else if FileManager.default.fileExists(atPath:destination.path) {
                // Only the application's own login item is changed.
                try FileManager.default.removeItem(at:destination)
            }
        } catch {status["error"]=error.localizedDescription}
        status["fontFamilies"]=NSFontManager.shared.availableFontFamilies.sorted()
        nativeStatus=status
        if let encoded=try? JSONSerialization.data(withJSONObject:status,options:[.sortedKeys]) {
            let file=directory.appendingPathComponent("native-status.json")
            try? encoded.write(to:file,options:.atomic)
            try? FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        }
    }
    @objc func appFocusChanged(_ notification:Notification) {
        guard let app=notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,let bundleId=app.bundleIdentifier,
              let data=try? Data(contentsOf:directory.appendingPathComponent("runtime.json")),let runtime=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let port=runtime["port"] as? Int,port==8840,let key=runtime["adminKey"] as? String else{return}
        var request=URLRequest(url:URL(string:"http://127.0.0.1:8840/api/admin/focus")!)
        request.httpMethod="POST";request.timeoutInterval=2;request.setValue(key,forHTTPHeaderField:"X-Open-Deck-Admin");request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody=try? JSONSerialization.data(withJSONObject:["bundleId":bundleId])
        URLSession.shared.dataTask(with:request).resume()
    }
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows flag:Bool)->Bool {show();return true}
    func windowShouldClose(_ sender:NSWindow)->Bool{sender.orderOut(nil);return false}
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply {poll?.invalidate();usbTimer?.invalidate();settingsTimer?.invalidate();recovery?.cancel();NSWorkspace.shared.notificationCenter.removeObserver(self);DistributedNotificationCenter.default().removeObserver(self);host?.terminate();if let pid=adoptedHostPID{kill(pid,SIGTERM)}
        let usb=settingsSection("usb")
        if usb["stopServerOnExit"] as? Bool == true,let adb=adbExecutable(usb) {
            // Explicit opt-in: ADB is shared with IDEs and other Android tools.
            usbQueue.async { _=self.runADB(adb,["kill-server"]);DispatchQueue.main.async {NSApp.reply(toApplicationShouldTerminate:true)} }
            return .terminateLater
        }
        return .terminateNow
    }
    func webView(_ webView:WKWebView,runJavaScriptAlertPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping()->Void){showError(message);completionHandler()}
    func webView(_ webView:WKWebView,runJavaScriptConfirmPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(Bool)->Void){let a=NSAlert();a.messageText=message;a.addButton(withTitle:t("확인"));a.addButton(withTitle:t("취소"));completionHandler(a.runModal() == .alertFirstButtonReturn)}
    func webView(_ webView:WKWebView,runJavaScriptTextInputPanelWithPrompt prompt:String,defaultText:String?,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(String?)->Void){let a=NSAlert();a.messageText=prompt;let field=NSTextField(frame:NSRect(x:0,y:0,width:300,height:24));field.stringValue=defaultText ?? "";a.accessoryView=field;a.addButton(withTitle:t("확인"));a.addButton(withTitle:t("취소"));completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue:nil)}
}
let app=NSApplication.shared
app.setActivationPolicy(.regular)
let delegate=AppDelegate();app.delegate=delegate;app.run()
