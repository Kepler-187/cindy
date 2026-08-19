# DSH 控制台修复 + 打包接手文档

> 生成时间：2026-08-19 22:35（本地）
> 目的：给下一个对话完整交接"DSH 控制台无法启动"的根因、修复、以及重新打包过程中的全部调查结论与未解决问题。

---

## 一、任务背景与目标

用户环境：Windows 10 Enterprise，工作区 `E:\Workshop\cindy`（Cindy 客户端仓），已安装正式版 `C:\Users\kepler\AppData\Local\Programs\CindyBeta`（Beta 版，Electron 41.10.3，Node 24.18.0）。

**原始问题**：CindyBeta 里打开 DSH 控制台失败。日志（`C:\Users\kepler\AppData\Roaming\cindy\logs\main-2026-08-19.log`）反复出现：

```
DSH console failed to load: failed to apply loader entry ... (@deepseek-ai/cordis-plugin-hmr):
--expose-internals is required for HMR service
```

随后 worker 进程退出，webview 连 `http://127.0.0.1:<port>/` 报 `ERR_CONNECTION_REFUSED/RESET`。

**目标**：让正式版 CindyBeta 的 DSH 控制台能打开（已通过源码修复 + fork 推送 + 重新打包三步推进）。

---

## 二、根因（已完成定位，100% 确认）

DSH（`@deepseek-ai/dsh@0.1.0-rc.7`）web profile 启动失败的完整链条：

1. **web profile 组装禁用了 HMR 插件**：`dsh-web-app` bundle 的 `cordis.patch.yml` 有 `- id: hmr  disabled: true`（官方 TODO：待热更新生命周期验证后重启用）。
2. **但 DSH 启动器在 boot 后强制恢复 HMR**：`apps/cli/src/profile-boot.ts` 的 `runProfile()` 在 boot 成功后执行：
   ```ts
   if (ctx.get('hmr') === undefined) {
     if (ctx.get('timer') === undefined) await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
     await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
   }
   await watchUserPatches(...)  // 用户 patch 热更新，依赖 hmr 服务
   ```
   目的是保持用户 patch（`cordis.patch.yml`）热更新契约。
3. **HMR 插件硬性要求 Node `--expose-internals`**：`cordis-plugin-hmr` 构造器 `if (!this.ctx.loader.internal) throw new Error('--expose-internals is required for HMR service')`。`loader.internal` 来自 `cordis-plugin-loader` 的 `ModuleLoader.fromInternal()`，两条路：
   - `require('internal/modules/esm/loader')`（需 `--expose-internals` 真实生效）
   - `node-addon-require-builtin` addon（需 Node 的 `GetAlignedPointerFromEmbedderData` 符号）
4. **打包版（CindyBeta）utilityProcess 里两条路都断**：
   - `--expose-internals` 传了 `execArgv: ['--expose-internals']`（dsh-console-process.ts 确认），`process.execArgv` 里也有，但 **`require('internal/*')` 全部 `MODULE_NOT_FOUND`**（实测 `internal/util`、`internal/modules/esm/loader` 等）；**dev 版 electron（node_modules/electron/dist/electron.exe）同样调用成功**。与 fuses 无关（flip 过 EnableEmbeddedAsarIntegrityValidation / EnableNodeOptionsEnvironmentVariable / EnableNodeCliInspectArguments 均无效）。**exe 二进制级差异，原因未明**。
   - addon 路径：Electron 的 Node 无 `GetAlignedPointerFromEmbedderData` 符号 → `requireBuiltin` 失败。
5. 强制创建的 HMR 抛错 → `suppressShutdownError` **rethrow** → `runProfile` 失败 → worker `import(cli)` reject → 控制台进程退出。

**为什么 dev 版能开**：dev electron 的 utilityProcess 里 `--expose-internals` 真实生效 → `loader.internal` 有值 → HMR 强制恢复不报错；且 `internal.import` 能解析链接到工作区 `node_modules` 的包。

**附带发现（不影响主因，但记录）**：即使 `--expose-internals` 生效（dev electron + ASAR 内 DSH CLI），`internal.import`（Node cascaded loader）解析 `~/.dsh/profiles/node_modules` 符号链接指向 **app.asar 内路径**时会 `ERR_MODULE_NOT_FOUND`（Node 原生 resolver 不认 asar 虚拟路径）；链接指向工作区时可读。`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是符号链接（junction），由 DSH 的 `healProfilesModuleFallback` 按"DSH 安装位置"（launcher 所在包）每次启动重写：CindyBeta 打包版 → 指向 app.asar 内；dev → 指向工作区。

---

## 三、修复（源码层已完成）

**修改文件**（DSH 源码，`apps/cli/src/profile-boot.ts`）：

```diff
   if (!signalShutdown.signal.aborted
     && ctx.fiber.state === FiberState.ACTIVE
     && ctx.get('loader') !== undefined
+    && ctx.loader.internal !== undefined) {
```

即：**`loader.internal`（--expose-internals）不可用时跳过 HMR 兜底挂载和用户 patch 热更新（watchUserPatches）**。internal 可用时行为完全不变（dev 环境无回归）。代价：无 internal 的环境里 `cordis.patch.yml` 改动需重启生效。

- **已验证**：模拟打包环境（utilityProcess 不传 execArgv → internal undefined）→ 控制台正常启动（`dsh web: http://127.0.0.1:<port>` 稳定运行）；dev 环境回归正常。
- **工作区 node_modules 补丁**（编译产物，等价改动）：`E:\Workshop\cindy\node_modules\@deepseek-ai\dsh\lib\profile-boot-DG5t9aNs.js`（256 行加了 `&& ctx.loader.internal`），备份 `.bak` 同目录。
- **已推送 fork**：用户 fork `github.com/Kepler-187/deepseek-harness`，分支 `fix/dsh-console-hmr-expose-internals`，commit `40a0c91`（本地 `E:\Workshop\deepseek-harness`，remote `fork` 已配好）。未提 PR（用户明确不要）。

---

## 四、重新打包：全部障碍与调查记录（重点！新对话从这接手）

打包命令：`pnpm release:package --beta --region cn --no-sign --skip-smoke`（cwd 应为 `E:\Workshop\cindy\apps\desktop`？——**注意**：用户上次成功产物的路径是 `apps/desktop/release/artifacts/cn/beta/unversioned/win32-x64/cindy-beta-unversioned-Setup.exe`，而我跑的从根 `E:\Workshop\cindy` 起，产物预期在 `E:\Workshop\cindy\release\artifacts/...`？——**需确认 release:package 的 cwd 约定**，见 package-desktop.mjs 头注释。实际我之前跑完都是失败，未验证产物路径）。

**关键环境事实**：我的执行环境（pwsh 工具）是沙箱，**大量系统环境变量为空/缺失**，这是连环失败的根源：
- `PATH` 只有 `C:\Program Files\PowerShell\7`（无 System32、无 node、无 git）
- `ComSpec` 空、`ProgramData` 空、`ALLUSERSPROFILE` 空、`CommonProgramFiles` 空/损坏（"(x86)"）、`SystemDrive` 空
- node/git/pnpm 都不在 PATH（node 在 `C:\Program Files\nodejs`，git 在 `C:\Program Files\Git\cmd`，pnpm 在 `C:\Users\kepler\AppData\Roaming\npm`，Python 3.12 在 `C:\Users\kepler\AppData\Local\Programs\Python\Python312`）

**打包障碍逐个（已解决）**：

1. **node-gyp 找不到 Python** → 需要 `cmd.exe`（node-gyp `checkCommand` 用 shell:true，靠 ComSpec/PATH 找 cmd）。修复：设置 `ComSpec=C:\WINDOWS\system32\cmd.exe` + PATH 加 System32 + `PYTHON` 指向 Python312。
2. **node-gyp 找不到 VS**：`Find-VisualStudio.cs` 用 COM（`Setup Configuration` CLSID `{42843719-...}`），**该 COM 组件未注册**（HKCR 查无；vswhere 也返回空）→ node-gyp 查不到 VS。修复：**绕过 COM，走 `findVSFromSpecifiedLocation`**——需要 **vcvars 环境变量**：`VCINSTALLDIR`、`VSCMD_VER`（vcvars 设置）、`WindowsSDKVersion`（vcvars 不一定导出，需手动设 `10.0.26100.0`，SDK 已装在 `C:\Program Files (x86)\Windows Kits\10`）。获取方式：`cmd /c "call "...\vcvars64.bat" >nul 2>&1 && set"` 提取全部环境变量（vcvars 路径：`C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`）。
3. **MSBuild FileTracker 崩溃**（MSB4018 `FileTracker` 初始化异常，`Path.GetPathRoot("")`）：vcvars 提取的 env 里**系统变量被沙箱清空**。修复：手动补 `TMP`/`TEMP`/`ProgramData`/`ALLUSERSPROFILE`/`CommonProgramFiles`/`CommonProgramFiles(x86)`/`SystemDrive`/`SystemRoot` 到标准值。
4. **cargo（cindy-updater.exe 构建，prePackage hook）找不到 windows.h**：vcvars 的 INCLUDE **没含 Windows SDK**（SDK 注册缺失导致 vcvars 不加）。修复：手动追加 SDK Include/Lib 到 INCLUDE/LIB：
   ```
   INCLUDE += C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\{ucrt,shared,um,winrt}
   LIB += C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\{ucrt\x64,um\x64}
   ```
5. **node-pty 编译在 forge 内挂起（0 CPU）**：**尚未解决（当前卡点）**。详见下节。

**当前打包脚本**（环境修复汇总）：`C:\Users\kepler\AppData\Local\Temp\package-cn-beta.ps1`（vcvars 提取 + 系统变量 + SDK Include/Lib + PATH/PYTHON，然后跑 `pnpm release:package --beta --region cn --no-sign --skip-smoke`，日志 `E:\Workshop\cindy\release-package-cn-beta.log`）。

**2026-08-20 更新**：该脚本已迁移入仓为 `apps/desktop/scripts/package-windows-env.ps1`（本机路径集中在顶部变量区，含 `TrackFileAccess=false` 的 FileTracker 挂起修复）。统一打包流程与 ABI 硬校验已落地，详见 `DSH-打包流程统一-接手文档.md` 第十/十一节。

---

## 五、已解决：node-pty rebuild 在 forge 内挂起（2026-08-20 更新）

**现象**：完整打包跑到 `[forge:afterCopy] rebuilding native modules (better-sqlite3, node-pty)` 后，MSBuild.exe 启动但 **0 CPU 持续数分钟**（挂起），无 cl.exe 编译活动、无输出。已挂 3 次（job pwsh-6/7/8，均被 kill）。

**2026-08-20 结论与处置**：

- **挂起修复**：打包脚本加了 `TrackFileAccess=false`——受限 shell 里 MSBuild FileTracker 的「挂起创建子进程 + 注入 tracker DLL」机制失效，cl.exe 被创建成挂起状态后无人唤醒（0 CPU 假死）。一次性发布构建不需要增量跟踪。该修复已随 `apps/desktop/scripts/package-windows-env.ps1` 入仓。
- **独立重编实证**（干净临时目录，root 137 better-sqlite3 + node-pty 1.2.0-beta.15 拷贝，同一套环境 + `TrackFileAccess=false`）：`electronRebuild(force:true)` 18.4s 完成，无挂起——better-sqlite3 走 prebuild-install 落 145，node-pty 走 node-gyp 从源码重编出 conpty.node + conpty_console_list.node。
- **win32 node-pty 主 addon 是 conpty.node，不是 pty.node**（1.2.x 的 binding.gyp 无 pty target；1.1.x 才同时编 pty.node 作 winpty 兜底）。旧文档「包内 pty.node」口径只适用于 1.1.x。
- forge 进程内完整链路（2h 打包）尚未复跑，建议窗口期跑一次确认（见 `DSH-打包流程统一-接手文档.md` 第十节）。

**历史已验证记录（第一轮调查，保留备查）**：
- **手动在打包现场（electron-packager 的 temp app 目录）用同一套环境跑 `electronRebuild({buildPath, electronVersion:'41.10.3', onlyModules:['better-sqlite3','node-pty'], force:true})` 成功**（一次单 node-pty 约几十秒、一次双模块 82 秒 "BOTH REBUILD DONE"）。
- **残留进程**：某次被杀后残留 cl.exe（启动于 21:53，29 分钟后仍 0 CPU 挂着）可能锁资源；**已彻底清理**（杀 MSBuild/cl/node-gyp/forge 进程 + 清 `C:\Users\kepler\AppData\Local\Temp\electron-packager`）后重跑**仍然挂起** → 残留不是唯一原因。
- 环境：手动测试与打包脚本设置的环境基本一致（vcvars + SDK + 系统变量）。
- **尚未定位**：为什么 forge 进程内 electronRebuild 挂起而独立脚本进程成功。怀疑方向：
  - forge 进程（`package-desktop.mjs` 的 `runForgeMake` 用 `execSync('npx electron-forge make ...', { env: forgeEnv })`，forgeEnv = `{...process.env, NODE_ENV, ...desktopClientBuildEnv(...)}`）——**环境理论上继承全量**，但可能有变量被覆盖/裁剪，需逐项对比 forge 进程实际 env 与手动脚本 env。
  - **并行**：better-sqlite3 与 node-pty 并行 rebuild（@electron/rebuild 内部 Promise.all）→ 并发 MSBuild 冲突/文件锁。**未在干净目录验证过并行**（最后一次"clean both"测试因复制 node-pty 时 package.json 缺失失败，`Copy-Item node-pty` 后 `rebuild` 报 `ENOENT ...\node-pty\package.json`——注意复制要用 `-Recurse` 且目标结构正确）。
  - MSBuild 在 electron-packager 的 temp 路径（`C:\Users\kepler\AppData\Local\Temp\electron-packager\tmp-*\resources\app\...`）编译，路径/权限/杀软因素未排除。
  - **建议下一步**：①在**干净的临时目录**重新做"双模块并行"测试（复制好完整包结构）确认是否并行挂起；②若并行挂 → 改 `apps/desktop/forge.config.ts` 的 afterCopy hook，把 `electronRebuild({onlyModules:['better-sqlite3','node-pty']})` 拆成**两次串行调用**（better 一次、node-pty 一次）；③或干脆**预编译 node-pty（Electron ABI 145）**到工作区/缓存，打包时跳过 rebuild（注意 electron-packager 默认也会 rebuild 原生模块，需看 forge.config.ts 的 packagerConfig.rebuild 配置）。

---

## 六、其他重要事实与提醒

- **ABI**：系统 Node 24.14 = ABI 137；Electron 41.10.3 = ABI 145。node-pty 的 prebuilds（Node ABI）在 Electron 里不可用，必须 electron-rebuild。
- **用户之前打包成功过**（2026-08-19 17:32 本地，产物 `apps/desktop/release/artifacts/cn/beta/unversioned/win32-x64/cindy-beta-unversioned-Setup.exe` 241MB，build-info 显示 region=cn、beta、versionless、commit 5be14e60、Electron 41.10.3）——**说明完整环境（含 VS COM 注册？）当时是好的**；我调查时 COM 未注册，是否环境差异或之后损坏未确认。claw-kit 任务记录（`E:\Workshop\cindy\.claw\archive\tasks\2026-08-19\实现-DSH-Web-控制台与配置共享\plan.report`）确认当时"Windows Beta 安装包与随包启动 smoke 已通过"。
- **当前安装的 CindyBeta 有编译好的 pty.node**（`...\resources\app.asar.unpacked\node_modules\node-pty\build\Release\pty.node`，Electron ABI，303104 字节，17:32 编译）——可作预编译产物来源。
- **用户侧备份**：改正式版 exe/asar 的备份已留（`CindyBeta.exe.bak-dsh-fix`、`app.asar.bak-dsh-fix`，在安装目录）；**exe 的 asar 完整性校验 fuse 未实际改**（当时 EBUSY，用户 Cindy 在跑）。
- **临时测试残留**：`E:\Workshop\cindy\.tmp-dsh-test` 已清理；`C:\Users\kepler\AppData\Local\Temp\` 下有 `package-cn-beta.ps1`、`clean-both.ps1`、`pty-rebuild-full.ps1`、`both-rebuild.ps1`、`vcvars-*.ps1` 等调试脚本可复用。
- **fork 相关**：本地 `E:\Workshop\deepseek-harness`（remote origin=官方、fork=用户 fork），分支 `fix/dsh-console-hmr-expose-internals` 已推送。
- **环境工具**（沙箱里跑命令都要显式加 PATH）：node=`C:\Program Files\nodejs\node.exe`，git=`C:\Program Files\Git\cmd\git.exe`，pnpm=`C:\Users\kepler\AppData\Roaming\npm\pnpm.cmd`，python=`C:\Users\kepler\AppData\Local\Programs\Python\Python312\python.exe`，cmd=`C:\WINDOWS\system32\cmd.exe`，powershell 5.1=`C:\WINDOWS\system32\WindowsPowerShell\v1.0\powershell.exe`。

---

## 七、下一步清单（新对话建议顺序）

1. **读本文档**（本文件）→ 确认根因和修复已就绪。
2. **解决 node-pty rebuild 挂起**（第五节）：
   - 先做干净目录的"双模块并行"复现（修复 clean-both 测试的包复制问题：用 `Copy-Item ... -Recurse` 且确认 package.json 到位，或直接用 `electron-packager` 现场）。
   - 若并行挂 → 改 `forge.config.ts` afterCopy 串行化（两次 electronRebuild 调用）。
3. **重跑 `package-cn-beta.ps1`**（或等价的完整环境打包命令）→ 验证产物 `cindy-beta-unversioned-Setup.exe` 生成。
4. **验证产物**：解包/读取新 app.asar 里的 `profile-boot-*.js`，确认含 `ctx.loader.internal` 修复；启动安装包验证 DSH 控制台。
5. **安装到 CindyBeta**（用户现有安装）或作为新安装；提醒用户更新器（cindy-updater）后续更新会覆盖本地改的 exe/asar（如走了改安装路径）。

---

## 八、关键文件/路径速查

| 项 | 路径 |
|---|---|
| 工作区 | `E:\Workshop\cindy` |
| DSH 源码修复 | `E:\Workshop\deepseek-harness\apps\cli\src\profile-boot.ts` |
| 工作区补丁（编译产物） | `E:\Workshop\cindy\node_modules\@deepseek-ai\dsh\lib\profile-boot-DG5t9aNs.js`（+`.bak`） |
| fork 分支 | `github.com/Kepler-187/deepseek-harness` @ `fix/dsh-console-hmr-expose-internals`（commit 40a0c91） |
| 打包脚本（环境修复版） | `C:\Users\kepler\AppData\Local\Temp\package-cn-beta.ps1` |
| 打包日志 | `E:\Workshop\cindy\release-package-cn-beta.log` |
| 上次成功产物 | `E:\Workshop\cindy\apps\desktop\release\artifacts\cn\beta\unversioned\win32-x64\cindy-beta-unversioned-Setup.exe` |
| 已装正式版 | `C:\Users\kepler\AppData\Local\Programs\CindyBeta` |
| 日志 | `C:\Users\kepler\AppData\Roaming\cindy\logs\main-2026-08-19.log` |
| DSH 集成文档 | `E:\Workshop\cindy\docs\dsh-integration.md`（排障章节可补 HMR/--expose-internals 条目） |

---

## 九、第二轮问题（2026-08-20）：控制台能启动但前端 "Failed to load plugins"

**现象**（HMR 修复已生效、打包版控制台进程正常 `dsh web: http://127.0.0.1:<port>` 之后）：

```
HARNESS
Failed to load plugins
web boot: 1 entry did not activate @deepseek-ai/dsh-client-app-shell: pending (waiting for services: slots, sessions, layout)
```

**根因（已定位、已验证）**：

1. 浏览器端 boot 由 `dsh-client-modules` 的 node 半边负责：扫描 Loader 树里声明
   `dsh.client.platform: web` 的条目，组合成 `window.__DSH_BOOT__`（manifest），并托管
   `/plugins/<id>/client.js`。扫描用 `createRequire(ctx.baseUrl).resolve(pkg + '/package.json')`
   （`ctx.baseUrl` = profile 目录 `~/.dsh/profiles/web`），沿 Node 父目录链先走
   `web/node_modules`，再走共享 fallback `~/.dsh/profiles/node_modules`。
2. `healProfilesModuleFallback`（`@deepseek-ai/dsh-app-boot`）在每次 profile boot 时把
   `~/.dsh/profiles/node_modules` 里的包链接（Windows junction）**指向安装位置 =
   app.asar 内部路径**（如 `C:\...\resources\app.asar\node_modules\@deepseek-ai\...`）。
   app.asar 是文件不是目录，这种 junction 在 OS 层就是死链 → 扫描里
   `resolveMeta` 对每个包都解析失败（静默返回 null）→ 表为空 → manifest `entries: []` →
   前端只剩静态注册的 app-shell（inject slots/sessions/layout 无提供者）→ 报上面的错。
   （Load 器本身解析 in-box 插件走「installation 优先」直接进 asar，Electron 补丁能读，
   所以服务端 132 个条目全部 active、server 正常、只是客户端 roster 为空。）
3. 佐证：用工作区 CLI（`node E:\Workshop\cindy\node_modules\@deepseek-ai\dsh\lib\bin.js web`）
   起第二实例，heal 把 fallback 链接指向**工作区真实目录**后，manifest 38 个条目全出、
   `/plugins/.../client.js` 全部 200。asar 内与工作区包内容逐字节一致。

**修复（本机已做，2026-08-20 1:30 前后）**：

- 在 `C:\Users\kepler\.dsh\profiles\web\node_modules\@deepseek-ai\` 下创建 195 个 junction，
  指向 `E:\Workshop\cindy\node_modules\@deepseek-ai\`（镜像共享 fallback 的包清单）。
  profile 自己的 `node_modules` 在父目录链上**先于**共享 fallback 被解析，且
  `healProfilesModuleFallback` 不管理它 → 跨重启稳定。
- 已停掉旧控制台 worker（PID 37632，端口 65200）。用户在 Cindy 里重新打开 DSH 控制台
  （关掉视图再开，或点「重试」）即会以新 junction 环境 boot，manifest 应有 38 个条目。

**遗留 / 注意**：

- 这是本地环境修复，不解决打包版固有缺陷。**上游正确修法**（DSH 源）：
  `healProfilesModuleFallback` 在 Windows 打包环境不应把 fallback 链接指向 asar 内路径，
  应改为复制到真实目录（如 `app.asar.unpacked`）或直接跳过已在安装包内可解析的包。
  可加到 fork `Kepler-187/deepseek-harness`（本地 checkout `E:\Workshop\deepseek-harness` 已删，
  需重新 clone）。
- 若工作区 node_modules 被删/换路径，`web/node_modules` 的 junction 会失效，需重做。
- `dsh plugin --profile web add ...`（pnpm 管理 profile 依赖）理论上会看到这批 junction；
  本机未用该命令，风险待观察。
- 新 worker 启动时 `healProfilesModuleFallback` 仍会把共享 fallback 指回 asar（无害，
  因为 web/node_modules 优先），不要把它当回归。
