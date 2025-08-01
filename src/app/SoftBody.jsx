import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { GPUComputationRenderer } from 'three/examples/jsm/Addons.js'
import { useMemo, useRef } from 'react'
import { useControls } from 'leva'

// ---------- Simulation constants ----------
const GRAVITY_Y   = -5               // default gravity Y value

// ---------- Helper: generate rest positions on a circle ----------
const genRest = (n, r) => [...Array(n)].map((_, i) => {
  const a = (i / n) * Math.PI * 2
  return [r * Math.cos(a), r * Math.sin(a)]
})

export default function SoftBody () {

  const { gl, viewport } = useThree()
  const { 
    kShape, 
    pressureK, 
    kSpring, 
    damping, 
    wallK, 
    wallDamp, 
    gravityY,
    radius,
    numPoints
  } = useControls({
    kShape   : { value: 60, min: 0, max: 200, step: 1 },
    pressureK: { value: 80, min: 0, max: 200, step: 1 },
    kSpring  : { value: 40, min: 0, max: 100, step: 1 },
    damping  : { value: 2, min: 0, max: 10, step: 0.1 },
    wallK    : { value: 300, min: 0, max: 500, step: 10 },
    wallDamp : { value: 5, min: 0, max: 20, step: 0.5 },
    gravityY : { value: GRAVITY_Y, min: -20, max: 0, step: 0.5 },
    radius   : { value: 0.2, min: 0.05, max: 0.5, step: 0.01 },
    numPoints: { value: 32, min: 16, max: 64, step: 8 }
  })
  const restPos          = useMemo(() => genRest(numPoints, radius), [numPoints, radius])

  /* ---------- GPUComputationRenderer init (reactive) ---------- */
  const { gpu, posVar } = useMemo(() => {

    // -- 1. create GPUCompute instance & seed texture --
    const gpu = new GPUComputationRenderer(numPoints, 1, gl)
    const tex = gpu.createTexture()
    for (let i = 0; i < numPoints; i++) {
      const a = (i / numPoints) * 2 * Math.PI
      tex.image.data.set([
        radius * Math.cos(a),        // x
        radius * Math.sin(a),        // y
        0,                           // vx
        0                            // vy
      ], i * 4)
    }

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
      uniform vec2   rot;        // cosθ, sinθ
      uniform vec2   trans;      // translation
      uniform float  kShape;

      const int   I_N = ${numPoints};
      const float F_N = float(${numPoints});
      const vec2  qRest[I_N] = vec2[](${restGLSL});

      // ------- helpers -------
      vec4 getPos (int idx) {
        float u = (float(idx) + 0.5) / F_N;
        return texture2D(texturePos, vec2(u, 0.5));
      }

      vec2 wallForce (vec2 pos, vec2 vel) {
        vec2 f = vec2(0.);
        // right
        if (pos.x > 1.) {
          float p = pos.x - 1.;
          vec2  n = vec2(1.,0.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        // left
        else if (pos.x < -1.) {
          float p = -1. - pos.x;
          vec2  n = vec2(-1.,0.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        // top
        if (pos.y > 1.) {
          float p = pos.y - 1.;
          vec2  n = vec2(0.,1.);
          f += -wallK * p * n - wallDamp * dot(vel,n) * n;
        }
        // bottom
        else if (pos.y < -1.) {
          float p = -1. - pos.y;
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
      dt         : { value: 0 },
      kSpring    : { value: kSpring },
      damping    : { value: damping },
      restLen    : { value: (2*Math.PI*radius)/numPoints },
      areaRest   : { value: Math.PI * radius * radius },
      kPressure  : { value: pressureK },
      gravity    : { value: new THREE.Vector2(0, gravityY) },
      wallK      : { value: wallK },
      wallDamp   : { value: wallDamp },
      rot        : { value: new THREE.Vector2(1,0) }, // cos, sin
      trans      : { value: new THREE.Vector2() },
      kShape     : { value: kShape }
    })

    // -- 5. compile & return --
    const err = gpu.init()
    if (err) console.error(err)
    return { gpu, posVar }
  }, [gl, restPos, numPoints, radius])

  /* ---------- instanced circles ---------- */
  const instRef = useRef()
  const dummy   = useMemo(() => new THREE.Object3D(), [])
  const buf     = useMemo(() => new Float32Array(numPoints * 4), [numPoints])

  /* ---------- per-frame update ---------- */
  useFrame((_, dt) => {
    // 1. run GPU simulation
    posVar.material.uniforms.dt.value       = dt
    posVar.material.uniforms.kPressure.value= pressureK
    posVar.material.uniforms.kShape.value   = kShape
    posVar.material.uniforms.kSpring.value  = kSpring
    posVar.material.uniforms.damping.value  = damping
    posVar.material.uniforms.wallK.value    = wallK
    posVar.material.uniforms.wallDamp.value = wallDamp
    posVar.material.uniforms.gravity.value  = new THREE.Vector2(0, gravityY)
    posVar.material.uniforms.restLen.value  = (2*Math.PI*radius)/numPoints
    posVar.material.uniforms.areaRest.value = Math.PI * radius * radius
    gpu.compute()

    // 2. read positions back (numPoints → negligible)
    const rt = gpu.getCurrentRenderTarget(posVar)
    gl.readRenderTargetPixels(rt, 0, 0, numPoints, 1, buf)

    // 3. compute centroid & covariance (for shape matching)
    let cx=0, cy=0
    for (let i=0;i<numPoints;i++){ cx+=buf[4*i]; cy+=buf[4*i+1] }
    cx/=numPoints; cy/=numPoints
    let a=0,b=0
    for (let i=0;i<numPoints;i++){
      const px = buf[4*i]   - cx
      const py = buf[4*i+1] - cy
      const q  = restPos[i]
      a += px*q[0] + py*q[1]
      b += py*q[0] - px*q[1]
    }
    const len = Math.hypot(a,b) || 1e-6
    const cos = a/len, sin = b/len

    posVar.material.uniforms.rot.value.set(cos, sin)
    posVar.material.uniforms.trans.value.set(cx, cy) // rest centroid is (0,0)

    // 4. update instanced mesh transforms
    for (let i=0;i<numPoints;i++){
      dummy.position.set(buf[4*i], buf[4*i+1], 0)
      dummy.updateMatrix()
      instRef.current.setMatrixAt(i, dummy.matrix)
    }
    instRef.current.instanceMatrix.needsUpdate = true
  })

  /* ---------- JSX ---------- */
  return (
    <instancedMesh ref={instRef} args={[null, null, numPoints]}>
      <circleGeometry args={[0.01, 16]} />
      <meshBasicMaterial color="#ff4040" />
    </instancedMesh>
  )
}
