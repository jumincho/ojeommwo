"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ForceGraph3DInstance, LinkObject, NodeObject } from "3d-force-graph";
import type { Object3D } from "three";
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
  };
  dispose?: () => void;
};

function seededValue(value: string, salt: number) {
  let hash = 2166136261 ^ salt;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
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
  if (kind === "anomaly") return width <= 480 ? 310 : width <= 760 ? 255 : width <= 1100 ? 215 : 190;
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
                  emissiveIntensity: 0.5,
                  roughness: 0.32,
                  metalness: 0.2,
                  flatShading: true,
                }),
              );
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
                new three.TorusGeometry(14.5, 0.42, 8, 48),
                new three.MeshBasicMaterial({
                  color: node.color,
                  transparent: true,
                  opacity: 0.48,
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
              for (const ornament of [halo, core, orbitA, orbitB]) ornament.raycast = () => {};
              hub.add(halo, core, orbitA, orbitB, sprite);
              objectById.set(node.id, hub);
              return hub;
            }

            if (node.kind === "anomaly") {
              const anomaly = new three.Group();
              anomaly.userData.selectionId = node.easterEgg?.id;
              const horizon = new three.Mesh(
                new three.SphereGeometry(node.size, 40, 40),
                new three.MeshBasicMaterial({ color: "#000000" }),
              );
              horizon.renderOrder = 4;

              const gravitationalHalo = new three.Mesh(
                new three.SphereGeometry(node.size * 1.48, 32, 32),
                new three.MeshBasicMaterial({
                  color: "#ffb84d",
                  transparent: true,
                  opacity: 0.07,
                  depthWrite: false,
                  side: three.BackSide,
                  blending: three.AdditiveBlending,
                }),
              );

              const facingGroup = new three.Group();
              facingGroup.name = "gargantua-facing";
              const accretionDisk = new three.Group();
              accretionDisk.name = "accretion-disk";
              const diskPalette = [
                { color: "#fff8dc", opacity: 0.5, radius: 1.46, tube: 0.075 },
                { color: "#ffe19a", opacity: 0.38, radius: 1.62, tube: 0.095 },
                { color: "#ffb24a", opacity: 0.27, radius: 1.82, tube: 0.12 },
                { color: "#ff7a2f", opacity: 0.17, radius: 2.08, tube: 0.15 },
                { color: "#e94b24", opacity: 0.09, radius: 2.4, tube: 0.18 },
              ];
              for (const layer of diskPalette) {
                const diskLayer = new three.Mesh(
                  new three.TorusGeometry(node.size * layer.radius, node.size * layer.tube, 10, 112),
                  new three.MeshBasicMaterial({
                    color: layer.color,
                    transparent: true,
                    opacity: layer.opacity,
                    depthWrite: false,
                    blending: three.AdditiveBlending,
                  }),
                );
                accretionDisk.add(diskLayer);
              }
              accretionDisk.rotation.x = 1.31;
              accretionDisk.rotation.z = -0.1;

              const photonRing = new three.Mesh(
                new three.TorusGeometry(node.size * 1.12, node.size * 0.055, 10, 112),
                new three.MeshBasicMaterial({
                  color: "#fff5c4",
                  transparent: true,
                  opacity: 0.52,
                  depthWrite: false,
                  blending: three.AdditiveBlending,
                }),
              );

              const buildLensedArc = (
                direction: 1 | -1,
                radiusScale: number,
                color: string,
                opacity: number,
                tubeScale: number,
              ) => {
                const points = Array.from({ length: 49 }, (_, index) => {
                  const progress = index / 48;
                  const angle = Math.PI * (0.07 + progress * 0.86);
                  return new three.Vector3(
                    Math.cos(angle) * node.size * radiusScale * 1.55,
                    direction * Math.sin(angle) * node.size * radiusScale,
                    -node.size * 0.08,
                  );
                });
                return new three.Mesh(
                  new three.TubeGeometry(new three.CatmullRomCurve3(points), 72, node.size * tubeScale, 7, false),
                  new three.MeshBasicMaterial({
                    color,
                    transparent: true,
                    opacity,
                    depthWrite: false,
                    blending: three.AdditiveBlending,
                  }),
                );
              };

              const upperLensingArc = buildLensedArc(1, 1.42, "#fff3c4", 0.44, 0.055);
              const lowerLensingArc = buildLensedArc(-1, 1.34, "#ffc466", 0.32, 0.05);
              const upperEcho = buildLensedArc(1, 1.62, "#ff8b36", 0.1, 0.04);
              const lowerEcho = buildLensedArc(-1, 1.56, "#ff6b2d", 0.07, 0.035);

              const selectionRing = new three.Mesh(
                new three.TorusGeometry(node.size * 2.82, node.size * 0.045, 8, 96),
                new three.MeshBasicMaterial({
                  color: "#ffe7a1",
                  transparent: true,
                  opacity: 0.2,
                  depthWrite: false,
                  blending: three.AdditiveBlending,
                }),
              );
              selectionRing.name = "selection-ring";
              selectionRing.visible = node.easterEgg?.id === selectedIdRef.current;

              facingGroup.add(
                accretionDisk,
                photonRing,
                upperLensingArc,
                lowerLensingArc,
                upperEcho,
                lowerEcho,
                selectionRing,
              );
              anomaly.add(gravitationalHalo, facingGroup, horizon);
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

        const lensing = new shaderPassModule.ShaderPass({
          uniforms: {
            tDiffuse: { value: null },
            lensCenter: { value: new three.Vector2(-2, -2) },
            lensRadius: { value: 0.08 },
            lensStrength: { value: 0.56 },
            aspect: { value: Math.max(1, container.clientWidth / Math.max(1, container.clientHeight)) },
          },
          vertexShader: `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform sampler2D tDiffuse;
            uniform vec2 lensCenter;
            uniform float lensRadius;
            uniform float lensStrength;
            uniform float aspect;
            varying vec2 vUv;

            void main() {
              vec2 metric = vec2((vUv.x - lensCenter.x) * aspect, vUv.y - lensCenter.y);
              float distanceToLens = length(metric);
              float outerMask = 1.0 - smoothstep(lensRadius * 0.82, lensRadius, distanceToLens);
              float horizonMask = smoothstep(lensRadius * 0.18, lensRadius * 0.34, distanceToLens);
              float photonRing = exp(-pow((distanceToLens - lensRadius * 0.48) / max(lensRadius * 0.11, 0.0001), 2.0));
              float deflection = lensRadius * (0.12 / max(distanceToLens / lensRadius, 0.22));
              deflection *= outerMask * horizonMask * lensStrength;
              vec2 direction = metric / max(distanceToLens, 0.0001);
              vec2 warpedMetric = metric + direction * deflection;
              vec2 warpedUv = lensCenter + vec2(warpedMetric.x / aspect, warpedMetric.y);
              warpedUv = clamp(warpedUv, vec2(0.001), vec2(0.999));
              vec2 chromaShift = vec2(direction.x / aspect, direction.y) * photonRing * 0.0018 * lensStrength;
              vec4 base = texture2D(tDiffuse, warpedUv);
              float red = texture2D(tDiffuse, clamp(warpedUv + chromaShift, 0.001, 0.999)).r;
              float blue = texture2D(tDiffuse, clamp(warpedUv - chromaShift, 0.001, 0.999)).b;
              vec3 lensed = vec3(red, base.g, blue) + vec3(1.0, 0.58, 0.18) * photonRing * 0.025;
              float eventHorizonMask = 1.0 - smoothstep(lensRadius * 0.22, lensRadius * 0.31, distanceToLens);
              vec3 finalLensed = mix(lensed, vec3(0.0), eventHorizonMask);
              float lensMask = step(distanceToLens, lensRadius);
              gl_FragColor = mix(texture2D(tDiffuse, vUv), vec4(finalLensed, base.a), lensMask);
            }
          `,
        }) as unknown as LensingPassLike;
        lensing.enabled = false;
        lensingPass = lensing;
        graph.postProcessingComposer().addPass(lensing as never);

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
        const stars = 1080;
        const starPositions = new Float32Array(stars * 3);
        for (let index = 0; index < stars; index += 1) {
          const radius = 280 + seededValue(`star-${index}`, 5) * 620;
          const theta = seededValue(`star-${index}`, 7) * Math.PI * 2;
          const phi = Math.acos(2 * seededValue(`star-${index}`, 13) - 1);
          starPositions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
          starPositions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
          starPositions[index * 3 + 2] = radius * Math.cos(phi);
        }
        const starGeometry = new three.BufferGeometry();
        starGeometry.setAttribute("position", new three.BufferAttribute(starPositions, 3));
        const starMaterial = new three.PointsMaterial({
            map: pointTexture,
            alphaTest: 0.01,
          color: "#c7ddff",
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
        // Decorative stars must never compete with actual menu hit targets.
        starField.raycast = () => {};
        for (const decoration of cosmicDecorations) {
          decoration.traverse((object) => { object.raycast = () => {}; });
        }
        graph.scene().add(...cosmicDecorations);
        graph.scene().fog = new three.FogExp2("#020208", 0.00072);

        const anomalyNode = graphData.nodes.find((node) => node.kind === "anomaly");
        const worldPosition = new three.Vector3();
        const projectedPosition = new three.Vector3();
        const categoryWorldPosition = new three.Vector3();
        const categoryProjectedPosition = new three.Vector3();
        let previousCosmicFrame = window.performance.now();
        const updateLensing = () => {
          if (disposed || document.hidden) { lensingAnimationFrame = null; return; }
          lensingAnimationFrame = window.requestAnimationFrame(updateLensing);
          const currentCosmicFrame = window.performance.now();
          const cosmicDelta = Math.min(0.05, Math.max(0, (currentCosmicFrame - previousCosmicFrame) / 1000));
          previousCosmicFrame = currentCosmicFrame;
          if (!motionReduced && !pausedRef.current) {
            dust.rotation.y -= cosmicDelta * 0.012;
            spiralArms.rotation.y += cosmicDelta * 0.009;
            stellarFlares.rotation.z += cosmicDelta * 0.005;
            nebulaArcs.rotation.y -= cosmicDelta * 0.004;
          }
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
          const onScreen = projectedPosition.z > -1
            && projectedPosition.z < 1
            && Math.abs(projectedPosition.x) < 1.18
            && Math.abs(projectedPosition.y) < 1.18;
          lensingPass.enabled = onScreen;
          if (!onScreen) return;
          const aspect = width / height;
          const distance = Math.max(1, camera.position.distanceTo(worldPosition));
          const fieldOfView = "fov" in camera && typeof camera.fov === "number" ? camera.fov : 50;
          const projectedRadius = anomalyNode.size
            / (2 * distance * Math.tan(three.MathUtils.degToRad(fieldOfView) / 2));
          lensingPass.uniforms.lensCenter.value.set(
            projectedPosition.x * 0.5 + 0.5,
            projectedPosition.y * 0.5 + 0.5,
          );
          lensingPass.uniforms.aspect.value = aspect;
          const maximumLensRadius = width <= 480 ? 0.11 : width <= 760 ? 0.14 : 0.18;
          lensingPass.uniforms.lensRadius.value = three.MathUtils.clamp(projectedRadius * 3.1, 0.04, maximumLensRadius);
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
      lensingPass?.dispose?.();
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
