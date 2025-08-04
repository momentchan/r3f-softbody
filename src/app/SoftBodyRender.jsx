/**************************************************************************
 *  SoftBodyRender – multi-row version
 **************************************************************************/
import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { useControls, folder } from 'leva';

/* ---------- GLSL ------------------------------------------------------ */

const VERTEX_SHADER = /* glsl */`
precision highp float;

uniform sampler2D posTex;

uniform vec2  uCenter;
uniform float scale;

uniform float uBodyRow;     // 0,1,2…
uniform float uBodyCount;   // total rows
uniform float uPointsPer;   // vertices per body (N)

uniform mat4  projectionMatrix;
uniform mat4  modelViewMatrix;

attribute float aIndex;     // local vertex index  (0..N-1)  – or -1 for center
attribute vec2  uv;         // pre-baked static UV
varying   vec2  vUv;

/* helper: convert (row , col) → texcoord */
vec2 texUV(float row, float col){
    return vec2( (col + 0.5) / uPointsPer,
                 (row + 0.5) / uBodyCount );
}

void main () {

    vec2 p;
    if (aIndex < 0.0) {
        p = uCenter;                           // centroid vertex
    } else {
        float col = aIndex;                    // 0…N-1
        vec2  posSample = texture2D(
            posTex, texUV(uBodyRow, col)
        ).xy;
        p = posSample;
    }

    vUv = uv;                                  // fixed rim-UV

    vec2 world = p * scale;
    gl_Position = projectionMatrix * modelViewMatrix
                * vec4(world, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */`
precision highp float;

uniform vec3  uColor;
uniform float uOpacity;
uniform float uRimWidth;      // 0–0.5
uniform float uRimIntensity;  // >1 for glow

varying vec2 vUv;

void main () {
    float d   = distance(vUv, vec2(0.5));
    float rim = smoothstep(0.5 - uRimWidth, 0.5, d);   // 0 center →1 edge
    vec3  col = mix(uColor, uColor * uRimIntensity, rim);
    gl_FragColor = vec4(col, uOpacity * rim);
}
`;

/* ---------- Geometry (unchanged) -------------------------------------- */
const useTriangleFanGeometry = (pointsPer) => useMemo(() => {
  const vCount = pointsPer + 1;                 // +1 centre
  const posArr = new Float32Array(vCount * 3);  // dummy
  const aIdx   = new Float32Array(vCount);
  const uvs    = new Float32Array(vCount * 2);
  const idxArr = [];

  /* centre vertex */
  aIdx[0] = -1.0;
  uvs[0] = 0.5; uvs[1] = 0.5;

  /* rim */
  for (let i = 1; i <= pointsPer; i++) {
    const a = (i - 1) / pointsPer * Math.PI * 2;
    uvs[i*2]   = 0.5 + 0.5 * Math.cos(a);
    uvs[i*2+1] = 0.5 + 0.5 * Math.sin(a);

    aIdx[i] = i - 1;                        // local col index 0…N-1
    idxArr.push(0, i, (i % pointsPer) + 1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  g.setAttribute('aIndex',   new THREE.BufferAttribute(aIdx, 1));
  g.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idxArr);
  return g;
}, [pointsPer]);

/* ---------- Leva controls --------------------------------------------- */
const useRenderConfig = () =>
  useControls({
    Render: folder({
      color:      { value: '#62d8ff' },
      opacity:    { value: 0.9,  min:0, max:1 },
      rimWidth:   { value: 0.08, min:0.01, max:0.25 },
      rimIntensity:{ value: 1.4, min:1, max:4 },
      visible:    true
    })
  });

/* ---------- Material factory ------------------------------------------ */
const makeMaterial = (renderCfg) => new THREE.RawShaderMaterial({
  vertexShader  : VERTEX_SHADER,
  fragmentShader: FRAGMENT_SHADER,
  transparent   : true,
  side          : THREE.DoubleSide,
  uniforms: {
    /* filled per-frame in useFrame */
    posTex     : { value: null },
    uCenter    : { value: new THREE.Vector2() },
    uBodyRow   : { value: 0 },
    uBodyCount : { value: 1 },
    uPointsPer : { value: 1 },
    scale      : { value: 1 },

    /* static / Leva-controlled  */
    uColor        : { value: new THREE.Color(renderCfg.color) },
    uOpacity      : { value: renderCfg.opacity },
    uRimWidth     : { value: renderCfg.rimWidth },
    uRimIntensity : { value: renderCfg.rimIntensity },
  }
});

/* ---------- Main component -------------------------------------------- */
export default function SoftBodyRender({
  posTex,          // shared position texture
  center,          // [cx,cy] current centroid
  bodyRow,         // 0,1,2…
  pointsPer,       // N
  bodyCount        // M (rows)
}) {
  const { viewport } = useThree();
  const renderCfg    = useRenderConfig();
  const geom         = useTriangleFanGeometry(pointsPer);
  const mat          = useMemo(() => makeMaterial(renderCfg), []);

  /* per-frame updates */
  useFrame(() => {
    /* skip when not visible */
    if (!renderCfg.visible) return;

    /* dynamic uniforms */
    mat.uniforms.posTex.value      = posTex;
    mat.uniforms.uCenter.value.set(center[0], center[1]);
    mat.uniforms.uBodyRow.value    = bodyRow;
    mat.uniforms.uBodyCount.value  = bodyCount;
    mat.uniforms.uPointsPer.value  = pointsPer;

    mat.uniforms.uColor.value.set(renderCfg.color);
    mat.uniforms.uOpacity.value    = renderCfg.opacity;
    mat.uniforms.uRimWidth.value   = renderCfg.rimWidth;
    mat.uniforms.uRimIntensity.value = renderCfg.rimIntensity;

    mat.uniforms.scale.value =
      Math.min(viewport.width, viewport.height) * 0.5;
  });

  if (!renderCfg.visible) return null;
  return <mesh geometry={geom} material={mat} />;
}
