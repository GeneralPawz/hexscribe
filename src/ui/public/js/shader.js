/**
 * The drop zone, alive — and doubling as the only progress indicator there is.
 *
 * An idle drop zone has nothing to say, and an indeterminate progress bar says
 * the wrong thing: it implies work is happening. So a slow field of drifting
 * bands sits behind the drop zone, and the same field carries the state of the
 * run — waiting drifts in the accent colour, working runs fast and amber, and a
 * finished transcript settles into green and stays there until the next file.
 *
 * Three named states, not a ramp: a colour halfway between "waiting" and "done"
 * is not something a person can read, and the honest progress number lives in
 * the label underneath where it can say it is an estimate.
 *
 * Deliberately small: ~40 lines of GLSL and one WebGL call per frame, no
 * library, no build step. If anything fails — no WebGL, a driver that refuses
 * the shader, a lost context — the canvas is removed and the plain CSS drop zone
 * is what remains, so this can only ever be decoration.
 *
 * It also stops rendering when it cannot be seen (tab hidden, scrolled away) and
 * draws a single frame when the reader asked for reduced motion.
 */

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAGMENT = `
// highp where the device has it. mediump carries roughly ten bits of mantissa,
// and uTime grows without bound -- at low precision the drift goes jerky and
// then effectively freezes after a few minutes on screen. The guard is the
// standard one; mediump remains the fallback, and the field below is built to
// survive it.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uSize;
uniform float uTime;
uniform float uEnergy;  // 0 calm .. 1 working: speed, mostly
uniform vec3 uTint;     // eased on the CPU, so the colour is a state, not a ramp
uniform float uDark;

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float aspect = uSize.x / max(uSize.y, 1.0);
  float x = uv.x * aspect;

  // Energy is speed. It used to carry brightness with it, which meant the calm
  // states were also the dim ones -- and "calm" is the state the page spends
  // most of its life in, so it was faint exactly when it had something to say.
  // Brightness now barely moves; the tempo does the talking.
  //
  // The top of the range is deliberately short of what the hardware could do.
  // "Working" has to read as faster than "waiting" -- about two and a half times
  // here -- without reading as *racing*, which is a different feeling and the
  // wrong one: it says something is wrong, not that something is happening.
  float t = uTime * (0.05 + uEnergy * 0.45);

  // Drift from three incommensurate sines rather than value noise.
  //
  // The noise this replaced needed a sin-based hash sampled on an axis-aligned
  // lattice, and its sample point drifted with time. On a tile-based mobile GPU
  // that hash loses precision as the coordinate grows and the lattice surfaces
  // as horizontal and vertical seams -- the exact artefact this effect exists to
  // avoid. Bounded sines have no lattice and no precision cliff.
  float warp = 0.040 * sin(x * 2.7 - t * 1.3)
             + 0.026 * sin(x * 4.3 + t * 0.9 + 1.7)
             + 0.018 * sin(x * 1.3 + t * 1.7 + 4.2);

  float field = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float phase = t * (0.9 + fi * 0.4) + fi * 2.1;
    float y = uv.y - 0.5
            + sin(x * (1.7 + fi * 0.8) + phase) * (0.09 + uEnergy * 0.05)
            + warp;
    // Gaussian, not exp(-|y|): an absolute value creases at the band centre, and
    // that crease renders as a bright hairline the full width of the frame.
    // Matched to the previous profile's half-width: k = ln2 / h^2, so the
    // strands stay as narrow as they were. Too small a k and the three merge
    // into one blob.
    float k = 70.0 + fi * 130.0;
    field += exp(-y * y * k) * (0.55 - fi * 0.13);
  }

  // Nearly flat across the states, and deliberately so: the light theme boosts
  // alpha by 1.55 to carry on white, so a brighter "working" state clipped the
  // band cores into one solid stroke instead of a wash. Every state now sits
  // around the value the idle field was tuned to in both themes.
  float alpha = clamp(field * (0.46 + uEnergy * 0.06), 0.0, 1.0);

  // Fade to nothing before the frame, so a band never ends mid-stroke. Doing it
  // here rather than with a CSS mask keeps the falloff visible and adjustable:
  // the mask this replaced was fully opaque at the box's own left and right
  // edges, which is what made the bands look chopped off.
  float edgeX = smoothstep(0.0, 0.15, uv.x) * smoothstep(1.0, 0.85, uv.x);
  float edgeY = smoothstep(0.0, 0.12, uv.y) * smoothstep(1.0, 0.88, uv.y);
  alpha *= edgeX * edgeY;

  // A 2x2 ordered dither, one 255th of a step. At these alphas an 8-bit
  // framebuffer quantises the falloff into visible contour rings; this breaks
  // them without being visible itself.
  float dither = fract(dot(floor(gl_FragCoord.xy), vec2(0.5, 0.25))) - 0.375;
  alpha += dither / 255.0;

  // Light needs a deeper tint: a glow on a dark ground carries at low alpha,
  // the same wash on white does not.
  vec3 tint = mix(uTint * 0.62, uTint, uDark);
  gl_FragColor = vec4(tint, max(alpha, 0.0) * (1.55 - 0.55 * uDark));
}
`

const FRAME_MS = 1000 / 30 // 30 fps is plenty for something this slow

/**
 * The three things the field can mean, and the colour each one wears.
 *
 * Named states rather than a 0..1 ramp: the app is waiting, working, or done,
 * and a colour halfway between "waiting" and "done" says nothing a person can
 * read. The palette comes from CSS so the two themes stay in one place; the
 * fallbacks are only for a stylesheet that failed to load.
 */
const TONES = {
  idle: { variable: '--accent', fallback: [0.4, 0.55, 1.0] },
  busy: { variable: '--busy', fallback: [0.95, 0.75, 0.3] },
  done: { variable: '--ok', fallback: [0.44, 0.83, 0.64] },
}

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function readColour(host, property, fallback) {
  const raw = getComputedStyle(host).getPropertyValue(property).trim()
  const hex = /^#?([\da-f]{6})$/i.exec(raw)
  if (!hex) return fallback
  const value = parseInt(hex[1], 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

/**
 * @typedef {object} Mood
 * @property {number} energy 0 calm .. 1 working
 * @property {'idle' | 'busy' | 'done'} [tone]
 * @property {boolean} [snap] arrive at once instead of gliding there
 */

/**
 * @param {HTMLElement} host element to render behind
 * @returns {{ setMood(mood: Mood): void, destroy(): void } | null}
 */
export function mountShader(host) {
  const canvas = document.createElement('canvas')
  canvas.className = 'field'
  canvas.setAttribute('aria-hidden', 'true')

  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false })
  if (!gl) return null

  const program = gl.createProgram()
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  if (!vertex || !fragment) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null

  gl.useProgram(program)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  const uniforms = Object.fromEntries(
    ['uSize', 'uTime', 'uEnergy', 'uTint', 'uDark'].map((name) => [
      name,
      gl.getUniformLocation(program, name),
    ]),
  )

  host.prepend(canvas)

  const darkQuery = matchMedia('(prefers-color-scheme: dark)')
  const stillQuery = matchMedia('(prefers-reduced-motion: reduce)')

  let energy = 1
  let target = 1
  let tone = 'idle'
  /** The colour on screen right now. Null means "start from wherever we are". */
  let tint = null
  let visible = true
  let running = false
  let raf = 0
  let last = 0
  const started = performance.now()

  const resize = () => {
    const scale = Math.min(devicePixelRatio || 1, 1.5)
    const width = Math.max(1, Math.round(host.clientWidth * scale))
    const height = Math.max(1, Math.round(host.clientHeight * scale))
    if (canvas.width === width && canvas.height === height) return
    canvas.width = width
    canvas.height = height
    gl.viewport(0, 0, width, height)
  }

  const draw = (now) => {
    resize()
    // Ease both, so a state change glides instead of snapping -- except where
    // the caller asked to arrive at once, which it does by clearing `tint`.
    energy += (target - energy) * 0.06

    // Read the tone's colour every frame rather than once at the change: the
    // palette follows the system theme, and switching it mid-run must be picked
    // up. Two decimal places of a colour channel per frame is nothing.
    const { variable, fallback } = TONES[tone] ?? TONES.idle
    const wanted = readColour(host, variable, fallback)
    tint = tint ? tint.map((channel, i) => channel + (wanted[i] - channel) * 0.045) : wanted

    gl.uniform2f(uniforms.uSize, canvas.width, canvas.height)
    gl.uniform1f(uniforms.uTime, (now - started) / 1000)
    gl.uniform1f(uniforms.uEnergy, energy)
    gl.uniform3fv(uniforms.uTint, tint)
    gl.uniform1f(uniforms.uDark, darkQuery.matches ? 1 : 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  const loop = (now) => {
    if (!running) return
    raf = requestAnimationFrame(loop)
    if (now - last < FRAME_MS) return
    last = now
    draw(now)
  }

  const start = () => {
    if (running || !visible || document.hidden) return
    if (stillQuery.matches) {
      draw(performance.now()) // one frame, then nothing moves
      return
    }
    running = true
    raf = requestAnimationFrame(loop)
  }

  const stop = () => {
    running = false
    cancelAnimationFrame(raf)
  }

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    visible ? start() : stop()
  })
  observer.observe(host)

  const onVisibility = () => (document.hidden ? stop() : start())
  document.addEventListener('visibilitychange', onVisibility)
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    stop()
  })

  start()

  return {
    /**
     * Where the field should be heading. One call per state change, because a
     * state is a speed *and* a colour and setting them separately let them
     * disagree.
     *
     * @param {Mood} mood
     */
    setMood({ energy: wanted = 1, tone: name = 'idle', snap = false }) {
      target = Math.max(0, Math.min(1, wanted))
      tone = name in TONES ? name : 'idle'
      // Reduced motion gets no transitions either: an eased colour would creep
      // one step per call and never arrive.
      if (snap || stillQuery.matches) {
        energy = target
        tint = null
        draw(performance.now())
      }
    },
    destroy() {
      stop()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.remove()
    },
  }
}
