import {
  AnimationState,
  AnimationStateData,
  AtlasAttachmentLoader,
  Physics,
  Skeleton,
  type SkeletonData,
  SkeletonJson,
  TextureAtlas,
} from '@esotericsoftware/spine-core';
import { DomTexture, type RegionImage, unpackRegions } from './DomTexture';
import { SpineHtmlRenderer } from './SpineHtmlRenderer';

const ASSET_BASE = '/spineboy';
const SKELETON_JSON = 'spineboy-ess.json'; // essential = region attachments only
const STAGE_SCALE = 0.4;

interface Instance {
  skeleton: Skeleton;
  state: AnimationState;
  renderer: SpineHtmlRenderer;
  container: HTMLDivElement;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

async function load(): Promise<{ data: SkeletonData; regionImages: Map<string, RegionImage> }> {
  const [atlasText, jsonText] = await Promise.all([
    fetch(`${ASSET_BASE}/spineboy.atlas`).then((r) => r.text()),
    fetch(`${ASSET_BASE}/${SKELETON_JSON}`).then((r) => r.text()),
  ]);

  const atlas = new TextureAtlas(atlasText);
  const pageImages = new Map<string, HTMLImageElement>();
  for (const page of atlas.pages) {
    const image = await loadImage(`${ASSET_BASE}/${page.name}`);
    page.setTexture(new DomTexture(image));
    pageImages.set(page.name, image);
  }

  const regionImages = await unpackRegions(atlas, pageImages);
  const json = new SkeletonJson(new AtlasAttachmentLoader(atlas));
  return { data: json.readSkeletonData(jsonText), regionImages };
}

function main(data: SkeletonData, regionImages: Map<string, RegionImage>): void {
  const stage = document.getElementById('stage') as HTMLDivElement;
  const animSelect = document.getElementById('anim') as HTMLSelectElement;
  const countInput = document.getElementById('count') as HTMLInputElement;
  const stats = document.getElementById('stats') as HTMLDivElement;

  for (const anim of data.animations) {
    const option = document.createElement('option');
    option.value = anim.name;
    option.textContent = anim.name;
    animSelect.appendChild(option);
  }
  const defaultAnim = data.animations.some((a) => a.name === 'walk')
    ? 'walk'
    : data.animations[0].name;
  animSelect.value = defaultAnim;

  const stateData = new AnimationStateData(data);
  stateData.defaultMix = 0.2;

  let instances: Instance[] = [];

  function rebuild(count: number): void {
    for (const inst of instances) {
      inst.renderer.dispose();
      inst.container.remove();
    }
    instances = [];
    for (let i = 0; i < count; i++) {
      const container = document.createElement('div');
      container.className = 'skeleton-root';
      // Spread instances horizontally; each root is the skeleton origin
      // (feet), so park it near the stage bottom.
      const x = count === 1 ? 50 : 10 + (80 * i) / (count - 1);
      container.style.left = `${x}%`;
      container.style.transform = `scale(${STAGE_SCALE})`;
      stage.appendChild(container);

      const skeleton = new Skeleton(data);
      const state = new AnimationState(stateData);
      state.setAnimation(0, animSelect.value, true);
      // Desync walk cycles so N instances don't look like one stamped sprite.
      state.update((i * 0.37) % 2);

      instances.push({
        skeleton,
        state,
        renderer: new SpineHtmlRenderer(container, regionImages),
        container,
      });
    }
  }

  animSelect.addEventListener('change', () => {
    for (const inst of instances) inst.state.setAnimation(0, animSelect.value, true);
  });
  countInput.addEventListener('change', () => {
    const count = Math.min(50, Math.max(1, Number(countInput.value) || 1));
    countInput.value = String(count);
    rebuild(count);
  });

  rebuild(1);

  // --- frame loop with split timings (skeleton math vs DOM writes) ---
  let last = performance.now();
  let updateMs = 0;
  let renderMs = 0;
  let frames = 0;
  let statsAt = last;

  function frame(now: number): void {
    const delta = Math.min((now - last) / 1000, 1 / 15);
    last = now;

    const t0 = performance.now();
    for (const inst of instances) {
      inst.state.update(delta);
      inst.state.apply(inst.skeleton);
      inst.skeleton.update(delta);
      inst.skeleton.updateWorldTransform(Physics.update);
    }
    const t1 = performance.now();
    for (const inst of instances) inst.renderer.render(inst.skeleton);
    const t2 = performance.now();

    updateMs += t1 - t0;
    renderMs += t2 - t1;
    frames++;

    if (now - statsAt >= 500 && frames > 0) {
      const meshNote = instances[0]?.renderer.meshSkipCount
        ? ` · meshes skipped: ${instances[0].renderer.meshSkipCount}`
        : '';
      stats.textContent =
        `${instances.length} skeleton(s) · ` +
        `skeleton ${(updateMs / frames).toFixed(2)}ms · ` +
        `DOM ${(renderMs / frames).toFixed(2)}ms / frame${meshNote}`;
      updateMs = renderMs = 0;
      frames = 0;
      statsAt = now;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

load()
  .then(({ data, regionImages }) => main(data, regionImages))
  .catch((err) => {
    const stats = document.getElementById('stats');
    if (stats) stats.textContent = `Load failed: ${err.message} — did you run bun run fetch-assets?`;
    console.error(err);
  });
