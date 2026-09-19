import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bootstrap-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PASSWORD_PEPPER = Deno.env.get("PASSWORD_PEPPER") || "";
const BOOTSTRAP_ADMIN_SECRET = Deno.env.get("BOOTSTRAP_ADMIN_SECRET") || "";
const STORAGE_BUCKET = "investigation-board-files";
const SESSION_DAYS = 7;

const FIXED_CREDENTIALS: Record<string, string> = {
  HO1: Deno.env.get("PLAYER1_PASSWORD") || "",
  HO2: Deno.env.get("PLAYER2_PASSWORD") || "",
  SYSTEAM: Deno.env.get("PLAYER3_PASSWORD") || "",
};
const ALLOWED_ACCOUNT_IDS = new Set(Object.keys(FIXED_CREDENTIALS));

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function ok(data: unknown = {}) {
  return json(200, { ok: true, data });
}

function fail(status: number, error: string) {
  return json(status, { ok: false, error });
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 24) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toHex(value);
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

async function passwordHash(password: string, salt: string) {
  if (!PASSWORD_PEPPER) throw new Error("PASSWORD_PEPPER secret is missing");
  return await sha256(`${salt}:${password}:${PASSWORD_PEPPER}`);
}

function safeFileName(name: string) {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[^0-9A-Za-z가-힣._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return cleaned || "file";
}

async function createSession(accountId: string) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from("investigation_sessions").insert({
    token_hash: tokenHash,
    account_id: accountId,
    expires_at: expiresAt,
  });
  if (error) throw error;
  return { token, expiresAt };
}

async function authenticate(sessionToken: string) {
  if (!sessionToken) return null;
  const tokenHash = await sha256(sessionToken);
  const { data: sessionRow, error: sessionError } = await supabase
    .from("investigation_sessions")
    .select("id, account_id, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (sessionError || !sessionRow) return null;
  if (new Date(sessionRow.expires_at).getTime() <= Date.now()) {
    await supabase.from("investigation_sessions").delete().eq("id", sessionRow.id);
    return null;
  }

  const { data: account, error: accountError } = await supabase
    .from("investigation_accounts")
    .select("id, display_name, role, blocked")
    .eq("id", sessionRow.account_id)
    .maybeSingle();
  if (
    accountError ||
    !account ||
    account.blocked ||
    !ALLOWED_ACCOUNT_IDS.has(account.id)
  ) return null;
  return { sessionId: sessionRow.id, account };
}

async function requireAuth(body: Record<string, unknown>) {
  const auth = await authenticate(String(body.sessionToken || ""));
  if (!auth) throw Object.assign(new Error("접속 세션이 만료되었거나 차단되었습니다."), { status: 401 });
  return auth;
}

function accountResponse(account: any) {
  return {
    id: account.id,
    displayName: account.display_name,
    role: account.role,
    blocked: Boolean(account.blocked),
  };
}

async function loginFingerprint(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown";
  const ip = forwarded.split(",")[0].trim();
  return await sha256(`login:${ip}:${PASSWORD_PEPPER}`);
}

async function checkLoginRateLimit(req: Request) {
  const fingerprint = await loginFingerprint(req);
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("investigation_login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("fingerprint", fingerprint)
    .eq("success", false)
    .gte("attempted_at", since);
  if (error) throw error;
  return { fingerprint, limited: (count || 0) >= 20 };
}

async function recordLoginAttempt(fingerprint: string, success: boolean) {
  await supabase.from("investigation_login_attempts").insert({ fingerprint, success });
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await supabase.from("investigation_login_attempts").delete().lt("attempted_at", cutoff);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "POST 요청만 사용할 수 있습니다.");

  let body: Record<string, any>;
  try { body = await req.json(); }
  catch { return fail(400, "JSON 본문이 필요합니다."); }

  const action = String(body.action || "");
  const boardId = String(body.boardId || "main-investigation-board");

  try {
    if (action === "bootstrap_admin") {
      const secret = req.headers.get("x-bootstrap-secret") || "";
      if (!BOOTSTRAP_ADMIN_SECRET || secret !== BOOTSTRAP_ADMIN_SECRET) return fail(403, "부트스트랩 비밀키가 올바르지 않습니다.");
      const password = String(body.password || "").trim();
      if (!/^[A-Za-z0-9]{1,32}$/.test(password)) return fail(400, "관리자 비밀번호는 영문 또는 숫자 1~32자리여야 합니다.");

      const { data: admin, error } = await supabase
        .from("investigation_accounts")
        .select("id, password_hash")
        .eq("id", "admin")
        .single();
      if (error) throw error;
      if (admin.password_hash) return fail(409, "관리자 비밀번호가 이미 설정되어 있습니다.");

      const salt = randomHex(16);
      const hash = await passwordHash(password, salt);
      const { error: updateError } = await supabase
        .from("investigation_accounts")
        .update({ password_salt: salt, password_hash: hash, updated_at: new Date().toISOString() })
        .eq("id", "admin");
      if (updateError) throw updateError;
      return ok({ configured: true });
    }

    if (action === "login") {
      const accountId = String(body.accountId || "").trim();
      const accessCode = String(body.accessCode || "").trim();
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(accountId)) return fail(400, "플레이어 ID 형식이 올바르지 않습니다.");
      if (!/^[A-Za-z0-9]{1,32}$/.test(accessCode)) return fail(400, "비밀번호 형식이 올바르지 않습니다.");

      const rate = await checkLoginRateLimit(req);
      if (rate.limited) return fail(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.");

      const expectedPassword = FIXED_CREDENTIALS[accountId];
      if (!expectedPassword) return fail(500, "플레이어 비밀번호 서버 설정이 없습니다.");
      if (expectedPassword !== accessCode) {
        await recordLoginAttempt(rate.fingerprint, false);
        return fail(401, "ID 또는 비밀번호가 올바르지 않습니다.");
      }

      const { data: matched, error } = await supabase
        .from("investigation_accounts")
        .select("id, display_name, role, blocked")
        .eq("id", accountId)
        .maybeSingle();
      if (error) throw error;
      if (!matched || matched.blocked) {
        await recordLoginAttempt(rate.fingerprint, false);
        return fail(401, "ID 또는 비밀번호가 올바르지 않습니다.");
      }

      await recordLoginAttempt(rate.fingerprint, true);
      const newSession = await createSession(matched.id);
      return ok({ sessionToken: newSession.token, expiresAt: newSession.expiresAt, account: accountResponse(matched) });
    }

    const auth = await requireAuth(body);
    const account = auth.account;

    if (action === "verify_session") {
      return ok({ account: accountResponse(account) });
    }

    if (action === "logout") {
      await supabase.from("investigation_sessions").delete().eq("id", auth.sessionId);
      return ok({ loggedOut: true });
    }

    if (action === "load_board") {
      const { data, error } = await supabase
        .from("investigation_boards")
        .select("state")
        .eq("board_id", boardId)
        .maybeSingle();
      if (error) throw error;
      return ok({ state: data?.state || { version: 3, boardId, boardTitle: "공동 사건 조사 보드", items: [], connections: [] } });
    }

    if (action === "save_board") {
      const incoming = body.state;
      if (!incoming || typeof incoming !== "object" || !Array.isArray(incoming.items) || !Array.isArray(incoming.connections)) {
        return fail(400, "보드 상태 형식이 올바르지 않습니다.");
      }

      const { data: currentRow, error: loadError } = await supabase
        .from("investigation_boards")
        .select("state")
        .eq("board_id", boardId)
        .maybeSingle();
      if (loadError) throw loadError;

      const current = currentRow?.state || {
        version: 3, boardId, boardTitle: "공동 사건 조사 보드", items: [], connections: [],
        deletedItemIds: [], deletedConnectionIds: [], resetAt: null
      };

      const currentReset = current.resetAt ? Date.parse(current.resetAt) || 0 : 0;
      const incomingReset = incoming.resetAt ? Date.parse(incoming.resetAt) || 0 : 0;
      const resetAt = incomingReset > currentReset ? incoming.resetAt : current.resetAt || null;
      const effectiveReset = Math.max(currentReset, incomingReset);

      const deletedItemIds = new Set<string>([
        ...(Array.isArray(current.deletedItemIds) ? current.deletedItemIds : []),
        ...(Array.isArray(incoming.deletedItemIds) ? incoming.deletedItemIds : []),
      ]);
      const deletedConnectionIds = new Set<string>([
        ...(Array.isArray(current.deletedConnectionIds) ? current.deletedConnectionIds : []),
        ...(Array.isArray(incoming.deletedConnectionIds) ? incoming.deletedConnectionIds : []),
      ]);

      const itemMap = new Map<string, any>();
      const mergeItem = (item: any) => {
        if (!item?.id || deletedItemIds.has(item.id)) return;
        const createdAt = item.createdAt ? Date.parse(item.createdAt) || 0 : 0;
        if (effectiveReset && createdAt && createdAt <= effectiveReset) return;
        const previous = itemMap.get(item.id);
        if (!previous) { itemMap.set(item.id, item); return; }
        const prevTime = Date.parse(previous.updatedAt || previous.createdAt || 0) || 0;
        const nextTime = Date.parse(item.updatedAt || item.createdAt || 0) || 0;
        if (nextTime >= prevTime) itemMap.set(item.id, item);
      };

      if (incomingReset <= currentReset) {
        for (const item of current.items || []) mergeItem(item);
      }
      for (const item of incoming.items || []) mergeItem(item);

      const connectionMap = new Map<string, any>();
      const mergeConnection = (connection: any) => {
        if (!connection?.id || deletedConnectionIds.has(connection.id)) return;
        if (deletedItemIds.has(connection.from) || deletedItemIds.has(connection.to)) return;
        if (!itemMap.has(connection.from) || !itemMap.has(connection.to)) return;
        const createdAt = connection.createdAt ? Date.parse(connection.createdAt) || 0 : 0;
        if (effectiveReset && createdAt && createdAt <= effectiveReset) return;
        const previous = connectionMap.get(connection.id);
        if (!previous) { connectionMap.set(connection.id, connection); return; }
        const prevTime = Date.parse(previous.updatedAt || previous.createdAt || 0) || 0;
        const nextTime = Date.parse(connection.updatedAt || connection.createdAt || 0) || 0;
        if (nextTime >= prevTime) connectionMap.set(connection.id, connection);
      };

      if (incomingReset <= currentReset) {
        for (const connection of current.connections || []) mergeConnection(connection);
      }
      for (const connection of incoming.connections || []) mergeConnection(connection);

      const safeState = {
        version: 3,
        boardId,
        boardTitle: String(incoming.boardTitle || current.boardTitle || "공동 사건 조사 보드").slice(0, 80),
        items: [...itemMap.values()],
        connections: [...connectionMap.values()],
        deletedItemIds: [...deletedItemIds],
        deletedConnectionIds: [...deletedConnectionIds],
        resetAt,
        updatedAt: new Date().toISOString(),
      };

      const { error } = await supabase.from("investigation_boards").upsert({
        board_id: boardId,
        state: safeState,
        updated_at: new Date().toISOString(),
        updated_by: account.id,
      }, { onConflict: "board_id" });
      if (error) throw error;
      return ok({ saved: true, state: safeState, updatedAt: safeState.updatedAt });
    }

    if (action === "list_accounts") {
      if (account.role !== "admin") return fail(403, "관리자만 플레이어 목록을 볼 수 있습니다.");
      const { data, error } = await supabase
        .from("investigation_accounts")
        .select("id, display_name, role, blocked, password_hash")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return ok({
        accounts: (data || []).map((row) => ({
          id: row.id,
          displayName: row.display_name,
          role: row.role,
          blocked: Boolean(row.blocked),
          hasPassword: Boolean(row.password_hash),
        })),
      });
    }

    if (action === "set_password") {
      if (account.role !== "admin") return fail(403, "관리자만 비밀번호를 변경할 수 있습니다.");
      const accountId = String(body.accountId || "");
      const password = String(body.password || "").trim();
      if (!/^[A-Za-z0-9]{1,32}$/.test(password)) return fail(400, "비밀번호는 영문 또는 숫자 1~32자리여야 합니다.");

      const { data: duplicateRows, error: duplicateError } = await supabase
        .from("investigation_accounts")
        .select("id, password_salt, password_hash")
        .not("password_hash", "is", null);
      if (duplicateError) throw duplicateError;
      for (const row of duplicateRows || []) {
        if (row.id === accountId || !row.password_salt || !row.password_hash) continue;
        if ((await passwordHash(password, row.password_salt)) === row.password_hash) {
          return fail(409, "다른 플레이어가 이미 사용하는 비밀번호입니다.");
        }
      }

      const salt = randomHex(16);
      const hash = await passwordHash(password, salt);
      const { error } = await supabase
        .from("investigation_accounts")
        .update({ password_salt: salt, password_hash: hash, updated_at: new Date().toISOString() })
        .eq("id", accountId);
      if (error) throw error;

      if (accountId === account.id) {
        await supabase.from("investigation_sessions").delete().eq("account_id", accountId).neq("id", auth.sessionId);
      } else {
        await supabase.from("investigation_sessions").delete().eq("account_id", accountId);
      }
      return ok({ saved: true });
    }

    if (action === "set_blocked") {
      if (account.role !== "admin") return fail(403, "관리자만 접속을 차단할 수 있습니다.");
      const accountId = String(body.accountId || "");
      const blocked = Boolean(body.blocked);
      const { data: target, error: targetError } = await supabase
        .from("investigation_accounts")
        .select("id, role")
        .eq("id", accountId)
        .single();
      if (targetError) throw targetError;
      if (target.role === "admin") return fail(400, "관리자 계정은 차단할 수 없습니다.");

      const { error } = await supabase
        .from("investigation_accounts")
        .update({ blocked, updated_at: new Date().toISOString() })
        .eq("id", accountId);
      if (error) throw error;
      if (blocked) await supabase.from("investigation_sessions").delete().eq("account_id", accountId);
      return ok({ blocked });
    }

    if (action === "create_upload_url") {
      const fileName = safeFileName(String(body.fileName || "file"));
      const path = `${boardId}/${account.id}/${crypto.randomUUID()}-${fileName}`;
      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUploadUrl(path);
      if (error) throw error;
      return ok({ path, token: data.token });
    }

    if (action === "create_download_url") {
      const path = String(body.path || "");
      if (!path.startsWith(`${boardId}/`)) return fail(403, "다른 보드의 파일에는 접근할 수 없습니다.");
      const options = body.download ? { download: true } : undefined;
      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(path, 3600, options);
      if (error) throw error;
      return ok({ signedUrl: data.signedUrl });
    }

    return fail(400, "알 수 없는 action입니다.");
  } catch (error) {
    console.error(error);
    const status = Number((error as any)?.status) || 500;
    return fail(status, status === 500 ? "서버 처리 중 오류가 발생했습니다." : String((error as Error).message));
  }
});
