# package-windows-env.ps1 — Windows 打包环境自愈 + 统一打包入口
#
# 背景（DSH-打包流程统一，2026-08-20）：在受限 shell（Agent 沙箱、精简 CI 容器等）
# 里跑 `pnpm release:package` 时，系统环境变量大量缺失/损坏（PATH 无 System32/node/
# git、ComSpec 空、ProgramData 空、CommonProgramFiles 损坏），导致 node-gyp 找不到
# Python/VS、MSBuild FileTracker 挂起（0 CPU 假死）、cargo 找不到 windows.h 等连环失败。
# 本脚本在启动打包前把环境补齐到「人类在本机 cmd 里跑打包」的等价状态：
#
#   1. 从 vcvars64.bat 提取完整 VS 2022 工具链环境（VCINSTALLDIR / VSCMD_VER 等）——
#      这是绕过本机 VS Setup COM 注册缺失、让 node-gyp 走 findVSFromSpecifiedLocation
#      的唯一途径；
#   2. 补齐被清空的系统变量（TMP/TEMP/ProgramData/ALLUSERSPROFILE/CommonProgramFiles*/
#      SystemDrive/SystemRoot/ComSpec）；
#   3. 手动追加 Windows SDK Include/Lib（本机 SDK 注册缺失，vcvars 不会自动加）；
#   4. 补工具链 PATH（node/git/pnpm/python/cmd）与 PYTHON；
#   5. TrackFileAccess=false：禁用 MSBuild FileTracker——受限 shell 里它的「挂起创建
#      子进程 + 注入 tracker DLL」机制失效，cl.exe 被创建成挂起状态后无人唤醒（0 CPU
#      假死）。一次性发布构建不需要增量跟踪。
#
# 用法（在任意位置）：
#   powershell -File apps/desktop/scripts/package-windows-env.ps1
#   # 等价于在仓库根跑: pnpm release:package --beta --region cn --no-sign --skip-smoke
#   powershell -File apps/desktop/scripts/package-windows-env.ps1 -PackArgs @('--beta','--region','global','--no-sign','--skip-smoke')
#
# 本机专属路径在下方变量区集中声明；换打包机时只需改这里。日志默认写到
# <仓库根>/release-package-windows.log。
#
# 原生模块 ABI 保证：统一流程要求 forge.config.ts 里 afterCopy 的
# rebuildNativeDepsInPackage 保持 force:true（强制 electronRebuild），并在 rebuild 后
# 用打包同一套 Electron 的加载器对 better-sqlite3 / node-pty 的 .node 做 ABI 硬校验
# （forge-native-abi-check.ts，fail closed）。本脚本不绕过、不回退该流程——若完整打包
# 需要 2 小时，这是「统一流程 + fail closed」的代价，不要用「只跑 NSIS」替代正式产物。

[CmdletBinding()]
param(
  # 传给 `pnpm release:package` 的参数；见 scripts/package-desktop.mjs 头注释。
  [string[]]$PackArgs = @('--beta', '--region', 'cn', '--no-sign', '--skip-smoke'),
  # 日志文件；默认 <仓库根>/release-package-windows.log。
  [string]$LogPath = ''
)

$ErrorActionPreference = 'Continue'

# ── 本机工具链路径（换机器改这里）───────────────────────────────────────────
$NodeDir    = 'C:\Program Files\nodejs'
$GitCmdDir  = 'C:\Program Files\Git\cmd'
$PnpmCmd    = 'C:\Users\kepler\AppData\Roaming\npm\pnpm.cmd'
$PythonDir  = 'C:\Users\kepler\AppData\Local\Programs\Python\Python312'
$VcVarsBat  = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$WinSdkRoot = 'C:\Program Files (x86)\Windows Kits\10'
$WinSdkVer  = '10.0.26100.0'
$UserProfileFallback = 'C:\Users\kepler'
# ─────────────────────────────────────────────────────────────────────────────

$WorkspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$userProfile = if ($env:USERPROFILE) { $env:USERPROFILE } else { $UserProfileFallback }

# 1. vcvars64 全量环境（绕过本机 VS Setup COM 注册缺失）。
if (-not (Test-Path $VcVarsBat)) {
  throw "vcvars64.bat not found at $VcVarsBat — 请先安装 VS 2022 BuildTools 并修正本脚本路径变量。"
}
$envDump = & "C:\WINDOWS\system32\cmd.exe" /c "call `"$VcVarsBat`" >nul 2>&1 && set" 2>&1
if ($LASTEXITCODE -ne 0 -or -not $envDump) {
  throw "vcvars64.bat 提取环境失败（ComSpec/PATH 缺失？请确认 SystemRoot 可用）。"
}
foreach ($line in $envDump) {
  if ($line -match '^([^=]+)=(.*)$') {
    try { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } catch {}
  }
}

# 2. 补齐受限 shell 缺失的系统变量（MSBuild FileTracker / node-gyp 依赖这些）。
$env:TMP    = Join-Path $userProfile 'AppData\Local\Temp'
$env:TEMP   = $env:TMP
$env:ProgramData          = 'C:\ProgramData'
$env:ALLUSERSPROFILE      = 'C:\ProgramData'
$env:CommonProgramFiles   = 'C:\Program Files\Common Files'
[Environment]::SetEnvironmentVariable('CommonProgramFiles(x86)', 'C:\Program Files (x86)\Common Files', 'Process')
$env:SystemDrive = 'C:'
$env:SystemRoot  = 'C:\WINDOWS'
$env:ComSpec     = 'C:\WINDOWS\system32\cmd.exe'
$env:ProgramFiles = 'C:\Program Files'
[Environment]::SetEnvironmentVariable('ProgramFiles(x86)', 'C:\Program Files (x86)', 'Process')
$env:PROCESSOR_ARCHITECTURE = 'AMD64'

# 3. Windows SDK Include/Lib（本机 SDK 注册缺失，vcvars 不会自动加；cargo/node-gyp 需要）。
$env:WindowsSDKVersion = "$WinSdkVer"
$env:INCLUDE = "$env:INCLUDE;$WinSdkRoot\Include\$WinSdkVer\ucrt;$WinSdkRoot\Include\$WinSdkVer\shared;$WinSdkRoot\Include\$WinSdkVer\um;$WinSdkRoot\Include\$WinSdkVer\winrt"
$env:LIB     = "$env:LIB;$WinSdkRoot\Lib\$WinSdkVer\ucrt\x64;$WinSdkRoot\Lib\$WinSdkVer\um\x64"
$env:LIBPATH = "$env:LIBPATH;$WinSdkRoot\UnionMetadata\$WinSdkVer;$WinSdkRoot\References\$WinSdkVer"

# 4. 工具链 PATH + Python。
$env:PATH = "C:\WINDOWS\system32;$NodeDir;$GitCmdDir;$PythonDir;$(Split-Path $PnpmCmd);$env:PATH"
$env:PYTHON = Join-Path $PythonDir 'python.exe'

# 5. 禁用 MSBuild FileTracker（受限 shell 下其挂起注入机制失效，0 CPU 假死）。
$env:TrackFileAccess = 'false'

Write-Host "=== env ready: VSCMD_VER=$env:VSCMD_VER WindowsSDKVersion=$env:WindowsSDKVersion ProgramData=$env:ProgramData INCLUDE=$([bool]$env:INCLUDE) ==="
Write-Host "=== cwd: $WorkspaceRoot ==="
Write-Host "=== pnpm release:package $($PackArgs -join ' ') ==="

if (-not $LogPath) { $LogPath = Join-Path $WorkspaceRoot 'release-package-windows.log' }

Push-Location $WorkspaceRoot
try {
  & $PnpmCmd release:package @PackArgs 2>&1 | Tee-Object -FilePath $LogPath
  Write-Host "package exit: $LASTEXITCODE"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
