# 上传素材固定保留 24 小时

## 原因与修改

`AssetStore.save` 每次上传都会生成新的 `asset_<uuid>` 文件及 `.meta.json`，应用重启会恢复全部历史上传。原先只有 `JobStore` 按 `JOB_RETENTION_DAYS` 清理已完成任务记录，上传文件没有删除机制，因此 `data/uploads` 一直累计。共享渠道 bridge 转存的输入图片也沿用同一个 AssetStore。

按用户明确要求，上传素材固定 24 小时有效，任务引用或读取不能续期，也不受 `JOB_RETENTION_DAYS` 调大影响。时间以已保存的 `createdAt` 为准；旧版缺少可用元数据时采用文件最后写入时间。`get/read` 在到期时立即返回不可用；应用启动和每 15 分钟删除过期文件、对应元数据、孤立旧元数据，并清理同一素材存储中已失效的网关归属索引（包括旧 key 的记录）。保留任务的历史记录和上游身份，重新使用过期素材需重新上传。

责任模块为 `src/stores/asset-store.ts`、`src/app.ts`、`src/system-channels/video-gateway.ts`。现有远端 COS 上传意图/对象及共享项目素材另有自己的所有权，不在此次本地上传目录清理范围内。

## 验证与本地历史清理

- `pnpm exec vitest run src/stores/asset-store.test.ts src/system-channels/video-gateway.test.ts --exclude 'tmp/**'`：10/10 通过，覆盖 24 小时边界、重启与读取不续期、旧版文件、孤立元数据和旧 key 索引。
- `pnpm typecheck`：通过；`git diff --check`：通过。
- 本机 `.env` 的 `DATA_DIR=./data`，已确认 `D:/workspace/hailuo/data/uploads` 为此 AssetStore 的上传目录。执行前未发现命令行包含 hailuo 或 `server.ts/js` 的本地 Node 服务。
- 用户明确授权清除本地超过 24 小时数据后，使用修改后的 AssetStore 执行实际清理：删除 28,415 个素材文件（28,414 PNG、1 MP4）及 24,084 个 sidecar，释放 **63,625,590,761 字节（59.256 GiB）**；无错误。
- 清理后该目录文件数与字节数均为 0；本次全部旧上传均已超过 24 小时，没有 24 小时内素材被删除。
- 未提交、推送、部署或操作生产目录。服务运行时自动清理需在后续正常重启/部署此版本后生效；本地历史清理已实际完成。
