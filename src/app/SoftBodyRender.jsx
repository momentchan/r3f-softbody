import * as THREE from 'three'
import { useMemo, useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { useControls, folder } from 'leva'

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
  attribute vec2 uv;
  varying vec2 vUv;
  
  void main () {
      vec2 p = (aIndex < 0.0)
        ? uCenter                           // centroid
        : texture2D(posTex, vec2(aIndex, .5)).xy; // rim
      vec2 world = p * scale;
      gl_Position = projectionMatrix * modelViewMatrix
                  * vec4(world, 0.0, 1.0);
      vUv = uv;
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  precision highp float;
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform vec3  uRimColor;
  uniform float uRimIntensity;
  uniform float uRimWidth;
  varying vec2 vUv;
  
  void main () {
    float d = distance(vUv, vec2(0.5));          // 0 → √0.5 ≈ 0.707
    float rim = smoothstep(0.5- uRimWidth, 0.50, d);   // 1 inside, 0 outside
    rim = step(uRimWidth, d);
    rim = 1.0 - rim;
    gl_FragColor = vec4(uColor, uOpacity * rim);
  }
`;

/* ---------- Custom Hook: Triangle Fan Geometry ---------- */
const useTriangleFanGeometry = (pointCount) => {
    return useMemo(() => {
      const vCount = pointCount + 1;                 // +1 for centroid
      const positions = new Float32Array(vCount * 3); // dummy
      const aIndex = new Float32Array(vCount);
      const uvs = new Float32Array(vCount * 2);       // NEW
      const indexArr = [];
  
      // Center (vertex 0)
      aIndex[0] = -1.0;
      uvs[0] = 0.5;
      uvs[1] = 0.5;
  
      // Rim vertices
      for (let i = 1; i <= pointCount; i++) {
        const angle = ((i - 1) / pointCount) * Math.PI * 2;
        const x = Math.cos(angle);
        const y = Math.sin(angle);
  
        aIndex[i] = (i - 0.5) / pointCount;
        uvs[i * 2 + 0] = x * 0.5 + 0.5;  // map from –1~1 → 0~1
        uvs[i * 2 + 1] = y * 0.5 + 0.5;
  
        indexArr.push(0, i, (i % pointCount) + 1);
      }
  
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('aIndex', new THREE.BufferAttribute(aIndex, 1));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2)); // NEW
      geo.setIndex(indexArr);
  
      return geo;
    }, [pointCount]);
  };

/* ---------- Custom Hook: Render Configuration ---------- */
const useRenderConfig = () => {
    return useControls({
        'Render': folder({
            color: { value: '#62d8ff', label: 'Color' },
            opacity: { value: 0.85, min: 0, max: 1, step: 0.01, label: 'Opacity' },
            visible: { value: true, label: 'Visible' },
            rimWidth: { value: 0.1, min: 0.01, max: 0.5, step: 0.01, label: 'Rim Width' }
        })
    })
}

/* ---------- Custom Hook: Raw Shader Material ---------- */
const useRawShaderMaterial = (center, renderConfig) => {
    return useMemo(() => {
        return new THREE.RawShaderMaterial({
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            // transparent: true,
            side: THREE.DoubleSide,
            uniforms: {
                posTex: { value: null },
                uCenter: { value: new THREE.Vector2(center[0], center[1]) },
                scale: { value: 1.0 },
                uColor: { value: new THREE.Color(renderConfig.color) },
                uOpacity: { value: renderConfig.opacity },
                uRimColor: { value: new THREE.Color(renderConfig.rimColor) },
                uRimIntensity: { value: renderConfig.rimEnabled ? renderConfig.rimIntensity : 0.0 },
                uRimWidth: { value: renderConfig.rimWidth }
            }
        });
    }, []); // create once – textures & color updated per-frame below
}

/* ---------- Custom Hook: Material Updates ---------- */
const useMaterialUpdates = (material, posTex, center, viewport, renderConfig) => {
    useFrame(() => {
        if (!material) return;

        // keep latest render targets
        material.uniforms.posTex.value = posTex;
        material.uniforms.uCenter.value = new THREE.Vector2(center[0], center[1]);
        material.uniforms.uColor.value = new THREE.Color(renderConfig.color);
        material.uniforms.uOpacity.value = renderConfig.opacity;

        // Rim effect updates
        material.uniforms.uRimColor.value = new THREE.Color(renderConfig.rimColor);
        material.uniforms.uRimIntensity.value = renderConfig.rimEnabled ? renderConfig.rimIntensity : 0.0;
        material.uniforms.uRimWidth.value = renderConfig.rimWidth;

        // equal-axis scale → keeps circle from stretching
        const s = Math.min(viewport.width, viewport.height) * 0.5;
        material.uniforms.scale.value = s;
    });
}

/* ---------- Main Component ------------------------------------ */
export default function SoftBodyRender({
    posTex,        // THREE.Texture from GPUComputationRenderer (rim)
    center,
    pointCount = 32 // N – number of rim vertices
}) {
    const { viewport } = useThree();
    const matRef = useRef();
    const renderConfig = useRenderConfig();

    const geometry = useTriangleFanGeometry(pointCount);
    const material = useRawShaderMaterial(center, renderConfig);

    useMaterialUpdates(material, posTex, center, viewport, renderConfig);

    if (!renderConfig.visible) return null;

    return (
        <mesh geometry={geometry} material={material} ref={matRef} />
    );
}
