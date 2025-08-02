import * as THREE from 'three'
import { useMemo, useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'

/* ---------- GLSL Shaders ------------------------------------------------ */

const VERTEX_SHADER = /* glsl */`
  precision highp float;

  uniform sampler2D posTex;   // rim positions
  uniform vec2      uCenter;  // centroid (x,y)
  uniform float     scale;

  uniform mat4 projectionMatrix;
  uniform mat4 modelViewMatrix;

  attribute float   aIndex;   // < 0 → centroid, else (i+0.5)/N
  
  attribute vec3 position;   // 必須存在，即使你不用它
  
  void main () {
      vec2 p = (aIndex < 0.0)
        ? uCenter                           // centroid
        : texture2D(posTex, vec2(aIndex, .5)).xy; // rim
      vec2 world = p * scale;
      gl_Position = projectionMatrix * modelViewMatrix
                  * vec4(world, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  precision highp float;
  uniform vec3  uColor;
  uniform float uOpacity;
  void main () {
    gl_FragColor = vec4(uColor, uOpacity);
  }
`;

/* ---------- Custom Hook: Triangle Fan Geometry ---------- */
const useTriangleFanGeometry = (pointCount) => {
  return useMemo(() => {
    const vCount = pointCount + 1;          // +1 for centroid
    const positions = new Float32Array(vCount * 3); // dummy, will be ignored
    const aIndex = new Float32Array(vCount);
    const indexArr = [];

    // vertex 0 : centroid, mark with -1.0
    aIndex[0] = -1.0;

    // rim vertices
    for (let i = 1; i <= pointCount; i++) {
      aIndex[i] = (i - 0.5) / pointCount;     // u coord for tex fetch
      indexArr.push(0, i, (i % pointCount) + 1); // fan indices
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aIndex', new THREE.BufferAttribute(aIndex, 1));
    geo.setIndex(indexArr);
    return geo;
  }, [pointCount]);
}

/* ---------- Custom Hook: Raw Shader Material ---------- */
const useRawShaderMaterial = (center, color, opacity) => {
  return useMemo(() => {
    return new THREE.RawShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      side: THREE.DoubleSide,
      uniforms: {
        posTex: { value: null },
        uCenter: { value: new THREE.Vector2(center[0], center[1]) },
        scale: { value: 1.0 },
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: opacity }
      }
    });
  }, []); // create once – textures & color updated per-frame below
}

/* ---------- Custom Hook: Material Updates ---------- */
const useMaterialUpdates = (material, posTex, center, viewport) => {
  useFrame(() => {
    if (!material) return;

    // keep latest render targets
    material.uniforms.posTex.value = posTex;
    material.uniforms.uCenter.value = new THREE.Vector2(center[0], center[1]);

    // equal-axis scale → keeps circle from stretching
    const s = Math.min(viewport.width, viewport.height) * 0.5;
    material.uniforms.scale.value = s;
  });
}

/* ---------- Main Component ------------------------------------ */
export default function SoftBodyRender({
  posTex,        // THREE.Texture from GPUComputationRenderer (rim)
  center,
  pointCount = 32, // N – number of rim vertices
  color = '#ff8888',
  opacity = 0.85
}) {
  const { viewport } = useThree();
  const matRef = useRef();

  const geometry = useTriangleFanGeometry(pointCount);
  const material = useRawShaderMaterial(center, color, opacity);
  
  useMaterialUpdates(material, posTex, center, viewport);

  return (
    <mesh geometry={geometry} material={material} ref={matRef} />
  );
}
