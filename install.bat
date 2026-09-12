@echo off
chcp 65001 >nul
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   双子代理转子 · Gemini Proxy Rotator    ║
echo  ║         一键安装 / 自动补丁              ║
echo  ╚══════════════════════════════════════════╝
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org
    pause
    exit /b 1
)
echo [✓] Node.js 已安装

:: 检查 tuxevil-rotator
where tuxevil-rotator >nul 2>&1
if %errorlevel% neq 0 (
    echo [*] 正在安装 tuxevil-rotator...
    npm install -g tuxevil-rotator
    if %errorlevel% neq 0 (
        echo [错误] tuxevil-rotator 安装失败，请检查网络
        pause
        exit /b 1
    )
)
echo [✓] tuxevil-rotator 已就绪

:: 获取 npm global 路径
for /f "delims=" %%i in ('npm root -g') do set NPM_ROOT=%%i
echo [*] npm 全局路径：%NPM_ROOT%

:: 替换仪表盘 UI
echo [*] 正在替换极客仪表盘...
copy /Y "src\static\gemini-dashboard.html" "%NPM_ROOT%\tuxevil-rotator\src\static\gemini-dashboard.html" >nul
if %errorlevel% neq 0 (
    echo [错误] 仪表盘文件替换失败
    pause
    exit /b 1
)
echo [✓] 仪表盘替换完成

:: 替换 proxy 核心
echo [*] 正在替换双模型分流逻辑...
copy /Y "patches\proxy.ts" "%NPM_ROOT%\tuxevil-rotator\src\proxy.ts" >nul
if %errorlevel% neq 0 (
    echo [错误] proxy 文件替换失败
    pause
    exit /b 1
)
echo [✓] 双模型分流逻辑替换完成

echo.
echo  ════════════════════════════════════════
echo  ✅ 安装完成！运行以下命令启动代理：
echo.
echo     tuxevil-rotator start
echo.
echo  仪表盘地址：http://localhost:51200
echo  ════════════════════════════════════════
echo.
pause
