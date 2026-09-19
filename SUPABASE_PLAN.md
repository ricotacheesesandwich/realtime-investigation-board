# Supabase 연결 구조

브라우저는 Supabase Edge Function을 통해 로그인/보드 저장/파일 서명 URL을 처리합니다. 비밀번호는 브라우저 코드가 아니라 Edge Function에서 확인합니다.

실시간 동기화는 Supabase Realtime Broadcast를 사용합니다. 한 클라이언트가 저장을 완료하면 `board_changed`를 보내고, 나머지 클라이언트가 최신 보드 상태를 다시 불러옵니다.

현재 계정은 다음 세 개로 고정되어 있습니다.

- `HO1` / `1234`
- `HO2` / `0000`
- `SYSTEAM` / `4321`

보드 ID는 `three-player-investigation-board-v1`입니다.
