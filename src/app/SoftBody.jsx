import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { GPUComputationRenderer } from 'three/examples/jsm/Addons.js'
import { useMemo, useRef, useState } from 'react'
import { useControls, folder } from 'leva'
import SoftBodyRender from './SoftBodyRender'

// ---------- Helper: generate rest positions on a circle ----------
const genRest = (n, r) => [...Array(n)].map((_, i) => {
  const a = (i / n) * Math.PI * 2
  return [r * Math.cos(a), r * Math.sin(a)]
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
const useGPUComputation = (cfg, restPos) => {
  const { gl } = useThree()

  return useMemo(() => {
    // -- 1. create GPUCompute instance & seed texture --
    const gpu = new GPUComputationRenderer(cfg.numPoints, 1, gl)
    const tex = gpu.createTexture()
    tex.image.data.set(
      restPos.flatMap(([x, y]) => [x, y, 0, 0])
    )

    // -- 2. embed rest positions as GLSL constant array string --
    const restGLSL = restPos
      .map(([x, y]) => `vec2(${x.toFixed(5)},${y.toFixed(5)})`)
      .join(',')

    // -- 3. compute shader source --
    const shader = /* glsl */`
      uniform float  dt;
      uniform float  kSpring, damping;
      uniform float  restLen;
      uniform float  areaRest, kPressure;
      uniform vec2   gravity;
      uniform float  wallK, wallDamp;
      uniform float  wallDistance;
      uniform vec2   rot;        // cosθ, sinθ
      uniform vec2   trans;      // translation
      uniform float  kShape;

      uniform vec2  dragPos;     // 
      uniform float kDrag;       // 

      const int   I_N = ${cfg.numPoints};
      const float F_N = float(${cfg.numPoints});
      const vec2  qRest[I_N] = vec2[](${restGLSL});

      // ------- helpers -------
      vec4 getPos (int idx) {
        float u = (float(idx) + 0.5) / F_N;
        return texture2D(texturePos, vec2(u, 0.5));
      }

      vec2 wallForce (vec2 pos, vec2 vel) {
        vec2 f = vec2(0.);
        // right
        if (pos.x > wallDistance) {
          float p = pos.x - wallDistance;
          vec2  n = vec2(1.,0.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        // left
        else if (pos.x < -wallDistance) {
          float p = -wallDistance - pos.x;
          vec2  n = vec2(-1.,0.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        // top
        if (pos.y > wallDistance) {
          float p = pos.y - wallDistance;
          vec2  n = vec2(0.,1.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        // bottom
        else if (pos.y < -wallDistance) {
          float p = -wallDistance - pos.y;
          vec2  n = vec2(0.,-1.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        return f;
      }

      // ------- main update -------
      void main () {
        int  idx = int(gl_FragCoord.x);
        vec4 p   = getPos(idx);
        vec2 pos = p.xy;
        vec2 vel = p.zw;
        vec2 f   = vec2(0.);

        // spring with neighbours (structural)
        for (int off = -1; off <= 1; off += 2) {
          int nIdx   = (idx + off + I_N) % I_N;
          vec2 nPos  = getPos(nIdx).xy;
          vec2 dir   = pos - nPos;
          float d    = length(dir);
          if (d > 1e-4) dir /= d;
          f += -kSpring * (d - restLen) * dir;
        }

        // internal pressure (2-D gas model)
        float area = 0.;
        for (int i = 0; i < I_N; ++i) {
          vec2 p0 = getPos(i).xy;
          vec2 p1 = getPos((i+1)%I_N).xy;
          area += p0.x*p1.y - p1.x*p0.y;
        }
        area = 0.5 * abs(area);
        float press = kPressure * (areaRest - area) / areaRest;
        vec2  prev  = getPos((idx + I_N-1)%I_N).xy;
        vec2  next  = getPos((idx + 1)%I_N).xy;
        vec2  edge  = next - prev;
        vec2  nrm   = normalize(vec2(edge.y, -edge.x) + 1e-4);
        f += press * nrm / F_N;

        // gravity & walls
        f += gravity;
        f += wallForce(pos, vel);

        // shape matching (goal = R·q + T)
        vec2 q    = qRest[idx];
        vec2 goal = vec2(
          rot.x*q.x - rot.y*q.y,
          rot.y*q.x + rot.x*q.y
        ) + trans;
        f += kShape * (goal - pos);


        f += kDrag * (dragPos - trans);

        // semi-implicit Euler
        vel += f * dt;
        vel *= exp(-damping * dt);
        pos += vel * dt;

        gl_FragColor = vec4(pos, vel);
      }
    `

    // -- 4. add variable & uniforms --
    const posVar = gpu.addVariable('texturePos', shader, tex)
    gpu.setVariableDependencies(posVar, [posVar])

    Object.assign(posVar.material.uniforms, {
      dt: { value: 0 },
      kSpring: { value: cfg.kSpring },
      damping: { value: cfg.damping },
      restLen: { value: (2 * Math.PI * cfg.radius) / cfg.numPoints },
      areaRest: { value: Math.PI * cfg.radius * cfg.radius },
      kPressure: { value: cfg.pressureK },
      gravity: { value: new THREE.Vector2(0, cfg.gravityY) },
      wallK: { value: cfg.wallK },
      wallDamp: { value: cfg.wallDamp },
      wallDistance: { value: cfg.wallDistance },
      rot: { value: new THREE.Vector2(1, 0) }, // cos, sin
      trans: { value: new THREE.Vector2() },
      kShape: { value: cfg.kShape },
      dragPos: { value: new THREE.Vector2() },
      kDrag: { value: 0.0 }
    })

    // -- 5. compile & return --
    const err = gpu.init()
    if (err) console.error(err)
    return { gpu, posVar }
  }, [gl, restPos, cfg.numPoints, cfg.radius])
}

// ---------- Custom Hook: Simulation State ----------
const useSimulationState = (cfg) => {
  const [center, setCenter] = useState([0, 0])
  const buf = useMemo(() => new Float32Array(cfg.numPoints * 4), [cfg.numPoints])

  return { center, setCenter, buf }
}

// ---------- Custom Hook: Instanced Mesh ----------
const useInstancedMesh = (cfg) => {
  const instRef = useRef()
  const dummy = useMemo(() => new THREE.Object3D(), [])

  return { instRef, dummy }
}

// ---------- Custom Hook: Simulation Update ----------
const useSimulationUpdate = (cfg, gpu, posVar, restPos, buf, setCenter, instRef, dummy, drag) => {
  const { gl, viewport } = useThree()

  useFrame((_, dt) => {

    if (drag.current.active) {
      posVar.material.uniforms.kDrag.value = 20.0;          // much stiffer
      posVar.material.uniforms.dragPos.value.copy(drag.current.pos);
      posVar.material.uniforms.gravity.value.set(0, 0);         // no gravity while dragging
    } else {
      posVar.material.uniforms.kDrag.value = 0.0;
      posVar.material.uniforms.gravity.value.set(0, cfg.gravityY);
    }

    // 1. run GPU simulation
    posVar.material.uniforms.dt.value = dt
    posVar.material.uniforms.kPressure.value = cfg.pressureK
    posVar.material.uniforms.kShape.value = cfg.kShape
    posVar.material.uniforms.kSpring.value = cfg.kSpring
    posVar.material.uniforms.damping.value = cfg.damping
    posVar.material.uniforms.wallK.value = cfg.wallK
    posVar.material.uniforms.wallDamp.value = cfg.wallDamp
    posVar.material.uniforms.wallDistance.value = cfg.wallDistance
    // posVar.material.uniforms.gravity.value = new THREE.Vector2(0, cfg.gravityY)
    posVar.material.uniforms.restLen.value = (2 * Math.PI * cfg.radius) / cfg.numPoints
    posVar.material.uniforms.areaRest.value = Math.PI * cfg.radius * cfg.radius
    gpu.compute()

    // 2. read positions back
    const rt = gpu.getCurrentRenderTarget(posVar)
    gl.readRenderTargetPixels(rt, 0, 0, cfg.numPoints, 1, buf)

    // 3. compute centroid & covariance (for shape matching)
    let cx = 0, cy = 0
    for (let i = 0; i < cfg.numPoints; i++) {
      cx += buf[4 * i];
      cy += buf[4 * i + 1]
    }
    cx /= cfg.numPoints;
    cy /= cfg.numPoints

    setCenter([cx, cy])

    let a = 0, b = 0
    for (let i = 0; i < cfg.numPoints; i++) {
      const px = buf[4 * i] - cx
      const py = buf[4 * i + 1] - cy
      const q = restPos[i]
      a += px * q[0] + py * q[1]
      b += py * q[0] - px * q[1]
    }
    const len = Math.hypot(a, b) || 1e-6
    const cos = a / len, sin = b / len

    posVar.material.uniforms.rot.value.set(cos, sin)
    posVar.material.uniforms.trans.value.set(cx, cy) // rest centroid is (0,0)

    const w2 = viewport.width * 0.5  // world half-width
    const h2 = viewport.height * 0.5  // world half-height

    const s = Math.min(w2, h2)

    // Only update instanced mesh if debug points are enabled
    if (instRef.current) {
      for (let i = 0; i < cfg.numPoints; i++) {
        dummy.position.set(
          buf[4 * i] * s,   // 同一倍率 s
          buf[4 * i + 1] * s,
          0
        )
        dummy.updateMatrix()
        instRef.current.setMatrixAt(i, dummy.matrix)
      }
      instRef.current.instanceMatrix.needsUpdate = true
    }
  })
}

const FullScreenPickup = ({ onDown, onMove, onUp }) => {
  const { viewport } = useThree()
  return (
    <mesh
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      position={[0, 0, 0.01]}           // 放在鏡頭前一點點
      visible={false}                   // 不影響畫面
    >
      {/* 視口寬高對應一面平面 */}
      <planeGeometry args={[viewport.width, viewport.height]} />
      <meshBasicMaterial transparent opacity={0} />
    </mesh>
  )
}

// ---------- Main Component ----------
export default function SoftBody() {
  const cfg = useSoftBodyConfig()
  const restPos = useMemo(() => genRest(cfg.numPoints, cfg.radius), [cfg.numPoints, cfg.radius])

  const { gpu, posVar } = useGPUComputation(cfg, restPos)
  const { center, setCenter, buf } = useSimulationState(cfg)
  const { instRef, dummy } = useInstancedMesh(cfg)
  const { size } = useThree();              // or useThree()


  const drag = useRef({
    active: false,
    pos: new THREE.Vector2()
  })

  const toSim = (x, y) => {
    return new THREE.Vector2(
      (x / size.width) * 2 - 1,
      -(y / size.height) * 2 + 1
    )
  }

  const onPointerDown = e => {
    drag.current.active = true
    drag.current.pos.copy(toSim(e.clientX, e.clientY))
  }
  const onPointerMove = e => {
    if (!drag.current.active) return
    drag.current.pos.copy(toSim(e.clientX, e.clientY))
  }
  const onPointerUp = () => (drag.current.active = false)

  useSimulationUpdate(cfg, gpu, posVar, restPos, buf, setCenter, instRef, dummy, drag)

  return (
    <group
    >
      <FullScreenPickup
        onDown={onPointerDown}
        onMove={onPointerMove}
        onUp={onPointerUp}
      />

      {cfg.debugPoints && (
        <instancedMesh ref={instRef} args={[null, null, cfg.numPoints]}>
          <circleGeometry args={[0.01, 16]} />
          <meshBasicMaterial color="#ff4040" />
        </instancedMesh>
      )}

      {gpu.getCurrentRenderTarget(posVar).texture && (
        <SoftBodyRender
          posTex={gpu.getCurrentRenderTarget(posVar).texture}
          center={center}
          pointCount={cfg.numPoints}
        />
      )}
    </group>
  )
}
