const SCALE = [146.83, 164.81, 196.0, 220.0, 246.94, 293.66, 329.63, 392.0, 440.0, 493.88];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class GardenAudio {
  constructor({ reducedMotion = false } = {}) {
    this.reducedMotion = reducedMotion;
    this.ctx = null;
    this.input = null;
    this.master = null;
    this.delay = null;
    this.feedback = null;
    this.wet = null;
    this.enabled = false;
    this.timer = 0;
    this.lastInteraction = 0;
    this.waterSource = null;
  }

  async toggle() {
    if (this.enabled) {
      this.stop();
      return false;
    }
    await this.start();
    return true;
  }

  async start() {
    if (!this.ctx) this.createGraph();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.enabled = true;
    this.startWaterBed();
    this.scheduleAmbient();
  }

  stop() {
    this.enabled = false;
    window.clearTimeout(this.timer);
    if (this.ctx && this.ctx.state === "running") this.ctx.suspend();
  }

  createGraph() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error("Web Audio is not available");
    this.ctx = new AudioContext();
    this.input = this.ctx.createGain();
    this.master = this.ctx.createGain();
    this.delay = this.ctx.createDelay(4);
    this.feedback = this.ctx.createGain();
    this.wet = this.ctx.createGain();

    this.input.gain.value = 0.9;
    this.master.gain.value = 0.28;
    this.delay.delayTime.value = 0.42;
    this.feedback.gain.value = 0.22;
    this.wet.gain.value = 0.16;

    this.input.connect(this.master);
    this.input.connect(this.delay);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.master);
    this.master.connect(this.ctx.destination);
  }

  startWaterBed() {
    if (!this.ctx || this.waterSource) return;
    const buffer = this.createNoiseBuffer(4.5);
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    source.loop = true;
    filter.type = "lowpass";
    filter.frequency.value = 620;
    filter.Q.value = 0.35;
    gain.gain.value = this.reducedMotion ? 0.006 : 0.012;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start();
    this.waterSource = source;
  }

  createNoiseBuffer(seconds) {
    const length = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      last = last * 0.985 + (Math.random() * 2 - 1) * 0.015;
      data[i] = last;
    }
    return buffer;
  }

  scheduleAmbient() {
    if (!this.enabled || !this.ctx) return;
    const delay = this.reducedMotion ? 4600 + Math.random() * 4200 : 1700 + Math.random() * 3800;
    this.timer = window.setTimeout(() => {
      if (!this.enabled || document.hidden) {
        this.scheduleAmbient();
        return;
      }
      const now = this.ctx.currentTime + 0.04;
      if (Math.random() < 0.22) {
        const start = Math.floor(Math.random() * 5);
        for (let i = 0; i < 3; i += 1) this.pluck(SCALE[start + i], 0.2 - i * 0.035, now + i * 0.11);
      } else {
        this.pluck(SCALE[Math.floor(Math.random() * SCALE.length)], 0.18 + Math.random() * 0.22, now);
      }
      if (Math.random() < 0.28) this.bell(SCALE[Math.floor(Math.random() * SCALE.length)] * 2, 0.08, now + 0.16);
      this.scheduleAmbient();
    }, delay);
  }

  onSplat(intensity = 0.5, colorKey = "sumi") {
    if (!this.enabled || !this.ctx) return;
    const nowMs = performance.now();
    if (nowMs - this.lastInteraction < 70) return;
    this.lastInteraction = nowMs;

    const colorOffsets = { sumi: 0, indigo: 2, cinnabar: 4, moss: 1 };
    const offset = colorOffsets[colorKey] || 0;
    const index = clamp(Math.floor(offset + intensity * 5 + Math.random() * 2), 0, SCALE.length - 1);
    const now = this.ctx.currentTime + 0.02;
    this.pluck(SCALE[index], clamp(0.08 + intensity * 0.22, 0.05, 0.38), now);
    if (intensity > 0.48) this.water(intensity, now);
  }

  onBloom(colorKey = "sumi") {
    if (!this.enabled || !this.ctx) return;
    const colorOffsets = { sumi: 2, indigo: 3, cinnabar: 5, moss: 1 };
    const start = colorOffsets[colorKey] || 2;
    const now = this.ctx.currentTime + 0.03;
    for (let i = 0; i < 4; i += 1) {
      this.pluck(SCALE[clamp(start + i, 0, SCALE.length - 1)], 0.22 - i * 0.025, now + i * 0.08);
    }
    this.bell(SCALE[clamp(start + 4, 0, SCALE.length - 1)] * 2, 0.12, now + 0.38);
  }

  pluck(freq, amount = 0.18, when = this.ctx.currentTime) {
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, when);
    osc.detune.setValueAtTime((Math.random() - 0.5) * 9, when);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(freq * 5.5, when);
    filter.frequency.exponentialRampToValueAtTime(freq * 1.4, when + 1.1);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, amount), when + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 1.35);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.input);
    osc.start(when);
    osc.stop(when + 1.45);
  }

  bell(freq, amount = 0.1, when = this.ctx.currentTime) {
    for (const ratio of [1, 2.01, 3.02]) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq * ratio, when);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(amount / ratio, when + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 2.2);
      osc.connect(gain);
      gain.connect(this.input);
      osc.start(when);
      osc.stop(when + 2.35);
    }
  }

  water(intensity = 0.5, when = this.ctx.currentTime) {
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    source.buffer = this.createNoiseBuffer(0.42);
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(420 + intensity * 860, when);
    filter.Q.value = 0.55;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.028 + intensity * 0.042, when + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.42);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.input);
    source.start(when);
    source.stop(when + 0.46);
  }
}
