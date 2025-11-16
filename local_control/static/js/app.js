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
  const clipboardPullButton = document.getElementById("clipboard-pull");
  const clipboardPushButton = document.getElementById("clipboard-push");
  const clipboardText = document.getElementById("clipboard-text");
  const clipboardImage = document.getElementById("clipboard-image");
  const clipboardStatus = document.getElementById("clipboard-status");
  const helpButton = document.getElementById("help-button");
  const helpOverlay = document.getElementById("help-overlay");
  const helpClose = document.getElementById("help-close");

  let authenticated = false;
  const EDGE_RELEASE_RATIO = 0.05;
  const EDGE_RELEASE_DELAY_MS = 100;
  const EDGE_BUFFER_PX = 2;
  const POINTER_WARP_RATIO = 0.3;
  const POINTER_WARP_MIN_THRESHOLD = 45;
  const POINTER_JUMP_RATIO = 3.2;
  const POINTER_JUMP_MIN_MAG = 26;
  const POINTER_JUMP_TIME_WINDOW_MS = 180;
  const POINTER_DIRECTION_DECAY_MS = 160;
  const POINTER_DIRECTION_MIN_MAG = 10;
  const POINTER_DIRECTION_MAX_NOISE = 38;
  const POINTER_DIRECTION_ALIGN_RATIO = 0.35;
  const POINTER_DIRECTION_TURN_RATIO = 0.7;
  const POINTER_BUTTON_MAP = new Map([
    [0, "left"],
    [1, "middle"],
    [2, "right"],
  ]);
  let lastRemoteState = null;
  let edgeAccumulators = { left: 0, right: 0, top: 0, bottom: 0 };
  let edgeReleaseTimer = null;
  const activeKeys = new Set();
  const touches = new Map();
  let touchSession = null;
  let pendingScroll = { horizontal: 0, vertical: 0 };
  let scrollFrameQueued = false;
  let lastSanitizedVector = null;
  let lastSanitizedAt = 0;
  let lastDirectionSample = null;
  const heldPointerButtons = new Set();
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
  let helpVisible = false;
  let lastClipboardContent = null;
  let lastDeviceClipboardSignature = null;
  const LOG_TEXT_LIMIT = 120;

  function logEvent(topic, message, detail) {
    const timestamp = new Date().toISOString();
    if (detail !== undefined) {
      console.log(`[${timestamp}] [${topic}] ${message}`, detail);
    } else {
      console.log(`[${timestamp}] [${topic}] ${message}`);
    }
  }

  function summarizeTextSample(text, limit = LOG_TEXT_LIMIT) {
    if (typeof text !== "string") {
      return text;
    }
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}… (len=${text.length})`;
  }

  function describeClipboardContent(content) {
    if (!content) {
      return { type: "none" };
    }
    if (content.type === "text") {
      return {
        type: "text",
        length: content.data ? content.data.length : 0,
        preview: summarizeTextSample(content.data || ""),
      };
    }
    if (content.type === "image") {
      return {
        type: "image",
        bytes: content.data ? content.data.length : 0,
        mime: content.mime || "image/png",
      };
    }
    return { type: content.type || "unknown" };
  }

  function fingerprintClipboardContent(content) {
    if (!content) return null;
    const type = content.type || "unknown";
    const mime = content.mime || "";
    const data = typeof content.data === "string" ? content.data : String(content.data || "");
    const length = data.length || 0;
    const head = data.slice(0, 16);
    const tail = length > 16 ? data.slice(-16) : "";
    return `${type}|${mime}|${length}|${head}|${tail}`;
  }

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

  function pointerButtonFromEvent(event) {
    if (!event || typeof event.button !== "number") {
      return null;
    }
    return POINTER_BUTTON_MAP.get(event.button) || null;
  }

  function sendMouseButton(button, action) {
    if (!authenticated || !button) return Promise.resolve();
    logEvent("Mouse", "Pointer button action", { button, action });
    return api("/api/mouse/button", { button, action }).catch((err) => {
      console.error("Mouse button action failed", err);
    });
  }

  function releaseAllPointerButtons() {
    if (!heldPointerButtons.size) return;
    const buttons = Array.from(heldPointerButtons);
    heldPointerButtons.clear();
    buttons.forEach((button) => {
      sendMouseButton(button, "up");
    });
  }

  function setClipboardStatus(message, tone = "info") {
    if (!clipboardStatus) return;
    clipboardStatus.textContent = message || "";
    clipboardStatus.dataset.tone = tone;
  }

  function setClipboardPreview(content, origin = "host") {
    if (!content) {
      logEvent("Clipboard", "Cleared clipboard preview");
      if (clipboardText) {
        clipboardText.hidden = false;
        clipboardText.value = "";
      }
      if (clipboardImage) {
        clipboardImage.src = "";
        clipboardImage.hidden = true;
      }
      return;
    }
    lastClipboardContent = content;
    logEvent("Clipboard", "Updated clipboard preview", {
      origin,
      ...describeClipboardContent(content),
    });
    if (content.type === "text") {
      if (clipboardText) {
        clipboardText.hidden = false;
        clipboardText.value = content.data;
      }
      if (clipboardImage) {
        clipboardImage.src = "";
        clipboardImage.hidden = true;
      }
      setClipboardStatus(
        origin === "device" ? "Uploaded device text to host clipboard." : "Fetched host clipboard text.",
      );
    } else if (content.type === "image") {
      if (clipboardImage) {
        const mime = content.mime || "image/png";
        clipboardImage.src = `data:${mime};base64,${content.data}`;
        clipboardImage.hidden = false;
      }
      if (clipboardText) {
        clipboardText.hidden = true;
        clipboardText.value = "";
      }
      setClipboardStatus(
        origin === "device" ? "Uploaded device image to host clipboard." : "Fetched host clipboard image.",
      );
    }
  }

  function base64ToBlob(base64, mime = "application/octet-stream") {
    const binary = atob(base64);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      array[i] = binary.charCodeAt(i);
    }
    return new Blob([array], { type: mime });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") {
          const base64 = result.split(",").pop();
          resolve(base64 || "");
        } else {
          reject(new Error("Unsupported clipboard blob result."));
        }
      };
      reader.onerror = () => reject(reader.error || new Error("Failed to convert blob to base64."));
      reader.readAsDataURL(blob);
    });
  }

  async function syncClipboardToDevice(content) {
    if (!navigator.clipboard) {
      setClipboardStatus("Browser clipboard API unavailable; copied content shown in preview only.", "warn");
      logEvent("Clipboard", "Device clipboard API unavailable");
      return;
    }
    logEvent("Clipboard", "Syncing host clipboard to device", describeClipboardContent(content));
    try {
      if (content.type === "text") {
        if (navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(content.data);
          setClipboardStatus("Copied host text to this device clipboard.");
          logEvent("Clipboard", "Device clipboard text updated");
        }
      } else if (content.type === "image") {
        const mime = content.mime || "image/png";
        const blob = base64ToBlob(content.data, mime);
        if (navigator.clipboard.write && window.ClipboardItem) {
          const item = new ClipboardItem({ [blob.type]: blob });
          await navigator.clipboard.write([item]);
          setClipboardStatus("Copied host image to this device clipboard.");
          logEvent("Clipboard", "Device clipboard image updated", { mime: blob.type, bytes: blob.size });
        } else {
          setClipboardStatus("Clipboard image synced to preview. Browser API does not support programmatic image copy.", "warn");
          logEvent("Clipboard", "Clipboard image sync limited by browser API");
        }
      }
    } catch (err) {
      console.warn("Failed to write to device clipboard", err);
      setClipboardStatus("Clipboard permission denied. Content available in preview.", "warn");
      logEvent("Clipboard", "Failed to sync host clipboard to device", { error: err.message });
    }
  }

  async function readDeviceClipboard() {
    if (!navigator.clipboard) {
      setClipboardStatus("Browser clipboard API unavailable.", "warn");
      return null;
    }
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes("image/png")) {
            const blob = await item.getType("image/png");
            const base64 = await blobToBase64(blob);
            return { type: "image", data: base64, mime: blob.type || "image/png" };
          }
          if (item.types.includes("text/plain")) {
            const blob = await item.getType("text/plain");
            const text = await blob.text();
            return { type: "text", data: text };
          }
        }
      }
      if (navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text !== undefined && text !== null) {
          return { type: "text", data: text };
        }
      }
    } catch (err) {
      console.warn("Failed to read device clipboard", err);
      setClipboardStatus("Clipboard permission denied. Paste may not transfer content.", "warn");
      return null;
    }
    return null;
  }

  async function pushDeviceClipboardToHost(options = {}) {
    const { force = true, reason = "manual" } = options;
    const local = await readDeviceClipboard();
    if (!local) {
      logEvent("Clipboard", "No device clipboard content to push");
      return false;
    }
    const signature = fingerprintClipboardContent(local);
    if (!force && signature && signature === lastDeviceClipboardSignature) {
      logEvent("Clipboard", "Device clipboard unchanged; skipping push", { reason });
      return false;
    }
    logEvent("Clipboard", "Pushing device clipboard to host", describeClipboardContent(local));
    try {
      await api("/api/clipboard", local);
      setClipboardPreview(local, "device");
      logEvent("Clipboard", "Device clipboard pushed to host successfully");
      lastDeviceClipboardSignature = signature;
      return true;
    } catch (err) {
      console.error("Failed to push clipboard to host", err);
      setClipboardStatus(err.message || "Clipboard upload failed.", "warn");
      logEvent("Clipboard", "Failed to push clipboard to host", { error: err.message });
      return false;
    }
  }

  async function pullClipboardFromHost(syncDevice = true) {
    try {
      logEvent("Clipboard", "Requesting host clipboard", { syncDevice });
      const response = await fetch("/api/clipboard", { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error(response.statusText);
      }
      const data = await response.json();
      if (!data || !data.content) {
        setClipboardStatus("Host clipboard empty.", "info");
        setClipboardPreview(null);
        logEvent("Clipboard", "Host clipboard empty");
        return null;
      }
      const content = data.content;
      setClipboardPreview(content, "host");
      if (syncDevice) {
        await syncClipboardToDevice(content);
      }
      logEvent("Clipboard", "Fetched host clipboard", describeClipboardContent(content));
      return content;
    } catch (err) {
      console.error("Failed to fetch clipboard", err);
      setClipboardStatus(err.message || "Unable to read host clipboard.", "warn");
      logEvent("Clipboard", "Failed to fetch host clipboard", { error: err.message });
      return null;
    }
  }

  function scheduleClipboardPull(delay = 250) {
    window.setTimeout(() => {
      pullClipboardFromHost(true).catch((err) =>
        console.warn("Clipboard pull failed", err),
      );
    }, delay);
  }

  async function sendComboPress(key) {
    try {
      logEvent("Keyboard", "Sending combo press", { key });
      await api("/api/keyboard/key", { key, action: "press" });
    } catch (err) {
      console.error("Combo press failed", err);
      logEvent("Keyboard", "Combo press failed", { key, error: err.message });
    }
  }

  function handleClipboardCombo(normalized, event) {
    if (normalized === "v") {
      event.preventDefault();
      if (!event.repeat) {
        logEvent("Keyboard", "Clipboard paste combo triggered");
        (async () => {
          const success = await pushDeviceClipboardToHost();
          await sendComboPress(normalized);
          if (!success) {
            setClipboardStatus("Paste sent to host without clipboard payload.", "warn");
          }
        })();
      }
      return true;
    }
    if (normalized === "c" || normalized === "x") {
      event.preventDefault();
      if (!event.repeat) {
        logEvent("Keyboard", `Clipboard ${normalized === "c" ? "copy" : "cut"} combo triggered`);
        sendComboPress(normalized);
        scheduleClipboardPull();
      }
      return true;
    }
    return false;
  }

  function openHelp() {
    if (!helpOverlay) return;
    if (isPointerLocked()) {
      try {
        document.exitPointerLock();
      } catch (err) {
        console.warn("Failed to exit pointer lock when opening help", err);
      }
    }
    releaseAllActiveKeys();
    releaseAllModifiers();
    helpOverlay.hidden = false;
    helpVisible = true;
    if (helpClose) {
      helpClose.focus();
    }
  }

  function closeHelp() {
    if (!helpOverlay) return;
    helpOverlay.hidden = true;
    helpVisible = false;
    if (helpButton) {
      helpButton.focus();
    }
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

  function rememberDirectionSample(vec, timestamp) {
    const mag = Math.hypot(vec.dx, vec.dy);
    if (mag < POINTER_DIRECTION_MIN_MAG) {
      return;
    }
    const inv = 1 / mag;
    lastDirectionSample = {
      x: vec.dx * inv,
      y: vec.dy * inv,
      mag,
      time: timestamp,
    };
  }

  function suppressPerpendicularJitter(vec, timestamp) {
    if (!lastDirectionSample) {
      return vec;
    }
    if (timestamp - lastDirectionSample.time > POINTER_DIRECTION_DECAY_MS) {
      lastDirectionSample = null;
      return vec;
    }
    const mag = Math.hypot(vec.dx, vec.dy);
    if (mag < POINTER_DIRECTION_MIN_MAG || mag > POINTER_DIRECTION_MAX_NOISE) {
      return vec;
    }
    const dot = vec.dx * lastDirectionSample.x + vec.dy * lastDirectionSample.y;
    const alignment = Math.abs(dot) / mag;
    if (alignment >= POINTER_DIRECTION_ALIGN_RATIO) {
      return vec;
    }
    if (mag > lastDirectionSample.mag * POINTER_DIRECTION_TURN_RATIO) {
      lastDirectionSample = null;
      return vec;
    }
    if (Math.abs(lastDirectionSample.x) >= Math.abs(lastDirectionSample.y)) {
      vec.dy = 0;
    } else {
      vec.dx = 0;
    }
    if (Math.abs(vec.dx) < 0.5 && Math.abs(vec.dy) < 0.5) {
      return null;
    }
    return vec;
  }

  function sanitizePointerLockDelta(dx, dy) {
    const docElement = document.documentElement;
    const padWidth = trackpad ? trackpad.clientWidth : 0;
    const padHeight = trackpad ? trackpad.clientHeight : 0;
    const viewportWidth = Math.max(window.innerWidth || 0, (docElement && docElement.clientWidth) || 0);
    const viewportHeight = Math.max(window.innerHeight || 0, (docElement && docElement.clientHeight) || 0);
    const refWidth = Math.min(
      padWidth || Number.POSITIVE_INFINITY,
      viewportWidth || Number.POSITIVE_INFINITY,
    );
    const refHeight = Math.min(
      padHeight || Number.POSITIVE_INFINITY,
      viewportHeight || Number.POSITIVE_INFINITY,
    );
    const thresholdX = Math.max(
      POINTER_WARP_MIN_THRESHOLD,
      (Number.isFinite(refWidth) ? refWidth : viewportWidth) * POINTER_WARP_RATIO,
    );
    const thresholdY = Math.max(
      POINTER_WARP_MIN_THRESHOLD,
      (Number.isFinite(refHeight) ? refHeight : viewportHeight) * POINTER_WARP_RATIO,
    );
    let filteredDx = dx;
    let filteredDy = dy;
    if (Math.abs(filteredDx) >= thresholdX) {
      filteredDx = 0;
    }
    if (Math.abs(filteredDy) >= thresholdY) {
      filteredDy = 0;
    }
    const now = performance.now();
    if (
      lastSanitizedVector &&
      now - lastSanitizedAt < POINTER_JUMP_TIME_WINDOW_MS
    ) {
      const prev = lastSanitizedVector;
      const prevMag = Math.hypot(prev.dx, prev.dy);
      const currMag = Math.hypot(filteredDx, filteredDy);
      const prevAxis = Math.abs(prev.dx) >= Math.abs(prev.dy) ? "x" : "y";
      const currAxis = Math.abs(filteredDx) >= Math.abs(filteredDy) ? "x" : "y";
      const prevDominant =
        prevAxis === "x"
          ? Math.abs(prev.dx) >= Math.abs(prev.dy) * POINTER_JUMP_RATIO
          : Math.abs(prev.dy) >= Math.abs(prev.dx) * POINTER_JUMP_RATIO;
      const currDominant =
        currAxis === "x"
          ? Math.abs(filteredDx) >= Math.abs(filteredDy || 0) * POINTER_JUMP_RATIO
          : Math.abs(filteredDy) >= Math.abs(filteredDx || 0) * POINTER_JUMP_RATIO;
      if (
        prevMag >= POINTER_JUMP_MIN_MAG &&
        currMag >= POINTER_JUMP_MIN_MAG &&
        prevAxis !== currAxis &&
        prevDominant &&
        currDominant
      ) {
        if (currAxis === "x") {
          filteredDx = 0;
        } else {
          filteredDy = 0;
        }
      }
    }

    const jitterChecked = suppressPerpendicularJitter(
      { dx: filteredDx, dy: filteredDy },
      now,
    );
    if (!jitterChecked) {
      return null;
    }
    filteredDx = jitterChecked.dx;
    filteredDy = jitterChecked.dy;
    if (filteredDx === 0 && filteredDy === 0) {
      return null;
    }
    const result = { dx: filteredDx, dy: filteredDy };
    lastSanitizedVector = { dx: filteredDx, dy: filteredDy };
    lastSanitizedAt = now;
    rememberDirectionSample(result, now);
    return result;
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
    refreshState();
    logEvent("Auth", "Control view shown", { username });
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
    closeHelp();
    if (isPointerLocked()) {
      try {
        document.exitPointerLock();
      } catch (err) {
        console.warn("Failed to exit pointer lock", err);
      }
    }
    releaseAllActiveKeys();
    releaseAllModifiers();
    logEvent("Auth", "Login view shown");
  }

  async function checkSession() {
    try {
      const res = await fetch("/api/session", { credentials: "same-origin" });
      const data = await res.json();
      logEvent("Auth", "Session check result", data);
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
      logEvent("Auth", "Login attempt", { username, remember });
      const data = await api("/api/login", { username, password, remember });
      logEvent("Auth", "Login success", { username: data.username });
      showControl(data.username);
    } catch (err) {
      loginError.textContent = err.message;
      logEvent("Auth", "Login failed", { username, error: err.message });
    }
  });

  logoutButton.addEventListener("click", async () => {
    logEvent("Auth", "Logout requested");
    try {
      await api("/api/logout", {});
    } catch (err) {
      console.warn("Logout failed", err);
      logEvent("Auth", "Logout request failed", { error: err.message });
    } finally {
      logEvent("Auth", "Logout complete");
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
      logEvent("Mouse", "Manual click command issued", payload);
      api("/api/mouse/click", payload).catch((err) =>
        console.error("Click failed", err)
      );
    });
  });

  lockButton.addEventListener("click", () => {
    if (!authenticated) return;
    logEvent("System", "Lock command requested");
    api("/api/system/lock").catch((err) => alert(err.message));
  });

  if (unlockButton) {
    unlockButton.addEventListener("click", () => {
      if (!authenticated) return;
      logEvent("System", "Unlock/Wake command requested");
      api("/api/system/unlock").catch((err) => alert(err.message));
    });
  }

  shutdownButton.addEventListener("click", () => {
    if (!authenticated) return;
    const confirmShutdown = confirm(
      "Shutdown the host computer immediately? Unsaved work will be lost."
    );
    if (!confirmShutdown) return;
    logEvent("System", "Shutdown command confirmed");
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
      const button = pointerButtonFromEvent(event);
      if (button) {
        heldPointerButtons.add(button);
        sendMouseButton(button, "down");
      }
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
      const sanitized = sanitizePointerLockDelta(
        event.movementX,
        event.movementY,
      );
      if (!sanitized) {
        event.preventDefault();
        return;
      }
      dx = sanitized.dx;
      dy = sanitized.dy;
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
        releaseAllPointerButtons();
      }
    }
    if (event.pointerType === "mouse") {
      const button = pointerButtonFromEvent(event);
      if (button) {
        if (heldPointerButtons.has(button)) {
          heldPointerButtons.delete(button);
        }
        sendMouseButton(button, "up");
      }
      tapCandidate = null;
      event.preventDefault();
      return;
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
      lastDirectionSample = null;
      lastSanitizedVector = null;
      lastSanitizedAt = 0;
      const activeElement = document.activeElement;
      if (
        activeElement &&
        typeof activeElement.blur === "function" &&
        activeElement !== document.body &&
        activeElement !== trackpad
      ) {
        activeElement.blur();
        logEvent("Sync", "Cleared active element focus for pointer lock", {
          blurred: activeElement.id ? `#${activeElement.id}` : activeElement.tagName,
        });
      }
      refreshState();
      activeKeys.clear();
      releaseAllModifiers();
      setPointerSyncState(true);
      logEvent("Sync", "Pointer lock acquired");
      pullClipboardFromHost(false).catch((err) =>
        console.warn("Clipboard refresh on sync entry failed", err)
      );
      if (navigator.clipboard && (navigator.clipboard.read || navigator.clipboard.readText)) {
        pushDeviceClipboardToHost({ force: false, reason: "sync-entry" }).catch((err) =>
          console.warn("Clipboard push on sync entry failed", err)
        );
      }
    } else {
      pointerActive = false;
      pendingDelta = { x: 0, y: 0 };
      lastPoint = { x: 0, y: 0 };
      resetEdgeTracking();
      lastDirectionSample = null;
      lastSanitizedVector = null;
      lastSanitizedAt = 0;
      releaseAllPointerButtons();
      releaseAllActiveKeys();
      releaseAllModifiers();
      setPointerSyncState(false);
      logEvent("Sync", "Pointer lock released");
      pullClipboardFromHost(true).catch((err) =>
        console.warn("Clipboard pull on sync exit failed", err)
      );
    }
  });

  document.addEventListener("pointerlockerror", (event) => {
    console.warn("Pointer lock error", event);
    pointerActive = false;
    lastDirectionSample = null;
    lastSanitizedVector = null;
    lastSanitizedAt = 0;
    releaseAllPointerButtons();
    releaseAllActiveKeys();
    releaseAllModifiers();
    setPointerSyncState(false);
    logEvent("Sync", "Pointer lock error", { error: event?.name || "unknown" });
  });

  window.addEventListener("blur", () => {
    if (!authenticated) return;
    releaseAllActiveKeys();
    releaseAllModifiers();
    releaseAllPointerButtons();
    logEvent("Sync", "Window blurred; releasing pointer lock if active");
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
    releaseAllPointerButtons();
    logEvent("Sync", "Document hidden; exiting pointer lock if active");
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
      logEvent("Keyboard", "Realtime input event", {
        inputType,
        text: summarizeTextSample(text),
      });
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
      logEvent("Keyboard", "Composition end", {
        data: summarizeTextSample(data || ""),
      });
      if (data) {
        api("/api/keyboard/type", { text: data }).catch((err) =>
          console.error("Realtime composition failed", err),
        );
      }
      realtimeInput.value = "";
    });

    realtimeInput.addEventListener("keydown", (event) => {
      if (!authenticated) return;
      logEvent("Keyboard", "Realtime keydown", {
        key: event.key,
        repeat: event.repeat,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
      });
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
        if (!handleClipboardCombo(normalized, event)) {
          if (!event.repeat) {
            sendComboPress(normalized);
          }
          event.preventDefault();
        }
      }
    });

    realtimeInput.addEventListener("keyup", (event) => {
      if (!authenticated) return;
      logEvent("Keyboard", "Realtime keyup", { key: event.key });
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
      logEvent("Keyboard", "Realtime input blurred; modifiers released");
    });
  }

  if (typeForm && typeInput) {
    typeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!authenticated) return;
      const text = typeInput.value;
      if (!text) return;
      logEvent("Keyboard", "Bulk text send requested", {
        length: text.length,
        preview: summarizeTextSample(text),
      });
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
        logEvent("Keyboard", "Bulk text submit shortcut pressed");
        typeForm.requestSubmit();
      }
    });
  }

  if (clipboardPullButton) {
    clipboardPullButton.addEventListener("click", () => {
      if (!authenticated) return;
      logEvent("Clipboard", "Manual host clipboard pull requested");
      pullClipboardFromHost(true);
    });
  }

  if (clipboardPushButton) {
    clipboardPushButton.addEventListener("click", () => {
      if (!authenticated) return;
      logEvent("Clipboard", "Manual device clipboard push requested");
      pushDeviceClipboardToHost();
    });
  }

  if (helpButton && helpOverlay) {
    helpButton.addEventListener("click", () => {
      if (helpVisible) {
        closeHelp();
      } else {
        openHelp();
      }
    });
  }

  if (helpClose) {
    helpClose.addEventListener("click", closeHelp);
  }

  if (helpOverlay) {
    helpOverlay.addEventListener("click", (event) => {
      if (event.target === helpOverlay) {
        closeHelp();
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (!authenticated) return;
    logEvent("Keyboard", "Document keydown", {
      key: event.key,
      repeat: event.repeat,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      alt: event.altKey,
      target: event.target && event.target.id ? `#${event.target.id}` : event.target?.tagName,
    });
    if (helpVisible) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHelp();
      }
      return;
    }
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
      if (!handleClipboardCombo(normalized, event)) {
        if (!event.repeat) {
          sendComboPress(normalized);
        }
        event.preventDefault();
      }
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
    logEvent("Keyboard", "Document keyup", {
      key: event.key,
      target: event.target && event.target.id ? `#${event.target.id}` : event.target?.tagName,
    });
    if (helpVisible) {
      return;
    }
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

  if (clipboardStatus) {
    setClipboardStatus("");
  }

  checkSession();
})();
