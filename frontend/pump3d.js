import * as THREE from "./vendor/three/three.module.js";
import { OrbitControls } from "./vendor/three/addons/controls/OrbitControls.js";

const host = document.querySelector("#pump-viewer");
const canvas = document.querySelector("#pump-canvas");
const status = document.querySelector("#viewer-status");

try {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 100);
  camera.position.set(-6.5, 3.4, 8.5);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  controls.autoRotateSpeed = 0.6;
  controls.minDistance = 5;
  controls.maxDistance = 14;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.update();
  controls.saveState();

  scene.add(new THREE.HemisphereLight(0xe5f3ff, 0x294047, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.position.set(-4, 7, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x66b3ff, 1.8);
  rim.position.set(3, 2, -5);
  scene.add(rim);
  const fill = new THREE.PointLight(0xffffff, 0.8);
  fill.position.set(0, -2, 5);
  scene.add(fill);

  const materials = {
    blue: new THREE.MeshStandardMaterial({ color: 0x0756c7, metalness: 0.42, roughness: 0.29 }),
    blueLight: new THREE.MeshStandardMaterial({ color: 0x1681ec, metalness: 0.34, roughness: 0.26 }),
    blueDark: new THREE.MeshStandardMaterial({ color: 0x06377f, metalness: 0.48, roughness: 0.3 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xb9c8d0, metalness: 0.82, roughness: 0.23 }),
    steelDark: new THREE.MeshStandardMaterial({ color: 0x566873, metalness: 0.74, roughness: 0.3 }),
    case: new THREE.MeshPhysicalMaterial({ color: 0x0756c7, metalness: 0.25, roughness: 0.28, transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide }),
    rotor: new THREE.MeshStandardMaterial({ color: 0x35a9c9, metalness: 0.7, roughness: 0.22 }),
  };
  const pump = new THREE.Group();
  pump.scale.setScalar(0.92);
  pump.rotation.y = -0.08;
  scene.add(pump);

  const zones = {};
  function makePart(zone) {
    const group = new THREE.Group();
    group.userData.zone = zone;
    zones[zone] = group;
    pump.add(group);
    return group;
  }
  const motor = makePart("motor");
  const mancal = makePart("mancal");
  const rotor = makePart("rotor");
  const impulsor = makePart("impulsor");
  function addMesh(group, geometry, material, position, rotation) {
    const mesh = new THREE.Mesh(geometry, material);
    if (position) mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.zone = group.userData.zone;
    group.add(mesh);
    return mesh;
  }
  function cylinderX(group, radiusA, radiusB, length, x, material, radialSegments = 48) {
    return addMesh(group, new THREE.CylinderGeometry(radiusA, radiusB, length, radialSegments, 1), material,
      [x, 0, 0], [0, 0, Math.PI / 2]);
  }
  function ringX(group, x, radius, tube, material) {
    return addMesh(group, new THREE.TorusGeometry(radius, tube, 12, 64), material,
      [x, 0, 0], [0, Math.PI / 2, 0]);
  }
  function box(group, dims, pos, material, bevel = false) {
    const geometry = new THREE.BoxGeometry(...dims);
    const mesh = addMesh(group, geometry, material, pos);
    if (bevel) mesh.geometry = new THREE.BoxGeometry(...dims);
    return mesh;
  }

  // Carcaça hidráulica: forma fechada e flange frontal, com corte translúcido para revelar o rotor.
  const casing = new THREE.Group();
  pump.add(casing);
  const casingShell = addMesh(casing, new THREE.SphereGeometry(1, 56, 36), materials.case, [-1.72, 0, 0]);
  casingShell.scale.set(1.2, 0.97, 0.97);
  casingShell.raycast = () => {};
  cylinderX(casing, 0.73, 0.92, 0.62, -2.42, materials.blueDark);
  cylinderX(casing, 0.98, 0.98, 0.18, -2.76, materials.blue);
  ringX(casing, -2.88, 0.97, 0.12, materials.steel);
  ringX(casing, -2.90, 0.67, 0.045, materials.blueLight);
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const bolt = addMesh(casing, new THREE.CylinderGeometry(0.055, 0.055, 0.13, 12), materials.steel,
      [-2.91, Math.cos(angle) * 0.82, Math.sin(angle) * 0.82], [0, 0, Math.PI / 2]);
    bolt.rotation.set(0, Math.PI / 2, 0);
  }

  // Eixo e impulsor interno, visíveis pela carcaça translúcida.
  cylinderX(rotor, 0.13, 0.13, 4.25, -0.02, materials.steelDark, 32);
  cylinderX(rotor, 0.24, 0.24, 0.18, 0.25, materials.steel, 32);
  addMesh(rotor, new THREE.SphereGeometry(0.21, 32, 24), materials.steel, [1.96, 0, 0]);
  addMesh(impulsor, new THREE.CylinderGeometry(0.48, 0.48, 0.14, 48), materials.rotor,
    [-1.92, 0, 0], [0, 0, Math.PI / 2]);
  for (let i = 0; i < 7; i++) {
    const bladePivot = new THREE.Group();
    bladePivot.userData.zone = "impulsor";
    bladePivot.rotation.x = (i / 7) * Math.PI * 2;
    impulsor.add(bladePivot);
    box(bladePivot, [0.09, 0.44, 0.11], [-1.92, 0.22, 0], materials.rotor);
  }

  // Mancal e grade de proteção entre hidráulica e motor.
  cylinderX(mancal, 0.47, 0.47, 0.18, -0.68, materials.steelDark, 48);
  ringX(mancal, -0.79, 0.47, 0.075, materials.steel);
  ringX(mancal, -0.50, 0.54, 0.05, materials.blueLight);
  cylinderX(mancal, 0.58, 0.58, 0.06, -0.18, materials.blueDark, 48);
  ringX(mancal, -0.14, 0.58, 0.05, materials.steel);
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const bar = box(mancal, [0.92, 0.045, 0.045], [-0.42, Math.cos(angle) * 0.56, Math.sin(angle) * 0.56], materials.steelDark);
    bar.rotation.x = angle;
  }

  // Motor elétrico com aletas, tampas metálicas e caixa de ligação.
  cylinderX(motor, 0.75, 0.75, 3.18, 1.43, materials.blue);
  cylinderX(motor, 0.79, 0.75, 0.25, -0.15, materials.blueDark);
  cylinderX(motor, 0.78, 0.68, 0.3, 3.18, materials.blueLight);
  cylinderX(motor, 0.64, 0.64, 0.1, 3.36, materials.steelDark);
  ringX(motor, -0.01, 0.77, 0.055, materials.steel);
  ringX(motor, 3.06, 0.76, 0.045, materials.blueDark);
  for (let i = 0; i < 13; i++) ringX(motor, 0.1 + i * 0.22, 0.755, 0.035, i % 3 === 0 ? materials.blueLight : materials.blueDark);
  box(motor, [0.92, 0.28, 0.54], [2.42, -0.84, 0], materials.steelDark);
  box(motor, [0.79, 0.07, 0.47], [2.42, -0.68, 0], materials.steel);
  box(motor, [1.05, 0.12, 1.75], [1.47, -0.82, 0], materials.blueDark);
  box(motor, [0.82, 0.09, 1.45], [1.47, -0.72, 0], materials.steel);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(4.5, 64), new THREE.ShadowMaterial({ opacity: 0.18 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.04;
  floor.receiveShadow = true;
  scene.add(floor);

  const baseMaterials = new Map();
  for (const group of Object.values(zones)) {
    group.traverse(object => {
      if (!object.isMesh) return;
      object.userData.baseMaterial = object.material;
      baseMaterials.set(object, object.material);
    });
  }
  const labelFor = { motor: "Motor elétrico", mancal: "Mancal", rotor: "Rotor", impulsor: "Impulsor" };
  const active = new Set();
  let hovered = null;
  function repaintZones() {
    for (const [object, original] of baseMaterials) {
      const zone = object.userData.zone;
      const isActive = active.has(zone);
      const isHovered = hovered === zone;
      if (!isActive && !isHovered) {
        object.material = original;
        continue;
      }
      if (!object.userData.highlightMaterial) {
        object.userData.highlightMaterial = original.clone();
        if (object.userData.highlightMaterial.emissive) object.userData.highlightMaterial.emissive.set(0x6b1010);
      }
      const highlighted = object.userData.highlightMaterial;
      if (highlighted.emissive) highlighted.emissive.set(isActive ? 0x9d0808 : 0x0b5669);
      object.material = highlighted;
    }
  }
  window.addEventListener("pump-health-updated", event => {
    active.clear();
    for (const alert of event.detail || []) if (zones[alert.zona]) active.add(alert.zona);
    repaintZones();
  });
  active.clear();
  for (const alert of window.pumpHealthAlerts || []) if (zones[alert.zona]) active.add(alert.zona);
  repaintZones();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  canvas.addEventListener("pointermove", event => {
    const bounds = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pump.children, true).find(item => item.object.userData.zone);
    const next = hit?.object.userData.zone || null;
    if (next !== hovered) {
      hovered = next;
      repaintZones();
      status.textContent = hovered ? "Região em foco: " + labelFor[hovered] + (active.has(hovered) ? " · aviso ativo" : "") : "Arraste para girar · role para aproximar · passe sobre uma peça para identificá-la";
    }
  });
  canvas.addEventListener("pointerleave", () => { hovered = null; repaintZones(); });

  const autoButton = document.querySelector("#view-auto");
  autoButton.textContent = controls.autoRotate ? "Pausar giro" : "Girar devagar";
  autoButton.setAttribute("aria-pressed", String(controls.autoRotate));
  document.querySelector("#view-reset").addEventListener("click", () => controls.reset());
  document.querySelector("#view-front").addEventListener("click", () => {
    camera.position.set(-7.8, 1.3, 0.2);
    controls.target.set(0, 0, 0);
    controls.update();
  });
  autoButton.addEventListener("click", () => {
    controls.autoRotate = !controls.autoRotate;
    autoButton.textContent = controls.autoRotate ? "Pausar giro" : "Retomar giro";
    autoButton.setAttribute("aria-pressed", String(controls.autoRotate));
  });
  const resize = new ResizeObserver(() => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  });
  resize.observe(host);
  status.textContent = "Arraste para girar · role para aproximar · passe sobre uma peça para identificá-la";
  let inView = false;
  let animationFrame = 0;
  function animate() {
    if (!inView || document.hidden) {
      animationFrame = 0;
      return;
    }
    controls.update();
    renderer.render(scene, camera);
    animationFrame = requestAnimationFrame(animate);
  }
  const visibility = new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    if (inView && !animationFrame && !document.hidden) animate();
  });
  visibility.observe(host);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && inView && !animationFrame) animate();
  });
} catch (error) {
  console.error("Não foi possível abrir a visualização 3D.", error);
  document.querySelector("#pump-canvas").hidden = true;
  document.querySelector(".pump-fallback").hidden = false;
  status.textContent = "A visualização 3D não está disponível neste navegador. A foto de referência está abaixo.";
}
