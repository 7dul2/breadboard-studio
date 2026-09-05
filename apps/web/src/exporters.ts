import type { DesignDocument } from '@breadboard-studio/schema';
import { serializeDesign } from '@breadboard-studio/core';
import { exportSvg, type ExportOptions } from '@breadboard-studio/render';
import { analysisOf } from './store';

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileBase(design: DesignDocument): string {
  return (design.metadata.name || 'breadboard').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
}

export function exportJsonFile(design: DesignDocument): void {
  download(`${fileBase(design)}.breadboard.json`, new Blob([serializeDesign(design)], { type: 'application/json' }));
}

export function buildSvgString(design: DesignDocument, opts: ExportOptions = {}): string {
  const a = analysisOf(design);
  return exportSvg(a.model, { title: design.metadata.name, legend: true, showPinLabels: true, ...opts });
}

export function exportSvgFile(design: DesignDocument, opts: ExportOptions = {}): void {
  download(`${fileBase(design)}.svg`, new Blob([buildSvgString(design, opts)], { type: 'image/svg+xml' }));
}

/** Rasterise the export SVG in the browser. Returns the PNG blob (also downloads it). */
export async function exportPngFile(design: DesignDocument, opts: ExportOptions = {}, scale = 2): Promise<Blob> {
  const svg = buildSvgString(design, opts);
  const m = /viewBox="([-\d. ]+)"/.exec(svg);
  const [, , w, h] = (m?.[1] ?? '0 0 100 100').split(' ').map(Number);
  const pxPerMm = 6 * scale;
  const width = Math.ceil((w ?? 100) * pxPerMm);
  const height = Math.ceil((h ?? 100) * pxPerMm);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG 渲染失败'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png'));
    download(`${fileBase(design)}.png`, blob);
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
