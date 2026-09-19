# 공동 사건 조사 보드 · 3인 Supabase Realtime

기존 조사 보드 기능을 유지하면서 3명의 플레이어가 서로 다른 ID로 접속하고, 같은 보드를 실시간으로 조작하도록 구성한 버전입니다.

## 접속 계정

| 플레이어 | ID | 비밀번호 |
| --- | --- | --- |
| HO1 | `HO1` | `1234` |
| HO2 | `HO2` | `0000` |
| SYSTEAM | `SYSTEAM` | `4321` |

세 계정은 모두 일반 참여자입니다. 각자 자료를 추가하고 자신의 자료를 수정/삭제할 수 있으며, 다른 참여자의 자료는 기존 규칙대로 이동할 수 있습니다.

## 실시간 동기화

- 보드 상태는 Supabase의 `investigation_boards`에 저장됩니다.
- 저장이 끝나면 Supabase Realtime Broadcast의 `board_changed` 이벤트가 전송됩니다.
- 다른 플레이어는 이벤트를 받는 즉시 서버의 최신 보드를 다시 읽어 화면에 반영합니다.
- 동시에 수정된 항목은 원래 프로젝트의 `updatedAt` 병합 규칙을 그대로 사용합니다.
- 첨부 이미지는 Supabase Storage의 `investigation-board-files` 버킷을 사용합니다.

## 처음 한 번 Supabase 적용

새 Supabase 프로젝트를 만든 뒤 `js/config.js`의 `YOUR_PROJECT_REF`와 `YOUR_PUBLISHABLE_KEY`를 새 프로젝트 값으로 교체합니다.

1. Supabase Dashboard → SQL Editor에서 `supabase/schema.sql` 전체를 실행합니다.
2. `deploy-supabase-function.bat`을 실행합니다. 이 파일이 Supabase 로그인 → 프로젝트 연결 → 세 비밀번호를 Edge Function Secret으로 등록 → 함수 배포까지 순서대로 진행합니다.

직접 명령어로 할 경우 아래와 같습니다.

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase secrets set PLAYER1_PASSWORD=1234 PLAYER2_PASSWORD=0000 PLAYER3_PASSWORD=4321
npx supabase functions deploy clever-api --no-verify-jwt
```

3. `start-server.bat`을 실행합니다.
4. 서로 다른 브라우저/PC에서 `HO1`, `HO2`, `SYSTEAM`으로 각각 로그인해 확인합니다.

## 새 보드

이 버전은 `three-player-investigation-board-v1`이라는 새 board ID를 사용하므로 기존 사건 보드 내용과 섞이지 않습니다. 기존 Supabase 보드는 삭제하지 않습니다.

정말 이 3인 보드의 내용까지 다시 완전히 비우고 싶을 때만 SQL Editor에서 `supabase/reset-board.sql`을 실행합니다.

## 비밀번호 변경 위치

비밀번호 값은 브라우저 코드에 넣지 않고 Supabase Edge Function Secret에 저장합니다. 변경할 때는 `supabase secrets set`으로 새 값을 저장한 뒤 Edge Function을 다시 배포합니다.
