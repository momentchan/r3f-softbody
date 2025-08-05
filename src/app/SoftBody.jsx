import * as THREE from 'three'
import React from 'react';
import { useFrame, useThree } from '@react-three/fiber'
import { GPUComputationRenderer } from 'three/examples/jsm/Addons.js'
import { useMemo, useRef, useState, useEffect } from 'react'
import { useControls, folder } from 'leva'
import SoftBodyRender from './SoftBodyRender'

// ---------- Configuration Constants ----------
const BODY_COUNT = 3;

const BODIES = [
  { radius: 0.22, center: new THREE.Vector2(-0.4, 0.3), color: '#ff6464' },
  { radius: 0.18, center: new THREE.Vector2(0.2, 0.1), color: '#62d8ff' },
  { radius: 0.25, center: new THREE.Vector2(-0.3, -0.2), color: '#98ff62' }
];

// ---------- Helper Functions ----------
const generateRestPositions = (radius, pointsPer) =>
  Array.from({ length: pointsPer }, (_, i) => {
    const angle = (i / pointsPer) * Math.PI * 2
    return [radius * Math.cos(angle), radius * Math.sin(angle)]
  })

// ---------- Custom Hook: Soft Body Configuration ----------
const useSoftBodyConfig = () => {
  return useControls({
    'Soft Body': folder({
      debugPoints: { value: true },
      debugAABBs: { value: false },
      kShape: { value: 300, min: 0, max: 1000, step: 1 },
      pressureK: { value: 80, min: 0, max: 200, step: 1 },
      kSpring: { value: 40, min: 0, max: 100, step: 1 },
      damping: { value: 2, min: 0, max: 10, step: 0.1 },
      wallK: { value: 300, min: 0, max: 500, step: 10 },
      wallDamp: { value: 5, min: 0, max: 20, step: 0.5 },
      gravityY: { value: -5, min: -20, max: 0, step: 0.5 },
      numPoints: { value: 32, min: 16, max: 256, step: 8 },
      wallDistance: { value: 0.9, min: 0, max: 1, step: 0.1, label: 'Wall Distance' },
      pushStrength: { value: 10, min: 0, max: 100, step: 1 },
      kDampSpring: { value: 1.0, min: 0.0, max: 10.0, step: 0.1 },
      dragBody: { value: -1 }, 
    })
  })
}

// ---------- Custom Hook: GPU Computation Renderer ----------
const useGPUComputation = (cfg) => {
  const { gl } = useThree()

  return useMemo(() => {
    // Create GPU computation renderer for multiple bodies
    const gpu = new GPUComputationRenderer(cfg.numPoints, BODY_COUNT, gl)
    const tex = gpu.createTexture()
    const restTex = gpu.createTexture()
    const shapeTex = gpu.createTexture()
    const bboxTex = gpu.createTexture()

    // Initialize texture with rest positions for all bodies
    const restPositionsList = []
    for (let row = 0; row < BODY_COUNT; row++) {
      const restPos = generateRestPositions(BODIES[row].radius, cfg.numPoints)
      restPositionsList.push(restPos)

      const c = BODIES[row].center

      // Set texture data for this row
      for (let i = 0; i < cfg.numPoints; i++) {
        const [x, y] = restPos[i]
        // Set initial position to rest position offset by the body's center
        tex.image.data.set(
          [x + c.x, y + c.y, 0, 0],
          (row * cfg.numPoints + i) * 4
        )
        restTex.image.data.set([x, y, 0, 0], (row * cfg.numPoints + i) * 4)

        const base = (row * cfg.numPoints + i) * 4;
        shapeTex.image.data[base + 0] = c.x;  // center.x
        shapeTex.image.data[base + 1] = c.y;  // center.y
        shapeTex.image.data[base + 2] = 1.0;  // cosθ = 1
        shapeTex.image.data[base + 3] = 0.0;  // sinθ = 0

        bboxTex.image.data[base + 0] = 0.0;  // min.x
        bboxTex.image.data[base + 1] = 0.0;  // min.y
        bboxTex.image.data[base + 2] = 0.0;  // max.x
        bboxTex.image.data[base + 3] = 0.0;  // max.y
      }
    }

    // Store rest positions for shape matching
    window.restList = restPositionsList

    // Compute shader source
    const shader = /* glsl */`
      uniform float  dt;
      uniform float  kSpring, damping;
      uniform float  kDampSpring;
      uniform float  kPressure;
      uniform vec2   gravity;
      uniform float  wallK, wallDamp;
      uniform float  wallDistance;
      uniform float  kShape;
      uniform float  pushStrength;
      uniform int   dragBody;

      uniform vec2  dragPos;     // drag position
      uniform float kDrag;       // drag stiffness

      uniform sampler2D restTex;

      const int   I_N = ${cfg.numPoints};
      const int   B_N = ${BODY_COUNT};
      const float F_N = float(${cfg.numPoints});
      
      uniform float radiusArr[B_N];

      vec2 uvFromIndex(int body, int idx) {
        float u = (float(idx)  + 0.5) / float(I_N);
        float v = (float(body) + 0.5) / float(B_N);
        return vec2(u, v);
      }

      vec4 getPos(int body, int idx) {
        return texture2D(texturePos, uvFromIndex(body, idx));
      }

      const float PI = 3.14159265358979323846;

      float restLen(int body) {
        return (2.0 * PI * radiusArr[body]) / float(I_N);
      }

      float areaRest(int body) {
        return PI * radiusArr[body] * radiusArr[body];
      }

      vec2 wallForce(vec2 pos, vec2 vel) {
        vec2 f = vec2(0.);
        
        // Right wall
        if (pos.x > wallDistance) {
          float p = pos.x - wallDistance;
          vec2  n = vec2(1.,0.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        // Left wall
        else if (pos.x < -wallDistance) {
          float p = -wallDistance - pos.x;
          vec2  n = vec2(-1.,0.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        // Top wall
        if (pos.y > wallDistance) {
          float p = pos.y - wallDistance;
          vec2  n = vec2(0.,1.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        // Bottom wall
        else if (pos.y < -wallDistance) {
          float p = -wallDistance - pos.y;
          vec2  n = vec2(0.,-1.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        return f;
      }

      // Main update function
      void main() {
        int idx = int(gl_FragCoord.x);
        int body = int(gl_FragCoord.y);

        vec4 sm   = texture2D(shapeMatchTex, vec2(0.5, (float(body)+0.5)/float(B_N)));
        vec2 trans = sm.xy;
        vec2 rot   = sm.zw; 

        vec4 p = texture2D(texturePos, uvFromIndex(body, idx));
        vec2 pos = p.xy;
        vec2 vel = p.zw;
        vec2 f = vec2(0.);

        // Spring forces with neighbors (structural)
        for (int off = -1; off <= 1; off += 2) {
          int nIdx = (idx + off + I_N) % I_N;
        
          // 取得鄰居的位置與速度
          vec4 nTex = getPos(body, nIdx);        // 你的 getPos 回傳 vec4(pos.xy, vel.xy)
          vec2 pb   = nTex.xy;
          vec2 vb   = nTex.zw;
        
          // 當前點
          vec2 pa = pos;
          vec2 va = vel;
        
          // 向量與長度
          vec2 ab = pb - pa;
          float d  = length(ab);
          vec2 dir = d > 1e-6 ? ab / d : vec2(0.0);
        
          float Fs = kSpring * (d - restLen(body));     // restLen(body) 已有
        
          float vRel = dot(dir, vb - va);               // 只取在彈簧方向上的相對速度
          float Fd   = kDampSpring * vRel;              // ← 新 uniform
        
          // 合力
          vec2 Fspring = (Fs + Fd) * dir;
          f += Fspring;
        }


        // Internal pressure (2D gas model)
        float area = 0.;
        for (int i = 0; i < I_N; ++i) {
          vec2 p0 = getPos(body, i).xy;
          vec2 p1 = getPos(body, (i+1)%I_N).xy;
          area += p0.x*p1.y - p1.x*p0.y;
        }
        area = 0.5 * abs(area);
        float press = kPressure * (areaRest(body) - area) / areaRest(body);
        vec2  prev = getPos(body, (idx + I_N-1)%I_N).xy;
        vec2  next = getPos(body, (idx + 1)%I_N).xy;
        vec2  edge = next - prev;
        vec2  nrm = normalize(vec2(edge.y, -edge.x) + 1e-4);
        f += press * nrm / F_N;

        // Gravity and wall forces
        f += gravity;
        f += wallForce(pos, vel);

        // Shape matching (goal = R·q + T)
        vec2 q = texture2D(restTex, uvFromIndex(body, idx)).xy;
        vec2 goal = vec2(
          rot.x*q.x - rot.y*q.y,
          rot.y*q.x + rot.x*q.y
        ) + trans;
        f += kShape * (goal - pos);

        // Drag force
        if (body == dragBody) {
          f += kDrag * (dragPos - trans);
        }

        // Semi-implicit Euler integration
        vel += f * dt;
        vel *= exp(-damping * dt);

        // --- temporarily update pos to predict ---
        vec2 nextPos = pos + vel * dt;

        // --- collision check and correction ---
        for (int otherBody = 0; otherBody < B_N; ++otherBody) {
          if (otherBody == body) continue;

          vec4 bbox = texture2D(bboxTex, vec2(0.5, (float(otherBody)+0.5)/float(B_N)));
          vec2 minP = bbox.xy, maxP = bbox.zw;

          if (nextPos.x < minP.x || nextPos.x > maxP.x || nextPos.y < minP.y || nextPos.y > maxP.y) continue;

          int count = 0;
          for (int i = 0; i < I_N; ++i) {
            vec2 a = getPos(otherBody, i).xy;
            vec2 b = getPos(otherBody, (i+1)%I_N).xy;
            if ((a.y > nextPos.y) != (b.y > nextPos.y)) {
              float t = (nextPos.y - a.y) / (b.y - a.y);
              float xCross = mix(a.x, b.x, t);
              if (nextPos.x < xCross) count++;
            }
          }

          if (count % 2 == 1) {
            float minDist = 1e6;
            vec2 newPos = nextPos;

            for (int i = 0; i < I_N; ++i) {
              vec2 a = getPos(otherBody, i).xy;
              vec2 b = getPos(otherBody, (i+1)%I_N).xy;
              vec2 ab = b - a;
              vec2 ap = nextPos - a;

              float t = clamp(dot(ap, ab) / (dot(ab, ab) + 1e-6), 0.0, 1.0);
              vec2 proj = a + t * ab;
              float d = length(nextPos - proj);
              if (d < minDist) {
                minDist = d;
                newPos = proj;
              }
            }

            nextPos = mix(nextPos, newPos, 1.0);
            vel = vec2(0.0); 
          }
        }

        // --- final position update ---
        pos = nextPos;

        gl_FragColor = vec4(pos, vel);
      }
    `
    const shapeShader = /* glsl */`
      uniform sampler2D restTex;
      const int I_N = ${cfg.numPoints};
      const int B_N = ${BODY_COUNT};

      vec2 uvFromIndex(int body, int idx) {
        float u = (float(idx)  + 0.5) / float(I_N);
        float v = (float(body) + 0.5) / float(B_N);
        return vec2(u, v);
      }

      void main() { 
        int idx = int(gl_FragCoord.x);
        int body = int(gl_FragCoord.y);
        vec2 C = vec2(0.0);
        float A = 0.0, B = 0.0;

        // Calculate centroid
        for (int i = 0; i < I_N; ++i) {
          vec2 p = texture2D(texturePos, uvFromIndex(body, i)).xy;
          C += p;
        }
        C /= float(I_N);

        // Calculate covariance (A, B)
        for (int i = 0; i < I_N; ++i) {
          vec2 p = texture2D(texturePos, uvFromIndex(body, i)).xy - C;
          vec2 q = texture2D(restTex,    uvFromIndex(body, i)).xy;
        
          // ----- Correct direction -----
          A += p.x * q.x + p.y * q.y;        // dot
          B += p.y * q.x - p.x * q.y;        // cross ★
        }
        float len  = max(length(vec2(A, B)), 1e-6);
        float cosT =  A / len;
        float sinT =  B / len;
        gl_FragColor = vec4(C, cosT, sinT);
      }
    `;

    const bboxShader = /* glsl */`
    const int I_N = ${cfg.numPoints};
    const int B_N = ${BODY_COUNT};
  
    vec2 uvFromIndex(int body, int idx) {
      float u = (float(idx)  + 0.5) / float(I_N);
      float v = (float(body) + 0.5) / float(B_N);
      return vec2(u, v);
    }
  
    
    void main() {
      int body = int(gl_FragCoord.y);
  
      vec2 minP = vec2(1e6), maxP = vec2(-1e6);
  
      for (int i = 0; i < I_N; ++i) {
        vec2 p = texture2D(texturePos, uvFromIndex(body, i)).xy;
        minP = min(minP, p);
        maxP = max(maxP, p);
      }
  
      // 寫入該 body 的整行
      gl_FragColor = vec4(minP, maxP);
    }
    `;


    // Add variable and uniforms
    const posVar = gpu.addVariable('texturePos', shader, tex)
    const shapeVar = gpu.addVariable('shapeMatchTex', shapeShader, shapeTex)
    const bboxVar = gpu.addVariable('bboxTex', bboxShader, bboxTex)

    // Initialize arrays for shape matching
    gpu.setVariableDependencies(posVar, [posVar, bboxVar, shapeVar])
    gpu.setVariableDependencies(shapeVar, [posVar])
    gpu.setVariableDependencies(bboxVar, [posVar])

    Object.assign(posVar.material.uniforms, {
      dt: { value: 0 },
      kSpring: { value: cfg.kSpring },
      kDampSpring: { value: cfg.kDampSpring },
      damping: { value: cfg.damping },
      kPressure: { value: cfg.pressureK },
      gravity: { value: new THREE.Vector2(0, cfg.gravityY) },
      wallK: { value: cfg.wallK },
      wallDamp: { value: cfg.wallDamp },
      wallDistance: { value: cfg.wallDistance },
      kShape: { value: cfg.kShape },
      dragPos: { value: new THREE.Vector2() },
      kDrag: { value: 0.0 },
      radiusArr: { value: BODIES.map(b => b.radius) },
      restTex: { value: restTex },
      pushStrength: { value: cfg.pushStrength },
      dragBody: { value: -1 },
    })

    // Compile and return
    const err = gpu.init()
    if (err) console.error(err)
    return { gpu, posVar, shapeVar, bboxVar }
  }, [gl, cfg.numPoints, cfg.radius])
}

// ---------- Custom Hook: Simulation State ----------
const useSimulationState = () => {
  const [centers, setCenters] = useState(
    () => Array.from({ length: BODY_COUNT }, () => [0, 0])
  );

  return { centers, setCenters };
};

// ---------- Custom Hook: Instanced Meshes ----------
const useInstancedMeshes = (pointsPer) => {
  // Create refs for each body
  const instRefs = useMemo(
    () => Array.from({ length: BODY_COUNT }, () => React.createRef()),
    []
  );

  // Reusable dummy Object3D for matrix updates
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // JSX helper that returns an array of debug meshes
  const DebugMeshes = () =>
    instRefs.map((ref, row) => (
      <instancedMesh key={row} ref={ref} args={[null, null, pointsPer]}>
        <circleGeometry args={[0.01, 16]} />
        <meshBasicMaterial color="#ff4040" />
      </instancedMesh>
    ));

  return { instRefs, dummy, DebugMeshes };
};


function DebugAABBs({ aabbs }) {
  const ref = useRef();
  const { viewport } = useThree();

  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(BODY_COUNT * 8 * 3); // 4邊×2點×3維
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geom;
  }, []);

  useEffect(() => {
    const s = Math.min(viewport.width, viewport.height) * 0.5;
    const posAttr = geometry.attributes.position;
    for (let i = 0; i < aabbs.length; i++) {
      const [min, max] = aabbs[i];
      const x0 = min[0] * s, y0 = min[1] * s;
      const x1 = max[0] * s, y1 = max[1] * s;

      const verts = [
        [x0, y0], [x1, y0],
        [x1, y0], [x1, y1],
        [x1, y1], [x0, y1],
        [x0, y1], [x0, y0],
      ];

      for (let j = 0; j < 8; j++) {
        const idx = i * 8 * 3 + j * 3;
        posAttr.array[idx + 0] = verts[j][0];
        posAttr.array[idx + 1] = verts[j][1];
        posAttr.array[idx + 2] = 0;
      }
    }
    geometry.attributes.position.needsUpdate = true;
  }, [aabbs]);

  return (
    <lineSegments ref={ref} geometry={geometry}>
      <lineBasicMaterial color="white" linewidth={2} />
    </lineSegments>
  );
}

// ---------- Custom Hook: Simulation Update ----------
const useSimulationUpdate = (cfg, gpu, posVar, shapeVar, bboxVar, setCenters, instRefs, dummy, drag, setAABBs) => {
  const { gl, viewport } = useThree()
  const rowBuf = useMemo(() => new Float32Array(cfg.numPoints * 4), [cfg.numPoints])


  useFrame((_, dt) => {
    // Handle drag interaction
    if (drag.current.active && drag.current.target !== -1) {
      posVar.material.uniforms.kDrag.value = 20.0;
    } else {
      posVar.material.uniforms.kDrag.value = 0.0;
    }

    // Update simulation uniforms
    posVar.material.uniforms.dt.value = dt
    posVar.material.uniforms.kPressure.value = cfg.pressureK
    posVar.material.uniforms.kShape.value = cfg.kShape
    posVar.material.uniforms.kSpring.value = cfg.kSpring
    posVar.material.uniforms.damping.value = cfg.damping
    posVar.material.uniforms.wallK.value = cfg.wallK
    posVar.material.uniforms.wallDamp.value = cfg.wallDamp
    posVar.material.uniforms.wallDistance.value = cfg.wallDistance
    posVar.material.uniforms.pushStrength.value = cfg.pushStrength

    // Run GPU computation
    posVar.material.uniforms.shapeMatchTex.value = gpu.getCurrentRenderTarget(shapeVar).texture
    posVar.material.uniforms.bboxTex.value = gpu.getCurrentRenderTarget(bboxVar).texture
    posVar.material.uniforms.dragBody.value = drag.current.target ?? -1;
    gpu.compute()


    // Update debug circles
    const rt = gpu.getCurrentRenderTarget(posVar)
    for (let row = 0; row < BODY_COUNT; row++) {
      gl.readRenderTargetPixels(rt, 0, row, cfg.numPoints, 1, rowBuf);
      const instRef = instRefs[row];
      if (instRef?.current) {
        const s = Math.min(viewport.width, viewport.height) * 0.5;
        for (let i = 0; i < cfg.numPoints; ++i) {
          dummy.position.set(rowBuf[i * 4] * s, rowBuf[i * 4 + 1] * s, 0);
          dummy.updateMatrix();
          instRef.current.setMatrixAt(i, dummy.matrix);
        }
        instRef.current.instanceMatrix.needsUpdate = true;
      }
    }

    // Update AABBs
    const bboxBuf = new Float32Array(BODY_COUNT * 4);
    const bboxRT = gpu.getCurrentRenderTarget(bboxVar)
    gl.readRenderTargetPixels(bboxRT, 0, 0, 1, BODY_COUNT, bboxBuf);
    const newAABBs = [];
    for (let i = 0; i < BODY_COUNT; i++) {
      const min = [bboxBuf[i * 4 + 0], bboxBuf[i * 4 + 1]];
      const max = [bboxBuf[i * 4 + 2], bboxBuf[i * 4 + 3]];
      newAABBs.push([min, max]);
    }
    setAABBs(newAABBs);


    // Update GPU uniforms with shape matching data
    const shapeRT = gpu.getCurrentRenderTarget(shapeVar)
    const centerBuf = new Float32Array(BODY_COUNT * 4)
    gl.readRenderTargetPixels(shapeRT, 0, 0, 1, BODY_COUNT, centerBuf)
    const cTmp = Array(BODY_COUNT)
    for (let r = 0; r < BODY_COUNT; r++) {
      cTmp[r] = [centerBuf[r * 4], centerBuf[r * 4 + 1]]
    }
    setCenters(cTmp)
  })
}

// ---------- Full Screen Interaction Component ----------
const FullScreenPickup = ({ onDown, onMove, onUp }) => {
  const { viewport } = useThree()
  return (
    <mesh
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      position={[0, 0, 0.01]}           // Slightly in front of camera
      visible={false}                   // Invisible, doesn't affect rendering
    >
      {/* Plane matching viewport dimensions */}
      <planeGeometry args={[viewport.width, viewport.height]} />
      <meshBasicMaterial transparent opacity={0} />
    </mesh>
  )
}

// ---------- Main Component ----------
export default function SoftBody() {
  const cfg = useSoftBodyConfig()

  const { gpu, posVar, shapeVar, bboxVar } = useGPUComputation(cfg)
  const { centers, setCenters } = useSimulationState()
  const { instRefs, dummy, DebugMeshes } = useInstancedMeshes(cfg.numPoints)
  const { size } = useThree();
  const [aabbs, setAABBs] = useState(() =>
    Array.from({ length: BODY_COUNT }, () => [[0, 0], [0, 0]])
  );

  // Drag interaction state
  const drag = useRef({
    active: false,
    pos: new THREE.Vector2()
  })

  // Convert screen coordinates to simulation space
  const toSimSpace = (x, y) => {
    const s = Math.min(size.width, size.height) * 0.5;     // 與 instancing 相同
    // 先轉到以螢幕中心為 (0,0) 的座標，再除以 s
    return new THREE.Vector2(
      (x - size.width  * 0.5) / s,
      -(y - size.height * 0.5) / s
    );
  };

  const onPointerDown = (e) => {
    const mouseSim = toSimSpace(e.clientX, e.clientY);
    drag.current.active = true;
    drag.current.pos.copy(mouseSim);
  
    // 判斷滑鼠落在哪個 soft-body：中心距離 < 半徑
    drag.current.target = -1;
    for (let row = 0; row < BODY_COUNT; row++) {
      const c = centers[row];                 // [x, y] in sim space
      if (!c) continue;
      const r = BODIES[row].radius;
      const dist2 = (mouseSim.x - c[0])**2 + (mouseSim.y - c[1])**2;
      if (dist2 < r * r) {
        drag.current.target = row;
        break;
      }
    }
  };

  const onPointerMove = (e) => {
    if (!drag.current.active) return;          // 只在拖曳中才管
    drag.current.pos.copy(toSimSpace(e.clientX, e.clientY));
  };


  const onPointerUp = () => (drag.current.target = -1)

  // Run simulation updates
  useSimulationUpdate(cfg, gpu, posVar, shapeVar, bboxVar, setCenters, instRefs, dummy, drag, setAABBs)

  return (
    <group>
      <FullScreenPickup
        onDown={onPointerDown}
        onMove={onPointerMove}
        onUp={onPointerUp}
      />

      {/* Debug points (optional) */}
      {cfg.debugPoints && <DebugMeshes />}

      {cfg.debugAABBs && <DebugAABBs aabbs={aabbs} />}

      {/* Render soft bodies */}
      {BODIES.map((body, row) => (
        <SoftBodyRender
          key={row}
          posTex={gpu.getCurrentRenderTarget(posVar).texture}
          center={centers[row]}         // Centroid from state
          bodyRow={row}
          pointsPer={cfg.numPoints}
          bodyCount={BODY_COUNT}
          color={body.color}
        />
      ))}
    </group>
  )
}
