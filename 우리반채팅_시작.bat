@echo off
chcp 65001 >nul
title 우리반 채팅 서버
cd /d "%~dp0"

rem 이미 3000번 포트에서 서버가 돌고 있으면 중복 실행하지 않고 브라우저만 연다.
netstat -ano | findstr ":3000" | findstr LISTENING >nul 2>&1
if %errorlevel%==0 (
  echo ==============================================
  echo  서버가 이미 실행 중입니다. 브라우저를 엽니다...
  echo ==============================================
  start http://localhost:3000
  timeout /t 3 >nul
  exit /b
)

echo ==============================================
echo  우리반 채팅 서버를 시작합니다...
echo  (이 검은 창을 끄면 사이트도 꺼집니다. 수업 중엔 열어두세요)
echo ==============================================
echo.

rem 서버가 켜질 시간을 준 뒤 브라우저를 자동으로 연다.
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"

node server.js

echo.
echo 서버가 종료되었습니다. 아무 키나 누르면 창이 닫힙니다.
pause >nul
