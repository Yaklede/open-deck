# Vorssaint · Mac 도구

Open Deck connects to the separately installed [Vorssaint 3.4.2](https://github.com/vorssaint/vorssaint-utils/releases/tag/v3.4.2) macOS utility. The integration targets upstream commit `833967fd45153fc9dc95651d34c867f5c4aee7f1` and its `com.vorssaint.utils` preference interface. Vorssaint requires macOS 14 or later; Open Deck itself still supports macOS 13.

## Setup

1. Install the official signed Vorssaint app at `/Applications/Vorssaint.app` and choose its features on the Mac.
2. In the Open Deck Mac editor, open **변수 · 연동 → Vorssaint** and choose **＋ Vorssaint**.
3. Open **Mac 도구** on the paired tablet. Each category opens native Android settings. The Mac editor also offers the same category forms.
4. Change options, then choose **저장하고 적용**. Draft edits and cancelled forms do not change Mac settings.

The page uses the normal editable grid. Its cards can be moved, resized, renamed and styled in the Mac editor. Adding the integration preserves existing pages and appends the new page to the default profile. Add it to other profiles with the regular profile editor when needed.

## Available controls

| Category | Scope |
| --- | --- |
| 에너지·화면 | Keep awake, display/brightness utilities and related options |
| 창·Dock | Window, Dock and workspace utility visibility and switches |
| 마우스·키보드 | Input utilities, smooth scrolling, focus and debounce options |
| 소리 | Audio utility visibility and switches |
| 클립보드·파일 | Clipboard and file utility visibility and switches |
| Dynamic Island | Island utility visibility and switches |
| 메뉴 막대 모니터 | CPU, GPU, memory, network, disk and power monitor visibility |
| 앱·도구 | App and miscellaneous utility visibility and switches |
| 공통 설정 | Vorssaint appearance and language |

The pinned catalog contains 77 feature entries and 151 typed preference fields. A feature's **Vorssaint에 표시** option controls its availability in Vorssaint; features with a separate enabled preference expose that switch as well. Changing visibility alone does not execute an arbitrary utility action.

The quick buttons start a 30-minute keep-awake session or stop it. Stop disables the keep-awake feature in Vorssaint, which releases its sleep-prevention assertion. Starting a session enables the feature and its automatic start with a 30-minute duration. These changes persist in Vorssaint.

App-specific volume controls, editable app/file lists, device selectors, global hotkeys, clipboard contents and other complex runtime tools remain in the official Mac app. **Mac에서 상세 설정** opens that app. This integration is not a full remote replica of every Vorssaint window. macOS Accessibility, Screen Recording and similar permissions must be granted through the normal Mac flow when a selected feature needs them; Open Deck does not grant them.

## Applying and synchronization

Vorssaint does not publish an external command API. Open Deck therefore reads an explicit allowlist of preference keys with a small native helper. A save validates field types, ranges and choices, checks that the settings have not changed since the form opened, asks Vorssaint to quit gracefully, rechecks the revision, writes only changed keys, then starts Vorssaint in the background. The Mac and other apps remain running.

An outdated form returns a conflict instead of overwriting newer settings. Close and reopen that category to load its latest values. Only one save runs at a time. If the app refuses to quit, the write is cancelled. If saving succeeds but starting the app fails, the UI reports that separately.

Reopening a form reads the latest Mac preferences. Page connection status and category visibility counts refresh approximately every six seconds. The page stream contains summaries, not the complete settings catalog. Existing paired-device tokens and page/profile access control apply to both USB and pinned HTTPS Wi-Fi requests.

Before a write, Open Deck keeps the previous values of the changed fields in `~/Library/Application Support/OpenDeck/vorssaint-settings-backups/`. The folder is private to the local user and retains the latest 20 saves. Other preferences, clipboard contents, accounts and personal files are not read or backed up by this adapter.

Vorssaint is installed separately and retains its own GPL-3.0-or-later license and signature. Open Deck does not distribute its app or source code. The adapter and native form implementation are Open Deck code; the catalog records public interface keys and setting metadata. A future Vorssaint version that changes those interfaces may require an adapter update.
