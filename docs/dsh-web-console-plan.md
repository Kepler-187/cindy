# DSH Web 控制台嵌入与配置共享实现方案

更新日期：2026-08-19
状态：本地核心链、开发版端到端验收与 SSH 启动链已完成并通过定向单测。Windows x64
Beta 安装包已生成；随包数据库初始化、DSH launcher/runtime 闭包与 Electron 启动 smoke
均通过。Beta 使用独立安装入口和图标，但与同区域正式版共享用户数据并保持互斥运行。

## 0. 实现结果（后续章节冲突时以本节为准）

2026-08-19 最终实现沿用了方案的产品目标，但在读取 rc.7 官方 CLI 后收缩了控制台 boot：

- 对话侧由 `apps/desktop/dsh/cindy-dsh-bin.mjs` 保留 packaged-bin 契约，组成顺序为
  `official dsh-base → DSH_HOME/cordis.patch.yml → Cindy 宿主 overlay → 派生 preset root`；
  Main 显式把 `DSH_HOME` 传给本地 transport。用户 patch 可扩展 DSH，但不能覆盖 Cindy
  后置的凭证、沙箱、权限和桥接边界。
- 控制台不再自行组装 `console-cordis.yml`，也没有平行的 console launcher。它直接用
  官方 `@deepseek-ai/dsh` CLI 执行 `dsh web --host 127.0.0.1 --port 0`；官方 web profile
  已包含 webserver、frontend、connection、settings、inventory 和设置 UI，并原生消费
  同一 home patch。
- `DshConsoleProcess` 以 Electron `utilityProcess` 懒启动该 CLI，启动并发去重、重复点击
  复用、崩溃后下次点击重建，退出时由统一 `onQuit(..., 'async')` 回收。控制台环境使用
  白名单且不传 `DEEPSEEK_API_KEY`。
- `/dsh-console` 保留 Cindy 左侧栏，右侧整个主工作区复用内置浏览器 WebView。空 guest
  先加载 `about:blank` 完成附加；Main 验证 `webContentsId` 确属调用方后，才返回自己持有的
  loopback URL，并把顶层导航锁在该动态 origin、拒绝所有弹窗。
- 隔离 `DSH_HOME` 集成测试已证明：同一用户插件在对话 launcher 与官方 Web inventory
  均为 active；Web `settings.mutate` 写入同一 `settings.yaml` 后，两个存活进程都收到
  热更新，随后文本对话仍正常完成。坏 patch/坏 settings 均 fail-loud。
- `dsh-test` 实机已验证首次点击启动、再次进入复用、主动终止控制台子进程后点击自动恢复、
  页面完整占用 Cindy 主工作区、跨 origin 导航被阻止且 `window.open` 被拒绝。
- DSH 模式由 official Web profile 的 `agentPreset.list` 动态投影；因此进入本地 DSH
  composer 时也可能为读取模式清单而启动/复用同一控制台进程，不再承诺“只有打开控制台
  页面才启动”。SSH/设备远程不使用本机清单，当前让远端 DSH 采用自己的默认模式。
- SSH transport 上传并执行同一 Cindy launcher，读取远端自己的 `~/.dsh` patch/settings，
  安全展开 `$HOME` 会话目录；远端 runtime 缓存按精确依赖闭包指纹失效，不再只看 rc 版本号。
- text-only 由 UI、capabilities 与 adapter 三层收口；image/file block 在 DSH 请求前被拒绝。

原方案 §2—§11 保留为设计过程与取舍记录，其中“自组控制台清单”“先系统浏览器后
WebView”“控制台用端口文件上报”等内容已被上述官方 profile 路径取代。

## 1. 背景与目标

让用户在 Cindy 侧边栏打开 DSH 的 Web 控制台页面，在其中查看/配置 DSH 插件，且这些配置
对 Cindy 里发起的 DSH 对话会话生效。

目标拆成四句可验收的话：

1. Cindy 侧边栏出现一个「DSH 控制台」入口，点击后在内嵌页面中打开 DSH Web。
2. 在 Web 页里修改插件配置（settings namespace）后，下一条 Cindy DSH 对话消息即按新
   配置执行。
3. 用户安装的 DSH 插件（磁盘上的插件目录 + 一份声明文件）同时出现在 Web 控制台的
   插件清单里，并被 Cindy 的对话会话加载。
4. 全程不扩大 Cindy 对 DSH 内部流程的所有权：boot 图主体仍由 Cindy 生成，用户插件与
   插件配置以 DSH 侧数据（`~/.dsh`）接入——与 `docs/dsh-integration.md` 的「只能收缩、
   迁回 DSH 所有」方向一致。

非目标：

- 不改 DSH 上游包源码（全部基于 `@deepseek-ai/dsh-app-boot` 等公开导出组合）。
- 不在 Web 页里做 Cindy 的供应商/凭证管理（凭证裁决永远留在 Cindy Main）。
- 插件「安装」不在 Web 页内完成（上游 inventory 是只读的，见 §3.3）；安装 =
  放插件目录 + 编辑声明文件，可以用脚本或后续的 Cindy UI 简化。

## 2. 现状事实（代码锚点）

### 2.1 Cindy 侧（实现前快照，已由 §0 的 launcher/DSH_HOME 接线更新）

- 每个 DSH 会话启动时，`packages/maker-core/src/agents/dsh/composition.ts` 的
  `buildDshCordisConfig` 生成一份**固定**的 Cordis 插件清单（18 个
  `@deepseek-ai/dsh-*` 包 + 相对路径的 `./cindy-dsh-bridge.mjs`），序列化为 YAML 写到
  每会话临时目录。
- launcher 解析：`apps/desktop/src/main/maker-host/dsh-host.ts` 的 `resolveDshLauncher`：
  优先 `CINDY_DSH_BIN` 环境变量（绝对路径且存在），否则
  `require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin')`。
- 本地 transport：`dsh-local-transport.ts` 以 `utilityProcess` 跑
  `dshRuntimeWorkerProcess.ts`，后者把 `process.argv` 改写为
  `[node, <launcher>, <configPath>]` 后加载 launcher。即 launcher 契约 = **argv[2] 是
  cordis 配置路径**。
- 子进程 env 白名单（`DSH_ENV_KEYS`）：`DEEPSEEK_API_KEY`、`DSH_CWD`、
  `DSH_SESSION_ROOT`、`DSH_SYSTEM_PROMPT`、`DSH_SNAPSHOT`。**不含 `DSH_HOME`**——
  DSH 侧会自然回落到 `~/.dsh`（`dsh-home-paths` 的默认），本方案依赖这个默认值。
- 远程（SSH）transport 走 `packages/maker-core/src/agents/dsh/transport.ts` 的
  `spawn(nodePath, [binPath, configPath])`，同一 argv 契约。
- composition 生成的清单中 **没有** settings 插件，且 agent-spine 显式
  `skills: { enabled: false }`。

### 2.2 DSH 上游侧（node_modules 实读结论，版本 0.1.0-rc.7）

- `packaged-bin`：要求显式配置（argv 或 `DSH_CORDIS_CONFIG`），无内置 fallback；调
  `boot(NAME, configPath, void 0, void 0, import.meta.url)`——**patch 参数空着没接线**。
- `dsh-app-boot` 公开导出 `boot / loadOptionalPatches / loadOverlayPatches /
  watchUserPatches / installFailLoud / loadEnv / resolveConfigPath` 等。
- patch 语义（`cordis-plugin-include` 的 `applyEntryPatches`）：patch 条目
  `{ id, insert, name, ...overrides }`；带 `insert` 时向命中的 group 或根清单**插入新
  插件条目**，不带 `insert` 时按 `id` 覆盖既有条目的 config。patch 文件是顶层 YAML
  数组，允许 `!!js` 表达式；缺失 = 无层，存在但非法 = fail-loud。
- 插件解析（`mountRootInclude` 的 `HostResolvedRootInclude`）：`isAbsolute(name)` →
  转 file URL 直接加载；`./` 前缀 → 相对配置文件目录；裸包名 → 从
  `bareModuleBaseUrl`（打包闭包）解析。**用户插件可以放任意磁盘路径。**
- `dsh-settings-file`：设置文档默认在 `~/.dsh/settings.yaml`，跨进程写锁 + 原子改名
  + 文件监听热发布——设计上即为多进程共享。
- `dsh-host-webserver`：HTTP/upgrade 路由注册插件，config `{ host, port }`，
  host 只接受 `127.0.0.1`（默认）或 `0.0.0.0`；`port: 0` 由 OS 分配。它**不服务
  文件**：dist 由 `dsh-host-frontend-static`（fallback owner）服务，`/api` 与 downlink
  WebSocket 由 connection 插件服务。其 README 明确：「Electron 以 `file://` 加载 dist、
  经 IPC bridge 承载 fetch」——上游自己就有 Electron 内嵌形态。
- `dsh-host-plugin-inventory`：**只读**的 Loader 树投影（id / specifier / 启用态 /
  fiber phase），没有安装/启停/删除能力。上游装插件走 CLI `dsh plugin`（profile 目录 +
  pnpm 管理 node_modules）。
- Web 前端 `apps/web`（`@deepseek-ai/dsh-web-frontend`）以 dist 形式发布；设置页
  体系含 `ui-settings-plugins`（按 namespace 渲染各插件的配置卡，保存经 client
  settings scope 落 `settings.yaml`）。

## 3. 总体架构

```
┌──────────────────────────── Cindy Desktop ────────────────────────────┐
│ 侧边栏「DSH 控制台」入口                                              │
│        │ 点击                                                         │
│        ▼                                                              │
│ 内嵌 WebView ──► http://127.0.0.1:<port>  ──┐                         │
│                                             │                         │
│ Main: 控制台进程管家 ──spawn──► DSH 控制台进程（常驻，console-bin）    │
│                                   │ boot: webserver + frontend-static │
│                                   │       + connection + settings     │
│                                   │       + inventory + 业务插件*     │
│                                   ▼                                   │
│                     读写 ~/.dsh/settings.yaml（插件配置）             │
│                     读写 ~/.dsh/cordis.patch.yml（插件清单）          │
└───────────────────────────────────────────────────────────────────────┘
                                     ▲
Cindy DSH 对话会话（每任务一个，cindy-dsh-bin launcher）
  boot: Cindy 生成的固定清单  +  patch 层（~/.dsh/cordis.patch.yml）
        └─ 其中固定插入 dsh-settings-file → 读同一份 settings.yaml
```

*控制台进程的 boot 也消费同一份 `cordis.patch.yml`，于是「装了什么插件」在两个进程
间天然一致：对话侧加载它，控制台侧把它的配置卡呈现在 Web 页里。

共享状态只有两个文件，都在 `~/.dsh`：

| 文件 | 写者 | 读者 | 内容 |
| --- | --- | --- | --- |
| `~/.dsh/cordis.patch.yml` | 用户（手编/脚本/未来 UI） | 对话 launcher、控制台 | 插件清单（insert 条目 + 可选 config 覆盖） |
| `~/.dsh/settings.yaml` | Web 页（经控制台 settings 服务）、用户 | 所有加载了 settings 插件的 DSH 进程 | 各插件 namespace 的配置值 |

## 4. 里程碑 M1：对话侧 launcher + patch 层

**目标**：Cindy 的 DSH 对话会话能加载 `~/.dsh/cordis.patch.yml` 声明的用户插件。
不改 `composition.ts`、不改任何 `@deepseek-ai` 包。

### 4.1 新文件：`apps/desktop/dsh/cindy-dsh-bin.mjs`（示意骨架）

契约与 `packaged-bin` 完全一致（argv[2] = 配置路径、stdin 结束即退出、stdout 留给
JSON-RPC、诊断只写 stderr），仅多一步：boot 前读用户 patch 文件。

```js
#!/usr/bin/env node
// cindy-dsh-bin.mjs — Cindy 专用 DSH launcher：packaged-bin 契约 + 用户 patch 层。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  boot, installFailLoud, loadEnv, loadOptionalPatches, resolveConfigPath,
} from "@deepseek-ai/dsh-app-boot";

const NAME = "cindy-dsh-agent";
const USER_PATCH = join(homedir(), ".dsh", "cordis.patch.yml");
// 裸包名（@deepseek-ai/dsh-*）必须从随包 DSH 闭包解析，与本文件位置无关。
const BARE_BASE = pathToFileURL(
  fileURLToPath(new URL(
    "../node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js",
    import.meta.url,
  )),
).href;

installFailLoud(NAME);
loadEnv(NAME);
const requested = process.argv[2];
const configPath = requested ? resolveConfigPath(requested, undefined) : undefined;
if (!configPath || !existsSync(configPath)) {
  process.stderr.write("usage: " + NAME + " <path/to/cordis.yml>\n");
  process.exit(1);
}
const patches = loadOptionalPatches(NAME, USER_PATCH) ?? [];
const ctx = await boot(NAME, configPath, patches, undefined, BARE_BASE);

let exiting = false;
async function disposeAndExit(code) {
  if (exiting) return;
  exiting = true;
  try { await ctx.fiber.dispose(); } finally { process.exit(code); }
}
process.stdin.on("end", () => disposeAndExit(0));
process.on("SIGTERM", () => disposeAndExit(0));
process.on("SIGINT", () => disposeAndExit(130));
```

要点：

- `BARE_BASE` 指向随包 `packaged-bin.js` 的 file URL（与上游 `packaged-bin` 传
  `import.meta.url` 同义），保证 Cindy 生成的裸包名继续从安装闭包解析。打包后需按
  实际布局校正这条路径（Forge 的 ASAR/unpacked 结构），这是 M1 唯一的打包敏感点。
- `loadOptionalPatches` 对缺失文件返回 `undefined`（无层），对非法文件抛错
  （fail-loud，会话起不来并在 stderr 给出文件名与原因）——语义与上游一致，不要吞掉。
- 不要把 `console.log` 写进这个文件或任何用户插件：stdout 是 JSON-RPC 专线。

### 4.2 接入 Cindy

- 开发期：设 `CINDY_DSH_BIN=E:\Workshop\cindy\apps\desktop\dsh\cindy-dsh-bin.mjs`
  即可，`resolveDshLauncher` 已支持。
- 打包形态：把 `cindy-dsh-bin.mjs` 加入 Forge 打包输入，并让 `resolveDshLauncher`
  在 `CINDY_DSH_BIN` 缺省时优先解析它（保留 packaged-bin 作为回退）。注意 worker 以
  虚拟 stdin 加载入口，launcher 必须是**单文件 ESM** 且其 import 全部可从解析位置到达
  （`@deepseek-ai/dsh-app-boot` 已在 desktop dependencies 中）。
- SSH 远程：`dsh-remote-transport` 同一 argv 契约，launcher 需同步部署到远端 DSH
  运行时旁。M1 只承诺本地，远程标记为未覆盖。

### 4.3 用户 patch 文件格式（`~/.dsh/cordis.patch.yml`）

```yaml
# 顶层数组，每个元素是一条 loader patch。
# 形式一：insert 向根清单插入用户插件（name 用绝对路径）
- insert:
  - id: user-my-echo
    name: "C:/Users/kepler/.dsh/plugins/my-echo/index.mjs"
    config:
      note: hello
# 形式二：按 id 覆盖 Cindy 既有条目的 config（谨慎，见 §9 风险）
# - id: agent-spine
#   config:
#     skills: { enabled: true }
```

规则：

- 用户插件 `id` 不得与 Cindy 固定清单的 id 重复（cindy-dsh-bridge、llm-deepseek、
  subprocess、bash、agent-spine、sessions、session-checkpoints、subagent、
  subagent-spawn-in-process、tool-subagent、tool-todo、fs-local、
  fs-observation-policy、tool-fs、token-meter、compaction-basic）。重复会变成覆盖语义，
  极易起不来。
- 用户插件 id 统一加 `user-` 前缀，一眼区分来源。
- 插件若 import `@deepseek-ai/cordis` 等包，其目录需自带 `node_modules`
  （`pnpm install`，同上游 profile 模型）；纯函数插件（只拿 `ctx` 干活）无需任何依赖。

### 4.4 M1 验证

1. 附录 A 的 PoC 已完成：patch insert + 绝对路径加载 + config 透传均工作。
2. 端到端：`CINDY_DSH_BIN` 指向 launcher，放一个在 `apply` 里向 stderr 写标记的
   用户插件，起一个 Cindy DSH 任务，确认 Cindy 日志（脱敏后）出现标记、对话正常。
3. 负例：patch 文件写非法 YAML，确认会话 fail-loud 且错误指向 patch 文件。
4. 负例：用户插件抛错，确认仅该会话失败、Cindy 其余功能不受影响。

## 5. 里程碑 M2：设置共享（settings.yaml 进对话会话）

**目标**：Cindy 对话会话读取 `~/.dsh/settings.yaml`，使 Web 页改的插件配置生效。

### 5.1 做法

在 `cindy-dsh-bin.mjs` 里，boot 前把 settings 插件**追加进 patch 列表**（相当于
固定内置一条 insert，而不是改 Cindy 的 composition）：

```js
const builtin = [{
  insert: [{ id: "settings", name: "@deepseek-ai/dsh-settings-file" }],
}];
const user = loadOptionalPatches(NAME, USER_PATCH) ?? [];
const patches = [...builtin, ...user];  // 用户 patch 在后，可覆盖 settings 的 config
const ctx = await boot(NAME, configPath, patches, undefined, BARE_BASE);
```

- `dsh-settings-file` 默认读 `~/.dsh/settings.yaml`，正是 Web 页写的那份。
- 用户 patch 放后面：想改 settings 路径/关掉 watch 时可以覆盖，默认零配置即可。
- 该包是否已进随包闭包需确认（M2 第一步）：`apps/desktop/package.json` 当前只声明了
  18 个 `dsh-*` 包；若缺 `dsh-settings-file`，补进 dependencies 并重打包。
- **生效语义**：settings-file 带文件监听，**进行中的会话**也能热读到 Web 页的保存；
  未加载 settings 的插件（其 namespace 不在会话 boot 图中）的配置静默无效，这是上游
  语义，不是 bug。

### 5.2 M2 验证

1. 起 Cindy DSH 任务，确认 boot 无警告（settings 插件激活）。
2. 手改 `~/.dsh/settings.yaml` 中某插件 namespace 的值，确认同一会话内该插件行为
   变化（用一个会读自己 namespace 的测试插件验证）。
3. 负例：settings.yaml 写成非法 YAML，确认 boot fail-loud（settings-file 的既定语义），
   文档写明恢复方法（删/修该文件）。

## 6. 里程碑 M3：DSH 控制台进程（原设计；实际改用官方 `dsh web`）

**目标**：在本机 127.0.0.1 上常驻一个 DSH Host，服务 DSH Web 前端，并把设置读写落到
`~/.dsh/settings.yaml`。

### 6.1 控制台 boot 清单

新文件 `apps/desktop/dsh/console-cordis.yml`（随包、静态，不按会话生成）：

```yaml
# DSH 控制台 boot 清单。确切包名与 config 字段以各包 README 为准，M3 第一步用 PoC 校准。
- id: webserver
  name: "@deepseek-ai/dsh-host-webserver"
  config: { host: "127.0.0.1", port: 0 }        # port 0 = OS 分配，启动后读回真实端口
- id: frontend-static
  name: "@deepseek-ai/dsh-host-frontend-static"
  config: { dist: "<随包 apps/web dist 路径>" }   # fallback owner，服务 SPA
# - id: connection                                # /api 桥与 downlink WebSocket；
#   name: "..."                                  # 确切包名/配置待查 packages/client/connection 的 Host 半
- id: plugin-inventory
  name: "@deepseek-ai/dsh-host-plugin-inventory"
- id: settings
  name: "@deepseek-ai/dsh-settings-file"          # 默认即 ~/.dsh/settings.yaml
# —— 与对话侧一致的业务插件，使 Web 设置页出现对应配置卡 ——
- id: bash
  name: "@deepseek-ai/dsh-bash-local"
  config: { cwd: ".", timeoutMs: 60000 }
# …（llm-deepseek 等需要凭证的插件不进控制台；控制台不发起模型调用）
```

控制台 launcher `apps/desktop/dsh/cindy-dsh-console-bin.mjs`：与 M1 的 launcher 同构，
区别是配置路径固定指向随包的 `console-cordis.yml`，并且**同样叠加
`~/.dsh/cordis.patch.yml`**——这样用户插件在控制台也加载，其 settings namespace 才会
出现在 Web 设置页（§3 的一致性设计）。

### 6.2 Cindy Main 的进程管家

- 位置：`apps/desktop/src/main/maker-host/` 新增 `dsh-console-process.ts`（或并入
  dsh-host.ts，视体量）。职责：懒启动（首次打开控制台页时 spawn）、端口读回
  （`ctx.webServer.port` 经 stdout/约定通道上报，或让 launcher 把 URL 写到
  `~/.dsh/console.port` 文件再轮询——推荐后者，stdout 仍保持干净）、崩溃退避重启、
  app 退出时 dispose。
- 端口分配用 `port: 0`，避免与既有服务冲突；bind 固定 `127.0.0.1`（webserver 默认
  姿态，也是安全底线，见 §8）。
- **凭证**：控制台进程不需要模型调用，不传 `DEEPSEEK_API_KEY`。若未来在控制台里做
  「测试连接」，密钥必须由 Cindy Main 临时注入、用完即弃，绝不落盘。

### 6.3 Web 前端 dist

- `@deepseek-ai/dsh-web-frontend` 以 dist 发布（package.json 的 files 含 dist）。
  把它加进 desktop dependencies，`frontend-static` 的 `dist` 指向解析到的目录。
- 版本必须与其它 `@deepseek-ai/*` 包同为 rc.7 闭包；升级时整组一起升。

### 6.4 M3 验证

1. 单跑控制台 launcher：浏览器打开返回的 URL，能看到 Web shell 与插件清单页。
2. 在设置页改一个插件配置（如 bash 的 timeoutMs），确认 `~/.dsh/settings.yaml` 被写入，
   且语法/注释保留（settings-file 的 leaf-diff 语义）。
3. 在 `cordis.patch.yml` 里加一个用户插件，重启控制台，确认清单页出现该插件、
   其配置卡可编辑。
4. 负例：端口被占（先 `port: 0` 规避）、dist 路径缺失时 fail-loud 文案可读。

## 7. 里程碑 M4：侧边栏入口 + 内嵌页面

实际实现直接采用方案 A，没有先落系统浏览器过渡版；内嵌页的 Main-owned guest 身份校验、
同源导航锁与弹窗拒绝见 §0。

**目标**：Cindy 侧边栏在「搜索」下方（用户截图红框处）出现「DSH 控制台」入口。

### 7.1 UI 形态选择

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| A. 内嵌 WebView 指向 `http://127.0.0.1:<port>` | Renderer 新路由/面板 + `<webview>` | 体验最完整；属 WebView 改动，必须过 `docs/dev-rules/electron-security-and-process-boundaries.md`（CSP、导航限制、nodeIntegration 关闭） |
| B. `file://` 加载 dist + IPC bridge | 上游 Electron 形态（webserver README 明示） | 无 HTTP 监听、攻击面最小；但要实现上游 connection 的 IPC bridge 半，工作量上移 |
| C. 调起系统浏览器 | Main `shell.openExternal` | 最简单；脱离 Cindy 窗口，入口只是快捷方式 |

**推荐先 C 后 A**：M4 第一版用 C 打通全链路（验证「配置共享」这个核心价值），
A 作为体验升级紧随其后；B 留作安全加强项，需要上游 bridge 契约稳定后再做。

### 7.2 落地清单（方案 A/C 公共部分）

- Renderer 侧边栏加入口项（图标 + 文案「DSH 控制台」）。动 UI 前必读
  `docs/design-rules/DESIGN.md`；新文案走 `i18n/GLOSSARY.md` + 五 locale 同步。
- 点击行为：方案 C = IPC 通知 Main 确保控制台进程在跑 → 读回 URL →
  `shell.openExternal(url)`；方案 A = 同前但导航到内嵌页。
- 入口可见性：仅在存在至少一个配置了 DSH runtime 的来源时显示（沿用 DSH 本身的
  出现条件），避免对非 DSH 用户造成干扰。
- 双模式：入口图标/文字必须 Light/Dark 双模式（语义 token），内嵌页是 DSH 自己的
  前端，不在 Cindy 双模式交付范围内，但入口本身在。

### 7.3 M4 验证

1. 入口出现/隐藏条件正确（有/无 DSH 来源）。
2. 点击后控制台进程懒启动、页面可开；二次点击复用同进程。
3. 修改插件配置 → 发起 Cindy DSH 对话 → 行为按新配置（全链路验收，M2+M3+M4 联调）。
4. Cindy 退出后控制台进程被回收（无孤儿）；Cindy 重启后端口变化不影响入口。

## 8. 安全与凭证边界

- **绑定地址**：webserver 只用 `127.0.0.1`，永不绑 `0.0.0.0`。控制台无鉴权，
  绑外网等于把插件配置面暴露给局域网。
- **stdout 纪律**：对话 launcher 与用户插件不得写 stdout（JSON-RPC 专线）；官方
  `dsh web` 控制台的 stdout 是其 readiness/diagnostic 通道，Main 只解析严格 loopback URL。
  stderr 经 Cindy 的 `redactSensitiveText` 脱敏后才进日志。
- **凭证**：`DEEPSEEK_API_KEY` 只由 Cindy Main 在启动对话会话时经 env 白名单注入；
  控制台进程默认不持有。用户插件运行在对话会话进程内，**读得到该进程 env**——
  因此 patch 文件和插件目录必须视为「用户自己机器上的显式信任配置」，不做远程同步、
  不做 UI 诱导安装，文档里写清楚这一点。
- **patch 覆盖边界**：用户 patch 位于 official base 之后，可扩展或覆盖 DSH 自有配置；
  Cindy 的凭证、沙箱、权限、preset root 与 bridge overlay 后置，用户 patch 不能反向覆盖
  这些宿主安全边界。错误 patch 或插件仍按 DSH 语义 fail-loud。
- **WebView（方案 A 时）**：`nodeIntegration: false`、`contextIsolation: true`、
  锁定导航到 `http://127.0.0.1:<port>`、禁用 `window.open` 外跳或经确认框——逐条对照
  electron 安全基线文档执行。

## 9. 风险与未决问题

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| 1 | connection 插件的确切包名/config 未核实 | M3 boot 清单可能起不来 | M3 第一步读 `packages/client/connection` 与上游 `dsh web` 命令实现校准 |
| 2 | `dsh-settings-file` / web 前端 dist 不在当前随包闭包 | M2/M3 需要加依赖、重打包 | 加进 `apps/desktop/package.json`，整组对齐 rc.7 |
| 3 | Web 设置页只呈现「Host 已加载插件」的 namespace | 用户插件没进控制台 boot 时其配置卡不可见 | 控制台 boot 同读 `cordis.patch.yml`（§6.1 已含） |
| 4 | 对话会话是短进程，Web 里改配置对**进行中的**回合语义取决于各插件自身 | 部分配置可能下个会话才生效 | settings-file 热发布能覆盖多数；文档如实写明 |
| 5 | SSH 远程会话的用户插件 | patch/settings 属于远端，不能错误读取本机模式 | transport 执行同一 launcher 并读远端 `~/.dsh`；本轮不把本机 preset 列表传给远端 |
| 6 | 上游 rc 版本升级改 patch/boot 契约 | launcher 编译期不错、运行期挂 | launcher 只做薄封装 + 附录 A 的 PoC 收进回归脚本，升级后先跑 PoC |
| 7 | 仓库规则张力：`composition.ts` 应收缩 | 本方案没动 composition，但新增了 Cindy 侧 launcher | 在 PR 说明中引用本文档，说明 launcher 是「搬运 DSH 自有机制」而非扩展 DSH 内部流程 |

## 10. 打包清单（自打包形态）

实际新增进包内容：

- `apps/desktop/dsh/cindy-dsh-bin.mjs`（M1）
- `.vite/build/dshConsoleWorkerProcess.js`（M3）
- 新增 direct dependencies：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-app-boot`、
  `@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-settings-file`（全部固定 rc.7）；Forge 按
  `@deepseek-ai/dsh` 的实际 dependency/peer closure 递归复制官方 Web profile 所需包。
- `resolveDshLauncher` 默认指向 `cindy-dsh-bin.mjs`
- Forge 配置：launcher 进入 `.vite/build`，console worker 作为 Vite main entry，官方
  `@deepseek-ai` 闭包进入应用 node_modules；定向测试已锁住路径与 `.mjs` worker 导入。

## 11. 分层验证总表

| 层 | 内容 | 通过标准 |
| --- | --- | --- |
| 机制 PoC | 附录 A | 已完成 |
| M1 单测 | patch 加载、fail-loud、id 冲突 | vitest 覆盖 launcher 的 patch 组装函数 |
| M1 集成 | `dshHarness.integration.test.ts` 同款 fake HTTP + 用户插件 | 用户插件激活、对话文本流正常 |
| M2 集成 | settings.yaml 共享 | 改文件 → 会话内行为变 |
| M3 手工 | 浏览器开控制台、改配置、查落盘 | §6.4 |
| M4 联调 | 入口 → 控制台 → 改配置 → 对话生效 | §7.3 |
| 正式包 smoke | Windows x64 Beta 打包后全链路 | 已通过：launcher/runtime 入包、全新数据库初始化、Electron 退出码 0，无 ASAR 解析失败 |
| 提交门禁 | `pnpm test:unit:related` + desktop/maker-core typecheck + `check:i18n-glossary` | 全绿 |

## 附录 A：已验证的机制 PoC（2026-08-19）

在 `E:\Workshop\cindy` 用随包 `@deepseek-ai/dsh-app-boot@0.1.0-rc.7` 实测：

- 以 Cindy 同款方式构造基础 `cordis.yml`（裸包名 `@deepseek-ai/dsh-token-meter`），
  `bareModuleBaseUrl` 指向随包 `packaged-bin.js`——裸包名解析正常。
- `loadOptionalPatches` 读入一份用户 patch（`insert` 一条**绝对路径**的用户插件，
  带 `config.note`），`boot` 成功，用户插件的 `apply(ctx, config)` 被执行并收到
  config（写标记文件验证）。
- `ctx.fiber.dispose()` 干净退出。

结论：方案 A（自定义 launcher + patch 层）不依赖任何未发布的上游能力，M1 可直接开工。
PoC 临时文件在 `.tmp/dsh-plugin-poc/`（可删）。

## 附录 B：用户插件最小模板

```js
// ~/.dsh/plugins/user-hello/index.mjs
export default function apply(ctx, config) {
  // ctx = Cordis context；config = patch 条目里的 config。
  // 诊断只能写 process.stderr，禁止 console.log（stdout 是 JSON-RPC）。
  process.stderr.write("[user-hello] loaded\n");
}
```

```yaml
# ~/.dsh/cordis.patch.yml
- insert:
  - id: user-hello
    name: "C:/Users/kepler/.dsh/plugins/user-hello/index.mjs"
```

需要 import `@deepseek-ai/cordis` 类型或工具时，在插件目录跑 `pnpm init && pnpm add
@deepseek-ai/cordis`，让插件自带 node_modules。
