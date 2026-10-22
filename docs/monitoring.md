# Mac monitoring and Grafana

The Monitor template prioritizes two native Grafana cards: system CPU/collection status and database readiness/CPU/TPS/connections. One compact Mac card sits below them. Tap the Mac card for CPU, memory, storage, power/thermal and network tabs. Calendar widgets and the Jimin OS page remain available separately.

## Mac cards

- CPU: whole-machine utilization normalized to 0–100%, a recent trend, and per-core details on tap.
- Memory: app, wired and compressed memory, kernel memory-pressure state, swap, and recent utilization. Missing pressure is shown as unknown.
- Storage: shared APFS data-volume capacity and available space, plus block-device read/write throughput.
- Network: receive/send throughput on active physical `en*` interfaces. Loopback, VPN and bridge interfaces are excluded from this total.
- Power: battery charge, AC power, charging, low-power mode and the OS thermal-pressure state. This is not a temperature sensor.
- Apps: the top five observable processes by CPU or physical footprint. Tap to switch between CPU and memory lists. CPU 100% means one logical core; a multithreaded process may exceed 100%.
- Overview: hardware, uptime and concrete memory, storage or thermal warnings.

A signed Swift helper samples host counters every two seconds and process counters every six seconds. Rates use counter deltas over monotonic elapsed time. Process CPU uses `proc_pid_rusage` with Mach-timebase conversion and guards against PID reuse. The first rate sample stays unavailable until a comparison exists. The host retains only 120 in-memory history points, hides stale values after eight seconds, and retries a failed helper with bounded backoff.

Telemetry is sent only through the existing paired-device connection. Process entries contain a short executable name and PID; command arguments, full paths and environment variables are not sent. No extra monitoring service or exporter is installed. Running the Node host from source requires setting `OPEN_DECK_METRICS_HELPER` to a locally compiled helper; the packaged Mac app includes it.

## Native Grafana cards

The Android app renders Grafana values and trends directly with Canvas. It does not open a browser or embed a WebView. Both cards share a project selection: tap the project row or long-press either card to change it. Selection persists on the tablet and updates both cards immediately from cached results.

- System: maximum reported `system_cpu_usage` across jobs, the individual job values, a one-hour trend and successful scrape targets out of total observed targets. These are system CPU values reported by the service runtimes, not Mac CPU or a sum of the entire cluster's CPU. Scrape success does not guarantee every business function is healthy.
- Database: readiness, maximum CPU utilization among observed nodes, per-node CPU, committed TPS, QPS, memory and total observed connections. The detail view uses six large numeric cards and switchable TPS, QPS, CPU and memory charts. QPS sums the dashboard’s per-node Questions rates; memory reports the highest observed node utilization. A failed observed MariaDB exporter prevents a healthy readiness badge.
- Mac: one supporting summary of CPU, memory, storage, power/thermal state and network. Its detail tabs use a balanced two-column layout with current values and native trend charts: CPU, memory utilization, disk read/write throughput, battery level and network receive/send throughput. They refresh every two seconds. App-level CPU/memory lists remain accessible from that dialog.

Grafana detail dialogs also put the metric summary beside its native one-hour chart. The monitor and detail views contain no embedded webpage.

The Mac editor configures the HTTPS dashboard URL, CPU/TPS panel IDs, project labels/values, default and optional token use. The source dashboard supplies the queries; project values are validated before substitution. Standard Open Deck dashboards also provide readiness, system CPU, scrape status and connection panels. Missing optional panels remain unavailable.

The Mac host queries Grafana every 30 seconds with at most two concurrent project requests and shares results between cards. It keeps 60 trend points per metric, bounds HTTP bodies/timeouts, rejects redirects, excludes source samples older than five minutes and hides results whose query timestamp is older than 90 seconds. Connection failures show an error instead of stale values or invented zeros. Source collection intervals can delay the latest CPU point even when a query just succeeded.

For authenticated Grafana, create a dedicated Viewer service account token and store it through the widget editor. The token is stored in macOS Keychain, never in deck JSON, exports, Android settings or snapshots. Dashboard URLs and private query configuration stay on the Mac. The paired tablet receives only bounded values, labels, timestamps and histories. Browser cookies and the Codex connector's credentials are not reused. Administration APIs remain blocked on Wi-Fi.

For an existing Kubernetes/Galera deployment, the configured dashboard uses the existing Cloud Monitoring and Prometheus/Mimir data sources:

- DB CPU: `kubernetes.io/container/cpu/limit_utilization`, filtered by the selected namespace and the database container, grouped by pod. It represents utilization relative to the container CPU limit.
- DB TPS: `sum(rate(mysql_global_status_wsrep_local_commits{job="mariadb-exporter",namespace="$project"}[5m]))`. This is Galera local committed transactions per second, not QPS, read-only transactions or replicated transaction applications.
- Separate panels cover readiness, memory, connections, QPS, service CPU/JVM heap, HTTP throughput, latency and 5xx errors.
- DB memory sums evictable and non-evictable utilization within each cluster and pod so the gauge shows a node total rather than two identically named category gauges.

Every panel is scoped to the selected project. A project without an exporter or database reports no data; it does not silently show another project's values or substitute zero. Grafana connections, project identifiers and deployment-specific dashboard definitions stay in private configuration.

References: [Apple CPU accounting](https://github.com/apple-oss-distributions/xnu/blob/main/doc/observability/recount.md), [MariaDB Galera status variables](https://mariadb.com/docs/galera-cluster/reference/galera-cluster-status-variables), [Google Kubernetes system metrics](https://docs.cloud.google.com/monitoring/api/metrics_kubernetes).

## Thresholds and tablet alerts

In the Mac widget editor, expand **임계치 · 태블릿 알림** and save changes. CPU, memory, TPS, QPS and connection rules can use an upper or lower threshold. CPU defaults to warning at 80% and critical at 90%; memory defaults to 85%/95%. TPS, QPS and connection thresholds start disabled because their useful limits depend on the workload. DB not-ready and failed scrape targets also indicate critical status. Normal numeric values use neutral text; a small green status badge indicates normal collection. Amber and red highlight warning and critical values and trends, while missing/stale samples stay unknown.

Color follows the current observation immediately. Notifications wait for the configured hold duration (default 60 seconds), repeat no more than once per cooldown (default 600 seconds) while the same condition persists, and report sustained recovery. A brief spike or missing data resets the hold. Projects are tracked independently. Turning notification delivery off preserves color classification. The editor includes a clearly labeled test notification; paired devices cannot call that admin endpoint.

While the tablet app is connected, new monitor events produce a private Android notification and a 12-second in-app banner. The banner stays visible inside Open Deck even when Android suppresses system popups; notification sound and system presentation still follow Android settings. Tap the banner/notification to open the relevant monitor page and project. This is the existing local paired connection, not a background cloud push service.

The main DB card compares individual database nodes: each node has a CPU gauge, memory percentage, a memory-capacity bar and actual GiB for that same node; a shared one-hour chart compares CPU traces. Aggregate TPS and QPS with small trend charts and total DB connections stay in a separate summary below. Missing or ambiguous byte series remain unavailable; bytes are never inferred from percentage. The source dashboard's optional memory-byte panel uses the existing Cloud Monitoring container memory-used counter grouped by cluster/pod. Mac memory likewise shows actual used/total GiB and percentage.

Monitor titles use the saved widget label rather than hardcoded text. The editor's title/text-size and separate numeric-size controls are delivered with the normal configuration revision; use **변경 저장** to publish edits to connected tablets without restarting the app. Page names also follow the saved configuration.


## Visual hierarchy

The monitor leads with system CPU as its largest figure. The DB card follows Grafana’s gauge/time-series/stat structure: per-node CPU dials with configured warning/critical markers, smaller memory values and bars, a shared CPU comparison chart, and total TPS/QPS/connection stats. Smaller total TPS/QPS readings include separate sparklines. The saved numeric-size setting controls the scale while preserving these relative priorities. Metric labels, numeric values, captions, bars and graphs use the same 20dp left/right inset; corresponding rows share their baseline.

Service/job rows and connections remain in the detail dialogs. DB details also retain the full node list, including memory percentage and actual GiB. The supporting Mac strip shows CPU, memory percentage/GiB and actionable warnings, with storage, thermal and network details available on tap. Normal colors are quiet; status badges and exceptional states carry color.

The OS template uses a calendar, a central schedule/task summary, and smaller request/notification cards. Schedule creation, tasks and the assistant are primary actions; requests, scheduled work, meetings and refresh are secondary actions. All original actions remain available. OS notification history excludes separate monitor notifications, which still arrive through the tablet notification channel and in-app banner. Existing Workspace pages are preserved.

Node identity is joined by exact DB pod name across CPU, memory percentage and actual-byte series. Duplicate identities produce unknown values rather than an arbitrary match. Prometheus exporter pod names are not assumed to identify the matching database pod: TPS/QPS and scrape health remain aggregate unless a verified mapping is available. The main view shows up to four nodes, with an explicit remaining-node count and the full list available on tap. Missing or ambiguous values show a dash.

## Grafana presentation reference

The native overview follows the existing dashboard’s gauge, time-series and stat roles. System CPU remains the largest readout; CPU dials share a 0–100% utilization range and show markers for the user’s actual enabled thresholds. Readout colors stay neutral while normal; threshold breaches change the affected node’s number, dial and memory bar independently. Quiet non-status colors identify nodes consistently between names, gauges and CPU traces.

CPU comparison traces use one common time window and percentage axis, rather than stretching each node’s samples independently. The chart includes clock labels and percentage grid lines; values above 100% expand the common DB chart scale. Missing intervals over two minutes break the line. TPS/QPS sparklines are independently scaled rate trends and do not share the CPU axis. Query time is labeled as query time, not as the age of every source sample.

The existing backend queries, permissions, polling rate and native rendering remain unchanged. Grafana rendering is recreated with local Canvas primitives; no browser, webview, image renderer or additional renderer service is required. Saved page geometry, labels and font settings are retained.

Design references: [Grafana visualization roles](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/), [gauge visualization](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/gauge/), and [dashboard best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/).

## Unlock recovery and data freshness

The Mac app observes workspace wake/display wake/session-active events and the unlock notification. It recreates USB forwarding, asks the authenticated localhost host to refresh queries, and closes existing tablet event streams so they reconnect cleanly. Repeated wake notifications are coalesced and failed localhost recovery requests retry with bounded backoff. A host event-loop gap over ten seconds also initiates recovery. None of this changes the lock or sleep policy, restarts the editor, or replays actions.

The tablet detects eight seconds without a snapshot, marks the connection offline, and reconnects using the existing encrypted Wi-Fi/USB fallback. Resume checks the stream too. Every five seconds, visible monitoring cards reevaluate freshness locally even if no new snapshot arrives. Disconnected or query-stale cards hide current numeric values and show an explicit red connection/query interruption state. Historical source time remains labeled as the last collection.

Main cards show source collection timestamps and elapsed age, independently of query time. Prometheus aggregate/rate evaluation timestamps are not treated as scrape timestamps: a scoped companion `min(timestamp(raw_selector))` query reports the oldest contributing raw sample. Unsupported or ambiguous selectors leave collection time unknown. Cloud Monitoring uses the original returned metric point time, which can represent an aligned/aggregated point rather than the exact exporter scrape instant. CPU/memory node times are kept separate. The detail view retains the API query time separately.

Prometheus sources become delayed at 90 seconds; Cloud Monitoring CPU/memory at 180 seconds to accommodate their observed collection latency. At five minutes, source data is stale and current values become unavailable. Missing collection metadata is explicitly unknown. Delayed data uses amber labels/values; stale, disconnected or stopped-query states use a red badge/border. Resource-critical coloring retains precedence over collection-delay amber. The existing CPU/memory resource thresholds remain independently configurable.

Alerts cannot continue a danger or recovery hold on delayed, stale or incomplete source data, even if the API query succeeded. A resumed query generation aborts superseded requests and ignores late old results, preserving bounded concurrency and preventing old data from overwriting new samples. Recovery is an admin-only localhost operation, unavailable to paired devices or LAN clients.
