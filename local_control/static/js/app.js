(() => {
  const loginView = document.getElementById("login-view");
  const controlView = document.getElementById("control-view");
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");
  const statusUser = document.getElementById("status-user");
  const logoutButton = document.getElementById("logout-button");
  const lockButton = document.getElementById("lock-button");
  const unlockButton = document.getElementById("unlock-button");
  const shutdownButton = document.getElementById("shutdown-button");
  const clickButtons = document.querySelectorAll("[data-click]");
  const trackpad = document.getElementById("trackpad");
  const typeInput = document.getElementById("type-input");
  const typeForm = document.getElementById("type-form");
  const realtimeInput = document.getElementById("realtime-input");

  let authenticated = false;
  const EDGE_RELEASE_RATIO = 0.05;
  const EDGE_RELEASE_DELAY_MS = 100;
  const EDGE_BUFFER_PX = 2;
  let lastRemoteState = null;
  let edgeAccumulators = { left: 0, right: 0, top: 0, bottom: 0 };
  let edgeReleaseTimer = null;
  let lastClickInfo = { time: 0, button: "left" };
  const activeKeys = new Set();
  const touches = new Map();
  let touchSession = null;
  let pendingScroll = { horizontal: 0, vertical: 0 };
  let scrollFrameQueued = false;
  const specialKeys = new Map([
    ["Enter", "enter"],
    ["Backspace", "backspace"],
    ["Tab", "tab"],
    ["Escape", "esc"],
    ["ArrowUp", "up"],
    ["ArrowDown", "down"],
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"],
    ["Delete", "delete"],
    ["Home", "home"],
    ["End", "end"],
    ["PageUp", "pageup"],
    ["PageDown", "pagedown"],
  ]);
  const modifierKeys = new Map([
    ["Shift", "shift"],
    ["Control", "ctrl"],
    ["Alt", "alt"],
    ["Meta", "command"],
  ]);
  const heldModifiers = new Set();
  const modifierTimers = new Map();
  const TOUCH_MOVE_BASE = 0.9;
  const TOUCH_MOVE_MIN = 1.6;
  const TOUCH_MOVE_MAX = 10;
  const TOUCH_SCROLL_MIN = 1.5;
  const TOUCH_SCROLL_MAX = 6;
  const MULTI_TAP_TIME_MS = 260;
  const MULTI_TAP_TRAVEL_THRESHOLD = 95;

  async function api(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "same-origin",
      body: JSON.stringify(payload ?? {}),
    });

    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      // no-op, keep default empty object
    }
    if (!response.ok) {
      const message = data.error || response.statusText;
      throw new Error(message);
    }
    return data;
  }

  function isPointerLocked() {
    return document.pointerLockElement === trackpad;
  }

  function setPointerSyncState(active) {
    if (!trackpad) return;
    trackpad.classList.toggle("pointer-sync", Boolean(active));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function computeTouchMoveScale() {
    if (!trackpad) return TOUCH_MOVE_MIN;
    const rect = trackpad.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return TOUCH_MOVE_MIN;
    }
    const remoteWidth = lastRemoteState ? Number(lastRemoteState.width) : null;
    const remoteHeight = lastRemoteState ? Number(lastRemoteState.height) : null;
    if (!remoteWidth || !remoteHeight) {
      const viewport = Math.max(window.innerWidth, window.innerHeight) || rect.width;
      const base = viewport / Math.max(rect.width, rect.height);
      return clamp(base * TOUCH_MOVE_BASE, TOUCH_MOVE_MIN, TOUCH_MOVE_MAX);
    }
    const scaleX = remoteWidth / rect.width;
    const scaleY = remoteHeight / rect.height;
    const weighted = Math.max(scaleX, scaleY) * TOUCH_MOVE_BASE;
    return clamp(weighted, TOUCH_MOVE_MIN, TOUCH_MOVE_MAX);
  }

  function computeTouchScrollScale() {
    const moveScale = computeTouchMoveScale();
    return clamp(moveScale * 0.45, TOUCH_SCROLL_MIN, TOUCH_SCROLL_MAX);
  }

  function queueScrollFlush() {
    if (scrollFrameQueued) return;
    scrollFrameQueued = true;
    requestAnimationFrame(flushScroll);
  }

  function flushScroll() {
    scrollFrameQueued = false;
    if (!authenticated) return;
    if (
      Math.abs(pendingScroll.horizontal) < 0.01 &&
      Math.abs(pendingScroll.vertical) < 0.01
    ) {
      pendingScroll = { horizontal: 0, vertical: 0 };
      return;
    }
    const payload = {
      horizontal: pendingScroll.horizontal,
      vertical: pendingScroll.vertical,
    };
    pendingScroll = { horizontal: 0, vertical: 0 };
    api("/api/mouse/scroll", payload).catch((err) =>
      console.error("Touch scroll failed", err)
    );
  }

  function cancelEdgeRelease() {
    if (edgeReleaseTimer) {
      clearTimeout(edgeReleaseTimer);
      edgeReleaseTimer = null;
    }
  }

  function resetEdgeTracking() {
    edgeAccumulators = { left: 0, right: 0, top: 0, bottom: 0 };
    cancelEdgeRelease();
  }

  function scheduleEdgeRelease() {
    if (edgeReleaseTimer) return;
    edgeReleaseTimer = setTimeout(() => {
      edgeReleaseTimer = null;
      if (isPointerLocked() && typeof document.exitPointerLock === "function") {
        try {
          document.exitPointerLock();
        } catch (err) {
          console.warn("Failed to exit pointer lock", err);
        }
      }
      resetEdgeTracking();
      releaseAllActiveKeys();
      releaseAllModifiers();
    }, EDGE_RELEASE_DELAY_MS);
  }

  function normalizeKeyForAction(key) {
    if (!key) return null;
    if (key.length === 1) {
      const digitShiftMap = {
        "!": "1",
        "@": "2",
        "#": "3",
        "$": "4",
        "%": "5",
        "^": "6",
        "&": "7",
        "*": "8",
        "(": "9",
        ")": "0",
      };

      if (digitShiftMap[key]) {
        return digitShiftMap[key];
      }

      if (key === " ") {
        return "space";
      }

      const punctuationMap = {
        "-": "minus",
        "_": "minus",
        "=": "equals",
        "+": "equals",
        "[": "leftbracket",
        "{": "leftbracket",
        "]": "rightbracket",
        "}": "rightbracket",
        "\\": "backslash",
        "|": "backslash",
        ";": "semicolon",
        ":": "semicolon",
        "'": "quote",
        '"': "quote",
        ",": "comma",
        "<": "comma",
        ".": "period",
        ">": "period",
        "/": "slash",
        "?": "slash",
        "`": "grave",
        "~": "grave",
      };

      if (punctuationMap[key]) {
        return punctuationMap[key];
      }

      const lower = key.toLowerCase();
      if ((lower >= "a" && lower <= "z") || (lower >= "0" && lower <= "9")) {
        return lower;
      }
      return null;
    }

    if (key === "Spacebar") {
      return "space";
    }

    return null;
  }

  function releaseAllActiveKeys() {
    if (!activeKeys.size) return;
    for (const key of activeKeys) {
      api("/api/keyboard/key", { key, action: "up" }).catch((err) =>
        console.error("Release key failed", err)
      );
    }
    activeKeys.clear();
  }

  function clearModifierTimer(key) {
    const timer = modifierTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      modifierTimers.delete(key);
    }
  }

  function scheduleModifierTimer(key) {
    clearModifierTimer(key);
    const timer = setTimeout(() => {
      modifierTimers.delete(key);
      if (!heldModifiers.has(key)) return;
      heldModifiers.delete(key);
      api("/api/keyboard/key", { key, action: "up" }).catch((err) =>
        console.error("Auto-release modifier failed", err)
      );
    }, 8000);
    modifierTimers.set(key, timer);
  }

  function modifierDown(key) {
    if (!heldModifiers.has(key)) {
      heldModifiers.add(key);
      api("/api/keyboard/key", { key, action: "down" }).catch((err) =>
        console.error("Modifier down failed", err)
      );
    }
    scheduleModifierTimer(key);
  }

  function modifierUp(key) {
    if (!heldModifiers.has(key)) return;
    heldModifiers.delete(key);
    clearModifierTimer(key);
    api("/api/keyboard/key", { key, action: "up" }).catch((err) =>
      console.error("Modifier up failed", err)
    );
  }

  function releaseAllModifiers() {
    if (!heldModifiers.size) return;
    const keys = Array.from(heldModifiers);
    keys.forEach((key) => modifierUp(key));
  }

  function handleRemoteState(state, movement) {
    if (!state || typeof state !== "object") {
      return;
    }
    lastRemoteState = state;
    lastMovementVector = movement || null;
    const width = Number(state.width) || 0;
    const height = Number(state.height) || 0;
    if (width <= 0 || height <= 0) {
      resetEdgeTracking();
      return;
    }
    const x = Number(state.x) || 0;
    const y = Number(state.y) || 0;
    if (!isPointerLocked()) {
      resetEdgeTracking();
      return;
    }

    const atLeft = x <= EDGE_BUFFER_PX;
    const atRight = x >= width - EDGE_BUFFER_PX;
    const atTop = y <= EDGE_BUFFER_PX;
    const atBottom = y >= height - EDGE_BUFFER_PX;
    const thresholdX = Math.max(width * EDGE_RELEASE_RATIO, EDGE_BUFFER_PX);
    const thresholdY = Math.max(height * EDGE_RELEASE_RATIO, EDGE_BUFFER_PX);

    const moveX = movement ? Number(movement.dx || 0) : 0;
    const moveY = movement ? Number(movement.dy || 0) : 0;
    let releaseReady = false;

    if (atLeft) {
      if (moveX < 0) {
        edgeAccumulators.left = Math.min(edgeAccumulators.left + Math.abs(moveX), thresholdX);
        if (edgeAccumulators.left >= thresholdX) {
          releaseReady = true;
        }
      } else if (moveX > 0) {
        edgeAccumulators.left = 0;
      }
    } else {
      edgeAccumulators.left = 0;
    }

    if (atRight) {
      if (moveX > 0) {
        edgeAccumulators.right = Math.min(edgeAccumulators.right + Math.abs(moveX), thresholdX);
        if (edgeAccumulators.right >= thresholdX) {
          releaseReady = true;
        }
      } else if (moveX < 0) {
        edgeAccumulators.right = 0;
      }
    } else {
      edgeAccumulators.right = 0;
    }

    if (atTop) {
      if (moveY < 0) {
        edgeAccumulators.top = Math.min(edgeAccumulators.top + Math.abs(moveY), thresholdY);
        if (edgeAccumulators.top >= thresholdY) {
          releaseReady = true;
        }
      } else if (moveY > 0) {
        edgeAccumulators.top = 0;
      }
    } else {
      edgeAccumulators.top = 0;
    }

    if (atBottom) {
      if (moveY > 0) {
        edgeAccumulators.bottom = Math.min(edgeAccumulators.bottom + Math.abs(moveY), thresholdY);
        if (edgeAccumulators.bottom >= thresholdY) {
          releaseReady = true;
        }
      } else if (moveY < 0) {
        edgeAccumulators.bottom = 0;
      }
    } else {
      edgeAccumulators.bottom = 0;
    }

    if (!releaseReady) {
      releaseReady =
        (atLeft && edgeAccumulators.left >= thresholdX) ||
        (atRight && edgeAccumulators.right >= thresholdX) ||
        (atTop && edgeAccumulators.top >= thresholdY) ||
        (atBottom && edgeAccumulators.bottom >= thresholdY);
    }

    if (releaseReady) {
      scheduleEdgeRelease();
    } else {
      cancelEdgeRelease();
    }
  }

  async function refreshState() {
    try {
      const res = await fetch("/api/mouse/state", { credentials: "same-origin" });
      if (!res.ok) return;
      const data = await res.json();
      handleRemoteState(data.state, null);
    } catch (err) {
      console.warn("Failed to refresh pointer state", err);
    }
  }

  function showControl(username) {
    authenticated = true;
    statusUser.textContent = username;
    controlView.hidden = false;
    loginView.hidden = true;
    loginError.textContent = "";
    if (realtimeInput) {
      realtimeInput.focus();
      realtimeInput.select();
    } else if (typeInput) {
      typeInput.focus();
      typeInput.select();
    }
    refreshState();
  }

  function showLogin() {
    authenticated = false;
    controlView.hidden = true;
    loginView.hidden = false;
    loginForm.reset();
    if (realtimeInput) {
      realtimeInput.value = "";
    }
    if (typeInput) {
      typeInput.value = "";
    }
    loginError.textContent = "";
    if (isPointerLocked()) {
      try {
        document.exitPointerLock();
      } catch (err) {
        console.warn("Failed to exit pointer lock", err);
      }
    }
    releaseAllActiveKeys();
    releaseAllModifiers();
  }

  async function checkSession() {
    try {
      const res = await fetch("/api/session", { credentials: "same-origin" });
      const data = await res.json();
      if (data.authenticated) {
        showControl(data.username);
      } else {
        showLogin();
      }
    } catch (err) {
      console.error("Failed to check session", err);
      showLogin();
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const remember = document.getElementById("remember").checked;

    try {
      const data = await api("/api/login", { username, password, remember });
      showControl(data.username);
    } catch (err) {
      loginError.textContent = err.message;
    }
  });

  logoutButton.addEventListener("click", async () => {
    try {
      await api("/api/logout", {});
    } catch (err) {
      console.warn("Logout failed", err);
    } finally {
      showLogin();
    }
  });

  clickButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (!authenticated) return;
      const type = button.dataset.click;
      const payload =
        type === "double"
          ? { button: "left", double: true }
          : { button: type };
      api("/api/mouse/click", payload).catch((err) =>
        console.error("Click failed", err)
      );
    });
  });

  lockButton.addEventListener("click", () => {
    if (!authenticated) return;
    api("/api/system/lock").catch((err) => alert(err.message));
  });

  if (unlockButton) {
    unlockButton.addEventListener("click", () => {
      if (!authenticated) return;
      api("/api/system/unlock").catch((err) => alert(err.message));
    });
  }

  shutdownButton.addEventListener("click", () => {
    if (!authenticated) return;
    const confirmShutdown = confirm(
      "Shutdown the host computer immediately? Unsaved work will be lost."
    );
    if (!confirmShutdown) return;
    api("/api/system/shutdown").catch((err) => alert(err.message));
  });

  // Trackpad handling -------------------------------------------------------
  let pointerActive = false;
  let lastPoint = { x: 0, y: 0 };
  let pendingDelta = { x: 0, y: 0 };
  let frameQueued = false;
  let tapCandidate = null;

  function queueFlush() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(flushMovement);
  }

  function flushMovement() {
    frameQueued = false;
    if (!authenticated) return;
    if (pendingDelta.x === 0 && pendingDelta.y === 0) return;
    const payload = { dx: pendingDelta.x, dy: pendingDelta.y };
    pendingDelta = { x: 0, y: 0 };
    api("/api/mouse/move", payload)
      .then((data) => {
        handleRemoteState(data.state, payload);
      })
      .catch((err) => console.error("Move failed", err));
  }

  function pointerDown(event) {
    if (!authenticated) return;
    pointerActive = true;
    lastPoint = { x: event.clientX, y: event.clientY };
    if (event.pointerType === "touch") {
      trackpad.setPointerCapture(event.pointerId);
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!touchSession) {
        touchSession = {
          startTime: performance.now(),
          maxPointers: touches.size,
          totalTravel: 0,
          lastPositions: new Map([[event.pointerId, { x: event.clientX, y: event.clientY }]]),
        };
      } else {
        touchSession.maxPointers = Math.max(touchSession.maxPointers, touches.size);
        touchSession.lastPositions.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (touches.size > 1) {
        tapCandidate = null;
      } else {
        tapCandidate = {
          startX: event.clientX,
          startY: event.clientY,
          time: performance.now(),
        };
      }
      event.preventDefault();
      return;
    }
    if (event.pointerType === "mouse") {
      tapCandidate = null;
      if (typeof trackpad.requestPointerLock === "function") {
        try {
          trackpad.requestPointerLock();
        } catch (err) {
          console.warn("Pointer lock request failed", err);
        }
      } else {
        trackpad.setPointerCapture(event.pointerId);
      }
    } else {
      tapCandidate = {
        startX: event.clientX,
        startY: event.clientY,
        time: performance.now(),
      };
      trackpad.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  }

  function pointerMove(event) {
    if (!pointerActive) return;
    if (event.shiftKey && heldModifiers.has("shift")) {
      scheduleModifierTimer("shift");
    }
    if (event.ctrlKey && heldModifiers.has("ctrl")) {
      scheduleModifierTimer("ctrl");
    }
    if (event.altKey && heldModifiers.has("alt")) {
      scheduleModifierTimer("alt");
    }
    if (event.metaKey && heldModifiers.has("command")) {
      scheduleModifierTimer("command");
    }
    if (event.pointerType === "touch") {
      const current = touches.get(event.pointerId);
      if (!current) {
        event.preventDefault();
        return;
      }
      const dxRaw = event.clientX - current.x;
      const dyRaw = event.clientY - current.y;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchSession) {
        touchSession.totalTravel += Math.abs(dxRaw) + Math.abs(dyRaw);
        touchSession.lastPositions.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
        touchSession.maxPointers = Math.max(touchSession.maxPointers, touches.size);
      }
      if (Math.abs(dxRaw) < 0.01 && Math.abs(dyRaw) < 0.01) {
        event.preventDefault();
        return;
      }
      if (touches.size >= 2) {
        const scrollScale = computeTouchScrollScale();
        pendingScroll.horizontal += dxRaw * scrollScale;
        pendingScroll.vertical += -dyRaw * scrollScale;
        queueScrollFlush();
      } else {
        const moveScale = computeTouchMoveScale();
        pendingDelta.x += dxRaw * moveScale;
        pendingDelta.y += dyRaw * moveScale;
        queueFlush();
      }
      event.preventDefault();
      return;
    }
    let dx = 0;
    let dy = 0;
    if (isPointerLocked()) {
      dx = event.movementX;
      dy = event.movementY;
    } else {
      dx = event.clientX - lastPoint.x;
      dy = event.clientY - lastPoint.y;
      lastPoint = { x: event.clientX, y: event.clientY };
    }
    if (dx === 0 && dy === 0) return;
    pendingDelta.x += dx;
    pendingDelta.y += dy;
    queueFlush();
    event.preventDefault();
  }

  function pointerUp(event) {
    if (!pointerActive && event.pointerType !== "touch") return;
    let handledGesture = false;
    if (event.pointerType === "touch") {
      if (trackpad.hasPointerCapture && trackpad.hasPointerCapture(event.pointerId)) {
        trackpad.releasePointerCapture(event.pointerId);
      }
      touches.delete(event.pointerId);
      if (touchSession) {
        touchSession.lastPositions.delete(event.pointerId);
      }
      const remaining = touches.size;
      if (touchSession && remaining === 0) {
        const duration = performance.now() - touchSession.startTime;
        const travel = touchSession.totalTravel;
        const maxPointers = touchSession.maxPointers;
        touchSession = null;
        if (maxPointers === 2 && duration < MULTI_TAP_TIME_MS && travel < MULTI_TAP_TRAVEL_THRESHOLD) {
          api("/api/mouse/click", { button: "right" }).catch((err) =>
            console.error("Two-finger tap failed", err)
          );
          handledGesture = true;
        } else if (
          maxPointers === 3 &&
          duration < MULTI_TAP_TIME_MS &&
          travel < MULTI_TAP_TRAVEL_THRESHOLD
        ) {
          api("/api/mouse/click", { button: "middle" }).catch((err) =>
            console.error("Three-finger tap failed", err)
          );
          handledGesture = true;
        }
      } else if (touchSession) {
        touchSession.maxPointers = Math.max(touchSession.maxPointers, remaining);
      }
      if (remaining > 0) {
        pointerActive = true;
        tapCandidate = null;
        event.preventDefault();
        return;
      }
    }
    if (!isPointerLocked()) {
      pointerActive = event.pointerType === "touch" ? touches.size > 0 : false;
      if (trackpad.hasPointerCapture && trackpad.hasPointerCapture(event.pointerId)) {
        trackpad.releasePointerCapture(event.pointerId);
      }
      if (tapCandidate && !handledGesture) {
        const dt = performance.now() - tapCandidate.time;
        const dist =
          Math.abs(event.clientX - tapCandidate.startX) +
          Math.abs(event.clientY - tapCandidate.startY);
        if (dt < 220 && dist < 20) {
          api("/api/mouse/click", { button: "left" }).catch((err) =>
            console.error("Tap failed", err)
          );
        }
      }
      if (event.pointerType !== "touch" || touches.size === 0) {
        releaseAllActiveKeys();
        releaseAllModifiers();
      }
    }
    if (event.pointerType === "mouse") {
      const buttonMap = {
        0: "left",
        2: "right",
      };
      const button = buttonMap[event.button];
      if (!button) {
        tapCandidate = null;
        event.preventDefault();
        return;
      }
      const now = performance.now();
      const isDouble =
        lastClickInfo.button === button && now - lastClickInfo.time < 320;
      lastClickInfo = { time: now, button };
      api("/api/mouse/click", { button, double: isDouble && button === "left" }).catch(
        (err) => console.error("Mouse click failed", err),
      );
    }
    tapCandidate = null;
    event.preventDefault();
  }

  trackpad.addEventListener(
    "wheel",
    (event) => {
      if (!authenticated) return;
      event.preventDefault();
      const horizontal = event.deltaX;
      const vertical = -event.deltaY;
      if (!horizontal && !vertical) return;
      api("/api/mouse/scroll", { horizontal, vertical }).catch((err) =>
        console.error("Scroll failed", err),
      );
    },
    { passive: false },
  );

  trackpad.addEventListener("pointerdown", pointerDown);
  trackpad.addEventListener("pointermove", pointerMove);
  trackpad.addEventListener("pointerup", pointerUp);
  trackpad.addEventListener("pointercancel", pointerUp);
  trackpad.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  document.addEventListener("pointerlockchange", () => {
    if (isPointerLocked()) {
      pointerActive = true;
      resetEdgeTracking();
      refreshState();
      activeKeys.clear();
      releaseAllModifiers();
      setPointerSyncState(true);
    } else {
      pointerActive = false;
      pendingDelta = { x: 0, y: 0 };
      lastPoint = { x: 0, y: 0 };
      resetEdgeTracking();
      releaseAllActiveKeys();
      releaseAllModifiers();
      setPointerSyncState(false);
    }
  });

  document.addEventListener("pointerlockerror", (event) => {
    console.warn("Pointer lock error", event);
    pointerActive = false;
    releaseAllActiveKeys();
    releaseAllModifiers();
    setPointerSyncState(false);
  });

  window.addEventListener("blur", () => {
    if (!authenticated) return;
    releaseAllActiveKeys();
    releaseAllModifiers();
    if (isPointerLocked()) {
      try {
        document.exitPointerLock();
      } catch (err) {
        console.warn("Failed to exit pointer lock on blur", err);
      }
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!authenticated || !document.hidden) return;
    releaseAllActiveKeys();
    releaseAllModifiers();
    if (isPointerLocked()) {
      try {
        document.exitPointerLock();
      } catch (err) {
        console.warn("Failed to exit pointer lock on hide", err);
      }
    }
    setPointerSyncState(false);
  });

  // Keyboard handling -------------------------------------------------------
  if (realtimeInput) {
    realtimeInput.addEventListener("input", (event) => {
      if (!authenticated) {
        event.target.value = "";
        return;
      }
      const inputType = event.inputType;
      const text = event.target.value;
      if (inputType === "deleteContentBackward") {
        api("/api/keyboard/key", { key: "backspace", action: "press" }).catch(
          (err) => console.error("Realtime backspace failed", err),
        );
      } else if (inputType === "deleteContentForward") {
        api("/api/keyboard/key", { key: "delete", action: "press" }).catch(
          (err) => console.error("Realtime delete failed", err),
        );
      } else if (inputType === "insertLineBreak") {
        api("/api/keyboard/key", { key: "enter", action: "press" }).catch(
          (err) => console.error("Realtime enter failed", err),
        );
      } else if (text) {
        api("/api/keyboard/type", { text }).catch((err) =>
          console.error("Realtime type failed", err),
        );
      }
      event.target.value = "";
    });

    realtimeInput.addEventListener("compositionend", (event) => {
      if (!authenticated) {
        realtimeInput.value = "";
        return;
      }
      const data = event.data || realtimeInput.value;
      if (data) {
        api("/api/keyboard/type", { text: data }).catch((err) =>
          console.error("Realtime composition failed", err),
        );
      }
      realtimeInput.value = "";
    });

    realtimeInput.addEventListener("keydown", (event) => {
      if (!authenticated) return;
      if (modifierKeys.has(event.key)) {
        const mapped = modifierKeys.get(event.key);
        modifierDown(mapped);
        event.preventDefault();
        return;
      }

      if (specialKeys.has(event.key)) {
        const key = specialKeys.get(event.key);
        api("/api/keyboard/key", { key, action: "press" }).catch((err) =>
          console.error("Realtime special key failed", err),
        );
        event.preventDefault();
        return;
      }

      const normalized = normalizeKeyForAction(event.key);
      const usingCombo =
        normalized && (event.ctrlKey || event.metaKey || event.altKey);
      if (usingCombo) {
        if (!event.repeat) {
          api("/api/keyboard/key", { key: normalized, action: "press" }).catch(
            (err) => console.error("Realtime combo press failed", err),
          );
        }
        event.preventDefault();
      }
    });

    realtimeInput.addEventListener("keyup", (event) => {
      if (!authenticated) return;
      if (modifierKeys.has(event.key)) {
        const mapped = modifierKeys.get(event.key);
        modifierUp(mapped);
        event.preventDefault();
        return;
      }

    });

    realtimeInput.addEventListener("blur", () => {
      if (!authenticated) return;
      releaseAllActiveKeys();
      releaseAllModifiers();
    });
  }

  if (typeForm && typeInput) {
    typeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!authenticated) return;
      const text = typeInput.value;
      if (!text) return;
      api("/api/keyboard/type", { text })
        .then(() => {
          typeInput.value = "";
          typeInput.focus();
        })
        .catch((err) => console.error("Type failed", err));
    });

    typeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        typeForm.requestSubmit();
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (!authenticated) return;
    if (typeInput && event.target === typeInput) {
      return;
    }
    if (realtimeInput && event.target === realtimeInput) {
      return;
    }

    if (modifierKeys.has(event.key)) {
      const mapped = modifierKeys.get(event.key);
      modifierDown(mapped);
      event.preventDefault();
      return;
    }

    if (specialKeys.has(event.key)) {
      const key = specialKeys.get(event.key);
      api("/api/keyboard/key", { key, action: "press" }).catch((err) =>
        console.error("Special key failed", err)
      );
      event.preventDefault();
      return;
    }

    const normalized = normalizeKeyForAction(event.key);
    const usingCombo =
      normalized && (event.ctrlKey || event.metaKey || event.altKey);
    if (usingCombo) {
      if (!event.repeat) {
        api("/api/keyboard/key", { key: normalized, action: "press" }).catch((err) =>
          console.error("Combo key press failed", err)
        );
      }
      event.preventDefault();
      return;
    }

    if (isPointerLocked()) {
      if (normalized) {
        if (!event.repeat && !activeKeys.has(normalized)) {
          activeKeys.add(normalized);
          api("/api/keyboard/key", { key: normalized, action: "down" }).catch((err) =>
            console.error("Key down failed", err)
          );
        }
        event.preventDefault();
        return;
      }

      if (
        event.key &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.isComposing
      ) {
        api("/api/keyboard/type", { text: event.key }).catch((err) =>
          console.error("Pointer lock typing failed", err)
        );
        event.preventDefault();
      }
    }
  });

  document.addEventListener("keyup", (event) => {
    if (!authenticated) return;
    if (typeInput && event.target === typeInput) {
      return;
    }
    if (realtimeInput && event.target === realtimeInput) {
      return;
    }

    if (modifierKeys.has(event.key)) {
      const mapped = modifierKeys.get(event.key);
      modifierUp(mapped);
      event.preventDefault();
      return;
    }

    const normalized = normalizeKeyForAction(event.key);
    if (normalized && activeKeys.has(normalized)) {
      activeKeys.delete(normalized);
      api("/api/keyboard/key", { key: normalized, action: "up" }).catch((err) =>
        console.error("Key up failed", err)
      );
      event.preventDefault();
    }
  });

  checkSession();
})();
