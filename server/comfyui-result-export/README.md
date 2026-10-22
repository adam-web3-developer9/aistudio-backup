# ComfyUI result export 扩展

仅提供已完成结果的摘要查询和 GPU 本机到火山 TOS 的预签名 PUT 上传，不提交工作流、不执行任意命令、不删除或移动文件。Hailuo 只处理 JSON 控制数据；视频字节不经 Hailuo 网关。

**这是源码扩展，不表示已安装、已上线、已验证当前 GPU 镜像或已完成真实 TOS 上传。** 本地测试不操作实例、不消耗生成额度、不调用远端写接口。

## 安装与配置

运行环境：Linux/POSIX、Python 3.10+、现有 ComfyUI `aiohttp`/`yarl` 依赖。无需 TOS SDK。必须支持 `openat`（Python `dir_fd`）、`O_NOFOLLOW` 和 `O_DIRECTORY`；不支持的平台直接拒绝文件操作，不使用不安全的路径检查降级。输出目录及其所有祖先目录不得为符号链接。

由管理员在授权维护窗口将整个目录复制到 `<ComfyUI>/custom_nodes/hailuo_result_export/`，然后在 **ComfyUI 进程**的环境配置中设置：

```dotenv
HAILUO_RESULT_EXPORT_SECRET=<独立随机密钥，UTF-8编码后至少32字节；建议32随机字节的hex表示>
```

该密钥由可信控制端和 GPU 扩展独立共享，不是 TOS AK/SK，不是 AIGate Token，也不要复用网关 API Key。长期 TOS AK/SK 仅留签名服务；GPU 仅收到单对象、短期有效的预签名 URL。配置后需要管理员明确授权重启 ComfyUI 才生效；本目录不自动安装或重启。

扩展通过 `PromptServer.instance.routes` 注册两个路由，无工作流节点。需核实当前镜像支持 custom_nodes，以及 `prompt_queue.get_history(prompt_id)` 保留标准原生历史。镜像若禁止安装扩展或隐藏/清理历史，必须先处理兼容性，不能绕过归属验证。外层反向代理必须启用 HTTPS，限制请求体并保留原始请求字节；建议增加来源网络限制，不记录请求体、签名、预签名 URL。

## 请求契约

两个接口均为 POST，原始正文为 UTF-8 JSON，最大 65536 字节，不接受压缩正文。先序列化一次，再按这份**完全一致的原始字节**计算：

```text
X-Hailuo-Export-Signature = hex(HMAC-SHA256(secret_utf8_bytes, raw_body_bytes))
Content-Type: application/json
```

`secret` 按配置原文的 UTF-8 字节使用，不把 hex 配置字符串再 hex 解码。签名覆盖整个 JSON，包括目标 URL、头、文件摘要和过期时间。JSON 重复键、非标准数值、未知顶层字段都会拒绝；不接受多个签名头。

### POST /hailuo/result-export/describe

```json
{
  "expiresAt": 1790000060000,
  "jobId": "job-example",
  "promptId": "prompt-example",
  "output": {
    "filename": "result.mp4",
    "subfolder": "job-example",
    "type": "output",
    "nodeId": "12"
  }
}
```

时间值只是格式示例，实际必须满足 `当前毫秒 < expiresAt <= 当前毫秒 + 120000`。控制端和 GPU 需要时钟同步。`jobId` 必须等于提交时写入 `extra_data.hailuoAttemptId` 的值，不能擅自用另一个业务 ID 替代。`promptId` 同时匹配历史 key 和历史 `prompt[1]`；历史必须 `completed=true` 且 `status_str=success`。

仅允许 `output` 目录中普通、非空、单硬链接的 `.mp4` 文件。拒绝绝对路径、父目录穿越、反斜杠、冒号、控制字符、符号链接（包括祖先目录）、硬链接和特殊文件。逐级从根目录以只读文件描述符打开，文件名/子目录/type 必须与指定节点的历史输出描述符逐字段精确一致。`nodeId` 可省略，但此时所有节点中只能有一个匹配；有歧义就拒绝。允许历史描述符保留额外字段，不能借额外字段改变文件选择。MP4 按后缀筛选，不代表验证视频编码/容器完整性。

成功响应为：

```json
{"size":123456,"sha256":"64位小写hex摘要","md5":"16字节MD5摘要的标准base64"}
```

以 1 MiB 块流式计算哈希，内存不随视频大小增长。单 PUT 文件上限保守限制为 5 GiB；更大文件不走此协议。

### POST /hailuo/result-export/upload

包含 describe 的全部字段，额外携带：

```json
{
  "file": {"size":123456,"sha256":"describe返回值","md5":"describe返回值"},
  "target": {
    "url":"https://<bucket>.tos-<region>.volces.com/<object-key>?<TOS4预签名参数>",
    "headers": {
      "Content-Type":"video/mp4",
      "Content-MD5":"describe返回值",
      "x-tos-meta-sha256":"describe返回值",
      "x-tos-acl":"public-read"
    }
  }
}
```

示例仅展示额外字段，不能单独提交。每次请求重新生成 `expiresAt` 和 HMAC。

签名服务在可信端为精确 bucket/key 签发 **PUT** URL，并给上传留足有效期。当前 TOS adapter 使用900秒 TOS4 URL，`X-Tos-SignedHeaders=content-md5;content-type;host;x-tos-acl;x-tos-meta-sha256`，四个上传头同时被 URL 签名和 export HMAC 绑定。扩展拒绝缺少任一必需签名头的目标。SDK 2.9.1 的公开预签名接口仅签 host，真实上传会被 TOS 以403拒绝；PUT签名不再使用该接口，HEAD/DELETE仍使用SDK。HMAC 请求的 120 秒窗口仅用于请求准入；已验签且准入的操作，不在哈希后或 PUT 前重查该窗口，因此慢读超过 120 秒不会仅因请求 expiresAt 过期而失败。PUT 前仍重新检查 TOS 预签名 URL 尚未过期。describe 整个请求最多 60 秒，upload 整个请求（读正文、校验、哈希及上传）最多 600 秒，均与 HTTP client 保持一致。describe 的 60 秒包含完整读盘和哈希：5 GiB 是大小上限，不保证慢盘能在期限内完成，吞吐不足返回 TIMEOUT，不自动放宽时限。扩展不能离线验真 TOS 签名或从 URL 判断其签名方法，由 TOS 验证；扩展只发送 PUT。

只接受标准 bucket 虚拟主机名 `*.tos-<region>.volces.com`：不接受 IP、自定义域名、内网 endpoint、用户信息、显式端口（包括 443）、片段或跳转。DNS 解析结果也必须是公网地址，连接使用经过检查的解析结果，不经环境代理。保留预签名 URL 的原始编码，不自动重编码。

必须有 TOS4 的 `X-Tos-Algorithm/Credential/Date/Expires/SignedHeaders/Signature` 参数；可额外有 `X-Tos-Security-Token` 和 `X-Tos-Content-Sha256`（仅接受 `UNSIGNED-PAYLOAD` 或文件 SHA256），不接受其他查询参数或重复键。真实 SDK 使用 `UNSIGNED-PAYLOAD`，其 Credential 作用域实测可能使用精确 service endpoint `tos-<region>.volces.com`，也兼容对应 region；不允许不同地域/域名。URL 中的 `Credential` 是预签名协议自带的标识/作用域，不含长期 SK；整个 URL 仍视为敏感短期授权。`target.headers` 必须包含上述四个头，且 ACL 必须精确为 `public-read`，拒绝 `private`、`public-read-write` 或缺失 ACL；可另外提供精确 `Content-Length`（未提供则补齐）。头名大小写不敏感但禁止重复；不允许 Authorization、Cookie、Host 或自定义任意头。

复用客户端现有火山公有桶，仅对本次上传对象设置公开读 ACL，不操作桶级权限或其他前缀策略。客户端下载使用标准 TOS 公网对象 URL，路径段正确 URI 编码，不携带凭据或 GET 签名。服务端以原对象上传时间起24小时执行业务过期和对象删除；删除成功前，已有公开 URL 仍可访问，不能承诺签名失效或准点断开公网访问。`downloadUrl` 的 `expiresSeconds` 仅保留参数合法性校验，不控制公开 URL 的有效期。

上传前重新核验归属和文件哈希，并在同一打开的只读文件描述符上流式 PUT。发送时再次统计大小/摘要，上传后检查文件身份/大小/mtime/ctime 未变。TOS 的 `Content-MD5` 校验负责拒绝不一致内容，`x-tos-meta-sha256` 是元数据，不是 TOS 自动校验 SHA256 的声明。上传成功仅接受 HTTP 200，返回与 `file` 完全相同的对象；不读取或回显上游错误正文。

## 安全和运行边界

- 同一 ComfyUI 进程内只允许一条 export 操作（describe/upload 共用锁），忙时立即返回 HTTP 409 `BUSY`，不排队、不自动重试。此限制不是跨多个 ComfyUI 进程的全局锁。
- 固定错误响应 `{"error":"CODE"}`，不包含文件路径、URL、Token 或上游正文。缺密钥返回 503；错误签名返回 401；归属或文件不符拒绝；超时返回 504。
- 不接受代码、命令、任意本机路径或用户提供的文件内容；没有任何本地删除接口。正常日志不记录请求敏感内容。
- HMAC 不是一次性 nonce：有效窗口内签名请求可重放；目标 key 必须由控制端唯一绑定 job/prompt/output，使用确定的短期授权和幂等收取策略。预签名 URL 在过期前也可能被重复使用。
- 文件系统必须由可信 ComfyUI 管理。逐级 no-follow 阻断路径替换为符号链接；打开后修改会被摘要/元数据检查检测，但不是对恶意本机管理员的隔离沙箱。
- 超时/连接丢失不证明 TOS 未写入。控制端应使用 HEAD 校验原对象大小、元数据及需要的摘要后再确认收取，不重生成视频、不直接认定上传失败就可释放 GPU。此扩展不发送 collected 回执、不关机、不修改任务状态、不自动删除对象或视频。
- 当前实例曾暴露 SSH/VS Code/JupyterLab 工具不等于已验证可连接，也不等于安装了此接口。发布和实际连通性、权限、TOS bucket 策略、出站网络及真实上传仍需单独授权验收。

## 本地测试

从仓库根目录运行（禁止生成 pycache）：

```text
rtk python -B -m unittest discover -s server/comfyui-result-export -p test_exporter.py -v
```

测试使用标准库 unittest、临时文件和内存模拟，不需要安装 ComfyUI/aiohttp，不访问网络。覆盖原始字节 HMAC、过期窗口、历史归属、路径、文件摘要、四个强制上传头、TOS 目标、DNS、流式 PUT、跳转拒绝、并发、60/600 秒时限及错误脱敏。额外的 SDK 兼容测试通过 `rtk proxy node --import tsx` 调用仓库实际 `TosResultStorage.uploadTarget` 和安装的 TOS SDK，用虚构凭据离线签署包含中文、空格和加号的 key，再交给 Python 校验；网络方法被禁用，不打印 URL/签名。没有 Node/RTK/SDK 时明确跳过该项，不安装依赖。POSIX 的真实 no-follow/符号链接/FIFO/硬链接测试在 Windows 上会明确跳过；发布前必须在目标 Linux 环境运行同一命令，不能把模拟传输测试当成真实 aiohttp/TOS 验收。
