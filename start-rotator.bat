@echo off
chcp 65001 >nul
title Tuxevil Rotator
echo =======================================================
echo         Tuxevil Rotator - AI Proxy Gateway
echo =======================================================
echo [API Endpoint] : http://127.0.0.1:51200/v1
echo [Dashboard UI] : http://localhost:51200/dashboard?token=4a2d0d255b65ba679adc3f4d3c1ebd462d1bb3e5e8faf3d24eb4109be13b1259
echo =======================================================
cmd.exe /c tuxevil-rotator start
pause
