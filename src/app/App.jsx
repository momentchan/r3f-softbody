import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { CameraControls } from '@react-three/drei'
import SoftBody from './SoftBody'


export default function App () {
  return (
    <Canvas orthographic camera={{ zoom: 200, position: [0,0,6] }}
            gl={{ preserveDrawingBuffer: true }}>
      <CameraControls makeDefault azimuthRotateSpeed={0} polarRotateSpeed={0}/>
      <SoftBody />
    </Canvas>
  )
}
