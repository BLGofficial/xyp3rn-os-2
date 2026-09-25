# Confirmed build assumptions

User confirmed: solo developer now and over 12 months; local, on-demand releases; internal tool; no new paid services. User authorized required P12–P13 prerequisites before P14–P16. Existing completed prerequisite branch was reused rather than replaced.

Local acceptance targets (targets, not claimed production SLOs): API p50 150 ms / p95 500 ms / p99 1000 ms on warm local reads; frontend LCP 2500 ms, INP 200 ms, CLS 0.1; deployment availability target 99.5% if a continuously operated deployment is later configured. No uptime measurement or mobile-4G lab currently exists; do not display these targets as observed telemetry.

Senior Fullstack composition chain: database/migration branch reviewed P13, corrected concurrent rights/scheduling and approval atomicity; API-test branch validates P14–P15 security. Evidence belongs in phase handoffs and acceptance documents. No new cloud services.
