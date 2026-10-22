import AppKit
import WebKit
import Darwin

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var host: Process?
    var adoptedHostPID: Int32?
    var menuItem: NSStatusItem!
    var poll: Timer?
    var usbTimer: Timer?
    var attempts = 0
    let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/OpenDeck")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let appMenu = NSMenu(); let root = NSMenuItem(); appMenu.addItem(root)
        let submenu = NSMenu(); submenu.addItem(withTitle: "Open Deck 정보", action: #selector(about), keyEquivalent: "")
        submenu.addItem(NSMenuItem.separator()); submenu.addItem(withTitle: "Open Deck 종료", action: #selector(quit), keyEquivalent: "q"); root.submenu = submenu
        let editRoot = NSMenuItem(); appMenu.addItem(editRoot); let edit = NSMenu(title: "편집")
        edit.addItem(withTitle: "잘라내기", action: Selector(("cut:")), keyEquivalent: "x"); edit.addItem(withTitle: "복사", action: Selector(("copy:")), keyEquivalent: "c"); edit.addItem(withTitle: "붙여넣기", action: Selector(("paste:")), keyEquivalent: "v"); edit.addItem(withTitle: "모두 선택", action: Selector(("selectAll:")), keyEquivalent: "a"); editRoot.submenu = edit; NSApp.mainMenu = appMenu
        window = NSWindow(contentRect: NSRect(x:0,y:0,width:1440,height:900),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title = "Open Deck"; window.center(); window.delegate = self; window.isReleasedWhenClosed = false
        window.minSize = NSSize(width:1050,height:680)
        let configuration=WKWebViewConfiguration();configuration.userContentController.add(self,name:"exportConfig")
        web = WKWebView(frame: .zero,configuration:configuration); web.uiDelegate = self; window.contentView = web
        menuItem = NSStatusBar.system.statusItem(withLength:NSStatusItem.variableLength); menuItem.button?.title = "◈"
        let menu = NSMenu(); menu.addItem(withTitle:"Open Deck 열기",action:#selector(show),keyEquivalent:"")
        menu.addItem(withTitle:"USB 다시 연결",action:#selector(connectUSB),keyEquivalent:"")
        menu.addItem(NSMenuItem.separator()); menu.addItem(withTitle:"종료",action:#selector(quit),keyEquivalent:""); menuItem.menu=menu
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true)
        startHost()
        connectUSB(); usbTimer=Timer.scheduledTimer(withTimeInterval:15,repeats:true){[weak self] _ in self?.connectUSB()}
    }
    func beginEditorPolling(){
        attempts=0
        poll=Timer.scheduledTimer(withTimeInterval:0.3,repeats:true){[weak self] _ in self?.loadEditor()}
    }
    func startHost() {
        let runtime=directory.appendingPathComponent("runtime.json")
        if let data=try? Data(contentsOf:runtime),let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let port=json["port"] as? Int,let pid=json["pid"] as? Int32,let key=json["adminKey"] as? String,port==8840,kill(pid,0)==0 {
            var request=URLRequest(url:URL(string:"http://127.0.0.1:\(port)/api/admin/info")!);request.timeoutInterval=1;request.setValue(key,forHTTPHeaderField:"X-Open-Deck-Admin")
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
        do{try p.run();host=p;beginEditorPolling()}catch{showError("호스트를 시작하지 못했습니다: \(error.localizedDescription)")}
    }
    func loadEditor(){
        attempts += 1
        if let data=try? Data(contentsOf:directory.appendingPathComponent("runtime.json")),let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let port=json["port"] as? Int,let key=json["adminKey"] as? String {
            poll?.invalidate();var request=URLRequest(url:URL(string:"http://127.0.0.1:\(port)/")!);request.setValue(key,forHTTPHeaderField:"X-Open-Deck-Admin");web.load(request)
        } else if attempts>80{poll?.invalidate();showError("호스트가 준비되지 않았습니다. 다른 앱이 포트 8840을 사용 중인지 확인하세요. 로그: \(directory.path)/host.log")}
    }
    func showError(_ message:String){let alert=NSAlert();alert.messageText="Open Deck";alert.informativeText=message;alert.runModal()}
    @objc func connectUSB(){
        DispatchQueue.global(qos:.utility).async{
            let candidates=["/opt/homebrew/bin/adb","/usr/local/bin/adb",FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Android/sdk/platform-tools/adb").path]
            guard let adb=candidates.first(where:{FileManager.default.isExecutableFile(atPath:$0)}) else{return}
            let p=Process();p.executableURL=URL(fileURLWithPath:adb);p.arguments=["devices"];let pipe=Pipe();p.standardOutput=pipe;p.standardError=FileHandle.nullDevice
            do{try p.run();let data=pipe.fileHandleForReading.readDataToEndOfFile();p.waitUntilExit();let text=String(data:data,encoding:.utf8) ?? ""
                for line in text.split(separator:"\n"){let parts=line.split(whereSeparator:{$0==" "||$0=="\t"});if parts.count==2 && parts[1]=="device" && !parts[0].hasPrefix("emulator-"){
                    let reverse=Process();reverse.executableURL=URL(fileURLWithPath:adb);reverse.arguments=["-s",String(parts[0]),"reverse","tcp:8840","tcp:8840"];reverse.standardOutput=FileHandle.nullDevice;reverse.standardError=FileHandle.nullDevice;try? reverse.run();reverse.waitUntilExit()
                }}
            }catch{}
        }
    }
    @objc func show(){window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)}
    @objc func about(){showError("Open Deck 0.8.2\n맥 호스트 + 네이티브 Android 컨트롤 패널\nMIT 오픈소스 · 계정과 구독 없음\nhttps://github.com/Yaklede/open-deck")}
    @objc func quit(){NSApp.terminate(nil)}
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage){
        guard message.name=="exportConfig",message.frameInfo.isMainFrame,message.frameInfo.request.url?.host=="127.0.0.1",let body=message.body as? String,body.utf8.count<16777216 else{return}
        let panel=NSSavePanel();panel.nameFieldStringValue="open-deck.json";panel.beginSheetModal(for:window){response in if response == .OK,let url=panel.url{do{try body.write(to:url,atomically:true,encoding:.utf8)}catch{self.showError(error.localizedDescription)}}}
    }
    func webView(_ webView:WKWebView,runOpenPanelWith parameters:WKOpenPanelParameters,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping([URL]?)->Void){let p=NSOpenPanel();p.allowsMultipleSelection=false;p.canChooseDirectories=false;p.beginSheetModal(for:window){r in completionHandler(r == .OK ? p.urls:nil)}}
    func windowShouldClose(_ sender:NSWindow)->Bool{sender.orderOut(nil);return false}
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply {poll?.invalidate();usbTimer?.invalidate();host?.terminate();if let pid=adoptedHostPID{kill(pid,SIGTERM)};return .terminateNow}
    func webView(_ webView:WKWebView,runJavaScriptAlertPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping()->Void){showError(message);completionHandler()}
    func webView(_ webView:WKWebView,runJavaScriptConfirmPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(Bool)->Void){let a=NSAlert();a.messageText=message;a.addButton(withTitle:"확인");a.addButton(withTitle:"취소");completionHandler(a.runModal() == .alertFirstButtonReturn)}
    func webView(_ webView:WKWebView,runJavaScriptTextInputPanelWithPrompt prompt:String,defaultText:String?,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(String?)->Void){let a=NSAlert();a.messageText=prompt;let field=NSTextField(frame:NSRect(x:0,y:0,width:300,height:24));field.stringValue=defaultText ?? "";a.accessoryView=field;a.addButton(withTitle:"확인");a.addButton(withTitle:"취소");completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue:nil)}
}
let app=NSApplication.shared
app.setActivationPolicy(.regular)
let delegate=AppDelegate();app.delegate=delegate;app.run()
