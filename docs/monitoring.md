# Mac monitoring and Grafana

The Monitor template contains seven native Mac status cards and a Grafana card. It does not include a calendar. Existing calendar widgets and the Jimin OS page remain available separately.

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

## Grafana card

Set the HTTPS dashboard URL, project variable name, project labels/values and default in the Mac widget editor. The tablet remembers its selected project for this widget. Tap the card's project row, or long-press the card, to change it. Tap the body to open the selected dashboard. The URL receives `var-<variable>=<selected value>` while retaining unrelated query parameters.

Grafana uses an Android browser Custom Tab and that browser's normal authentication session. It is a dashboard launcher, not embedded native Grafana charts. First use may need browser setup and Grafana login. Open Deck does not relay a Mac session, store a Grafana API token or bypass Grafana access controls. The native Mac cards work independently of Grafana availability.

For a tablet-focused view, add `kiosk=1` to the configured URL to hide Grafana's management navigation. Project selection still comes from the native card; the dashboard also retains its variable selector in the verified Grafana version.

For an existing Kubernetes/Galera deployment, the configured dashboard uses the existing Cloud Monitoring and Prometheus/Mimir data sources:

- DB CPU: `kubernetes.io/container/cpu/limit_utilization`, filtered by the selected namespace and the database container, grouped by pod. It represents utilization relative to the container CPU limit.
- DB TPS: `sum(rate(mysql_global_status_wsrep_local_commits{job="mariadb-exporter",namespace="$project"}[5m]))`. This is Galera local committed transactions per second, not QPS, read-only transactions or replicated transaction applications.
- Separate panels cover readiness, memory, connections, QPS, service CPU/JVM heap, HTTP throughput, latency and 5xx errors.
- DB memory sums evictable and non-evictable utilization within each cluster and pod so the gauge shows a node total rather than two identically named category gauges.

Every panel is scoped to the selected project. A project without an exporter or database reports no data; it does not silently show another project's values or substitute zero. Grafana connections, project identifiers and deployment-specific dashboard definitions stay in private configuration.

References: [Apple CPU accounting](https://github.com/apple-oss-distributions/xnu/blob/main/doc/observability/recount.md), [MariaDB Galera status variables](https://mariadb.com/docs/galera-cluster/reference/galera-cluster-status-variables), [Google Kubernetes system metrics](https://docs.cloud.google.com/monitoring/api/metrics_kubernetes).
