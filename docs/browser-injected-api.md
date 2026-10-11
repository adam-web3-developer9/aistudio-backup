# 调研：通过浏览器调用海螺 API（注入式），替代 Node 直连

日期：2026-09-17。验证脚本：`tmp/browser-api-probe.mjs`。所有实验走 `.env` 里的 `HAILUO_PROXY_URL`，用余额最低的账号，只做读接口和一次 1x1 PNG 上传，没有消耗积分。

## 一句话结论

可行，而且已经跑通：在 Playwright 页面里拿到海螺前端自己的 axios 实例，直接 `instance.request()`，签名、指纹参数、token 全部由网页代码自己补齐；OSS 上传仍留在 Node 直连。代价是每个账号常驻一个页面（约 400 MB 内存、首次就绪 13–24 秒）。目前直连并没有被风控拦截，所以这是"保险"而不是"救火"，建议做成可切换的第二种传输层，而不是替换。

## 现状：直连到底缺了什么

抓包网页端真实请求，对比 `src/adapters/hailuo-api.ts` 的直连请求：

| 项目 | 网页端 | 我们的直连 |
|---|---|---|
| 基础 query | device_platform, app_id, version_code, biz_id, unix, lang | 相同 |
| unix | 取整到秒（`…000`） | 毫秒 |
| 设备身份 | `uuid`（localStorage `UNIQUE_USER_ID`）+ `device_id`（localStorage `USER_HARD_WARE_INFO`，由 `POST /v1/api/user/device/register` 颁发） | 没有 |
| 指纹 query | os_name, browser_name, device_memory, cpu_core_num, browser_language, browser_platform, screen_width, screen_height | 没有 |
| 头 | token, yy, sec-ch-ua*, 真实 UA, referer, origin | token, yy；undici 默认 UA |
| Cookie | _token, NEXT_LOCALE, create_type_cache | _token |
| TLS 指纹 | Chrome | Node/undici |

服务端目前不校验这些差异：在页面里用我们的 6 参数最小签名发 `fetch`，同样返回 200（Test A）。也就是说直连能用是因为海螺没有开硬校验，不是因为我们伪装得像。

前端 bundle 里带有 Akamai Bot Manager 的上报逻辑（403 时检查 `_abck`、`ak_bmsc`、`bm_sv`、`bm_sz` cookie，事件名 `login_api_edge_denied`），但今天在 hailuoai.com 上没有观察到任何 Akamai cookie 下发。一旦他们把这套东西开到创作接口，只有真浏览器流量能过，直连会整体失效。

## 历史失败原因（data/jobs，658 条）

| 错误 | 次数 | 与风控关系 |
|---|---:|---|
| `fetch failed`（undici 网络错） | 54 | 代理断流，不是风控 |
| 2400002 文案违反社区规范 | 25 | 内容审核 |
| INSUFFICIENT_CREDITS | ~20 | 余额 |
| 生成失败 / 超时 | ~10 | 渲染侧 |

没有一条是账号或设备维度的风控拒绝。浏览器方案解决不了上面任何一种，它防的是尚未发生的事。

## 注入方式（已验证）

1. 上下文带 `_token` cookie，打开 `/create/image-to-video`，等到页面自己发出 `/v1/api/user/equity`（说明 app 已初始化、device 已注册）。
2. 通过 webpack 运行时拿到模块表：
   ```js
   let req; window.webpackChunk_N_E.push([[Symbol()], {}, r => { req = r; }]);
   const id = Object.keys(req.m).find(id => String(req.m[id]).includes('ooui'));  // 签名盐
   const axios = Object.values(req(id)).find(v => typeof v === 'function' && v.interceptors?.request?.handlers?.length);
   ```
   当前构建里该模块 id 是 `89461`，但 id 随构建变化，必须按源码特征（`ooui`）找，不能写死。
3. `axios.request({ method, url, data })`。请求拦截器会：写入 `headers.token`；合并公共参数和指纹参数；按 `md5(encodeURIComponent(pathWithQuery) + '_' + body + md5(unix) + 'ooui')` 计算 `yy`；把 body 序列化后放到 `e.data`。我们一行签名代码都不用维护，海螺改算法我们自动跟上。
4. 响应拦截器在 `statusInfo.code !== 0` 时 `throw statusInfo`（形如 `{code, message}`），并且会弹登录/付费弹窗。调用时传 `disableLoginIntercept: true, disablePaymentIntercept: true` 可以关掉副作用。
5. 已验证走通的接口：`GET /v1/api/user/equity`、`POST /api/feed/creation/my/processing`、`POST /api/feed/creation/my/batch`、`GET /v1/api/files/request_policy`、`POST /v1/api/files/policy_callback`。出站请求全部带齐 16 个 query 参数和 `yy`。`generate/video` 没有跑，因为会扣积分，但它和 `policy_callback` 走的是同一条 POST 路径。

## 混合上传（已验证）

`request_policy`（页面）→ OSS PUT（Node 直连，复用 `src/adapters/oss.ts`）→ `policy_callback`（页面），全链路 3.6 秒。OSS 不需要 token，不必进浏览器，也就避开了住宅代理传大文件断流的问题。浏览器代理配置里加 `bypass: '*.aliyuncs.com'`，防止页面自己的上传流量误走代理。

## 指纹与身份

- Playwright 默认 headless shell 的 UA 和 `sec-ch-ua` 都写着 `HeadlessChrome`，`navigator.webdriver === true`。这比直连更像机器人。
- 用 `channel: 'chromium'` + `args: ['--disable-blink-features=AutomationControlled']` + `newContext({ userAgent })` 把 `HeadlessChrome/` 改成 `Chrome/` 后：UA 干净，`webdriver === false`，brands 为 Chromium / Not=A?Brand。
- `uuid` 和 `device_id` 存在 localStorage。每个账号用 `context.storageState()` 落盘、下次 `newContext({ storageState })` 恢复，`device/register` 会返回同一个 `deviceID`（已验证）。不落盘的话，每个任务都是一台"新设备"，这是现有 `hailuo-adapter.run()` 浏览器路径的隐患。

## 成本

| 指标 | 实测 |
|---|---:|
| 页面就绪（goto 到首个 equity 请求，经代理） | 13–24 秒 |
| 内存（1 个 browser，2 个页面） | 818 MB |
| 空闲页面后台请求 | 30 秒 23 次 `/meerkat-reporter/api/report`（埋点），可用 `page.route` 屏蔽 |
| 代理 | 5 次运行 1 次 `ERR_CONNECTION_RESET`，与任务历史里的 `fetch failed` 同源 |

12 个账号全部常驻约 5 GB；按需打开、空闲 N 分钟后关闭，则每个任务多付 15–25 秒首次就绪时间。

## 方案对比

| 方案 | 参数/指纹一致 | TLS 一致 | 签名维护 | 资源 | 改动 |
|---|---|---|---|---|---|
| A 现状直连 | 否 | 否 | 我们维护 | 极低 | 无 |
| B 直连补参数（uuid/device 注册、指纹字段、Chrome 头） | 是 | 否 | 我们维护 | 极低 | 小 |
| C 浏览器注入（本文） | 是 | 是 | 海螺维护 | 每账号 ~400 MB | 中 |
| D C + 直连回退 | 是 | 是 | 双份 | 同 C | 中 |

## 建议落地形态

把传输层做成可切换，不动业务逻辑：

- `HailuoClient.request()` 是唯一出口。抽成 `HailuoTransport` 接口：`direct`（现有 `hailuoRequest`）和 `browser`（`page.evaluate` 调注入的 axios）。
- `.env` 里 `HAILUO_TRANSPORT=api|browser`（已加入 config，`browser` 目前启动时报未实现），默认 `api`，出问题一分钟内切回。
- `browser` 传输层：一个 browser，每个 sessionId 一个 context，懒加载、空闲回收；storageState 与 cookie 一起存进 `data/sessions/`；启动时按 `ooui` 特征绑定 axios，绑定失败视为海螺改版并回退 direct。
- 上传保持 Node 直连 OSS，浏览器代理 bypass `*.aliyuncs.com`。
- 出口由 `HAILUO_PROXY=iproyal|local|direct` 决定（已加入 config），API 和浏览器共用，不单独配浏览器代理；`local` 用 `HAILUO_LOCAL_PROXY_URL`，默认 `http://127.0.0.1:7897`。见文末的本地代理一节。
- 屏蔽 `/meerkat-reporter/` 埋点减少后台流量；是否屏蔽属于风控取舍，可配置。
- 现有 `HailuoAdapter.run()`（点按钮那条路径）在此之后可以删掉，两条浏览器路径没必要并存。

## 补充（同日下午）：对照离线源码 + 本地代理

### 离线源码 `Downloads/hailuoai.com (1)`

- 构建号 `prod-zh-0.1.794`，与线上完全一致（线上页面引用同一版本，模块 id `89461` / `62001` 都能在离线 chunk `5401-d1fb2600c7af85c2.js` 里找到）。之前在浏览器里探到的一切都可以拿这份源码静态核对。
- axios 实例是模块 `89461` 的导出 `Z`，前端内部一律 `u.Z.post(...)` 调用。请求拦截器在 `Z.interceptors.request.use`，签名函数 `b`：`md5(encodeURIComponent(path?query) + '_' + JSON.stringify(body) + md5(String(unix)) + 'ooui')`，与 `src/adapters/hailuo-api.ts` 一致。
- 常量（模块 `99273`）：`app_id = "3001"`，`version_code = "22203"`，`biz_id = "0"`。localStorage 键（模块 `88626`）：`_token`、`USER_HARD_WARE_INFO`（device_id）、`UNIQUE_USER_ID`（uuid）。
- 响应拦截器识别的业务码：`1000048` 未登录/登录失效（会触发登录弹窗，`disableLoginIntercept` 关闭）；`22` 通用提示（toast 消息体）；`2400026` / `2400040` 付费拦截，`2400025` / `2400039` 付费提示（`disablePaymentIntercept` 关闭）；其余 `throw statusInfo`。
- 用户模块里有 `/v1/api/user/need_captcha`、`/public/app/ban_user_appeal`、`/v1/api/safety/user/appeal`：平台有验证码门和封号申诉流程，说明账号维度风控是存在的，只是我们还没撞上。
- 签名为空时前端会上报 `uuidExists` / `deviceIdExists`（函数 `P`），侧面说明服务端日志里这两个字段是被关注的。

### 本地代理

机器上跑着 `verge-mihomo`（Clash Verge 内核），监听 `127.0.0.1:7897`，环境变量 `HTTP_PROXY` / `HTTPS_PROXY` 也指向它。`.env` 里的 `HAILUO_PROXY_URL` 是 IPRoyal 住宅代理。

| 出口 | IP | 页面就绪 + 上传链 |
|---|---|---|
| 直连 | 106.118.34.135 | 未测 |
| IPRoyal（`HAILUO_PROXY_URL`） | 88.212.173.71 | 13–24 秒 + 3.6 秒 |
| 本地 7897 | 103.151.172.75 | 整段脚本 3 秒，上传链 0.6–0.9 秒 |

浏览器走本地代理已验证：`tmp/browser-api-probe.mjs` 读同一个 `HAILUO_PROXY` 开关（`PROBE_PROXY_URL` 可临时覆盖），无账号密码时自动省略认证。OSS 域名经 7897 也能通（HEAD 0.27 秒），但上传仍建议 Node 直连。

三个出口 IP 各不相同，所以出口开关是全局一个：`HAILUO_PROXY` 同时管签名 API 和浏览器，切换时整个服务一起换出口，不会出现同一个 `_token` 一半流量走 IPRoyal、一半走本机的情况。切换出口等于让所有账号换 IP，这是运营决策，改之前想清楚。

### 真实生成测试（2026-09-17 16:07，账号 探索者7344）

`tmp/browser-generate-test.mjs`：浏览器传输层 + 本地代理，多参（all-reference，frameType 4），hailuo3.0-i2v，768p，5 秒，16:9，提示词"参考图中穿红色上衣的男人化身马斯克……"。

- 结果：成功。页面就绪 0.6 秒，7 MB 参考图上传 2 秒，非会员排队约 30 秒，渲染约 2.5 分钟，总耗时 195 秒，扣 35 积分。视频存 `tmp/browser-generate-musk.mp4`，结果 JSON 在 `tmp/browser-generate-result.json`。
- 走 IPRoyal 的同一脚本也成功（视频 556903622295793667），说明传输层本身不挑出口。
- mihomo 处于规则模式时，同一脚本走本地代理提交 `generate/video` 稳定返回 `2400001 生成内容出错了，请重新生成`，而查询、上传都正常；切到全局模式后成功。`icanhazip` 两种模式下出口都是 103.151.172.75，所以差别在规则模式把 hailuoai.com 这个国内域名判成了 DIRECT，生成请求实际从河北电信 IP 出去。结论：不必开全局，给 mihomo 加一条 `DOMAIN-SUFFIX,hailuoai.com` 走代理节点即可；`aliyuncs.com` 保持直连。
- 工具侧：Playwright 自带的 ffmpeg 不带 H.264 解码，抽帧用封面图代替。
- 补测（16:15）：mihomo 规则模式 + `hailuoai.com` 走代理的规则，同一脚本再次成功，总耗时 154 秒，扣 35 积分。确认不需要全局模式。
