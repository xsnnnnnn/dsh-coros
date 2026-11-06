# dsh-coros-mcp

<p>
  <a href="https://github.com/xsnnnnnn/dsh-coros"><img alt="GitHub 仓库" src="https://img.shields.io/badge/github-xsnnnnnn%2Fdsh--coros-181717?logo=github"></a>
  <img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5%20%7C%200.2.2--rc.1-4B8BBE">
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Tests" src="https://img.shields.io/badge/tests-42%20passing-brightgreen">
</p>

把**高驰（COROS）官方 MCP**接进 DeepSeek Harness：一次安装，`mcp__coros__*` 工具全部出现——睡眠 / HRV / 静息心率 / 恢复分 / 训练负荷、运动记录与 FIT 文件、课表与训练计划（创建 / 修改 / 排期）、设备与路线等（当前官方端点 34 个工具，随端点版本可能变化）。

**自包含**：桥接脚本、OAuth 登录、令牌续期都在本包内。不需要 `~/.coros-mcp` 里的外部 CLI，不需要在 profile 配置里写任何绝对路径，也不需要本地回调端口。

## 亮点

- **零运行时依赖** —— 只用 Node 内置模块（`fetch` / `crypto` / `fs` / `http`），不用 `npm install` 装任何东西。
- **自包含 OAuth** —— 动态客户端注册 + PKCE(S256) + COROS CLI 登录会话；`login-start` / `login-finish` 可跨进程，**不监听任何本地端口**。
- **DSH 升级不再失效** —— `engines.dsh` 为无上限下限（`>=0.2.1-rc.1`）；若未来 DSH 改了 MCP 客户端 JS API，插件会自动改用 Cordis Loader 挂载同一行，不会因为版本号变化被静默拦掉。
- **令牌只在本机** —— `~/.dsh/coros-mcp/<区域>/token.json`（0600），不在 profile 配置里，日志不打印，无遥测，数据不经过第三方服务器。
- **修掉真实 MCP schema 问题** —— COROS 的 `tools/list` 用顶层 `$defs`/`$ref`，桥接会内联展开，避免模型侧报 `Pointer '/$defs/Section' does not exist` 导致整轮失败。
- **刷新轮换安全** —— COROS 每次刷新都会轮换 refresh_token；桥接与登录 CLI 共用一把跨进程文件锁串行化续期，避免互相作废。
- **也能独立使用** —— `lib/proxy.mjs` 是标准 MCP stdio server，Claude Desktop / Cursor 等任何 MCP 客户端都能接。

---

## 架构

```
DeepSeek Harness
  └─ dsh-coros-mcp（宿主插件，本包）
        └─ 注册 DSH MCP 客户端（serverName=coros）
              │  JSON-RPC / stdio
              ▼
        lib/proxy.mjs   本地桥：读令牌缓存、过期自动续期（带文件锁）、schema $ref 内联
              │  HTTPS POST + Authorization: Bearer <access_token>
              ▼
        https://mcpcn.coros.com/mcp   （COROS 官方 MCP，中国区）
```

为什么需要桥：DSH 的 MCP 客户端只支持 stdio / 静态 header，而 COROS 官方端点要求会过期的 OAuth 2.0 Bearer 令牌。桥接进程负责续期，使工具调用对模型完全透明。

登录流程（`lib/login.mjs`）走 COROS 网关自带的 CLI 登录会话：动态客户端注册 + PKCE(S256) + 浏览器授权 + 轮询 `loginTicket` + 服务器端换取授权码。**不监听本地端口**，所以 `login-start` 和 `login-finish` 可以是两个独立进程，Windows 上也没有端口冲突问题。

## DSH 升级后还会失效吗（更新保障）

**不会再因为「版本号不匹配」被自动停用。** 机制与原因：

- DSH 在启动 profile 时用 `engines.dsh`（`app-boot` 的 `evaluatePluginCompatibility`）判定插件能否加载；判定用 `semver.satisfies(..., { includePrerelease: true })`。旧版插件写的是**有限区间**（只含 0.2.1 线 + 0.2.2 那一个 rc），DSH 自动升级到新的 rc 后区间不匹配，插件被跳过且没有任何提示——这就是「DSH 一更新高驰工具就消失」的原因。
- 1.0.2 起 `engines.dsh` 改成**只有下限、没有上限**的 `>=0.2.1-rc.1`。在 `includePrerelease: true` 语义下，它覆盖 0.2.1、0.2.2、0.2.x 未来 rc、0.3.x、1.x 等所有更高版本 → **以后 DSH 正常升级不会再把插件拦下来**。
- 双保险：即使未来 DSH 改了 `@deepseek-ai/dsh-mcp-client` 的 JS 导出形态（导入失败），插件会自动改用 Cordis Loader 的 `ctx.loader.create` 挂载同一个 MCP 客户端行（与 profile patch 走同一条路径）；只有两条路都失败才会在日志里给出明确 warning。
- 唯一不保证的是「DSH 做了破坏性 API 改造、且两条注册路径都失效」；那时日志会出现 `[coros-mcp] could not attach the DSH MCP client`，重新安装适配新版的插件构建即可。

> 从 GitHub/tgz 安装的插件不会随 DSH 自动升级插件自身版本；需要时重新跑一次 `dsh plugin add <新 tgz>`。token、登录状态不受插件升级影响。

## 安装

要求：DeepSeek Harness ≥ `0.2.1-rc.1`（`engines.dsh` 为无上限区间，未来版本不会被拦截）、Node.js ≥ 20（DSH 自带运行时即可）。

### 方式 A：从 tarball 安装（推荐分发）

```powershell
# 在包目录 npm pack 生成 dsh-coros-mcp-<version>.tgz
& '<DSH>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'github:xsnnnnnn/dsh-coros'
```

### 方式 B：从目录安装（开发）

```powershell
& '<DSH>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\path\to\dsh-coros-mcp'
```

目录安装是 `link:` 语义：改源码即改插件，移动或删除目录会让插件失效。

安装后：**设置 → 插件** 里确认 `dsh-coros-mcp` 已启用，必要时重启 DSH。

> 从旧的手工配置迁移：先备份 profile 的 `cordis.patch.yml`，再删除里面手写的 `id: mcp-coros` 那条 `@deepseek-ai/dsh-mcp-client` 行。插件和手工行同时存在会把同一批 `mcp__coros__*` 工具注册两次，导致工具注册冲突。

## 登录

首次使用（或令牌失效后）：

```powershell
# 1) 创建登录会话，打印授权链接（会尝试自动打开浏览器）
node '<插件目录>\lib\login.mjs' login-start

# 2) 浏览器里登录高驰账号并授权；回到终端执行
node '<插件目录>\lib\login.mjs' login-finish

# 3) 其它常用
node '<插件目录>\lib\login.mjs' login-status   # 离线查看状态
node '<插件目录>\lib\login.mjs' refresh        # 立即续期
node '<插件目录>\lib\login.mjs' logout         # 清掉本机令牌
```

- 令牌写到插件自己的缓存：`~/.dsh/coros-mcp/<区域>/token.json`（Windows：`%USERPROFILE%\.dsh\coros-mcp\...`，文件 0600）。它**不在 profile 目录里**，所以导出/备份 profile 配置不会带走令牌。
- 兼容旧缓存：如果 `~/.coros-mcp-skill-gateway-ts/<区域>/token.json`（COROS 官方 CLI 的缓存）存在，桥接会直接复用它，无需重新登录；一旦你重新 `login-start`/`login-finish`，新令牌写入插件自己的目录并优先使用。
- access token 有效期 30 天；**refresh_token 每次刷新都会轮换、旧值立即失效**，所以桥接和登录 CLI 用同一把文件锁串行化续期（`token.json.lock`），避免互相作废。
- 区域：默认从缓存推断，可用 `--region cn|eu|us` 或配置项覆盖。

## 配置

bundle 行 `config:`（全部可选，写在 profile 的 `cordis.patch.yml` 里覆盖；默认值已内置）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `serverName` | `coros` | 工具前缀，`mcp__coros__*` |
| `cacheRoot` | `$DSH_HOME/coros-mcp` | 令牌缓存根目录 |
| `region` | 从缓存推断 | `cn` / `eu` / `us` |
| `issuer` | 按区域 | 覆盖 OAuth issuer |
| `mcpUrl` | `<issuer>/mcp` | 覆盖 MCP 端点 |
| `nodePath` | 自动探测 | 启动桥接用的 Node 可执行文件 |
| `requestTimeoutMs` | `30000` | 单次请求 COROS 的超时 |
| `toolCallTimeoutMs` | `120000` | 单次工具调用超时（DSH 侧） |
| `failOnStartupError` | `false` | 桥接起不来时是否让 profile 启动失败 |
| `enabled` | `true` | 设为 `false` 保留插件但不连接 |

环境变量兜底（低于配置项）：`COROS_MCP_CACHE_ROOT`、`COROS_MCP_REGION`、`COROS_MCP_ISSUER`、`COROS_MCP_URL`、`COROS_MCP_TIMEOUT_MS`。

## 工具一览（按官方端点当前版本）

- **身体与恢复**：`queryDailyHealthData`、`querySleepOverview`、`querySleepHrv`、`queryRestingHeartRate`、`queryAvgHeartRate`、`queryRecoveryStatus`、`queryStressLevel`、`queryStressTimeSeries`、`queryHealthCheckTimeSeries`、`queryFitnessAssessmentOverview`、`queryTrainingLoadAssessment`、`queryMenstruationCycles`、`queryUserInfo`
- **运动记录**：`querySportRecords`、`getActivityDetail`、`queryActivityLapData`、`queryCustomActivityLapData`、`downloadActivityFitFiles`、`queryActivityFitFileDownloadUrls`
- **课表与计划**：`queryTrainingSchedule`、`queryScheduledWorkoutDetails`、`createScheduledWorkout`、`updateScheduledWorkout`、`queryTrainingPlanLibrary`、`queryTrainingPlanDetails`、`createTrainingPlan`、`updateTrainingPlan`
- **训练库**：`queryWorkoutLibrary`、`queryWorkoutDetails`、`createSingleWorkout`、`updateWorkoutDetails`、`scheduleWorkout`
- **其它**：`queryDevices`、`uploadRouteFile`

## 独立使用（非 DSH）

`lib/proxy.mjs` 是标准 MCP stdio server，可给任意 MCP 客户端使用：

```jsonc
// Claude Desktop / Cursor 等
{
  "mcpServers": {
    "coros": {
      "command": "node",
      "args": ["D:\\path\\to\\dsh-coros-mcp\\lib\\proxy.mjs"]
    }
  }
}
```

诊断命令：

```powershell
node lib\proxy.mjs --status      # 区域 / 缓存 / 令牌到期时间（离线，不联网）
node lib\proxy.mjs --selftest    # 真实连一次官方端点，列出工具
```

## 排障

| 现象 | 处理 |
|---|---|
| 工具整批消失 | `node lib\proxy.mjs --status` 看令牌；在 DSH 日志里搜 `[coros-mcp]` 开头的 stderr |
| `no COROS login found` | 走一遍 `login-start` / `login-finish` |
| `token refresh failed (HTTP 400)` | refresh_token 被轮换/撤销，重新 `login-start` / `login-finish` |
| `timed out waiting for the token lock` | 删掉 `token.json.lock`（确认没有其它 COROS 进程在跑） |
| 只有部分工具 schema 报错 | 本包已把 `$defs`/`$ref` 内联；仍报错请附 `--selftest` 输出反馈 |
| DSH 升级后工具消失 | 1.0.2+ 已不会再被版本闸门拦截；若仍消失，在 DSH 日志里搜 `[coros-mcp]`（可能是 MCP 客户端 API 变更），重新安装适配新版的插件即可 |

## 隐私与安全

- 令牌只存本机 `~/.dsh/coros-mcp/`，0600、原子写；插件、日志、README 里都不含令牌值。
- 日志只输出区域、端点、到期时间等元信息；access/refresh token、`login_ticket`、`code_verifier` 不打印。
- 插件启动时**不联网**；只有工具调用、`--selftest` 或登录/续期命令才会访问 COROS。
- 令牌不进 profile 配置（市场备份会导出 profile 配置），也不进 npm 包（`files` 白名单 + prepack 检查）。
- 本插件不是 COROS 官方产品，只是官方 MCP 端点的客户端；使用受高驰账号与官方服务条款约束。

## 开发与验证

```powershell
npm test                 # 39 项单元 + mock issuer 全链路测试（零网络）
npm run status           # 离线状态
npm run selftest         # 真实端点：initialize + tools/list
node research/preflight.mjs .   # 商城上架静态预检（仓库根目录执行时）
npm pack                 # prepack 自动跑 scripts/prepack-check.mjs
```

## 仓库结构

| 路径 | 内容 |
|---|---|
| `lib/index.js` | 宿主半：注册 DSH MCP 客户端（主路径 + Loader 兜底） |
| `lib/proxy.mjs` | stdio↔HTTP 桥（`--status` / `--selftest` / MCP server） |
| `lib/login.mjs` | 自包含 OAuth：`login-start` / `login-finish` / `login-status` / `refresh` / `logout` |
| `lib/config.mjs` | 令牌缓存、区域解析、带文件锁的续期 |
| `cordis.patch.yml` · `dsh.plugin.json` | bundle 清单与插件元数据 |
| `assets/icon.png` | 插件图标（DSH 插件页 / 市场卡片） |
| `test/` | 42 项零网络测试（含协议一致 mock issuer 全链路） |
| `scripts/prepack-check.mjs` | 发包前静态检查（清单/图标/密钥泄漏） |

## 兼容性与许可

- `engines.dsh`: `>=0.2.1-rc.1`（**无上限**，覆盖未来版本；DSH 的判定带 `includePrerelease: true`）；`dsh.compatibility.dshReleases`: `0.2.1-rc.5`、`0.2.2-rc.1` = compatible。
- Node.js ≥ 20（内置 `fetch` / `crypto` / `node:test`），无第三方运行时依赖。
- 许可：MIT。COROS、高驰为其权利人商标；本项目与高驰官方无隶属关系。
- 协议细节依据 COROS 官方 MCP 网关的公开端点与官方 CLI 行为整理；官方 npm 包（UNLICENSED）代码未复制、未打包。
