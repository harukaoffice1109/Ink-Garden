import { FluidSimulation } from "./fluid.js";
import { GardenAudio } from "./audio.js";
import { INK_COLORS, PondScene } from "./scene.js";

const paperCanvas = document.getElementById("paperLayer");
const fishCanvas = document.getElementById("fishLayer");
const inkCanvas = document.getElementById("inkLayer");
const surfaceCanvas = document.getElementById("surfaceLayer");
const fallback = document.getElementById("fallback");
const title = document.getElementById("title");
const hud = document.querySelector(".hud");
const statusEl = document.getElementById("status");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const seed = readSeed();
const artId = `IG-${seed.toString(36).toUpperCase().slice(0, 7)}`;
const pointers = new Map();

const state = {
  tool: "brush",
  color: "sumi",
  interacted: false,
  lastActivity: performance.now(),
  idle: false
};

let fluid;
let scene;
let audio;
let lastFrame = performance.now();
let statusTimer = 0;
let recording = null;
let artworkTitle = makeArtworkTitle(seed);

try {
  fluid = new FluidSimulation(inkCanvas, { reducedMotion });
  scene = new PondScene({
    paperCanvas,
    fishCanvas,
    surfaceCanvas,
    fluid,
    seed,
    reducedMotion
  });
  audio = new GardenAudio({ reducedMotion });
  init();
} catch (error) {
  console.error(error);
  fallback.hidden = false;
  const message = error instanceof Error ? error.message : String(error);
  const text = fallback.querySelector("p");
  if (text) text.textContent = `初始化失败：${message}`;
}

function init() {
  resize();
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!audio?.ctx || !audio.enabled) return;
    if (document.hidden && audio.ctx.state === "running") audio.ctx.suspend();
    if (!document.hidden && audio.ctx.state === "suspended") audio.ctx.resume();
  });

  bindControls();
  applyInitialState();
  bindPointerInput();
  bindKeyboard();
  primeInk();
  requestAnimationFrame(frame);
}

function readSeed() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("seed");
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  const text = raw || `${Date.now()}-${Math.random()}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  fluid.resize(width, height, dpr);
  scene.resize(width, height, dpr);
}

function bindControls() {
  for (const button of document.querySelectorAll("[data-color]")) {
    button.addEventListener("click", () => setColor(button.dataset.color));
  }

  for (const button of document.querySelectorAll("[data-tool]")) {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  }

  document.getElementById("autoBtn").addEventListener("click", () => {
    const enabled = !scene.auto.enabled;
    scene.setAuto(enabled);
    toggleButton("autoBtn", enabled);
    showStatus(enabled ? "静观开启" : "静观关闭");
    markActivity();
  });

  document.getElementById("audioBtn").addEventListener("click", async () => {
    try {
      const enabled = await audio.toggle();
      toggleButton("audioBtn", enabled);
      showStatus(enabled ? "琴音开启" : "琴音关闭");
    } catch {
      showStatus("当前浏览器不支持音频");
    }
    markActivity();
  });

  document.getElementById("saveBtn").addEventListener("click", () => {
    savePNG();
    markActivity();
  });

  document.getElementById("recordBtn").addEventListener("click", () => {
    toggleRecording();
    markActivity();
  });

  document.getElementById("shareBtn").addEventListener("click", () => {
    copyShareLink();
    markActivity();
  });

  document.getElementById("nameBtn").addEventListener("click", () => {
    artworkTitle = makeArtworkTitle(Date.now() ^ seed ^ Math.floor(Math.random() * 100000));
    showStatus(artworkTitle);
    markActivity();
  });

  document.getElementById("clearBtn").addEventListener("click", () => {
    fluid.clearInk();
    scene.clear();
    showStatus("清池");
    markActivity();
  });
}

function applyInitialState() {
  const params = new URLSearchParams(window.location.search);
  const ink = params.get("ink");
  const tool = params.get("tool");
  if (INK_COLORS[ink]) {
    state.color = ink;
    for (const button of document.querySelectorAll("[data-color]")) {
      const active = button.dataset.color === ink;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }
  if (tool && document.querySelector(`[data-tool="${tool}"]`)) {
    state.tool = tool;
    for (const button of document.querySelectorAll("[data-tool]")) {
      const active = button.dataset.tool === tool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }
  if (params.get("auto") === "1") {
    scene.setAuto(true);
    toggleButton("autoBtn", true);
  }
  const named = params.get("title");
  if (named) artworkTitle = named.slice(0, 16);
}

function bindPointerInput() {
  surfaceCanvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    surfaceCanvas.setPointerCapture(event.pointerId);
    const point = getPoint(event);
    const pointer = {
      id: event.pointerId,
      x: point.x,
      y: point.y,
      lastX: point.x,
      lastY: point.y,
      downX: point.x,
      downY: point.y,
      lastTime: performance.now(),
      moved: false,
      bloomed: false,
      petalCooldown: 0,
      rippleCooldown: 0,
      holdTimer: window.setTimeout(() => {
        const active = pointers.get(event.pointerId);
        if (!active || active.bloomed || active.moved) return;
        if (["brush", "drop", "vortex"].includes(state.tool)) {
          active.bloomed = true;
          inkDrop(active.x, active.y, 1.05);
          audio.onBloom(state.color);
          showStatus("滴墨");
        }
      }, 620)
    };
    pointers.set(event.pointerId, pointer);
    state.interacted = true;
    markActivity();
    handlePointerStart(pointer);
  });

  surfaceCanvas.addEventListener("pointermove", (event) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    const now = performance.now();
    const point = getPoint(event);
    const dt = Math.max(12, now - pointer.lastTime);
    const dx = point.x - pointer.lastX;
    const dy = point.y - pointer.lastY;
    pointer.moved = pointer.moved || Math.hypot(point.x - pointer.downX, point.y - pointer.downY) > 12;
    pointer.x = point.x;
    pointer.y = point.y;
    pointer.lastTime = now;
    markActivity();

    if (pointers.size >= 2) {
      handleTwoFingerFlow();
    } else {
      handlePointerMove(pointer, dx, dy, dt);
    }

    pointer.lastX = point.x;
    pointer.lastY = point.y;
  });

  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    surfaceCanvas.addEventListener(type, (event) => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer) return;
      window.clearTimeout(pointer.holdTimer);
      handlePointerEnd(pointer);
      pointers.delete(event.pointerId);
      if (pointers.size === 0) {
        scene.setCursor(pointer.x, pointer.y, false, state.tool, state.color);
        scene.setSummonTarget(pointer.x, pointer.y, false);
      }
    });
  }
}

function bindKeyboard() {
  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tools = {
      "1": "brush",
      "2": "drop",
      "3": "vortex",
      "4": "water",
      "5": "petal",
      "6": "summon"
    };
    const colors = {
      q: "sumi",
      w: "indigo",
      e: "cinnabar",
      r: "moss"
    };
    if (tools[event.key]) {
      setTool(tools[event.key]);
      event.preventDefault();
    } else if (colors[event.key.toLowerCase()]) {
      setColor(colors[event.key.toLowerCase()]);
      event.preventDefault();
    } else if (event.key.toLowerCase() === "c") {
      fluid.clearInk();
      scene.clear();
      showStatus("清池");
    } else if (event.key.toLowerCase() === "s") {
      savePNG();
    } else if (event.key.toLowerCase() === "a") {
      document.getElementById("autoBtn").click();
    } else if (event.key.toLowerCase() === "m") {
      document.getElementById("audioBtn").click();
    }
    markActivity();
  });
}

function getPoint(event) {
  const rect = surfaceCanvas.getBoundingClientRect();
  return {
    x: clamp(event.clientX - rect.left, 0, rect.width),
    y: clamp(event.clientY - rect.top, 0, rect.height)
  };
}

function handlePointerStart(pointer) {
  scene.setCursor(pointer.x, pointer.y, true, state.tool, state.color);

  if (state.tool === "drop") {
    inkDrop(pointer.x, pointer.y, 1.1);
  } else if (state.tool === "water") {
    clearWater(pointer.x, pointer.y, 1.2);
  } else if (state.tool === "petal") {
    scene.dropPetal(pointer.x, pointer.y - 120);
    scene.addRipple(pointer.x, pointer.y, 0.55);
  } else if (state.tool === "summon") {
    scene.setSummonTarget(pointer.x, pointer.y, true);
    scene.addRipple(pointer.x, pointer.y, 0.8);
  } else if (state.tool === "vortex") {
    vortex(pointer.x, pointer.y, 1.2);
  } else {
    inkDrop(pointer.x, pointer.y, 0.72 + Math.random() * 0.28);
  }
}

function handlePointerMove(pointer, dx, dy, dt) {
  const speed = Math.hypot(dx, dy) / dt;
  scene.setCursor(pointer.x, pointer.y, true, state.tool, state.color);

  if (state.tool === "brush") {
    const uvSpeed = Math.min(Math.hypot(dx / scene.width, dy / scene.height) * 30, 1);
    const forceX = (dx / scene.width) * 5200;
    const forceY = (dy / scene.height) * 5200;
    addInk(pointer.x, pointer.y, forceX, forceY, 0.06 + uvSpeed * 0.12);
    if (speed > 1.05 && Math.random() < 0.18) {
      const nx = pointer.x - dx * (0.25 + Math.random() * 0.45);
      const ny = pointer.y - dy * (0.25 + Math.random() * 0.45);
      fluid.erase(nx / scene.width, 1 - ny / scene.height, 0.0018 + Math.random() * 0.0024, 0.34);
    }
  } else if (state.tool === "drop") {
    if (speed > 0.1) {
      const uvSpeed = Math.min(Math.hypot(dx / scene.width, dy / scene.height) * 30, 1);
      const forceX = (dx / scene.width) * 5200;
      const forceY = (dy / scene.height) * 5200;
      addInk(pointer.x, pointer.y, forceX, forceY, 0.06 + uvSpeed * 0.12);
    }
  } else if (state.tool === "vortex") {
    vortex(pointer.x, pointer.y, clamp(0.6 + speed * 2.3, 0.5, 2.6));
  } else if (state.tool === "water") {
    clearWater(pointer.x, pointer.y, clamp(0.85 + speed, 0.8, 1.8));
    fluid.addVelocity(pointer.x / scene.width, 1 - pointer.y / scene.height, dx * 8, -dy * 8, 0.006, 1);
  } else if (state.tool === "petal") {
    pointer.petalCooldown -= dt;
    if (pointer.petalCooldown <= 0) {
      pointer.petalCooldown = 140;
      scene.dropPetal(pointer.x + (Math.random() - 0.5) * 26, pointer.y - 140);
      scene.addRipple(pointer.x, pointer.y, 0.28);
    }
  } else if (state.tool === "summon") {
    scene.setSummonTarget(pointer.x, pointer.y, true);
    pointer.rippleCooldown -= dt;
    if (pointer.rippleCooldown <= 0) {
      pointer.rippleCooldown = 240;
      scene.addRipple(pointer.x, pointer.y, 0.42);
    }
  }
}

function handlePointerEnd(pointer) {
  pointer.bloomed = Boolean(pointer.bloomed);
}

function handleTwoFingerFlow() {
  const values = [...pointers.values()];
  const a = values[0];
  const b = values[1];
  const cx = (a.x + b.x) * 0.5;
  const cy = (a.y + b.y) * 0.5;
  const radius = Math.max(38, Math.hypot(a.x - b.x, a.y - b.y) * 0.34);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const spin = Math.sign(dx * (a.y - a.lastY) - dy * (a.x - a.lastX) || 1);
  vortex(cx, cy, clamp(radius / 46, 0.8, 3.2) * spin);
  scene.setCursor(cx, cy, true, "vortex", state.color);
  scene.addRipple(cx, cy, 0.3);
}

function addInk(x, y, dx, dy, intensity) {
  const color = INK_COLORS[state.color];
  const u = x / scene.width;
  const v = 1 - y / scene.height;
  fluid.addVelocity(u, v, dx, -dy, 0.0052, 1);
  fluid.addDye(u, v, color.rgb, 0.00234, intensity);
  scene.rememberInk(x, y, state.color, 30 + intensity * 180, intensity);
  audio.onSplat(intensity, state.color);
}

function inkDrop(x, y, force = 1) {
  const color = INK_COLORS[state.color];
  const u = x / scene.width;
  const v = 1 - y / scene.height;
  fluid.addDye(u, v, color.rgb, 0.0026, force * 0.22);
  const angle = Math.random() * Math.PI * 2;
  const speed = 60 + Math.random() * 80;
  fluid.addVelocity(u, v, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.00312, 1);
  scene.rememberInk(x, y, state.color, 54 + force * 36, 1.1 * force);
  scene.addRipple(x, y, 1.1 * force);
  audio.onSplat(force, state.color);
}

function clearWater(x, y, force = 1) {
  fluid.erase(x / scene.width, 1 - y / scene.height, 0.010 * force, 0.64);
  scene.addRipple(x, y, 0.45 * force);
  audio.onSplat(0.18 * force, "indigo");
}

function vortex(x, y, force = 1) {
  const color = INK_COLORS[state.color];
  const points = 9;
  const spin = Math.sign(force || 1);
  const amount = Math.abs(force);
  for (let i = 0; i < points; i += 1) {
    const angle = (i / points) * Math.PI * 2;
    const px = x + Math.cos(angle) * 32 * amount;
    const py = y + Math.sin(angle) * 32 * amount;
    const vx = -Math.sin(angle) * 168 * amount * spin;
    const vy = Math.cos(angle) * 168 * amount * spin;
    fluid.addSplat(px / scene.width, 1 - py / scene.height, vx, -vy, color.rgb, 0.0036 + amount * 0.0014, 0.026);
  }
  scene.rememberInk(x, y, state.color, 46 + amount * 28, 0.52);
  audio.onSplat(0.3 + amount * 0.12, state.color);
}

function primeInk() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const colors = ["sumi", "indigo", "sumi", "moss"];
  window.setTimeout(() => {
    colors.forEach((colorKey, index) => {
      const x = width * (0.38 + index * 0.075);
      const y = height * (0.47 + Math.sin(index) * 0.045);
      const previous = state.color;
      state.color = colorKey;
      inkDrop(x, y, index === 0 ? 0.75 : index === 1 ? 0.6 : 0.5);
      state.color = previous;
      scene.rememberInk(x, y, colorKey, 48, 0.82);
    });
  }, 180);
}

function setColor(color) {
  if (!INK_COLORS[color]) return;
  state.color = color;
  for (const button of document.querySelectorAll("[data-color]")) {
    const active = button.dataset.color === color;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  showStatus(INK_COLORS[color].name);
  markActivity();
}

function setTool(tool) {
  state.tool = tool;
  for (const button of document.querySelectorAll("[data-tool]")) {
    const active = button.dataset.tool === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  markActivity();
}

function toggleButton(id, active) {
  const button = document.getElementById(id);
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
}

function markActivity() {
  state.lastActivity = performance.now();
  hud.classList.remove("idle");
  title.classList.add("dim");
}

function showStatus(message) {
  statusEl.textContent = message;
  statusEl.classList.add("show");
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => statusEl.classList.remove("show"), 1500);
}

function frame(now) {
  const dt = Math.min(0.033, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;

  if (!document.hidden) {
    const seconds = now / 1000;
    scene.update(dt, seconds);
    scene.draw(seconds);
    fluid.step(dt);
    if (recording?.active) drawComposite(recording.canvas);
  }

  const idle = now - state.lastActivity > 7600;
  if (idle !== state.idle) {
    state.idle = idle;
    hud.classList.toggle("idle", idle);
  }

  requestAnimationFrame(frame);
}

function drawComposite(targetCanvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.floor(window.innerWidth * dpr);
  const height = Math.floor(window.innerHeight * dpr);
  if (targetCanvas.width !== width || targetCanvas.height !== height) {
    targetCanvas.width = width;
    targetCanvas.height = height;
  }

  const ctx = targetCanvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(paperCanvas, 0, 0, width, height);
  ctx.drawImage(inkCanvas, 0, 0, width, height);
  ctx.save();
  ctx.globalAlpha = 0.78;
  ctx.globalCompositeOperation = "multiply";
  ctx.filter = "saturate(0.68) contrast(0.9) brightness(0.97) blur(0.12px)";
  ctx.drawImage(fishCanvas, 0, 0, width, height);
  ctx.restore();
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(surfaceCanvas, 0, 0, width, height);
  drawSignature(ctx, width, height, dpr);

  const track = recording?.stream?.getVideoTracks?.()[0];
  if (track?.requestFrame) track.requestFrame();
}

function savePNG() {
  const canvas = document.createElement("canvas");
  drawComposite(canvas);
  canvas.toBlob((blob) => {
    if (!blob) {
      showStatus("保存失败");
      return;
    }
    downloadBlob(blob, `ink-garden-${timestamp()}.png`);
    showStatus("已保存 PNG");
  }, "image/png");
}

function toggleRecording() {
  if (recording?.active) {
    recording.media.stop();
    return;
  }

  const canvas = document.createElement("canvas");
  drawComposite(canvas);
  if (!canvas.captureStream || !window.MediaRecorder) {
    showStatus("当前浏览器不支持录制");
    return;
  }

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";
  const stream = canvas.captureStream(30);
  const media = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6000000 });
  const chunks = [];
  media.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  media.addEventListener("stop", () => {
    const blob = new Blob(chunks, { type: mimeType });
    downloadBlob(blob, `ink-garden-${timestamp()}.webm`);
    stream.getTracks().forEach((track) => track.stop());
    recording.active = false;
    toggleButton("recordBtn", false);
    showStatus("已保存 WebM");
  });

  recording = { active: true, canvas, stream, media, chunks };
  media.start();
  toggleButton("recordBtn", true);
  showStatus("录制中");
}

async function copyShareLink() {
  const url = new URL(window.location.href);
  url.searchParams.set("seed", String(seed));
  url.searchParams.set("ink", state.color);
  url.searchParams.set("tool", state.tool);
  url.searchParams.set("title", artworkTitle);
  if (scene.auto.enabled) url.searchParams.set("auto", "1");
  else url.searchParams.delete("auto");
  try {
    await navigator.clipboard.writeText(url.toString());
    showStatus("链接已复制");
  } catch {
    window.prompt("分享链接", url.toString());
  }
}

function drawSignature(ctx, width, height, dpr) {
  const pad = 18 * dpr;
  ctx.save();
  ctx.globalAlpha = 0.58;
  ctx.fillStyle = "rgba(21, 23, 24, 0.62)";
  ctx.font = `${12 * dpr}px Avenir Next, Helvetica Neue, Arial, sans-serif`;
  ctx.textBaseline = "bottom";
  ctx.letterSpacing = "0px";
  ctx.fillText(`${artworkTitle} · ${artId}`, pad, height - pad);
  ctx.restore();
}

function makeArtworkTitle(value) {
  const first = ["月下", "旧墨", "松风", "鱼影", "微雨", "水底", "花迟", "清梦", "朱云", "远青"];
  const second = ["入池", "成纹", "听水", "照庭", "留白", "生烟", "回澜", "浮光", "未央", "归静"];
  const a = Math.abs(value) % first.length;
  const b = Math.abs(Math.floor(value / 17)) % second.length;
  return `${first[a]}${second[b]}`;
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
