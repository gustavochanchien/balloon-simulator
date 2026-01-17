/**
 * simulation.js — Hot-Air Balloons (daytime/dawn)
 *
 * High-level flow:
 *  1) Build scene + materials (instanced envelope + gondola).
 *  2) Maintain per-instance state arrays (pos/vel/rotation/buoyancy).
 *  3) Gather interaction “influencers” (mouse raycast, wrists, fingertips, or full-body boxes).
 *  4) Convert influencers → buoyancy, then integrate physics and write instance matrices.
 *
 * Notes for future work:
 *  - Instancing is the performance backbone: avoid per-balloon Mesh objects.
 *  - Screen-space hit testing is the default because it’s stable at distance.
 *  - “Orbs” are just visualized interaction points; fullBody has no orbs by design.
 */

import * as THREE from "https://unpkg.com/three@0.165.0/build/three.module.js";
import {
  PoseLandmarker,
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.skypack.dev/@mediapipe/tasks-vision@0.10.0";

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */
/**
 * CONFIG is intentionally centralized so this file can be tuned without hunting
 * constants. Anything expected to be tweaked at runtime is also exposed via
 * window.SIM (near the bottom).
 *
 * Beware: CONFIG.balloons.count is read once at init to allocate typed arrays,
 * create InstancedMesh, and seed instances. Changing it at runtime requires a
 * full re-init.
 */
const CONFIG = {
  balloons: {
    count: 400,
    scale: 1.25,
    zBounds: { min: -18, max: 10 },

    /**
     * Offscreen margin multiplier used for spawn/reset bounds in X.
     * Increasing this reduces “pop-in” at edges but keeps more balloons alive
     * outside the visible frustum.
     */
    xMarginMultiplier: 1.28,

    /**
     * Spawn/off offsets are defined relative to the computed camera frustum.
     * ySpawnOffset: how far above top-of-view to spawn.
     * yOffOffset:   how far below bottom-of-view counts as “dead”.
     */
    ySpawnOffset: 8,
    yOffOffset: 8,
  },

  envelope: {
    radialSegments: 18,

    /**
     * Lathe profile points: [radius, y] pairs in normalized-ish coordinates.
     * Think of this as a 2D silhouette spun around the Y axis.
     */
    profile: [
      [0.07, -0.62],
      [0.12, -0.52],
      [0.33, -0.28],
      [0.48, 0.0],
      [0.44, 0.26],
      [0.30, 0.50],
      [0.03, 0.62],
    ],
  },

  gondola: {
    /**
     * Gondola dimensions are derived from the envelope’s bounding box, then
     * scaled by these ratios. This keeps the basket proportional if the envelope
     * profile changes.
     */
    widthRatio: 0.20,
    depthRatio: 0.20,
    heightRatio: 0.12,

    // Simple “wicker” look; tune roughness/metalness for different materials.
    color: 0x8b6b46,
    metalness: 0.0,
    roughness: 1.0,
  },

  camera3d: {
    fov: 55,
    near: 0.1,
    far: 260,
    position: { x: 0, y: 6, z: 40 },
    lookAt: { x: 0, y: 6, z: 0 },
  },

  cameraOverlay: {
    /**
     * This is a DOM overlay placed ABOVE the camera video but BELOW the WebGL
     * canvas. It allows “grading” the background camera feed with either a
     * gradient or an image and a blend mode.
     *
     * If you later want to grade the 3D scene too, do it via postprocessing
     * (EffectComposer) rather than this overlay.
     */
    enabled: true,
    mode: "gradient", // "gradient" | "image"
    imageUrl: "", // used when mode === "image"
    opacity: 0.55,
    blendMode: "overlay", // "overlay" | "soft-light" | "screen" | "normal" etc.
    filter: "saturate(1.15) contrast(1.05)",
    gradientCss:
      "linear-gradient(0deg, rgba(255,120,180,0.85) 0%, rgba(155,90,210,0.75) 18%, rgba(40,60,140,0.70) 35%, rgba(70,110,230,0.65) 50%, rgba(70,110,230,0.65) 100%)",
  },

  lighting: {
    /**
     * Lighting is kept simple (ambient + directional) and most of the “dawn”
     * look comes from:
     *  - the environment PMREM texture (procedural sky gradient)
     *  - material clearcoat/roughness
     *  - the balloon pattern shader tweaks
     */
    ambient: { color: 0xffffff, intensity: 0.55 },
    directional: {
      color: 0xfff0e0,
      intensity: 1.15,
      position: { x: 10, y: 18, z: 10 },
    },
  },

  physics: {
    /**
     * This is intentionally “gamey” physics: stable, readable motion > realism.
     * All values assume dt is in seconds and are tuned for ~60fps.
     */
    gravity: -0.16,
    liftStrength: 1.35,

    /**
     * buoyancyRiseRate drives how quickly a balloon “lights” when hovered.
     * decayRate/variance make balloons fade at slightly different speeds.
     */
    buoyancyRiseRate: 520,
    buoyancyDecayRate: 0.65,
    buoyancyDecayVariance: { min: 0.65, max: 1.55 },

    // Drag keeps the swarm from accelerating indefinitely.
    horizontalDrag: 0.957,
    verticalDrag: 0.994,

    // Prevents runaway vertical spikes when buoyancy rises quickly.
    maxVerticalSpeed: 5.6,
  },

  wobble: {
    /**
     * Per-balloon wind wobble is generated by sin/cos with randomized amp/speed.
     * It gives the swarm depth without needing actual wind simulation.
     */
    ampX: { min: 0.18, max: 0.55 },
    ampZ: { min: 0.16, max: 0.50 },
    speedX: { min: 0.25, max: 0.85 },
    speedZ: { min: 0.25, max: 0.85 },
  },

  spawn: {
    /**
     * Initial velocity is biased to slow downward drift so balloons “enter”
     * rather than immediately rocket upwards.
     */
    initialVelocity: {
      x: { spread: 0.75 },
      y: { min: -0.48, max: -0.06 },
      z: { spread: 0.75 },
    },

    // Initial buoyancy adds subtle variance so not all balloons look “off”.
    initialBuoyancy: { maxFactor: 0.10 },
  },

  randomLight: {
    /**
     * Idle twinkles: when balloons are not hovered and below a threshold height,
     * they can randomly “ignite” to keep the scene lively.
     *
     * rate is probability per second (scaled by dt).
     * thresholdY is a fraction of the visible height.
     */
    rate: 0.0015,
    thresholdY: 0.90,
  },

  appearance: {
    /**
     * Balloon shading is customized via onBeforeCompile. These values map to
     * shader uniforms (uBrightColor/uFlameColor/etc.) so you can tune look
     * without editing shader code.
     */
    brightColor: 0xffddb0,
    flameColor: 0xff7a18,
    flameMix: 0.70,

    // Emissive is intentionally disabled in shader (see onBeforeCompile).
    baseEmissive: 0.02,
    boostEmissive: 3.0,

    // “Lit” behavior (hovered) biases towards brightColor + warmth.
    litBrightnessBoost: 0.22,
    litColorMix: 0.14,

    // Nudges patterns towards paper-white for a more balloon-like finish.
    paperWhiteMix: 0.0001,

    opacity: 1.0,

    // Physical material surface characteristics (affects env reflections).
    roughness: 0.48,
    clearcoat: 0.45,
    clearcoatRoughness: 0.48,
  },

  patterns: {
    /**
     * density: how many pattern repeats/panels.
     * paletteStrength: reserved for future use if you want to modulate contrast.
     */
    density: 1.05,
    paletteStrength: 1.05,
  },

  interaction: {
    /**
     * Interaction modes:
     *  - fingers: uses HandLandmarker fingertip points as hover influencers
     *  - wrists:  uses PoseLandmarker wrists as hover influencers
     *  - fullBody: uses pose bounding boxes in screen space; no orbs drawn
     */
    mouseEnabled: true,
    poseEnabled: true,
    mirror: false,

    trackMode: "fingers", // "fingers" | "wrists" | "fullBody"
    orbsVisible: true,

    // Upper bounds for Mediapipe; also used to size orb buffers.
    maxPeople: 4,
    maxHands: 4,

    /**
     * Hover testing approaches:
     *  - screen-space (default): compare NDC distance between balloon and orbs
     *  - world-space (legacy): compare 3D distance; less reliable at distance
     */
    hoverRadiusWorld: 5.8,
    useScreenSpaceHit: true,
    screenRadiusNDC: 0.065,
    screenRadiusMin: 0.03,
    screenRadiusMax: 0.10,

    // Orb visuals (purely cosmetic).
    orbColor: 0xff7a18,
    orbSize: 1.65,
    orbSizeLitBoost: 0.65,
    orbOpacity: 0.95,

    /**
     * orbSmoothing is a per-frame lerp strength (converted to an effective alpha
     * in the main loop). Higher = snappier, lower = floatier.
     */
    orbSmoothing: 0.14,

    /**
     * Orbs are “ephemeral”: points update when tracking provides new landmarks.
     * orbMaxTTL defines how long a point remains active if tracking stalls.
     */
    orbMaxTTL: 0.12,
  },

  render: {
    /**
     * Caps renderer pixel ratio for performance on high-DPI devices.
     */
    pixelRatioCap: 2,
  },

  pose: {
    /**
     * Mediapipe Pose indices. These match the pose landmark model definition.
     */
    leftWristIndex: 15,
    rightWristIndex: 16,

    wasmRoot: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm",
    modelAssetPath:
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    delegate: "GPU",
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  },

  hands: {
    wasmRoot: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm",
    modelAssetPath:
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    delegate: "GPU",
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  },
};

/* -------------------------------------------------------------------------- */
/* DOM LAYERS                                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Layering model (bottom -> top):
 *  1) <video id="cameraBg"> (fullscreen camera feed)
 *  2) #stage (container above video; pointerEvents:none)
 *     2a) $cameraOverlay (gradient/image grade)
 *  3) WebGL canvas (renderer.domElement) appended to <body> with high z-index
 *
 * Keep pointerEvents disabled on overlays/canvas so the Enable button works and
 * the page remains interactive if needed elsewhere.
 */
const $video = document.getElementById("cameraBg");
const $stage = document.getElementById("stage");
const $btn = document.getElementById("enableCameraBtn");

if (!$stage) throw new Error("Missing #stage.");
if (!$btn) throw new Error("Missing #enableCameraBtn.");
if (!$video) throw new Error("Missing #cameraBg <video>.");

$video.style.position = "fixed";
$video.style.inset = "0";
$video.style.width = "100vw";
$video.style.height = "100vh";
$video.style.objectFit = "cover";
$video.style.zIndex = "0";
$video.style.transform = "translateZ(0)";

$stage.style.position = "fixed";
$stage.style.inset = "0";
$stage.style.overflow = "hidden";
$stage.style.zIndex = "1";
$stage.style.pointerEvents = "none";

/* -------------------------------------------------------------------------- */
/* CAMERA OVERLAY (DOM)                                                        */
/* -------------------------------------------------------------------------- */
/**
 * $cameraOverlay is a lightweight way to color-grade the camera feed without
 * touching WebGL. It’s safe and cheap because it’s just CSS.
 *
 * If cfg.mode === "image", set cfg.imageUrl to a fully qualified URL or data URL.
 * If cfg.enabled === false, the overlay is hidden entirely.
 */
const $cameraOverlay = document.createElement("div");
$cameraOverlay.style.position = "absolute";
$cameraOverlay.style.inset = "0";
$cameraOverlay.style.pointerEvents = "none";
$cameraOverlay.style.zIndex = "0";
$cameraOverlay.style.willChange = "opacity, background-image, filter";
$stage.appendChild($cameraOverlay);

function applyCameraOverlayStyles() {
  const cfg = CONFIG.cameraOverlay;

  if (!cfg.enabled) {
    $cameraOverlay.style.display = "none";
    return;
  }

  $cameraOverlay.style.display = "block";
  $cameraOverlay.style.opacity = String(THREE.MathUtils.clamp(cfg.opacity ?? 0.55, 0, 1));
  $cameraOverlay.style.mixBlendMode = cfg.blendMode || "overlay";
  $cameraOverlay.style.filter = cfg.filter || "none";

  if ((cfg.mode || "gradient") === "image" && cfg.imageUrl) {
    $cameraOverlay.style.backgroundImage = `url("${cfg.imageUrl}")`;
    $cameraOverlay.style.backgroundSize = "cover";
    $cameraOverlay.style.backgroundPosition = "center";
    $cameraOverlay.style.backgroundRepeat = "no-repeat";
  } else {
    $cameraOverlay.style.backgroundImage = cfg.gradientCss;
    $cameraOverlay.style.backgroundSize = "100% 100%";
    $cameraOverlay.style.backgroundPosition = "center";
    $cameraOverlay.style.backgroundRepeat = "no-repeat";
  }
}
applyCameraOverlayStyles();

/* -------------------------------------------------------------------------- */
/* THREE.JS SETUP                                                              */
/* -------------------------------------------------------------------------- */
/**
 * Renderer is created with alpha:true so the camera feed shows through.
 * Tone mapping + SRGB are set for a more cinematic look with PhysicalMaterial.
 */
const scene = new THREE.Scene();

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.render.pixelRatioCap));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);

renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

renderer.domElement.style.position = "fixed";
renderer.domElement.style.left = "0";
renderer.domElement.style.top = "0";
renderer.domElement.style.width = "100vw";
renderer.domElement.style.height = "100vh";
renderer.domElement.style.zIndex = "9999";
renderer.domElement.style.display = "block";
renderer.domElement.style.pointerEvents = "none";

document.body.appendChild(renderer.domElement);

/* -------------------------------------------------------------------------- */
/* CAMERA + LIGHTING                                                           */
/* -------------------------------------------------------------------------- */
/**
 * Camera lookAt is fixed to a “viewCenter”. We compute spawn/reset bounds from
 * the camera frustum at the current distance to that center.
 *
 * If you later add camera motion (parallax, orbit, etc.), you MUST call
 * updateVisibleBounds() whenever camera or viewCenter changes.
 */
const camera = new THREE.PerspectiveCamera(
  CONFIG.camera3d.fov,
  window.innerWidth / window.innerHeight,
  CONFIG.camera3d.near,
  CONFIG.camera3d.far
);
camera.position.set(CONFIG.camera3d.position.x, CONFIG.camera3d.position.y, CONFIG.camera3d.position.z);

const viewCenter = new THREE.Vector3(CONFIG.camera3d.lookAt.x, CONFIG.camera3d.lookAt.y, CONFIG.camera3d.lookAt.z);
camera.lookAt(viewCenter);

{
  const amb = new THREE.AmbientLight(CONFIG.lighting.ambient.color, CONFIG.lighting.ambient.intensity);
  scene.add(amb);

  const dir = new THREE.DirectionalLight(CONFIG.lighting.directional.color, CONFIG.lighting.directional.intensity);
  dir.position.set(
    CONFIG.lighting.directional.position.x,
    CONFIG.lighting.directional.position.y,
    CONFIG.lighting.directional.position.z
  );
  scene.add(dir);
}

/* -------------------------------------------------------------------------- */
/* ENVIRONMENT (PMREM)                                                         */
/* -------------------------------------------------------------------------- */
/**
 * We generate a simple gradient “sky” texture in a canvas and feed it through
 * PMREM so PhysicalMaterial gets plausible reflections.
 *
 * This is cheaper than loading an HDR environment and removes external assets.
 * If you swap to an HDR, replace makeSkyEnvTexture() and keep PMREM.
 */
{
  const pmrem = new THREE.PMREMGenerator(renderer);

  function makeSkyEnvTexture() {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext("2d");

    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.0, "#7fb8ff");
    g.addColorStop(0.30, "#a88cff");
    g.addColorStop(0.55, "#ffd1e8");
    g.addColorStop(0.78, "#cfe9ff");
    g.addColorStop(1.0, "#ffffff");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  const envRT = pmrem.fromEquirectangular(makeSkyEnvTexture());
  scene.environment = envRT.texture;
  scene.background = null;
}

/* -------------------------------------------------------------------------- */
/* VIEW BOUNDS                                                                 */
/* -------------------------------------------------------------------------- */
/**
 * bounds defines the “simulation volume”:
 *  - yMin/yMax: current visible vertical range
 *  - ySpawnTop: where new balloons spawn
 *  - yOffBottom: below this we respawn a balloon
 *  - xVisible/xOff: visible vs offscreen margins for respawn
 *  - zMin/zMax: depth lane bounds
 */
const bounds = {
  yMin: -2,
  yMax: 14,
  ySpawnTop: 18,
  yOffBottom: -6,
  xVisible: 10,
  xOff: 14,
  zMin: CONFIG.balloons.zBounds.min,
  zMax: CONFIG.balloons.zBounds.max,
};

function updateVisibleBounds() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const aspect = w / h || 1;

  // Distance from camera to the plane around viewCenter where we “stage” orbs.
  const dist = camera.position.distanceTo(viewCenter);

  // Visible half-height at that distance.
  const vHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * dist;

  bounds.yMin = viewCenter.y - vHalf;
  bounds.yMax = viewCenter.y + vHalf;
  bounds.ySpawnTop = bounds.yMax + CONFIG.balloons.ySpawnOffset;
  bounds.yOffBottom = bounds.yMin - CONFIG.balloons.yOffOffset;

  const hHalf = vHalf * aspect;
  bounds.xVisible = hHalf;
  bounds.xOff = hHalf * CONFIG.balloons.xMarginMultiplier;

  bounds.zMin = CONFIG.balloons.zBounds.min;
  bounds.zMax = CONFIG.balloons.zBounds.max;
}
updateVisibleBounds();

/* -------------------------------------------------------------------------- */
/* INSTANCED STATE BUFFERS                                                     */
/* -------------------------------------------------------------------------- */
/**
 * Per-instance state is stored in typed arrays for speed and to minimize GC:
 *  - pos/vel/rot/ang: simulation state
 *  - buoy/decay: buoyancy “light” state
 *  - wobble params: per-balloon wind noise
 *
 * Separate GPU instance attributes are used to drive shader variation:
 *  - iBuoyancy: hover intensity (0..1)
 *  - iBaseTint: base color tint
 *  - iPatternType: selects pattern generator branch
 *  - iSeed: random seed for palette/pattern variance
 */
const N = CONFIG.balloons.count;

const posX = new Float32Array(N);
const posY = new Float32Array(N);
const posZ = new Float32Array(N);

const velX = new Float32Array(N);
const velY = new Float32Array(N);
const velZ = new Float32Array(N);

const rotY = new Float32Array(N);
const angY = new Float32Array(N);

const buoy = new Float32Array(N);
const decay = new Float32Array(N);

const wAmpX = new Float32Array(N);
const wAmpZ = new Float32Array(N);
const wSpdX = new Float32Array(N);
const wSpdZ = new Float32Array(N);
const wPhX = new Float32Array(N);
const wPhZ = new Float32Array(N);

// GPU instanced attrs
const iBuoy = new Float32Array(N);
const iBase = new Float32Array(N * 3);
const iPatternType = new Float32Array(N);
const iSeed = new Float32Array(N);

/* -------------------------------------------------------------------------- */
/* REUSABLE TEMP OBJECTS                                                       */
/* -------------------------------------------------------------------------- */
/**
 * These are shared scratch objects to avoid allocations inside hot loops.
 * Do not store references to these outside the frame they’re used.
 */
const tmpMat = new THREE.Matrix4();
const tmpMatG = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3(CONFIG.balloons.scale, CONFIG.balloons.scale, CONFIG.balloons.scale);
const tmpScaleG = new THREE.Vector3(1, 1, 1);
const yAxis = new THREE.Vector3(0, 1, 0);

/* -------------------------------------------------------------------------- */
/* COLOR + PATTERN SEEDING                                                     */
/* -------------------------------------------------------------------------- */
/**
 * Palette is intentionally “realistic balloon paint” (high saturation + neutrals).
 * randomVibrantTint writes linearized RGB into iBaseTint.
 */
const REAL_BALLOON_PALETTE = [
  0xd72638, 0xff6f00, 0xf9c80e, 0x2e7d32, 0x1565c0, 0x283593, 0x6a1b9a,
  0x00838f, 0x6d4c41, 0x263238, 0xffffff, 0xe0e0e0, 0x111111,
];

function randomVibrantTint(out, i3) {
  const hex = REAL_BALLOON_PALETTE[(Math.random() * REAL_BALLOON_PALETTE.length) | 0];
  const c = new THREE.Color(hex);
  out[i3 + 0] = c.r;
  out[i3 + 1] = c.g;
  out[i3 + 2] = c.b;
}

/**
 * resetInstance seeds a balloon at a random position and gives it:
 *  - initial drift velocity
 *  - random wobble parameters
 *  - a decay rate for buoyancy fade
 *  - a base tint + a pattern type + a seed
 *
 * isInitial influences spawn Y range so the scene starts filled (not empty).
 */
function resetInstance(i, isInitial) {
  const spawnYMin = isInitial ? bounds.yOffBottom : bounds.yMax + 2;
  const spawnYMax = bounds.ySpawnTop;

  posX[i] = THREE.MathUtils.randFloatSpread(bounds.xVisible * 2.0);
  posY[i] = THREE.MathUtils.randFloat(spawnYMin, spawnYMax);
  posZ[i] = THREE.MathUtils.randFloat(bounds.zMin, bounds.zMax);

  velX[i] = THREE.MathUtils.randFloatSpread(CONFIG.spawn.initialVelocity.x.spread);
  velY[i] = THREE.MathUtils.randFloat(CONFIG.spawn.initialVelocity.y.min, CONFIG.spawn.initialVelocity.y.max);
  velZ[i] = THREE.MathUtils.randFloatSpread(CONFIG.spawn.initialVelocity.z.spread);

  buoy[i] = Math.random() * Math.random() * CONFIG.spawn.initialBuoyancy.maxFactor;
  iBuoy[i] = buoy[i];

  rotY[i] = Math.random() * Math.PI * 2;
  angY[i] = THREE.MathUtils.randFloatSpread(0.45);

  decay[i] =
    CONFIG.physics.buoyancyDecayRate *
    THREE.MathUtils.randFloat(CONFIG.physics.buoyancyDecayVariance.min, CONFIG.physics.buoyancyDecayVariance.max);

  wAmpX[i] = THREE.MathUtils.randFloat(CONFIG.wobble.ampX.min, CONFIG.wobble.ampX.max);
  wAmpZ[i] = THREE.MathUtils.randFloat(CONFIG.wobble.ampZ.min, CONFIG.wobble.ampZ.max);
  wSpdX[i] = THREE.MathUtils.randFloat(CONFIG.wobble.speedX.min, CONFIG.wobble.speedX.max);
  wSpdZ[i] = THREE.MathUtils.randFloat(CONFIG.wobble.speedZ.min, CONFIG.wobble.speedZ.max);
  wPhX[i] = Math.random() * Math.PI * 2;
  wPhZ[i] = Math.random() * Math.PI * 2;

  const i3 = i * 3;
  randomVibrantTint(iBase, i3);

  // 0/1/2 select different pattern generation branches in the shader.
  const r = Math.random();
  iPatternType[i] = r < 0.72 ? 0 : r < 0.92 ? 1 : 2;

  iSeed[i] = Math.random() * 1000.0;
}

/* -------------------------------------------------------------------------- */
/* GEOMETRY: ENVELOPE (LATHE)                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Envelope is a LatheGeometry built from CONFIG.envelope.profile.
 * We precompute:
 *  - aHeightFactor: normalized height (0 bottom → 1 top)
 *  - aAngleFactor:  normalized around-axis angle (0..1)
 *
 * These attributes let the fragment shader produce procedural patterns without
 * needing UV unwrapping.
 */
function makeEnvelopeGeometry() {
  const pts = CONFIG.envelope.profile.map(([rx, yy]) => new THREE.Vector2(rx, yy));
  const geo = new THREE.LatheGeometry(pts, CONFIG.envelope.radialSegments);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

const baseGeo = makeEnvelopeGeometry();

const bb = baseGeo.boundingBox;
const minY = bb.min.y;
const maxY = bb.max.y;
const hRange = (maxY - minY) || 1;

const posAttr = baseGeo.attributes.position;
const vCount = posAttr.count;

const aHeight = new Float32Array(vCount);
const aAngle = new Float32Array(vCount);

for (let i = 0; i < vCount; i++) {
  const x = posAttr.getX(i);
  const y = posAttr.getY(i);
  const z = posAttr.getZ(i);
  aHeight[i] = (y - minY) / hRange;
  aAngle[i] = (Math.atan2(z, x) + Math.PI) / (Math.PI * 2);
}
baseGeo.setAttribute("aHeightFactor", new THREE.BufferAttribute(aHeight, 1));
baseGeo.setAttribute("aAngleFactor", new THREE.BufferAttribute(aAngle, 1));

/* -------------------------------------------------------------------------- */
/* GONDOLA (BASKET) GEOMETRY                                                   */
/* -------------------------------------------------------------------------- */
/**
 * Basket is a simple BoxGeometry scaled relative to the envelope bounding box.
 * gondolaLocalYOffset is positioned slightly below the envelope base.
 */
const envelopeWidth = (bb.max.x - bb.min.x) || 1;
const envelopeDepth = (bb.max.z - bb.min.z) || 1;
const envelopeHeight = (bb.max.y - bb.min.y) || 1;

const gondolaGeo = new THREE.BoxGeometry(
  envelopeWidth * CONFIG.gondola.widthRatio,
  envelopeHeight * CONFIG.gondola.heightRatio,
  envelopeDepth * CONFIG.gondola.depthRatio
);
const gondolaMat = new THREE.MeshStandardMaterial({
  color: CONFIG.gondola.color,
  metalness: CONFIG.gondola.metalness,
  roughness: CONFIG.gondola.roughness,
});

const gondolaLocalYOffset = minY - (envelopeHeight * CONFIG.gondola.heightRatio) * 0.75;

/* -------------------------------------------------------------------------- */
/* BALLOON MATERIAL + SHADER HOOK                                               */
/* -------------------------------------------------------------------------- */
/**
 * We start with MeshPhysicalMaterial for reflections/clearcoat, then inject
 * pattern + “lit” behavior in onBeforeCompile.
 *
 * Maintenance tips:
 *  - Any new uniforms should be wired both here and in the animate() loop.
 *  - Keep shader edits localized to replace() blocks for easy diffing.
 */
const balloonMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  metalness: 0.0,
  roughness: CONFIG.appearance.roughness,
  clearcoat: CONFIG.appearance.clearcoat,
  clearcoatRoughness: CONFIG.appearance.clearcoatRoughness,
  transparent: false,
  opacity: 1.0,
  side: THREE.FrontSide,
});

let shaderUniforms = null;

balloonMat.onBeforeCompile = (shader) => {
  shader.uniforms.uBrightColor = { value: new THREE.Color(CONFIG.appearance.brightColor) };
  shader.uniforms.uFlameColor = { value: new THREE.Color(CONFIG.appearance.flameColor) };
  shader.uniforms.uFlameMix = { value: CONFIG.appearance.flameMix };

  shader.uniforms.uBaseEm = { value: CONFIG.appearance.baseEmissive };
  shader.uniforms.uBoostEm = { value: CONFIG.appearance.boostEmissive };

  shader.uniforms.uLitMix = { value: CONFIG.appearance.litColorMix };
  shader.uniforms.uLitBoost = { value: CONFIG.appearance.litBrightnessBoost };

  shader.uniforms.uPatDensity = { value: CONFIG.patterns.density };
  shader.uniforms.uPatStrength = { value: CONFIG.patterns.paletteStrength };

  shader.uniforms.uPaperWhiteMix = { value: CONFIG.appearance.paperWhiteMix };

  shaderUniforms = shader.uniforms;

  shader.vertexShader =
    `
attribute float iBuoyancy;
attribute vec3 iBaseTint;
attribute float iPatternType;
attribute float iSeed;

attribute float aHeightFactor;
attribute float aAngleFactor;

varying float vBuoy;
varying vec3 vBase;
varying float vPatType;
varying float vSeed;

varying float vH;
varying float vA;
` + shader.vertexShader;

  shader.vertexShader = shader.vertexShader.replace(
    "#include <begin_vertex>",
    `
#include <begin_vertex>
vBuoy = iBuoyancy;
vBase = iBaseTint;
vPatType = iPatternType;
vSeed = iSeed;
vH = aHeightFactor;
vA = aAngleFactor;
`
  );

  shader.fragmentShader =
    `
uniform vec3 uBrightColor;
uniform vec3 uFlameColor;
uniform float uFlameMix;

uniform float uBaseEm;
uniform float uBoostEm;

uniform float uLitMix;
uniform float uLitBoost;

uniform float uPatDensity;
uniform float uPatStrength;

uniform float uPaperWhiteMix;

varying float vBuoy;
varying vec3 vBase;
varying float vPatType;
varying float vSeed;

varying float vH;
varying float vA;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec3 srgbToLinear(vec3 c) {
  return pow(c, vec3(2.2));
}

vec3 pickRealPaint(float idx){
  vec3 c;
  if (idx < 0.5)  c = vec3(0.843, 0.149, 0.220);
  else if (idx < 1.5)  c = vec3(1.000, 0.435, 0.000);
  else if (idx < 2.5)  c = vec3(0.976, 0.784, 0.055);
  else if (idx < 3.5)  c = vec3(0.180, 0.490, 0.196);
  else if (idx < 4.5)  c = vec3(0.082, 0.396, 0.753);
  else if (idx < 5.5)  c = vec3(0.157, 0.208, 0.576);
  else if (idx < 6.5)  c = vec3(0.416, 0.106, 0.604);
  else if (idx < 7.5)  c = vec3(0.000, 0.514, 0.561);
  else if (idx < 8.5)  c = vec3(0.427, 0.298, 0.255);
  else if (idx < 9.5)  c = vec3(0.149, 0.196, 0.220);
  else if (idx < 10.5) c = vec3(0.92);
  else                 c = vec3(0.08);
  return srgbToLinear(c);
}

vec3 paletteColor(float seed, float slot){
  float r0 = floor(hash11(seed + 11.0) * 12.0);
  float r1 = floor(hash11(seed + 29.0) * 12.0);
  float r2 = floor(hash11(seed + 71.0) * 12.0);

  vec3 c0 = pickRealPaint(r0);
  vec3 c1 = pickRealPaint(r1);
  vec3 c2 = pickRealPaint(r2);

  float grime = (hash11(seed + 101.0) - 0.5) * 0.06;
  c0 = clamp(c0 + grime, 0.0, 1.0);
  c1 = clamp(c1 + grime, 0.0, 1.0);
  c2 = clamp(c2 + grime, 0.0, 1.0);

  if (slot < 0.5) return c0;
  if (slot < 1.5) return c1;
  return c2;
}

vec3 pickPalette(float t, float seed) {
  float slot = (t < 0.333) ? 0.0 : ((t < 0.666) ? 1.0 : 2.0);
  return paletteColor(seed, slot);
}

float patternIndex(float type, float h, float a, float density, float seed) {
  float panels = floor(mix(10.0, 18.0, hash11(seed + 3.1)) * density);
  float ia = floor(a * panels);
  float gore = mod(ia, 3.0) / 2.0;

  if (type < 0.5) {
    return gore;
  } else if (type < 1.5) {
    float band = smoothstep(0.00, 0.22, h) * (1.0 - smoothstep(0.22, 0.30, h));
    float scallop = step(0.5, fract(ia * 0.35 + h * 8.0));
    float alt = mix(gore, 0.0, scallop);
    return mix(gore, alt, band);
  } else {
    float zig = floor((h * 7.0 - a * 7.0) * density);
    return mod(zig, 3.0) / 2.0;
  }
}
` + shader.fragmentShader;

  shader.fragmentShader = shader.fragmentShader.replace(
    "vec4 diffuseColor = vec4( diffuse, opacity );",
    `
float b = clamp(vBuoy, 0.0, 1.0);

float t = patternIndex(vPatType, vH, vA, uPatDensity, vSeed);
vec3 basePat = pickPalette(t, vSeed);

// subtle “paper” whitening to reduce overly digital saturation
basePat = mix(basePat, vec3(1.0), uPaperWhiteMix);

// belly shading: slightly brighten the midsection
float belly = smoothstep(0.10, 0.65, vH) * (1.0 - smoothstep(0.65, 0.92, vH));
basePat *= (0.92 + 0.14 * belly);

// heat gradient: strongest near bottom when buoyant (b)
float grad = b * (1.0 - vH);
basePat = mix(basePat, uFlameColor, uFlameMix * grad);
basePat *= (1.0 + 0.25 * uLitBoost * grad);
basePat = min(basePat, vec3(1.0));
basePat = mix(basePat, uBrightColor, uLitMix * b);

vec4 diffuseColor = vec4(basePat, 1.0);
`
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <emissivemap_fragment>",
    `
#include <emissivemap_fragment>
// Emissive intentionally disabled (keeps daylight feel and avoids blowout).
totalEmissiveRadiance = vec3(0.0) * (uBaseEm + uBoostEm * clamp(vBuoy, 0.0, 1.0));
`
  );
};

/* -------------------------------------------------------------------------- */
/* INSTANCED MESHES                                                            */
/* -------------------------------------------------------------------------- */
/**
 * Two instanced meshes:
 *  - balloons: envelope geometry + custom physical shader
 *  - gondolas: box geometry + standard material
 *
 * Each frame we update instance matrices for both meshes.
 */
const balloons = new THREE.InstancedMesh(baseGeo, balloonMat, N);
balloons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(balloons);

const gondolas = new THREE.InstancedMesh(gondolaGeo, gondolaMat, N);
gondolas.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(gondolas);

/**
 * Instanced attributes are attached to balloons.geometry and used in the shader.
 * If you add attributes, remember:
 *  - allocate typed array
 *  - create InstancedBufferAttribute
 *  - setAttribute()
 *  - mark needsUpdate where appropriate
 */
const instBuoyAttr = new THREE.InstancedBufferAttribute(iBuoy, 1);
const instBaseAttr = new THREE.InstancedBufferAttribute(iBase, 3);
const instPatAttr = new THREE.InstancedBufferAttribute(iPatternType, 1);
const instSeedAttr = new THREE.InstancedBufferAttribute(iSeed, 1);

balloons.geometry.setAttribute("iBuoyancy", instBuoyAttr);
balloons.geometry.setAttribute("iBaseTint", instBaseAttr);
balloons.geometry.setAttribute("iPatternType", instPatAttr);
balloons.geometry.setAttribute("iSeed", instSeedAttr);

/**
 * writeMatrices composes transform matrices for envelope + gondola for instance i.
 * This is the hot path for “render update”; keep it allocation-free.
 */
function writeMatrices(i) {
  tmpPos.set(posX[i], posY[i], posZ[i]);
  tmpQuat.setFromAxisAngle(yAxis, rotY[i]);
  tmpMat.compose(tmpPos, tmpQuat, tmpScale);
  balloons.setMatrixAt(i, tmpMat);

  const yOff = gondolaLocalYOffset * CONFIG.balloons.scale;
  tmpPos.set(posX[i], posY[i] + yOff, posZ[i]);

  const gS = CONFIG.balloons.scale * 0.95;
  tmpScaleG.set(gS, gS, gS);

  tmpMatG.compose(tmpPos, tmpQuat, tmpScaleG);
  gondolas.setMatrixAt(i, tmpMatG);
}

// Initial fill
for (let i = 0; i < N; i++) {
  resetInstance(i, true);
  writeMatrices(i);
}
balloons.instanceMatrix.needsUpdate = true;
gondolas.instanceMatrix.needsUpdate = true;

instBuoyAttr.needsUpdate = true;
instBaseAttr.needsUpdate = true;
instPatAttr.needsUpdate = true;
instSeedAttr.needsUpdate = true;

/* -------------------------------------------------------------------------- */
/* INTERACTION MODEL (ORBS)                                                    */
/* -------------------------------------------------------------------------- */
/**
 * Orbs are “influence points” used to determine whether a balloon is hovered.
 * They are sourced from:
 *  - mouse intersection (slot 0)
 *  - pose wrists (slots 1..)
 *  - hand fingertips (slots after wrists)
 *
 * Orb state uses:
 *  - orbTargets: new measurements
 *  - orbPositions: smoothed positions used for influence + sprite visuals
 *  - orbTTL: time-to-live to discard stale tracking points
 */
const FINGERTIPS_PER_HAND = 5;
const MAX_ORBS =
  1 + // mouse
  (CONFIG.interaction.maxPeople * 2) + // wrists
  (CONFIG.interaction.maxHands * FINGERTIPS_PER_HAND); // fingertips

const orbPositions = Array.from({ length: MAX_ORBS }, () => new THREE.Vector3());
const orbTargets = Array.from({ length: MAX_ORBS }, () => new THREE.Vector3());
const orbBuoy = new Float32Array(MAX_ORBS);
const orbTTL = new Float32Array(MAX_ORBS);

const WRIST_SLOTS_START = 1;
const WRIST_SLOTS_COUNT = CONFIG.interaction.maxPeople * 2;
const FINGER_SLOTS_START = WRIST_SLOTS_START + WRIST_SLOTS_COUNT;

// Helpers for projecting between spaces
const planeNormal = new THREE.Vector3();
const planePoint = new THREE.Vector3();
const tmpPlane = new THREE.Plane();
const tmpRay = new THREE.Ray();
const rayOrigin = new THREE.Vector3();
const rayDir = new THREE.Vector3();
const ndcVec = new THREE.Vector3();

const tmpNdcB = new THREE.Vector3();
const tmpNdcO = new THREE.Vector3();
const tmpBalloonW = new THREE.Vector3();

function worldToNDC(v, out) {
  out.copy(v).project(camera);
  return out;
}

/**
 * Maps NDC (screen-space -1..1) onto the plane that passes through viewCenter
 * and faces the camera. This makes tracking points feel “stuck” to the scene,
 * even though they come from 2D image coordinates.
 */
function ndcToWorldOnViewPlane(ndcX, ndcY, out) {
  camera.getWorldDirection(planeNormal);
  planePoint.copy(viewCenter);
  tmpPlane.setFromNormalAndCoplanarPoint(planeNormal, planePoint);

  rayOrigin.copy(camera.position);
  ndcVec.set(ndcX, ndcY, 0.5).unproject(camera);
  rayDir.copy(ndcVec).sub(rayOrigin).normalize();
  tmpRay.set(rayOrigin, rayDir);

  const hit = tmpRay.intersectPlane(tmpPlane, out);
  if (!hit) out.copy(ndcVec);
}

function setOrb(slot, worldPos, strength = 1.0) {
  if (slot < 0 || slot >= MAX_ORBS) return;
  orbTargets[slot].copy(worldPos);

  // First write initializes smoothed position to avoid lerping from (0,0,0)
  if (orbPositions[slot].lengthSq() < 1e-6) orbPositions[slot].copy(worldPos);

  orbBuoy[slot] = strength;
  orbTTL[slot] = Math.max(0.01, CONFIG.interaction.orbMaxTTL);
}

function smoothOrbs(alpha) {
  for (let i = 0; i < MAX_ORBS; i++) {
    if (orbTTL[i] > 0) orbPositions[i].lerp(orbTargets[i], alpha);
  }
}

/* -------------------------------------------------------------------------- */
/* ORB SPRITES (VISUALIZATION ONLY)                                            */
/* -------------------------------------------------------------------------- */
/**
 * Sprites visualize interaction points. They do NOT affect hover logic except
 * that both use the same orbPositions arrays.
 *
 * If you want debug-only visibility, gate this behind a debug flag.
 */
function makeRadialGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, "rgba(255,140,40,1)");
  g.addColorStop(0.12, "rgba(255,120,25,0.98)");
  g.addColorStop(0.35, "rgba(255,110,20,0.65)");
  g.addColorStop(1.0, "rgba(255,90,15,0.0)");

  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const orbTex = makeRadialGlowTexture();
const orbSprites = [];
for (let i = 0; i < MAX_ORBS; i++) {
  const sm = new THREE.SpriteMaterial({
    map: orbTex,
    color: new THREE.Color(CONFIG.interaction.orbColor),
    transparent: true,
    opacity: CONFIG.interaction.orbOpacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const s = new THREE.Sprite(sm);
  s.visible = false;
  s.scale.setScalar(CONFIG.interaction.orbSize);
  s.renderOrder = 999;
  scene.add(s);
  orbSprites.push(s);
}

function updateOrbSprites() {
  const mode = CONFIG.interaction.trackMode;
  const visible = !!CONFIG.interaction.orbsVisible && mode !== "fullBody";

  if (!visible) {
    for (let i = 0; i < orbSprites.length; i++) orbSprites[i].visible = false;
    return;
  }

  const baseSize = CONFIG.interaction.orbSize;
  const extra = CONFIG.interaction.orbSizeLitBoost;
  const maxT = Math.max(0.01, CONFIG.interaction.orbMaxTTL);

  for (let i = 0; i < orbSprites.length; i++) {
    const s = orbSprites[i];
    const alive = orbTTL[i] > 0;

    if (alive) {
      const life01 = Math.min(1, orbTTL[i] / maxT);
      const b = THREE.MathUtils.clamp(orbBuoy[i], 0, 1);
      s.position.copy(orbPositions[i]);
      s.scale.setScalar(baseSize + extra * b);
      s.material.opacity = CONFIG.interaction.orbOpacity * life01;
      s.visible = true;
    } else {
      s.visible = false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* MOUSE INPUT (RAYCAST)                                                       */
/* -------------------------------------------------------------------------- */
/**
 * Mouse produces a single interaction point by raycasting the instanced mesh.
 * This is independent of pose/hand tracking and remains active even if camera
 * tracking is disabled.
 */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(999, 999);

window.addEventListener("pointermove", (e) => {
  if (!CONFIG.interaction.mouseEnabled) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
});
window.addEventListener("pointerleave", () => pointer.set(999, 999));

function updateMouseOrb() {
  if (!CONFIG.interaction.mouseEnabled) return;
  if (Math.abs(pointer.x) > 2 || Math.abs(pointer.y) > 2) return;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(balloons, false);
  if (!hits || !hits.length) return;

  setOrb(0, hits[0].point, 1.0);
}

/* -------------------------------------------------------------------------- */
/* MEDIAPIPE: POSE + HANDS                                                     */
/* -------------------------------------------------------------------------- */
/**
 * Tracking is initialized lazily after camera permissions are granted.
 * We share the same Vision task resolver for Pose and Hands.
 *
 * last*VideoTime guards against reprocessing the same video frame multiple times.
 */
let poseLandmarker = null;
let poseReady = false;
let lastPoseVideoTime = -1;

let handLandmarker = null;
let handsReady = false;
let lastHandsVideoTime = -1;

// Used in fullBody mode (screen-space “hover zones”)
const poseBoxesNDC = [];

async function initHandLandmarker(vision) {
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: CONFIG.hands.modelAssetPath, delegate: CONFIG.hands.delegate },
    runningMode: "VIDEO",
    numHands: CONFIG.interaction.maxHands,
    minHandDetectionConfidence: CONFIG.hands.minHandDetectionConfidence,
    minHandPresenceConfidence: CONFIG.hands.minHandPresenceConfidence,
    minTrackingConfidence: CONFIG.hands.minTrackingConfidence,
  });
  handsReady = true;
}

async function initPoseLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(CONFIG.pose.wasmRoot);

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: CONFIG.pose.modelAssetPath, delegate: CONFIG.pose.delegate },
    runningMode: "VIDEO",
    numPoses: CONFIG.interaction.maxPeople,
    minPoseDetectionConfidence: CONFIG.pose.minPoseDetectionConfidence,
    minPosePresenceConfidence: CONFIG.pose.minPosePresenceConfidence,
    minTrackingConfidence: CONFIG.pose.minTrackingConfidence,
  });
  poseReady = true;

  await initHandLandmarker(vision);
}

/**
 * Enables the camera, starts video playback, then initializes trackers once.
 * UI is minimal: button text updates, then fades out when active.
 */
async function enableCamera() {
  $btn.disabled = true;
  $btn.textContent = "Starting…";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    $video.srcObject = stream;
    await $video.play();

    if (!poseLandmarker) await initPoseLandmarker();

    $btn.textContent = "Camera Enabled";
    $btn.style.opacity = "0";
    $btn.style.pointerEvents = "none";
  } catch (err) {
    console.warn(err);
    $btn.disabled = false;
    $btn.textContent = "Enable Camera";
    alert("Could not start camera / pose tracking (check permissions).");
  }
}
$btn.addEventListener("click", enableCamera);

/* -------------------------------------------------------------------------- */
/* TRACKING → ORB POINTS / FULLBODY BOXES                                      */
/* -------------------------------------------------------------------------- */
/**
 * Wrists mode:
 *  - Uses pose wrists
 *  - Writes into stable orb slots (1 + p*2, 1 + p*2 + 1)
 */
function addPoseWristOrbPoints(nowMs) {
  if (CONFIG.interaction.trackMode !== "wrists") return;
  if (!CONFIG.interaction.poseEnabled) return;
  if (!poseReady) return;
  if (!$video.videoWidth) return;
  if ($video.currentTime === lastPoseVideoTime) return;
  lastPoseVideoTime = $video.currentTime;

  const res = poseLandmarker.detectForVideo($video, nowMs);
  const poses = res?.landmarks || [];

  for (let p = 0; p < poses.length; p++) {
    const lm = poses[p];
    const lw = lm[CONFIG.pose.leftWristIndex];
    const rw = lm[CONFIG.pose.rightWristIndex];

    if (lw) {
      const nx = CONFIG.interaction.mirror ? 1 - lw.x : lw.x;
      ndcToWorldOnViewPlane(nx * 2 - 1, -(lw.y * 2 - 1), tmpPos);
      setOrb(1 + p * 2, tmpPos, 1.0);
    }

    if (rw) {
      const nx = CONFIG.interaction.mirror ? 1 - rw.x : rw.x;
      ndcToWorldOnViewPlane(nx * 2 - 1, -(rw.y * 2 - 1), tmpPos);
      setOrb(1 + p * 2 + 1, tmpPos, 1.0);
    }
  }
}

/**
 * Fingers mode:
 *  - Uses hand fingertip landmarks (5 per hand)
 *  - Writes sequentially into the packed slots after wrists
 */
const HAND_TIPS = [4, 8, 12, 16, 20];

function addFingerOrbPoints(nowMs) {
  if (CONFIG.interaction.trackMode !== "fingers") return;
  if (!handsReady) return;
  if (!$video.videoWidth) return;
  if ($video.currentTime === lastHandsVideoTime) return;
  lastHandsVideoTime = $video.currentTime;

  const res = handLandmarker.detectForVideo($video, nowMs);
  const hands = res?.landmarks || [];

  let slot = FINGER_SLOTS_START;

  for (let h = 0; h < hands.length; h++) {
    const lm = hands[h];
    for (let t = 0; t < HAND_TIPS.length; t++) {
      if (slot >= MAX_ORBS) return;

      const tip = lm[HAND_TIPS[t]];
      if (!tip) { slot++; continue; }

      const nx = CONFIG.interaction.mirror ? 1 - tip.x : tip.x;
      ndcToWorldOnViewPlane(nx * 2 - 1, -(tip.y * 2 - 1), tmpPos);
      setOrb(slot, tmpPos, 1.0);
      slot++;
    }
  }
}

/**
 * FullBody mode:
 *  - No orbs (purely zone-based)
 *  - Builds per-person bounding boxes in NDC from all pose landmarks
 *  - Used later to determine “hover” by checking if balloon projects inside a box
 */
function updateFullBodyBoxes(nowMs) {
  poseBoxesNDC.length = 0;

  if (CONFIG.interaction.trackMode !== "fullBody") return;
  if (!CONFIG.interaction.poseEnabled) return;
  if (!poseReady) return;
  if (!$video.videoWidth) return;
  if ($video.currentTime === lastPoseVideoTime) return;
  lastPoseVideoTime = $video.currentTime;

  const res = poseLandmarker.detectForVideo($video, nowMs);
  const poses = res?.landmarks || [];

  for (let p = 0; p < poses.length; p++) {
    const lm = poses[p];
    let minX = 999, maxX = -999, minY = 999, maxY = -999;

    for (let i = 0; i < lm.length; i++) {
      const pt = lm[i];
      if (!pt) continue;

      const x = (CONFIG.interaction.mirror ? 1 - pt.x : pt.x) * 2 - 1;
      const y = -((pt.y * 2) - 1);

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    if (minX < 998) {
      const padX = 0.06;
      const padY = 0.08;
      poseBoxesNDC.push({
        minX: minX - padX,
        maxX: maxX + padX,
        minY: minY - padY,
        maxY: maxY + padY,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* BUOYANCY APPLICATION                                                        */
/* -------------------------------------------------------------------------- */
/**
 * applyOrbInfluence computes hovered state per balloon and updates buoyancy:
 *  - hovered: buoyancy rises quickly
 *  - not hovered: buoyancy decays per balloon via decay[i]
 *
 * Hover detection options:
 *  - fullBody: balloon NDC inside any pose bounding box
 *  - screen-space: compare balloon NDC against each active orb NDC (recommended)
 *  - world-space: compare 3D distance (legacy)
 */
function applyOrbInfluence(dt) {
  const { buoyancyRiseRate } = CONFIG.physics;
  const { randomLight } = CONFIG;
  const mode = CONFIG.interaction.trackMode;

  const useScreen = !!CONFIG.interaction.useScreenSpaceHit;

  const rW = CONFIG.interaction.hoverRadiusWorld;
  const rWSq = rW * rW;

  const rN = THREE.MathUtils.clamp(
    CONFIG.interaction.screenRadiusNDC ?? 0.065,
    CONFIG.interaction.screenRadiusMin ?? 0.03,
    CONFIG.interaction.screenRadiusMax ?? 0.10
  );
  const rNSq = rN * rN;

  for (let i = 0; i < N; i++) {
    let b = buoy[i];
    let hovered = false;

    if (mode === "fullBody") {
      if (poseBoxesNDC.length) {
        tmpBalloonW.set(posX[i], posY[i], posZ[i]);
        worldToNDC(tmpBalloonW, tmpNdcB);

        const balloonClipOK = tmpNdcB.z >= -1 && tmpNdcB.z <= 1;
        if (balloonClipOK) {
          for (let bi = 0; bi < poseBoxesNDC.length; bi++) {
            const bb2 = poseBoxesNDC[bi];
            if (
              tmpNdcB.x >= bb2.minX && tmpNdcB.x <= bb2.maxX &&
              tmpNdcB.y >= bb2.minY && tmpNdcB.y <= bb2.maxY
            ) {
              hovered = true;
              break;
            }
          }
        }
      }
    } else if (useScreen) {
      tmpBalloonW.set(posX[i], posY[i], posZ[i]);
      worldToNDC(tmpBalloonW, tmpNdcB);

      const balloonClipOK = tmpNdcB.z >= -1 && tmpNdcB.z <= 1;
      if (balloonClipOK) {
        for (let j = 0; j < MAX_ORBS; j++) {
          if (orbTTL[j] <= 0) continue;

          worldToNDC(orbPositions[j], tmpNdcO);
          if (tmpNdcO.z < -1 || tmpNdcO.z > 1) continue;

          const dx = tmpNdcB.x - tmpNdcO.x;
          const dy = tmpNdcB.y - tmpNdcO.y;

          if (dx * dx + dy * dy < rNSq) {
            hovered = true;
            break;
          }
        }
      }
    } else {
      const bx = posX[i], by = posY[i], bz = posZ[i];
      for (let j = 0; j < MAX_ORBS; j++) {
        if (orbTTL[j] <= 0) continue;
        const op = orbPositions[j];
        const dx = bx - op.x;
        const dy = by - op.y;
        const dz = bz - op.z;
        if (dx * dx + dy * dy + dz * dz < rWSq) {
          hovered = true;
          break;
        }
      }
    }

    if (hovered) b += buoyancyRiseRate * dt;
    else if (b > 0) b -= decay[i] * dt;

    if (!hovered && b <= 0.01 && posY[i] < bounds.yMax * randomLight.thresholdY) {
      if (Math.random() < randomLight.rate * dt) b = 1.0;
    }

    b = THREE.MathUtils.clamp(b, 0, 1);
    buoy[i] = b;
    iBuoy[i] = b;
  }

  balloons.geometry.getAttribute("iBuoyancy").needsUpdate = true;
}

/* -------------------------------------------------------------------------- */
/* PHYSICS INTEGRATION                                                         */
/* -------------------------------------------------------------------------- */
/**
 * updatePhysics integrates velocities and positions:
 *  - lift increases with buoyancy
 *  - wobble adds lateral motion
 *  - drag stabilizes
 *
 * Respawn rule:
 *  - If balloon leaves the simulation volume (y/x), reset it above view.
 *  - Z is clamped with a bounce-like response for gentle depth confinement.
 */
function updatePhysics(dt, t) {
  const { physics } = CONFIG;

  for (let i = 0; i < N; i++) {
    const b = buoy[i];

    velY[i] += (physics.gravity + physics.liftStrength * b) * dt;
    velX[i] += Math.sin(t * wSpdX[i] + wPhX[i]) * wAmpX[i] * dt;
    velZ[i] += Math.cos(t * wSpdZ[i] + wPhZ[i]) * wAmpZ[i] * dt;

    velX[i] *= physics.horizontalDrag;
    velY[i] *= physics.verticalDrag;
    velZ[i] *= physics.horizontalDrag;

    velY[i] = THREE.MathUtils.clamp(velY[i], -physics.maxVerticalSpeed, physics.maxVerticalSpeed);

    posX[i] += velX[i] * dt;
    posY[i] += velY[i] * dt;
    posZ[i] += velZ[i] * dt;

    rotY[i] += angY[i] * dt;

    if (
      posY[i] < bounds.yOffBottom ||
      posY[i] > bounds.ySpawnTop ||
      posX[i] < -bounds.xOff ||
      posX[i] > bounds.xOff
    ) {
      resetInstance(i, false);
    }

    if (posZ[i] < bounds.zMin) {
      posZ[i] = bounds.zMin;
      velZ[i] = Math.abs(velZ[i]) * 0.6;
    } else if (posZ[i] > bounds.zMax) {
      posZ[i] = bounds.zMax;
      velZ[i] = -Math.abs(velZ[i]) * 0.6;
    }

    writeMatrices(i);
  }

  balloons.instanceMatrix.needsUpdate = true;
  gondolas.instanceMatrix.needsUpdate = true;
}

/* -------------------------------------------------------------------------- */
/* MAIN LOOP                                                                   */
/* -------------------------------------------------------------------------- */
/**
 * Frame order matters:
 *  1) Update shader uniforms from CONFIG (runtime tuning).
 *  2) Decay orb TTL (removes stale tracking points).
 *  3) Update tracking inputs based on trackMode.
 *  4) Update mouse orb (independent).
 *  5) Smooth orbs + update orb sprites.
 *  6) Apply interaction influence to buoyancy.
 *  7) Integrate physics + update instance matrices.
 *  8) Render.
 */
let lastTime = performance.now();

function animate(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05) || 0.016;
  lastTime = now;
  const t = now * 0.001;

  if (shaderUniforms) {
    shaderUniforms.uBaseEm.value = CONFIG.appearance.baseEmissive;
    shaderUniforms.uBoostEm.value = CONFIG.appearance.boostEmissive;
    shaderUniforms.uLitMix.value = CONFIG.appearance.litColorMix;
    shaderUniforms.uLitBoost.value = CONFIG.appearance.litBrightnessBoost;
    shaderUniforms.uPatDensity.value = CONFIG.patterns.density;
    shaderUniforms.uPatStrength.value = CONFIG.patterns.paletteStrength;
    shaderUniforms.uPaperWhiteMix.value = CONFIG.appearance.paperWhiteMix;

    shaderUniforms.uFlameColor.value.setHex(CONFIG.appearance.flameColor);
    shaderUniforms.uFlameMix.value = CONFIG.appearance.flameMix;
  }

  for (let i = 0; i < MAX_ORBS; i++) orbTTL[i] = Math.max(0, orbTTL[i] - dt);

  const mode = CONFIG.interaction.trackMode;
  if (mode === "wrists") addPoseWristOrbPoints(now);
  else if (mode === "fingers") addFingerOrbPoints(now);
  else if (mode === "fullBody") updateFullBodyBoxes(now);

  updateMouseOrb();

  const alpha = 1.0 - Math.pow(1.0 - CONFIG.interaction.orbSmoothing, Math.max(1, dt * 60));
  smoothOrbs(alpha);
  updateOrbSprites();

  applyOrbInfluence(dt);
  updatePhysics(dt, t);

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

/* -------------------------------------------------------------------------- */
/* RESIZE                                                                      */
/* -------------------------------------------------------------------------- */
/**
 * Resizing must update:
 *  - camera aspect + projection
 *  - renderer size
 *  - bounds derived from the new frustum
 */
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateVisibleBounds();
});

/* -------------------------------------------------------------------------- */
/* RUNTIME TUNING API (window.SIM)                                             */
/* -------------------------------------------------------------------------- */
/**
 * Small debugging/tuning surface area without adding UI.
 * Keep this stable if other code/scripts rely on it.
 */
window.SIM = {
  setHandEffectRadius(v) {
    CONFIG.interaction.hoverRadiusWorld = Math.max(0.1, v);
  },
  setScreenRadiusNDC(v) {
    CONFIG.interaction.screenRadiusNDC = THREE.MathUtils.clamp(v, 0.01, 0.25);
  },
  useScreenSpaceHit(v) {
    CONFIG.interaction.useScreenSpaceHit = !!v;
  },
  setBalloonScale(v) {
    CONFIG.balloons.scale = Math.max(0.01, v);
    tmpScale.setScalar(CONFIG.balloons.scale);
  },
  setBalloonCountNote() {
    console.warn("Balloon count is fixed at init. Change CONFIG.balloons.count and reload.");
  },

  setTrackMode(mode) {
    const m = String(mode || "wrists");
    CONFIG.interaction.trackMode = m;

    // Defaults by mode; fullBody forces no orbs.
    if (m === "fullBody") CONFIG.interaction.orbsVisible = false;
    if (m === "wrists") CONFIG.interaction.orbsVisible = true;
    if (m === "fingers") CONFIG.interaction.orbsVisible = true;

    console.log("trackMode =", CONFIG.interaction.trackMode, "orbsVisible =", CONFIG.interaction.orbsVisible);
  },
  showOrbs(v) {
    CONFIG.interaction.orbsVisible = !!v;
  },

  setOverlayOpacity(v) {
    CONFIG.cameraOverlay.opacity = THREE.MathUtils.clamp(Number(v) || 0, 0, 1);
    applyCameraOverlayStyles();
  },
  useOverlayGradient() {
    CONFIG.cameraOverlay.enabled = true;
    CONFIG.cameraOverlay.mode = "gradient";
    applyCameraOverlayStyles();
  },
  setOverlayImage(url) {
    CONFIG.cameraOverlay.enabled = true;
    CONFIG.cameraOverlay.mode = "image";
    CONFIG.cameraOverlay.imageUrl = String(url || "");
    applyCameraOverlayStyles();
  },
  setOverlayBlendMode(mode) {
    CONFIG.cameraOverlay.blendMode = String(mode || "overlay");
    applyCameraOverlayStyles();
  },
  enableOverlay(v) {
    CONFIG.cameraOverlay.enabled = !!v;
    applyCameraOverlayStyles();
  },
};
