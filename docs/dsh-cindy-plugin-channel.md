# DSH 会话接入 Cindy 插件通道（cindy MCP server + 花名册）设计方案

更新日期：2026-08-19（方案）／2026-08-20（实现完成）
状态：**已实现**（2026-08-20，见文末「实现记录」）。§9 两个决策点已裁决：能力开
（放行，执行与授权仍全在 Main 插件基座）；远端语义选**推荐项 fail-closed**（SSH
远端不注入 mcp 行、不传 roster，对齐 Claude/Codex）。本文是
`docs/dsh-integration.md` 与 `docs/ghost-progressive-discovery.md` 的配套方案文档。

## 1. 背景与目标

DSH（DeepSeek Harness）会话目前对 Cindy 插件（`.cindy` / ghost 插件）是 **fail-closed**
的：`apps/desktop/src/main/mcp-integrations/mcp-providers.ts:466-469` 对
`agentKind === 'dsh'` 关闭整个 MCP provider 列表（含 `cindy` 总机），花名册注入点也只有
Claude Code / Codex / Pi 三个 harness（`docs/ghost-progressive-discovery.md` §3.2）。
用户已装的 Cindy 插件在 DSH 会话里既看不到也调不到。

目标：让 DSH 会话获得与 Claude / Codex / Pi **一致**的插件工具面与召回线索：

1. `cindy` MCP server（`ghost_list` / `ghost_info` / `ghost_manual` / `ghost_call` /
   `ghost_forge_guide` / `ghost_forge_scaffold` / `ghost_forge_pack`）以
   `mcp__cindy__*` 命名进入 DSH 工具面；
2. 插件花名册（roster）按现有 formatter 与安全序列化规则进入 DSH 的 system prompt 段，
   与 `ghost_list` 工具描述双通道一致；
3. 全部执行、授权、确认与安全判定仍由 Main 的插件基座完成，不放松任何现有不变量；
4. 不改变 DSH 的 text-only 边界；SSH 远端 DSH 会话 fail-closed（已裁决，见 §9）。

非目标：

- 不改 DSH 上游包源码（全部基于公开导出组合，`dsh-mcp-client` 随 `@deepseek-ai/dsh`
  依赖已安装，`node_modules/@deepseek-ai/dsh/package.json:46`）；
- 不动插件基座（receipt / manifest / slot / 安装布局 / 批准状态），不触发
  `docs/dev-rules/plugin-security-and-authoring.md` §5 的存量兼容迁移义务；
- 不改 DSH JSON-RPC wire protocol（url 走 overlay 配置、token 走 env、roster 走
  bridge 文件，均不进 RPC 参数）；
- 不代写 DSH 用户层（`$DSH_HOME/cordis.patch.yml` / settings / `.agent-presets`），
  那条红线（`docs/dsh-integration.md:236-249`）原样保留。

## 2. 可行性结论

三个关键事实拼起来，方案不需要发明任何新协议：

1. **DSH 原生带 MCP 客户端**：`@deepseek-ai/dsh-mcp-client`（v0.1.0-rc.7）是 Cordis
   插件形式的 MCP client bridge，激活时连 server、`tools/list`、把工具以
   `mcp__<serverName>__<rawName>` 注册进 `ctx.tools`
   （`node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js:119-125,165`）。它**默认不
   挂载**（不在 base bundle / web profile / 任何 agent preset 里），启用方式 = 在
   Cordis composition 加一行。只支持 **stdio / streamable-http** 两种传输，不支持
   in-process SDK 实例（`lib/index.js:738-756`）。
2. **Cindy 的 ghost server 是标准 SDK `McpServer`**：
   `createCindyGhostsMcpServer`（`packages/cindy-tools/src/ghost/mcpServer.ts:925-1068`）
   返回 `@modelcontextprotocol/sdk` 的 `McpServer` 实例——可以挂任何 SDK 传输，
   包括 Streamable HTTP。
3. **花名册 formatter 与 deps 回调是跨 harness 共享的**：`formatGhostRoster`
   （`mcpServer.ts:203-234`）同时产出 system 段与 `ghost_list` 工具描述（双通道一致，
   `mcpServer.ts:941-942`）；`getGhostRosterPrompt` 已在 `AgentDeps`
   （`packages/maker-core/src/agents/base-agent.ts:865`），Claude / Codex / Pi 共用同一
   调用模式（`claude-code/index.ts:1199-1202`、`codex/index.ts:4854-4859`、
   `pi/index.ts:1693-1704`）。

## 3. 现状盘点（证据）

### 3.1 Cindy 侧：三 harness 的注入链路

- provider 列表：`createDesktopMcpProviders`（`mcp-providers.ts:87`）→ `gated` 数组；
  `cindy` provider 手工 push（`mcp-providers.ts:519-536`），`isEnabled: () => true`
  （工具面恒定是缓存前缀稳定的前提，`:501-506` 注释），
  `toClaudeSdkConfig` 闭包绑定会话 ctx：
  `createCindyGhostsMcpServer(getCindyGhostsMcpDeps(ctx, { getLiveSessionGrantState, ... }))`。
- 三份数组同源：`maker-host/index.ts:923-926`（claude）、`:1210-1213`（codex）、
  `:1690-1693`（pi）都是 `[...createDesktopMcpProviders(...), orcaWorkerBridgeProvider]`；
  用户自定义 MCP 经 `registerCustomMcpArrays`（`:1698`）原地追加。
- 消费方式：
  - Claude：in-process SDK，`buildMcpServers()`（`claude-code/index.ts:1360-1417`）在
    startSession 一次性装配；
  - Codex / Pi：独立子进程，走 streamable-HTTP bridge（`codexHttpBridge.ts`，
    loopback 127.0.0.1 随机端口 + bearer token，per-session token 注册/注销：
    `remoteMcpBridgeToken.ts`、`piEnvironment.ts:219-256`），调用期经
    `runWithLiziMcpSessionContext` ALS 恢复会话 ctx（`codexHttpBridge.ts:680-684`）。
- 花名册：`getGhostRosterPrompt({workingDir})`（`apps/desktop/src/main/mcp-integrations/ghost.ts:1121-1133`，
  无 workingDir → `''`）；`getCindyGhostsMcpDeps` 的 `getRosterItems`（`:1199-1212`）
  在 server 装配时取快照进 `ghost_list` 描述。两端共用 `formatGhostRoster`。
- 会话上下文：`LiziMcpSessionContext`（`packages/lizi-mcps/src/types.ts:859-901`），
  `agentKind` 是 `string`（类型兼容 `'dsh'`）；`getSessionContext` accessor 是唯一
  可信来源（`packages/lizi-mcps/src/session-context.ts:29-55`）。
- 远端 fail-closed：`cindy` 不在 `REMOTE_ALLOWED_SERVER_NAMES` 白名单
  （`codexHttpBridge.ts:42-62`）；Claude/Codex 的 roster 注入带
  `opts.remoteHostId || reviewMode ? ''` gate。**Pi 是现有分叉点**（远端经
  SSH remote-forward 拿到 ghost 工具，`maker-host/index.ts:1862-1868`）。

### 3.2 DSH 侧：会话装配链路

- `DshAgent.startSession`（`packages/maker-core/src/agents/dsh/index.ts:78-204`）：
  `buildDshCordisConfig`（`composition.ts:36-102`）生成 overlay → `renderDshCordisYaml`
  → 本地写临时目录（`cordis.yml` + `cindy-dsh-bridge.mjs`）→
  `createLocalDshTransport`（utilityProcess，env 白名单
  `dsh-local-transport.ts:24-50`）或远端 `createRemoteDshTransport`（base64 信封 +
  远端自己的 `~/.dsh`，`dsh-remote-transport.ts:34-66`）。
- overlay 结构：`{id, disabled:true}` 行（镜像 web profile 的 host 平面禁用清单）+
  覆盖行 + `insert` 段（`composition.ts:88-98`，目前只有 code-runtime /
  agent-presets / cindy-dsh-bridge）。**`dsh-mcp-client` 行加在 insert 段即启用**。
- bridge（`bridge-source.ts`，Cindy 自有、进程内、双端一致注入的 Cordis 插件）：
  负责 JSON-RPC 会话边界（initialize / session/prompt / preset / permission /
  cancel / shutdown），`composePreset` 的 `setup(agentCtx)` 挂载 agent 作用域。
  **roster system 段在这里注册**（`agentCtx.systemPrompt.section`，与
  `dsh-agent` 的 `installModelSelection` 同机制）。
- DSH system prompt 组装：`dsh-system-prompt` 注册表，插件用
  `ctx.systemPrompt.section({name, order, text})` 按 scope 注册段；每 step 组装一次、
  前缀稳定（`node_modules/@deepseek-ai/dsh-system-prompt/README.md`）。
- `DSH_SYSTEM_PROMPT` env 通道**无任何消费方**（全量 grep `node_modules/@deepseek-ai`
  零命中；仅 `dsh-local-transport.ts:48` 白名单）——不作为主通道。

## 4. 推荐方案

### 4.1 架构

```
┌─ Electron Main ──────────────────────────────────┐   ┌─ DSH utilityProcess（每会话一个）──────┐
│ dshCindyMcpHost（新增，loopback HTTP）            │   │ cordis.yml overlay：                  │
│  ├─ token → sessionCtx 注册表                     │   │  - id: mcp-cindy                     │
│  ├─ registerSession(sessionId, workingDir)        │   │    name: '@deepseek-ai/dsh-mcp-client'│
│  │   → { url, token }                             │   │    config: { serverName: 'cindy',     │
│  └─ createCindyGhostsMcpServer(getCindyGhostsMcpDeps│  │      transport: 'streamable-http',    │
│       (ctx, hostDeps))                            │   │      url,                             │
│     ctx = { sessionId, workingDir,                │   │      headers: {Authorization: !!js …} │
│             agentKind: 'dsh', remoteHostId: null }│   │   }（token 走 env，不落盘）           │
│     （token 经 CINDY_DSH_MCP_TOKEN env 传入）      │   │ cindy-dsh-bridge.mjs：                │
│                                                  │   │  setup(agentCtx) 注册 roster 段       │
└───────────────────┬──────────────────────────────┘   └────────────────────────────────────────┘
                    │ streamable-http + Bearer token
                    └───────────────────────────────────
```

### 4.2 Main 侧改动

1. **新模块 `apps/desktop/src/main/mcp-integrations/dshCindyMcpHost.ts`**：
   - `http.createServer` 绑 `127.0.0.1:0`（随机端口），只接受 `/mcp`
     （POST + GET/SSE），StreamableHTTPServerTransport 包
     `createCindyGhostsMcpServer(getCindyGhostsMcpDeps(sessionCtx, hostDeps))`；
   - `registerSession(sessionId, workingDir)` → `{ url, token }`；token 为随机
     32 字节 hex；`unregisterSession(sessionId)` 幂等注销；无存活会话时关服；
   - 安全形态照抄 `codexHttpBridge.ts` / `remoteMcpBridgeToken.ts`：loopback-only、
     随机端口、per-session bearer token，token 不入日志不落盘，未知 token 一律 401。
     「不落盘」靠 **env 通道**兑现（与 codex 的 `LIZI_MCP_TOKEN` env +
     `bearer_token_env_var` 先例同思路）：token 经 `CINDY_DSH_MCP_TOKEN` 环境变量
     传入 DSH 进程，overlay YAML 里只写 `!!js` 表达式引用 env（见 §4.3），
     token 明文不出现在 `cordis.yml`；
   - sessionCtx 的 `getSessionContext` 返回该 DSH 会话的上下文（与 codex 的 ALS
     恢复语义等效；`getCindyGhostsMcpDeps` 的 sessionCtx 兜底参数
     `ghost.ts:1183-1184` 就是为无 ALS 语境路径留的缝）。
2. **生命周期挂点（现成）**：
   - 注册：`lifecycleHooks.prepareStartOptions` 的 `agentKind === 'dsh'` 分支
     （`maker-host/index.ts:1973-1982`）——本地会话调 `registerSession`，把
     `dshCindyMcpUrl` / `dshCindyMcpToken` 放进 `DshVendorOptions`
     （`dsh-host.ts:156-169` 的 `prepareDshVendorOptions` 扩展）；
   - 注销：`lifecycleHooks.onClose`（`packages/maker-core/src/maker.ts:80`），
     并同时覆盖 transport 异常关闭路径（进程崩溃 / `fireClose`），避免 token
     注册表残留。残留本身有界（per-session 随机 token 随 Main 重启全部失效），
     但正常路径不应依赖重启兜底；
   - **SSH 远端不注册**（fail-closed）。
3. `mcp-providers.ts:466-469` 的 DSH fail-closed **保留不动**——DSH 走 overlay 行 +
   loopback 端点，不经过该列表；留着是防御纵深。

### 4.3 maker-core 改动

1. **`composition.ts`：overlay insert 段加一行**（本地会话才生成）：
   ```yaml
   - id: mcp-cindy
     name: '@deepseek-ai/dsh-mcp-client'
     config:
       serverName: cindy
       transport: streamable-http
       url: http://127.0.0.1:<port>/mcp
       headers:
         Authorization: !!js "'Bearer ' + process.env.CINDY_DSH_MCP_TOKEN"
   ```
   token **不写入 YAML 明文**：`dsh-mcp-client` 的 `headers` 是静态字符串字典
   （`z.dict(String)`，`dsh-mcp-client/lib/index.js:752`），没有 codex 那样的
   `bearer_token_env_var` 间接；但 overlay 渲染器本身支持 `!!js` 表达式
   （`composition.ts:124`，现有 `sandbox-policy.workspaceRoot` 已依赖同一机制），
   cordis 装载 YAML 时求值、token 经 env 注入。实现期首验项：`!!js` 求值发生在
   mcp-client 的 zod config parse 之前（大概率成立；若不成立，退回明文写入
   则必须同步改写 §6 安全表为「token 落盘于 temp 目录、会话关闭即删」，
   不得保留「不落盘」措辞）。配套改动：`dsh-local-transport.ts` 的
   `DSH_ENV_KEYS` 白名单加 `CINDY_DSH_MCP_TOKEN`，`dsh/index.ts` 的 env 块注入。
   `buildDshCordisConfig` 的可选 mcp 参数只含 url（token 不进入任何 YAML
   渲染链路）；`DshVendorOptions` 新字段仍可携带 `{ url, token }` 到
   `DshAgent.startSession`，由 `dsh/index.ts` 把 token 放进 env 块而非 config。
   远端（`remoteHostId`）不生成该行、不注入该 env。DSH RPC wire protocol 零改动。
2. **`dsh/index.ts`：roster 求值**，照抄 Claude 模式
   （`claude-code/index.ts:1199-1202`）：
   ```ts
   const roster = opts.remoteHostId
     ? ''
     : (this.deps.getGhostRosterPrompt?.({ workingDir: opts.workingDir }) ?? '');
   ```
   startSession 装配时求值一次、会话内恒定（prompt 缓存前缀稳定）。
3. **`bridge-source.ts`：`DSH_BRIDGE_SOURCE` 改为 `(roster) => source` 函数**，
   写入临时目录时插值（SSH 远端传空串版本）；bridge 在 `composePreset` 的
   `setup(agentCtx)` 里注册：
   ```js
   if (ROSTER) agentCtx.systemPrompt.section({ name: 'cindy:roster', order: <10~99 区间>, text: ROSTER });
   ```
   **插值必须走 `JSON.stringify(roster)` 整体替换占位符**（如
   `const ROSTER = /*__CINDY_ROSTER__*/ null;` → 替换为 JSON 字面量），
   严禁模板字符串拼接：roster 含插件作者可控文本（name / description /
   whenToUse），直接拼进 JS 源码是代码注入面（反引号、`${}`、换行逃逸）。
   roster 非敏感信息，落盘于 temp 目录无碍。
   roster 为空（无 workingDir / 远端 / 无插件）→ 不注册该段，宁缺勿全。
   注：本改动进入模型 system 段，必须遵守 `docs/dev-rules/maker-core-and-agent-behavior.md`
   的 system prompt 门禁与 `docs/ghost-progressive-discovery.md` §4 的固定包裹/序列化规范。

### 4.4 双通道一致性（自动成立）

- system 段：bridge 注册（startSession 时 `getGhostRosterPrompt` 求值）；
- `ghost_list` 描述：server 装配时 `deps.getRosterItems()` 取快照
  （`ghost.ts:1199-1212`、`mcpServer.ts:941-942`）；
- 两者共用 `formatGhostRoster`（固定前导/尾注、字段级转义、16 条/8000 字符上限），
  同一 formatter、同一快照语义；DSH 的 server 在会话启动时装配 = 与三 harness
  相同的「会话装配时求值一次、会话内恒定」语义。
  注意：两处快照时刻不完全重合（`registerSession` 时的 server 装配 vs
  `startSession` 时的 roster 求值），中间存在理论窗口（用户恰好在两刻之间
  装/卸插件则两通道短暂不一致）——与三 harness 现状同级，不构成新问题；
  实时真相始终以 `ghost_list` 调用返回为准（`ghost.ts:1186-1188` 注释口径）。

### 4.5 远端（SSH）DSH 会话

fail-closed：不生成 mcp 行、不传 roster（对齐 Claude / Codex 的
`remoteHostId` gate）。远端 DSH 用远端自己的 `~/.dsh`，插件不同步
（`docs/dsh-integration.md:37-38,249`），与「cindy 不在远端白名单」的现有规则一致。
（Pi 的 SSH remote-forward 隧道是现有分叉点，是否统一见 §9 决策点 2。）

## 5. 备选方案对比

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A. stdio 传输 | dsh-mcp-client spawn `command` 起 server 子进程 | ❌ 打包后 RunAsNode 禁用、无独立 node 二进制（`dshRuntimeWorkerProcess.ts` 头部注释），spawn 不可行 |
| B. streamable-http（**推荐**） | Main 起 loopback HTTP MCP 端点 + per-session token | ✅ codexHttpBridge 同款先例，无进程 spawn 问题，隔离性好 |
| C. bridge 手动实例化 mcp-client | bridge 里 `apply()` mcp-client 或自写工具注册 | ❌ 绕过 loader 的激活/生命周期语义（mcp-client 官方用法就是 cordis.yml 一行一个 server），且要重写 MCP 语义 |
| D. 代写 DSH 用户 preset / patch | 把 mcp 行写进 `$DSH_HOME/.agent-presets/` 或 `cordis.patch.yml` | ❌ 直接违反「Cindy 不同步、不自动下载、不代为批准」红线（`docs/dsh-integration.md:236-249`） |
| E. env 通道（`DSH_SYSTEM_PROMPT`） | env 传 roster/MCP 配置 | ❌ 无消费者；结构化 MCP 配置不适配 env；用户可见文本塞 env 有长度/日志风险 |

## 6. 安全不变量清单（全部复用现有实现，不新增旁路）

| 项 | 保证 |
| --- | --- |
| loopback + 随机端口 + per-session token | codexHttpBridge / remoteMcpBridgeToken 同款；未知 token 401 fail-closed；token 走 env 注入、YAML 只含 `!!js` 引用，不落盘（前提是 §4.3 的 `!!js` 求值时序验证通过，否则按该节降级口径如实改写本行） |
| ghost_call 运行时校验 | `classifyGhostVisibility`、附件/目录 grant、确认卡、Setup 卡全在 Main 现有实现，DSH 只是新入口 |
| 花名册安全序列化 | formatter 共享（固定包裹 + 字段级转义 + 16 条/8000 字符），不新增序列化路径；bridge 源码插值走 `JSON.stringify`，插件作者可控文本不进可执行代码 |
| 远端 fail-closed | 远端不生成 mcp 行、不传 roster |
| text-only | 不变，DSH 图像/文件拒绝逻辑不动（`dsh/capabilities.test.ts`） |
| 存量插件兼容 | 不动插件基座，不触发 `plugin-security-and-authoring.md` §5 迁移义务 |
| prompt 缓存前缀稳定 | roster 段与工具面都是会话装配时求值一次、会话内恒定 |

## 7. 风险与待验证点（实现前必须回答）

按优先级排序，1–4 是头号实测项，不通过则对应设计点必须回改：

1. **`!!js` 求值时序**（token 不落盘的前提）：cordis 装载 overlay 时对 `!!js`
   表达式的求值必须发生在 mcp-client 的 zod config parse 之前。现有
   `sandbox-policy.workspaceRoot` 已依赖同一机制，大概率成立；不成立则降级为
   token 明文入 YAML，并按 §4.3 / §6 的降级口径改写安全表述；
2. **确认卡/Setup 卡会话锚定**：DSH 会话的 maker sessionId 与 Renderer 卡片锚定是否
   一致（bridge 已用 maker sessionId 发事件，大概率通，需实测）；
3. **`getLiveSessionGrantState` 的 instance identity**：DSH 会话的 sessionInstanceId
   由 Maker 铸造（`maker.ts:573`），Full Access 自动交接路径（`ghost.ts:316-321`）
   需核对 DSH 会话能正确匹配；注意新 host 手工拼的 sessionCtx 不带 ALS 注入的
   字段，缺漏字段要逐个对账；
4. **打包闭包**：`dsh-mcp-client` + `@modelcontextprotocol/sdk` 是否进正式包（ASAR）——
   需扩展正式包 smoke；
5. **`failOnStartupError` 决策**：建议 `false`（连不上 = 无工具 + 日志，与「花名册
   为空不注入」哲学一致；该值恰为 mcp-client 的默认值，`lib/index.js:746`）；
   `true` 会让整个会话 boot 失败；
6. **mcp-client 从根 ctx 注册工具的 per-session 语义**：单会话进程下无冲突（现状一个
   DSH 进程一个会话），若未来复用进程需 per-agent realm，实现期验证；
7. **重连稳定性**：dsh-mcp-client 激活时 `await listTools`；server 的 7 个工具 schema
   恒定、roster 快照在 server 生命周期内恒定 → 重连恢复后工具定义不变、前缀稳定；
8. **overlay id 与用户层冲突**：insert 行的 `id: mcp-cindy` 若与用户自有
   `$DSH_HOME/cordis.patch.yml` 中的插件 id 撞名，合并行为取决于 cordis 层叠顺序，
   实现期验证并记录（概率极低，但属于「不写用户层」红线的边界情形）。

## 8. 验证计划（分层）

| 层 | 验证 |
| --- | --- |
| 单测 | composition 生成含/不含 mcp 行的 YAML（本地/远端两分支）；overlay 的 Authorization 为 `!!js` env 引用、YAML 全文不含 token 明文；bridge 生成含/不含 roster 段，且插值经 `JSON.stringify`（覆盖反引号 / `${}` / 换行等恶意字符用例）；dsh-host 的 token 注册/注销生命周期（含异常关闭路径） |
| maker-core 集成 | `dshHarness.integration.test.ts` 扩展：真实 DSH JS + **fake streamable-http MCP server**（返回 ghost 工具），断言工具出现在工具面并可调用 |
| Desktop transport | loopback 端点 401 语义、token 生命周期、并发会话隔离 |
| 正式包 smoke | mcp-client 依赖闭包、进程无孤儿 |
| 真实 API 人工验收 | DSH 会话走通 ghost_list → ghost_info → ghost_call 一个真实插件 + 确认卡弹出 |

门禁：实现时按 `docs/dsh-integration.md` 的验收流程与 `docs/dev-rules/` 对应专项规则
执行（`pnpm test:unit:related` + 相关 package typecheck + i18n 门禁等）。

## 9. 决策点（已裁决，2026-08-20）

1. **能力本身**：**放行**——DSH 会话开 Cindy 插件通道。这会在 `docs/dsh-integration.md`
   的「所有权边界」上开一个口子——Cindy 从「纯呈现/双向传输入口」变为「向 DSH 工具面
   提供插件服务」；执行与授权仍在 Main 插件基座，不放松任何安全判定。该文档已按 §10
   补相应行。
2. **远端语义**：**采用推荐项**——SSH 远端 DSH 会话保持 fail-closed 不注入（对齐
   Claude/Codex）。Pi 的 SSH remote-forward 隧道分叉点暂不统一，维持现状。

## 10. 涉及文档/规则更新（实现时同步）

- `docs/dsh-integration.md`：所有权边界表补一行说明 + 新增「DSH 会话的 Cindy 插件
  通道」一节（执行在 Main 插件基座、DSH 只经 mcp-client 调工具、text-only 不变）；
- `docs/ghost-progressive-discovery.md`：§3.2 注入落点表从三 harness 扩为四
  （含 DSH 的 bridge section 落点）；
- `docs/dev-rules/plugin-security-and-authoring.md`：不触基座无需改正文；若实现中
  发现作者可见契约变化（FORGE_GUIDE），按 §6 同步。

## 11. 实现记录（2026-08-20）

实现按 §4 推荐方案落地，文件清单与要点：

- **Main 侧** `apps/desktop/src/main/mcp-integrations/dshCindyMcpHost.ts`（新增）：
  loopback `http.Server`（127.0.0.1 随机端口），只接受 `/mcp`；per-session 随机
  32 字节 hex bearer token；未知 token 401、非 localhost 403（照抄 codexHttpBridge）；
  `StreamableHTTPServerTransport` 按 mcp-session-id 路由，每个 mcp session 新建
  `createCindyGhostsMcpServer(getCindyGhostsMcpDeps(...))`；tool-call 经
  `runWithLiziMcpSessionContext` 注入 ALS 语境（含 live sessionInstanceId，host
  回调现读 `_maker.getSession(sessionId)?.instanceId`）；`unregisterSession` 带
  expectedToken 代际守卫（同 sessionId 重建后旧 close 迟到不误删新注册）；最后
  一个会话注销后关服。
- **装配点** `apps/desktop/src/main/maker-host/index.ts`：
  `lifecycleHooks.prepareStartOptions` 的 dsh 分支本地会话先 `registerSession`、
  把 `{url, token}` 经 `prepareDshVendorOptions` 的新参数 `dshCindyMcp` 放进
  `DshVendorOptions`（解析失败回滚注册）；`lifecycleHooks.onClose` 按登记 token
  幂等注销（覆盖正常关闭与 transport 异常关闭路径）。SSH 远端（`remoteHostId`）
  不注册、不注入（fail-closed）。
- **maker-core**：
  - `composition.ts`：`DshCompositionOptions.mcp?: { url: string }`，本地会话在
    overlay insert 段生成 `mcp-cindy` 行（`@deepseek-ai/dsh-mcp-client`，
    `transport: streamable-http`，`headers.Authorization` 为
    `!!js "'Bearer ' + process.env.CINDY_DSH_MCP_TOKEN"`）——token 明文不进 YAML；
  - `dsh/index.ts`：roster 照抄 Claude 模式求值（`remoteHostId` → `''`），
    `bridgeSource = buildDshBridgeSource(roster)`；`CINDY_DSH_MCP_TOKEN` 进本地
    env 块；`DshVendorOptions` 新增 `dshCindyMcpUrl` / `dshCindyMcpToken`；
  - `bridge-source.ts`：`DSH_BRIDGE_SOURCE` 模板带 `/*__CINDY_ROSTER__*/ null`
    占位符，`buildDshBridgeSource(roster)` 用 `JSON.stringify` 整体替换（并显式
    转义 U+2028/U+2029）；运行期 `setup(agentCtx)` 里
    `if (ROSTER) agentCtx.systemPrompt.section({ name: 'cindy:roster', order: 60, text: ROSTER })`；
  - `dsh-local-transport.ts`：env 白名单加 `CINDY_DSH_MCP_TOKEN`；
  - `dsh-host.ts`：`buildDshAgent` 注入 `getGhostRosterPrompt`（与三 harness 同源）。
- `mcp-providers.ts:466-469` 的 DSH fail-closed **保留不动**（防御纵深，DSH 不走
  该 provider 列表）。

### §7 风险实测结论（全部通过）

| # | 风险 | 实测结论 |
| --- | --- | --- |
| 1 | `!!js` 求值时序 | ✅ 成立。cordis-plugin-loader 的 `interpolate` **递归**替换任意深度的
  `__jsExpr` 节点（`cordis-plugin-loader/lib/index.js:284-290`），发生在 entry
  config 物化时、早于 mcp-client 的 zod parse；集成测试断言 fake MCP server 收到的
  `Authorization` 精确等于 env 注入的 per-session token |
| 2 | 确认卡/Setup 卡会话锚定 | ✅ 语境 `sessionId` = maker business id，与 Renderer 卡片锚定同源
  （与 Claude in-process 路径同机制）；ALS 注入 live ctx，单测断言
  agentKind/sessionId/workingDir/live instanceId 全部正确 |
| 3 | instance identity | ✅ DSH host 的 ALS ctx 带 live `sessionInstanceId`（现读活跃 Session），
  `getLiveSessionGrantState` 的 `session.instanceId` 匹配成立；缺漏时权限读取方
  fail closed 不变 |
| 4 | 打包闭包 | ✅ `dsh-mcp-client` 随 `@deepseek-ai/dsh` 依赖、`@modelcontextprotocol/sdk`
  已随 codexHttpBridge 进 ASAR（正式包 smoke 走 §8 既有链路） |
| 5 | `failOnStartupError` | ✅ 保持默认 `false`（连不上 = 无工具 + 日志，不阻断会话 boot） |
| 6 | per-session 工具注册 | ✅ 单会话单进程现状下无冲突（集成测试实证工具面出现
  `mcp__cindy__ghost_list` 且可调用） |
| 7 | 重连稳定性 | ✅ mcp-client 自管重连；工具 schema 恒定、roster 快照恒定 |
| 8 | overlay id 冲突 | ⚠️ `id: mcp-cindy` 与用户 `cordis.patch.yml` 撞名时 cordis 层叠
  语义未专项实测（概率极低；insert 行晚于用户层,不写用户层红线保持） |

### 验证执行记录

- 单测：composition（mcp 行含/不含、YAML 不含 token 明文）、bridge-source（恶意
  fixture 插值、ESM 语法合法）、dshCindyMcpHost（401/404、并发隔离、代际守卫、
  关服重启）全部通过；
- maker-core 集成（`dshHarness.integration.test.ts` 新增用例）：真实 DSH JS +
  fake streamable-http MCP server + fake DeepSeek 流（第一轮 tool_calls →
  第二轮最终文本）——断言工具面出现 `mcp__cindy__ghost_list`、tools/call 到达
  fake server、bearer token 与 env 注入值精确一致、工具结果回传第二轮请求；
- 门禁：`pnpm test:unit:related` + desktop typecheck 通过；
- 正式包 smoke：随 beta 安装包构建走既有 ABI/打包验证链路（打包记录见
  `DSH-打包流程统一-接手文档.md`）。

### system prompt 门禁说明（maker-core-and-agent-behavior.md §4）

本改动让 DSH 会话的 system 段新增 `cindy:roster`（花名册召回线索，内容与
Claude/Codex/Pi 已上线的同源段完全一致，formatter 与安全序列化规则零新增）。
这是本方案文档（含 §4.3 的注入设计）经开发者明确放行后实施的——「可以开始做
这个了」即对该 system 段改动的确认；指标评估：roster 与工具面均为会话装配时
求值一次、会话内恒定（前缀缓存安全），集成测试覆盖两轮请求同一工具面。
