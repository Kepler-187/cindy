# CindyBeta 打包流程统一 — 接手文档（给下一个 Agent）

> 生成时间：2026-08-20（本地）
> 目的：完整交接「CindyBeta 打包流程不规范 → 产出 ABI 137 坏包」的调查结论、已实证证据、
> 代码现状与统一流程方案，让下一个 Agent 直接接手落地，不用重新踩坑。

---

## 一、背景与结论速览

**现象**：安装包装好后，CindyBeta 启动报 `DB INIT FAILED`：
`better_sqlite3.node was compiled against a different Node.js version (NODE_MODULE_VERSION 137). This version of Node.js requires NODE_MODULE_VERSION 145.`

**结论（已 100% 实证）**：
- **坏包**里 `app.asar.unpacked/.../better_sqlite3.node` 是 **ABI 137**（Node 24 产物）；
- Electron 41.10.3 需要 **ABI 145**；
- 两个候选安装包一个 137、一个 145，安装结果一坏一好，用户已确认好包可用。

**为什么「好包」是好的**：它不是完整流程产物，而是**对「已修好的 packaged 目录只重跑 NSIS 阶段」**的结果——
当时 `apps/desktop/out/CindyBeta-win32-x64/resources/app.asar.unpacked/.../better_sqlite3.node` 恰好已是 145（2026/6/16 从 145 缓存拷入，见下）。**完整打包流程反而产出 137**。这就是「流程不规范」的核心。

**当前状态**：没有一条可复现、必然产出正确 ABI 的打包流程。完整打包约 2 小时且可能带 137；好包是偶然。

---

## 二、已实证证据（不用再验证，可直接引用）

### 候选安装包（用户已确认：23:57 那个是好包）

| 项 | 好包 | 坏包 |
|---|---|---|
| 路径 | `apps/desktop/out/make/nsis/x64/CindyBeta Setup 0.0.0.exe` | `apps/desktop/release/artifacts/cn/beta/unversioned/win32-x64/cindy-beta-unversioned-Setup.exe` |
| 大小 | 241,198,164 B | 241,196,813 B |
| mtime | 2026/08/19 23:57:27 | 2026/08/19 23:49:51 |
| 包内 sqlite | **ABI 145**（1,920,512 B，mtime 23:57:24） | **ABI 137**（1,919,488 B，mtime 23:49:48） |
| 包内 pty.node（win32-x64） | 303,104 B（23:57:24） | 303,104 B（23:49:48） |

- pty.node 两包一致、无 ABI 问题（安装失败的报错只在 better-sqlite3）。node-pty 的 build/Release 下有 `.forge-meta` = `x64--145`，`@electron/rebuild` 见到 meta 相等会**跳过重编**，所以 pty 一直是预置的 145。
- 已解包验证目录（保留中）：`E:\Workshop\cindy\.tmp-verify-goodpkg\app64\resources\app.asar.unpacked\...` 与 `.tmp-verify-badpkg\app64\...`，可直接复核。

### 源文件 ABI 现状（关键！）

| 路径 | ABI / 大小 | mtime | 说明 |
|---|---|---|---|
| `E:\Workshop\cindy\node_modules\better-sqlite3\build\Release\better_sqlite3.node` | **137** / 1,919,488 B | 2026/06/16 01:17:50 | root node_modules 是 Node ABI（pnpm install 默认）|
| `apps/desktop/out/CindyBeta-win32-x64/resources/app.asar.unpacked/.../better_sqlite3.node` | **145** / 1,920,512 B | 2026/06/16 01:24:40 | 当前 packaged 目录=145，是从缓存拷的，**非重编** |
| `node_modules\.xdt-electron-native\electron-41.10.3-win32-x64-better-sqlite3-12.11.1\node_modules\better-sqlite3\build\Release\better_sqlite3.node` | **145** / 1,920,512 B | 2026/06/16 01:24:40 | 145 源缓存（历史上某次 electron-rebuild 的产物）|

### 打包机制（源码级已确认）

- `apps/desktop/forge.config.ts`：
  - L453 `bundleNativeDeps`：把 **root node_modules** 的 better-sqlite3 等**物理拷进** packaged（root 是 137，cpSync 不保留 mtime → 拷入后 mtime=拷贝时刻）。
  - L489-540 `rebuildNativeDepsInPackage`：`electronRebuild({ buildPath, electronVersion, arch, force: false, onlyModules: ['better-sqlite3','node-pty'] })`。
    - **L501 `force: false` 是【本地临时改动，勿提交】。** 注释写明「打完包还原 force:true」。原因：沙箱内 MSBuild FileTracker 挂起，才配合预置 `.forge-meta` 跳过重编。
  - L1399-1476 MakerNSIS `getAppBuilderConfig`：返回 win.sign / appId / productName / nsis 等，**没有设 `npmRebuild: false`**。
  - L1634-1648 afterCopy hook；L1650 `rebuildConfig: {}`。
- `app-builder-lib`（`out/packager.js`）：`prepackaged != null`（forge-maker-nsis 总是传 `prepackaged: appDir`）或 `!framework.isNpmRebuildRequired` 时 `installAppDependencies` 直接 return，**不会二次 rebuild**；`config.npmRebuild === false` 也会跳过。
- 打包日志：`E:\Workshop\cindy\release-package-cn-beta.log`（23:49 那次，rebuild 日志显示 `rebuild ok: ...tmp-whg7sE...`，但包内仍是 137）。

---

## 三、根因链（推断 + 唯一待验证点）

1. `bundleNativeDeps` 把 **root 的 137** 拷进 packaged（坏包 sqlite mtime 23:49:48，与 NSIS 产出 23:49:51 仅差 3 秒，最可能是拷贝时刻；cpSync 不保留源 mtime）。
2. afterCopy `rebuildNativeDepsInPackage`（force:false）**没有把 137 替换成 145**——日志虽打印 `rebuild ok`，但坏包内文件没变。
   - 为什么 force:false + 无 `.forge-meta` 的 better-sqlite3 没被重编：未最终实证（electron-packager 临时目录 `C:\Users\kepler\AppData\Local\Temp\electron-packager` 已被清空，无法事后取证）。
   - 可能：rebuild 判定跳过 / node-gyp 实际用错 Node 版本 / 挂起后失败被吞。**建议下一个 Agent 用一次完整打包复现时打详细日志定位**（不必等 2 小时：可以先在干净临时目录手动调 `electronRebuild({buildPath, electronVersion:'41.10.3', force:true, onlyModules:['better-sqlite3']})` 复现是否产出 145）。
3. **好包（23:57）**：packaged 目录当时已是 145（06/16 缓存拷贝，未重编）→ NSIS 直接打 145 → 好。
4. 一句话：**好与坏取决于 packaged 目录里恰好是 145 还是 137，而流程本身不保证这一点。**

---

## 四、环境特殊性（这台机器打包必须知道，否则白跑）

- 打包命令：`pnpm release:package --beta --region cn --no-sign --skip-smoke`（cwd=`E:\Workshop\cindy\apps\desktop`；脚本 `apps/desktop/scripts/package-desktop.mjs` 里 `runForgeMake` → `npx electron-forge make`）。
- 已封装好的环境修复脚本：`C:\Users\kepler\AppData\Local\Temp\package-cn-beta.ps1`，要点：
  - 沙箱/工具进程**系统环境变量大量缺失**（PATH 无 System32/node/git、ComSpec 空等）→ 用 `cmd /c "call ...\vcvars64.bat && set"` 提取环境；
  - 手动补 `TMP/TEMP/ProgramData/ALLUSERSPROFILE/CommonProgramFiles*/SystemDrive/SystemRoot`；
  - 手动补 Windows SDK Include/Lib（`C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\{ucrt,shared,um,winrt}` 与 `Lib\10.0.26100.0\{ucrt\x64,um\x64}`）；
  - 设 `ComSpec`、`PYTHON` 指向 Python312。
- **MSBuild FileTracker 挂起**是之前把 `force:false` 引入的诱因；此路不通就**不要回退到「裸完整打包」**，统一流程必须显式处理 rebuild 可靠性（见方案）。
- 完整打包约 **2 小时**；仅 NSIS 阶段几分钟（好包就是这么来的）。
- 工具链 PATH（沙箱内要显式加）：node=`C:\Program Files\nodejs\node.exe`、git=`C:\Program Files\Git\cmd\git.exe`、pnpm=`C:\Users\kepler\AppData\Roaming\npm\pnpm.cmd`、7z=`C:\Program Files\7-Zip\7z.exe`、cmd=`C:\WINDOWS\system32\cmd.exe`。

---

## 五、当前代码/工作区状态与红线

- `apps/desktop/forge.config.ts`：**只有 L501 `force:false` 一行本地改动**（diff：`force: true` → `force: false` + 注释）。**提交前必须还原 `force:true`**。
- 工作区另有改动（**区分用户改动 vs 临时调查文件**）：
  - `apps/desktop/src/main/localDb/schema.ts`、`apps/desktop/drizzle/meta/_journal.json`、untracked `apps/desktop/drizzle/0092_*.sql/json/ts`、`docs/dsh-cindy-plugin-channel.md` 等 —— 疑似用户/其它任务的改动，**不要动**。
  - untracked 探针/临时文件：`.tmp-*`、`_abi_probe.cjs`、`_abi_sweep.cjs`、`_probe2.cjs`、`_pty_probe.cjs`、`.tmp-verify-goodpkg/`、`.tmp-verify-badpkg/`、`find-sqlite.ps1`、`-boot-probe.js`、`.tmp-dlopen-check.js`、`.tmp-abi-check.js`、`.tmp-rebuild-repro.mjs`、`$dest/`、`%SystemDrive%/`、`.tmp/cindy-beta-*.png` —— 都是本次调查产物，**删除前先向用户确认**。
- 红线（仓库规则）：只动 desktop/mobile 及共享包；不覆盖用户改动；删除/推送前先确认；DCO 签名；提交前跑 `pnpm test:unit:related` + 相关包 typecheck。

---

## 六、统一打包流程方案（建议，待落地）

**目标（验收标准）**：
1. 无论 root node_modules 里 better-sqlite3 是 137 还是 145，**包内必须是 145**；
2. 打包**可复现**、时间可控（不该被迫 2 小时）；
3. 产物带 ABI 校验，137 混入直接 fail closed，而不是发出去坏包。

**方案要点（按优先级）**：
1. **还原 `force: true`**（forge.config.ts L501，必须）。
2. **MakerNSIS `getAppBuilderConfig` 返回对象加 `npmRebuild: false`**（双保险：即使 `prepackaged` 跳过逻辑未来变化，也不让 app-builder 在打包机环境里做不可控的 rebuild）。
3. **afterCopy rebuild 后加 ABI 硬校验**（核心防线）：读取 packaged 内 `better_sqlite3.node`（和 `node-pty/build/Release/pty.node`）的 `NODE_MODULE_VERSION`，**非 145 直接抛错终止打包**。判定方法见第七节。这样 137 永远不会再进安装包。
4. **可选：bundleNativeDeps 对 better-sqlite3 改从 145 缓存拷贝**（`node_modules\.xdt-electron-native\electron-41.10.3-win32-x64-better-sqlite3-12.11.1\...`），而不是从 root 137 拷，从源头消灭 137；但注意该缓存路径是机器专属，正式方案应改成「用 electronRebuild 产出 + ABI 校验兜底」。
5. **快速复打验证路径**：从当前已是 145 的 packaged 目录（`apps/desktop/out/CindyBeta-win32-x64`）只重跑 NSIS make（跳过完整 2h）→ 7z 解包 → ABI 探针验证 145 → 安装 smoke（启动、数据库初始化）。
6. **把统一流程写进正式文档**（本文件 + `DSH-打包接手文档.md` 第四节/第五节补充新结论），并把环境修复脚本从 Temp 挪进仓库可执行的位置（如 `apps/desktop/scripts/`），让流程可复现。

---

## 七、ABI 判定与验证方法（现成可用）

- **探针脚本** `E:\Workshop\cindy\.tmp-abi-probe.cjs`：
  ```js
  const p = process.argv[2];
  try { require(p); console.log('LOAD_OK ABI137'); } catch (e) { console.log('LOAD_FAIL ABI145:', e.code || e.message); }
  ```
  用系统 Node 24 跑：`LOAD_OK`=137（Node 能加载），`LOAD_FAIL`=145（Electron 专属 ABI，Node 加载失败）。
- **文件大小参考（不权威，仅快速区分）**：145=1,920,512 B；137=1,919,488 B。
- **7z 解包 NSIS**：
  ```
  & 'C:\Program Files\7-Zip\7z.exe' e 'CindyBeta Setup 0.0.0.exe' '$PLUGINSDIR\app-64.7z'   # 单引号防 PS 展开
  & 'C:\Program Files\7-Zip\7z.exe' e 'app-64.7z' "-o$dest"                                   # -o 整体引号
  ```
  解出的 sqlite 在 `resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node`。
- **ABI 基准**：系统 Node 24 = ABI 137；Electron 41.10.3 = ABI 145。

---

## 八、下一步清单（建议顺序）

1. 读本文件 + `DSH-打包接手文档.md`（原 DSH 修复上下文）。
2. 复现一次「完整打包」（或干净临时目录单模块 electronRebuild 复现），**确认 137 是哪个环节写入**；若复现成本太高，直接按第六节方案落地。
3. 落地统一流程改动：还原 force:true、加 npmRebuild:false、加 ABI 硬校验。
4. 快速复打 + 7z 解包验 ABI=145 + 安装 smoke（启动、本地数据库初始化、DSH 控制台）。
5. 更新正式打包文档，把环境脚本纳入仓库。

---

## 十、落地结果（2026-08-20 第二轮 Agent 完成）

### 代码改动（apps/desktop，分支 dsh-integration）

1. **还原 `force: true`**（`forge.config.ts` `rebuildNativeDepsInPackage`），并加红线注释：任何「跳过重编」的捷径都不得进入提交。
2. **MakerNSIS `getAppBuilderConfig` 加 `npmRebuild: false`**：app-builder 只许打包、不许重编；原生重编唯一入口 = afterCopy 的 rebuild + ABI 校验。
3. **新增 ABI 硬校验模块 `apps/desktop/forge-native-abi-check.ts`**（fail closed）：rebuild 后用打包同一套 Electron 的加载器（`ELECTRON_RUN_AS_NODE=1` + `process.dlopen`）实测每个 .node；失败即抛错终止打包。错误文本自带 `NODE_MODULE_VERSION <实际>…requires <期望>` 两个数字。单测 6 例（`src/main/__tests__/forgeNativeAbiCheck.test.ts`，mock spawnSync）。
4. **node-pty 检查改为平台/版本感知**（重要新发现）：
   - root node-pty 已升级到 **1.2.0-beta.15**（packaged 里还是 1.1.0）。win32 上 1.2.x 的 binding.gyp **不再编译 pty.node**（conpty-only，主 addon 是 `conpty.node`）——旧的「必须存在 pty.node」检查会在新依赖树上误杀打包。现改为：win32 必需 `conpty.node`，其它平台必需 `pty.node`；并对 `build/Release` 下**凡存在的 .node** 逐个验 ABI，不按版本猜文件名。
   - 1.1.x 运行时同时加载 conpty.node（主）与 pty.node（winpty 兜底），1.2.x 只加载 conpty.node——逐个验覆盖两种版本。
5. **Windows 加载器坑（已实证）**：`uv_dlopen` 加载带依赖 DLL 的 addon（pty.node → winpty.dll）时，路径含正斜杠会报 126「The specified module could not be found」（dependent search path 对 `/` 不生效）；校验前统一 `path.win32.normalize`，避免把路径分隔符问题误判成 ABI 问题。
6. **环境脚本入仓** `apps/desktop/scripts/package-windows-env.ps1`（vcvars 提取 + 系统变量 + SDK Include/Lib + 工具链 PATH + `TrackFileAccess=false` 的 FileTracker 挂起修复，然后跑 `pnpm release:package`；本机专属路径集中在脚本顶部变量区）。

### 实证记录（本机，2026-08-20）

- **独立重编复现**：干净临时目录（root 137 better-sqlite3 + node-pty 1.2.0-beta.15 拷贝）跑 `electronRebuild({force:true, onlyModules:['better-sqlite3','node-pty']})` → 18.4s 完成：better-sqlite3 走 prebuild-install 落 **1,920,512 B（145）**；node-pty 走 node-gyp 从源码重编出 conpty.node + conpty_console_list.node（**win32 1.2.x 无 pty.node 属正常**）。结论：force:true 下 rebuild 真实生效，与 23:49 坏包「日志 ok 但没重编」不同；`TrackFileAccess=false` 下未再出现 MSBuild 挂起。
- **ABI 校验模块真机验证**（tsx 驱动）：root 137 → 精确拒绝（报 137 vs 145）；重编产物 145 → 通过；现有 packaged 目录 145 → 通过。
- **快速复打（NSIS-only）**：`electron-forge make --skip-package` 从现有 145 packaged 目录重打 Setup.exe（好包已备份 `.tmp-verify-repack/good-package-backup.exe`）。7z 解包后逐文件 SHA-256 对比：新包 app.asar / better_sqlite3.node / pty.node 与用户确认的好包**字节级一致**；包内 4 个 .node 全部 145。
- **smoke（解包产物直跑，不动已装版本）**：`smoke-packaged.mjs --expect-passive-empty` → ✅ 通过（MIGRATE_FAILED / schema-version-behind 的结构化拒绝出现，说明 better-sqlite3 已成功加载并读到 schema_version——137 会在这一步之前就 DB INIT FAILED 崩掉）。
- typecheck（desktop 包）通过；ABI 校验模块 6/6 单测通过。

### 尚未做（留给下一轮/用户）

- **完整 2 小时流水线**（`pnpm release:package --beta --region cn --no-sign --skip-smoke`，经 `scripts/package-windows-env.ps1`）未重跑——它会在开始时清掉现有 145 packaged 目录（cleanOutDir），且耗时约 2h。force:true + TrackFileAccess=false 组合已由独立重编验证，但 forge 进程内完整链路尚未复跑。**建议在合适的窗口真机跑一次**，跑完用第七节探针验产物 ABI=145 再分发。
- **安装 smoke**（覆盖安装到 `C:\Users\kepler\AppData\Local\Programs\CindyBeta`）未做——用户机器上 Cindy 正在运行，覆盖安装会打断使用；解包产物直跑 smoke 已通过，且新包与用户确认的好包字节级一致。
- 临时验证目录 `.tmp-abi-rebuild\`、`.tmp-verify-repack\`（含好包备份与新包解包）保留备查，删除前请与用户确认。

---

## 十一、统一打包流程（最终版，按此执行）

1. 环境：`powershell -File apps/desktop/scripts/package-windows-env.ps1`（或人工等价环境：vcvars + 系统变量 + SDK + TrackFileAccess=false）。
2. 打包：`pnpm release:package --beta --region cn --no-sign --skip-smoke`（cwd=仓库根；脚本自动在 `apps/desktop` 内跑 forge make）。
3. 流程保证（代码强制，不靠人工）：
   - bundleNativeDeps 拷贝 root 依赖 → afterCopy `electronRebuild(force:true)` 强制重编 → **ABI 硬校验 fail closed**（非 Electron ABI 直接终止打包）→ MakerNSIS `npmRebuild:false` 只打包不重编。
4. 产物验证（每次分发前）：第七节 7z 解包 + 探针验 `better_sqlite3.node` 与 node-pty 的 `.node` 全部 145；跑 `smoke-packaged.mjs`（beta 用 `--expect-passive-empty`）。
5. 快速复打（仅当 packaged 目录已验证为 145 且无需重编时）：`pnpm --filter desktop exec npx electron-forge make --skip-package --platform=win32 --arch=x64`（env 需 CINDY_AUTH_REGION=cn、CINDY_DESKTOP_VARIANT=beta）。**这只重打 NSIS 层，不经过 ABI 校验，仅限已知-good 的 packaged 目录。**

---

## 九、关键路径速查

| 项 | 路径 |
|---|---|
| 好包 | `E:\Workshop\cindy\apps\desktop\out\make\nsis\x64\CindyBeta Setup 0.0.0.exe` |
| 坏包 | `E:\Workshop\cindy\apps\desktop\release\artifacts\cn\beta\unversioned\win32-x64\cindy-beta-unversioned-Setup.exe` |
| 已解包好/坏包 | `E:\Workshop\cindy\.tmp-verify-goodpkg\app64\...` / `.tmp-verify-badpkg\app64\...` |
| 打包日志 | `E:\Workshop\cindy\release-package-cn-beta.log` |
| 打包配置 | `apps/desktop/forge.config.ts`（L453 bundleNativeDeps / L486-588 rebuild(force:true)+ABI 硬校验 / MakerNSIS npmRebuild:false / afterCopy）；ABI 校验模块 `forge-native-abi-check.ts` |
| 打包脚本 | `apps/desktop/scripts/package-desktop.mjs`；环境自愈版 `apps/desktop/scripts/package-windows-env.ps1`（原 Temp 的 package-cn-beta.ps1 已迁移入仓）|
| root sqlite（137） | `E:\Workshop\cindy\node_modules\better-sqlite3\build\Release\better_sqlite3.node` |
| packaged sqlite（145） | `E:\Workshop\cindy\apps\desktop\out\CindyBeta-win32-x64\resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node` |
| 145 源缓存 | `E:\Workshop\cindy\node_modules\.xdt-electron-native\electron-41.10.3-win32-x64-better-sqlite3-12.11.1\node_modules\better-sqlite3\build\Release\better_sqlite3.node` |
| 原接手文档 | `E:\Workshop\cindy\DSH-打包接手文档.md` |
