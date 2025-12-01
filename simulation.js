/**
 * Lantern Simulation
 * A Three.js-based floating lantern visualization with physics and interactivity.
 * 
 * All parameters are tunable via the CONFIG object and UI controls.
 */

import * as THREE from "https://unpkg.com/three@0.165.0/build/three.module.js";
import { RoundedBoxGeometry } from "https://unpkg.com/three@0.165.0/examples/jsm/geometries/RoundedBoxGeometry.js?module";

// =============================================================================
// CONFIGURATION - All tunable parameters in one place
// =============================================================================

const CONFIG = {
  // Camera
  camera: {
    fov: 45,
    near: 0.1,
    far: 100,
    position: { x: 0, y: 5, z: 22 },
    lookAt: { x: 0, y: 5, z: 0 },
  },

  // Lighting
  lighting: {
    ambient: {
      color: 0xffffff,
      intensity: 0.7,
    },
    directional: {
      color: 0xffffff,
      intensity: 0.9,
      position: { x: 6, y: 12, z: 8 },
      shadow: {
        mapSize: 1024,
        near: 1,
        far: 50,
      },
    },
  },

  // Lantern geometry
  lantern: {
    width: 0.6,
    height: 1.0,
    depth: 0.6,
    cornerRadius: 0.3,
    smoothness: 5,
    flareFactor: 1.3,
    count: 110,
  },

  // Basket (under each lantern)
  basket: {
    widthRatio: 0.35,
    depthRatio: 0.35,
    heightRatio: 0.18,
    color: 0xd6b48a,
    metalness: 0.25,
    roughness: 0.9,
  },

  // Physics
  physics: {
    gravity: -0.2,
    liftStrength: 1.2,
    buoyancyRiseRate: 200.5,
    buoyancyDecayRate: 0.4,
    buoyancyDecayVariance: { min: 0.6, max: 1.6 },
    horizontalDrag: 0.949,
    verticalDrag: 0.995,
    maxVerticalSpeed: 4.0,
    collisionRestitution: 0.3,
  },

  // Spawning & bounds
  spawn: {
    initialVelocity: {
      x: { spread: 0.6 },
      y: { min: -0.9, max: -0.1 },
      z: { spread: 0.6 },
    },
    initialBuoyancy: { maxFactor: 0.4 },
    zBounds: { min: -8, max: 4 },
    xMarginMultiplier: 1.3,
    ySpawnOffset: 4,
    yOffOffset: 4,
  },

  // Wobble motion
  wobble: {
    ampX: { min: 0.4, max: 1.0 },
    ampZ: { min: 0.3, max: 0.8 },
    speedX: { min: 0.4, max: 1.0 },
    speedZ: { min: 0.4, max: 1.0 },
  },

  // Angular velocity
  rotation: {
    ySpeed: { spread: 0.6 },
  },

  // Random lighting behavior
  randomLight: {
    rate: 0.08,
    thresholdY: 0.8,
  },

  // Hover interaction
  hover: {
    radius: 0.3,
  },

  // Visual appearance
  appearance: {
    brightColor: 0xfff6a0,
    glowColor: 0xc4c47a,
    opacity: 0.9,
    metalness: 0.0,
    roughness: 0.9,
    baseEmissiveIntensity: 0.3,
    maxEmissiveBoost: 1.0,
    litBrightnessBoost: 0.35,
    litColorMix: 0.25,
  },

  // Pattern generation
  patterns: {
    types: ["checker", "horizontal", "diagonal"],
    checker: { cellsY: 6, cellsA: 8 },
    horizontal: { stripes: 8 },
    diagonal: { stripes: 9 },

    // NEW: global controls
    density: 1.0,          // scales how many pattern repetitions we see
    baseColor: 0xffb347,   // default pattern base color (matches HTML default)
    paletteStrength: 1.0,  // how strong accent colors are vs base

    offColor: {
      saturation: { min: 0.95, max: 1.0 },
      lightness: { min: 0.35, max: 0.43 },
    },
    paletteOffsets: {
      color2: { h: 0.05, s: 0.08, l: 0.1 },
      color3: { h: -0.05, s: -0.05, l: -0.08 },
    },
  },
};

// =============================================================================
// SIMULATION CLASS
// =============================================================================

class LanternSimulation {
  constructor(container, controls = {}) {
    this.container = container;
    this.controls = controls;
    this.paused = false;
    this.lanterns = [];
    this.lastTime = performance.now();

    // Live-adjustable colors and opacity
    this.brightColor = new THREE.Color(CONFIG.appearance.brightColor);
    this.glowColor = new THREE.Color(CONFIG.appearance.glowColor);
    this.globalOpacity = CONFIG.appearance.opacity;
    // NEW: base pattern color
    this.patternBaseColor = new THREE.Color(CONFIG.patterns.baseColor || 0xffb347);

    // Temp objects for calculations
    this.tempColor = new THREE.Color();
    this.tempHSL = { h: 0, s: 0, l: 0 };
    this.tmpScreenPos = new THREE.Vector3();
    this.pointer = new THREE.Vector2();

    // Bounds (updated on resize)
    this.bounds = {
      yMin: -2,
      yMax: 14,
      ySpawnTop: 18,
      yOffBottom: -6,
      xVisible: 10,
      xOff: 14,
      zMin: CONFIG.spawn.zBounds.min,
      zMax: CONFIG.spawn.zBounds.max,
    };

    this.init();
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  init() {
    this.setupRenderer();
    this.setupCamera();
    this.setupLights();
    this.setupGeometry();
    this.spawnLanterns();
    this.setupEventListeners();
    this.setupUIControls();
    this.updateVisibleBounds();
    this.animate(performance.now());
  }

  getSize() {
    const rect = this.container.getBoundingClientRect();
    return {
      width: rect.width || this.container.clientWidth || 800,
      height: rect.height || this.container.clientHeight || 400,
    };
  }

  setupRenderer() {
    const size = this.getSize();

    this.scene = new THREE.Scene();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(size.width, size.height);
    this.renderer.shadowMap.enabled = true;

    this.container.appendChild(this.renderer.domElement);
  }

  setupCamera() {
    const size = this.getSize();
    const { fov, near, far, position, lookAt } = CONFIG.camera;

    this.camera = new THREE.PerspectiveCamera(fov, size.width / size.height, near, far);
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.lookAt(lookAt.x, lookAt.y, lookAt.z);

    this.viewCenter = new THREE.Vector3(lookAt.x, lookAt.y, lookAt.z);
  }

  setupLights() {
    const { ambient, directional } = CONFIG.lighting;

    this.scene.add(new THREE.AmbientLight(ambient.color, ambient.intensity));

    this.dirLight = new THREE.DirectionalLight(directional.color, directional.intensity);
    this.dirLight.position.set(directional.position.x, directional.position.y, directional.position.z);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(directional.shadow.mapSize, directional.shadow.mapSize);
    this.dirLight.shadow.camera.near = directional.shadow.near;
    this.dirLight.shadow.camera.far = directional.shadow.far;

    this.scene.add(this.dirLight);
  }

  setupGeometry() {
    const { width, height, depth, cornerRadius, smoothness, flareFactor } = CONFIG.lantern;

    // Create rounded box geometry
    this.lanternGeo = new RoundedBoxGeometry(width, height, depth, smoothness, cornerRadius);

    // Flare the top
    const posAttr = this.lanternGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      if (posAttr.getY(i) > 0) {
        posAttr.setX(i, posAttr.getX(i) * flareFactor);
        posAttr.setZ(i, posAttr.getZ(i) * flareFactor);
      }
    }
    posAttr.needsUpdate = true;
    this.lanternGeo.computeVertexNormals();
    this.lanternGeo.computeBoundingBox();

    // Precompute vertex factors
    const { min, max } = this.lanternGeo.boundingBox;
    this.lanternMinY = min.y;
    this.lanternMaxY = max.y;
    const heightRange = max.y - min.y;
    const vertexCount = posAttr.count;

    this.vertexCount = vertexCount;
    this.heightFactors = new Float32Array(vertexCount);
    this.angleFactors = new Float32Array(vertexCount);

    for (let i = 0; i < vertexCount; i++) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const z = posAttr.getZ(i);

      this.heightFactors[i] = (y - min.y) / heightRange;
      this.angleFactors[i] = (Math.atan2(z, x) + Math.PI) / (Math.PI * 2);
    }

    // Basket geometry
    const { basket } = CONFIG;
    this.basketGeo = new THREE.BoxGeometry(
      width * basket.widthRatio,
      height * basket.heightRatio,
      depth * basket.depthRatio
    );
    this.basketMat = new THREE.MeshStandardMaterial({
      color: basket.color,
      metalness: basket.metalness,
      roughness: basket.roughness,
    });

    // Collision radius
    this.collisionRadius = Math.max(width * flareFactor, height) * 0.35;
  }

  // ---------------------------------------------------------------------------
  // Lantern Creation
  // ---------------------------------------------------------------------------

  createPaletteFromBase(baseColor) {
    const { paletteOffsets, paletteStrength } = CONFIG.patterns;
    const strength = paletteStrength ?? 1.0;

    return [
      baseColor.clone(),
      baseColor.clone().offsetHSL(
        paletteOffsets.color2.h * strength,
        paletteOffsets.color2.s * strength,
        paletteOffsets.color2.l * strength
      ),
      baseColor.clone().offsetHSL(
        paletteOffsets.color3.h * strength,
        paletteOffsets.color3.s * strength,
        paletteOffsets.color3.l * strength
      ),
    ];
  }

  spawnLantern(isInitial = false) {
    const mat = this.createLanternMaterial();
    const geo = this.lanternGeo.clone();

    const colors = new Float32Array(this.vertexCount * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const lantern = new THREE.Mesh(geo, mat);
    lantern.castShadow = true;
    lantern.receiveShadow = false;

    // Add basket
    const basket = new THREE.Mesh(this.basketGeo, this.basketMat);
    basket.castShadow = true;
    basket.position.y = this.lanternMinY - (CONFIG.lantern.height * CONFIG.basket.heightRatio) * 0.7;
    lantern.add(basket);

    // Initialize user data
    const { wobble, rotation, spawn, patterns } = CONFIG;

    lantern.userData = {
      velocity: new THREE.Vector3(),
      buoyancy: 0,
      hovered: false,
      decayRate: CONFIG.physics.buoyancyDecayRate * THREE.MathUtils.randFloat(
        CONFIG.physics.buoyancyDecayVariance.min,
        CONFIG.physics.buoyancyDecayVariance.max
      ),
      angularVelocity: new THREE.Vector3(0, THREE.MathUtils.randFloatSpread(rotation.ySpeed.spread), 0),
      wobble: {
        ampX: THREE.MathUtils.randFloat(wobble.ampX.min, wobble.ampX.max),
        ampZ: THREE.MathUtils.randFloat(wobble.ampZ.min, wobble.ampZ.max),
        speedX: THREE.MathUtils.randFloat(wobble.speedX.min, wobble.speedX.max),
        speedZ: THREE.MathUtils.randFloat(wobble.speedZ.min, wobble.speedZ.max),
        phaseX: Math.random() * Math.PI * 2,
        phaseZ: Math.random() * Math.PI * 2,
      },
      material: mat,
    };

    // Generate base pattern color for this lantern
    const offColor = new THREE.Color();

    // If a base pattern color is defined, use it for all lanterns;
    // otherwise fall back to the older random HSL behavior.
    if (this.patternBaseColor) {
      offColor.copy(this.patternBaseColor);
    } else {
      offColor.setHSL(
        Math.random(),
        patterns.offColor.saturation.min +
          Math.random() * (patterns.offColor.saturation.max - patterns.offColor.saturation.min),
        patterns.offColor.lightness.min +
          Math.random() * (patterns.offColor.lightness.max - patterns.offColor.lightness.min)
      );
    }
    lantern.userData.offColor = offColor;

    const patternType = patterns.types[Math.floor(Math.random() * patterns.types.length)];
    lantern.userData.pattern = {
      type: patternType,
      palette: this.createPaletteFromBase(offColor),
      stripes: patterns[patternType]?.stripes || 8,
      cellsY: patterns.checker.cellsY,
      cellsA: patterns.checker.cellsA,
    };

    this.resetLantern(lantern, isInitial);
    this.scene.add(lantern);
    this.lanterns.push(lantern);
  }

  createLanternMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      metalness: CONFIG.appearance.metalness,
      roughness: CONFIG.appearance.roughness,
      transparent: this.globalOpacity < 1,
      opacity: this.globalOpacity,
      emissive: this.glowColor.clone(),
      emissiveIntensity: 0.0,
      side: THREE.DoubleSide,
    });
  }

  resetLantern(lantern, isInitial = false) {
    const { spawn } = CONFIG;

    const spawnYMin = isInitial ? this.bounds.yOffBottom : this.bounds.yMax + 2;
    const spawnYMax = this.bounds.ySpawnTop;

    lantern.position.set(
      THREE.MathUtils.randFloatSpread(this.bounds.xVisible * 2.0),
      THREE.MathUtils.randFloat(spawnYMin, spawnYMax),
      THREE.MathUtils.randFloat(this.bounds.zMin, this.bounds.zMax)
    );

    lantern.userData.velocity.set(
      THREE.MathUtils.randFloatSpread(spawn.initialVelocity.x.spread),
      THREE.MathUtils.randFloat(spawn.initialVelocity.y.min, spawn.initialVelocity.y.max),
      THREE.MathUtils.randFloatSpread(spawn.initialVelocity.z.spread)
    );

    lantern.userData.buoyancy = Math.random() * Math.random() * spawn.initialBuoyancy.maxFactor;
    lantern.userData.hovered = false;
  }

  spawnLanterns() {
    for (let i = 0; i < CONFIG.lantern.count; i++) {
      this.spawnLantern(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Bounds & Visibility
  // ---------------------------------------------------------------------------

  updateVisibleBounds() {
    const { width, height } = this.getSize();
    const aspect = width / height || 1;
    const dist = this.camera.position.distanceTo(this.viewCenter);
    const vHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * dist;

    this.bounds.yMin = this.viewCenter.y - vHalf;
    this.bounds.yMax = this.viewCenter.y + vHalf;
    this.bounds.ySpawnTop = this.bounds.yMax + CONFIG.spawn.ySpawnOffset;
    this.bounds.yOffBottom = this.bounds.yMin - CONFIG.spawn.yOffOffset;

    const hHalf = vHalf * aspect;
    this.bounds.xVisible = hHalf;
    this.bounds.xOff = hHalf * CONFIG.spawn.xMarginMultiplier;

    this.bounds.zMin = CONFIG.spawn.zBounds.min;
    this.bounds.zMax = CONFIG.spawn.zBounds.max;
  }

  // ---------------------------------------------------------------------------
  // Pattern Colors
  // ---------------------------------------------------------------------------

  applyPatternColor(pattern, vertexIndex, outColor) {
    if (!pattern?.palette?.length) {
      outColor.set(0xffffff);
      return;
    }

    const density = CONFIG.patterns.density ?? 1.0;

    const h = this.heightFactors[vertexIndex];
    const a = this.angleFactors[vertexIndex];
    const palette = pattern.palette;
    const len = palette.length;

    let idx;
    switch (pattern.type) {
      case "checker": {
        const iy = Math.floor(h * pattern.cellsY * density);
        const ia = Math.floor(a * pattern.cellsA * density);
        idx = (iy + ia) % len;
        break;
      }
      case "horizontal": {
        idx = Math.floor(h * pattern.stripes * density) % len;
        break;
      }
      case "diagonal":
      default: {
        const v = (h + a) * pattern.stripes * density;
        idx = Math.floor(v) % len;
        break;
      }
    }

    outColor.copy(palette[(idx + len) % len]);
  }

  // ---------------------------------------------------------------------------
  // Physics
  // ---------------------------------------------------------------------------

  handleCollisions() {
    const minDist = this.collisionRadius * 2;
    const minDistSq = minDist * minDist;
    const restitution = CONFIG.physics.collisionRestitution;

    for (let i = 0; i < this.lanterns.length; i++) {
      const a = this.lanterns[i];
      const pa = a.position;
      const va = a.userData.velocity;

      for (let j = i + 1; j < this.lanterns.length; j++) {
        const b = this.lanterns[j];
        const pb = b.position;
        const vb = b.userData.velocity;

        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const dz = pb.z - pa.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq === 0 || distSq > minDistSq) continue;

        const dist = Math.sqrt(distSq);
        const overlap = minDist - dist;
        if (overlap <= 0) continue;

        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;
        const halfCorrection = overlap * 0.5;

        pa.x -= nx * halfCorrection;
        pa.y -= ny * halfCorrection;
        pa.z -= nz * halfCorrection;
        pb.x += nx * halfCorrection;
        pb.y += ny * halfCorrection;
        pb.z += nz * halfCorrection;

        const rvx = vb.x - va.x;
        const rvy = vb.y - va.y;
        const rvz = vb.z - va.z;
        const velAlongNormal = rvx * nx + rvy * ny + rvz * nz;

        if (velAlongNormal > 0) continue;

        const jImpulse = -(1 + restitution) * velAlongNormal * 0.5;
        const impulseX = jImpulse * nx;
        const impulseY = jImpulse * ny;
        const impulseZ = jImpulse * nz;

        va.x -= impulseX;
        va.y -= impulseY;
        va.z -= impulseZ;
        vb.x += impulseX;
        vb.y += impulseY;
        vb.z += impulseZ;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event Listeners
  // ---------------------------------------------------------------------------

  setupEventListeners() {
    // Pause button
    const pauseBtn = this.container.closest(".hero-media")?.querySelector("[data-sim-pause]");
    if (pauseBtn) {
      pauseBtn.addEventListener("click", () => {
        this.paused = !this.paused;
        pauseBtn.textContent = this.paused ? "Play" : "Pause";
      });
    }

    // Pointer events
    this.renderer.domElement.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.renderer.domElement.addEventListener("pointerleave", () => this.onPointerLeave());

    // Resize
    window.addEventListener("resize", () => this.onResize());
  }

  onPointerMove(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const hoverRadiusSq = CONFIG.hover.radius * CONFIG.hover.radius;

    for (const lantern of this.lanterns) {
      this.tmpScreenPos.copy(lantern.position).project(this.camera);
      const dx = this.tmpScreenPos.x - this.pointer.x;
      const dy = this.tmpScreenPos.y - this.pointer.y;
      lantern.userData.hovered = (dx * dx + dy * dy) < hoverRadiusSq;
    }
  }

  onPointerLeave() {
    for (const lantern of this.lanterns) {
      lantern.userData.hovered = false;
    }
  }

  onResize() {
    const { width, height } = this.getSize();
    if (!width || !height) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.updateVisibleBounds();
  }

  // ---------------------------------------------------------------------------
  // UI Controls
  // ---------------------------------------------------------------------------

  setupUIControls() {
    const { controls } = this;

    // Bright color
    if (controls.brightInput) {
      controls.brightInput.value = "#" + this.brightColor.getHexString();
      if (controls.brightLabel) controls.brightLabel.textContent = controls.brightInput.value;

      controls.brightInput.addEventListener("input", () => {
        this.brightColor.set(controls.brightInput.value);
        if (controls.brightLabel) controls.brightLabel.textContent = controls.brightInput.value;
      });
    }

    // Glow color
    if (controls.glowInput) {
      controls.glowInput.value = "#" + this.glowColor.getHexString();
      if (controls.glowLabel) controls.glowLabel.textContent = controls.glowInput.value;

      controls.glowInput.addEventListener("input", () => {
        this.glowColor.set(controls.glowInput.value);
        if (controls.glowLabel) controls.glowLabel.textContent = controls.glowInput.value;
      });
    }

    // Opacity
    if (controls.opacityInput) {
      controls.opacityInput.value = String(this.globalOpacity);
      if (controls.opacityLabel) controls.opacityLabel.textContent = this.globalOpacity.toFixed(2);

      controls.opacityInput.addEventListener("input", () => {
        this.globalOpacity = THREE.MathUtils.clamp(parseFloat(controls.opacityInput.value) || 0.9, 0, 1);
        if (controls.opacityLabel) controls.opacityLabel.textContent = this.globalOpacity.toFixed(2);

        for (const lantern of this.lanterns) {
          const mat = lantern.userData.material;
          mat.opacity = this.globalOpacity;
          mat.transparent = this.globalOpacity < 1;
        }
      });
    }

    // NEW: Pattern base color
    if (controls.patternBaseInput) {
      controls.patternBaseInput.value = "#" + this.patternBaseColor.getHexString();
      if (controls.patternBaseLabel) {
        controls.patternBaseLabel.textContent = controls.patternBaseInput.value;
      }

      controls.patternBaseInput.addEventListener("input", () => {
        this.patternBaseColor.set(controls.patternBaseInput.value);
        if (controls.patternBaseLabel) {
          controls.patternBaseLabel.textContent = controls.patternBaseInput.value;
        }

        // Apply new base color to all lanterns and rebuild palettes
        for (const lantern of this.lanterns) {
          lantern.userData.offColor.copy(this.patternBaseColor);
          lantern.userData.pattern.palette = this.createPaletteFromBase(lantern.userData.offColor);
        }
      });
    }

    // Physics controls
    this.setupPhysicsControl("gravityInput", "gravityLabel", "gravity", (v) => CONFIG.physics.gravity = v);
    this.setupPhysicsControl("liftInput", "liftLabel", "liftStrength", (v) => CONFIG.physics.liftStrength = v);
    this.setupPhysicsControl("buoyancyRiseInput", "buoyancyRiseLabel", "buoyancyRiseRate", (v) => CONFIG.physics.buoyancyRiseRate = v);
    this.setupPhysicsControl("buoyancyDecayInput", "buoyancyDecayLabel", "buoyancyDecayRate", (v) => CONFIG.physics.buoyancyDecayRate = v);
    this.setupPhysicsControl("hDragInput", "hDragLabel", "horizontalDrag", (v) => CONFIG.physics.horizontalDrag = v);
    this.setupPhysicsControl("vDragInput", "vDragLabel", "verticalDrag", (v) => CONFIG.physics.verticalDrag = v);
    this.setupPhysicsControl("maxSpeedInput", "maxSpeedLabel", "maxVerticalSpeed", (v) => CONFIG.physics.maxVerticalSpeed = v);
    this.setupPhysicsControl("collisionInput", "collisionLabel", "collisionRestitution", (v) => CONFIG.physics.collisionRestitution = v);

    // Appearance controls
    this.setupPhysicsControl("metalnessInput", "metalnessLabel", null, (v) => {
      CONFIG.appearance.metalness = v;
      for (const lantern of this.lanterns) lantern.userData.material.metalness = v;
    });
    this.setupPhysicsControl("roughnessInput", "roughnessLabel", null, (v) => {
      CONFIG.appearance.roughness = v;
      for (const lantern of this.lanterns) lantern.userData.material.roughness = v;
    });
    this.setupPhysicsControl("baseEmissiveInput", "baseEmissiveLabel", null, (v) => CONFIG.appearance.baseEmissiveIntensity = v);
    this.setupPhysicsControl("emissiveBoostInput", "emissiveBoostLabel", null, (v) => CONFIG.appearance.maxEmissiveBoost = v);

    // Wobble controls
    this.setupPhysicsControl("wobbleAmpXInput", "wobbleAmpXLabel", null, (v) => {
      CONFIG.wobble.ampX.max = v;
      CONFIG.wobble.ampX.min = v * 0.4;
    });
    this.setupPhysicsControl("wobbleAmpZInput", "wobbleAmpZLabel", null, (v) => {
      CONFIG.wobble.ampZ.max = v;
      CONFIG.wobble.ampZ.min = v * 0.375;
    });
    this.setupPhysicsControl("wobbleSpeedInput", "wobbleSpeedLabel", null, (v) => {
      CONFIG.wobble.speedX.max = v;
      CONFIG.wobble.speedX.min = v * 0.4;
      CONFIG.wobble.speedZ.max = v;
      CONFIG.wobble.speedZ.min = v * 0.4;
    });

    // Hover radius
    this.setupPhysicsControl("hoverRadiusInput", "hoverRadiusLabel", null, (v) => CONFIG.hover.radius = v);

    // Random light rate
    this.setupPhysicsControl("randomLightInput", "randomLightLabel", null, (v) => CONFIG.randomLight.rate = v);

    // Lighting controls
    this.setupPhysicsControl("ambientIntensityInput", "ambientIntensityLabel", null, (v) => {
      CONFIG.lighting.ambient.intensity = v;
      this.scene.children.find(c => c instanceof THREE.AmbientLight).intensity = v;
    });
    this.setupPhysicsControl("directionalIntensityInput", "directionalIntensityLabel", null, (v) => {
      CONFIG.lighting.directional.intensity = v;
      this.dirLight.intensity = v;
    });

    // NEW: Pattern density (how many stripes / cells)
    this.setupPhysicsControl("patternDensityInput", "patternDensityLabel", null, (v) => {
      CONFIG.patterns.density = v;
      // no per-lantern change needed; density is used at sampling time
    });

    // NEW: Pattern color strength (how strong accent colors are)
    this.setupPhysicsControl("patternStrengthInput", "patternStrengthLabel", null, (v) => {
      CONFIG.patterns.paletteStrength = v;

      // Rebuild palettes so new strength takes effect immediately
      for (const lantern of this.lanterns) {
        lantern.userData.pattern.palette = this.createPaletteFromBase(lantern.userData.offColor);
      }
    });
  }

  setupPhysicsControl(inputKey, labelKey, configKey, setter) {
    const input = this.controls[inputKey];
    const label = this.controls[labelKey];

    if (!input) return;

    if (configKey && CONFIG.physics[configKey] !== undefined) {
      input.value = String(CONFIG.physics[configKey]);
    }

    if (label) {
      const step = input.step && input.step.includes(".")
        ? input.step.split(".")[1].length
        : 2;
      label.textContent = parseFloat(input.value).toFixed(step);
    }

    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) return;
      setter(v);
      if (label) {
        const step = input.step && input.step.includes(".")
          ? input.step.split(".")[1].length
          : 2;
        label.textContent = v.toFixed(step);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Animation Loop
  // ---------------------------------------------------------------------------

  animate(now) {
    const dt = Math.min((now - this.lastTime) / 1000, 0.05) || 0.016;
    this.lastTime = now;
    const time = now * 0.001;

    if (!this.paused) {
      this.updateLanterns(dt, time);
      this.handleCollisions();
    }

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame((t) => this.animate(t));
  }

  updateLanterns(dt, time) {
    const { physics, randomLight, appearance } = CONFIG;

    for (const lantern of this.lanterns) {
      const v = lantern.userData.velocity;
      const mat = lantern.userData.material;
      const isHovered = lantern.userData.hovered;

      // Update buoyancy
      let b = lantern.userData.buoyancy || 0;

      if (isHovered) {
        b += physics.buoyancyRiseRate * dt;
      } else if (b > 0) {
        b -= lantern.userData.decayRate * dt;
      }

      // Random lighting
      if (!isHovered && b <= 0.01 && lantern.position.y < this.bounds.yMax * randomLight.thresholdY) {
        if (Math.random() < randomLight.rate * dt) {
          b = 1.0;
        }
      }

      b = THREE.MathUtils.clamp(b, 0, 1);
      lantern.userData.buoyancy = b;

      // Apply forces
      const ay = physics.gravity + physics.liftStrength * b;
      v.y += ay * dt;

      // Wobble
      const wobble = lantern.userData.wobble;
      if (wobble) {
        v.x += Math.sin(time * wobble.speedX + wobble.phaseX) * wobble.ampX * dt;
        v.z += Math.cos(time * wobble.speedZ + wobble.phaseZ) * wobble.ampZ * dt;
      }

      // Drag
      v.x *= physics.horizontalDrag;
      v.y *= physics.verticalDrag;
      v.z *= physics.horizontalDrag;

      // Clamp speed
      v.y = THREE.MathUtils.clamp(v.y, -physics.maxVerticalSpeed, physics.maxVerticalSpeed);

      // Update position
      lantern.position.x += v.x * dt;
      lantern.position.y += v.y * dt;
      lantern.position.z += v.z * dt;

      // Rotation
      if (lantern.userData.angularVelocity) {
        lantern.rotation.y += lantern.userData.angularVelocity.y * dt;
      }

      // Recycle if out of bounds
      if (
        lantern.position.y < this.bounds.yOffBottom ||
        lantern.position.y > this.bounds.ySpawnTop ||
        lantern.position.x < -this.bounds.xOff ||
        lantern.position.x > this.bounds.xOff
      ) {
        this.resetLantern(lantern, false);
      }

      // Bounce off depth walls
      if (lantern.position.z < this.bounds.zMin) {
        lantern.position.z = this.bounds.zMin;
        v.z = Math.abs(v.z) * 0.6;
      } else if (lantern.position.z > this.bounds.zMax) {
        lantern.position.z = this.bounds.zMax;
        v.z = -Math.abs(v.z) * 0.6;
      }

      // Update vertex colors
      this.updateLanternColors(lantern, b);

      // Update material
      mat.emissive.copy(this.glowColor);
      mat.emissiveIntensity = appearance.baseEmissiveIntensity + appearance.maxEmissiveBoost * b;
      mat.opacity = this.globalOpacity;
      mat.transparent = this.globalOpacity < 1;
    }
  }

  updateLanternColors(lantern, buoyancy) {
    const { appearance } = CONFIG;
    const geom = lantern.geometry;
    const colorAttr = geom.attributes.color;
    const colorArray = colorAttr.array;
    const pattern = lantern.userData.pattern;

    for (let i = 0; i < this.vertexCount; i++) {
      this.applyPatternColor(pattern, i, this.tempColor);

      if (buoyancy > 0) {
        this.tempColor.getHSL(this.tempHSL);

        const h = this.heightFactors[i];
        const grad = buoyancy * (1.0 - h);
        const extraLight = appearance.litBrightnessBoost * grad;

        this.tempHSL.l = Math.min(1, this.tempHSL.l + extraLight);
        this.tempColor.setHSL(this.tempHSL.h, this.tempHSL.s, this.tempHSL.l);
        this.tempColor.lerp(this.brightColor, appearance.litColorMix * buoyancy);
      }

      const idx = i * 3;
      colorArray[idx] = this.tempColor.r;
      colorArray[idx + 1] = this.tempColor.g;
      colorArray[idx + 2] = this.tempColor.b;
    }

    colorAttr.needsUpdate = true;
  }
}

// =============================================================================
// BOOTSTRAP
// =============================================================================

const SIMULATIONS = {
  lanterns: (container, controls) => new LanternSimulation(container, controls),
};

document.addEventListener("DOMContentLoaded", () => {
  const container = document.querySelector("[data-hero-sim]");
  if (!container) return;

  const simName = container.dataset.sim || "lanterns";
  const simFn = SIMULATIONS[simName];

  const controls = {
    // Appearance
    brightInput: document.querySelector("[data-bright-color]"),
    brightLabel: document.querySelector("[data-bright-preview]"),
    glowInput: document.querySelector("[data-glow-color]"),
    glowLabel: document.querySelector("[data-glow-preview]"),
    opacityInput: document.querySelector("[data-opacity]"),
    opacityLabel: document.querySelector("[data-opacity-value]"),
    metalnessInput: document.querySelector("[data-metalness]"),
    metalnessLabel: document.querySelector("[data-metalness-value]"),
    roughnessInput: document.querySelector("[data-roughness]"),
    roughnessLabel: document.querySelector("[data-roughness-value]"),
    baseEmissiveInput: document.querySelector("[data-base-emissive]"),
    baseEmissiveLabel: document.querySelector("[data-base-emissive-value]"),
    emissiveBoostInput: document.querySelector("[data-emissive-boost]"),
    emissiveBoostLabel: document.querySelector("[data-emissive-boost-value]"),

    // NEW: Patterns
    patternBaseInput: document.querySelector("[data-pattern-base-color]"),
    patternBaseLabel: document.querySelector("[data-pattern-base-preview]"),
    patternDensityInput: document.querySelector("[data-pattern-density]"),
    patternDensityLabel: document.querySelector("[data-pattern-density-value]"),
    patternStrengthInput: document.querySelector("[data-pattern-strength]"),
    patternStrengthLabel: document.querySelector("[data-pattern-strength-value]"),

    // Physics
    gravityInput: document.querySelector("[data-gravity]"),
    gravityLabel: document.querySelector("[data-gravity-value]"),
    liftInput: document.querySelector("[data-lift]"),
    liftLabel: document.querySelector("[data-lift-value]"),
    buoyancyRiseInput: document.querySelector("[data-buoyancy-rise]"),
    buoyancyRiseLabel: document.querySelector("[data-buoyancy-rise-value]"),
    buoyancyDecayInput: document.querySelector("[data-buoyancy-decay]"),
    buoyancyDecayLabel: document.querySelector("[data-buoyancy-decay-value]"),
    hDragInput: document.querySelector("[data-h-drag]"),
    hDragLabel: document.querySelector("[data-h-drag-value]"),
    vDragInput: document.querySelector("[data-v-drag]"),
    vDragLabel: document.querySelector("[data-v-drag-value]"),
    maxSpeedInput: document.querySelector("[data-max-speed]"),
    maxSpeedLabel: document.querySelector("[data-max-speed-value]"),
    collisionInput: document.querySelector("[data-collision]"),
    collisionLabel: document.querySelector("[data-collision-value]"),

    // Wobble
    wobbleAmpXInput: document.querySelector("[data-wobble-amp-x]"),
    wobbleAmpXLabel: document.querySelector("[data-wobble-amp-x-value]"),
    wobbleAmpZInput: document.querySelector("[data-wobble-amp-z]"),
    wobbleAmpZLabel: document.querySelector("[data-wobble-amp-z-value]"),
    wobbleSpeedInput: document.querySelector("[data-wobble-speed]"),
    wobbleSpeedLabel: document.querySelector("[data-wobble-speed-value]"),

    // Interaction
    hoverRadiusInput: document.querySelector("[data-hover-radius]"),
    hoverRadiusLabel: document.querySelector("[data-hover-radius-value]"),
    randomLightInput: document.querySelector("[data-random-light]"),
    randomLightLabel: document.querySelector("[data-random-light-value]"),

    // Lighting
    ambientIntensityInput: document.querySelector("[data-ambient-intensity]"),
    ambientIntensityLabel: document.querySelector("[data-ambient-intensity-value]"),
    directionalIntensityInput: document.querySelector("[data-directional-intensity]"),
    directionalIntensityLabel: document.querySelector("[data-directional-intensity-value]"),
  };

  if (typeof simFn === "function") {
    simFn(container, controls);
  }
});
