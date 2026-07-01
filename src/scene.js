const TAU = Math.PI * 2;

export const INK_COLORS = {
  sumi: {
    name: "墨黑",
    rgb: [2.28, 2.28, 2.1],
    css: "#151718",
    wash: "rgba(21, 23, 24, 0.22)"
  },
  indigo: {
    name: "靛蓝",
    rgb: [2.45, 1.39, 0.74],
    css: "#24536c",
    wash: "rgba(36, 83, 108, 0.22)"
  },
  cinnabar: {
    name: "朱砂",
    rgb: [0.24, 1.53, 1.74],
    css: "#b84c32",
    wash: "rgba(184, 76, 50, 0.22)"
  },
  moss: {
    name: "松绿",
    rgb: [1.71, 0.86, 1.17],
    css: "#486a4f",
    wash: "rgba(72, 106, 79, 0.22)"
  }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function dist(a, b, c, d) {
  return Math.hypot(a - c, b - d);
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function drawPetalShape(ctx, scale = 1) {
  ctx.beginPath();
  ctx.moveTo(0, -9 * scale);
  ctx.bezierCurveTo(9 * scale, -6 * scale, 9 * scale, 7 * scale, 0, 12 * scale);
  ctx.bezierCurveTo(-9 * scale, 7 * scale, -9 * scale, -6 * scale, 0, -9 * scale);
  ctx.closePath();
}

export class PondScene {
  constructor({ paperCanvas, fishCanvas, surfaceCanvas, fluid, seed = Date.now(), reducedMotion = false }) {
    this.paperCanvas = paperCanvas;
    this.fishCanvas = fishCanvas;
    this.surfaceCanvas = surfaceCanvas;
    this.paper = paperCanvas.getContext("2d", { alpha: false });
    this.fishCtx = fishCanvas.getContext("2d");
    this.surface = surfaceCanvas.getContext("2d");
    this.fluid = fluid;
    this.random = mulberry32(seed);
    this.reducedMotion = reducedMotion;

    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.paperPattern = null;
    this.memory = [];
    this.inkEntries = [];
    this.petals = [];
    this.ripples = [];
    this.bubbles = [];
    this.cursor = { x: 0, y: 0, active: false, tool: "brush", color: "sumi" };
    this.summon = { x: 0, y: 0, active: false, strength: 0 };
    this.auto = { enabled: false, next: 1.4 };
    this.fish = this.createFishSchool();
    this.lastWake = 0;
  }

  createFishSchool() {
    const bodies = [
      { size: 66, body: "#b56549", belly: "#dccfb9", fin: "#7c493c", cap: null, speed: 25 },
      { size: 56, body: "#d8d0bf", belly: "#eee5d4", fin: "#a3573b", cap: "#24211d", speed: 28 },
      { size: 50, body: "#aa8746", belly: "#d9c9a8", fin: "#704a3d", cap: null, speed: 31 },
      { size: 43, body: "#d9d4c7", belly: "#ebe3d2", fin: "#355263", cap: "#8f4a39", speed: 34 }
    ];

    return bodies.map((body, index) => ({
      ...body,
      x: 240 + index * 130,
      y: 250 + (index % 2) * 110,
      vx: 0,
      vy: 0,
      heading: this.random() * TAU,
      targetHeading: this.random() * TAU,
      phase: this.random() * TAU,
      drift: this.random() * 2 - 1,
      depth: 0.52 + this.random() * 0.34,
      currentSpeed: body.speed * (0.6 + this.random() * 0.35),
      targetSpeed: body.speed,
      wanderTimer: 0.5 + this.random() * 2,
      placed: false,
      wake: 0,
      react: 0,
      dart: 0,
      memoryCooldown: 0
    }));
  }

  resize(width, height, dpr = window.devicePixelRatio || 1) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = clamp(dpr, 1, 2);

    for (const canvas of [this.paperCanvas, this.fishCanvas, this.surfaceCanvas]) {
      const canvasWidth = Math.floor(this.width * this.dpr);
      const canvasHeight = Math.floor(this.height * this.dpr);
      if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
      }
    }

    for (const ctx of [this.paper, this.fishCtx, this.surface]) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    this.paperPattern = this.createPaperPattern();
    this.fish.forEach((fish, index) => {
      if (!fish.placed || fish.x > this.width - 24 || fish.y > this.height - 24) {
        fish.x = this.width * (0.2 + 0.17 * index + (this.random() - 0.5) * 0.04);
        fish.y = this.height * (0.34 + 0.11 * (index % 2) + (this.random() - 0.5) * 0.08);
        fish.heading = index % 2 === 0 ? this.random() * 0.55 : Math.PI + this.random() * 0.55;
        fish.targetHeading = fish.heading;
        fish.placed = true;
      }
    });
  }

  createPaperPattern() {
    const offscreen = document.createElement("canvas");
    offscreen.width = 360;
    offscreen.height = 360;
    const ctx = offscreen.getContext("2d");
    ctx.fillStyle = "#e9ebdf";
    ctx.fillRect(0, 0, offscreen.width, offscreen.height);

    const image = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const grain = (this.random() - 0.5) * 12;
      data[i] = clamp(data[i] + grain, 0, 255);
      data[i + 1] = clamp(data[i + 1] + grain, 0, 255);
      data[i + 2] = clamp(data[i + 2] + grain * 0.7, 0, 255);
      data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);

    ctx.globalAlpha = 0.11;
    for (let i = 0; i < 90; i += 1) {
      const x = this.random() * offscreen.width;
      const y = this.random() * offscreen.height;
      const length = 40 + this.random() * 130;
      ctx.strokeStyle = this.random() > 0.5 ? "#ffffff" : "#aeb6a3";
      ctx.lineWidth = 0.35 + this.random() * 0.65;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + length * 0.3, y - 10, x + length * 0.7, y + 12, x + length, y + 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    return this.paper.createPattern(offscreen, "repeat");
  }

  setCursor(x, y, active, tool, color) {
    this.cursor.x = x;
    this.cursor.y = y;
    this.cursor.active = active;
    this.cursor.tool = tool;
    this.cursor.color = color;
  }

  setSummonTarget(x, y, active) {
    this.summon.x = x;
    this.summon.y = y;
    this.summon.active = active;
    this.summon.strength = active ? 1 : 0;
  }

  setAuto(enabled) {
    this.auto.enabled = enabled;
    this.auto.next = enabled ? 0.2 : 1.4;
  }

  rememberInk(x, y, colorKey, radius = 46, intensity = 1) {
    const color = INK_COLORS[colorKey] || INK_COLORS.sumi;
    this.memory.push({
      x,
      y,
      color: color.css,
      rgb: color.rgb,
      radius,
      intensity,
      age: 0,
      life: 90 + this.random() * 110,
      seed: this.random() * TAU,
      cooldown: 0
    });
    if (this.memory.length > 190) this.memory.splice(0, this.memory.length - 190);
  }

  addInkEntry(x, y, colorKey, force = 1, kind = "drop") {
    const color = INK_COLORS[colorKey] || INK_COLORS.sumi;
    this.inkEntries.push({
      x,
      y,
      color: color.css,
      age: 0,
      life: kind === "stroke" ? 0.72 : kind === "vortex" ? 1.15 : 1.35,
      radius: kind === "stroke" ? 18 + force * 24 : kind === "vortex" ? 34 + force * 30 : 26 + force * 42,
      force,
      seed: this.random() * TAU,
      kind
    });
    if (this.inkEntries.length > 140) this.inkEntries.splice(0, this.inkEntries.length - 140);
  }

  addRipple(x, y, force = 1) {
    this.ripples.push({ x, y, age: 0, life: 1.4 + force * 0.22, radius: 16 + force * 14, force });
    if (this.ripples.length > 80) this.ripples.shift();
  }

  dropPetal(x = this.random() * this.width, y = -24) {
    this.petals.push({
      x,
      y,
      vx: (this.random() - 0.5) * 24,
      vy: 18 + this.random() * 42,
      rot: this.random() * TAU,
      vr: (this.random() - 0.5) * 1.7,
      sway: this.random() * TAU,
      scale: 0.72 + this.random() * 0.54,
      age: 0,
      life: 20 + this.random() * 16,
      floating: false,
      color: this.random() > 0.35 ? "rgba(213, 111, 98, 0.76)" : "rgba(238, 200, 188, 0.78)"
    });
    if (this.petals.length > 42) this.petals.shift();
  }

  createBloom(x, y, colorKey) {
    const color = INK_COLORS[colorKey] || INK_COLORS.sumi;
    const spokes = 10;
    for (let i = 0; i < spokes; i += 1) {
      const angle = (i / spokes) * TAU + this.random() * 0.25;
      const power = 160 + this.random() * 160;
      const dx = Math.cos(angle) * power;
      const dy = Math.sin(angle) * power;
      this.fluid.addDye(x / this.width, 1 - y / this.height, color.rgb, 0.008 + this.random() * 0.004, 0.32);
      this.fluid.addVelocity(x / this.width, 1 - y / this.height, dx * 0.28, -dy * 0.28, 0.007, 0.38);
      this.addInkEntry(x, y, colorKey, 1.1, "drop");
    }
    for (let i = 0; i < 5; i += 1) {
      this.dropPetal(x + (this.random() - 0.5) * 70, y - 80 - this.random() * 70);
    }
    this.addRipple(x, y, 1.9);
    this.rememberInk(x, y, colorKey, 90, 1.45);
  }

  clear() {
    this.memory.length = 0;
    this.inkEntries.length = 0;
    this.ripples.length = 0;
    this.petals.length = 0;
    this.bubbles.length = 0;
  }

  update(dt, time) {
    const safeDt = clamp(dt, 0.001, 0.04);
    this.updateMemory(safeDt);
    this.updateInkEntries(safeDt);
    this.updatePetals(safeDt);
    this.updateFish(safeDt, time);
    this.updateBubbles(safeDt);
    if (!this.reducedMotion) this.updateAuto(safeDt);
    this.summon.strength = lerp(this.summon.strength, this.summon.active ? 1 : 0, 1 - Math.pow(0.02, safeDt));
  }

  updateMemory(dt) {
    for (let i = this.memory.length - 1; i >= 0; i -= 1) {
      const mark = this.memory[i];
      mark.age += dt;
      mark.cooldown = Math.max(0, mark.cooldown - dt);
      if (mark.age > mark.life) this.memory.splice(i, 1);
    }
  }

  updateInkEntries(dt) {
    for (let i = this.inkEntries.length - 1; i >= 0; i -= 1) {
      const entry = this.inkEntries[i];
      entry.age += dt;
      if (entry.age >= entry.life) this.inkEntries.splice(i, 1);
    }
  }

  updatePetals(dt) {
    for (let i = this.petals.length - 1; i >= 0; i -= 1) {
      const petal = this.petals[i];
      petal.age += dt;
      petal.sway += dt * 2.1;
      petal.rot += petal.vr * dt;

      if (!petal.floating) {
        petal.x += (petal.vx + Math.sin(petal.sway) * 20) * dt;
        petal.y += petal.vy * dt;
        const landing = this.height * (0.22 + this.random() * 0.54);
        if (petal.y > landing) {
          petal.floating = true;
          petal.vy = 4 + this.random() * 5;
          petal.vx *= 0.35;
          this.addRipple(petal.x, petal.y, 0.6);
      this.fluid.addDye(petal.x / this.width, 1 - petal.y / this.height, INK_COLORS.sumi.rgb, 0.0028, 0.006);
        }
      } else {
        petal.x += (petal.vx * 0.28 + Math.sin(petal.sway) * 6) * dt;
        petal.y += petal.vy * dt;
      }

      if (petal.age > petal.life || petal.x < -60 || petal.x > this.width + 60 || petal.y > this.height + 60) {
        this.petals.splice(i, 1);
      }
    }
  }

  updateFish(dt, time) {
    const margin = 74;
    for (let i = 0; i < this.fish.length; i += 1) {
      const fish = this.fish[i];
      fish.phase += dt * (2.1 + fish.currentSpeed * 0.025 + fish.react * 2.4);
      fish.react = Math.max(0, fish.react - dt);
      fish.dart = Math.max(0, fish.dart - dt * 1.25);
      fish.memoryCooldown = Math.max(0, fish.memoryCooldown - dt);

      fish.wanderTimer -= dt;
      if (fish.wanderTimer <= 0) {
        fish.wanderTimer = 1.8 + this.random() * 4.2;
        fish.targetHeading = fish.heading + (this.random() - 0.5) * 1.15 + Math.sin(time * 0.2 + fish.drift) * 0.35;
        fish.targetSpeed = fish.speed * (0.45 + this.random() * 0.72);
        if (this.random() < 0.08) fish.dart = 1;
      }

      let desired = fish.targetHeading + Math.sin(time * 0.42 + fish.drift * 4.0) * 0.22;
      if (this.summon.strength > 0.02) {
        const dx = this.summon.x - fish.x;
        const dy = this.summon.y - fish.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 16) {
          desired = Math.atan2(dy, dx);
          fish.react = Math.max(fish.react, this.summon.strength * 0.8);
          fish.targetSpeed = fish.speed * 1.25;
        }
      }

      for (let j = 0; j < this.fish.length; j += 1) {
        if (i === j) continue;
        const other = this.fish[j];
        const d = dist(fish.x, fish.y, other.x, other.y);
        if (d > 0 && d < fish.size * 1.1) {
          desired += Math.atan2(fish.y - other.y, fish.x - other.x) * 0.035;
        }
      }

      if (fish.x < margin) desired = 0;
      if (fish.x > this.width - margin) desired = Math.PI;
      if (fish.y < margin) desired = Math.PI * 0.5;
      if (fish.y > this.height - margin) desired = -Math.PI * 0.5;

      let turn = desired - fish.heading;
      while (turn > Math.PI) turn -= TAU;
      while (turn < -Math.PI) turn += TAU;
      fish.heading += clamp(turn, -dt * (0.75 + fish.react), dt * (0.75 + fish.react));

      const desiredSpeed = fish.targetSpeed * (0.78 + fish.react * 0.6 + fish.dart * 0.7) * (this.reducedMotion ? 0.58 : 1);
      fish.currentSpeed = lerp(fish.currentSpeed, desiredSpeed, 1 - Math.pow(0.06, dt));
      const wave = Math.sin(fish.phase) * (0.055 + fish.react * 0.06 + fish.dart * 0.08);
      const glide = 0.88 + 0.12 * Math.sin(time * 0.33 + fish.drift * 3.7);
      const speed = fish.currentSpeed * glide;
      fish.vx = Math.cos(fish.heading + wave) * speed;
      fish.vy = Math.sin(fish.heading + wave) * speed;
      fish.x += fish.vx * dt;
      fish.y += fish.vy * dt;
      fish.x = clamp(fish.x, 20, this.width - 20);
      fish.y = clamp(fish.y, 20, this.height - 20);

      fish.wake -= dt;
      if (fish.wake <= 0) {
        fish.wake = this.reducedMotion ? 0.5 : 0.36;
        if (fish.react > 0.35 || this.summon.strength > 0.15) {
          this.fluid.addVelocity(
            fish.x / this.width,
            1 - fish.y / this.height,
            fish.vx * 0.18,
            -fish.vy * 0.18,
            0.0018 + fish.size / 42000,
            0.28
          );
        }
      }

      this.reactivateMemory(fish);
    }
  }

  reactivateMemory(fish) {
    if (fish.memoryCooldown > 0) return;
    for (const mark of this.memory) {
      if (mark.cooldown > 0) continue;
      const d = dist(fish.x, fish.y, mark.x, mark.y);
      if (d < mark.radius * 0.76 + fish.size * 0.5) {
        mark.cooldown = 2.2;
        fish.memoryCooldown = 0.8;
        fish.react = Math.max(fish.react, 0.8);
        this.fluid.addVelocity(
          fish.x / this.width,
          1 - fish.y / this.height,
          fish.vx * 0.28,
          -fish.vy * 0.28,
          0.0032,
          0.38
        );
        this.fluid.addDye(fish.x / this.width, 1 - fish.y / this.height, mark.rgb, 0.0038, 0.018 * mark.intensity);
        this.addRipple(fish.x, fish.y, 0.45);
        break;
      }
    }
  }

  updateBubbles(dt) {
    if (!this.reducedMotion && this.random() < dt * 0.22 && this.bubbles.length < 14) {
      this.bubbles.push({
        x: this.random() * this.width,
        y: this.height + 20,
        r: 2 + this.random() * 5,
        vx: (this.random() - 0.5) * 10,
        vy: 10 + this.random() * 22,
        age: 0,
        life: 7 + this.random() * 5
      });
    }

    for (let i = this.bubbles.length - 1; i >= 0; i -= 1) {
      const bubble = this.bubbles[i];
      bubble.age += dt;
      bubble.x += bubble.vx * dt + Math.sin(bubble.age * 2) * 3 * dt;
      bubble.y -= bubble.vy * dt;
      if (bubble.age > bubble.life || bubble.y < -20) this.bubbles.splice(i, 1);
    }
  }

  updateAuto(dt) {
    if (!this.auto.enabled) return;
    this.auto.next -= dt;
    if (this.auto.next > 0) return;

    this.auto.next = 1.2 + this.random() * 2.2;
    const colorKeys = Object.keys(INK_COLORS);
    const colorKey = colorKeys[Math.floor(this.random() * colorKeys.length)];
    const color = INK_COLORS[colorKey];
    const x = this.width * (0.18 + this.random() * 0.64);
    const y = this.height * (0.2 + this.random() * 0.58);

    if (this.random() < 0.34) {
      this.createBloom(x, y, colorKey);
      return;
    }

    const angle = this.random() * TAU;
    const length = 90 + this.random() * 230;
    const steps = 5 + Math.floor(this.random() * 7);
    for (let i = 0; i < steps; i += 1) {
      const t = i / Math.max(1, steps - 1);
      const px = x + Math.cos(angle) * (t - 0.5) * length + Math.sin(t * Math.PI) * 54 * (this.random() - 0.5);
      const py = y + Math.sin(angle) * (t - 0.5) * length + Math.sin(t * Math.PI) * 54 * (this.random() - 0.5);
      const dx = Math.cos(angle) * (160 + this.random() * 90);
      const dy = Math.sin(angle) * (160 + this.random() * 90);
      this.fluid.addDye(px / this.width, 1 - py / this.height, color.rgb, 0.006 + this.random() * 0.004, 0.22);
      this.fluid.addVelocity(px / this.width, 1 - py / this.height, dx * 0.22, -dy * 0.22, 0.006, 0.32);
      this.addInkEntry(px, py, colorKey, 0.42, "stroke");
      this.rememberInk(px, py, colorKey, 45 + this.random() * 42, 0.78);
    }

    if (this.random() < 0.55) this.dropPetal(x + (this.random() - 0.5) * 180, -20);
    this.addRipple(x, y, 1);
  }

  draw(time) {
    this.drawPaper(time);
    this.drawFish(time);
    this.drawSurface(time);
  }

  drawPaper(time) {
    const ctx = this.paper;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const g = ctx.createRadialGradient(
      this.width * 0.52,
      this.height * 0.42,
      0,
      this.width * 0.52,
      this.height * 0.46,
      Math.max(this.width, this.height) * 0.82
    );
    g.addColorStop(0, "#f4f5ea");
    g.addColorStop(0.62, "#e9ebdf");
    g.addColorStop(1, "#d2dac8");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);

    if (this.paperPattern) {
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = this.paperPattern;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
    }

    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    for (const mark of this.memory) {
      const life = 1 - mark.age / mark.life;
      const pulse = 1 + Math.sin(time * 0.36 + mark.seed) * 0.04;
      const radius = mark.radius * (1.2 + (1 - life) * 0.65) * pulse;
      const stain = ctx.createRadialGradient(mark.x, mark.y, radius * 0.08, mark.x, mark.y, radius);
      stain.addColorStop(0, hexToRgba(mark.color, 0.045 * life));
      stain.addColorStop(0.58, hexToRgba(mark.color, 0.026 * life));
      stain.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = stain;
      ctx.beginPath();
      ctx.ellipse(mark.x, mark.y, radius * 1.22, radius * 0.78, mark.seed, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    const moon = ctx.createRadialGradient(this.width * 0.78, this.height * 0.22, 0, this.width * 0.78, this.height * 0.22, 160);
    moon.addColorStop(0, "rgba(255, 255, 238, 0.18)");
    moon.addColorStop(1, "rgba(255, 255, 238, 0)");
    ctx.fillStyle = moon;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  drawFish(time) {
    const ctx = this.fishCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    ctx.save();
    for (const bubble of this.bubbles) {
      const alpha = clamp(1 - bubble.age / bubble.life, 0, 1) * 0.16;
      ctx.strokeStyle = `rgba(255, 255, 246, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(bubble.x, bubble.y, bubble.r, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();

    const sorted = [...this.fish].sort((a, b) => a.depth - b.depth || a.y - b.y);
    for (const fish of sorted) this.drawSingleFish(ctx, fish, time);
  }

  drawSingleFish(ctx, fish) {
    const s = fish.size;
    const tailWave = Math.sin(fish.phase) * (0.18 + fish.react * 0.08 + fish.dart * 0.14);
    const bodyWave = Math.sin(fish.phase * 0.62) * s * 0.018;
    const alpha = clamp(0.34 + (1 - fish.depth) * 0.19 + fish.react * 0.07, 0.3, 0.58);

    ctx.save();
    ctx.translate(fish.x, fish.y);
    ctx.rotate(fish.heading);
    ctx.filter = `blur(${fish.depth * 0.22}px)`;
    ctx.globalAlpha = alpha;

    ctx.globalAlpha = alpha * 0.20;
    ctx.fillStyle = "#101315";
    ctx.beginPath();
    ctx.ellipse(6, 18 + fish.depth * 10, s * 0.62, s * 0.16, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = alpha;

    ctx.save();
    ctx.translate(-s * 0.52, 0);
    ctx.rotate(tailWave);
    ctx.fillStyle = fish.fin;
    ctx.globalAlpha = alpha * 0.48;
    ctx.beginPath();
    ctx.moveTo(s * 0.03, 0);
    ctx.bezierCurveTo(-s * 0.22, -s * 0.36, -s * 0.54, -s * 0.24, -s * 0.34, bodyWave);
    ctx.bezierCurveTo(-s * 0.54, s * 0.24, -s * 0.22, s * 0.36, s * 0.03, 0);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = fish.fin;
    ctx.globalAlpha = alpha * 0.34;
    ctx.beginPath();
    ctx.ellipse(-s * 0.02, -s * 0.22, s * 0.24, s * 0.07, -0.45, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-s * 0.03, s * 0.22, s * 0.22, s * 0.065, 0.45, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = alpha;

    const body = ctx.createLinearGradient(-s * 0.45, -s * 0.2, s * 0.46, s * 0.2);
    body.addColorStop(0, fish.fin);
    body.addColorStop(0.18, fish.body);
    body.addColorStop(0.58, fish.belly);
    body.addColorStop(1, fish.body);
    ctx.shadowColor = "rgba(26, 34, 35, 0.14)";
    ctx.shadowBlur = s * 0.12;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(s * 0.48, 0);
    ctx.bezierCurveTo(s * 0.32, -s * 0.21, -s * 0.20, -s * 0.29 + bodyWave, -s * 0.53, -s * 0.04);
    ctx.bezierCurveTo(-s * 0.27, s * 0.25 + bodyWave, s * 0.22, s * 0.25, s * 0.48, 0);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.save();
    ctx.clip();
    ctx.globalAlpha = alpha * 0.18;
    ctx.strokeStyle = "#4b3c2e";
    ctx.lineWidth = Math.max(0.6, s * 0.011);
    for (let k = 0; k < 5; k += 1) {
      const x = -s * 0.24 + k * s * 0.13;
      ctx.beginPath();
      ctx.arc(x, 0, s * (0.13 + k * 0.003), -0.9, 0.9);
      ctx.stroke();
    }
    ctx.restore();

    if (fish.cap) {
      ctx.fillStyle = fish.cap;
      ctx.globalAlpha = alpha * 0.7;
      ctx.beginPath();
      ctx.ellipse(s * 0.24, -s * 0.04, s * 0.18, s * 0.12, -0.18, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = alpha;
    }

    ctx.fillStyle = "rgba(255,255,245,0.52)";
    ctx.globalAlpha = alpha * 0.38;
    ctx.beginPath();
    ctx.ellipse(s * 0.02, -s * 0.065, s * 0.24, s * 0.045, -0.05, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = alpha * 0.72;
    ctx.fillStyle = "#151718";
    ctx.beginPath();
    ctx.arc(s * 0.39, -s * 0.052, Math.max(1.5, s * 0.027), 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.58)";
    ctx.beginPath();
    ctx.arc(s * 0.41, -s * 0.066, Math.max(0.9, s * 0.012), 0, TAU);
    ctx.fill();

    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = 0.12 + fish.depth * 0.14;
    ctx.fillStyle = "#e9ebdf";
    ctx.fillRect(-s * 0.72, -s * 0.42, s * 1.3, s * 0.84);
    ctx.globalCompositeOperation = "source-over";

    ctx.restore();
  }

  drawSurface(time) {
    const ctx = this.surface;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    ctx.save();
    for (let i = this.ripples.length - 1; i >= 0; i -= 1) {
      const ripple = this.ripples[i];
      ripple.age += 1 / 60;
      const t = ripple.age / ripple.life;
      if (t >= 1) {
        this.ripples.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = `rgba(255, 255, 246, ${0.28 * (1 - t)})`;
      ctx.lineWidth = 1 + ripple.force * 0.45;
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, ripple.radius + t * 76 * ripple.force, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();

    this.drawInkEntries(ctx, time);

    for (const petal of this.petals) {
      const life = clamp(1 - petal.age / petal.life, 0, 1);
      ctx.save();
      ctx.translate(petal.x, petal.y);
      ctx.rotate(petal.rot + Math.sin(time + petal.sway) * 0.18);
      ctx.globalAlpha = life * 0.86;
      ctx.fillStyle = petal.color;
      drawPetalShape(ctx, petal.scale);
      ctx.fill();
      ctx.strokeStyle = "rgba(145, 72, 67, 0.18)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.restore();
    }

    if (this.cursor.active) {
      const color = INK_COLORS[this.cursor.color] || INK_COLORS.sumi;
      const size = this.cursor.tool === "vortex" ? 42 : this.cursor.tool === "water" ? 34 : 24;
      ctx.save();
      ctx.globalAlpha = 0.54;
      ctx.strokeStyle = this.cursor.tool === "water" ? "rgba(255,255,248,0.9)" : color.css;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(this.cursor.x, this.cursor.y, size + Math.sin(time * 5) * 2, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawInkEntries(ctx, time) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    for (const entry of this.inkEntries) {
      const t = clamp(entry.age / entry.life, 0, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      const alpha = (entry.kind === "stroke" ? 0.2 : 0.34) * (1 - t);
      const radius = entry.radius * (0.58 + ease * 1.15);
      const wobble = 1 + Math.sin(time * 3.1 + entry.seed) * 0.035;
      const ink = ctx.createRadialGradient(entry.x, entry.y, radius * 0.05, entry.x, entry.y, radius * wobble);
      ink.addColorStop(0, hexToRgba(entry.color, alpha * 0.86));
      ink.addColorStop(0.52, hexToRgba(entry.color, alpha * 0.38));
      ink.addColorStop(1, hexToRgba(entry.color, 0));
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.ellipse(entry.x, entry.y, radius * (1.1 + 0.08 * Math.sin(entry.seed)), radius * 0.78, entry.seed, 0, TAU);
      ctx.fill();

      if (entry.kind !== "stroke") {
        ctx.globalAlpha = 0.22 * (1 - t);
        ctx.strokeStyle = entry.color;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(entry.x, entry.y, radius * (0.6 + t * 0.35), 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }
}
