(() => {
  "use strict";

  const CONFIG = window.INVESTIGATION_BOARD_CONFIG || {};
  const SB = CONFIG.supabase || {};
  const TOKEN_KEY = "investigation-board-supabase-session-three-player-v1";
  let client = null;
  let realtimeChannel = null;

  function enabled() {
    return CONFIG.mode === "supabase" && SB.enabled === true;
  }

  function getClient() {
    if (!enabled()) return null;
    if (client) return client;
    if (!window.supabase?.createClient)
      throw new Error("Supabase JavaScript 라이브러리를 불러오지 못했습니다.");
    if (
      !SB.url ||
      !SB.publishableKey ||
      SB.url.includes("YOUR_PROJECT_REF") ||
      SB.publishableKey.includes("YOUR_")
    ) {
      throw new Error(
        "js/config.js에 Supabase URL과 Publishable Key를 입력해 주세요.",
      );
    }
    client = window.supabase.createClient(SB.url, SB.publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    return client;
  }

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  function setToken(token) {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  }

  function hasSession() {
    return Boolean(getToken());
  }

  function clearSession() {
    setToken("");
  }

  async function call(action, payload = {}, { includeSession = true } = {}) {
    if (!enabled())
      throw new Error("Supabase 모드가 활성화되어 있지 않습니다.");
    getClient();
    const endpoint = `${SB.url.replace(/\/$/, "")}/functions/v1/${SB.edgeFunctionName || "investigation-api"}`;
    const body = {
      action,
      boardId: CONFIG.boardId || "main-investigation-board",
      ...payload,
    };
    if (includeSession) body.sessionToken = getToken();

    let response;
    try {
      // Edge Function은 verify_jwt=false이고 자체 세션 검증을 사용합니다.
      // text/plain은 브라우저의 CORS 사전요청(OPTIONS)을 피하는 simple request라
      // 로컬 미리보기/정적 호스팅에서도 안정적으로 호출됩니다.
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const networkError = new Error(
        `Supabase 함수에 연결하지 못했습니다. 함수 주소: ${endpoint}`,
      );
      networkError.cause = error;
      throw networkError;
    }

    let data = null;
    try {
      data = await response.json();
    } catch {}
    if (!response.ok || data?.ok === false) {
      const error = new Error(
        data?.error || `Supabase API 오류 (${response.status})`,
      );
      error.status = response.status;
      throw error;
    }
    return data?.data ?? data;
  }

  async function login(accountId, accessCode) {
    const result = await call(
      "login",
      { accountId, accessCode },
      { includeSession: false },
    );
    if (!result?.sessionToken || !result?.account)
      throw new Error("로그인 응답이 올바르지 않습니다.");
    setToken(result.sessionToken);
    return {
      accountId: result.account.id,
      displayName: result.account.displayName,
      role: result.account.role,
      blocked: Boolean(result.account.blocked),
    };
  }

  async function restoreSession() {
    if (!getToken()) return null;
    try {
      const result = await call("verify_session");
      return {
        accountId: result.account.id,
        displayName: result.account.displayName,
        role: result.account.role,
        blocked: Boolean(result.account.blocked),
      };
    } catch (error) {
      clearSession();
      return null;
    }
  }

  async function verifySession() {
    const result = await call("verify_session");
    return {
      accountId: result.account.id,
      displayName: result.account.displayName,
      role: result.account.role,
      blocked: Boolean(result.account.blocked),
    };
  }

  async function logout() {
    if (getToken()) {
      try {
        await call("logout");
      } catch {}
    }
    clearSession();
  }

  async function loadBoard() {
    const result = await call("load_board");
    return result?.state || result || null;
  }

  async function saveBoard(state) {
    return await call("save_board", { state });
  }

  async function listAccounts() {
    const result = await call("list_accounts");
    return Array.isArray(result?.accounts)
      ? result.accounts
      : Array.isArray(result)
        ? result
        : [];
  }

  async function setPassword(accountId, password) {
    return await call("set_password", { accountId, password });
  }

  async function setBlocked(accountId, blocked) {
    return await call("set_blocked", { accountId, blocked: Boolean(blocked) });
  }

  async function uploadFile(file) {
    const sb = getClient();
    const signed = await call("create_upload_url", {
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
    });
    if (!signed?.path || !signed?.token)
      throw new Error("업로드 URL을 만들지 못했습니다.");

    const { error } = await sb.storage
      .from(SB.storageBucket || "investigation-board-files")
      .uploadToSignedUrl(signed.path, signed.token, file, {
        contentType: file.type || "application/octet-stream",
      });
    if (error) throw error;
    return { path: signed.path };
  }

  async function getFileUrl(path, { download = false } = {}) {
    if (!path) return "";
    const result = await call("create_download_url", {
      path,
      download: Boolean(download),
    });
    return result?.signedUrl || result?.signedURL || "";
  }

  function subscribe({ onBoardChanged, onAccountsChanged } = {}) {
    if (!enabled()) return null;
    const sb = getClient();
    if (realtimeChannel) return realtimeChannel;
    const topic = `${SB.realtimeTopicPrefix || "investigation-board"}:${CONFIG.boardId || "main-investigation-board"}`;
    realtimeChannel = sb.channel(topic, {
      config: { broadcast: { self: false } },
    });
    realtimeChannel
      .on("broadcast", { event: "board_changed" }, (payload) =>
        onBoardChanged?.(payload),
      )
      .on("broadcast", { event: "accounts_changed" }, (payload) =>
        onAccountsChanged?.(payload),
      )
      .subscribe();
    return realtimeChannel;
  }

  async function broadcast(event, payload = {}) {
    if (!enabled()) return;
    const channel = realtimeChannel || subscribe({});
    if (!channel) return;
    try {
      await channel.send({ type: "broadcast", event, payload });
    } catch {}
  }

  window.InvestigationSupabaseApi = {
    enabled,
    hasSession,
    clearSession,
    login,
    restoreSession,
    verifySession,
    logout,
    loadBoard,
    saveBoard,
    listAccounts,
    setPassword,
    setBlocked,
    uploadFile,
    getFileUrl,
    subscribe,
    broadcast,
  };
})();
