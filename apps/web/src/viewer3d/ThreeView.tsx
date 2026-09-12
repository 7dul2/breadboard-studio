import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { analysisOf, useStore } from '../store';
import { buildScene3D, type Scene3D } from './scene3d';

/**
 * 「3D 预览」：用 three.js 把同一份 DesignModel 渲染成实体。
 *
 * 和 2D 画布的分工：SVG 那套继续负责编辑（命中测试、拖动、仿真覆盖层、SVG/PNG 导出），
 * 这一层只读地展示"长什么样、线从哪过、谁比谁高"。几何全部由 scene3d.ts 从设计数据
 * 自动生成，没有给任何元件手搓模型。
 *
 * 相机交给 OrbitControls —— 俯视、仰视、环绕、缩放都是它现成的，不用自己写。
 */
type ViewPreset = 'iso' | 'top' | 'front';

const PRESETS: { id: ViewPreset; label: string; title: string }[] = [
  { id: 'iso', label: '等轴测', title: '斜着看：能同时看出高度和平面位置' },
  { id: 'top', label: '正俯视', title: '从正上方看，和 2D 画布的布局一致' },
  { id: 'front', label: '正侧视', title: '从侧前方看，高度差最明显' }
];

export default function ThreeView() {
  const design = useStore((s) => s.design);
  const scene = useMemo(() => buildScene3D(analysisOf(design).model), [design]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const viewRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const fitRef = useRef({ center: new THREE.Vector3(), radius: 100 });
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [preset, setPreset] = useState<ViewPreset>('iso');

  const draw = useCallback(() => {
    const renderer = rendererRef.current;
    const view = viewRef.current;
    const camera = cameraRef.current;
    if (renderer && view && camera) renderer.render(view, camera);
  }, []);

  const applyPreset = useCallback(
    (p: ViewPreset) => {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls) return;
      const { center, radius } = fitRef.current;
      // 用包围球半径算距离：不管视口宽高比怎么变都能把整个设计框进来
      const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.12;
      const dir: Record<ViewPreset, [number, number, number]> = {
        iso: [0.55, 0.6, 0.66],
        top: [0, 1, 0.0001],
        front: [0, 0.24, 1]
      };
      const [ux, uy, uz] = dir[p];
      const len = Math.hypot(ux, uy, uz);
      camera.position.set(center.x + (ux / len) * dist, center.y + (uy / len) * dist, center.z + (uz / len) * dist);
      controls.target.copy(center);
      controls.update();
      setPreset(p);
      draw();
    },
    [draw]
  );

  // 渲染器 / 光照 / 控制器：只建一次
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      setError(`这个环境起不了 WebGL：${(e as Error).message}`);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor('#eef0f4');
    host.appendChild(renderer.domElement);

    const view = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // 不让镜头钻到板子底下

    view.add(new THREE.HemisphereLight(0xffffff, 0x59606e, 1.1));
    view.add(new THREE.AmbientLight(0xffffff, 0.22));
    const sun = new THREE.DirectionalLight(0xffffff, 1.75);
    sun.position.set(90, 170, 70);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    view.add(sun);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.16 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    view.add(ground);

    const content = new THREE.Group();
    view.add(content);

    rendererRef.current = renderer;
    viewRef.current = view;
    cameraRef.current = camera;
    controlsRef.current = controls;
    contentRef.current = content;

    controls.addEventListener('change', draw);
    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // 点一下选中对应对象（和 2D 画布共用同一份选中状态）
    const pick = (ev: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1),
        camera
      );
      for (const hit of ray.intersectObjects(content.children, false)) {
        const id = (hit.object.userData as { id?: string }).id;
        if (id) {
          useStore.getState().select([id]);
          return;
        }
      }
    };
    renderer.domElement.addEventListener('click', pick);

    setReady(true);
    return () => {
      renderer.domElement.removeEventListener('click', pick);
      ro.disconnect();
      controls.removeEventListener('change', draw);
      controls.dispose();
      disposeGroup(content);
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      viewRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      contentRef.current = null;
      setReady(false);
    };
  }, [draw]);

  // 内容：几何清单变了就重建，并把取景对上去
  useEffect(() => {
    const content = contentRef.current;
    const ground = viewRef.current?.children.find((c) => c instanceof THREE.Mesh && (c as THREE.Mesh).material instanceof THREE.ShadowMaterial) as THREE.Mesh | undefined;
    if (!content || !ready) return;
    disposeGroup(content);
    buildMeshes(scene, content);

    const center = new THREE.Vector3(
      (scene.bounds.min[0] + scene.bounds.max[0]) / 2,
      (scene.bounds.min[1] + scene.bounds.max[1]) / 2,
      (scene.bounds.min[2] + scene.bounds.max[2]) / 2
    );
    const radius = Math.hypot(
      (scene.bounds.max[0] - scene.bounds.min[0]) / 2,
      (scene.bounds.max[1] - scene.bounds.min[1]) / 2,
      (scene.bounds.max[2] - scene.bounds.min[2]) / 2,
      20
    );
    fitRef.current = { center, radius };
    const sun = viewRef.current?.children.find((c) => c instanceof THREE.DirectionalLight) as THREE.DirectionalLight | undefined;
    if (sun) {
      sun.position.set(center.x + radius * 0.6, radius * 1.4, center.z + radius * 0.5);
      sun.target.position.copy(center);
      sun.target.updateMatrixWorld();
      const cam = sun.shadow.camera;
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 1;
      cam.far = radius * 6;
      cam.updateProjectionMatrix();
    }
    if (ground) {
      ground.position.set(center.x, -8.5 - 0.05, center.z);
      ground.scale.set(radius * 4, radius * 4, 1);
    }
    applyPreset('iso');
    (window as unknown as { __bbs3d?: unknown }).__bbs3d = { ready: true, stats: scene.stats, bounds: scene.bounds, objects: content.children.length };
  }, [scene, ready, applyPreset]);

  if (error) {
    return (
      <div className="three-view" data-testid="three-view" data-webgl="fallback">
        <p className="muted" style={{ padding: 16 }}>{error}</p>
      </div>
    );
  }

  return (
    <div className="three-view" data-testid="three-view" data-webgl={ready ? 'ok' : 'loading'}>
      <div className="three-host" ref={hostRef} />
      <div className="three-hud">
        <div className="three-presets" role="group" aria-label="视角">
          {PRESETS.map((p) => (
            <button key={p.id} className={preset === p.id ? 'active' : ''} title={p.title} onClick={() => applyPreset(p.id)} data-testid={`three-${p.id}`}>
              {p.label}
            </button>
          ))}
        </div>
        <span className="muted small">
          拖动=环绕 · 滚轮=缩放 · 右键拖动=平移 · 点元件=选中
        </span>
        <span className="muted small" data-testid="three-stats">
          板 {scene.stats.boards} · 元件 {scene.stats.components} · 线 {scene.stats.wires} · 孔 {scene.stats.holes} · 针 {scene.stats.pins}
        </span>
      </div>
    </div>
  );
}

/** 几何清单 → three 的 Mesh。 */
function buildMeshes(scene: Scene3D, group: THREE.Group): void {
  for (const p of scene.prims) {
    if (p.kind === 'box') {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]),
        new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.72, metalness: 0.06, transparent: p.opacity !== undefined, opacity: p.opacity ?? 1 })
      );
      mesh.position.set(p.center[0], p.center[1], p.center[2]);
      mesh.rotation.y = p.rotateY;
      mesh.castShadow = p.group === 'component' || p.group === 'art';
      mesh.receiveShadow = p.group === 'board' || p.group === 'ravine';
      setOwner(mesh, p.key);
      group.add(mesh);
    } else {
      // 导线用现成的曲线 + 管：CatmullRomCurve3 会自己把折线圆滑掉
      const curve = new THREE.CatmullRomCurve3(p.points.map((q) => new THREE.Vector3(q[0], q[1], q[2])));
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.max(16, p.points.length * 6), p.radius, 8, false),
        new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.5, metalness: 0.05 })
      );
      mesh.castShadow = true;
      setOwner(mesh, p.key);
      group.add(mesh);
    }
  }
  // 孔：几百上千个，用一个 InstancedMesh
  if (scene.holes.length) {
    const r = scene.holes[0]!.r;
    const inst = new THREE.InstancedMesh(new THREE.CylinderGeometry(r, r, 3, 10), new THREE.MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.95 }), scene.holes.length);
    const m = new THREE.Matrix4();
    scene.holes.forEach((h, i) => inst.setMatrixAt(i, m.makeTranslation(h.x, -1.45, h.z)));
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }
  // 排针：按颜色分组，各自一个 InstancedMesh
  const byColor = new Map<string, typeof scene.pins>();
  for (const pin of scene.pins) byColor.set(pin.color, [...(byColor.get(pin.color) ?? []), pin]);
  for (const [color, list] of byColor) {
    const first = list[0]!;
    const inst = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(first.r, first.r, first.h, 8),
      new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.65 }),
      list.length
    );
    const m = new THREE.Matrix4();
    list.forEach((pin, i) => inst.setMatrixAt(i, m.makeTranslation(pin.x, pin.h / 2, pin.z)));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    group.add(inst);
  }
}

/** key 形如 `wire:w1` / `component:mcu` —— 取出后面的对象 id 供点选。 */
function setOwner(mesh: THREE.Mesh, key: string): void {
  const id = key.split(':')[1];
  if (id) mesh.userData.id = id;
}

function disposeGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  }
}
