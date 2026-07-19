import { useEffect, useRef } from "preact/hooks";

/**
 * Decorative full-viewport backdrop: domain-warped fbm smoke drifting up,
 * a molten glow rising from the bottom edge, and sparse embers. Hand-rolled
 * WebGL, no dependencies. Honors prefers-reduced-motion (one static frame),
 * pauses while the tab is hidden, caps at ~30fps, and quietly does nothing
 * when WebGL is unavailable (the stylesheet gradient stays behind it).
 */

const VERTEX_SOURCE = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SOURCE = `
precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = p * 2.03 + vec2(11.7, 5.3);
    amplitude *= 0.55;
  }
  return value;
}

float embers(vec2 uv, float t, float scale, float speed, float threshold) {
  vec2 grid = vec2(scale, scale * 0.6);
  vec2 p = uv * grid;
  p.y -= t * speed;
  vec2 cell = floor(p);
  float seed = hash(cell);
  if (seed < threshold) return 0.0;
  vec2 center = fract(p) - 0.5;
  center.x += (hash(cell + 7.0) - 0.5) * 0.6 + sin(t * 1.7 + seed * 40.0) * 0.12;
  float flicker = 0.55 + 0.45 * sin(t * (2.0 + seed * 4.0) + seed * 90.0);
  float glow = smoothstep(0.16, 0.0, length(center)) * flicker;
  return glow * smoothstep(0.0, 0.25, uv.y) * smoothstep(1.05, 0.55, uv.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 p = uv * aspect;
  float t = u_time;

  vec3 charcoal = vec3(0.047, 0.035, 0.031);
  vec3 crimson = vec3(0.70, 0.07, 0.18);
  vec3 magma = vec3(1.0, 0.24, 0.0);
  vec3 emberTone = vec3(1.0, 0.62, 0.27);
  vec3 smokeTone = vec3(0.36, 0.31, 0.28);

  // Domain-warped smoke, advected upward.
  vec2 drift = vec2(0.02 * sin(t * 0.11), -t * 0.045);
  vec2 warp = vec2(
    fbm(p * 2.1 + drift),
    fbm(p * 2.1 + drift + vec2(4.2, 9.7))
  );
  float smoke = fbm(p * 2.6 + warp * 1.4 + vec2(0.0, -t * 0.09));
  smoke = smoothstep(0.35, 0.95, smoke);

  // Molten glow breathing along the bottom edge.
  float ground = pow(1.0 - uv.y, 3.2);
  float shimmer = 0.55 + 0.45 * fbm(vec2(p.x * 3.4, t * 0.22));
  float heat = ground * shimmer;

  vec3 color = charcoal;
  color += smokeTone * smoke * (0.16 + 0.3 * heat);
  color += mix(crimson, magma, shimmer) * heat * 0.55;
  color += emberTone * pow(heat, 2.4) * 0.5;

  float sparks = embers(uv, t, 26.0, 0.05, 0.965) +
    embers(uv, t, 14.0, 0.028, 0.975) * 1.4;
  color += emberTone * sparks;

  // Vignette so content edges stay quiet.
  float vignette = smoothstep(1.25, 0.45, length(uv - vec2(0.5, 0.42)));
  color *= 0.72 + 0.28 * vignette;

  gl_FragColor = vec4(color, 1.0);
}
`;

const FRAME_INTERVAL_MS = 1000 / 30;
const MAX_PIXEL_RATIO = 1.5;

function compile(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader | null {
  const shader = gl.createShader(kind);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function start(canvas: HTMLCanvasElement): () => void {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) return () => {};

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return () => {};
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return () => {};
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const resolutionUniform = gl.getUniformLocation(program, "u_resolution");
  const timeUniform = gl.getUniformLocation(program, "u_time");

  const resize = () => {
    const ratio = Math.min(globalThis.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  };

  const render = (seconds: number) => {
    resize();
    gl.uniform2f(resolutionUniform, canvas.width, canvas.height);
    gl.uniform1f(timeUniform, seconds);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const reducedMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let lastFrameAt = 0;
  let running = false;

  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    if (now - lastFrameAt < FRAME_INTERVAL_MS) return;
    lastFrameAt = now;
    render(now / 1000);
  };

  const stopLoop = () => {
    running = false;
    cancelAnimationFrame(frame);
  };

  const startLoop = () => {
    if (running || reducedMotion.matches || document.hidden) return;
    running = true;
    frame = requestAnimationFrame(loop);
  };

  const applyMotionPreference = () => {
    stopLoop();
    // A developed, mid-drift frame reads as intentional art when static.
    if (reducedMotion.matches) render(8);
    else startLoop();
  };

  const onVisibility = () => {
    if (document.hidden) stopLoop();
    else startLoop();
  };

  applyMotionPreference();
  reducedMotion.addEventListener("change", applyMotionPreference);
  document.addEventListener("visibilitychange", onVisibility);
  globalThis.addEventListener("resize", resize);

  return () => {
    stopLoop();
    reducedMotion.removeEventListener("change", applyMotionPreference);
    document.removeEventListener("visibilitychange", onVisibility);
    globalThis.removeEventListener("resize", resize);
  };
}

export default function MagmaBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return start(canvas);
  }, []);

  return <canvas ref={canvasRef} class="magma-backdrop" aria-hidden="true" />;
}
