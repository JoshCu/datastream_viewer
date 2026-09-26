// ====================================================================
// The brush's 3D-terrain form: a translucent sphere drawn by MapLibre as a
// custom "3d" layer, so it shares the terrain's depth buffer. Whatever part
// of the sphere is below ground is hidden by the terrain itself, and it
// shrinks with distance through the camera matrix; nothing here recomputes
// its size per frame.
//
// Owned by sim/brush.js, which decides where the sphere is and how big; this
// module only draws it, and imports nothing.
// ====================================================================

const LAYER_ID = "sim-brush-sphere";
const LAT_BANDS = 16;
const LON_BANDS = 32;

// { x, y, z, r, painting } in MercatorCoordinate units, or null for hidden.
let sphere = null;

const VERTEX_SOURCE = `#version 300 es
uniform mat4 u_matrix;
in vec3 a_pos;
out vec3 v_normal;
void main() {
    v_normal = a_pos;
    gl_Position = u_matrix * vec4(a_pos, 1.0);
}`;

// Mercator axes are x east, y south, z up; the light comes from the
// north-west, high up. A rim term keeps the silhouette readable over the
// basemap's own colours.
const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
uniform float u_alpha;
in vec3 v_normal;
out vec4 fragColor;
void main() {
    vec3 n = normalize(v_normal);
    vec3 l = normalize(vec3(-0.5, -0.6, 0.8));
    float diffuse = max(dot(n, l), 0.0);
    float rim = pow(1.0 - abs(n.z), 3.0);
    vec3 color = vec3(0.0, 0.83, 1.0) * (0.35 + 0.65 * diffuse) + 0.25 * rim;
    fragColor = vec4(color * u_alpha, u_alpha);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`brush sphere shader: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

// A unit UV sphere: positions double as normals.
function sphereMesh() {
  const positions = [];
  for (let i = 0; i <= LAT_BANDS; i++) {
    const theta = (i * Math.PI) / LAT_BANDS;
    for (let j = 0; j <= LON_BANDS; j++) {
      const phi = (j * 2 * Math.PI) / LON_BANDS;
      positions.push(
        Math.sin(theta) * Math.cos(phi),
        Math.sin(theta) * Math.sin(phi),
        Math.cos(theta),
      );
    }
  }
  const indices = [];
  for (let i = 0; i < LAT_BANDS; i++) {
    for (let j = 0; j < LON_BANDS; j++) {
      const a = i * (LON_BANDS + 1) + j;
      const b = a + LON_BANDS + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

// mainMatrix · translate(center) · scale(r), in doubles. Folding the centre
// in here rather than in the shader matters: at street zoom the radius is
// ~1e-6 mercator units, below float32 resolution around the centre's ~0.5.
function sphereMatrix(m, { x, y, z, r }) {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    out[row] = m[row] * r;
    out[4 + row] = m[4 + row] * r;
    out[8 + row] = m[8 + row] * r;
    out[12 + row] = m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row];
  }
  return out;
}

const layer = {
  id: LAYER_ID,
  type: "custom",
  // Required to draw against the terrain's depth.
  renderingMode: "3d",

  onAdd(map, gl) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE));
    gl.linkProgram(program);
    this.program = program;
    this.uMatrix = gl.getUniformLocation(program, "u_matrix");
    this.uAlpha = gl.getUniformLocation(program, "u_alpha");

    const { positions, indices } = sphereMesh();
    this.count = indices.length;
    // Own VAO so binding our attribute doesn't disturb MapLibre's.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  },

  render(gl, args) {
    if (!sphere) return;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(
      this.uMatrix,
      false,
      sphereMatrix(args.defaultProjectionData.mainMatrix, sphere),
    );
    gl.uniform1f(this.uAlpha, sphere.painting ? 0.75 : 0.5);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    // Two passes make it translucent without seeing its own far side:
    // lay down the sphere's nearest depth, then colour only that surface.
    // Both test against the terrain, which is what clips the buried part.
    gl.colorMask(false, false, false, false);
    gl.depthMask(true);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  },
};

// Show the sphere at { x, y, z, r, painting } (mercator units), or hide it
// with null. Adds the layer on first use, on top of everything else.
export function setBrushSphere(map, next) {
  sphere = next;
  if (next && !map.getLayer(LAYER_ID)) map.addLayer(layer);
  if (map.getLayer(LAYER_ID)) map.triggerRepaint();
}
