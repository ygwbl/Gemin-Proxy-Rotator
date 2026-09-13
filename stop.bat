@echo off
chcp 65001 >nul
title ֹͣ����ת��
echo [*] ����ֹͣ 51200 �˿ڵĴ���ת�ӽ���...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :51200 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo [OK] ����������ֹͣ��
timeout /t 2 >nul
