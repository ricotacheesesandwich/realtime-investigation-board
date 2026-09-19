-- 정말 보드를 다시 완전히 비울 때만 실행하세요.
update public.investigation_boards
set state = '{"version":3,"boardId":"three-player-investigation-board-v1","boardTitle":"공동 사건 조사 보드","items":[],"connections":[],"deletedItemIds":[],"deletedConnectionIds":[],"resetAt":null}'::jsonb,
    updated_at = now(),
    updated_by = null
where board_id = 'three-player-investigation-board-v1';

delete from public.investigation_sessions
where account_id in ('HO1', 'HO2', 'SYSTEAM');
