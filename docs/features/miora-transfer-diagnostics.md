# Miora transfer diagnostics (2026-10-13)

Scope is authorized by the user's request for detailed, redacted backend logs and independent transfer-failure investigation. This follows client architecture 8.7, 8.8, 8.13–8.15 and the backend request logger contract. Production deployment, credentials, configuration and paid reruns are excluded.

The confirmed gap is observability: public-import failures retain a safe stage/code, but route attempts, source reading, grant duration and upload duration cannot be correlated. This environment has no running Miora service or journal entries; tests cannot establish the cause of the user's historical failures.

1. Ownership: the intent store remains the source of item state; diagnostics never write business state.
2. Commands: existing import/ready/failed/consume transitions stay authoritative.
3. Tasks: diagnostics carry existing job/task/intent/request IDs and item index, without creating tasks.
4. Flows: one public import records source fetch/read verification, COS grant and single streaming PUT; this implementation does not use multipart upload.
5. Time: record monotonic elapsed milliseconds and retry delays; preserve caller cancellation and timeout classification.
6. Upstream: record method, path without query, route label, status and bounded provider code; never replay a request because logging failed.
7. Prompts: never log prompts or request/response bodies.
8. Credentials: allowlisted fields only; no cookie/token/auth/signature/query, source path or object key. A source identity is a digest of origin+pathname, never query.
9. Media: log expected/read bytes and verification outcome; retain streaming/hash checks.
10. Views: existing public failure fields remain compatible; no fake success or default data.
11. UI: no UI changes.
12. Navigation: no changes.
13. Modes: gateway/public-import and direct API diagnostics use the same helper.
14. Errors: stage, retryability, status, network/provider/request code; free-form error messages are excluded.
15. Observability: AsyncLocalStorage isolates concurrent operations. A bounded asynchronous queue emits into the existing Node service logger; storage/rotation belongs to that logger's service destination, not a second file sink. Overflow and sink failures are counted.
16. Tests: targeted transfer, transport/client and redaction/context/queue tests; no real uploads.
17. Evidence: production root-cause review needs UTC time window, intent ID/item index, client task ID, public error fields, and correlated service logs. Before an intent exists, request ID and safe HTTP/application code are needed.

Acceptance distinguishes local fake-channel tests from live-service evidence. A successful local test is not a claim that production failures are fixed.
