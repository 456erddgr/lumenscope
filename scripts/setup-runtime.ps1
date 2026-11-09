# LumenScope 运行时依赖准备脚本
# 由安装程序在装完后调用（后台静默），也可以手动右键「用 PowerShell 运行」。
# 作用：把虚拟摄像头功能需要的 Python 依赖装好；没有 Python 就装一个便携版。
# 全部失败也不影响主程序使用 —— 只是没有虚拟摄像头输出。

$ErrorActionPreference = 'SilentlyContinue'
$logDir = Join-Path $env:LOCALAPPDATA 'LumenScope'
$log = Join-Path $logDir 'setup.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Output $line
  Add-Content -Path $log -Value $line -Encoding UTF8
}

Log "===== LumenScope 运行时准备开始 ====="

# ---------- 1) 找 Python ----------
$pyExe = $null
$pyArgs = @()

$candidates = @(
  @{ exe = 'py';      args = @('-3.11') },
  @{ exe = 'py';      args = @('-3')    },
  @{ exe = 'python';  args = @()        },
  @{ exe = 'python3'; args = @()        }
)

foreach ($c in $candidates) {
  $cmd = Get-Command $c.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { continue }
  $ver = & $c.exe @($c.args + @('-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])')) 2>$null
  if ($LASTEXITCODE -eq 0 -and $ver -match '^\d+$') {
    $num = [int]$ver
    if ($num -ge 308) {
      $pyExe = $c.exe
      $pyArgs = $c.args
      Log "找到 Python: $($c.exe) $($c.args -join ' ') -> $num"
      break
    }
  }
}

# 没 Python 就下载官方便携版（约 11 MB，解到用户目录，不改系统环境）
if (-not $pyExe) {
  Log "系统里没有可用 Python，下载便携版…"
  $embedDir = Join-Path $env:LOCALAPPDATA 'LumenScope\python'
  $zip = Join-Path $env:TEMP 'lumen-python.zip'
  $urls = @(
    'https://npmmirror.com/mirrors/python/3.11.9/python-3.11.9-embed-amd64.zip',
    'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'
  )
  foreach ($u in $urls) {
    try {
      Log "下载 $u"
      Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 120
      if ((Test-Path $zip) -and (Get-Item $zip).Length -gt 5000000) { break }
    } catch { Log "下载失败: $($_.Exception.Message)" }
  }
  if ((Test-Path $zip) -and (Get-Item $zip).Length -gt 5000000) {
    New-Item -ItemType Directory -Force -Path $embedDir | Out-Null
    Expand-Archive -Path $zip -DestinationPath $embedDir -Force
    Remove-Item $zip -Force
    # embed 版默认不带 pip，且 _pth 关掉了 site-packages，这里都打开
    $pth = Get-ChildItem $embedDir -Filter 'python*._pth' | Select-Object -First 1
    if ($pth) {
      $content = Get-Content $pth.FullName
      $content = $content -replace '^#\s*import site', 'import site'
      if ($content -notmatch 'Lib\\site-packages') { $content += 'Lib\site-packages' }
      Set-Content -Path $pth.FullName -Value $content -Encoding ASCII
    }
    $getPip = Join-Path $embedDir 'get-pip.py'
    try {
      Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip -UseBasicParsing -TimeoutSec 60
      & (Join-Path $embedDir 'python.exe') $getPip --no-warn-script-location 2>&1 | Out-Null
    } catch { Log "get-pip 失败: $($_.Exception.Message)" }
    $pyExe = Join-Path $embedDir 'python.exe'
    $pyArgs = @()
    Log "便携版 Python 就绪: $pyExe"
  } else {
    Log "便携版下载失败，跳过虚拟摄像头依赖（主程序仍可用）"
    Log "===== 结束（未装虚拟摄像头依赖）====="
    exit 0
  }
}

# ---------- 2) 装 pyvirtualcam + numpy ----------
function TestDeps {
  # 用退出码判断，不看输出文本：
  # 便携版装在含中文的用户目录下，stdout 编码会让 -match 误判。
  $code = 'import pyvirtualcam, numpy'
  & $pyExe @($pyArgs + @('-c', $code)) *> $null
  return ($LASTEXITCODE -eq 0)
}

# 判据用"能不能 import"，不看 pip 退出码：
# pip 在"已是最新版本"时也可能返回非 0（还会因为 pip 自升级提示），退出码不可靠。
function TryInstall($indexUrl) {
  $args = @()
  $args += $pyArgs
  $args += @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'pyvirtualcam', 'numpy')
  if ($indexUrl) { $args += @('-i', $indexUrl) }
  Log "pip install (index=$(if ($indexUrl) { $indexUrl } else { 'default' }))…"
  & $pyExe @args 2>&1 | ForEach-Object { Log "  $_" }
  if (TestDeps) { return 0 } else { return 1 }
}

$ok = TestDeps
if ($ok) { Log "依赖本来就在，跳过安装" }
if (-not $ok) { if ((TryInstall $null) -eq 0) { $ok = $true } }
if (-not $ok) {
  Log "默认源失败，改用清华镜像重试"
  if ((TryInstall 'https://pypi.tuna.tsinghua.edu.cn/simple') -eq 0) { $ok = $true }
}

# ---------- 3) 校验 ----------
if ($ok) {
  if (TestDeps) {
    Log "虚拟摄像头依赖就绪"
    # 把解释器路径写进配置，主程序启动时直接读，省得每次探测
    Set-Content -Path (Join-Path $logDir 'python.txt') -Value ("{0} {1}" -f $pyExe, ($pyArgs -join ' ')).Trim() -Encoding UTF8
  } else {
    Log "依赖装了但仍然导入失败，请手动检查"
  }
} else {
  Log "依赖安装失败。虚拟摄像头功能不可用，其余功能正常。"
  Log "可稍后手动执行：$pyExe $($pyArgs -join ' ') -m pip install pyvirtualcam numpy"
}

Log "===== LumenScope 运行时准备结束 ====="
