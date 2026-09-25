"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ForceGraph3DInstance, LinkObject, NodeObject } from "3d-force-graph";
import type { DepthTexture, Object3D } from "three";
import type { CategoryRecord, MenuRecord, TasteGravityEasterEgg } from "../types";

type MenuCosmosProps = {
  menus: MenuRecord[];
  easterEggs: TasteGravityEasterEgg[];
  taxonomy: CategoryRecord[];
  selectedId: string | null;
  paused: boolean;
  onSelect: (menu: MenuRecord) => void;
  onSelectEasterEgg: (item: TasteGravityEasterEgg) => void;
};

type GraphNode = NodeObject & {
  id: string;
  kind: "category" | "menu" | "anomaly";
  category: string;
  color: string;
  name: string;
  menu?: MenuRecord;
  easterEgg?: TasteGravityEasterEgg;
  size: number;
};

type GraphLink = LinkObject<GraphNode> & {
  kind: "category";
  count: number;
  distance: number;
};

type OrbitControlsLike = {
  autoRotate?: boolean;
  autoRotateSpeed?: number;
};

type LensingPassLike = {
  enabled: boolean;
  uniforms: {
    lensCenter: { value: { set: (x: number, y: number) => void } };
    lensRadius: { value: number };
    lensStrength: { value: number };
    aspect: { value: number };
    shadowRadius: { value: number };
    pixelsPerShadow: { value: number };
    diskTime: { value: number };
    selectionMix: { value: number };
    fogMix: { value: number };
    holeDepth: { value: number };
    depthMargin: { value: number };
    cameraNear: { value: number };
    cameraFar: { value: number };
    tDepth: { value: DepthTexture | null };
    depthReady: { value: number };
  };
  render: (
    renderer: unknown,
    writeBuffer: unknown,
    readBuffer: { depthTexture: DepthTexture | null },
    deltaTime?: number,
    maskActive?: boolean,
  ) => void;
  dispose?: () => void;
};

// Gargantua is seen from slightly above its disk, with a small roll, and is
// always turned toward the camera. The lensing shader and the invisible click
// proxies share these angles so what is drawn and what is clickable agree.
const GARGANTUA_INCLINATION = 0.16;
const GARGANTUA_ROLL = -0.1;
const FOG_DENSITY = 0.00072;

function seededValue(value: string, salt: number) {
  let hash = 2166136261 ^ salt;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}

function latticeHash(x: number, y: number, z: number) {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  hash = Math.imul(hash ^ (hash >>> 13), 1103515245);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
}

function latticeNoise(x: number, y: number, z: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;
  const plane = (offsetZ: number) => lerp(
    lerp(latticeHash(ix, iy, iz + offsetZ), latticeHash(ix + 1, iy, iz + offsetZ), ux),
    lerp(latticeHash(ix, iy + 1, iz + offsetZ), latticeHash(ix + 1, iy + 1, iz + offsetZ), ux),
    uy,
  );
  return lerp(plane(0), plane(1), uz);
}

function skyNoise(x: number, y: number, z: number, octaves = 4) {
  let sum = 0;
  let total = 0;
  let amplitude = 0.5;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += amplitude * latticeNoise(x, y, z);
    total += amplitude;
    x = x * 2.03 + 5.1;
    y = y * 2.03 + 1.3;
    z = z * 2.03 + 7.7;
    amplitude *= 0.5;
  }
  return sum / total;
}

// Paints a faint equirectangular nebula with a dusty galactic band. Noise is
// sampled on the unit sphere, so the texture wraps without a seam.
function paintNebula(context: CanvasRenderingContext2D, width: number, height: number) {
  const image = context.createImageData(width, height);
  const violet = [62, 44, 138];
  const teal = [20, 92, 118];
  const magenta = [110, 32, 98];
  for (let row = 0; row < height; row += 1) {
    const latitude = (0.5 - row / (height - 1)) * Math.PI;
    const y = Math.sin(latitude);
    const ring = Math.cos(latitude);
    const band = Math.exp(-((y / 0.3) ** 2));
    for (let column = 0; column < width; column += 1) {
      const longitude = (column / width) * Math.PI * 2;
      const x = ring * Math.cos(longitude);
      const z = ring * Math.sin(longitude);
      const cloud = Math.max(0, skyNoise(x * 2.1 + 3, y * 2.1, z * 2.1 - 4) - 0.38) / 0.62;
      const hue = skyNoise(x * 1.3 - 7, y * 1.3 + 2, z * 1.3 + 5, 3);
      const rift = Math.max(0, skyNoise(x * 6 + 1, y * 6 - 3, z * 6 + 2, 3) - 0.45) / 0.55;
      const glow = cloud ** 1.6 * (0.28 + 0.9 * band) * (1 - 0.6 * band * rift);
      const toTeal = Math.min(1, Math.max(0, (hue - 0.38) / 0.24));
      const toMagenta = Math.min(1, Math.max(0, (0.42 - hue) / 0.2));
      const index = (row * width + column) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const base = violet[channel] + (teal[channel] - violet[channel]) * toTeal;
        image.data[index + channel] = (base + (magenta[channel] - base) * toMagenta) * glow;
      }
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

// The cosmos is rebuilt whenever the filters change, so paint the nebula once
// per page and let every rebuild reuse it.
let nebulaCanvasCache: HTMLCanvasElement | null = null;
function nebulaCanvas() {
  if (!nebulaCanvasCache) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) return null;
    paintNebula(context, canvas.width, canvas.height);
    nebulaCanvasCache = canvas;
  }
  return nebulaCanvasCache;
}

function categoryPosition(index: number, total: number) {
  const normalized = total <= 1 ? 0 : index / (total - 1);
  const vertical = 1 - normalized * 2;
  const planar = Math.sqrt(Math.max(0, 1 - vertical * vertical));
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  const radius = 235;
  return {
    x: Math.cos(angle) * planar * radius,
    y: vertical * radius,
    z: Math.sin(angle) * planar * radius,
  };
}

type MutableGraphNode = GraphNode & { vx?: number; vy?: number; vz?: number };
type CollisionForce = ((alpha: number) => void) & { initialize: (nodes: MutableGraphNode[]) => void };

function createCollisionForce(padding = 5): CollisionForce {
  let nodes: MutableGraphNode[] = [];
  const force = ((alpha: number) => {
    const strength = Math.min(0.28, 0.09 + alpha * 0.2);
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const right = nodes[rightIndex];
        let dx = Number(right.x ?? 0) - Number(left.x ?? 0);
        let dy = Number(right.y ?? 0) - Number(left.y ?? 0);
        let dz = Number(right.z ?? 0) - Number(left.z ?? 0);
        let distance = Math.hypot(dx, dy, dz);
        const minimum = left.size + right.size + padding;
        if (distance >= minimum) continue;
        if (distance < 0.001) {
          dx = seededValue(`${left.id}:${right.id}`, 71) - 0.5;
          dy = seededValue(`${left.id}:${right.id}`, 73) - 0.5;
          dz = seededValue(`${left.id}:${right.id}`, 79) - 0.5;
          distance = Math.hypot(dx, dy, dz) || 1;
        }
        const impulse = ((minimum - distance) / distance) * strength;
        const ix = dx * impulse;
        const iy = dy * impulse;
        const iz = dz * impulse;
        if (left.fx == null) left.vx = Number(left.vx ?? 0) - ix;
        if (left.fy == null) left.vy = Number(left.vy ?? 0) - iy;
        if (left.fz == null) left.vz = Number(left.vz ?? 0) - iz;
        if (right.fx == null) right.vx = Number(right.vx ?? 0) + ix;
        if (right.fy == null) right.vy = Number(right.vy ?? 0) + iy;
        if (right.fz == null) right.vz = Number(right.vz ?? 0) + iz;
      }
    }
  }) as CollisionForce;
  force.initialize = (nextNodes) => { nodes = nextNodes; };
  return force;
}

function disposeObject(root: Object3D) {
  root.traverse((child) => {
    type DisposableMaterial = { dispose?: () => void; map?: { dispose?: () => void } };
    const disposable = child as Object3D & {
      geometry?: { dispose?: () => void };
      material?: DisposableMaterial | DisposableMaterial[];
    };
    disposable.geometry?.dispose?.();
    const materials = Array.isArray(disposable.material) ? disposable.material : [disposable.material];
    for (const material of materials) {
      material?.map?.dispose?.();
      material?.dispose?.();
    }
  });
}

function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function focusGraphNode(
  graph: ForceGraph3DInstance<GraphNode, GraphLink>,
  node: GraphNode,
  distance: number,
  duration: number,
) {
  const x = Number(node.x ?? node.fx ?? 0);
  const y = Number(node.y ?? node.fy ?? 0);
  const z = Number(node.z ?? node.fz ?? 0);
  const length = Math.hypot(x, y, z) || 1;
  const ratio = 1 + distance / length;
  graph.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, duration);
}

function cameraDistanceForViewport(width: number, height: number) {
  // Fit the category sphere in both axes, including the toolbar safe area.
  // Width-only breakpoints cropped the poles in short desktop viewports.
  const safeWidth = Math.max(1, width - 60);
  const safeHeight = Math.max(1, height - 110);
  const halfFov = Math.atan(Math.tan(Math.PI / 7.2) * Math.min(safeWidth, safeHeight) / Math.max(1, height));
  return Math.max(800, Math.min(2400, 335 / Math.sin(halfFov)));
}

function categoryLabelHeight(width: number) {
  if (width <= 480) return 24;
  if (width <= 760) return 22;
  return 14;
}

function focusDistanceForViewport(kind: GraphNode["kind"], width: number) {
  // Frame the whole ray-traced disk, not only the shadow.
  if (kind === "anomaly") return width <= 480 ? 320 : width <= 760 ? 275 : width <= 1100 ? 255 : 240;
  return width <= 480 ? 150 : width <= 760 ? 125 : 96;
}

export function MenuCosmos({
  menus,
  easterEggs,
  taxonomy,
  selectedId,
  paused,
  onSelect,
  onSelectEasterEgg,
}: MenuCosmosProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance<GraphNode, GraphLink> | null>(null);
  const selectedIdRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  const onSelectEasterEggRef = useRef(onSelectEasterEgg);
  const pausedRef = useRef(paused);
  const objectByIdRef = useRef(new Map<string, Object3D>());
  const [status, setStatus] = useState<"loading" | "ready" | "fallback">("loading");
  const [reducedMotion, setReducedMotion] = useState<boolean | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(media.matches);
    updatePreference();
    media.addEventListener("change", updatePreference);
    return () => media.removeEventListener("change", updatePreference);
  }, []);

  const graphData = useMemo(() => {
    const categoryMap = new Map(taxonomy.map((category) => [category.id, category]));
    const categoryCounts = new Map<string, number>();
    for (const menu of menus) categoryCounts.set(menu.category, (categoryCounts.get(menu.category) ?? 0) + 1);
    const categoryNodes: GraphNode[] = taxonomy.map((category, index) => {
      const position = categoryPosition(index, taxonomy.length);
      return {
        id: `category:${category.id}`,
        kind: "category",
        category: category.id,
        color: category.color,
        name: `${category.emoji} ${category.id}`,
        size: 18,
        fx: position.x,
        fy: position.y,
        fz: position.z,
      };
    });
    const categoryPositionMap = new Map(categoryNodes.map((node) => [node.category, node]));
    const menuNodes: GraphNode[] = menus.map((menu) => {
      const category = categoryMap.get(menu.category);
      const center = categoryPositionMap.get(menu.category) ?? categoryNodes[0];
      const clusterCount = categoryCounts.get(menu.category) ?? 1;
      const spread = 76 + Math.sqrt(clusterCount) * 10;
      const theta = seededValue(menu.id, 11) * Math.PI * 2;
      const vertical = seededValue(menu.id, 29) * 2 - 1;
      const radial = 34 + seededValue(menu.id, 47) * spread;
      const planar = Math.sqrt(Math.max(0, 1 - vertical * vertical));
      return {
        id: menu.id,
        kind: "menu",
        category: menu.category,
        color: category?.color ?? "#ffffff",
        name: `${menu.restaurantLabel} · ${menu.menu}`,
        menu,
        size: 5.5,
        x: Number(center?.fx ?? 0) + Math.cos(theta) * planar * radial,
        y: Number(center?.fy ?? 0) + Math.sin(theta) * planar * radial,
        z: Number(center?.fz ?? 0) + vertical * radial * 0.72,
      };
    });
    const anomalyNodes: GraphNode[] = easterEggs.map((item, index) => ({
      id: `anomaly:${item.id}`,
      kind: "anomaly",
      category: item.category,
      color: "#050301",
      name: `${item.restaurantLabel} · ${item.menu} · 취향 −∞`,
      easterEgg: item,
      size: 22,
      fx: -540 - index * 70,
      fy: -250 - index * 35,
      fz: -330 - index * 45,
    }));
    const categoryLinks: GraphLink[] = menuNodes.map((node) => ({
      source: `category:${node.category}`,
      target: node.id,
      kind: "category",
      count: 1,
      distance: 74 + Math.min(38, Math.sqrt(categoryCounts.get(node.category) ?? 1) * 8),
    }));
    return { nodes: [...categoryNodes, ...menuNodes, ...anomalyNodes], links: categoryLinks };
  }, [easterEggs, menus, taxonomy]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let starField: Object3D | null = null;
    const cosmicDecorations: Object3D[] = [];
    let bloomPass: { setSize: (width: number, height: number) => void; dispose?: () => void } | null = null;
    let lensingPass: LensingPassLike | null = null;
    const depthTextures: DepthTexture[] = [];
    let lensingAnimationFrame: number | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let handleVisibilityChange: (() => void) | null = null;
    let appliedCameraDistance = 0;
    const objectById = new Map<string, Object3D>();
    objectByIdRef.current = objectById;
    const container = containerRef.current;
    if (reducedMotion === null) return;
    const motionReduced = reducedMotion;
    if (!container || !webglAvailable()) {
      setStatus("fallback");
      return;
    }
    setStatus("loading");

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (!disposed) setStatus("fallback");
    };

    async function mountGraph() {
      try {
        const [forceModule, three, spriteModule, bloomModule, shaderPassModule] = await Promise.all([
          import("3d-force-graph"),
          import("three"),
          import("three-spritetext"),
          import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
          import("three/examples/jsm/postprocessing/ShaderPass.js"),
        ]);
        if (disposed || !container) return;
        const ForceGraph3D = forceModule.default;
        const SpriteText = spriteModule.default;
        const graph = new ForceGraph3D(container, { controlType: "orbit" }) as unknown as ForceGraph3DInstance<GraphNode, GraphLink>;
        graphRef.current = graph;
        objectById.clear();

        // Soft stellar glow shared by category coronas and menu stars. Glows
        // are additive, never raycast, and stay dimmer than the labels.
        const glowCanvas = document.createElement("canvas");
        glowCanvas.width = glowCanvas.height = 128;
        const glowContext = glowCanvas.getContext("2d");
        if (glowContext) {
          const glow = glowContext.createRadialGradient(64, 64, 0, 64, 64, 64);
          glow.addColorStop(0, "rgba(255,255,255,1)");
          glow.addColorStop(0.1, "rgba(255,255,255,0.7)");
          glow.addColorStop(0.28, "rgba(255,255,255,0.24)");
          glow.addColorStop(0.56, "rgba(255,255,255,0.06)");
          glow.addColorStop(1, "rgba(255,255,255,0)");
          glowContext.fillStyle = glow;
          glowContext.fillRect(0, 0, 128, 128);
        }
        const glowTexture = new three.CanvasTexture(glowCanvas);
        // Drawn only if the lensing shader cannot compile on this GPU.
        const blackHoleFallback: Object3D[] = [];
        let lensingFailed = false;

        graph
          .width(Math.max(1, container.clientWidth))
          .height(Math.max(1, container.clientHeight))
          .backgroundColor("#020208")
          .showNavInfo(false)
          .graphData(graphData)
          .nodeLabel((node) => {
            const tooltip = document.createElement("div");
            tooltip.className = "graph-tooltip";
            tooltip.textContent = node.kind === "category"
              ? `${node.name} · ${menus.filter((menu) => menu.category === node.category).length}개 메뉴`
              : node.name;
            return tooltip;
          })
          .nodeThreeObject((node): Object3D => {
            const cached = objectById.get(node.id);
            if (cached) return cached;
            if (node.kind === "category") {
              const hub = new three.Group();
              hub.name = "category-hub";
              const core = new three.Mesh(
                new three.IcosahedronGeometry(7.2, 1),
                new three.MeshStandardMaterial({
                  color: node.color,
                  emissive: node.color,
                  emissiveIntensity: 0.56,
                  roughness: 0.32,
                  metalness: 0.2,
                  flatShading: true,
                }),
              );
              const corona = new three.Sprite(new three.SpriteMaterial({
                map: glowTexture,
                color: node.color,
                transparent: true,
                opacity: 0.3,
                depthWrite: false,
                blending: three.AdditiveBlending,
              }));
              corona.name = "category-corona";
              corona.scale.set(74, 74, 1);
              corona.renderOrder = -1;
              const halo = new three.Mesh(
                new three.SphereGeometry(12.5, 18, 18),
                new three.MeshBasicMaterial({
                  color: node.color,
                  transparent: true,
                  opacity: 0.09,
                  depthWrite: false,
                  side: three.BackSide,
                  blending: three.AdditiveBlending,
                }),
              );
              const orbitA = new three.Mesh(
                new three.TorusGeometry(14.5, 0.34, 8, 64),
                new three.MeshBasicMaterial({
                  color: node.color,
                  transparent: true,
                  opacity: 0.44,
                  depthWrite: false,
                  blending: three.AdditiveBlending,
                }),
              );
              const orbitB = orbitA.clone();
              orbitA.rotation.x = Math.PI / 2.4;
              orbitB.rotation.y = Math.PI / 2.2;
              orbitB.scale.setScalar(0.78);
              const sprite = new SpriteText(node.name);
              sprite.name = "category-label";
              // Lift label luminance independently of category star color.
              sprite.color = new three.Color(node.color).lerp(new three.Color("#ffffff"), 0.42).getStyle();
              sprite.textHeight = categoryLabelHeight(container.clientWidth);
              sprite.fontWeight = "700";
              sprite.backgroundColor = "rgba(2, 4, 12, .90)";
              sprite.padding = 3;
              sprite.borderRadius = 4;
              sprite.position.set(0, 24, 0);
              sprite.userData.labelAspect = sprite.scale.x / sprite.scale.y;
              sprite.raycast = () => {};
              // Category ornaments must never cover a nearby selectable menu.
              for (const ornament of [corona, halo, core, orbitA, orbitB]) ornament.raycast = () => {};
              hub.add(corona, halo, core, orbitA, orbitB, sprite);
              objectById.set(node.id, hub);
              return hub;
            }

            if (node.kind === "anomaly") {
              // Gargantua itself is ray-traced by the lensing pass below: the
              // shadow, the photon ring, the Doppler-beamed accretion disk and
              // the far half of the disk bent over and under the shadow. These
              // meshes are never drawn. The raycaster ignores visibility, so
              // they keep the click target the same shape as the drawn hole.
              const anomaly = new three.Group();
              anomaly.userData.selectionId = node.easterEgg?.id;
              const proxyMaterial = new three.MeshBasicMaterial({ visible: false });
              const horizon = new three.Mesh(
                new three.SphereGeometry(node.size, 32, 32),
                new three.MeshBasicMaterial({ color: "#000000", visible: false }),
              );
              horizon.renderOrder = 4;
              const gravitationalHalo = new three.Mesh(new three.SphereGeometry(node.size * 1.5, 24, 24), proxyMaterial);

              const facingGroup = new three.Group();
              facingGroup.name = "gargantua-facing";
              const accretionDisk = new three.Mesh(new three.CircleGeometry(node.size * 3.3, 64), proxyMaterial);
              accretionDisk.name = "accretion-disk";
              accretionDisk.rotation.set(-(Math.PI / 2 - GARGANTUA_INCLINATION), 0, GARGANTUA_ROLL, "ZYX");

              const buildLensedArc = (direction: 1 | -1, radiusScale: number, tubeScale: number) => {
                const points = Array.from({ length: 25 }, (_, index) => {
                  const angle = Math.PI * (0.06 + (index / 24) * 0.88);
                  return new three.Vector3(
                    Math.cos(angle) * node.size * radiusScale * 1.3,
                    direction * Math.sin(angle) * node.size * radiusScale,
                    0,
                  );
                });
                const arc = new three.Mesh(
                  new three.TubeGeometry(new three.CatmullRomCurve3(points), 40, node.size * tubeScale, 6, false),
                  proxyMaterial,
                );
                arc.rotation.z = GARGANTUA_ROLL;
                return arc;
              };
              // The far half of the disk is lensed into arcs above and below the shadow.
              const upperLensingArc = buildLensedArc(1, 1.42, 0.3);
              const lowerLensingArc = buildLensedArc(-1, 1.28, 0.24);

              const selectionRing = new three.Mesh(
                new three.TorusGeometry(node.size * 2.82, node.size * 0.045, 8, 96),
                proxyMaterial,
              );
              selectionRing.name = "selection-ring";
              selectionRing.visible = node.easterEgg?.id === selectedIdRef.current;

              const fallbackGlow = new three.Sprite(new three.SpriteMaterial({
                map: glowTexture,
                color: "#ffb84d",
                transparent: true,
                opacity: 0.55,
                depthWrite: false,
                blending: three.AdditiveBlending,
              }));
              fallbackGlow.scale.set(node.size * 6, node.size * 6, 1);
              fallbackGlow.visible = false;
              fallbackGlow.raycast = () => {};
              blackHoleFallback.push(horizon, fallbackGlow);

              facingGroup.add(accretionDisk, upperLensingArc, lowerLensingArc, selectionRing);
              anomaly.add(fallbackGlow, gravitationalHalo, facingGroup, horizon);
              objectById.set(node.id, anomaly);
              return anomaly;
            }

            const group = new three.Group();
            const core = new three.Mesh(
              new three.SphereGeometry(node.size, 18, 18),
              new three.MeshStandardMaterial({
                color: node.color, emissive: node.color, emissiveIntensity: 0.66,
                roughness: 0.28, metalness: 0.16,
              }),
            );
            group.add(core);

            const ring = new three.Mesh(
              new three.TorusGeometry(node.size * 1.75, Math.max(0.28, node.size * 0.08), 8, 36),
              new three.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.92 }),
            );
            ring.name = "selection-ring";
            ring.raycast = () => {};
            ring.visible = node.id === selectedIdRef.current;
            ring.rotation.x = Math.PI / 2.8;
            group.add(ring);
            objectById.set(node.id, group);
            return group;
          })
          .linkVisibility(() => false)
          .linkOpacity(0)
          .linkWidth(0)
          .linkDirectionalParticles(0)
          .onNodeHover((node) => {
            container.style.cursor = node?.kind === "menu" || node?.kind === "anomaly" ? "pointer" : "grab";
          })
          .onNodeClick((node) => {
            if (node.kind === "category") return;
            if (node.kind === "menu" && node.menu) onSelectRef.current(node.menu);
            if (node.kind === "anomaly" && node.easterEgg) onSelectEasterEggRef.current(node.easterEgg);
            const distance = focusDistanceForViewport(node.kind, container.clientWidth);
            focusGraphNode(graph, node, distance, motionReduced ? 0 : 900);
          })
          .warmupTicks(72)
          .cooldownTicks(motionReduced ? 60 : 180)
          .d3AlphaDecay(0.029)
          .d3VelocityDecay(0.4);

        const charge = graph.d3Force("charge");
        if (charge && "strength" in charge && typeof charge.strength === "function") charge.strength(-72);
        if (charge && "distanceMin" in charge && typeof charge.distanceMin === "function") charge.distanceMin(12);
        const linkForce = graph.d3Force("link");
        if (linkForce && "distance" in linkForce && typeof linkForce.distance === "function") {
          linkForce.distance((link: GraphLink) => link.distance);
        }
        if (linkForce && "strength" in linkForce && typeof linkForce.strength === "function") {
          linkForce.strength(0.34);
        }
        graph.d3Force("collision", createCollisionForce(5));

        const controls = graph.controls() as OrbitControlsLike;
        controls.autoRotate = !pausedRef.current && !motionReduced;
        controls.autoRotateSpeed = 0.38;
        appliedCameraDistance = cameraDistanceForViewport(container.clientWidth, container.clientHeight);
        graph.cameraPosition({ x: 0, y: 24, z: appliedCameraDistance });
        graph.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.45));

        // Gargantua pass. Near the hole every pixel traces a light ray through
        // the Schwarzschild metric (units of r_s): rays below the critical
        // impact parameter fall in, rays crossing the thin disk pick up
        // Doppler-beamed, gravitationally redshifted emission, and rays that
        // circle the hole draw the far half of the disk over and under the
        // shadow. Stars behind the hole are bent onto a source plane, and scene
        // depth keeps anything in front of the hole sharp and unbent.
        const lensing = new shaderPassModule.ShaderPass({
          uniforms: {
            tDiffuse: { value: null },
            tDepth: { value: null },
            depthReady: { value: 0 },
            lensCenter: { value: new three.Vector2(-2, -2) },
            lensRadius: { value: 0.08 },
            lensStrength: { value: 1 },
            aspect: { value: Math.max(1, container.clientWidth / Math.max(1, container.clientHeight)) },
            shadowRadius: { value: 0.02 },
            pixelsPerShadow: { value: 20 },
            diskTime: { value: 18 },
            selectionMix: { value: 0 },
            fogMix: { value: 0 },
            holeDepth: { value: 1000 },
            depthMargin: { value: 12 },
            cameraNear: { value: 0.1 },
            cameraFar: { value: 2000 },
          },
          defines: {
            GARGANTUA_INCLINATION: GARGANTUA_INCLINATION.toFixed(4),
            GARGANTUA_ROLL: GARGANTUA_ROLL.toFixed(4),
          },
          vertexShader: `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            #include <packing>
            uniform sampler2D tDiffuse;
            uniform sampler2D tDepth;
            uniform float depthReady;
            uniform vec2 lensCenter;
            uniform float lensRadius;
            uniform float lensStrength;
            uniform float aspect;
            uniform float shadowRadius;
            uniform float pixelsPerShadow;
            uniform float diskTime;
            uniform float selectionMix;
            uniform float fogMix;
            uniform float holeDepth;
            uniform float depthMargin;
            uniform float cameraNear;
            uniform float cameraFar;
            varying vec2 vUv;

            // Units are Schwarzschild radii; the shadow edge sits at 3√3/2.
            const float CRITICAL_IMPACT = 2.598;
            const float DISK_INNER = 3.0;
            const float DISK_OUTER = 8.6;
            const float START_DISTANCE = 15.0;
            // Puts the Einstein ring near 1.4 shadow radii, behind the lensed disk.
            const float SOURCE_DISTANCE = 4.0;
            const float NEAR_FIELD = 3.75;
            const float FLOW_PERIOD = 40.0;
            const int MAX_STEPS = 120;

            float hash13(vec3 point) {
              point = fract(point * 0.1031);
              point += dot(point, point.zyx + 31.32);
              return fract((point.x + point.y) * point.z);
            }

            float valueNoise(vec3 point) {
              vec3 cell = floor(point);
              vec3 local = fract(point);
              vec3 blend = local * local * (3.0 - 2.0 * local);
              float n000 = hash13(cell);
              float n100 = hash13(cell + vec3(1.0, 0.0, 0.0));
              float n010 = hash13(cell + vec3(0.0, 1.0, 0.0));
              float n110 = hash13(cell + vec3(1.0, 1.0, 0.0));
              float n001 = hash13(cell + vec3(0.0, 0.0, 1.0));
              float n101 = hash13(cell + vec3(1.0, 0.0, 1.0));
              float n011 = hash13(cell + vec3(0.0, 1.0, 1.0));
              float n111 = hash13(cell + vec3(1.0, 1.0, 1.0));
              return mix(
                mix(mix(n000, n100, blend.x), mix(n010, n110, blend.x), blend.y),
                mix(mix(n001, n101, blend.x), mix(n011, n111, blend.x), blend.y),
                blend.z
              );
            }

            float fbm(vec3 point) {
              float sum = 0.0;
              float amplitude = 0.5;
              for (int octave = 0; octave < 3; octave++) {
                sum += amplitude * valueNoise(point);
                point = point * 2.07 + vec3(3.1, 1.7, 5.3);
                amplitude *= 0.5;
              }
              return sum / 0.875;
            }

            // Sampled on a circle so the streaks have no seam at ±π.
            float diskStreaks(float azimuth, float radius, float seed) {
              return fbm(vec3(cos(azimuth) * 2.3, sin(azimuth) * 2.3, log(radius) * 7.5) + seed * 17.0);
            }

            vec3 diskPalette(float heat) {
              vec3 color = mix(vec3(0.254, 0.012, 0.004), vec3(0.815, 0.07, 0.018), smoothstep(0.0, 0.25, heat));
              color = mix(color, vec3(1.0, 0.195, 0.028), smoothstep(0.2, 0.42, heat));
              color = mix(color, vec3(1.0, 0.445, 0.068), smoothstep(0.38, 0.6, heat));
              color = mix(color, vec3(1.0, 0.753, 0.323), smoothstep(0.55, 0.78, heat));
              color = mix(color, vec3(1.0, 0.939, 0.716), smoothstep(0.74, 0.95, heat));
              return mix(color, vec3(0.791, 0.855, 1.0), smoothstep(1.05, 1.4, heat));
            }

            vec4 diskSample(vec3 hit, float radius, vec3 rayDirection, float detail) {
              float azimuth = atan(hit.z, hit.x);
              float speed = sqrt(0.5 / radius);
              vec3 orbit = vec3(-sin(azimuth), 0.0, cos(azimuth));
              float doppler = sqrt(1.0 - speed * speed) / (1.0 + speed * dot(orbit, rayDirection));
              float shift = doppler * sqrt(max(0.0, 1.0 - 1.0 / radius));
              float profile = pow(DISK_INNER / radius, 0.75)
                * pow(max(0.0, 1.0 - sqrt(DISK_INNER / radius)), 0.25) / 0.488;
              // Two phases cross-fade so differential rotation never winds the streaks up.
              float angularSpeed = speed / radius;
              float cycle = diskTime / FLOW_PERIOD;
              float phase = fract(cycle);
              float halfPhase = fract(cycle + 0.5);
              float streaks = mix(
                diskStreaks(azimuth - angularSpeed * halfPhase * FLOW_PERIOD, radius, floor(cycle + 0.5)),
                diskStreaks(azimuth - angularSpeed * phase * FLOW_PERIOD, radius, floor(cycle) + 0.5),
                1.0 - abs(phase * 2.0 - 1.0)
              );
              streaks = mix(0.6, streaks, detail);
              float edges = smoothstep(DISK_INNER * 0.94, DISK_INNER * 1.18, radius)
                * (1.0 - smoothstep(DISK_OUTER * 0.62, DISK_OUTER, radius));
              float alpha = clamp(edges * smoothstep(0.16, 0.8, streaks) * (0.5 + 0.55 * profile), 0.0, 0.94);
              float intensity = pow(profile, 1.6) * pow(shift, 2.3) * (0.55 + 0.9 * streaks);
              return vec4(diskPalette(profile * shift) * intensity * 1.4, alpha);
            }

            void main() {
              vec4 scene = texture2D(tDiffuse, vUv);
              vec2 metric = vec2((vUv.x - lensCenter.x) * aspect, vUv.y - lensCenter.y);
              float distanceToLens = length(metric);
              float lensMask = step(distanceToLens, lensRadius);
              if (lensMask < 0.5) {
                gl_FragColor = scene;
                return;
              }
              if (depthReady > 0.5) {
                // Anything between the camera and the hole is neither bent nor covered.
                float depth = texture2D(tDepth, vUv).x;
                float sceneDistance = -perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
                if (depth < 0.9999 && sceneDistance < holeDepth - depthMargin) {
                  gl_FragColor = scene;
                  return;
                }
              }

              float rollCos = cos(GARGANTUA_ROLL);
              float rollSin = sin(GARGANTUA_ROLL);
              vec2 disk = vec2(rollCos * metric.x + rollSin * metric.y, rollCos * metric.y - rollSin * metric.x)
                / max(shadowRadius, 0.00001);
              float radius = length(disk);
              vec2 direction = radius > 0.00001 ? disk / radius : vec2(0.0, 1.0);
              float detail = smoothstep(6.0, 42.0, pixelsPerShadow);

              // Stars and clusters behind the hole, bent onto a source plane behind it.
              float impact = max(radius * CRITICAL_IMPACT, 0.001);
              float bending = min(2.0 / impact + 2.945 / (impact * impact), 1.5);
              float sourceImpact = impact - tan(bending) * SOURCE_DISTANCE;
              float taper = 1.0 - smoothstep(0.5, 1.0, distanceToLens / lensRadius);
              vec2 source = direction * mix(radius, sourceImpact / CRITICAL_IMPACT, taper * lensStrength);
              vec2 sourceMetric = vec2(rollCos * source.x - rollSin * source.y, rollSin * source.x + rollCos * source.y)
                * shadowRadius;
              vec2 sourceUv = lensCenter + vec2(sourceMetric.x / aspect, sourceMetric.y);
              // Light bent in from beyond the frame is not rendered: reflect it
              // back from the edge, dimming as the reach grows, so a hole near
              // the edge of the canvas does not cut a black notch into the sky.
              vec2 beyond = max(-sourceUv, sourceUv - 1.0);
              float frame = mix(0.45, 1.0, 1.0 - smoothstep(0.02, 0.4, max(beyond.x, beyond.y)));
              vec2 reflectedUv = 1.0 - abs(1.0 - mod(abs(sourceUv), 2.0));
              // Inside the Einstein ring only faint, mirrored secondary images remain.
              float secondary = mix(0.1, 1.0, smoothstep(1.02, 1.6, radius));
              vec3 background = texture2D(tDiffuse, clamp(reflectedUv, 0.001, 0.999)).rgb * frame * secondary;

              // Shadow, photon ring and accretion disk, ray-traced near the hole.
              vec3 emission = vec3(0.0);
              float opacity = 0.0;
              float eventHorizonMask = 0.0;
              // Only trace where light can meet the disk: the lensed arcs stay
              // within about 2 shadow radii, the direct image in a thin band.
              if (radius < 2.4 || (abs(disk.y) < 1.0 && abs(disk.x) < NEAR_FIELD)) {
                vec3 forward = vec3(0.0, -sin(GARGANTUA_INCLINATION), cos(GARGANTUA_INCLINATION));
                vec3 up = vec3(0.0, cos(GARGANTUA_INCLINATION), sin(GARGANTUA_INCLINATION));
                vec3 position = -forward * START_DISTANCE + (vec3(disk.x, 0.0, 0.0) + up * disk.y) * CRITICAL_IMPACT;
                vec3 velocity = forward;
                vec3 angular = cross(position, velocity);
                float angularSquared = dot(angular, angular);
                for (int iteration = 0; iteration < MAX_STEPS; iteration++) {
                  float radiusSquared = dot(position, position);
                  float orbitRadius = sqrt(radiusSquared);
                  if (orbitRadius < 1.0) {
                    eventHorizonMask = 1.0;
                    break;
                  }
                  float stepSize = clamp(0.085 * orbitRadius, 0.03, 0.65);
                  vec3 previous = position;
                  velocity -= (1.5 * angularSquared / radiusSquared) * position / (radiusSquared * orbitRadius) * stepSize;
                  position += velocity * stepSize;
                  if (previous.y * position.y < 0.0) {
                    vec3 hit = mix(previous, position, previous.y / (previous.y - position.y));
                    float hitRadius = length(hit.xz);
                    if (hitRadius > DISK_INNER * 0.94 && hitRadius < DISK_OUTER) {
                      vec4 diskLight = diskSample(hit, hitRadius, normalize(velocity), detail);
                      emission += (1.0 - opacity) * diskLight.rgb * diskLight.a;
                      opacity += (1.0 - opacity) * diskLight.a;
                      if (opacity > 0.985) break;
                    }
                  }
                  if (orbitRadius > DISK_OUTER + 0.5 && dot(position, velocity) > 0.0) break;
                }
              }

              float coverage = opacity + (1.0 - opacity) * eventHorizonMask;
              emission /= 1.0 + 0.3 * emission;
              float ringOffset = (radius - 1.015) / max(0.028, 1.4 / max(pixelsPerShadow, 1.0));
              float photonRing = exp(-ringOffset * ringOffset) * (1.0 - 0.3 * direction.x);
              vec3 hole = (emission + vec3(1.0, 0.896, 0.552) * photonRing * 0.8) * (1.0 - fogMix);
              float selectionOffset = (radius - 2.82) / max(0.022, 1.2 / max(pixelsPerShadow, 1.0));
              float selection = selectionMix * exp(-selectionOffset * selectionOffset);
              vec3 color = background * (1.0 - coverage) + hole + vec3(1.0, 0.799, 0.356) * selection * 0.5;
              gl_FragColor = vec4(color, scene.a);
            }
          `,
        }) as unknown as LensingPassLike;
        lensing.enabled = false;
        lensingPass = lensing;
        const composer = graph.postProcessingComposer();
        // EffectComposer captures DPR at construction; keep the expensive lens
        // and bloom buffers under the same 1.45 cap as the visible canvas.
        composer.setPixelRatio(graph.renderer().getPixelRatio());
        // Scene depth lets the pass leave anything in front of the hole alone.
        for (const target of [composer.renderTarget1, composer.renderTarget2]) {
          if (target.depthTexture) continue;
          const depthTexture = new three.DepthTexture(Math.max(1, target.width), Math.max(1, target.height));
          target.depthTexture = depthTexture;
          target.dispose();
          depthTextures.push(depthTexture);
        }
        const renderLensing = lensing.render.bind(lensing);
        lensing.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
          lensing.uniforms.tDepth.value = readBuffer.depthTexture;
          lensing.uniforms.depthReady.value = readBuffer.depthTexture ? 1 : 0;
          renderLensing(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
        };
        composer.addPass(lensing as never);
        // If a GPU rejects the shader, fall back to a plain black hole rather
        // than leaving the pass to paint nothing.
        graph.renderer().debug.onShaderError = (gl, program) => {
          console.error("Menu cosmos lensing shader failed", gl.getProgramInfoLog(program));
          lensingFailed = true;
          lensing.enabled = false;
          for (const object of blackHoleFallback) {
            object.visible = true;
            const material = (object as Object3D & { material?: { visible: boolean } }).material;
            if (material) material.visible = true;
          }
        };

        const bloom = new bloomModule.UnrealBloomPass(
          new three.Vector2(container.clientWidth, container.clientHeight),
          0.62,
          0.3,
          0.28,
        );
        bloom.threshold = 0.8;
        bloom.strength = 0.48;
        bloom.radius = 0.24;
        bloomPass = bloom;
        graph.postProcessingComposer().addPass(bloom);

        // One shared point texture keeps every batched star round and softly
        // luminous, rather than rendering opaque square particles.
        const pointCanvas = document.createElement("canvas");
        pointCanvas.width = pointCanvas.height = 64;
        const pointContext = pointCanvas.getContext("2d");
        if (pointContext) {
          const light = pointContext.createRadialGradient(32, 32, 0, 32, 32, 32);
          light.addColorStop(0, "rgba(255,255,255,1)");
          light.addColorStop(0.14, "rgba(255,255,255,0.95)");
          light.addColorStop(0.38, "rgba(255,255,255,0.35)");
          light.addColorStop(1, "rgba(255,255,255,0)");
          pointContext.fillStyle = light;
          pointContext.fillRect(0, 0, 64, 64);
        }
        const pointTexture = new three.CanvasTexture(pointCanvas);
        // Stellar tints from blue-white to warm, weighted toward the old #c7ddff.
        const starTints = ["#c7ddff", "#c7ddff", "#e9f1ff", "#ffffff", "#ffe7c2", "#9ec1ff"]
          .map((color) => new three.Color(color));
        const stars = 1080;
        const starPositions = new Float32Array(stars * 3);
        const starColors = new Float32Array(stars * 3);
        for (let index = 0; index < stars; index += 1) {
          const radius = 280 + seededValue(`star-${index}`, 5) * 620;
          const theta = seededValue(`star-${index}`, 7) * Math.PI * 2;
          const phi = Math.acos(2 * seededValue(`star-${index}`, 13) - 1);
          starPositions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
          starPositions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
          starPositions[index * 3 + 2] = radius * Math.cos(phi);
          const tint = starTints[Math.floor(seededValue(`star-${index}`, 19) * starTints.length)];
          starColors[index * 3] = tint.r;
          starColors[index * 3 + 1] = tint.g;
          starColors[index * 3 + 2] = tint.b;
        }
        const starGeometry = new three.BufferGeometry();
        starGeometry.setAttribute("position", new three.BufferAttribute(starPositions, 3));
        starGeometry.setAttribute("color", new three.BufferAttribute(starColors, 3));
        const starMaterial = new three.PointsMaterial({
          map: pointTexture,
          alphaTest: 0.01,
          vertexColors: true,
          size: 1.85,
          transparent: true,
          opacity: 0.66,
          depthWrite: false,
          blending: three.AdditiveBlending,
        });
        starField = new three.Points(starGeometry, starMaterial);
        graph.scene().add(starField);

        const dustCount = 260;
        const dustPositions = new Float32Array(dustCount * 3);
        const dustColors = new Float32Array(dustCount * 3);
        const cyan = new three.Color("#5de7ff");
        const violet = new three.Color("#b176ff");
        for (let index = 0; index < dustCount; index += 1) {
          const angle = seededValue(`dust-${index}`, 17) * Math.PI * 2;
          const radius = 150 + seededValue(`dust-${index}`, 23) * 430;
          const lift = (seededValue(`dust-${index}`, 31) - 0.5) * 90;
          dustPositions[index * 3] = Math.cos(angle) * radius;
          dustPositions[index * 3 + 1] = Math.sin(angle) * radius * 0.42 + lift;
          dustPositions[index * 3 + 2] = (seededValue(`dust-${index}`, 43) - 0.5) * 250;
          const color = index % 3 === 0 ? violet : cyan;
          dustColors[index * 3] = color.r;
          dustColors[index * 3 + 1] = color.g;
          dustColors[index * 3 + 2] = color.b;
        }
        const dustGeometry = new three.BufferGeometry();
        dustGeometry.setAttribute("position", new three.BufferAttribute(dustPositions, 3));
        dustGeometry.setAttribute("color", new three.BufferAttribute(dustColors, 3));
        const dust = new three.Points(
          dustGeometry,
          new three.PointsMaterial({
            map: pointTexture,
            alphaTest: 0.01,
            size: 2.3,
            transparent: true,
            opacity: 0.32,
            vertexColors: true,
            depthWrite: false,
            blending: three.AdditiveBlending,
          }),
        );
        dust.rotation.z = -0.16;
        dust.name = "galactic-dust";
        cosmicDecorations.push(dust);

        const spiralCount = 900;
        const spiralPositions = new Float32Array(spiralCount * 3);
        const spiralColors = new Float32Array(spiralCount * 3);
        const pink = new three.Color("#ff5e91");
        for (let index = 0; index < spiralCount; index += 1) {
          const progress = Math.pow(index / spiralCount, 0.7);
          const arm = index % 3;
          const angle = progress * Math.PI * 3.6 + arm * (Math.PI * 2 / 3)
            + (seededValue(`spiral-${index}`, 61) - 0.5) * 0.34;
          const radius = 36 + progress * 500;
          spiralPositions[index * 3] = Math.cos(angle) * radius;
          spiralPositions[index * 3 + 1] = (seededValue(`spiral-${index}`, 67) - 0.5) * (18 + progress * 52);
          spiralPositions[index * 3 + 2] = Math.sin(angle) * radius * 0.72;
          const color = index % 5 === 0 ? pink : index % 2 === 0 ? violet : cyan;
          spiralColors[index * 3] = color.r;
          spiralColors[index * 3 + 1] = color.g;
          spiralColors[index * 3 + 2] = color.b;
        }
        const spiralGeometry = new three.BufferGeometry();
        spiralGeometry.setAttribute("position", new three.BufferAttribute(spiralPositions, 3));
        spiralGeometry.setAttribute("color", new three.BufferAttribute(spiralColors, 3));
        const spiralArms = new three.Points(
          spiralGeometry,
          new three.PointsMaterial({
            map: pointTexture,
            alphaTest: 0.01,
            size: 3.5,
            transparent: true,
            opacity: 0.62,
            vertexColors: true,
            depthWrite: false,
            blending: three.AdditiveBlending,
          }),
        );
        spiralArms.rotation.x = 0.42;
        spiralArms.rotation.z = -0.22;
        spiralArms.name = "spiral-arms";
        cosmicDecorations.push(spiralArms);

        // A single batched flare field adds near-camera depth and bright anchor
        // stars without creating one mesh (and one draw call) per light.
        const flareCount = 96;
        const flarePositions = new Float32Array(flareCount * 3);
        const flareColors = new Float32Array(flareCount * 3);
        const warmWhite = new three.Color("#fff1c2");
        for (let index = 0; index < flareCount; index += 1) {
          const angle = seededValue(`flare-${index}`, 83) * Math.PI * 2;
          const radius = 210 + seededValue(`flare-${index}`, 89) * 520;
          flarePositions[index * 3] = Math.cos(angle) * radius;
          flarePositions[index * 3 + 1] = (seededValue(`flare-${index}`, 97) - 0.5) * 420;
          flarePositions[index * 3 + 2] = Math.sin(angle) * radius;
          const color = index % 4 === 0 ? warmWhite : index % 3 === 0 ? violet : cyan;
          flareColors[index * 3] = color.r;
          flareColors[index * 3 + 1] = color.g;
          flareColors[index * 3 + 2] = color.b;
        }
        const flareGeometry = new three.BufferGeometry();
        flareGeometry.setAttribute("position", new three.BufferAttribute(flarePositions, 3));
        flareGeometry.setAttribute("color", new three.BufferAttribute(flareColors, 3));
        const stellarFlares = new three.Points(
          flareGeometry,
          new three.PointsMaterial({
            map: pointTexture,
            alphaTest: 0.01,
            size: 4.0,
            transparent: true,
            opacity: 0.68,
            vertexColors: true,
            depthWrite: false,
            blending: three.AdditiveBlending,
          }),
        );
        stellarFlares.name = "stellar-flares";
        cosmicDecorations.push(stellarFlares);

        // Two faint partial rings suggest distant nebula filaments while
        // retaining the existing data-first composition and bounded GPU cost.
        const nebulaArcs = new three.Group();
        nebulaArcs.name = "nebula-arcs";
        for (const [index, color] of ["#6feaff", "#c98cff"].entries()) {
          const arc = new three.Mesh(
            new three.TorusGeometry(350 + index * 84, 0.72 + index * 0.22, 6, 160, Math.PI * 1.42),
            new three.MeshBasicMaterial({
              color,
              transparent: true,
              opacity: 0.13 - index * 0.035,
              depthWrite: false,
              blending: three.AdditiveBlending,
            }),
          );
          arc.rotation.set(1.08 + index * 0.16, 0.34 - index * 0.22, -0.52 + index * 0.64);
          nebulaArcs.add(arc);
        }
        cosmicDecorations.push(nebulaArcs);

        const coreTextureCanvas = document.createElement("canvas");
        coreTextureCanvas.width = coreTextureCanvas.height = 64;
        const coreContext = coreTextureCanvas.getContext("2d");
        if (coreContext) {
          const gradient = coreContext.createRadialGradient(32, 32, 0, 32, 32, 32);
          gradient.addColorStop(0, "rgba(220,245,255,.5)");
          gradient.addColorStop(.16, "rgba(120,220,255,.22)");
          gradient.addColorStop(.45, "rgba(118,95,220,.07)");
          gradient.addColorStop(1, "rgba(80,70,160,0)");
          coreContext.fillStyle = gradient;
          coreContext.fillRect(0, 0, 64, 64);
          const galacticCore = new three.Sprite(new three.SpriteMaterial({
            map: new three.CanvasTexture(coreTextureCanvas), transparent: true,
            depthWrite: false, blending: three.AdditiveBlending,
          }));
          galacticCore.scale.set(285, 285, 1);
          galacticCore.name = "galactic-core";
          cosmicDecorations.push(galacticCore);
        }

        const galacticDisk = new three.Mesh(
          new three.RingGeometry(185, 535, 96),
          new three.MeshBasicMaterial({
            color: "#5f8cff",
            transparent: true,
            opacity: 0.009,
            depthWrite: false,
            side: three.DoubleSide,
            blending: three.AdditiveBlending,
          }),
        );
        galacticDisk.rotation.x = 1.13;
        galacticDisk.rotation.z = -0.18;
        cosmicDecorations.push(galacticDisk);

        // A warm nucleus and a dense, flattened bulge give the galactic core
        // a body instead of a flat glow.
        const nucleusCanvas = document.createElement("canvas");
        nucleusCanvas.width = nucleusCanvas.height = 64;
        const nucleusContext = nucleusCanvas.getContext("2d");
        if (nucleusContext) {
          const gradient = nucleusContext.createRadialGradient(32, 32, 0, 32, 32, 32);
          gradient.addColorStop(0, "rgba(255,244,222,.6)");
          gradient.addColorStop(.18, "rgba(255,214,160,.2)");
          gradient.addColorStop(.5, "rgba(190,150,255,.05)");
          gradient.addColorStop(1, "rgba(120,100,220,0)");
          nucleusContext.fillStyle = gradient;
          nucleusContext.fillRect(0, 0, 64, 64);
          const nucleus = new three.Sprite(new three.SpriteMaterial({
            map: new three.CanvasTexture(nucleusCanvas), transparent: true,
            depthWrite: false, blending: three.AdditiveBlending,
          }));
          nucleus.scale.set(110, 110, 1);
          nucleus.name = "galactic-nucleus";
          cosmicDecorations.push(nucleus);
        }
        const bulgeCount = 420;
        const bulgePositions = new Float32Array(bulgeCount * 3);
        const bulgeColors = new Float32Array(bulgeCount * 3);
        const bulgeTints = ["#fff1d6", "#ffe0b0", "#ffd9a8", "#f4f0ff"].map((color) => new three.Color(color));
        for (let index = 0; index < bulgeCount; index += 1) {
          const spread = Math.sqrt(-2 * Math.log(Math.max(1e-6, seededValue(`bulge-${index}`, 151)))) * 34;
          const theta = seededValue(`bulge-${index}`, 157) * Math.PI * 2;
          const phi = Math.acos(2 * seededValue(`bulge-${index}`, 163) - 1);
          bulgePositions[index * 3] = spread * Math.sin(phi) * Math.cos(theta);
          bulgePositions[index * 3 + 1] = spread * Math.cos(phi) * 0.62;
          bulgePositions[index * 3 + 2] = spread * Math.sin(phi) * Math.sin(theta);
          const tint = bulgeTints[index % bulgeTints.length];
          bulgeColors[index * 3] = tint.r;
          bulgeColors[index * 3 + 1] = tint.g;
          bulgeColors[index * 3 + 2] = tint.b;
        }
        const bulgeGeometry = new three.BufferGeometry();
        bulgeGeometry.setAttribute("position", new three.BufferAttribute(bulgePositions, 3));
        bulgeGeometry.setAttribute("color", new three.BufferAttribute(bulgeColors, 3));
        const galacticBulge = new three.Points(
          bulgeGeometry,
          new three.PointsMaterial({
            map: pointTexture,
            alphaTest: 0.01,
            size: 2.4,
            transparent: true,
            opacity: 0.5,
            vertexColors: true,
            depthWrite: false,
            blending: three.AdditiveBlending,
          }),
        );
        galacticBulge.rotation.x = 0.42;
        galacticBulge.rotation.z = -0.22;
        galacticBulge.name = "galactic-bulge";
        cosmicDecorations.push(galacticBulge);

        // Distant sky: fine unattenuated stars and a faint nebula sphere, far
        // outside the galaxy and exempt from fog so they read as background.
        const skyStarCount = 1400;
        const skyPositions = new Float32Array(skyStarCount * 3);
        const skyColors = new Float32Array(skyStarCount * 3);
        for (let index = 0; index < skyStarCount; index += 1) {
          const theta = seededValue(`sky-${index}`, 101) * Math.PI * 2;
          const phi = Math.acos(2 * seededValue(`sky-${index}`, 103) - 1);
          const radius = 3200 + seededValue(`sky-${index}`, 107) * 600;
          skyPositions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
          skyPositions[index * 3 + 1] = radius * Math.cos(phi);
          skyPositions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
          const tint = starTints[Math.floor(seededValue(`sky-${index}`, 109) * starTints.length)];
          const brightness = 0.35 + seededValue(`sky-${index}`, 113) ** 2 * 0.65;
          skyColors[index * 3] = tint.r * brightness;
          skyColors[index * 3 + 1] = tint.g * brightness;
          skyColors[index * 3 + 2] = tint.b * brightness;
        }
        const skyGeometry = new three.BufferGeometry();
        skyGeometry.setAttribute("position", new three.BufferAttribute(skyPositions, 3));
        skyGeometry.setAttribute("color", new three.BufferAttribute(skyColors, 3));
        const skyStars = new three.Points(
          skyGeometry,
          new three.PointsMaterial({
            map: pointTexture,
            alphaTest: 0.01,
            size: 1.8,
            sizeAttenuation: false,
            transparent: true,
            opacity: 0.85,
            vertexColors: true,
            depthWrite: false,
            fog: false,
            blending: three.AdditiveBlending,
          }),
        );
        skyStars.name = "sky-stars";
        cosmicDecorations.push(skyStars);

        const nebulaImage = nebulaCanvas();
        if (nebulaImage) {
          const nebulaTexture = new three.CanvasTexture(nebulaImage);
          nebulaTexture.colorSpace = three.SRGBColorSpace;
          const nebulaSky = new three.Mesh(
            new three.SphereGeometry(3900, 48, 24),
            new three.MeshBasicMaterial({
              map: nebulaTexture,
              side: three.BackSide,
              transparent: true,
              depthWrite: false,
              fog: false,
              blending: three.AdditiveBlending,
            }),
          );
          nebulaSky.rotation.set(0.42, 0.3, -0.36);
          nebulaSky.name = "nebula-sky";
          cosmicDecorations.push(nebulaSky);
        }

        // One batched glow per menu star, following the simulated positions.
        const menuNodes = graphData.nodes.filter((node) => node.kind === "menu");
        const menuGlowPositions = new Float32Array(menuNodes.length * 3);
        const menuGlowColors = new Float32Array(menuNodes.length * 3);
        const menuGlowTints = menuNodes.map((node) => new three.Color(node.color).lerp(new three.Color("#ffffff"), 0.2));
        const menuGlowRhythm = menuNodes.map((node) => ({
          speed: 0.55 + seededValue(node.id, 137) * 1.05,
          phase: seededValue(node.id, 139) * Math.PI * 2,
        }));
        const menuGlowGeometry = new three.BufferGeometry();
        const menuGlowPositionAttribute = new three.BufferAttribute(menuGlowPositions, 3);
        const menuGlowColorAttribute = new three.BufferAttribute(menuGlowColors, 3);
        menuGlowGeometry.setAttribute("position", menuGlowPositionAttribute);
        menuGlowGeometry.setAttribute("color", menuGlowColorAttribute);
        const menuGlow = new three.Points(
          menuGlowGeometry,
          new three.PointsMaterial({
            map: glowTexture,
            size: 54,
            transparent: true,
            opacity: 0.6,
            vertexColors: true,
            depthWrite: false,
            blending: three.AdditiveBlending,
          }),
        );
        menuGlow.name = "menu-star-glow";
        menuGlow.frustumCulled = false;
        menuGlow.renderOrder = -1;
        cosmicDecorations.push(menuGlow);
        // Decorative stars must never compete with actual menu hit targets.
        starField.raycast = () => {};
        for (const decoration of cosmicDecorations) {
          decoration.traverse((object) => { object.raycast = () => {}; });
        }
        graph.scene().add(...cosmicDecorations);
        graph.scene().fog = new three.FogExp2("#020208", FOG_DENSITY);

        const anomalyNode = graphData.nodes.find((node) => node.kind === "anomaly");
        const worldPosition = new three.Vector3();
        const projectedPosition = new three.Vector3();
        const categoryWorldPosition = new three.Vector3();
        const categoryProjectedPosition = new three.Vector3();
        const glowPosition = new three.Vector3();
        const cameraForward = new three.Vector3();
        const holeOffset = new three.Vector3();
        let twinkleClock = 0;
        let previousCosmicFrame = window.performance.now();
        const updateLensing = () => {
          if (disposed || document.hidden) { lensingAnimationFrame = null; return; }
          lensingAnimationFrame = window.requestAnimationFrame(updateLensing);
          const currentCosmicFrame = window.performance.now();
          const cosmicDelta = Math.min(0.05, Math.max(0, (currentCosmicFrame - previousCosmicFrame) / 1000));
          previousCosmicFrame = currentCosmicFrame;
          const cosmosMoving = !motionReduced && !pausedRef.current;
          if (cosmosMoving) {
            dust.rotation.y -= cosmicDelta * 0.012;
            spiralArms.rotation.y += cosmicDelta * 0.009;
            galacticBulge.rotation.y += cosmicDelta * 0.014;
            stellarFlares.rotation.z += cosmicDelta * 0.005;
            nebulaArcs.rotation.y -= cosmicDelta * 0.004;
            twinkleClock += cosmicDelta;
          }
          // Glows follow their stars; they twinkle only while the cosmos moves.
          for (let index = 0; index < menuNodes.length; index += 1) {
            const star = objectById.get(menuNodes[index].id);
            if (!star) continue;
            star.getWorldPosition(glowPosition);
            menuGlowPositions[index * 3] = glowPosition.x;
            menuGlowPositions[index * 3 + 1] = glowPosition.y;
            menuGlowPositions[index * 3 + 2] = glowPosition.z;
            const rhythm = menuGlowRhythm[index];
            const pulse = 0.8 + 0.2 * Math.sin(twinkleClock * rhythm.speed + rhythm.phase);
            const emphasis = menuNodes[index].id === selectedIdRef.current ? 1.45 : 1;
            const tint = menuGlowTints[index];
            menuGlowColors[index * 3] = tint.r * pulse * emphasis;
            menuGlowColors[index * 3 + 1] = tint.g * pulse * emphasis;
            menuGlowColors[index * 3 + 2] = tint.b * pulse * emphasis;
          }
          menuGlowPositionAttribute.needsUpdate = true;
          menuGlowColorAttribute.needsUpdate = true;
          const camera = graph.camera();
          const width = Math.max(1, container.clientWidth);
          const height = Math.max(1, container.clientHeight);
          const selectedCategory = graphData.nodes.find((node) => (
            node.id === selectedIdRef.current || node.easterEgg?.id === selectedIdRef.current
          ))?.category;
          const projectedLabels = graphData.nodes
            .filter((node) => node.kind === "category")
            .map((node) => {
              const hub = objectById.get(node.id);
              const label = hub?.getObjectByName("category-label");
              if (!hub || !label) return null;
              hub.updateWorldMatrix(true, false);
              label.getWorldPosition(categoryWorldPosition);
              const distance = Math.max(1, camera.position.distanceTo(categoryWorldPosition));
              const fov = "fov" in camera && typeof camera.fov === "number" ? camera.fov : 50;
              const labelHeight = width < 480 ? 22 : 23;
              const worldHeight = labelHeight * 2 * distance * Math.tan(three.MathUtils.degToRad(fov) / 2) / height;
              const labelAspect = Number(label.userData.labelAspect) || 3;
              label.scale.set(worldHeight * labelAspect, worldHeight, 1);
              categoryProjectedPosition.copy(categoryWorldPosition).project(camera);
              return {
                id: node.id,
                category: node.category,
                label,
                halfWidth: (labelHeight / 2) * labelAspect,
                distance,
                x: (categoryProjectedPosition.x * 0.5 + 0.5) * width,
                y: (-categoryProjectedPosition.y * 0.5 + 0.5) * height,
                visible: categoryProjectedPosition.z >= -1 && categoryProjectedPosition.z <= 1,
              };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .sort((left, right) => (
              Number(right.category === selectedCategory) - Number(left.category === selectedCategory)
              || left.distance - right.distance
              || left.id.localeCompare(right.id, "ko-KR")
            ));
          const visibleLabelPositions: Array<{ x: number; y: number; halfWidth: number }> = [];
          const verticalGap = width <= 480 ? 36 : 29;
          for (const item of projectedLabels) {
            const overlaps = visibleLabelPositions.some((position) => (
              Math.abs(position.x - item.x) < position.halfWidth + item.halfWidth + 8
              && Math.abs(position.y - item.y) < verticalGap
            ));
            item.label.visible = item.visible && item.x > item.halfWidth && item.x < width - item.halfWidth
              && item.y > 66 && item.y < height - 36 && !overlaps;
            if (item.label.visible) visibleLabelPositions.push({ x: item.x, y: item.y, halfWidth: item.halfWidth });
          }

          if (!anomalyNode || !lensingPass) return;
          const anomalyObject = objectById.get(anomalyNode.id);
          if (!anomalyObject) {
            lensingPass.enabled = false;
            return;
          }
          const facingGroup = anomalyObject.getObjectByName("gargantua-facing");
          if (facingGroup) facingGroup.quaternion.copy(camera.quaternion);
          anomalyObject.updateWorldMatrix(true, false);
          anomalyObject.getWorldPosition(worldPosition);
          projectedPosition.copy(worldPosition).project(camera);
          const aspect = width / height;
          const distance = Math.max(1, camera.position.distanceTo(worldPosition));
          const fieldOfView = "fov" in camera && typeof camera.fov === "number" ? camera.fov : 50;
          // Apparent shadow radius, as a fraction of the viewport height.
          const projectedRadius = anomalyNode.size
            / (2 * distance * Math.tan(three.MathUtils.degToRad(fieldOfView) / 2));
          // Keep the pass on while any part of the disk can still be on screen.
          const diskReach = projectedRadius * 3.6 * 2;
          const onScreen = projectedPosition.z > -1
            && projectedPosition.z < 1
            && Math.abs(projectedPosition.x) < 1.06 + diskReach / aspect
            && Math.abs(projectedPosition.y) < 1.06 + diskReach;
          lensingPass.enabled = onScreen && !lensingFailed;
          if (!lensingPass.enabled) return;
          const uniforms = lensingPass.uniforms;
          uniforms.lensCenter.value.set(
            projectedPosition.x * 0.5 + 0.5,
            projectedPosition.y * 0.5 + 0.5,
          );
          uniforms.aspect.value = aspect;
          // The bent-starlight halo stays local so labels elsewhere stay straight.
          const maximumLensRadius = width <= 480 ? 0.6 : width <= 760 ? 0.7 : 0.8;
          uniforms.shadowRadius.value = projectedRadius;
          uniforms.lensRadius.value = Math.max(projectedRadius * 3.9, Math.min(projectedRadius * 6, maximumLensRadius));
          uniforms.pixelsPerShadow.value = projectedRadius * height * graph.renderer().getPixelRatio();
          camera.getWorldDirection(cameraForward);
          uniforms.holeDepth.value = holeOffset.subVectors(worldPosition, camera.position).dot(cameraForward);
          uniforms.depthMargin.value = anomalyNode.size * 0.6;
          if ("near" in camera && typeof camera.near === "number") uniforms.cameraNear.value = camera.near;
          if ("far" in camera && typeof camera.far === "number") uniforms.cameraFar.value = camera.far;
          // Match the scene fog, a little lighter because the disk is emissive.
          uniforms.fogMix.value = (1 - Math.exp(-((FOG_DENSITY * distance) ** 2))) * 0.78;
          uniforms.selectionMix.value = anomalyObject.getObjectByName("selection-ring")?.visible ? 1 : 0;
          if (cosmosMoving) uniforms.diskTime.value += cosmicDelta * 2.3;
        };
        handleVisibilityChange = () => {
          if (document.hidden) {
            graph.pauseAnimation();
            if (lensingAnimationFrame !== null) window.cancelAnimationFrame(lensingAnimationFrame);
            lensingAnimationFrame = null;
          } else {
            graph.resumeAnimation();
            previousCosmicFrame = window.performance.now();
            if (lensingAnimationFrame === null) lensingAnimationFrame = window.requestAnimationFrame(updateLensing);
          }
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);
        handleVisibilityChange();
        if (anomalyNode?.easterEgg?.id === selectedIdRef.current) {
          focusGraphNode(graph, anomalyNode, focusDistanceForViewport("anomaly", container.clientWidth), motionReduced ? 0 : 900);
        }

        canvas = graph.renderer().domElement;
        canvas.addEventListener("webglcontextlost", handleContextLost, false);

        resizeObserver = new ResizeObserver(([entry]) => {
          const width = Math.max(1, Math.round(entry.contentRect.width));
          const height = Math.max(1, Math.round(entry.contentRect.height));
          graph.width(width).height(height);
          bloomPass?.setSize(width, height);
          if (lensingPass) lensingPass.uniforms.aspect.value = width / height;
          const nextCameraDistance = cameraDistanceForViewport(width, height);
          if (nextCameraDistance !== appliedCameraDistance) {
            appliedCameraDistance = nextCameraDistance;
            graph.cameraPosition({ x: 0, y: 24, z: nextCameraDistance }, { x: 0, y: 0, z: 0 }, motionReduced ? 0 : 420);
          }
          const nextLabelHeight = categoryLabelHeight(width);
          for (const category of taxonomy) {
            const label = objectById
              .get(`category:${category.id}`)
              ?.getObjectByName("category-label") as (Object3D & { textHeight?: number }) | undefined;
            if (label && label.textHeight !== nextLabelHeight) {
              label.textHeight = nextLabelHeight;
              label.userData.labelAspect = label.scale.x / label.scale.y;
            }
          }
        });
        resizeObserver.observe(container);
        setStatus("ready");
      } catch (error) {
        console.error("Menu cosmos initialization failed", error);
        if (!disposed) setStatus("fallback");
      }
    }

    void mountGraph();
    return () => {
      disposed = true;
      if (lensingAnimationFrame !== null) window.cancelAnimationFrame(lensingAnimationFrame);
      resizeObserver?.disconnect();
      if (handleVisibilityChange) document.removeEventListener("visibilitychange", handleVisibilityChange);
      canvas?.removeEventListener("webglcontextlost", handleContextLost, false);
      if (starField) {
        graphRef.current?.scene().remove(starField);
        disposeObject(starField);
      }
      for (const decoration of cosmicDecorations) {
        graphRef.current?.scene().remove(decoration);
        disposeObject(decoration);
      }
      if (graphRef.current) graphRef.current.scene().fog = null;
      if (graphRef.current) graphRef.current.renderer().debug.onShaderError = null;
      lensingPass?.dispose?.();
      for (const depthTexture of depthTextures) depthTexture.dispose();
      bloomPass?.dispose?.();
      graphRef.current?._destructor();
      for (const object of objectById.values()) disposeObject(object);
      objectById.clear();
      graphRef.current = null;
      container.replaceChildren();
    };
  }, [graphData, menus, reducedMotion, taxonomy]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    for (const [id, object] of objectByIdRef.current) {
      const ring = object.getObjectByName("selection-ring");
      const selectionId = typeof object.userData.selectionId === "string" ? object.userData.selectionId : id;
      if (ring) ring.visible = selectionId === selectedId;
    }
    const graph = graphRef.current;
    graph?.refresh();
    const selectedAnomaly = graphData.nodes.find((node) => node.kind === "anomaly" && node.easterEgg?.id === selectedId);
    if (graph && selectedAnomaly) {
      const width = containerRef.current?.clientWidth ?? 1024;
      focusGraphNode(graph, selectedAnomaly, focusDistanceForViewport("anomaly", width), reducedMotion === false ? 900 : 0);
    }
  }, [graphData.nodes, reducedMotion, selectedId]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onSelectEasterEggRef.current = onSelectEasterEgg;
  }, [onSelectEasterEgg]);

  useEffect(() => {
    pausedRef.current = paused;
    const graph = graphRef.current;
    if (!graph) return;
    const controls = graph.controls() as OrbitControlsLike;
    controls.autoRotate = !paused && reducedMotion === false;
    graph.refresh();
  }, [paused, reducedMotion]);

  return (
    <section className="menu-cosmos" id="cosmos-stage" aria-label="3차원 메뉴 코스모스" aria-describedby="cosmos-accessibility-note">
      <div ref={containerRef} className="menu-cosmos__canvas" aria-hidden="true" />
      <div className="menu-cosmos__atmosphere" aria-hidden="true"><i /><i /><i /></div>
      <p className="sr-only" id="cosmos-accessibility-note">
        3차원 시각화는 드래그와 확대 축소로 탐색합니다. 키보드 탐색은 취향 지도의 목록 모드를 이용하세요. 동작 줄이기 설정에서는 자동 회전을 사용하지 않습니다.
      </p>
      {status === "loading" && (
        <div className="cosmos-state">
          <span className="cosmos-loader" />
          <strong>별자리를 계산하고 있습니다</strong>
          <small>{menus.length}개의 메뉴 궤도 정렬 중</small>
        </div>
      )}
      {status === "fallback" && (
        <div className="cosmos-state cosmos-state--fallback">
          <span>✦</span>
          <strong>이 환경에서는 WebGL 우주를 열 수 없습니다</strong>
          <small>상단의 취향 지도로 동일한 메뉴를 탐색할 수 있습니다.</small>
        </div>
      )}
      <div className="cosmos-navigation-hint" aria-hidden="true">드래그로 회전 · 휠로 확대 · 별을 눌러 상세 보기</div>
    </section>
  );
}
