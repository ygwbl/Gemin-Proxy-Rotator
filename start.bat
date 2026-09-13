@echo off
chcp 65001 >nul
title ˫�Ӵ���ת�� �� Gemini Proxy Rotator
echo.
echo  ==============================================
echo     ˫�Ӵ���ת�� �� Gemini Proxy Rotator
echo             ����һ����������...
echo  ==============================================
echo.

:: ��� 51200 �˿��Ƿ��ѱ�ռ��
netstat -ano | findstr :51200 | findstr LISTENING >nul
if %errorlevel% equ 0 (
    echo [!] ��⵽���������Ѿ��������У�
    echo [*] ����Ϊ����������Ǳ��̣�http://localhost:51200
    start http://localhost:51200
    timeout /t 3 >nul
    exit /b 0
)

echo [*] ��������ת�ӷ����Զ����Ǳ���...
start http://localhost:51200
tuxevil-rotator start
