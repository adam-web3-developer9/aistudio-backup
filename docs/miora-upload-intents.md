# Miora upload intents

The managed video gateway prepares Miora references before it creates a paid generation job.

- `POST /v1/upload-intents` selects and pins one enabled Miora account.
- Hash-verified public imports are reused by account, SHA-256, size, MIME type and media kind. Direct client PUTs are not added to the cross-task cache because the server cannot independently prove their content hash.
- Public HTTPS media from `MIORA_PUBLIC_MEDIA_HOSTS` is streamed into the account's Tencent COS prefix.
- Local-only media receives a ten-minute PUT request signed for one exact object, MIME type and byte length.
- `POST /v1/upload-intents/:id/complete` verifies the COS object and exact byte length before recording a successful direct upload.
- `GET /v1/upload-intents/:id` reports preparation status.
- `POST /v1/jobs` with `uploadIntentId` persists and owns one deterministic gateway job before consuming the intent. Repeating it returns that job; it never recreates a pruned paid job.

Miora credentials and STS secrets never leave the server. Legacy `/v1/assets` remains available for older clients and other adapters.
