@echo off
chcp 65001 >nul
title 停止代理转子
echo [*] 正在停止 51200 端口的代理转子进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :51200 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo [✓] 代理服务已停止。
timeout /t 2 >nul
