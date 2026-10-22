# 0.8.1 validation

- 59 Node tests pass, including template validation, paired snapshots, OS mutation scoping and monitor alerts. Signed Android release build/lint and optimized Mac app/helper build pass.
- The physical tablet shows a CPU-first monitor: the system CPU figure leads, DB CPU/MEM precede smaller TPS/QPS values, and numeric values/captions use one common inset. Normal figures use neutral color; only badges and abnormal conditions carry status color.
- Service rows and connection details remain accessible in Grafana details. Server footer opens details; DB footer opens shared project selection; the compact Mac strip opens all five live detail tabs.
- The OS page preserves its 11 widgets and all seven actions while separating schedule/tasks, requests, notifications and primary/secondary actions. The native schedule form, task list and notification history are verified without submitting production mutations.
- A before/after digest confirms the existing Workspace page configuration is unchanged. Personal page names, connector addresses, projects, credentials and threshold/notification settings are preserved. Private configuration backups precede layout changes.
- Screenshots of live monitor/OS screens remain in private output artifacts. No production calendar/task writes, unrelated launcher actions or Mac reboot are performed.
