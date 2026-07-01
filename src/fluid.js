const CONFIG = {
  SIM_RES: 256,
  DYE_RES: 1280,
  PRESSURE_ITER: 28,
  VEL_DISSIPATION: 0.16,
  DYE_DISSIPATION: 0.07,
  CURL: 14,
  SPLAT_RADIUS: 0.0026,
  SPLAT_FORCE: 5200
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function requireThree() {
  const three = globalThis.THREE;
  if (!three) throw new Error("Three.js is required for the original ink fluid engine");
  return three;
}

export class FluidSimulation {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = { reducedMotion: false, ...options };
    this.THREE = requireThree();
    this.config = { ...CONFIG };
    if (this.options.reducedMotion) {
      this.config.CURL = 6;
      this.config.PRESSURE_ITER = 16;
    }

    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;
    this.time = 0;
    this.washing = 0;

    this.initRenderer();
    this.initTargets();
    this.initMaterials();
  }

  initRenderer() {
    const THREE = this.THREE;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true
    });
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0xefeae0, 1);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.scene.add(this.quad);
  }

  initTargets() {
    this.velocity = null;
    this.dye = null;
    this.pressure = null;
    this.curlRT = null;
    this.divergeRT = null;
  }

  initMaterials() {
    const THREE = this.THREE;
    const VERT = `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `;

    const prog = (fragmentShader, uniforms) =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader,
        uniforms,
        depthTest: false,
        depthWrite: false
      });

    this.advectMat = prog(`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uVelocity, uSource;
      uniform vec2 uTexel;
      uniform float uDt, uDissipation;
      void main(){
        vec2 coord = vUv - uDt * texture2D(uVelocity, vUv).xy * uTexel;
        vec4 result = texture2D(uSource, coord);
        gl_FragColor = result / (1.0 + uDissipation * uDt);
      }
    `, {
      uVelocity: { value: null },
      uSource: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uDt: { value: 0 },
      uDissipation: { value: 0 }
    });

    this.splatMat = prog(`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTarget;
      uniform float uAspect, uRadius;
      uniform vec2 uPoint;
      uniform vec3 uColor;
      void main(){
        vec2 p = vUv - uPoint;
        p.x *= uAspect;
        vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
        gl_FragColor = vec4(texture2D(uTarget, vUv).rgb + splat, 1.0);
      }
    `, {
      uTarget: { value: null },
      uAspect: { value: 1 },
      uRadius: { value: 0.001 },
      uPoint: { value: new THREE.Vector2() },
      uColor: { value: new THREE.Vector3() }
    });

    this.curlMat = prog(`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uVelocity;
      uniform vec2 uTexel;
      void main(){
        float L = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
        float R = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
        float B = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
        float T = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
        gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
      }
    `, {
      uVelocity: { value: null },
      uTexel: { value: new THREE.Vector2() }
    });

    this.vorticityMat = prog(`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uVelocity, uCurl;
      uniform vec2 uTexel;
      uniform float uCurlStrength, uDt;
      void main(){
        float L = texture2D(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
        float R = texture2D(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
        float B = texture2D(uCurl, vUv - vec2(0.0, uTexel.y)).x;
        float T = texture2D(uCurl, vUv + vec2(0.0, uTexel.y)).x;
        float C = texture2D(uCurl, vUv).x;
        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= uCurlStrength * C;
        force.y *= -1.0;
        vec2 vel = texture2D(uVelocity, vUv).xy + force * uDt;
        gl_FragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
      }
    `, {
      uVelocity: { value: null },
      uCurl: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uCurlStrength: { value: 0 },
      uDt: { value: 0 }
    });

    this.divergeMat = prog(`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uVelocity;
      uniform vec2 uTexel;
      void main(){
        float L = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
        float R = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
        float B = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
        float T = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vUv.x - uTexel.x < 0.0) L = -C.x;
        if (vUv.x + uTexel.x > 1.0) R = -C.x;
        if (vUv.y - uTexel.y < 0.0) B = -C.y;
        if (vUv.y + uTexel.y > 1.0) T = -C.y;
        gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
      }
    `, {
      uVelocity: { value: null },
      uTexel: { value: new THREE.Vector2() }
    });

    this.pressureMat = prog(`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uPressure, uDivergence;
      uniform vec2 uTexel;
      void main(){
        float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
        float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
        float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
        float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
        float div = texture2D(uDivergence, vUv).x;
        gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
      }
    `, {
      uPressure: { value: null },
      uDivergence: { value: null },
      uTexel: { value: new THREE.Vector2() }
    });

    this.gradientMat = prog(`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uPressure, uVelocity;
      uniform vec2 uTexel;
      void main(){
        float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
        float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
        float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
        float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
        vec2 vel = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
        gl_FragColor = vec4(vel, 0.0, 1.0);
      }
    `, {
      uPressure: { value: null },
      uVelocity: { value: null },
      uTexel: { value: new THREE.Vector2() }
    });

    this.clearMat = prog(`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTexture;
      uniform float uValue;
      void main(){
        gl_FragColor = uValue * texture2D(uTexture, vUv);
      }
    `, {
      uTexture: { value: null },
      uValue: { value: 0.8 }
    });

    this.eraseMat = prog(`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTarget;
      uniform float uAspect, uRadius, uStrength;
      uniform vec2 uPoint;
      void main(){
        vec2 p = vUv - uPoint;
        p.x *= uAspect;
        float cut = exp(-dot(p, p) / uRadius) * uStrength;
        gl_FragColor = texture2D(uTarget, vUv) * clamp(1.0 - cut, 0.0, 1.0);
      }
    `, {
      uTarget: { value: null },
      uAspect: { value: 1 },
      uRadius: { value: 0.01 },
      uStrength: { value: 0.5 },
      uPoint: { value: new THREE.Vector2() }
    });

    this.displayMat = prog(`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uDye;
      uniform vec2 uTexel;
      uniform vec3 uPaper;
      uniform float uTime;

      float hash(vec2 p){
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      void main(){
        float fiber = noise(vUv * 420.0) * 0.028
                    + noise(vUv * 180.0) * 0.022
                    + noise(vUv * 60.0) * 0.018;
        vec3 A = texture2D(uDye, vUv).rgb;
        vec3 col = uPaper * exp(-A) + fiber;
        vec2 uv2 = vUv * (1.0 - vUv.yx);
        float vign = pow(uv2.x * uv2.y * 15.0, 0.18);
        col *= 0.92 + 0.08 * vign;
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `, {
      uDye: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uPaper: { value: new THREE.Vector3(0.937, 0.918, 0.878) },
      uTime: { value: 0 }
    });
  }

  makeRT(width, height) {
    const THREE = this.THREE;
    return new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false
    });
  }

  makeDoubleFBO(width, height) {
    const read = this.makeRT(width, height);
    const write = this.makeRT(width, height);
    return {
      read,
      write,
      texel: new this.THREE.Vector2(1 / width, 1 / height),
      swap() {
        const temp = this.read;
        this.read = this.write;
        this.write = temp;
      },
      resize: (nextWidth, nextHeight) => {
        read.setSize(nextWidth, nextHeight);
        write.setSize(nextWidth, nextHeight);
        this.clearRenderTarget(read);
        this.clearRenderTarget(write);
      }
    };
  }

  simSizes() {
    const aspect = this.width / Math.max(1, this.height);
    const sim = this.config.SIM_RES;
    const dye = Math.min(this.config.DYE_RES, Math.max(this.canvas.width, this.canvas.height));
    return aspect >= 1
      ? {
          sw: Math.round(sim * aspect),
          sh: sim,
          dw: Math.round(dye),
          dh: Math.round(dye / aspect)
        }
      : {
          sw: sim,
          sh: Math.round(sim / aspect),
          dw: Math.round(dye * aspect),
          dh: Math.round(dye)
        };
  }

  clearRenderTarget(target) {
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
  }

  resize(width, height, dpr = window.devicePixelRatio || 1) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = Math.min(dpr || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);

    const sizes = this.simSizes();
    const needsInit = !this.velocity;
    if (needsInit) {
      this.velocity = this.makeDoubleFBO(sizes.sw, sizes.sh);
      this.dye = this.makeDoubleFBO(sizes.dw, sizes.dh);
      this.pressure = this.makeDoubleFBO(sizes.sw, sizes.sh);
      this.curlRT = this.makeRT(sizes.sw, sizes.sh);
      this.divergeRT = this.makeRT(sizes.sw, sizes.sh);
      this.clearInk();
      return;
    }

    if (sizes.sw !== this.velocity.read.width || sizes.sh !== this.velocity.read.height) {
      this.velocity.read.setSize(sizes.sw, sizes.sh);
      this.velocity.write.setSize(sizes.sw, sizes.sh);
      this.velocity.texel.set(1 / sizes.sw, 1 / sizes.sh);
      this.pressure.read.setSize(sizes.sw, sizes.sh);
      this.pressure.write.setSize(sizes.sw, sizes.sh);
      this.pressure.texel.set(1 / sizes.sw, 1 / sizes.sh);
      this.curlRT.setSize(sizes.sw, sizes.sh);
      this.divergeRT.setSize(sizes.sw, sizes.sh);
      this.clearRenderTarget(this.velocity.read);
      this.clearRenderTarget(this.velocity.write);
      this.clearRenderTarget(this.pressure.read);
      this.clearRenderTarget(this.pressure.write);
    }

    if (sizes.dw !== this.dye.read.width || sizes.dh !== this.dye.read.height) {
      this.dye.read.setSize(sizes.dw, sizes.dh);
      this.dye.write.setSize(sizes.dw, sizes.dh);
      this.dye.texel.set(1 / sizes.dw, 1 / sizes.dh);
      this.clearRenderTarget(this.dye.read);
      this.clearRenderTarget(this.dye.write);
    }
  }

  blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  addVelocity(x, y, fx, fy, radius = this.config.SPLAT_RADIUS, strength = 1) {
    if (!this.velocity) return;
    const radiusMul = Math.max(0.2, radius / this.config.SPLAT_RADIUS);
    this.splatMat.uniforms.uTarget.value = this.velocity.read.texture;
    this.splatMat.uniforms.uAspect.value = this.width / Math.max(1, this.height);
    this.splatMat.uniforms.uPoint.value.set(clamp(x, 0, 1), clamp(y, 0, 1));
    this.splatMat.uniforms.uRadius.value = this.config.SPLAT_RADIUS * radiusMul;
    this.splatMat.uniforms.uColor.value.set(
      clamp(fx * strength, -1000, 1000),
      clamp(fy * strength, -1000, 1000),
      0
    );
    this.blit(this.splatMat, this.velocity.write);
    this.velocity.swap();
  }

  addDye(x, y, absorption, radius = this.config.SPLAT_RADIUS, strength = 1) {
    if (!this.dye) return;
    const radiusMul = Math.max(0.2, radius / this.config.SPLAT_RADIUS);
    this.splatMat.uniforms.uTarget.value = this.dye.read.texture;
    this.splatMat.uniforms.uAspect.value = this.width / Math.max(1, this.height);
    this.splatMat.uniforms.uPoint.value.set(clamp(x, 0, 1), clamp(y, 0, 1));
    this.splatMat.uniforms.uRadius.value = this.config.SPLAT_RADIUS * radiusMul;
    this.splatMat.uniforms.uColor.value.set(absorption[0] * strength, absorption[1] * strength, absorption[2] * strength);
    this.blit(this.splatMat, this.dye.write);
    this.dye.swap();
  }

  addSplat(x, y, dx, dy, absorption, radius = this.config.SPLAT_RADIUS, strength = 1) {
    this.addVelocity(x, y, dx, dy, radius, 1);
    this.addDye(x, y, absorption, radius, strength);
  }

  erase(x, y, radius = 0.018, strength = 0.78) {
    if (!this.dye) return;
    this.eraseMat.uniforms.uTarget.value = this.dye.read.texture;
    this.eraseMat.uniforms.uAspect.value = this.width / Math.max(1, this.height);
    this.eraseMat.uniforms.uPoint.value.set(clamp(x, 0, 1), clamp(y, 0, 1));
    this.eraseMat.uniforms.uRadius.value = Math.max(0.0001, radius);
    this.eraseMat.uniforms.uStrength.value = clamp(strength, 0, 1);
    this.blit(this.eraseMat, this.dye.write);
    this.dye.swap();
  }

  clearInk() {
    if (!this.velocity || !this.dye || !this.pressure) return;
    for (const target of [
      this.velocity.read,
      this.velocity.write,
      this.dye.read,
      this.dye.write,
      this.pressure.read,
      this.pressure.write,
      this.curlRT,
      this.divergeRT
    ]) {
      this.clearRenderTarget(target);
    }
    this.render();
  }

  step(dt) {
    if (!this.velocity || !this.dye) return;
    const safeDt = Math.min(Math.max(dt, 0.0001), 1 / 30);
    this.time += safeDt;

    this.curlMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.curlMat.uniforms.uTexel.value.copy(this.velocity.texel);
    this.blit(this.curlMat, this.curlRT);

    this.vorticityMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.vorticityMat.uniforms.uCurl.value = this.curlRT.texture;
    this.vorticityMat.uniforms.uTexel.value.copy(this.velocity.texel);
    this.vorticityMat.uniforms.uCurlStrength.value = this.config.CURL;
    this.vorticityMat.uniforms.uDt.value = safeDt;
    this.blit(this.vorticityMat, this.velocity.write);
    this.velocity.swap();

    this.divergeMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.divergeMat.uniforms.uTexel.value.copy(this.velocity.texel);
    this.blit(this.divergeMat, this.divergeRT);

    this.clearMat.uniforms.uTexture.value = this.pressure.read.texture;
    this.clearMat.uniforms.uValue.value = 0.8;
    this.blit(this.clearMat, this.pressure.write);
    this.pressure.swap();

    this.pressureMat.uniforms.uDivergence.value = this.divergeRT.texture;
    this.pressureMat.uniforms.uTexel.value.copy(this.velocity.texel);
    for (let i = 0; i < this.config.PRESSURE_ITER; i += 1) {
      this.pressureMat.uniforms.uPressure.value = this.pressure.read.texture;
      this.blit(this.pressureMat, this.pressure.write);
      this.pressure.swap();
    }

    this.gradientMat.uniforms.uPressure.value = this.pressure.read.texture;
    this.gradientMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.gradientMat.uniforms.uTexel.value.copy(this.velocity.texel);
    this.blit(this.gradientMat, this.velocity.write);
    this.velocity.swap();

    this.advectMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.advectMat.uniforms.uSource.value = this.velocity.read.texture;
    this.advectMat.uniforms.uTexel.value.copy(this.velocity.texel);
    this.advectMat.uniforms.uDt.value = safeDt;
    this.advectMat.uniforms.uDissipation.value = this.config.VEL_DISSIPATION;
    this.blit(this.advectMat, this.velocity.write);
    this.velocity.swap();

    this.advectMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.advectMat.uniforms.uSource.value = this.dye.read.texture;
    this.advectMat.uniforms.uTexel.value.copy(this.dye.texel);
    this.advectMat.uniforms.uDissipation.value = this.config.DYE_DISSIPATION + (this.washing > 0 ? 2.4 : 0);
    this.blit(this.advectMat, this.dye.write);
    this.dye.swap();
    if (this.washing > 0) this.washing -= safeDt;

    this.render();
  }

  wash(seconds = 1.6) {
    this.washing = Math.max(this.washing, seconds);
  }

  render() {
    if (!this.dye) return;
    this.displayMat.uniforms.uDye.value = this.dye.read.texture;
    this.displayMat.uniforms.uTexel.value.copy(this.dye.texel);
    this.displayMat.uniforms.uTime.value = this.time;
    this.blit(this.displayMat, null);
  }
}
