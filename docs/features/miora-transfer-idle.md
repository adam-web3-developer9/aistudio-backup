# Miora transfer inactivity (2026-10-13)

The user authorized completing the long-preparation omissions, including finite no-progress failure after removing aggregate client clocks. Keep the existing account ownership, source host/hash/size checks, COS signature validity and finite retry schedule.

Each existing source-to-COS attempt shares one inactivity watchdog. Source headers, source chunks, upload verification and COS response/error-body chunks reset it. The default inactivity interval is ten minutes, matching the previous preparation network interval, with no total-transfer deadline. A watchdog abort becomes typed `TRANSFER_IDLE_TIMEOUT`, records the active source/COS stage and remains transient under the existing retry budget. Caller cancellation remains terminal and is kept distinct from the watchdog signal. Failed/redirected responses are closed; blocked source reads race cancellation and release their iterator.

The initial grant retains its existing finite retry budget. Each subsequent source/PUT attempt asks for one fresh grant and signs just in time; a grant failure consumes that existing attempt and introduces no nested retry schedule. This prevents reusing an expired ten-minute signed PUT after an idle timeout while preserving the original media identity and intent.

The service coordinator cancels active transfers at shutdown with a retryable `TRANSFER_SERVICE_STOPPED`; unstarted items remain resumable. Shutdown waits for those import runners to settle before flushing final diagnostics. Missing account credentials before per-item work now records explicit terminal preparation failures rather than leaving items importing forever. Read-only diagnostics never start imports.

Acceptance is limited to fake transports: pre-header/read/PUT stalls fail finitely with the correct stage; sustained chunk progress beyond an idle interval succeeds; retries keep the same count; caller cancellation and service shutdown do not restart reads. The preparation HTTP fixture proves missing credentials persist a typed failure without a provider call. No deployment, production configuration, real media or paid work is exercised.
