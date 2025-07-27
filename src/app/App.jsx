import { CameraControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useRef, useEffect, useMemo } from 'react'
import Utilities from "../r3f-gist/utility/Utilities";
import { CustomShaderMaterial } from "../r3f-gist/shader/CustomShaderMaterial";
import fragmentShader from "../shader/test/fragment.glsl";
import { useControls } from 'leva'
import { GPUComputationRenderer } from "three/examples/jsm/Addons.js";
import * as THREE from 'three'

const N = 32
const RADIUS = 1
const K = 40.0
const DAMPING = 2
const REST_LEN = (2 * Math.PI * RADIUS) / N


function GPUPoint() {
    const {gl,viewport} = useThree()

    const { gpu, posVar } = useMemo(() => {
        const gpu = new GPUComputationRenderer(N, 1, gl)

        const tex0 = gpu.createTexture()
        const data = tex0.image.data

        for(let i = 0; i < N; i++){
            const a = (i / N) * 2 * Math.PI

            data[i * 4 + 0] = RADIUS * Math.cos(a) // x
            data[i * 4 + 1] = RADIUS * Math.sin(a) // y
            data[i * 4 + 2] = 0 // vx
            data[i * 4 + 3] = 0 // vy
        }

        const shader =  /*glsl*/`
            uniform float delta;
            uniform float k;
            uniform float damping;
            uniform float restLen;
            const float N = float(${N});

            vec4 getPos(int idx){
                float u = (float(idx) + 0.5) / N;
                return texture2D(texturePos, vec2(u, 0.5));
            }

            void main(){
                int idx = int(gl_FragCoord.x); // 0~N-1
                vec4 p = getPos(idx);

                vec2 pos = p.xy;
                vec2 vel = p.zw;

                // neighbor
                vec2 f = vec2(0.0);
                for(int offset = -1; offset <= 1; offset += 2){
                    int nIdx = (idx + offset + ${N}) % ${N};

                    vec2 nPos = getPos(nIdx).xy;
                    vec2 dir = pos - nPos;

                    float d = length(dir);
                    dir = normalize(dir + 1e-6);
                    f += -k * (d - restLen) * dir;
                }

                // given some random force
                if(idx == 0) f += vec2(0.0, 5.0);

                vel += f * delta;
                vel *= exp(-damping * delta); // damping
                pos += vel * delta;


                if(pos.x>1.0){pos.x = 1.0; vel.x*=-1.0;}
                if(pos.x<-1.0){pos.x = -1.0; vel.x*=-1.0;}
                if(pos.y>1.0){pos.y = 1.0; vel.y*=-1.0;}
                if(pos.y<-1.0){pos.y = -1.0; vel.y*=-1.0;}

                gl_FragColor = vec4(pos, vel);
            }`




        const posVar = gpu.addVariable('texturePos', 
            shader,
            tex0,
        )

        gpu.setVariableDependencies(posVar, [posVar])
        posVar.material.uniforms.delta = { value: 0 }
        posVar.material.uniforms.k = { value: K }
        posVar.material.uniforms.damping = { value: DAMPING }
        posVar.material.uniforms.restLen = { value: REST_LEN }

        gpu.init()
        return { gpu, posVar }
    }, [gl])



    const instRef = useRef()
    const dummy =  useMemo(()=> new THREE.Object3D(),[])
    const buf = useMemo(()=> new Float32Array(N*4),[])


    useFrame((_, delta) => {
        posVar.material.uniforms.delta.value = delta
        gpu.compute()


        const rt = gpu.getCurrentRenderTarget(posVar)
        gl.readRenderTargetPixels(rt, 0,0,N,1,buf)

        for(let i=0; i<N; i++){
            const x = buf[i*4+0] * viewport.width/2
            const y = buf[i*4+1] * viewport.height/2
            dummy.position.set(x,y,0)
            dummy.updateMatrixWorld()
            instRef.current.setMatrixAt(i, dummy.matrix)
        }
        instRef.current.instanceMatrix.needsUpdate = true
    })

    return (
        <instancedMesh ref={instRef} args={[null, null, N]}>
            <circleGeometry args={[0.1, 32]} />
            <meshBasicMaterial color="red" />
        </instancedMesh>
    )
}

export default function App() {
    return <>
        <Canvas
            orthographic
            camera={{
                zoom: 200,
                position: [0, 0, 6]
            }}
            gl={{ preserveDrawingBuffer: true }}
        >
            <CameraControls makeDefault  azimuthRotateSpeed={0} polarRotateSpeed={0} />
            <GPUPoint />
            <Utilities />
        </Canvas>
    </>
}