// WebGL1 着色器源码, 立方体与 2D 矩形共用同一套帧采样逻辑, 静态贴图的帧参数为 0 与 1
export const CUBE_VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec2 aUv;
attribute float aShade;
uniform mat4 uMvp;
varying vec2 vUv;
varying float vShade;
void main() {
  gl_Position = uMvp * vec4(aPosition, 1.0);
  vUv = aUv;
  vShade = aShade;
}
`

export const CUBE_FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTexture;
uniform float uFrame;
uniform float uNextFrame;
uniform float uMix;
uniform float uFrameScale;
varying vec2 vUv;
varying float vShade;
void main() {
  vec4 current = texture2D(uTexture, vec2(vUv.x, (uFrame + vUv.y) * uFrameScale));
  vec4 next = texture2D(uTexture, vec2(vUv.x, (uNextFrame + vUv.y) * uFrameScale));
  vec4 color = mix(current, next, uMix);
  if (color.a < 0.5) discard;
  gl_FragColor = vec4(color.rgb * vShade, 1.0);
}
`

export const QUAD_VERTEX_SHADER = `
attribute vec2 aCorner;
uniform vec4 uRect;
uniform vec2 uViewport;
varying vec2 vUv;
void main() {
  vec2 pixel = uRect.xy + aCorner * uRect.zw;
  vec2 clip = vec2(pixel.x / uViewport.x * 2.0 - 1.0, 1.0 - pixel.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = aCorner;
}
`

export const QUAD_FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTexture;
uniform float uFrame;
uniform float uNextFrame;
uniform float uMix;
uniform float uFrameScale;
uniform vec4 uTint;
varying vec2 vUv;
void main() {
  vec4 current = texture2D(uTexture, vec2(vUv.x, (uFrame + vUv.y) * uFrameScale));
  vec4 next = texture2D(uTexture, vec2(vUv.x, (uNextFrame + vUv.y) * uFrameScale));
  vec4 color = mix(current, next, uMix) * uTint;
  if (color.a < 0.01) discard;
  gl_FragColor = color;
}
`
