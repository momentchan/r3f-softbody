import * as THREE from 'three'
import React from 'react';
import { useFrame, useThree } from '@react-three/fiber'
import { GPUComputationRenderer } from 'three/examples/jsm/Addons.js'
import { useMemo, useRef, useState } from 'react'
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
      debugPoints: { value: false },
      kShape: { value: 300, min: 0, max: 1000, step: 1 },
      pressureK: { value: 80, min: 0, max: 200, step: 1 },
      kSpring: { value: 40, min: 0, max: 100, step: 1 },
      damping: { value: 2, min: 0, max: 10, step: 0.1 },
      wallK: { value: 300, min: 0, max: 500, step: 10 },
      wallDamp: { value: 5, min: 0, max: 20, step: 0.5 },
      gravityY: { value: -5, min: -20, max: 0, step: 0.5 },
      radius: { value: 0.2, min: 0.05, max: 0.5, step: 0.01 },
      numPoints: { value: 64, min: 16, max: 256, step: 8 },
      wallDistance: { value: 0.9, min: 0, max: 1, step: 0.1, label: 'Wall Distance' }
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
    
    // Initialize texture with rest positions for all bodies
    const restPositionsList = []
    for (let row = 0; row < BODY_COUNT; row++) {
      const restPos = generateRestPositions(BODIES[row].radius, cfg.numPoints)
      restPositionsList.push(restPos)
      
      // Set texture data for this row
      for (let i = 0; i < cfg.numPoints; i++) {
        const [x, y] = restPos[i]
        // Set initial position to rest position offset by the body's center
        tex.image.data.set(
          [x + BODIES[row].center.x, y + BODIES[row].center.y, 0, 0],
          (row * cfg.numPoints + i) * 4
        )
        restTex.image.data.set([x, y, 0, 0], (row * cfg.numPoints + i) * 4)
      }
    }

    // Store rest positions for shape matching
    window.restList = restPositionsList

    // Compute shader source
    const shader = /* glsl */`
      uniform float  dt;
      uniform float  kSpring, damping;
      uniform float  kPressure;
      uniform vec2   gravity;
      uniform float  wallK, wallDamp;
      uniform float  wallDistance;
      uniform float  kShape;

      uniform vec2  dragPos;     // drag position
      uniform float kDrag;       // drag stiffness

      uniform sampler2D restTex;

      const int   I_N = ${cfg.numPoints};
      const int   B_N = ${BODY_COUNT};
      const float F_N = float(${cfg.numPoints});
      
      uniform float radiusArr[B_N];
      uniform vec2 rotArr[B_N];         // rotArr[i] = (cosθi , sinθi)
      uniform vec2 transArr[B_N];       // transArr[i] = centroid Pc_i

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

        vec2 rot = rotArr[body];    // Get rotation for this body
        vec2 trans = transArr[body]; // Get translation for this body

        vec4 p = texture2D(texturePos, uvFromIndex(body, idx));
        vec2 pos = p.xy;
        vec2 vel = p.zw;
        vec2 f = vec2(0.);

        // Spring forces with neighbors (structural)
        for (int off = -1; off <= 1; off += 2) {
          int nIdx = (idx + off + I_N) % I_N;
          vec2 nPos = getPos(body, nIdx).xy;
          vec2 dir = pos - nPos;
          float d = length(dir);
          if (d > 1e-4) dir /= d;
          f += -kSpring * (d - restLen(body)) * dir;
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
        f += kDrag * (dragPos - trans);

        // Semi-implicit Euler integration
        vel += f * dt;
        vel *= exp(-damping * dt);
        pos += vel * dt;

        gl_FragColor = vec4(pos, vel);
      }
    `

    // Add variable and uniforms
    const posVar = gpu.addVariable('texturePos', shader, tex)
    gpu.setVariableDependencies(posVar, [posVar])

    // Initialize arrays for shape matching
    const rotSeed = new Float32Array(BODY_COUNT * 2);   // Initialize with zeros
    const transSeed = new Float32Array(BODY_COUNT * 2);

    Object.assign(posVar.material.uniforms, {
      dt: { value: 0 },
      kSpring: { value: cfg.kSpring },
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
      rotArr: { value: rotSeed },
      transArr: { value: transSeed }
    })

    // Compile and return
    const err = gpu.init()
    if (err) console.error(err)
    return { gpu, posVar }
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

// ---------- Custom Hook: Simulation Update ----------
const useSimulationUpdate = (cfg, gpu, posVar, setCenters, instRefs, dummy, drag) => {
  const { gl, viewport } = useThree()

  const rowBuf = useMemo(() => new Float32Array(cfg.numPoints * 4), [cfg.numPoints])
  const rotData = useMemo(() => new Float32Array(BODY_COUNT * 2), [])
  const transData = useMemo(() => new Float32Array(BODY_COUNT * 2), [])

  useFrame((_, dt) => {
    // Handle drag interaction
    if (drag.current.active) {
      posVar.material.uniforms.kDrag.value = 20.0;          // Much stiffer when dragging
      posVar.material.uniforms.dragPos.value.copy(drag.current.pos);
      posVar.material.uniforms.gravity.value.set(0, 0);     // No gravity while dragging
    } else {
      posVar.material.uniforms.kDrag.value = 0.0;
      posVar.material.uniforms.gravity.value.set(0, cfg.gravityY);
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

    // Run GPU computation
    gpu.compute()

    // Read positions back from GPU
    const rt = gpu.getCurrentRenderTarget(posVar)
    const centersTmp = Array(BODY_COUNT);

    // Process each body
    for (let row = 0; row < BODY_COUNT; row++) {
      // Read one row (pointsPer × 1)
      gl.readRenderTargetPixels(rt, 0, row, cfg.numPoints, 1, rowBuf);

      // Calculate centroid
      let cx = 0, cy = 0;
      for (let i = 0; i < cfg.numPoints; ++i) {
        cx += rowBuf[i * 4];
        cy += rowBuf[i * 4 + 1];
      }
      cx /= cfg.numPoints; 
      cy /= cfg.numPoints;
      centersTmp[row] = [cx, cy];

      // Calculate covariance for shape matching
      const rest = window.restList[row];
      let A = 0, B = 0;
      for (let i = 0; i < cfg.numPoints; ++i) {
        const px = rowBuf[i * 4] - cx;
        const py = rowBuf[i * 4 + 1] - cy;
        const qx = rest[i][0];
        const qy = rest[i][1];
        A += px * qx + py * qy;
        B += py * qx - px * qy;
      }
      const len = Math.hypot(A, B) || 1e-6;
      const cos = A / len;
      const sin = B / len;

      // Pack into uniform arrays
      rotData[row * 2] = cos;
      rotData[row * 2 + 1] = sin;
      transData[row * 2] = cx;
      transData[row * 2 + 1] = cy;

      // Update debug circles (optional)
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

    // Update GPU uniforms with shape matching data
    posVar.material.uniforms.rotArr.value = rotData;
    posVar.material.uniforms.transArr.value = transData;
    setCenters(centersTmp);
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

  const { gpu, posVar } = useGPUComputation(cfg)
  const { centers, setCenters } = useSimulationState()
  const { instRefs, dummy, DebugMeshes } = useInstancedMeshes(cfg.numPoints)
  const { size } = useThree();

  // Drag interaction state
  const drag = useRef({
    active: false,
    pos: new THREE.Vector2()
  })

  // Convert screen coordinates to simulation space
  const toSimSpace = (x, y) => {
    return new THREE.Vector2(
      (x / size.width) * 2 - 1,
      -(y / size.height) * 2 + 1
    )
  }

  // Pointer event handlers
  const onPointerDown = e => {
    drag.current.active = true
    drag.current.pos.copy(toSimSpace(e.clientX, e.clientY))
  }
  
  const onPointerMove = e => {
    if (!drag.current.active) return
    drag.current.pos.copy(toSimSpace(e.clientX, e.clientY))
  }
  
  const onPointerUp = () => (drag.current.active = false)

  // Run simulation updates
  useSimulationUpdate(cfg, gpu, posVar, setCenters, instRefs, dummy, drag)

  return (
    <group>
      <FullScreenPickup
        onDown={onPointerDown}
        onMove={onPointerMove}
        onUp={onPointerUp}
      />

      {/* Debug points (optional) */}
      {cfg.debugPoints && <DebugMeshes />}

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
