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
const SKELETONS = {
  pro: 'spineboy-pro.json', // meshes (deform tier → per-part canvases)
  ess: 'spineboy-ess.json', // region attachments only (rigid tier → pure DOM)
} as const;
type SkeletonVariant = keyof typeof SKELETONS;
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

async function load(): Promise<{
  data: Record<SkeletonVariant, SkeletonData>;
  regionImages: Map<string, RegionImage>;
}> {
  const [atlasText, proText, essText] = await Promise.all([
    fetch(`${ASSET_BASE}/spineboy.atlas`).then((r) => r.text()),
    fetch(`${ASSET_BASE}/${SKELETONS.pro}`).then((r) => r.text()),
    fetch(`${ASSET_BASE}/${SKELETONS.ess}`).then((r) => r.text()),
  ]);

  const atlas = new TextureAtlas(atlasText);
  const pageImages = new Map<string, HTMLImageElement>();
  for (const page of atlas.pages) {
    const image = await loadImage(`${ASSET_BASE}/${page.name}`);
    page.setTexture(new DomTexture(image));
    pageImages.set(page.name, image);
  }

  const regionImages = await unpackRegions(atlas, pageImages);
  const loader = new AtlasAttachmentLoader(atlas);
  return {
    data: {
      pro: new SkeletonJson(loader).readSkeletonData(proText),
      ess: new SkeletonJson(loader).readSkeletonData(essText),
    },
    regionImages,
  };
}

function main(
  data: Record<SkeletonVariant, SkeletonData>,
  regionImages: Map<string, RegionImage>,
): void {
  const stage = document.getElementById('stage') as HTMLDivElement;
  const skelSelect = document.getElementById('skel') as HTMLSelectElement;
  const animSelect = document.getElementById('anim') as HTMLSelectElement;
  const countInput = document.getElementById('count') as HTMLInputElement;
  const stats = document.getElementById('stats') as HTMLDivElement;

  let variant: SkeletonVariant = 'pro';
  let stateData = new AnimationStateData(data[variant]);
  let instances: Instance[] = [];

  function fillAnimations(): void {
    animSelect.innerHTML = '';
    for (const anim of data[variant].animations) {
      const option = document.createElement('option');
      option.value = anim.name;
      option.textContent = anim.name;
      animSelect.appendChild(option);
    }
    const names = data[variant].animations.map((a) => a.name);
    animSelect.value = names.includes('walk') ? 'walk' : names[0];
  }

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

      const skeleton = new Skeleton(data[variant]);
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

  skelSelect.addEventListener('change', () => {
    variant = skelSelect.value as SkeletonVariant;
    stateData = new AnimationStateData(data[variant]);
    stateData.defaultMix = 0.2;
    fillAnimations();
    rebuild(instances.length || 1);
  });
  animSelect.addEventListener('change', () => {
    for (const inst of instances) inst.state.setAnimation(0, animSelect.value, true);
  });
  countInput.addEventListener('change', () => {
    const count = Math.min(50, Math.max(1, Number(countInput.value) || 1));
    countInput.value = String(count);
    rebuild(count);
  });

  stateData.defaultMix = 0.2;
  fillAnimations();
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
      let meshes = 0;
      let triangles = 0;
      let clips = 0;
      for (const inst of instances) {
        meshes += inst.renderer.meshCount;
        triangles += inst.renderer.triangleCount;
        clips += inst.renderer.clipSkipCount;
      }
      const meshNote = meshes ? ` · ${meshes} mesh canvases (${triangles} tris)` : '';
      const clipNote = clips ? ` · ${clips} clips skipped` : '';
      stats.textContent =
        `${instances.length} skeleton(s) · ` +
        `skeleton ${(updateMs / frames).toFixed(2)}ms · ` +
        `render ${(renderMs / frames).toFixed(2)}ms / frame${meshNote}${clipNote}`;
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
