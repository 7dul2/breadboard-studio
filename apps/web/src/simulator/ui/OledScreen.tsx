/**
 * One OLED panel on the canvas (plan §9.2).
 *
 * The pixels never enter React or zustand: `WorkerBackend` diverts them to
 * `visualBus`, this component subscribes with a ref and writes straight into a
 * `<canvas>` 2D context. A 8,192-byte frame at ~21 fps through `setState` would
 * re-render the whole editor; here React renders the `<foreignObject>` once and
 * never sees a frame.
 *
 * The canvas is its native 128×64 and is stretched to the feature rect by CSS,
 * with `image-rendering: pixelated` so a magnified panel shows square pixels
 * instead of a blur — which is what the real thing looks like under a loupe.
 */
import { useEffect, useRef } from 'react';
import { visualBus, type DisplayFrame } from '../runtime/visualBus';
import { parseHexColor, type OverlayRect } from './overlay-geometry';

interface Props {
  componentId: string;
  feature: string;
  rect: OverlayRect;
}

/**
 * Paint one frame. Intensity is per pixel (0–255) and the panel colour is a flat
 * tint, which is how a monochrome OLED actually works: the contrast register
 * scales the whole panel, it does not change its colour.
 */
export function drawFrame(ctx: CanvasRenderingContext2D, frame: DisplayFrame): void {
  const { width, height, pixels } = frame;
  if (width <= 0 || height <= 0) return;
  const image = ctx.createImageData(width, height);
  const [r, g, b] = parseHexColor(frame.color);
  const data = image.data;
  for (let i = 0; i < width * height; i++) {
    const level = pixels[i] ?? 0;
    const at = i * 4;
    data[at] = r;
    data[at + 1] = g;
    data[at + 2] = b;
    // Intensity rides in the alpha channel, so an unlit pixel shows the black panel.
    data[at + 3] = frame.enabled ? level : 0;
  }
  ctx.clearRect(0, 0, width, height);
  ctx.putImageData(image, 0, 0);
}

export function OledScreen({ componentId, feature, rect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    return visualBus.subscribe(componentId, (frame) => {
      if (frame.feature !== feature) return;
      // The panel's own resolution, resized only when it actually changes.
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
        ctx = null;
      }
      ctx ??= canvas.getContext('2d');
      if (ctx) drawFrame(ctx, frame);
      canvas.dataset.onPixels = String(frame.onPixels);
      canvas.dataset.enabled = String(frame.enabled);
    });
  }, [componentId, feature]);

  return (
    <foreignObject x={rect.x} y={rect.y} width={rect.width} height={rect.height} className="sim-screen" pointerEvents="none">
      <canvas
        ref={canvasRef}
        width={128}
        height={64}
        data-testid={`sim-screen-${componentId}`}
        style={{ width: '100%', height: '100%', display: 'block', background: '#050608', imageRendering: 'pixelated' }}
      />
    </foreignObject>
  );
}
