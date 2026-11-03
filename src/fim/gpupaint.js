// ====================================================================
// The flood depth image on the GPU (WebGL2): HAND and the per-cell reach
// number are uploaded once per field as textures, and each timestep only
// uploads the per-reach stage (a few kB); a fragment shader does
// depth = stage[reach] − HAND and the colour ramp for every cell.
//
// The result is a WebGL canvas the map's canvas source (src/fim/fim.js)
// copies from, a GPU-to-GPU copy, instead of a CPU loop over every cell
// plus a putImageData and a full RGBA upload per step.
//
// WebGL2 rather than WebGPU: the map samples the canvas through WebGL, and a
// WebGL canvas with preserveDrawingBuffer is the one every browser lets it
// read back reliably. createGpuPainter() returns null where WebGL2 (or a
// big enough texture) isn't available, and fim.js paints on the CPU.
// ====================================================================

// Reach numbers are looked up in a stage texture this many texels wide.
const STAGE_W = 2048;
// A reach with no stage: below any HAND, so it never floods.
const NO_STAGE = -1e30;

const VERT = `#version 300 es
void main() {
  // One triangle over the whole viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D uHand;
uniform usampler2D uReach;
uniform sampler2D uStage;
uniform int uRows;
uniform vec4 uShallow;
uniform vec4 uDeep;
uniform float uDeepM;
out vec4 color;
void main() {
  // Row 0 of the field is the top of the image.
  ivec2 p = ivec2(int(gl_FragCoord.x), uRows - 1 - int(gl_FragCoord.y));
  uint r = texelFetch(uReach, p, 0).r;
  if (r == 0u) { color = vec4(0.0); return; }
  float s = texelFetch(uStage, ivec2(int(r % ${STAGE_W}u), int(r / ${STAGE_W}u)), 0).r;
  float d = s - texelFetch(uHand, p, 0).r;
  if (!(d > 0.0)) { color = vec4(0.0); return; }
  vec4 c = mix(uShallow, uDeep, min(d / uDeepM, 1.0));
  color = vec4(c.rgb * c.a, c.a); // premultiplied, as the canvas is
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}

function texture(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  // 32-bit float and integer textures can't be filtered; texelFetch anyway.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// `shallow`, `deep`: [r, g, b, a] in 0–255 (straight alpha); `deepM`: the
// depth that reaches `deep`. Returns { canvas, setField, draw } or null.
export function createGpuPainter({ shallow, deep, deepM, maxSide }) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl || gl.getParameter(gl.MAX_TEXTURE_SIZE) < maxSide) return null;
  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  } catch (err) {
    console.warn("Flood map: no GPU painter, using the CPU", err);
    return null;
  }
  gl.useProgram(program);
  const u = (name) => gl.getUniformLocation(program, name);
  gl.uniform1i(u("uHand"), 0);
  gl.uniform1i(u("uReach"), 1);
  gl.uniform1i(u("uStage"), 2);
  gl.uniform4fv(u("uShallow"), shallow.map((v) => v / 255));
  gl.uniform4fv(u("uDeep"), deep.map((v) => v / 255));
  gl.uniform1f(u("uDeepM"), deepM);
  const uRows = u("uRows");
  const handTex = texture(gl);
  const reachTex = texture(gl);
  const stageTex = texture(gl);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  let stageBuf = new Float32Array(0);
  let stageRows = 0;
  let w = 0;
  let h = 0;

  return {
    canvas,
    // A new field: its HAND (Float32Array) and reach numbers (Uint32Array).
    setField(fw, fh, hand, reach) {
      w = fw;
      h = fh;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform1i(uRows, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, handTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, hand);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, reachTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, reach);
      stageRows = 0; // reallocate the stage texture on the next draw
    },
    // Draw with `stage` (Float32Array, by reach number; NaN = none).
    draw(stage) {
      const rows = Math.max(1, Math.ceil(stage.length / STAGE_W));
      if (stageBuf.length !== rows * STAGE_W) stageBuf = new Float32Array(rows * STAGE_W);
      stageBuf.fill(NO_STAGE);
      for (let i = 0; i < stage.length; i++) if (stage[i] === stage[i]) stageBuf[i] = stage[i];
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, stageTex);
      if (rows !== stageRows) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, STAGE_W, rows, 0, gl.RED, gl.FLOAT, stageBuf);
        stageRows = rows;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, STAGE_W, rows, gl.RED, gl.FLOAT, stageBuf);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
