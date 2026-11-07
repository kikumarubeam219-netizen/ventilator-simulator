import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * 医療機器メーカーのハイエンドモニタ・X線ホログラフィック医用イメージング3Dレンダラー
 * - プリミティブの貼り合わせを全廃
 * - 単一の数学的変形による滑らかな肺シルエット（フレネル透過）
 * - 葉間裂のミニマルなシェーダーライン表現
 * - 数千点の肺胞ドット群（Points）による肺胞内圧（Palv）色温度連動データビジュアライゼーション
 * - 解剖学的に傾斜した扁平・極細の半透明X線肋骨
 * - 滑らかな単一チューブ気道ツリー（Torusリング全廃）
 */
export class AnatomyRenderer {
  constructor(containerElement) {
    this.container = containerElement;
    this.width = containerElement.clientWidth || 420;
    this.height = containerElement.clientHeight || 360;

    this.showHeart = true;

    // 生体力学・ダンピング状態
    this.smoothedVolume = 0;
    this.smoothedPmus = 0;
    this.smoothedPalv = 5;

    this.initScene();
    this.initShaders();
    this.buildBodySilhouette();
    this.buildAnatomicalRibcage();
    this.buildStreamlinedAirway();
    this.buildHolographicLungs();
    this.buildAlveolarPointCloud();
    this.buildHolographicHeart();
    this.buildDiaphragmDome();
    this.buildAirflowParticles();

    this.onResize = this.resize.bind(this);
    window.addEventListener('resize', this.onResize);
  }

  initScene() {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(34, this.width / this.height, 0.1, 100);
    this.camera.position.set(0, 0.15, 11.0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(0, 0.1, 0);
    this.controls.minDistance = 4.5;
    this.controls.maxDistance = 16.0;
    this.controls.maxPolarAngle = Math.PI * 0.85;
    this.controls.minPolarAngle = Math.PI * 0.15;

    // 医用ハイエンドモニタ向けライティング（落ち着いたクリーンな光環境）
    const hemiLight = new THREE.HemisphereLight(0x38bdf8, 0x020617, 0.9);
    this.scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xf8fafc, 1.2);
    keyLight.position.set(3, 5, 8);
    this.scene.add(keyLight);

    const rimLightL = new THREE.DirectionalLight(0x0284c7, 1.4);
    rimLightL.position.set(-6, 2, -4);
    this.scene.add(rimLightL);

    const rimLightR = new THREE.DirectionalLight(0xf43f5e, 1.0);
    rimLightR.position.set(6, 2, -4);
    this.scene.add(rimLightR);
  }

  initShaders() {
    // 1. 肺実質用ホログラフィック・フレネルシェーダー（正面クリア透過＋エッジ発光＋葉間裂ライン）
    const lungVertexShader = `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        vLocalPos = position;
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const lungFragmentShader = `
      uniform vec3 uBaseColor;
      uniform vec3 uRimColor;
      uniform vec3 uStressColor;
      uniform float uStress;
      uniform float uSide; // -1: 右肺, +1: 左肺
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;

      void main() {
        vec3 normal = normalize(vNormal);
        if (!gl_FrontFacing) normal = -normal;
        vec3 viewDir = normalize(vViewPosition);
        float ndotv = clamp(abs(dot(normal, viewDir)), 0.0, 1.0);
        float fresnel = pow(1.0 - ndotv, 2.8);

        vec3 activeRim = mix(uRimColor, uStressColor, uStress);
        vec3 activeBase = mix(uBaseColor, uStressColor * 0.6, uStress);

        // 葉間裂（Fissure）のミニマルな光ライン表現
        // 斜裂（Oblique fissure）
        float obliqueDist = abs(vLocalPos.y + 0.65 * vLocalPos.z + 0.30);
        float obliqueLine = smoothstep(0.045, 0.0, obliqueDist);

        // 水平裂（Horizontal fissure: 右肺のみ）
        float horizLine = 0.0;
        if (uSide < 0.0 && vLocalPos.z > -0.2) {
          float horizDist = abs(vLocalPos.y - 0.15);
          horizLine = smoothstep(0.038, 0.0, horizDist);
        }

        float fissureGlow = max(obliqueLine, horizLine);

        vec3 color = mix(activeBase, activeRim, fresnel);
        color += activeRim * (fissureGlow * 0.85);

        // 正面は非常に透明、エッジに向かって滑らかに発色
        float alpha = 0.06 + fresnel * 0.68 + fissureGlow * 0.35;
        gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.90));
      }
    `;

    this.createLungMaterial = (side) => {
      return new THREE.ShaderMaterial({
        vertexShader: lungVertexShader,
        fragmentShader: lungFragmentShader,
        uniforms: {
          uBaseColor: { value: new THREE.Color(0x0f172a) },
          uRimColor: { value: new THREE.Color(side < 0 ? 0xf472b6 : 0xfb7185) },
          uStressColor: { value: new THREE.Color(0xf97316) },
          uStress: { value: 0.0 },
          uSide: { value: side }
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide
      });
    };

    // 2. 肋骨・骨格用 X線透視フレネルシェーダー（背景に馴染む淡い半透明）
    const boneVertexShader = `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const boneFragmentShader = `
      uniform vec3 uBoneColor;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vec3 normal = normalize(vNormal);
        if (!gl_FrontFacing) normal = -normal;
        vec3 viewDir = normalize(vViewPosition);
        float fresnel = pow(1.0 - clamp(abs(dot(normal, viewDir)), 0.0, 1.0), 2.2);
        vec3 col = mix(uBoneColor * 0.6, uBoneColor, fresnel);
        float alpha = 0.05 + fresnel * 0.40;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.55));
      }
    `;

    this.boneMaterial = new THREE.ShaderMaterial({
      vertexShader: boneVertexShader,
      fragmentShader: boneFragmentShader,
      uniforms: {
        uBoneColor: { value: new THREE.Color(0x38bdf8) }
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    // 3. 体幹シルエット用シェーダー
    this.bodyMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vWorldPos;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = -mvPosition.xyz;
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vWorldPos;
        void main() {
          vec3 normal = normalize(vNormal);
          if (!gl_FrontFacing) normal = -normal;
          vec3 viewDir = normalize(vViewPosition);
          float fresnel = pow(1.0 - clamp(abs(dot(normal, viewDir)), 0.0, 1.0), 3.2);
          float yFade = smoothstep(-3.8, -2.6, vWorldPos.y) * (1.0 - smoothstep(3.2, 4.3, vWorldPos.y));
          vec3 edgeColor = vec3(0.18, 0.35, 0.55);
          float alpha = (0.01 + fresnel * 0.28) * yFade;
          gl_FragColor = vec4(edgeColor, clamp(alpha, 0.0, 0.35));
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
  }

  /**
   * 1. 体幹シルエット（腕の円柱は全廃、首〜胸郭のミニマルなゴースト輪郭のみ）
   */
  buildBodySilhouette() {
    this.bodyGroup = new THREE.Group();
    const layers = 44;
    const radialSegs = 40;
    const geom = new THREE.BufferGeometry();
    const positions = [];
    const indices = [];

    for (let i = 0; i <= layers; i++) {
      const v = i / layers;
      const y = -3.6 + v * 7.5;
      let rx = 2.15;
      let rz = 1.38;

      if (y > 2.2) {
        const t = (y - 2.2) / 1.7;
        rx = 0.82 + Math.pow(t, 2.0) * 0.40;
        rz = 0.78 + Math.pow(t, 1.8) * 0.30;
      } else if (y > 1.35) {
        const t = (2.2 - y) / 0.85;
        const s = t * t * (3 - 2 * t);
        rx = 0.82 + s * 2.30;
        rz = 0.78 + s * 0.65;
      } else {
        const t = (1.35 - y) / 4.95;
        const shoulderBump = Math.exp(-Math.pow(t * 4.0, 2)) * 0.75;
        rx = 2.38 + shoulderBump - t * 0.35;
        rz = 1.42 - t * 0.20;
      }

      for (let j = 0; j <= radialSegs; j++) {
        const theta = (j / radialSegs) * Math.PI * 2;
        const squareness = 1.0 - 0.08 * Math.cos(theta * 2);
        positions.push(Math.cos(theta) * rx * squareness, y, Math.sin(theta) * rz * squareness);
      }
    }

    for (let i = 0; i < layers; i++) {
      for (let j = 0; j < radialSegs; j++) {
        const a = i * (radialSegs + 1) + j;
        const b = a + radialSegs + 1;
        indices.push(a, b, a + 1);
        indices.push(b, b + 1, a + 1);
      }
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    this.bodyGroup.add(new THREE.Mesh(geom, this.bodyMaterial));
    this.scene.add(this.bodyGroup);
  }

  /**
   * 2. 解剖学的X線肋骨・骨格（極細・扁平・尾側へ傾斜・肩の球体は削除）
   */
  buildAnatomicalRibcage() {
    this.skeletonGroup = new THREE.Group();
    this.ribcageGroup = new THREE.Group();

    // A. 脊椎（胸椎 T1〜T12）の薄型キューブ列
    const spineGroup = new THREE.Group();
    for (let i = 0; i < 14; i++) {
      const y = 2.75 - i * 0.36;
      const s = 0.7 + (i / 14) * 0.35;
      const vGeom = new THREE.BoxGeometry(0.32 * s, 0.22, 0.28 * s);
      const vMesh = new THREE.Mesh(vGeom, this.boneMaterial);
      vMesh.position.set(0, y, -0.80);
      spineGroup.add(vMesh);
    }
    this.skeletonGroup.add(spineGroup);

    // B. 鎖骨（左右の優雅なS字アーチ、肩の球体は全廃）
    [-1, 1].forEach(side => {
      const clavCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.22, 1.78, 0.80),
        new THREE.Vector3(side * 1.05, 1.88, 0.60),
        new THREE.Vector3(side * 1.95, 1.80, 0.15),
        new THREE.Vector3(side * 2.55, 1.82, -0.15)
      ]);
      const clavGeom = new THREE.TubeGeometry(clavCurve, 18, 0.048, 8, false);
      this.ribcageGroup.add(new THREE.Mesh(clavGeom, this.boneMaterial));
    });

    // C. 解剖学的肋骨（太いパイプを廃止し、極細チューブ＆尾側への自然な傾斜）
    for (let r = 0; r < 10; r++) {
      const t = r / 9;
      // 脊椎起始部から前下方へ大きく傾斜（約25〜30度の尾側傾斜）
      const yBack = 1.75 - r * 0.35;
      const yFront = yBack - 0.45 - t * 0.22;
      const width = 1.38 + Math.sin(t * Math.PI * 0.82) * 0.86;
      const depthFront = 0.98 + Math.sin(t * Math.PI * 0.75) * 0.30;

      [-1, 1].forEach(side => {
        const pts = [
          new THREE.Vector3(side * 0.22, yBack, -0.78),
          new THREE.Vector3(side * (width * 0.65), yBack - 0.12, -0.90),
          new THREE.Vector3(side * width, (yBack + yFront) * 0.52, -0.05),
          new THREE.Vector3(side * (width * 0.70), yFront + 0.10, depthFront * 0.78)
        ];

        if (r < 7) {
          pts.push(new THREE.Vector3(side * 0.20, yFront, depthFront));
        } else {
          pts.push(new THREE.Vector3(side * (0.38 + (r - 6) * 0.18), yFront + 0.26, depthFront * 0.80));
        }

        const ribCurve = new THREE.CatmullRomCurve3(pts);
        // 極細（半径0.032）の繊細なX線リブ
        const ribGeom = new THREE.TubeGeometry(ribCurve, 20, 0.032, 6, false);
        this.ribcageGroup.add(new THREE.Mesh(ribGeom, this.boneMaterial));
      });
    }

    // D. 胸骨（薄型半透明プレート）
    const sternumGeom = new THREE.BoxGeometry(0.24, 2.05, 0.05);
    const sternumMesh = new THREE.Mesh(sternumGeom, this.boneMaterial);
    sternumMesh.position.set(0, 0.52, 1.12);
    sternumMesh.rotation.x = -0.08;
    this.ribcageGroup.add(sternumMesh);

    this.skeletonGroup.add(this.ribcageGroup);
    this.scene.add(this.skeletonGroup);
  }

  /**
   * 3. 流線型気道ツリー（Torusリング全廃・滑らかな単一チューブ）
   */
  buildStreamlinedAirway() {
    this.airwayGroup = new THREE.Group();

    const airwayMat = new THREE.MeshPhysicalMaterial({
      color: 0xbae6fd,
      emissive: 0x0284c7,
      emissiveIntensity: 0.35,
      roughness: 0.25,
      metalness: 0.1,
      transmission: 0.40,
      transparent: true,
      opacity: 0.85
    });

    // 気管（滑らかな単一チューブ）
    const tracheaCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 2.75, 0.05),
      new THREE.Vector3(0, 1.85, 0.02),
      new THREE.Vector3(0, 0.95, 0.0)
    ]);
    const tracheaGeom = new THREE.TubeGeometry(tracheaCurve, 20, 0.15, 14, false);
    this.airwayGroup.add(new THREE.Mesh(tracheaGeom, airwayMat));

    this.bronchiTreeGroup = new THREE.Group();

    const addTaperedBranch = (pStart, pEnd, rStart, rEnd) => {
      const mid = new THREE.Vector3().lerpVectors(pStart, pEnd, 0.5);
      const curve = new THREE.CatmullRomCurve3([pStart, mid, pEnd]);
      const segs = 8;
      const radial = 8;
      const geom = new THREE.TubeGeometry(curve, segs, rStart, radial, false);
      const posAttr = geom.attributes.position;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const center = curve.getPointAt(t);
        const radiusScale = (rStart * (1.0 - t) + rEnd * t) / rStart;
        for (let j = 0; j <= radial; j++) {
          const idx = i * (radial + 1) + j;
          const vx = posAttr.getX(idx) - center.x;
          const vy = posAttr.getY(idx) - center.y;
          const vz = posAttr.getZ(idx) - center.z;
          posAttr.setXYZ(idx, center.x + vx * radiusScale, center.y + vy * radiusScale, center.z + vz * radiusScale);
        }
      }
      geom.computeVertexNormals();
      this.bronchiTreeGroup.add(new THREE.Mesh(geom, airwayMat));
    };

    [-1, 1].forEach(side => {
      const s = side;
      const carina = new THREE.Vector3(0, 0.95, 0.0);
      const mainHilus = new THREE.Vector3(s * (s < 0 ? 0.58 : 0.68), s < 0 ? 0.58 : 0.50, 0.0);
      addTaperedBranch(carina, mainHilus, 0.14, 0.095);

      // 上葉枝
      const pUpper = new THREE.Vector3(s * 0.88, 0.88, 0.04);
      addTaperedBranch(mainHilus, pUpper, 0.090, 0.065);
      addTaperedBranch(pUpper, new THREE.Vector3(s * 0.94, 1.40, 0.06), 0.060, 0.035);
      addTaperedBranch(pUpper, new THREE.Vector3(s * 1.25, 1.05, 0.12), 0.060, 0.035);

      // 中葉/舌区枝
      const pMid = new THREE.Vector3(s * 0.98, 0.22, 0.10);
      addTaperedBranch(mainHilus, pMid, 0.085, 0.060);
      addTaperedBranch(pMid, new THREE.Vector3(s * 1.34, 0.30, 0.18), 0.055, 0.032);
      addTaperedBranch(pMid, new THREE.Vector3(s * 1.32, -0.16, 0.16), 0.055, 0.032);

      // 下葉枝
      const pLower = new THREE.Vector3(s * 0.90, -0.08, -0.05);
      addTaperedBranch(mainHilus, pLower, 0.090, 0.065);
      addTaperedBranch(pLower, new THREE.Vector3(s * 1.10, -0.62, -0.05), 0.060, 0.035);
      addTaperedBranch(pLower, new THREE.Vector3(s * 1.38, -0.52, -0.08), 0.060, 0.035);
    });

    this.airwayGroup.add(this.bronchiTreeGroup);
    this.scene.add(this.airwayGroup);
  }

  /**
   * 4. ホログラフィック肺（団子重ね廃止 → 高分割単一滑らかメッシュ）
   */
  buildHolographicLungs() {
    this.lungsGroup = new THREE.Group();

    const createSingleContinuousLung = (side) => {
      // 96x96の高分割単一メッシュ
      const geom = new THREE.SphereGeometry(1.0, 96, 96);
      const pos = geom.attributes.position;
      const basePositions = [];

      for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i);
        let y = pos.getY(i);
        let z = pos.getZ(i);

        // 縦長の基本プロポーション
        y *= 1.82;
        z *= 0.88;

        const normY = (y + 1.82) / 3.64; // 0(肺底) 〜 1(肺尖)

        // 肺尖（上端）の滑らかな円錐テーパリング
        const widthProfile = 0.38 + 0.90 * Math.pow(1.0 - normY, 0.60) * Math.sin(Math.acos(Math.max(-1, Math.min(1, (normY - 0.5) * 2.0))) * 0.35 + 0.7);
        x *= widthProfile * 1.16;
        z *= (0.52 + 0.55 * (1.0 - normY * 0.5));

        // 縦隔面（内側）の滑らかな平坦化
        const isMedial = (side < 0 && x > 0) || (side > 0 && x < 0);
        if (isMedial) {
          x *= 0.32;
        } else {
          x *= 1.15; // 外側面は肋骨に沿う美しい膨らみ
        }

        // 心切痕（左肺）
        if (side > 0 && x < 0.35 && y < 0.35 && y > -1.25 && z > -0.15) {
          const notch = Math.exp(-Math.pow((y + 0.42) / 0.52, 2)) * Math.exp(-Math.pow((x + 0.05) / 0.42, 2));
          x += notch * 0.38;
          z -= notch * 0.16;
        }

        // 肺底部（横隔膜ドーム受け凹面）
        if (y < -1.15) {
          const radialDist = Math.hypot(x * 0.7, z * 0.8);
          const domeIndent = Math.max(0, 1.0 - radialDist * 0.85) * 0.45;
          y += domeIndent * Math.min(1.0, (-1.15 - y) * 1.8);
        }

        const xOffset = side * 1.05;
        const finalX = x + xOffset;
        const finalY = y + 0.22;
        const finalZ = z;

        pos.setXYZ(i, finalX, finalY, finalZ);
        basePositions.push({ x: finalX, y: finalY, z: finalZ, normY });
      }

      geom.computeVertexNormals();

      const mat = this.createLungMaterial(side);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData = { basePositions, side, mat };
      return mesh;
    };

    this.rightLungMesh = createSingleContinuousLung(-1);
    this.leftLungMesh = createSingleContinuousLung(1);

    this.lungsGroup.add(this.rightLungMesh);
    this.lungsGroup.add(this.leftLungMesh);
    this.scene.add(this.lungsGroup);
  }

  /**
   * 5. 肺胞ドット群（Points：数千個の微小点群・Palv色温度連動データビジュアライゼーション）
   */
  buildAlveolarPointCloud() {
    const particleCount = 2800; // 合計2800点の肺胞ドット
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    this.alveoliBaseData = [];

    const baseColorA = new THREE.Color(0x38bdf8); // 低圧時：クリアシアン
    const baseColorB = new THREE.Color(0xf472b6); // 低圧時：パステルローズ

    for (let i = 0; i < particleCount; i++) {
      const side = (i % 2 === 0) ? -1 : 1;
      let px = 0, py = 0, pz = 0;
      let normY = 0;

      while (true) {
        normY = Math.random();
        py = -1.1 + normY * 2.3;
        const rMax = (0.28 + 0.65 * (1.0 - normY * 0.65)) * 0.85;
        const angle = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * rMax;
        px = Math.cos(angle) * r;
        pz = Math.sin(angle) * r * 0.75;

        if ((side < 0 && px > 0.15) || (side > 0 && px < -0.15)) continue;
        break;
      }

      const worldX = px + side * 1.05;
      const worldY = py + 0.22;
      const worldZ = pz;

      positions[i * 3 + 0] = worldX;
      positions[i * 3 + 1] = worldY;
      positions[i * 3 + 2] = worldZ;

      const col = (side < 0) ? baseColorA : baseColorB;
      colors[i * 3 + 0] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;

      this.alveoliBaseData.push({
        x: worldX,
        y: worldY,
        z: worldZ,
        normY,
        side,
        radialDist: Math.hypot(px, pz)
      });
    }

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.alveoliPointsMaterial = new THREE.PointsMaterial({
      size: 0.052,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.alveoliPointCloud = new THREE.Points(geom, this.alveoliPointsMaterial);
    this.scene.add(this.alveoliPointCloud);
  }

  /**
   * 6. ミニマルな半透明ホログラフィック心臓
   */
  buildHolographicHeart() {
    this.heartGroup = new THREE.Group();
    this.heartGroup.position.set(0.24, -0.32, 0.24);

    const heartMat = new THREE.MeshPhysicalMaterial({
      color: 0x991b1b,
      emissive: 0x881337,
      emissiveIntensity: 0.2,
      roughness: 0.4,
      transmission: 0.5,
      transparent: true,
      opacity: 0.45,
      depthWrite: false
    });

    const heartGeom = new THREE.SphereGeometry(0.55, 24, 24);
    heartGeom.scale(0.95, 1.18, 0.85);
    const heartMesh = new THREE.Mesh(heartGeom, heartMat);
    heartMesh.rotation.z = -0.35;
    heartMesh.rotation.x = 0.12;
    this.heartGroup.add(heartMesh);

    this.scene.add(this.heartGroup);
  }

  /**
   * 7. 3D横隔膜ドーム（ワイヤー全廃・滑らかなフレネル曲面）
   */
  buildDiaphragmDome() {
    this.diaphragmGroup = new THREE.Group();

    const radialSegs = 32;
    const angularSegs = 48;
    this.diaphragmGeom = new THREE.BufferGeometry();

    const positions = [];
    const indices = [];
    this.diaphragmBaseData = [];

    for (let i = 0; i <= radialSegs; i++) {
      const r = i / radialSegs;
      for (let j = 0; j <= angularSegs; j++) {
        const theta = (j / angularSegs) * Math.PI * 2;
        const x = Math.cos(theta) * r * 2.10;
        const z = Math.sin(theta) * r * 1.25;
        positions.push(x, -1.5, z);
        this.diaphragmBaseData.push({ r, theta, x, z });
      }
    }

    for (let i = 0; i < radialSegs; i++) {
      for (let j = 0; j < angularSegs; j++) {
        const a = i * (angularSegs + 1) + j;
        const b = a + angularSegs + 1;
        indices.push(a, b, a + 1);
        indices.push(b, b + 1, a + 1);
      }
    }

    this.diaphragmGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.diaphragmGeom.setIndex(indices);

    this.diaphragmMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x881337,
      emissive: 0x4c0519,
      emissiveIntensity: 0.25,
      roughness: 0.4,
      metalness: 0.1,
      transmission: 0.45,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide
    });

    this.diaphragmMesh = new THREE.Mesh(this.diaphragmGeom, this.diaphragmMaterial);
    this.diaphragmGroup.add(this.diaphragmMesh);

    // 吸気努力矢印（極細のミニマルベクター）
    this.pmusArrowsGroup = new THREE.Group();
    const arrowMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.85 });

    [-1.0, 0, 1.0].forEach(xPos => {
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 8), arrowMat);
      shaft.position.y = 0.12;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.18, 10), arrowMat);
      head.position.y = -0.12;
      head.rotation.x = Math.PI;
      arrow.add(shaft, head);
      arrow.position.set(xPos, -2.0, 0.30);
      this.pmusArrowsGroup.add(arrow);
    });
    this.pmusArrowsGroup.visible = false;
    this.diaphragmGroup.add(this.pmusArrowsGroup);

    this.scene.add(this.diaphragmGroup);
    this.updateDiaphragmGeometry(0, 0);
  }

  updateDiaphragmGeometry(pmus, volRatio) {
    const posAttr = this.diaphragmGeom.attributes.position;
    const contractionDrop = (pmus * 0.075) + (volRatio * 0.36);
    const domeHeight = Math.max(0.18, 0.85 - contractionDrop);

    for (let i = 0; i < this.diaphragmBaseData.length; i++) {
      const { r, x, z } = this.diaphragmBaseData[i];
      const domeBell = Math.cos(r * Math.PI * 0.5);
      const doublePeak = 1.0 + 0.18 * Math.pow(Math.abs(x) / 1.5, 1.5) * (1.0 - r) - (x < 0 ? -0.05 : 0.03) * (1.0 - r);
      const y = -2.05 + domeBell * domeHeight * doublePeak - (1.0 - r * 0.65) * contractionDrop * 0.35;
      posAttr.setXYZ(i, x, y, z);
    }
    posAttr.needsUpdate = true;
    this.diaphragmGeom.computeVertexNormals();
  }

  /**
   * 8. 気道内気流パーティクル
   */
  buildAirflowParticles() {
    this.particlesGroup = new THREE.Group();
    this.particlePaths = [
      [new THREE.Vector3(0, 2.7, 0.04), new THREE.Vector3(0, 0.95, 0.0)],
      [new THREE.Vector3(0, 0.95, 0.0), new THREE.Vector3(-0.58, 0.58, 0.0), new THREE.Vector3(-1.10, 1.25, 0.08)],
      [new THREE.Vector3(0, 0.95, 0.0), new THREE.Vector3(-0.58, 0.58, 0.0), new THREE.Vector3(-1.20, -0.75, -0.05)],
      [new THREE.Vector3(0, 0.95, 0.0), new THREE.Vector3(0.68, 0.50, 0.0), new THREE.Vector3(1.18, 1.18, 0.08)],
      [new THREE.Vector3(0, 0.95, 0.0), new THREE.Vector3(0.68, 0.50, 0.0), new THREE.Vector3(1.28, -0.75, -0.05)]
    ].map(pts => new THREE.CatmullRomCurve3(pts));

    this.flowParticleMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.0 });
    const pGeom = new THREE.SphereGeometry(0.045, 8, 8);
    this.particleMeshes = [];

    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(pGeom, this.flowParticleMat);
      this.particlesGroup.add(mesh);
      this.particleMeshes.push({ mesh, pathIndex: i % this.particlePaths.length, offset: i / 12 });
    }
    this.scene.add(this.particlesGroup);
  }

  setCameraView(viewName) {
    if (viewName === 'front') {
      this.camera.position.set(0, 0.15, 11.0);
      this.controls.target.set(0, 0.1, 0);
    } else if (viewName === 'oblique') {
      this.camera.position.set(4.8, 1.5, 9.2);
      this.controls.target.set(0, 0.1, 0);
    } else if (viewName === 'side') {
      this.camera.position.set(10.0, 0.2, 1.0);
      this.controls.target.set(0, 0.1, 0);
    } else if (viewName === 'diaphragm') {
      this.camera.position.set(0, -2.4, 8.8);
      this.controls.target.set(0, -0.5, 0);
    }
    this.controls.update();
  }

  toggleHeartVisibility() {
    this.showHeart = !this.showHeart;
    if (this.heartGroup) this.heartGroup.visible = this.showHeart;
    return this.showHeart;
  }

  resize() {
    if (!this.container) return;
    this.width = this.container.clientWidth || 420;
    this.height = this.container.clientHeight || 360;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
  }

  /**
   * 60fps レンダリングループ
   * - 肺実質メッシュ＆肺胞ドット群の生体力学連動（肺底伸展）
   * - 肺胞内圧（Palv）連動の色温度グラデーション
   */
  render(engineState, params, now) {
    const { V, Pmus, Paw, Palv, Flow, currentAutoPeep } = engineState;

    const tau = Math.max(0.2, (params.R * (params.C / 1000.0)));
    const smoothFactor = Math.min(0.25, 0.016 / tau * 1.8);

    this.smoothedVolume += (V - this.smoothedVolume) * smoothFactor;
    this.smoothedPmus += (Pmus - this.smoothedPmus) * (smoothFactor * 1.5);
    this.smoothedPalv += (Palv - this.smoothedPalv) * smoothFactor;

    const volRatio = Math.max(0, Math.min(1.5, this.smoothedVolume / 600.0));
    const pmusVal = this.smoothedPmus;
    const palvVal = this.smoothedPalv;

    // 1. 肺実質メッシュの生体力学的伸展（下葉・肺底が横隔膜に牽引される）
    [this.rightLungMesh, this.leftLungMesh].forEach(lung => {
      if (!lung) return;
      const posAttr = lung.geometry.attributes.position;
      const { basePositions, side, mat } = lung.userData;

      for (let i = 0; i < basePositions.length; i++) {
        const { x, y, z, normY } = basePositions[i];
        // 肺尖(normY〜1)は静止、肺底(normY〜0)が大きく尾側へ伸展
        const stretchY = Math.pow(1.0 - normY, 1.25) * (volRatio * 0.32 + (pmusVal / 15.0) * 0.12);
        const stretchX = Math.sin(normY * Math.PI) * (volRatio * 0.14);
        const stretchZ = (1.0 - normY) * (volRatio * 0.16);

        posAttr.setXYZ(i, x + side * stretchX, y - stretchY, z + stretchZ);
      }
      posAttr.needsUpdate = true;
      lung.geometry.computeVertexNormals();

      // 圧ストレス（高気道圧/Auto-PEEP）によるシェーダー警戒色
      const isStressed = (currentAutoPeep > 2.2 || Paw > 28);
      const targetStress = isStressed ? 1.0 : 0.0;
      mat.uniforms.uStress.value += (targetStress - mat.uniforms.uStress.value) * 0.1;
    });

    // 2. 肺胞ドット群（Points）の動態 ＆ Palv色温度変化
    if (this.alveoliPointCloud) {
      const posAttr = this.alveoliPointCloud.geometry.attributes.position;
      const colAttr = this.alveoliPointCloud.geometry.attributes.color;

      const palvNorm = Math.min(1.0, Math.max(0.0, (palvVal - 5.0) / 25.0));
      const coolColorL = new THREE.Color(0xf472b6);
      const coolColorR = new THREE.Color(0x38bdf8);
      const hotColor = new THREE.Color(0xf97316);

      for (let i = 0; i < this.alveoliBaseData.length; i++) {
        const d = this.alveoliBaseData[i];
        const stretchY = Math.pow(1.0 - d.normY, 1.25) * (volRatio * 0.32 + (pmusVal / 15.0) * 0.12);
        const stretchX = Math.sin(d.normY * Math.PI) * (volRatio * 0.14);
        const stretchZ = (1.0 - d.normY) * (volRatio * 0.16);

        posAttr.setXYZ(i, d.x + d.side * stretchX, d.y - stretchY, d.z + stretchZ);

        const baseCol = (d.side < 0) ? coolColorR : coolColorL;
        const currentParticleColor = baseCol.clone().lerp(hotColor, palvNorm);
        colAttr.setXYZ(i, currentParticleColor.r, currentParticleColor.g, currentParticleColor.b);
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }

    // 3. 気管支ツリーの追従
    if (this.bronchiTreeGroup) {
      this.bronchiTreeGroup.scale.set(
        1.0 + volRatio * 0.07,
        1.0 + volRatio * 0.15,
        1.0 + volRatio * 0.08
      );
      this.bronchiTreeGroup.position.y = -volRatio * 0.07;
    }

    // 4. 胸郭（肋骨カゴ）のバケツハンドル挙上
    if (this.ribcageGroup) {
      this.ribcageGroup.position.y = volRatio * 0.14;
      this.ribcageGroup.position.z = volRatio * 0.05;
      this.ribcageGroup.scale.set(
        1.0 + volRatio * 0.04,
        1.0 + volRatio * 0.015,
        1.0 + volRatio * 0.05
      );
    }

    // 5. 横隔膜ドームの尾側引き下げ
    this.updateDiaphragmGeometry(pmusVal, volRatio);

    if (this.pmusArrowsGroup) {
      this.pmusArrowsGroup.visible = pmusVal > 0.8;
      const effort = Math.min(1.0, pmusVal / 10.0);
      this.pmusArrowsGroup.position.y = -effort * 0.22;
    }

    // 6. 心臓拍動（75 bpm）
    if (this.heartGroup && this.showHeart) {
      const heartCycle = (now / 1000.0) % 0.8;
      const systole = Math.exp(-Math.pow((heartCycle - 0.15) / 0.07, 2));
      const compression = Math.max(0, (params.peep + currentAutoPeep - 8) * 0.008);
      const hScale = Math.max(0.85, 1.0 - (systole * 0.07) - compression);
      this.heartGroup.scale.setScalar(hScale);
    }

    // 7. 気流パーティクル
    if (Math.abs(Flow) > 0.05) {
      this.flowParticleMat.opacity = Math.min(0.85, 0.25 + Math.abs(Flow) * 0.5);
      this.flowParticleMat.color.setHex(Flow > 0 ? 0x38bdf8 : 0x94a3b8);
      const speed = Flow * 0.0015;
      this.particleMeshes.forEach(p => {
        const path = this.particlePaths[p.pathIndex];
        const t = ((now * speed + p.offset) % 1 + 1) % 1;
        p.mesh.position.copy(path.getPointAt(t));
      });
    } else {
      this.flowParticleMat.opacity = 0.0;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
