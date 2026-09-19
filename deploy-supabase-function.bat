@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [0/6] Node 패키지 확인
if not exist node_modules (
  call npm install
  if errorlevel 1 goto :error
)

if not exist supabase\config.toml (
  echo [1/6] Supabase 로컬 설정 초기화
  call npx supabase init
  if errorlevel 1 goto :error
) else (
  echo [1/6] Supabase 로컬 설정 확인 완료
)

echo [2/6] Supabase 로그인
call npx supabase login
if errorlevel 1 goto :error

echo.
set /p PROJECT_REF=Supabase Project Ref를 입력하세요: 
if "%PROJECT_REF%"=="" goto :error

echo [3/6] 프로젝트 연결
call npx supabase link --project-ref %PROJECT_REF%
if errorlevel 1 goto :error

echo [4/6] 플레이어 비밀번호 Secret 설정
call npx supabase secrets set PLAYER1_PASSWORD=1234 PLAYER2_PASSWORD=0000 PLAYER3_PASSWORD=4321
if errorlevel 1 goto :error

echo [5/6] Edge Function 배포
call npx supabase functions deploy clever-api --no-verify-jwt
if errorlevel 1 goto :error

echo [6/6] 완료
call npx supabase secrets list

echo.
echo 계정: HO1 / 1234, HO2 / 0000, SYSTEAM / 4321
echo 배포가 완료되었습니다.
pause
exit /b 0

:error
echo.
echo 설정 중 오류가 발생했습니다. 위 오류 내용을 확인해 주세요.
pause
exit /b 1
