(() => {
  "use strict";

  const CONFIG = window.INVESTIGATION_BOARD_CONFIG || {};
  const REMOTE = window.InvestigationSupabaseApi || null;
  const REMOTE_MODE =
    CONFIG.mode === "supabase" && CONFIG.supabase?.enabled === true && REMOTE;

  const BOARD_KEY = "realtime-investigation-board-three-player-v1";
  const LEGACY_BOARD_KEYS = [];
  const ACCOUNTS_KEY = "realtime-investigation-board-accounts-three-player-v1";
  const SESSION_KEY = "realtime-investigation-board-session-three-player-v1";
  const CHANNEL_NAME = "realtime-investigation-board-channel-three-player-v1";
  const DB_NAME = "realtime-investigation-board-files";
  const DB_STORE = "attachments";
  const WORLD_W = 6000;
  const WORLD_H = 4000;
  const NOTE_COLORS = [
    "#f7e67c",
    "#ffc9cf",
    "#bde7ff",
    "#cdeebd",
    "#dcccf8",
    "#ffd7a8",
    "#ffffff",
  ];
  const STICKERS = [
    "🔎",
    "📌",
    "❗",
    "❓",
    "💡",
    "🧩",
    "🗝️",
    "👁️",
    "⚠️",
    "📷",
    "✓",
    "✕",
    "★",
    "●",
    "▲",
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));
  const uid = (prefix = "id") =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const nowIso = () => new Date().toISOString();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>'"]/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#39;",
          '"': "&quot;",
        })[ch],
    );
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const elements = {
    loginView: $("#loginView"),
    boardApp: $("#boardApp"),
    loginForm: $("#loginForm"),
    accountIdInput: $("#accountIdInput"),
    accessCodeInput: $("#accessCodeInput"),
    loginMessage: $("#loginMessage"),
    viewport: $("#viewport"),
    world: $("#world"),
    items: $("#itemsLayer"),
    svg: $("#connectionsLayer"),
    boardTitle: $("#boardTitle"),
    syncStatus: $("#syncStatus"),
    viewerName: $("#viewerName"),
    selectionPanel: $("#selectionPanel"),
    selectionMarquee: $("#selectionMarquee"),
    modalBackdrop: $("#modalBackdrop"),
    modal: $("#modal"),
    toast: $("#toast"),
    emptyHint: $("#emptyHint"),
    zoomValue: $("#zoomResetButton"),
  };

  function initialBoardState() {
    return {
      version: 3,
      boardId: CONFIG.boardId || "main-investigation-board",
      boardTitle: "공동 사건 조사 보드",
      items: [],
      connections: [],
      deletedItemIds: [],
      deletedConnectionIds: [],
      resetAt: null,
      updatedAt: nowIso(),
    };
  }

  function initialAccounts() {
    return clone(
      Array.isArray(CONFIG.initialAccounts) ? CONFIG.initialAccounts : [],
    ).map((account) => ({
      id: String(account.id || uid("acct")),
      accessCode: String(account.accessCode || ""),
      displayName: String(account.displayName || "플레이어"),
      role: account.role === "admin" ? "admin" : "participant",
      blocked: Boolean(account.blocked),
      createdAt: account.createdAt || nowIso(),
      updatedAt: account.updatedAt || nowIso(),
    }));
  }

  function loadLocalBoardState() {
    try {
      const candidates = [BOARD_KEY, ...LEGACY_BOARD_KEYS];
      const raw = candidates
        .map((key) => localStorage.getItem(key))
        .find(Boolean);
      if (!raw) return initialBoardState();
      const parsed = JSON.parse(raw);
      return {
        ...initialBoardState(),
        ...parsed,
        version: 3,
        items: Array.isArray(parsed.items) ? parsed.items : [],
        connections: Array.isArray(parsed.connections)
          ? parsed.connections
          : [],
        deletedItemIds: Array.isArray(parsed.deletedItemIds)
          ? parsed.deletedItemIds
          : [],
        deletedConnectionIds: Array.isArray(parsed.deletedConnectionIds)
          ? parsed.deletedConnectionIds
          : [],
        resetAt: parsed.resetAt || null,
      };
    } catch {
      return initialBoardState();
    }
  }

  function loadLocalAccounts() {
    try {
      const raw = localStorage.getItem(ACCOUNTS_KEY);
      if (!raw) {
        const seeded = initialAccounts();
        localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(seeded));
        return seeded;
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : initialAccounts();
    } catch {
      return initialAccounts();
    }
  }

  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  let state = loadLocalBoardState();
  let accounts = loadLocalAccounts();
  let session = loadSession();
  let history = [];
  let future = [];
  let selected = null;
  let selectedIds = new Set();
  let connectSource = null;
  let tool = "select";
  let pan = { x: -1800, y: -1100, scale: 1 };
  let panning = null;
  let dragging = null;
  let resizing = null;
  let marquee = null;
  let spaceDown = false;
  let channel = null;
  let dragFrame = 0;
  let renderToken = 0;
  const imageUrlCache = new Map();

  if (!REMOTE_MODE) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channel = null;
    }
  }

  function saveLocalAccounts({ broadcast = true } = {}) {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    if (broadcast && channel) {
      channel.postMessage({
        type: "accounts",
        accounts,
        sender: session?.accountId || "unknown",
      });
    }
  }

  function getAccount(accountId) {
    return accounts.find((account) => account.id === accountId) || null;
  }

  function findAccountByCredentials(accountId, accessCode) {
    return (
      accounts.find(
        (account) =>
          account.id === accountId &&
          account.accessCode &&
          account.accessCode === accessCode,
      ) || null
    );
  }

  function getAdminAccount() {
    return accounts.find((account) => account.role === "admin") || null;
  }

  function hasLocalAdminPassword() {
    return Boolean(getAdminAccount()?.accessCode);
  }

  function saveSession(data) {
    session = data;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function saveLocalSessionFromAccount(account) {
    saveSession({
      accountId: account.id,
      name: account.displayName,
      role: account.role,
      mode: "local-preview",
      loggedInAt: nowIso(),
    });
  }

  function clearSession() {
    if (REMOTE_MODE) REMOTE.clearSession?.();
    session = null;
    sessionStorage.removeItem(SESSION_KEY);
  }

  function localSessionValid() {
    if (!session?.accountId) return false;
    const account = getAccount(session.accountId);
    return Boolean(account && !account.blocked);
  }

  function currentSessionValid() {
    if (REMOTE_MODE)
      return Boolean(session?.accountId && REMOTE.hasSession?.());
    return localSessionValid();
  }

  function showLogin(message = "") {
    elements.boardApp.classList.add("is-hidden");
    elements.loginView.classList.remove("is-hidden");
    if (
      !message &&
      !REMOTE_MODE &&
      CONFIG.localPreview?.allowFirstRunAdminSetup &&
      !hasLocalAdminPassword()
    ) {
      message =
        "로컬 첫 실행입니다. 지금 입력하는 번호가 관리자 비밀번호로 설정됩니다.";
    }
    elements.loginMessage.textContent = message;
    elements.accountIdInput.value = "";
    elements.accessCodeInput.value = "";
    setTimeout(() => elements.accountIdInput.focus(), 0);
  }

  async function enterBoard() {
    if (!currentSessionValid()) {
      clearSession();
      showLogin("접속 권한을 확인할 수 없습니다.");
      return;
    }

    if (REMOTE_MODE) {
      try {
        const remoteBoard = await REMOTE.loadBoard();
        if (remoteBoard)
          state = { ...initialBoardState(), ...remoteBoard, version: 3 };
        if (session.role === "admin") accounts = await REMOTE.listAccounts();
      } catch (error) {
        clearSession();
        showLogin(
          error?.message || "서버에서 조사 보드를 불러오지 못했습니다.",
        );
        return;
      }
    } else {
      const account = getAccount(session.accountId);
      if (!account || account.blocked) {
        clearSession();
        showLogin("관리자가 이 계정의 접속을 차단했습니다.");
        return;
      }
      session.name = account.displayName;
      session.role = account.role;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }

    elements.loginView.classList.add("is-hidden");
    elements.boardApp.classList.remove("is-hidden");
    elements.viewerName.textContent = `${session.name} · ${session.role === "admin" ? "관리자" : "참여자"}`;
    $$(".admin-action").forEach((el) =>
      el.classList.toggle("is-hidden", session.role !== "admin"),
    );

    if (REMOTE_MODE) setupRemoteRealtime();

    requestAnimationFrame(() => {
      const rect = elements.viewport.getBoundingClientRect();
      if (state.items.length) fitBoard();
      else {
        pan.x = rect.width / 2 - WORLD_W / 2;
        pan.y = rect.height / 2 - WORLD_H / 2;
        pan.scale = 1;
        applyTransform();
      }
      renderBoard();
    });
  }

  async function enforceAccountStatus(reason = "") {
    if (!session?.accountId) return;
    if (REMOTE_MODE) {
      try {
        const verified = await REMOTE.verifySession();
        if (verified?.blocked || !verified?.accountId) throw new Error();
        return;
      } catch {
        clearSession();
        closeModal();
        selected = null;
        selectedIds.clear();
        showLogin(
          reason ||
            "관리자가 이 계정의 접속을 차단했습니다. 이전에 작성한 자료는 보드에 그대로 유지됩니다.",
        );
        return;
      }
    }

    const account = getAccount(session.accountId);
    if (!account || account.blocked) {
      clearSession();
      closeModal();
      selected = null;
      selectedIds.clear();
      showLogin(
        reason ||
          "관리자가 이 계정의 접속을 차단했습니다. 이전에 작성한 자료는 보드에 그대로 유지됩니다.",
      );
    }
  }

  function snapshot() {
    history.push(clone(state));
    if (history.length > 80) history.shift();
    future = [];
  }

  async function saveState({ broadcast = true, render = true } = {}) {
    if (!currentSessionValid()) {
      await enforceAccountStatus();
      return;
    }

    state.updatedAt = nowIso();
    elements.syncStatus.textContent = "저장 중…";

    if (REMOTE_MODE) {
      try {
        const saved = await REMOTE.saveBoard(state);
        if (saved?.state)
          state = { ...initialBoardState(), ...saved.state, version: 3 };
        elements.syncStatus.textContent = "저장됨";
        if (broadcast)
          await REMOTE.broadcast("board_changed", {
            updatedAt: state.updatedAt,
          });
      } catch (error) {
        elements.syncStatus.textContent = "저장 실패";
        showToast(error?.message || "서버 저장에 실패했습니다.");
      }
    } else {
      localStorage.setItem(BOARD_KEY, JSON.stringify(state));
      elements.syncStatus.textContent = "저장됨";
      if (broadcast && channel)
        channel.postMessage({
          type: "state",
          state,
          sender: session.accountId,
        });
    }

    if (render || REMOTE_MODE) renderBoard();
  }

  function setTool(next) {
    tool = next;
    if (tool !== "connect") connectSource = null;
    $$("[data-tool]").forEach((btn) =>
      btn.classList.toggle("is-active", btn.dataset.tool === tool),
    );
    elements.viewport.classList.toggle("is-hand", tool === "hand");
    elements.viewport.classList.toggle("is-connecting", tool === "connect");
    renderBoard();
  }

  function worldPoint(clientX, clientY) {
    const rect = elements.viewport.getBoundingClientRect();
    return {
      x: (clientX - rect.left - pan.x) / pan.scale,
      y: (clientY - rect.top - pan.y) / pan.scale,
    };
  }

  function viewportCenterWorld() {
    const rect = elements.viewport.getBoundingClientRect();
    return worldPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function estimatedItemHeight(item) {
    if (item.type === "note") return item.h || 190;
    if (item.type === "sticker") return item.h || 126;
    if (item.type === "photoSticker")
      return item.h || Math.round((item.w || 300) * 0.8);
    if (["evidence", "official"].includes(item.type)) return item.h || 300;
    return item.h || 180;
  }

  function clampItem(item) {
    const width = item.w || 220;
    const height = estimatedItemHeight(item);
    item.x = clamp(item.x, 0, WORLD_W - width);
    item.y = clamp(item.y, 0, WORLD_H - height);
  }

  function isAdminCreatedItem(item) {
    if (!item) return false;
    return (
      item.authorRole === "admin" ||
      item.authorId === "admin" ||
      item.type === "official"
    );
  }

  function isOwnItem(item) {
    return Boolean(
      item && session?.accountId && item.authorId === session.accountId,
    );
  }

  function canEditItem(item) {
    if (!item || !session) return false;
    if (session.role === "admin") return true;
    if (isAdminCreatedItem(item)) return false;
    return isOwnItem(item);
  }

  function isLockableImage(item) {
    if (!item) return false;
    if (item.type === "photoSticker") return true;
    return (
      ["evidence", "official"].includes(item.type) &&
      item.attachmentType?.startsWith("image/")
    );
  }

  function canMoveItem(item) {
    if (!item || !session) return false;
    if (session.role === "admin") return true;
    if (isAdminCreatedItem(item)) return false;
    if (item.locked) return false;
    // 참여자끼리는 작성자가 달라도 위치 이동만 허용한다.
    return true;
  }

  function canResizeItem(item) {
    if (!item || !session) return false;
    // 포스트잇 크기/비율 조절은 작성자 본인만 가능하다.
    // 관리자가 다른 참여자의 포스트잇을 선택해도 크기는 바꿀 수 없다.
    if (item.type === "note") return isOwnItem(item);
    if (session.role === "admin") return true;
    if (isAdminCreatedItem(item) || item.locked) return false;
    return isOwnItem(item);
  }

  function canDeleteItem(item) {
    if (!item || !session) return false;
    // 이미지 잠금은 잠금을 해제하기 전에는 관리자도 삭제하지 못한다.
    if (item.locked) return false;
    if (session.role === "admin") return true;
    if (isAdminCreatedItem(item)) return false;
    return isOwnItem(item);
  }

  function itemPermissionMessage(item, action) {
    if (!item) return "선택한 항목을 찾을 수 없습니다.";
    if (session?.role === "admin") {
      if (action === "delete" && item.locked)
        return "잠긴 이미지는 잠금을 해제한 뒤 삭제할 수 있습니다.";
      return "";
    }
    if (isAdminCreatedItem(item))
      return "관리자가 등록한 항목은 참여자가 이동·수정·삭제할 수 없습니다.";
    if (item.locked)
      return "관리자가 잠근 이미지는 참여자가 이동·수정·삭제할 수 없습니다.";
    if (!isOwnItem(item) && action !== "move")
      return "다른 참여자가 만든 항목은 이동만 가능하며 수정·삭제할 수 없습니다.";
    return "";
  }

  function canDeleteConnection(connection) {
    return (
      session?.role === "admin" || connection.authorId === session?.accountId
    );
  }

  function applyTransform() {
    elements.world.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${pan.scale})`;
    elements.zoomValue.textContent = `${Math.round(pan.scale * 100)}%`;
  }

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  function randomSignedTilt(minAbs, maxAbs) {
    const magnitude = minAbs + Math.random() * Math.max(0, maxAbs - minAbs);
    return Number(((Math.random() < 0.5 ? -1 : 1) * magnitude).toFixed(1));
  }

  function nextPhotoTilt() {
    const count = state.items.filter(
      (item) => item.type === "photoSticker",
    ).length;
    const direction = count % 2 === 0 ? -1 : 1;
    const magnitude = 1.2 + Math.random() * 2.2;
    return Number((direction * magnitude).toFixed(1));
  }

  function itemStyle(item) {
    const noteAutoHeight = item.type === "note";
    const autoHeight =
      noteAutoHeight ||
      ["evidence", "official", "photoSticker"].includes(item.type);
    const rotation = ["evidence", "official"].includes(item.type)
      ? 0
      : item.rotation || 0;
    const styleParts = [
      `left:${item.x}px`,
      `top:${item.y}px`,
      `width:${item.w || 220}px`,
      autoHeight
        ? "height:auto"
        : `height:${item.h || estimatedItemHeight(item)}px`,
      `z-index:${item.type === "sticker" ? 100000 + Number(item.z || 1) : Number(item.z || 1)}`,
      `transform:rotate(${rotation}deg)`,
    ];
    // 포스트잇은 내용이 길어지면 자동으로 아래로 늘어나되,
    // 작성자가 직접 늘린 세로 길이는 최소 높이로 유지한다.
    if (noteAutoHeight)
      styleParts.push(`min-height:${Math.max(120, Number(item.h || 190))}px`);
    return styleParts.join(";");
  }

  function renderBoard() {
    if (
      !session?.accountId ||
      elements.boardApp.classList.contains("is-hidden")
    )
      return;
    const token = ++renderToken;
    elements.boardTitle.value = state.boardTitle || "공동 사건 조사 보드";
    elements.emptyHint.classList.toggle("is-hidden", state.items.length > 0);
    const sorted = [...state.items].sort((a, b) => (a.z || 0) - (b.z || 0));
    elements.items.innerHTML = sorted.map(itemMarkup).join("");
    renderConnections();
    renderSelectionPanel();
    hydrateImages(token);
    applyTransform();
  }

  function cachedAttachmentUrl(item) {
    const key = REMOTE_MODE
      ? `remote:${item.attachmentPath || ""}`
      : `local:${item.attachmentId || ""}`;
    return imageUrlCache.get(key) || "";
  }

  function itemMarkup(item) {
    const selectedClass =
      selectedIds.has(item.id) ||
      (selected?.type === "item" && selected.id === item.id)
        ? " is-selected"
        : "";
    const connectClass = connectSource === item.id ? " is-connect-source" : "";
    const lockedClass = item.locked ? " is-locked" : "";
    const immovableClass = !canMoveItem(item) ? " is-immovable" : "";
    const style = itemStyle(item);
    const resizeHandle =
      canResizeItem(item) &&
      ["evidence", "official", "photoSticker"].includes(item.type)
        ? `<button class="resize-handle" type="button" data-resize-item="${esc(item.id)}" data-resize-axis="x" aria-label="크기 조절" title="사진 비율을 유지하며 크기 조절"></button>`
        : "";
    const noteResizeHandles =
      item.type === "note" && canResizeItem(item)
        ? `<button class="note-resize-handle note-resize-handle--x" type="button" data-resize-item="${esc(item.id)}" data-resize-axis="x" aria-label="포스트잇 가로 길이 조절" title="가로 길이 조절"></button><button class="note-resize-handle note-resize-handle--y" type="button" data-resize-item="${esc(item.id)}" data-resize-axis="y" aria-label="포스트잇 세로 길이 조절" title="세로 길이 조절"></button><button class="note-resize-handle note-resize-handle--xy" type="button" data-resize-item="${esc(item.id)}" data-resize-axis="xy" aria-label="포스트잇 가로·세로 길이 조절" title="가로·세로 길이 조절"></button>`
        : "";
    const lockBadge =
      item.locked && isLockableImage(item)
        ? `<span class="item-lock-badge" title="관리자가 고정한 이미지" aria-label="잠긴 이미지">🔒</span>`
        : "";

    if (item.type === "note") {
      return `<article class="board-item board-item--note${selectedClass}${connectClass}${lockedClass}${immovableClass}" data-item-id="${esc(item.id)}" style="${style}"><div class="item-card note-card" style="--note-color:${esc(item.color || NOTE_COLORS[0])}"><p class="note-text">${esc(item.body)}</p><div class="note-author">${esc(item.authorName)}</div></div>${noteResizeHandles}</article>`;
    }

    if (item.type === "sticker") {
      return `<article class="board-item${selectedClass}${connectClass}${lockedClass}${immovableClass}" data-item-id="${esc(item.id)}" style="${style}"><div class="item-card sticker-card"><div class="sticker-emoji">${esc(item.emoji || "📌")}</div>${item.body ? `<div class="sticker-caption">${esc(item.body)}</div>` : ""}</div></article>`;
    }

    if (item.type === "photoSticker") {
      return `<article class="board-item board-item--auto${selectedClass}${connectClass}${lockedClass}${immovableClass}" data-item-id="${esc(item.id)}" style="${style}">${lockBadge}<div class="item-card photo-sticker-card"><img class="photo-sticker-image" src="${esc(cachedAttachmentUrl(item))}" data-attachment-id="${esc(item.attachmentId || "")}" data-attachment-path="${esc(item.attachmentPath || "")}" alt="${esc(item.attachmentName || "사진 스티커")}" draggable="false" />${item.body ? `<div class="photo-sticker-caption">${esc(item.body)}</div>` : ""}<div class="photo-sticker-pin" aria-hidden="true"></div></div>${resizeHandle}</article>`;
    }

    const official = item.type === "official";
    const hasImage =
      Boolean(item.attachmentId || item.attachmentPath) &&
      item.attachmentType?.startsWith("image/");
    const hasFile =
      Boolean(item.attachmentId || item.attachmentPath) && !hasImage;
    const media = hasImage
      ? `<div class="evidence-media"><img class="evidence-image" src="${esc(cachedAttachmentUrl(item))}" data-attachment-id="${esc(item.attachmentId || "")}" data-attachment-path="${esc(item.attachmentPath || "")}" alt="${esc(item.attachmentName || "첨부 이미지")}" draggable="false" /></div>`
      : "";
    const fileButton = hasFile
      ? `<button type="button" class="attachment-chip" data-download-attachment="${esc(item.attachmentId || "")}" data-download-path="${esc(item.attachmentPath || "")}">📎 ${esc(item.attachmentName || "첨부 파일")}</button>`
      : "";

    return `<article class="board-item board-item--auto${selectedClass}${connectClass}${lockedClass}${immovableClass}" data-item-id="${esc(item.id)}" style="${style}">${lockBadge}<div class="item-card evidence-card${official ? " official-card" : ""}">${media}<div class="evidence-info"><div class="evidence-kind"><span>${official ? "관리자 공개 정보" : "조사 자료"}</span><span>${item.attachmentName ? "첨부" : ""}</span></div><h3 class="evidence-title">${esc(item.title || "제목 없음")}</h3>${item.body ? `<div class="evidence-body">${esc(item.body)}</div>` : ""}${fileButton}<div class="author-line">${esc(item.authorName)} · ${formatTime(item.createdAt)}</div></div></div>${resizeHandle}</article>`;
  }

  function itemGeometry(item) {
    const element = elements.items.querySelector(
      `[data-item-id="${CSS.escape(item.id)}"]`,
    );
    return {
      x: item.x,
      y: item.y,
      w: element?.offsetWidth || item.w || 220,
      h: element?.offsetHeight || estimatedItemHeight(item),
    };
  }

  function itemCenter(item) {
    const geometry = itemGeometry(item);
    return { x: geometry.x + geometry.w / 2, y: geometry.y + geometry.h / 2 };
  }

  function renderConnections() {
    const itemsById = new Map(state.items.map((item) => [item.id, item]));
    elements.svg.innerHTML = state.connections
      .map((connection) => {
        const from = itemsById.get(connection.from);
        const to = itemsById.get(connection.to);
        if (!from || !to) return "";
        const p1 = itemCenter(from);
        const p2 = itemCenter(to);
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const selectedClass =
          selected?.type === "connection" && selected.id === connection.id
            ? " is-selected"
            : "";
        const labelWidth = Math.min(
          200,
          34 + String(connection.label || "").length * 11,
        );
        return `<g data-connection-id="${esc(connection.id)}"><line class="connection-hit" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/><line class="connection-line${selectedClass}" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/><circle class="connection-end" cx="${p1.x}" cy="${p1.y}" r="4"/><circle class="connection-end" cx="${p2.x}" cy="${p2.y}" r="4"/>${connection.label ? `<rect class="connection-label-bg" x="${mx - labelWidth / 2}" y="${my - 13}" width="${labelWidth}" height="26" rx="8"/><text class="connection-label" x="${mx}" y="${my}">${esc(connection.label)}</text>` : ""}</g>`;
      })
      .join("");
  }

  async function resolveAttachmentUrl(itemOrData) {
    const localId =
      itemOrData.attachmentId || itemOrData.dataset?.attachmentId || "";
    const remotePath =
      itemOrData.attachmentPath || itemOrData.dataset?.attachmentPath || "";
    const cacheKey = REMOTE_MODE ? `remote:${remotePath}` : `local:${localId}`;
    if (imageUrlCache.has(cacheKey)) return imageUrlCache.get(cacheKey);

    if (REMOTE_MODE) {
      if (!remotePath) return "";
      const url = await REMOTE.getFileUrl(remotePath);
      if (url) imageUrlCache.set(cacheKey, url);
      return url || "";
    }

    if (!localId) return "";
    const record = await dbGet(localId);
    if (!record?.blob) return "";
    const url = URL.createObjectURL(record.blob);
    imageUrlCache.set(cacheKey, url);
    return url;
  }

  async function hydrateImages(token) {
    const images = $$(
      "img[data-attachment-id], img[data-attachment-path]",
      elements.items,
    );
    for (const image of images) {
      if (token !== renderToken) return;
      try {
        const url = await resolveAttachmentUrl(image);
        if (!url || token !== renderToken) continue;
        image.src = url;
        image.addEventListener(
          "load",
          () => {
            if (token !== renderToken) return;
            requestAnimationFrame(renderConnections);
          },
          { once: true },
        );
      } catch {}
    }
  }

  function updateSelectionClasses() {
    $$("[data-item-id]", elements.items).forEach((element) => {
      element.classList.toggle(
        "is-selected",
        selectedIds.has(element.dataset.itemId),
      );
    });
  }

  function setSingleItemSelection(id) {
    selectedIds = new Set(id ? [id] : []);
    selected = id ? { type: "item", id } : null;
    updateSelectionClasses();
    renderSelectionPanel();
  }

  function renderSelectionPanel() {
    if (selectedIds.size > 1) {
      elements.selectionPanel.classList.remove("is-hidden");
      const deletableCount = [...selectedIds]
        .map((id) => state.items.find((item) => item.id === id))
        .filter((item) => item && canDeleteItem(item)).length;
      const multiDescription =
        session?.role === "admin"
          ? "관리자는 모든 항목을 이동·수정·삭제할 수 있습니다. 단, 잠긴 이미지는 잠금 해제 후 삭제할 수 있습니다."
          : "다른 참여자의 항목은 위치만 이동할 수 있습니다. 수정·크기조절·삭제는 작성자 본인만 가능하고, 관리자 등록 항목은 이동도 할 수 없습니다.";
      elements.selectionPanel.innerHTML = `<p class="panel-kicker">MULTI SELECT</p><h3>${selectedIds.size}개 항목 선택됨</h3><p class="panel-description">${multiDescription}</p>${deletableCount ? `<div class="panel-actions"><button class="small-danger" data-action="delete-selected">삭제 가능한 내 항목 삭제</button></div>` : ""}`;
      return;
    }

    if (!selected) {
      elements.selectionPanel.classList.add("is-hidden");
      elements.selectionPanel.innerHTML = "";
      return;
    }

    if (selected.type === "connection") {
      const connection = state.connections.find(
        (item) => item.id === selected.id,
      );
      if (!connection) {
        selected = null;
        renderSelectionPanel();
        return;
      }
      const editable = canDeleteConnection(connection);
      elements.selectionPanel.classList.remove("is-hidden");
      elements.selectionPanel.innerHTML = `<p class="panel-kicker red-kicker">RED CONNECTION</p><h3>실마리 연결선</h3><div class="panel-row"><label>연결 설명</label><input id="connectionLabelInput" value="${esc(connection.label || "")}" maxlength="60" placeholder="예: 동일 인물, 시간대 일치" ${editable ? "" : "disabled"}></div><div class="connection-author">${esc(connection.authorName || "")}</div>${editable ? `<div class="panel-actions"><button class="small-primary" data-action="save-connection">저장</button><button class="small-danger" data-action="delete-selected">삭제</button></div>` : ""}`;
      return;
    }

    const id = selectedIds.size === 1 ? [...selectedIds][0] : selected.id;
    const item = state.items.find((entry) => entry.id === id);
    if (!item) {
      selected = null;
      selectedIds.clear();
      renderSelectionPanel();
      return;
    }
    selected = { type: "item", id: item.id };
    const editable = canEditItem(item);
    const deletable = canDeleteItem(item);
    const movable = canMoveItem(item);
    const lockable = isLockableImage(item);
    const typeLabel =
      item.type === "note"
        ? "포스트잇"
        : item.type === "sticker"
          ? "기호 스티커"
          : item.type === "photoSticker"
            ? "사진 스티커"
            : item.type === "official"
              ? "관리자 공개 정보"
              : "조사 자료";
    const previewTitle =
      item.title ||
      item.body?.slice(0, 30) ||
      item.emoji ||
      item.attachmentName ||
      "선택 항목";
    const titleField = ["evidence", "official"].includes(item.type)
      ? `<div class="panel-row"><label>제목</label><input id="editTitle" value="${esc(item.title || "")}" ${editable ? "" : "disabled"}></div>`
      : "";
    const bodyLabel =
      item.type === "photoSticker"
        ? "사진 문구"
        : item.type === "sticker"
          ? "스티커 문구"
          : "내용";
    const bodyField =
      item.type === "sticker" || item.type === "photoSticker"
        ? `<div class="panel-row"><label>${bodyLabel}</label><input id="editBody" value="${esc(item.body || "")}" maxlength="60" ${editable ? "" : "disabled"}></div>`
        : `<div class="panel-row"><label>${bodyLabel}</label><textarea id="editBody" ${editable ? "" : "disabled"}>${esc(item.body || "")}</textarea></div>`;
    const resizable = canResizeItem(item);
    const resizeHelp =
      item.type === "note"
        ? `<div class="panel-tip">${resizable ? "포스트잇은 글 길이에 맞춰 자동으로 늘어납니다. 작성자는 선택 후 오른쪽 핸들로 가로, 아래 핸들로 세로, 모서리 핸들로 가로·세로를 함께 조절할 수 있습니다." : "포스트잇의 길이 조절은 작성자 본인만 할 수 있습니다."}</div>`
        : ["evidence", "official", "photoSticker"].includes(item.type)
          ? `<div class="panel-tip">${resizable ? "선택한 카드의 오른쪽 아래 핸들을 드래그하면 사진 비율을 유지한 채 크기를 조절할 수 있습니다." : isAdminCreatedItem(item) && session?.role !== "admin" ? "관리자가 등록한 항목은 크기를 조절할 수 없습니다." : !isOwnItem(item) && session?.role !== "admin" ? "다른 참여자의 항목은 위치 이동만 가능하며 크기를 조절할 수 없습니다." : "현재 이 이미지는 크기를 조절할 수 없습니다."}</div>`
          : "";
    const moveHelp = !movable
      ? `<div class="panel-tip panel-tip--locked">🔒 ${isAdminCreatedItem(item) && session?.role !== "admin" ? "관리자가 등록한 항목이라 위치를 옮길 수 없습니다." : "현재 위치가 고정되어 있습니다."}</div>`
      : !isOwnItem(item) && session?.role !== "admin"
        ? `<div class="panel-tip">다른 참여자의 항목입니다. 위치 이동만 가능합니다.</div>`
        : "";
    const lockAction =
      session?.role === "admin" && lockable
        ? `<button class="small-lock" data-action="toggle-lock">${item.locked ? "잠금 해제" : "이미지 잠금"}</button>`
        : "";
    const editAction = editable
      ? `<button class="small-primary" data-action="save-item">저장</button>`
      : "";
    const deleteAction = deletable
      ? `<button class="small-danger" data-action="delete-selected">삭제</button>`
      : "";
    const actions =
      lockAction || editAction || deleteAction
        ? `<div class="panel-actions">${lockAction}${editAction}${deleteAction}</div>`
        : "";

    elements.selectionPanel.classList.remove("is-hidden");
    elements.selectionPanel.innerHTML = `<p class="panel-kicker">${esc(typeLabel)}</p><h3>${esc(previewTitle)}</h3>${titleField}${bodyField}<div class="panel-row"><label>작성자</label><input value="${esc(item.authorName)}" disabled></div>${moveHelp}${resizeHelp}${actions}`;
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.remove("is-hidden");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(
      () => elements.toast.classList.add("is-hidden"),
      1900,
    );
  }

  function openModal(html) {
    elements.modal.innerHTML = html;
    elements.modalBackdrop.classList.remove("is-hidden");
    setTimeout(
      () => elements.modal.querySelector("input,textarea,button")?.focus(),
      0,
    );
  }

  function closeModal() {
    elements.modalBackdrop.classList.add("is-hidden");
    elements.modal.innerHTML = "";
  }

  function openEvidenceModal({ official = false } = {}) {
    if (official && session.role !== "admin") return;
    openModal(
      `<h2>${official ? "관리자 공개 정보" : "조사 자료"} 추가</h2><p class="modal-lead">사진을 올리면 원본 비율을 유지한 사진이 카드의 중심으로 표시되고, 제목·설명·작성자 정보는 사진 아래에 표시됩니다.</p><form id="evidenceForm" class="form-stack"><input type="hidden" name="official" value="${official ? "1" : "0"}"><div class="form-field"><label>자료 제목</label><input name="title" maxlength="80" required placeholder="예: CCTV 캡처 22:14"></div><div class="form-field"><label>사진 / 자료 파일</label><input name="file" type="file" accept="image/*,.pdf,.txt,.md,.doc,.docx"></div><div class="form-field"><label>하단 정보글</label><textarea name="body" maxlength="1200" placeholder="발견 장소, 시간, 특징, 추측 등을 적으세요."></textarea></div><div class="form-actions"><button class="cancel-btn" type="button" data-close-modal>취소</button><button class="submit-btn" type="submit">자료 올리기</button></div></form>`,
    );
  }

  function openNoteModal() {
    openModal(
      `<h2>포스트잇 붙이기</h2><p class="modal-lead">사진이나 사건 자료 옆에 추측, 질문, 확인할 내용을 적어 붙일 수 있습니다.</p><form id="noteForm" class="form-stack"><div class="form-field"><label>메모 내용</label><textarea name="body" maxlength="500" required placeholder="예: 이 사진의 시각과 출입 기록 시간이 맞지 않음"></textarea></div><div class="form-field"><label>포스트잇 색상</label><div class="color-grid">${NOTE_COLORS.map((color, index) => `<button type="button" class="color-swatch ${index === 0 ? "is-selected" : ""}" data-note-color="${color}" style="background:${color}" aria-label="색상 선택"></button>`).join("")}</div><input type="hidden" name="color" value="${NOTE_COLORS[0]}"></div><div class="form-actions"><button class="cancel-btn" type="button" data-close-modal>취소</button><button class="submit-btn" type="submit">붙이기</button></div></form>`,
    );
  }

  function openStickerModal() {
    openModal(
      `<h2>기호 스티커 붙이기</h2><p class="modal-lead">중요, 의문, 확인 완료 같은 표시를 사건 보드 위에 남깁니다.</p><form id="stickerForm" class="form-stack"><div class="form-field"><label>스티커</label><div class="sticker-grid">${STICKERS.map((sticker, index) => `<button type="button" class="sticker-choice ${index === 0 ? "is-selected" : ""}" data-sticker="${sticker}">${sticker}</button>`).join("")}</div><input type="hidden" name="emoji" value="${STICKERS[0]}"></div><div class="form-field"><label>짧은 문구 (선택)</label><input name="body" maxlength="30" placeholder="예: 중요, 재확인"></div><div class="form-actions"><button class="cancel-btn" type="button" data-close-modal>취소</button><button class="submit-btn" type="submit">붙이기</button></div></form>`,
    );
  }

  function openPhotoStickerModal() {
    openModal(
      `<h2>사진 스티커 붙이기</h2><p class="modal-lead">사용자가 직접 올린 사진을 독립된 사진 조각처럼 붙입니다. 사진 비율은 유지되며 선택 후 오른쪽 아래 핸들로 크기를 조절할 수 있습니다.</p><form id="photoStickerForm" class="form-stack"><div class="form-field"><label>사진</label><input name="file" type="file" accept="image/*" required></div><div class="form-field"><label>짧은 문구 (선택)</label><input name="body" maxlength="60" placeholder="예: 현장 바닥에서 발견"></div><div class="form-actions"><button class="cancel-btn" type="button" data-close-modal>취소</button><button class="submit-btn" type="submit">사진 붙이기</button></div></form>`,
    );
  }

  function openHelpModal() {
    openModal(
      `<h2>사용 방법</h2><div class="help-list"><p><strong>선택:</strong> 빈 공간을 드래그하면 드래그 범위 안의 항목을 한꺼번에 선택합니다. Shift를 누르면 기존 선택에 추가할 수 있습니다.</p><p><strong>이동:</strong> 항목을 드래그하면 부드럽게 이동합니다. 여러 항목을 선택한 뒤 하나를 드래그하면 함께 이동합니다.</p><p><strong>사진 크기:</strong> 사진 자료/사진 스티커 선택 후 오른쪽 아래 핸들을 드래그하면 원본 비율을 유지하며 확대·축소됩니다.</p><p><strong>붉은 선:</strong> 왼쪽 ╱ 도구를 선택하고 두 항목을 차례로 클릭합니다.</p><p><strong>보드 이동:</strong> H로 손 도구를 선택하거나 Space를 누른 채 드래그합니다. 마우스 휠(가운데 버튼)을 누른 채 드래그해도 바로 손 도구처럼 이동합니다.</p><p><strong>확대/축소:</strong> Ctrl/⌘ + 휠 또는 오른쪽 아래 확대 버튼을 사용합니다.</p></div><div class="form-actions"><button class="submit-btn" data-close-modal type="button">확인</button></div>`,
    );
  }

  async function refreshAccountsForAdmin() {
    if (session.role !== "admin") return;
    if (REMOTE_MODE) {
      try {
        accounts = await REMOTE.listAccounts();
      } catch (error) {
        showToast(error?.message || "플레이어 목록을 불러오지 못했습니다.");
      }
    }
  }

  async function openPlayerManager() {
    if (session.role !== "admin") return;
    await refreshAccountsForAdmin();
    const sorted = [...accounts].sort((a, b) => {
      if (a.role === "admin") return 1;
      if (b.role === "admin") return -1;
      return 0;
    });
    const rows = sorted
      .map((account) => {
        const passwordState = REMOTE_MODE
          ? account.hasPassword
            ? "비밀번호 설정됨"
            : "비밀번호 미설정"
          : account.accessCode
            ? "비밀번호 설정됨"
            : "비밀번호 미설정";
        return `<div class="account-row ${account.blocked ? "is-blocked" : ""}"><div class="account-main"><strong>${esc(account.displayName)}</strong><span>${account.role === "admin" ? "관리자" : "플레이어"} · ${passwordState}</span></div><div class="account-status">${account.blocked ? "차단됨" : "접속 가능"}</div><div class="account-actions"><button type="button" class="account-password" data-account-password="${esc(account.id)}">비밀번호 ${passwordState.includes("설정됨") ? "변경" : "설정"}</button>${account.role !== "admin" ? `<button type="button" class="account-toggle ${account.blocked ? "unblock" : "block"}" data-account-toggle="${esc(account.id)}">${account.blocked ? "차단 해제" : "차단"}</button>` : ""}</div></div>`;
      })
      .join("");
    openModal(
      `<h2>플레이어 접속 관리</h2><p class="modal-lead">비밀번호는 화면에 표시하지 않습니다. 관리자가 직접 새 번호를 지정할 수 있습니다. 플레이어를 차단해도 기존에 올린 사진·메모·스티커·연결선은 그대로 유지됩니다.</p><div class="account-list">${rows}</div><div class="form-actions"><button class="cancel-btn" data-close-modal type="button">닫기</button></div>`,
    );
  }

  function openPasswordModal(accountId) {
    if (session.role !== "admin") return;
    const account = getAccount(accountId);
    if (!account) return;
    openModal(
      `<h2>${esc(account.displayName)} 비밀번호 설정</h2><p class="modal-lead">이 번호를 입력해야 해당 플레이어가 접속할 수 있습니다. 기존 비밀번호는 표시되지 않으며 새 번호로 덮어씁니다.</p><form id="passwordForm" class="form-stack"><input type="hidden" name="accountId" value="${esc(account.id)}"><div class="form-field"><label>새 접속 비밀번호</label><input name="password" type="password" inputmode="text" maxlength="32" pattern="[A-Za-z0-9]+" required placeholder="영문·숫자로 지정"></div><div class="form-field"><label>한 번 더 입력</label><input name="passwordConfirm" type="password" inputmode="text" maxlength="32" pattern="[A-Za-z0-9]+" required placeholder="같은 비밀번호 재입력"></div><div class="form-actions"><button class="cancel-btn" type="button" data-back-player-manager>뒤로</button><button class="submit-btn" type="submit">비밀번호 저장</button></div></form>`,
    );
  }

  async function setAccountPassword(accountId, password) {
    if (session.role !== "admin") return;
    if (!/^[A-Za-z0-9]{1,32}$/.test(password))
      throw new Error(
        "비밀번호는 영문 대소문자와 숫자만 사용해 1~32자리로 지정해 주세요.",
      );
    if (REMOTE_MODE) {
      await REMOTE.setPassword(accountId, password);
      await REMOTE.broadcast("accounts_changed", { accountId });
      await refreshAccountsForAdmin();
      return;
    }
    const account = getAccount(accountId);
    if (!account) throw new Error("계정을 찾을 수 없습니다.");
    if (
      accounts.some(
        (other) =>
          other.id !== accountId &&
          other.accessCode &&
          other.accessCode === password,
      )
    ) {
      throw new Error("다른 플레이어가 이미 사용하는 비밀번호입니다.");
    }
    account.accessCode = password;
    account.updatedAt = nowIso();
    saveLocalAccounts();
  }

  async function toggleAccountBlocked(accountId) {
    if (session.role !== "admin") return;
    const account = getAccount(accountId);
    if (!account || account.role === "admin") return;
    const nextBlocked = !account.blocked;
    if (REMOTE_MODE) {
      await REMOTE.setBlocked(accountId, nextBlocked);
      await REMOTE.broadcast("accounts_changed", {
        accountId,
        blocked: nextBlocked,
      });
      await refreshAccountsForAdmin();
    } else {
      account.blocked = nextBlocked;
      account.updatedAt = nowIso();
      saveLocalAccounts();
    }
    showToast(
      nextBlocked
        ? `${account.displayName} 접속을 차단했습니다.`
        : `${account.displayName} 차단을 해제했습니다.`,
    );
  }

  function highestZ() {
    return state.items.reduce((max, item) => Math.max(max, item.z || 0), 0);
  }

  async function getImageRatio(file) {
    if (!(file instanceof File) || !file.type.startsWith("image/")) return null;
    try {
      if (window.createImageBitmap) {
        const bitmap = await createImageBitmap(file);
        const ratio =
          bitmap.width && bitmap.height ? bitmap.width / bitmap.height : null;
        bitmap.close?.();
        return ratio;
      }
    } catch {}
    return await new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const ratio =
          image.naturalWidth && image.naturalHeight
            ? image.naturalWidth / image.naturalHeight
            : null;
        URL.revokeObjectURL(url);
        resolve(ratio);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      image.src = url;
    });
  }

  async function storeUploadedFile(file) {
    if (!(file instanceof File) || file.size <= 0) {
      return {
        attachmentId: null,
        attachmentPath: null,
        attachmentName: null,
        attachmentType: null,
        imageRatio: null,
        attachmentSource: null,
      };
    }
    if (file.size > 15 * 1024 * 1024) throw new Error("FILE_TOO_LARGE");
    const imageRatio = await getImageRatio(file);

    if (REMOTE_MODE) {
      const uploaded = await REMOTE.uploadFile(file);
      return {
        attachmentId: null,
        attachmentPath: uploaded.path,
        attachmentName: file.name,
        attachmentType: file.type || "application/octet-stream",
        imageRatio,
        attachmentSource: "remote",
      };
    }

    const attachmentId = uid("file");
    const attachmentName = file.name;
    const attachmentType = file.type || "application/octet-stream";
    await dbPut({
      id: attachmentId,
      blob: file,
      name: attachmentName,
      type: attachmentType,
      createdAt: nowIso(),
      uploadedBy: session.accountId,
    });
    return {
      attachmentId,
      attachmentPath: null,
      attachmentName,
      attachmentType,
      imageRatio,
      attachmentSource: "local",
    };
  }

  async function addEvidence(form) {
    const fd = new FormData(form);
    const official = fd.get("official") === "1";
    if (official && session.role !== "admin") return;
    const title = String(fd.get("title") || "").trim();
    const body = String(fd.get("body") || "").trim();
    const file = fd.get("file");
    if (!title) return;

    let attachment = {
      attachmentId: null,
      attachmentPath: null,
      attachmentName: null,
      attachmentType: null,
      imageRatio: null,
      attachmentSource: null,
    };
    try {
      attachment = await storeUploadedFile(file);
    } catch (error) {
      showToast(
        error.message === "FILE_TOO_LARGE"
          ? "첨부 파일은 15MB 이하로 올려 주세요."
          : error.message || "첨부 파일 저장에 실패했습니다.",
      );
      return;
    }

    snapshot();
    const center = viewportCenterWorld();
    const imageWidth = attachment.attachmentType?.startsWith("image/")
      ? 430
      : 330;
    const item = {
      id: uid("item"),
      type: official ? "official" : "evidence",
      x: center.x - imageWidth / 2,
      y: center.y - 180,
      w: imageWidth,
      h: 300,
      z: highestZ() + 1,
      rotation: 0,
      title,
      body,
      ...attachment,
      authorId: session.accountId,
      authorName: session.name,
      authorRole: session.role,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    clampItem(item);
    state.items.push(item);
    selectedIds = new Set([item.id]);
    selected = { type: "item", id: item.id };
    closeModal();
    await saveState();
  }

  function addNote(form) {
    const fd = new FormData(form);
    const body = String(fd.get("body") || "").trim();
    if (!body) return;
    snapshot();
    const center = viewportCenterWorld();
    const item = {
      id: uid("item"),
      type: "note",
      x: center.x - 110,
      y: center.y - 95,
      w: 220,
      h: 190,
      z: highestZ() + 1,
      rotation: randomSignedTilt(1.1, 4.2),
      body,
      color: String(fd.get("color") || NOTE_COLORS[0]),
      authorId: session.accountId,
      authorName: session.name,
      authorRole: session.role,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    clampItem(item);
    state.items.push(item);
    selectedIds = new Set([item.id]);
    selected = { type: "item", id: item.id };
    closeModal();
    saveState();
  }

  function addSticker(form) {
    const fd = new FormData(form);
    snapshot();
    const center = viewportCenterWorld();
    const item = {
      id: uid("item"),
      type: "sticker",
      x: center.x - 63,
      y: center.y - 63,
      w: 126,
      h: 126,
      z: highestZ() + 1,
      rotation: Number((Math.random() * 8 - 4).toFixed(1)),
      emoji: String(fd.get("emoji") || STICKERS[0]),
      body: String(fd.get("body") || "").trim(),
      authorId: session.accountId,
      authorName: session.name,
      authorRole: session.role,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    clampItem(item);
    state.items.push(item);
    selectedIds = new Set([item.id]);
    selected = { type: "item", id: item.id };
    closeModal();
    saveState();
  }

  async function addPhotoSticker(form) {
    const fd = new FormData(form);
    const file = fd.get("file");
    if (
      !(file instanceof File) ||
      !file.type.startsWith("image/") ||
      file.size <= 0
    ) {
      showToast("사진 파일을 선택해 주세요.");
      return;
    }

    let attachment;
    try {
      attachment = await storeUploadedFile(file);
    } catch (error) {
      showToast(
        error.message === "FILE_TOO_LARGE"
          ? "사진은 15MB 이하로 올려 주세요."
          : error.message || "사진 저장에 실패했습니다.",
      );
      return;
    }

    snapshot();
    const center = viewportCenterWorld();
    const item = {
      id: uid("item"),
      type: "photoSticker",
      x: center.x - 160,
      y: center.y - 140,
      w: 320,
      h: 260,
      z: highestZ() + 1,
      rotation: nextPhotoTilt(),
      body: String(fd.get("body") || "").trim(),
      ...attachment,
      authorId: session.accountId,
      authorName: session.name,
      authorRole: session.role,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    clampItem(item);
    state.items.push(item);
    selectedIds = new Set([item.id]);
    selected = { type: "item", id: item.id };
    closeModal();
    await saveState();
  }

  async function deleteSelected() {
    if (selected?.type === "connection" && selectedIds.size === 0) {
      const connection = state.connections.find(
        (item) => item.id === selected.id,
      );
      if (!connection || !canDeleteConnection(connection)) return;
      snapshot();
      state.connections = state.connections.filter(
        (item) => item.id !== connection.id,
      );
      state.deletedConnectionIds = [
        ...new Set([...(state.deletedConnectionIds || []), connection.id]),
      ];
      selected = null;
      await saveState();
      return;
    }

    const ids = selectedIds.size
      ? [...selectedIds]
      : selected?.type === "item"
        ? [selected.id]
        : [];
    if (!ids.length) return;
    const selectedItems = ids
      .map((id) => state.items.find((item) => item.id === id))
      .filter(Boolean);
    const deletableItems = selectedItems.filter((item) => canDeleteItem(item));
    if (!deletableItems.length) {
      const message = selectedItems
        .map((item) => itemPermissionMessage(item, "delete"))
        .find(Boolean);
      if (message) showToast(message);
      return;
    }

    snapshot();
    const deleteIds = new Set(deletableItems.map((item) => item.id));
    const removedConnectionIds = state.connections
      .filter(
        (connection) =>
          deleteIds.has(connection.from) || deleteIds.has(connection.to),
      )
      .map((connection) => connection.id);
    state.items = state.items.filter((item) => !deleteIds.has(item.id));
    state.connections = state.connections.filter(
      (connection) =>
        !deleteIds.has(connection.from) && !deleteIds.has(connection.to),
    );
    state.deletedItemIds = [
      ...new Set([...(state.deletedItemIds || []), ...deleteIds]),
    ];
    state.deletedConnectionIds = [
      ...new Set([
        ...(state.deletedConnectionIds || []),
        ...removedConnectionIds,
      ]),
    ];
    selected = null;
    selectedIds.clear();

    if (!REMOTE_MODE) {
      for (const item of deletableItems) {
        if (item.attachmentId) {
          try {
            await dbDelete(item.attachmentId);
          } catch {}
        }
      }
    }
    await saveState();
  }

  function createConnection(fromId, toId) {
    if (fromId === toId) return;
    const existing = state.connections.find(
      (connection) =>
        (connection.from === fromId && connection.to === toId) ||
        (connection.from === toId && connection.to === fromId),
    );
    if (existing) {
      selectedIds.clear();
      selected = { type: "connection", id: existing.id };
      connectSource = null;
      setTool("select");
      showToast("이미 붉은 선으로 연결된 항목입니다.");
      return;
    }

    snapshot();
    const connection = {
      id: uid("conn"),
      from: fromId,
      to: toId,
      label: "",
      authorId: session.accountId,
      authorName: session.name,
      authorRole: session.role,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      color: "red",
    };
    state.connections.push(connection);
    selectedIds.clear();
    selected = { type: "connection", id: connection.id };
    connectSource = null;
    tool = "select";
    $$("[data-tool]").forEach((btn) =>
      btn.classList.toggle("is-active", btn.dataset.tool === "select"),
    );
    elements.viewport.classList.remove("is-connecting");
    saveState();
  }

  function zoomAt(nextScale, clientX, clientY) {
    const rect = elements.viewport.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const worldX = (cx - pan.x) / pan.scale;
    const worldY = (cy - pan.y) / pan.scale;
    const scale = clamp(nextScale, 0.25, 2.4);
    pan.x = cx - worldX * scale;
    pan.y = cy - worldY * scale;
    pan.scale = scale;
    applyTransform();
  }

  function fitBoard() {
    if (!state.items.length) {
      pan = { x: -1800, y: -1100, scale: 1 };
      applyTransform();
      return;
    }
    const geometries = state.items.map((item) => itemGeometry(item));
    const minX = Math.min(...geometries.map((item) => item.x));
    const minY = Math.min(...geometries.map((item) => item.y));
    const maxX = Math.max(...geometries.map((item) => item.x + item.w));
    const maxY = Math.max(...geometries.map((item) => item.y + item.h));
    const rect = elements.viewport.getBoundingClientRect();
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = clamp(
      Math.min((rect.width - 180) / width, (rect.height - 160) / height),
      0.25,
      1.3,
    );
    pan.scale = scale;
    pan.x = rect.width / 2 - (minX + width / 2) * scale;
    pan.y = rect.height / 2 - (minY + height / 2) * scale;
    applyTransform();
  }

  function undo() {
    if (!history.length) return;
    future.push(clone(state));
    state = history.pop();
    selected = null;
    selectedIds.clear();
    saveState();
  }

  function redo() {
    if (!future.length) return;
    history.push(clone(state));
    state = future.pop();
    selected = null;
    selectedIds.clear();
    saveState();
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE))
          db.createObjectStore(DB_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbPut(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbGet(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(DB_STORE, "readonly")
        .objectStore(DB_STORE)
        .get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbDelete(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function downloadAttachment(target) {
    const localId = target.dataset.downloadAttachment || "";
    const remotePath = target.dataset.downloadPath || "";
    if (REMOTE_MODE) {
      if (!remotePath) return;
      const url = await REMOTE.getFileUrl(remotePath, { download: true });
      if (url) window.open(url, "_blank", "noopener");
      return;
    }
    const record = await dbGet(localId);
    if (!record?.blob) return;
    const url = URL.createObjectURL(record.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = record.name || "attachment";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function beginMarquee(event) {
    const rect = elements.viewport.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    marquee = {
      pointerId: event.pointerId,
      startX: x,
      startY: y,
      currentX: x,
      currentY: y,
      base: event.shiftKey ? new Set(selectedIds) : new Set(),
      moved: false,
    };
    elements.selectionMarquee.classList.remove("is-hidden");
    elements.selectionMarquee.style.left = `${x}px`;
    elements.selectionMarquee.style.top = `${y}px`;
    elements.selectionMarquee.style.width = "0px";
    elements.selectionMarquee.style.height = "0px";
    elements.viewport.setPointerCapture(event.pointerId);
  }

  function updateMarquee(event) {
    if (!marquee) return;
    const rect = elements.viewport.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    marquee.currentX = x;
    marquee.currentY = y;
    const left = Math.min(marquee.startX, x);
    const top = Math.min(marquee.startY, y);
    const width = Math.abs(x - marquee.startX);
    const height = Math.abs(y - marquee.startY);
    marquee.moved = width > 3 || height > 3;
    elements.selectionMarquee.style.left = `${left}px`;
    elements.selectionMarquee.style.top = `${top}px`;
    elements.selectionMarquee.style.width = `${width}px`;
    elements.selectionMarquee.style.height = `${height}px`;

    const box = {
      left: rect.left + left,
      right: rect.left + left + width,
      top: rect.top + top,
      bottom: rect.top + top + height,
    };
    const next = new Set(marquee.base);
    $$("[data-item-id]", elements.items).forEach((itemElement) => {
      const r = itemElement.getBoundingClientRect();
      const intersects =
        r.right >= box.left &&
        r.left <= box.right &&
        r.bottom >= box.top &&
        r.top <= box.bottom;
      if (intersects) next.add(itemElement.dataset.itemId);
    });
    selectedIds = next;
    selected =
      selectedIds.size === 1 ? { type: "item", id: [...selectedIds][0] } : null;
    updateSelectionClasses();
    renderSelectionPanel();
  }

  function endMarquee(event) {
    if (!marquee) return;
    const moved = marquee.moved;
    const baseHadSelection = marquee.base.size > 0;
    marquee = null;
    elements.selectionMarquee.classList.add("is-hidden");
    try {
      elements.viewport.releasePointerCapture(event.pointerId);
    } catch {}
    if (!moved && !baseHadSelection) {
      selectedIds.clear();
      selected = null;
    } else if (selectedIds.size === 1) {
      selected = { type: "item", id: [...selectedIds][0] };
    } else if (selectedIds.size > 1) {
      selected = null;
    }
    updateSelectionClasses();
    renderSelectionPanel();
  }

  function scheduleDragPaint(callback) {
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      callback();
    });
  }

  function beginItemDrag(event, itemElement, item) {
    if (!canMoveItem(item)) {
      const message = itemPermissionMessage(item, "move");
      if (message) showToast(message);
      return;
    }
    const ids = selectedIds.has(item.id) ? [...selectedIds] : [item.id];
    if (!selectedIds.has(item.id)) setSingleItemSelection(item.id);
    const movableItems = ids
      .map((id) => state.items.find((entry) => entry.id === id))
      .filter((entry) => entry && canMoveItem(entry));
    if (!movableItems.length) return;

    snapshot();
    const point = worldPoint(event.clientX, event.clientY);
    const maxZ = highestZ();
    const starts = new Map();
    movableItems.forEach((entry, index) => {
      starts.set(entry.id, { x: entry.x, y: entry.y });
      entry.z = maxZ + 1 + index;
      const dom = elements.items.querySelector(
        `[data-item-id="${CSS.escape(entry.id)}"]`,
      );
      if (dom) {
        dom.style.zIndex = String(entry.z);
        dom.classList.add("is-dragging");
      }
    });
    dragging = {
      pointerId: event.pointerId,
      startWorld: point,
      starts,
      moved: false,
      lastWorld: point,
    };
    elements.viewport.setPointerCapture(event.pointerId);
  }

  function updateItemDrag(event) {
    if (!dragging) return;
    const point = worldPoint(event.clientX, event.clientY);
    dragging.lastWorld = point;
    const dx = point.x - dragging.startWorld.x;
    const dy = point.y - dragging.startWorld.y;
    dragging.moved = dragging.moved || Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;

    scheduleDragPaint(() => {
      for (const [id, start] of dragging.starts) {
        const item = state.items.find((entry) => entry.id === id);
        if (!item) continue;
        item.x = start.x + dx;
        item.y = start.y + dy;
        clampItem(item);
        const dom = elements.items.querySelector(
          `[data-item-id="${CSS.escape(id)}"]`,
        );
        if (dom) {
          dom.style.left = `${item.x}px`;
          dom.style.top = `${item.y}px`;
        }
      }
      renderConnections();
    });
  }

  async function endItemDrag(event) {
    if (!dragging) return;
    const moved = dragging.moved;
    for (const id of dragging.starts.keys()) {
      elements.items
        .querySelector(`[data-item-id="${CSS.escape(id)}"]`)
        ?.classList.remove("is-dragging");
    }
    const movedIds = [...dragging.starts.keys()];
    dragging = null;
    try {
      elements.viewport.releasePointerCapture(event.pointerId);
    } catch {}
    if (moved) {
      const stamp = nowIso();
      movedIds.forEach((id) => {
        const item = state.items.find((entry) => entry.id === id);
        if (item) item.updatedAt = stamp;
      });
      await saveState({ render: false });
    } else {
      history.pop();
    }
    renderSelectionPanel();
  }

  function beginResize(event, itemElement, item, axis = "x") {
    if (!canResizeItem(item)) return;
    event.preventDefault();
    event.stopPropagation();
    snapshot();
    const point = worldPoint(event.clientX, event.clientY);
    resizing = {
      pointerId: event.pointerId,
      id: item.id,
      axis,
      startWorld: point,
      startWidth: item.w || itemElement.offsetWidth || 320,
      startHeight:
        itemElement.offsetHeight || item.h || estimatedItemHeight(item),
      moved: false,
    };
    itemElement.classList.add("is-resizing");
    elements.viewport.setPointerCapture(event.pointerId);
  }

  function updateResize(event) {
    if (!resizing) return;
    const item = state.items.find((entry) => entry.id === resizing.id);
    if (!item) return;
    const point = worldPoint(event.clientX, event.clientY);
    const dx = point.x - resizing.startWorld.x;
    const dy = point.y - resizing.startWorld.y;
    const dom = elements.items.querySelector(
      `[data-item-id="${CSS.escape(item.id)}"]`,
    );

    if (item.type === "note") {
      if (resizing.axis === "x" || resizing.axis === "xy") {
        const nextWidth = clamp(resizing.startWidth + dx, 160, 1000);
        resizing.moved =
          resizing.moved || Math.abs(nextWidth - resizing.startWidth) > 0.5;
        item.w = nextWidth;
        if (dom) dom.style.width = `${nextWidth}px`;
      }
      if (resizing.axis === "y" || resizing.axis === "xy") {
        const nextHeight = clamp(resizing.startHeight + dy, 120, 1400);
        resizing.moved =
          resizing.moved || Math.abs(nextHeight - resizing.startHeight) > 0.5;
        item.h = nextHeight;
        if (dom) {
          dom.style.height = "auto";
          dom.style.minHeight = `${nextHeight}px`;
        }
      }
      scheduleDragPaint(renderConnections);
      return;
    }

    const nextWidth = clamp(resizing.startWidth + dx, 180, 1100);
    resizing.moved =
      resizing.moved || Math.abs(nextWidth - resizing.startWidth) > 0.5;
    item.w = nextWidth;
    if (dom) dom.style.width = `${nextWidth}px`;
    scheduleDragPaint(renderConnections);
  }

  async function endResize(event) {
    if (!resizing) return;
    const moved = resizing.moved;
    const resizedId = resizing.id;
    elements.items
      .querySelector(`[data-item-id="${CSS.escape(resizing.id)}"]`)
      ?.classList.remove("is-resizing");
    resizing = null;
    try {
      elements.viewport.releasePointerCapture(event.pointerId);
    } catch {}
    if (moved) {
      const item = state.items.find((entry) => entry.id === resizedId);
      if (item) item.updatedAt = nowIso();
      await saveState({ render: false });
    } else {
      history.pop();
    }
    renderSelectionPanel();
  }

  function setupRemoteRealtime() {
    if (!REMOTE_MODE || setupRemoteRealtime.done) return;
    setupRemoteRealtime.done = true;
    REMOTE.subscribe({
      onBoardChanged: async () => {
        try {
          const incoming = await REMOTE.loadBoard();
          if (incoming) {
            state = { ...initialBoardState(), ...incoming, version: 3 };
            renderBoard();
          }
        } catch {}
      },
      onAccountsChanged: async () => {
        if (session?.role === "admin") await refreshAccountsForAdmin();
        await enforceAccountStatus();
      },
    });
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    const accountId = String(formData.get("accountId") || "").trim();
    const code = String(formData.get("accessCode") || "").trim();

    if (!/^[A-Za-z0-9_-]{1,32}$/.test(accountId)) {
      elements.loginMessage.textContent =
        "플레이어 ID를 영문, 숫자, -, _ 조합으로 입력해 주세요.";
      return;
    }
    if (!/^[A-Za-z0-9]{1,32}$/.test(code)) {
      elements.loginMessage.textContent =
        "비밀번호는 영문 대소문자와 숫자만 사용해 1~32자리로 입력해 주세요.";
      return;
    }

    if (REMOTE_MODE) {
      elements.loginMessage.textContent = "접속 확인 중…";
      try {
        const account = await REMOTE.login(accountId, code);
        saveSession({
          accountId: account.accountId,
          name: account.displayName,
          role: account.role,
          mode: "supabase",
          loggedInAt: nowIso(),
        });
        elements.loginMessage.textContent = "";
        await enterBoard();
      } catch (error) {
        elements.loginMessage.textContent =
          error?.message || "ID 또는 비밀번호가 올바르지 않습니다.";
      }
      return;
    }

    const account = findAccountByCredentials(accountId, code);
    if (!account) {
      elements.loginMessage.textContent = "ID 또는 비밀번호가 올바르지 않습니다.";
      return;
    }
    if (account.blocked) {
      elements.loginMessage.textContent = "차단된 계정입니다.";
      return;
    }
    saveLocalSessionFromAccount(account);
    elements.loginMessage.textContent = "";
    await enterBoard();
  });

  elements.viewport.addEventListener("pointerdown", (event) => {
    if (!currentSessionValid()) {
      enforceAccountStatus();
      return;
    }

    const resizeHandle = event.target.closest("[data-resize-item]");
    const itemElement = event.target.closest("[data-item-id]");
    const connectionElement = event.target.closest("[data-connection-id]");

    if (event.button === 1) {
      event.preventDefault();
      panning = {
        x: event.clientX,
        y: event.clientY,
        panX: pan.x,
        panY: pan.y,
        pointerId: event.pointerId,
      };
      elements.viewport.classList.add("is-panning");
      elements.viewport.setPointerCapture(event.pointerId);
      return;
    }

    if (resizeHandle && itemElement) {
      const item = state.items.find(
        (entry) => entry.id === resizeHandle.dataset.resizeItem,
      );
      if (item)
        beginResize(
          event,
          itemElement,
          item,
          resizeHandle.dataset.resizeAxis || "x",
        );
      return;
    }

    if ((tool === "hand" || spaceDown) && !itemElement) {
      panning = {
        x: event.clientX,
        y: event.clientY,
        panX: pan.x,
        panY: pan.y,
        pointerId: event.pointerId,
      };
      elements.viewport.classList.add("is-panning");
      elements.viewport.setPointerCapture(event.pointerId);
      return;
    }

    if (connectionElement) {
      selectedIds.clear();
      selected = {
        type: "connection",
        id: connectionElement.dataset.connectionId,
      };
      updateSelectionClasses();
      renderSelectionPanel();
      renderConnections();
      return;
    }

    if (!itemElement) {
      if (tool === "select") {
        beginMarquee(event);
      } else {
        selected = null;
        selectedIds.clear();
        renderSelectionPanel();
      }
      return;
    }

    const id = itemElement.dataset.itemId;
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;

    if (tool === "connect") {
      if (!connectSource) {
        connectSource = id;
        selectedIds = new Set([id]);
        selected = { type: "item", id };
        showToast("붉은 선으로 연결할 두 번째 항목을 선택하세요.");
        renderBoard();
      } else {
        createConnection(connectSource, id);
      }
      return;
    }

    if (tool !== "select") return;

    if (event.shiftKey) {
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      selected =
        selectedIds.size === 1
          ? { type: "item", id: [...selectedIds][0] }
          : null;
      updateSelectionClasses();
      renderSelectionPanel();
      return;
    }

    if (!selectedIds.has(id)) setSingleItemSelection(id);
    else {
      selected = selectedIds.size === 1 ? { type: "item", id } : null;
      renderSelectionPanel();
    }
    beginItemDrag(event, itemElement, item);
  });

  elements.viewport.addEventListener("pointermove", (event) => {
    if (panning) {
      pan.x = panning.panX + (event.clientX - panning.x);
      pan.y = panning.panY + (event.clientY - panning.y);
      applyTransform();
      return;
    }
    if (resizing) {
      updateResize(event);
      return;
    }
    if (dragging) {
      updateItemDrag(event);
      return;
    }
    if (marquee) updateMarquee(event);
  });

  elements.viewport.addEventListener("pointerup", async (event) => {
    if (panning) {
      panning = null;
      elements.viewport.classList.remove("is-panning");
      try {
        elements.viewport.releasePointerCapture(event.pointerId);
      } catch {}
      return;
    }
    if (resizing) {
      await endResize(event);
      return;
    }
    if (dragging) {
      await endItemDrag(event);
      return;
    }
    if (marquee) endMarquee(event);
  });

  elements.viewport.addEventListener("pointercancel", async (event) => {
    if (resizing) await endResize(event);
    if (dragging) await endItemDrag(event);
    if (marquee) endMarquee(event);
    panning = null;
    elements.viewport.classList.remove("is-panning");
  });

  elements.viewport.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });

  elements.viewport.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomAt(
          pan.scale * (event.deltaY > 0 ? 0.9 : 1.1),
          event.clientX,
          event.clientY,
        );
      } else {
        event.preventDefault();
        pan.x -= event.deltaX;
        pan.y -= event.deltaY;
        applyTransform();
      }
    },
    { passive: false },
  );

  elements.items.addEventListener("dblclick", (event) => {
    const item = event.target.closest("[data-item-id]");
    if (!item) return;
    setSingleItemSelection(item.dataset.itemId);
  });

  elements.items.addEventListener("click", async (event) => {
    const attachment = event.target.closest(
      "[data-download-attachment], [data-download-path]",
    );
    if (!attachment) return;
    await downloadAttachment(attachment);
  });

  elements.selectionPanel.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "delete-selected") deleteSelected();
    if (
      action === "toggle-lock" &&
      selected?.type === "item" &&
      session?.role === "admin"
    ) {
      const item = state.items.find((entry) => entry.id === selected.id);
      if (!item || !isLockableImage(item)) return;
      snapshot();
      item.locked = !item.locked;
      item.lockedBy = item.locked ? session.accountId : null;
      item.lockedAt = item.locked ? nowIso() : null;
      item.updatedAt = nowIso();
      showToast(
        item.locked
          ? "이미지를 잠갔습니다. 플레이어는 이동하거나 삭제할 수 없습니다."
          : "이미지 잠금을 해제했습니다.",
      );
      saveState();
      return;
    }
    if (action === "save-item" && selected?.type === "item") {
      const item = state.items.find((entry) => entry.id === selected.id);
      if (!item || !canEditItem(item)) return;
      snapshot();
      if ($("#editTitle")) item.title = $("#editTitle").value.trim();
      if ($("#editBody")) item.body = $("#editBody").value.trim();
      item.updatedAt = nowIso();
      saveState();
    }
    if (action === "save-connection" && selected?.type === "connection") {
      const connection = state.connections.find(
        (entry) => entry.id === selected.id,
      );
      if (!connection || !canDeleteConnection(connection)) return;
      snapshot();
      connection.label = $("#connectionLabelInput").value.trim();
      connection.updatedAt = nowIso();
      saveState();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (
      ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
    )
      return;
    if (event.code === "Space") {
      spaceDown = true;
      event.preventDefault();
    }
    if (event.key === "v" || event.key === "V") setTool("select");
    if (event.key === "h" || event.key === "H") setTool("hand");
    if (event.key === "c" || event.key === "C") setTool("connect");
    if (event.key === "Delete" || event.key === "Backspace") deleteSelected();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    }
  });
  document.addEventListener("keyup", (event) => {
    if (event.code === "Space") spaceDown = false;
  });

  $$("[data-tool]").forEach((button) =>
    button.addEventListener("click", () => setTool(button.dataset.tool)),
  );
  $("#addEvidenceButton").addEventListener("click", () => openEvidenceModal());
  $("#addNoteButton").addEventListener("click", openNoteModal);
  $("#addStickerButton").addEventListener("click", openStickerModal);
  $("#addPhotoStickerButton").addEventListener("click", openPhotoStickerModal);
  $("#deleteButton").addEventListener("click", deleteSelected);
  $("#playerManagerButton").addEventListener("click", openPlayerManager);
  $("#addOfficialButton").addEventListener("click", () =>
    openEvidenceModal({ official: true }),
  );
  $("#helpButton").addEventListener("click", openHelpModal);
  $("#logoutButton").addEventListener("click", async () => {
    if (REMOTE_MODE) await REMOTE.logout?.();
    clearSession();
    showLogin("");
  });

  $("#zoomOutButton").addEventListener("click", () => {
    const rect = elements.viewport.getBoundingClientRect();
    zoomAt(
      pan.scale * 0.85,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
  });
  $("#zoomInButton").addEventListener("click", () => {
    const rect = elements.viewport.getBoundingClientRect();
    zoomAt(
      pan.scale * 1.15,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
  });
  $("#zoomResetButton").addEventListener("click", () => {
    pan.scale = 1;
    applyTransform();
  });
  $("#zoomFitButton").addEventListener("click", fitBoard);

  elements.boardTitle.addEventListener("change", () => {
    if (session.role !== "admin") {
      elements.boardTitle.value = state.boardTitle;
      showToast("보드 이름은 관리자만 변경할 수 있습니다.");
      return;
    }
    snapshot();
    state.boardTitle =
      elements.boardTitle.value.trim() || "공동 사건 조사 보드";
    saveState();
  });

  elements.modalBackdrop.addEventListener("click", (event) => {
    if (event.target === elements.modalBackdrop) closeModal();
  });

  elements.modal.addEventListener("click", async (event) => {
    if (event.target.closest("[data-close-modal]")) {
      closeModal();
      return;
    }
    if (event.target.closest("[data-back-player-manager]")) {
      await openPlayerManager();
      return;
    }

    const swatch = event.target.closest("[data-note-color]");
    if (swatch) {
      $$("[data-note-color]", elements.modal).forEach((button) =>
        button.classList.toggle("is-selected", button === swatch),
      );
      $('[name="color"]', elements.modal).value = swatch.dataset.noteColor;
      return;
    }

    const sticker = event.target.closest("[data-sticker]");
    if (sticker) {
      $$("[data-sticker]", elements.modal).forEach((button) =>
        button.classList.toggle("is-selected", button === sticker),
      );
      $('[name="emoji"]', elements.modal).value = sticker.dataset.sticker;
      return;
    }

    const passwordButton = event.target.closest("[data-account-password]");
    if (passwordButton && session.role === "admin") {
      openPasswordModal(passwordButton.dataset.accountPassword);
      return;
    }

    const accountToggle = event.target.closest("[data-account-toggle]");
    if (accountToggle && session.role === "admin") {
      try {
        await toggleAccountBlocked(accountToggle.dataset.accountToggle);
        await openPlayerManager();
      } catch (error) {
        showToast(error?.message || "접속 상태 변경에 실패했습니다.");
      }
      return;
    }
  });

  elements.modal.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.id === "evidenceForm") await addEvidence(event.target);
    if (event.target.id === "noteForm") addNote(event.target);
    if (event.target.id === "stickerForm") addSticker(event.target);
    if (event.target.id === "photoStickerForm")
      await addPhotoSticker(event.target);
    if (event.target.id === "passwordForm" && session.role === "admin") {
      const fd = new FormData(event.target);
      const accountId = String(fd.get("accountId") || "");
      const password = String(fd.get("password") || "").trim();
      const confirmPassword = String(fd.get("passwordConfirm") || "").trim();
      if (password !== confirmPassword) {
        showToast("비밀번호가 서로 다릅니다.");
        return;
      }
      try {
        await setAccountPassword(accountId, password);
        showToast("비밀번호를 저장했습니다.");
        await openPlayerManager();
      } catch (error) {
        showToast(error?.message || "비밀번호 저장에 실패했습니다.");
      }
    }
  });

  if (channel) {
    channel.addEventListener("message", (event) => {
      if (event.data?.sender === session?.accountId) return;
      if (event.data?.type === "state") {
        state = { ...initialBoardState(), ...event.data.state, version: 3 };
        elements.syncStatus.textContent = "반영됨";
        renderBoard();
        setTimeout(() => {
          if (elements.syncStatus) elements.syncStatus.textContent = "저장됨";
        }, 700);
      }
      if (event.data?.type === "accounts") {
        accounts = Array.isArray(event.data.accounts)
          ? event.data.accounts
          : loadLocalAccounts();
        enforceAccountStatus();
      }
    });
  }

  window.addEventListener("storage", (event) => {
    if (REMOTE_MODE) return;
    if (event.key === BOARD_KEY && event.newValue) {
      try {
        state = {
          ...initialBoardState(),
          ...JSON.parse(event.newValue),
          version: 3,
        };
        renderBoard();
      } catch {}
    }
    if (event.key === ACCOUNTS_KEY && event.newValue) {
      try {
        accounts = JSON.parse(event.newValue);
      } catch {
        accounts = loadLocalAccounts();
      }
      enforceAccountStatus();
    }
  });

  window.addEventListener("beforeunload", () => {
    for (const [key, url] of imageUrlCache) {
      if (key.startsWith("local:")) {
        try {
          URL.revokeObjectURL(url);
        } catch {}
      }
    }
  });

  async function bootstrap() {
    if (REMOTE_MODE) {
      try {
        const restored = await REMOTE.restoreSession();
        if (restored) {
          saveSession({
            accountId: restored.accountId,
            name: restored.displayName,
            role: restored.role,
            mode: "supabase",
            loggedInAt: session?.loggedInAt || nowIso(),
          });
          await enterBoard();
          return;
        }
      } catch {}
      clearSession();
      showLogin("");
      return;
    }

    if (localSessionValid()) await enterBoard();
    else showLogin("");
  }

  bootstrap();
})();
