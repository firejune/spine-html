/**
 * Shared offscreen WebGL rasterizer for the mesh (deform) tier.
 *
 * One module-level context serves every renderer instance: browsers cap live
 * WebGL contexts (16 on Chrome/Safari) and a page can hold many renderers, so
 * per-renderer contexts would evict each other. Per flush, every dirty mesh is
 * shelf-packed into a rect of the offscreen canvas, its triangles are drawn
 * textured (atlas page texture, premultiplied alpha), and each rect is blitted
 * onto the mesh's per-part 2d canvas with an unclipped drawImage rect copy.
 * The texture is premultiplied either by the upload or by the exporter — a
 * `pma: true` page arrives that way, so it is uploaded unconverted (textureFor).
 *
 * Why this exists: Safari antialiases canvas2d clip paths, so the standard
 * per-triangle clip+transform+drawImage mapping pays a per-triangle AA-mask
 * cost in the GPU process — invisible to in-callback JS timing, but it
 * rAF-limits heavy scenes. GL rasterizes shared triangle edges seamlessly
 * (no clip, no crack overdraw needed), and the remaining canvas2d work is a
 * plain rect blit.
 *
 * The offscreen buffer is scratch space: rects are scissor-cleared and
 * redrawn every flush and read back in the same task, so neither
 * preserveDrawingBuffer nor cross-frame content is relied on. The buffer
 * grows quantized and never shrinks, mirroring the per-part backing policy
 * (reallocating GPU surfaces per frame is a Safari killer).
 *
 * Page textures are the one thing here with a lifetime, and since this object
 * outlives every renderer they are reference-counted: a renderer retains each
 * page it queues a job for and releases them in dispose(), and the last
 * release deletes the GL texture (a later job re-uploads it). The cache is
 * keyed weakly by the page image, so a consumer that never disposes still
 * loses nothing but GPU memory — this object never pins the caller's image.
 */

export interface MeshBlitJob {
  /** Destination per-part canvas; the blit clears its full backing first. */
  canvas: HTMLCanvasElement;
  /** Atlas page image the mesh samples (cached as a GL texture on first use). */
  page: HTMLImageElement;
  /**
   * `page.pma` — whether the page's texels are already premultiplied, which
   * decides whether the upload premultiplies them again (see textureFor). It
   * travels with the page because it describes the page's *pixels*, and the
   * blend below wants them premultiplied exactly once.
   */
  pma: boolean;
  /** Bbox-relative vertices in CSS px, x/y interleaved (indexed via `triangles`). */
  vertices: Float64Array;
  /** Normalized page UVs aligned with `vertices`. */
  uvs: ArrayLike<number>;
  /** Triangle index list into vertex/UV pairs. */
  triangles: ArrayLike<number>;
  /** Backing-store pixels per CSS px. */
  ratio: number;
  /** Rasterized region in device px — the packed rect and the blit both use it. */
  width: number;
  height: number;
}

const VERTEX_SHADER = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform vec2 uResolution;
varying vec2 vUV;
void main() {
  // aPos is in offscreen-canvas device px, top-left origin (matching the
  // top-left-origin drawImage read of the same rect).
  vec2 clip = aPos / uResolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUV = aUV;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV;
void main() {
  gl_FragColor = texture2D(uTex, vUV);
}`;

/** Gap between packed rects; blits are 1:1 unfiltered, so 1px is plenty. */
const GUTTER = 1;
/** Drawing-buffer growth quantum (device px). */
const GROW_STEP = 256;

/** Cache entry for one atlas page: the upload, and how many renderers want it. */
interface PageTexture {
  /** Uploaded lazily, on the first flush that binds this page. */
  texture: WebGLTexture | null;
  /** Live retain() calls outstanding — one per renderer drawing this page. */
  users: number;
  /** The alpha convention `texture` was uploaded under; meaningless without it. */
  pma: boolean;
}

class MeshGlBlitter {
  lost = false;
  /**
   * Page textures created minus deleted, i.e. how many uploads are live right
   * now. Deterministic (no GC in the path), which is what the lifetime tests
   * assert against — see tests/gl-textures.spec.ts.
   */
  liveTextureCount = 0;

  private readonly canvas = document.createElement('canvas');
  private readonly gl: WebGLRenderingContext;
  private readonly uResolution: WebGLUniformLocation;
  /**
   * Weak by the page image on purpose: a consumer that forgets dispose()
   * leaks its texture until context loss, but dropping the image still lets
   * the image (and then the WebGLTexture this entry holds) be collected.
   * Reassigned wholesale on context loss, never iterated.
   */
  private textures = new WeakMap<HTMLImageElement, PageTexture>();
  private readonly maxSize: number;
  private vertexData = new Float32Array(8192);
  /** Per-job packed rect origins, filled by flush(). */
  private packX: number[] = [];
  private packY: number[] = [];

  constructor() {
    const gl = this.canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    // No restore attempt: on loss the renderer falls back to canvas2d and the
    // backend signature re-dirties every mesh, so frames stay complete.
    this.canvas.addEventListener('webglcontextlost', () => {
      this.markLost();
    });

    const program = gl.createProgram();
    if (!program) throw new Error('createProgram failed');
    gl.attachShader(program, this.compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const uResolution = gl.getUniformLocation(program, 'uResolution');
    if (!uResolution) throw new Error('uResolution not found');
    this.uResolution = uResolution;
    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);

    // Static state: this context does exactly one thing, set it up once.
    // Interleaved [x, y, u, v] vertices in a single dynamic buffer.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    const aPos = gl.getAttribLocation(program, 'aPos');
    const aUV = gl.getAttribLocation(program, 'aUV');
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
    // Premultiplied source-over, matching canvas2d triangle compositing.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    this.maxSize = Math.min((gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) || 4096, 8192);
  }

  /**
   * Rasterize every job into the offscreen buffer, then blit each rect onto
   * its per-part canvas. Returns false when the context is lost (or the jobs
   * cannot fit) so the caller can rasterize the batch on the canvas2d path.
   */
  flush(jobs: MeshBlitJob[]): boolean {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return false;

    // Shelf-pack, tallest first (indices keep job order for the draw pass).
    let width = Math.max(512, this.canvas.width);
    for (const job of jobs) width = Math.max(width, job.width + GUTTER * 2);
    if (width > this.maxSize) return false;
    const order = jobs.map((_, i) => i).sort((a, b) => jobs[b].height - jobs[a].height);
    const packX = (this.packX = new Array<number>(jobs.length));
    const packY = (this.packY = new Array<number>(jobs.length));
    let shelfX = GUTTER;
    let shelfY = GUTTER;
    let shelfH = 0;
    let height = GUTTER;
    for (const i of order) {
      const job = jobs[i];
      if (shelfX + job.width + GUTTER > width) {
        shelfY += shelfH + GUTTER;
        shelfX = GUTTER;
        shelfH = 0;
      }
      packX[i] = shelfX;
      packY[i] = shelfY;
      shelfX += job.width + GUTTER;
      if (job.height > shelfH) shelfH = job.height;
      if (shelfY + job.height + GUTTER > height) height = shelfY + job.height + GUTTER;
    }
    if (height > this.maxSize) return false;

    // Grow-only quantized drawing buffer. Resizing clears it, which is fine:
    // every rect below is cleared and redrawn anyway.
    if (width > this.canvas.width || height > this.canvas.height) {
      this.canvas.width = Math.min(this.maxSize, Math.ceil(width / GROW_STEP) * GROW_STEP);
      this.canvas.height = Math.min(
        this.maxSize,
        Math.ceil(Math.max(height, this.canvas.height) / GROW_STEP) * GROW_STEP,
      );
    }
    const bufW = this.canvas.width;
    const bufH = this.canvas.height;
    gl.viewport(0, 0, bufW, bufH);
    gl.uniform2f(this.uResolution, bufW, bufH);

    // Build one interleaved vertex array for the whole batch (unindexed —
    // meshes are a few hundred triangles, expansion is cheaper than managing
    // index buffers).
    let floats = 0;
    for (const job of jobs) floats += job.triangles.length * 4;
    if (this.vertexData.length < floats) {
      this.vertexData = new Float32Array(1 << Math.ceil(Math.log2(floats)));
    }
    const data = this.vertexData;
    let f = 0;
    for (let i = 0; i < jobs.length; i++) {
      const { vertices, uvs, triangles, ratio } = jobs[i];
      const ox = packX[i];
      const oy = packY[i];
      for (let t = 0; t < triangles.length; t++) {
        const vi = triangles[t] * 2;
        data[f++] = ox + vertices[vi] * ratio;
        data[f++] = oy + vertices[vi + 1] * ratio;
        data[f++] = uvs[vi];
        data[f++] = uvs[vi + 1];
      }
    }
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, floats), gl.DYNAMIC_DRAW);

    let boundPage: HTMLImageElement | null = null;
    let first = 0;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (job.page !== boundPage) {
        gl.bindTexture(gl.TEXTURE_2D, this.textureFor(job.page, job.pma));
        boundPage = job.page;
      }
      // Scissor is bottom-left origin; pack coords are top-left origin.
      gl.scissor(packX[i], bufH - packY[i] - job.height, job.width, job.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, first, job.triangles.length);
      first += job.triangles.length;
    }

    // If the context died mid-batch the draws above were no-ops; report it
    // before blitting stale/blank rects onto the part canvases.
    if (gl.isContextLost()) {
      this.markLost();
      return false;
    }

    // Blit each rect onto its per-part canvas: same-task read (no
    // preserveDrawingBuffer needed), 1:1 device px (no filtering).
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const ctx = job.canvas.getContext('2d');
      if (!ctx) continue;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Clear the full backing: the previous raster may have been larger.
      ctx.clearRect(0, 0, job.canvas.width, job.canvas.height);
      ctx.drawImage(this.canvas, packX[i], packY[i], job.width, job.height, 0, 0, job.width, job.height);
    }
    return true;
  }

  /**
   * Declares one more user of `page`. The upload itself stays lazy (the first
   * flush that binds the page does it) — this only counts, so that the last
   * release() can free the texture instead of the module holding it forever.
   * Callers retain once per page and hand the same page back exactly once;
   * SpineHtmlRenderer keeps that ledger and settles it in dispose().
   */
  retain(page: HTMLImageElement): void {
    const entry = this.textures.get(page);
    if (entry) entry.users++;
    else this.textures.set(page, { texture: null, users: 1, pma: false });
  }

  /**
   * Gives back one retain(). The GL texture goes when the last user of the
   * page is gone; a later job for the same page simply uploads it again. A
   * page the cache does not know (a release after a context loss dropped
   * everything, or a double dispose) is a no-op, so this is safe to call
   * unconditionally.
   */
  release(page: HTMLImageElement): void {
    const entry = this.textures.get(page);
    if (!entry) return;
    if (--entry.users > 0) return;
    this.textures.delete(page);
    if (!entry.texture) return;
    // deleteTexture is a documented no-op on a lost context rather than a
    // throw, but a lost context has already dropped the cache and zeroed the
    // count — reaching here with `lost` set would mean decrementing twice.
    if (!this.lost && !this.gl.isContextLost()) this.gl.deleteTexture(entry.texture);
    this.liveTextureCount--;
  }

  /**
   * Context loss invalidates every texture handle at once. Drop the cache and
   * the count instead of carrying dead handles (deleting them is pointless —
   * the GPU side is already gone) and let the next frames re-upload if the
   * caller keeps drawing; the renderer meanwhile falls back to canvas2d.
   */
  private markLost(): void {
    this.lost = true;
    this.textures = new WeakMap();
    this.liveTextureCount = 0;
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('createShader failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }

  /**
   * The page's GL texture, uploaded on demand.
   *
   * `pma` is a property of the page's *pixels*, so one image cannot honestly be
   * both: two atlases naming the same image with different `pma:` lines are not
   * a mixed page, one of them is simply wrong about the file. The cache is keyed
   * by the image, so rather than trusting that, a flag that disagrees with the
   * live upload re-uploads under the new one — the pathological case stays
   * correct (at the price of re-uploading while it lasts) instead of silently
   * drawing one of the two atlases wrong.
   */
  private textureFor(page: HTMLImageElement, pma: boolean): WebGLTexture {
    let entry = this.textures.get(page);
    if (entry?.texture) {
      if (entry.pma === pma) return entry.texture;
      this.gl.deleteTexture(entry.texture);
      entry.texture = null;
      this.liveTextureCount--;
    }
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Premultiply at upload so blending and the premultiplied canvas agree —
    // unless the page is already premultiplied (`pma: true`), where doing it
    // again is the second multiply that darkens every semi-transparent texel
    // (#37). The blend below is premultiplied source-over either way, so a pma
    // page is simply uploaded as it is: no conversion, nothing lost.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pma ? 0 : 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, page);
    // Linear, no mips, clamped — NPOT-safe in WebGL1.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (!entry) {
      // Nobody retained this page — not a path this package takes, since the
      // renderer retains as it queues each job. Cache it anyway so the batch
      // does not re-upload per flush; with no users only a context loss (or
      // the image being collected, which takes the weak entry with it) clears
      // it, which is exactly the old behavior for a caller that opts out.
      entry = { texture: null, users: 0, pma };
      this.textures.set(page, entry);
    }
    entry.pma = pma;
    entry.texture = texture;
    this.liveTextureCount++;
    return texture;
  }
}

let shared: MeshGlBlitter | null | undefined;

/**
 * The module-level blitter, created on first use. Returns null when WebGL is
 * unavailable or the shared context has been lost — callers then stay on the
 * canvas2d path.
 */
export function getMeshGlBlitter(): MeshGlBlitter | null {
  if (shared === undefined) {
    try {
      shared = new MeshGlBlitter();
    } catch {
      shared = null;
    }
  }
  return shared && !shared.lost ? shared : null;
}
