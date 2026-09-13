@echo off
chcp 65001 >nul
title 双子代理转子 · Gemini Proxy Rotator
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   双子代理转子 · Gemini Proxy Rotator    ║
echo  ║           正在一键启动代理...            ║
echo  ╚══════════════════════════════════════════╝
echo.

:: 检查 51200 端口是否已被占用
netstat -ano | findstr :51200 | findstr LISTENING >nul
if %errorlevel% equ 0 (
    echo [!] 检测到代理服务已经在运行中！
    echo [*] 正在为您打开浏览器仪表盘：http://localhost:51200
    start http://localhost:51200
    timeout /t 3 >nul
    exit /b 0
)

echo [*] 正在启动转子服务并自动打开仪表盘...
start "" http://localhost:51200
tuxevil-rotator start
