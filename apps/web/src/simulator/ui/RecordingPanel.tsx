/**
 * Record what you did, feed it back (阶段 4).
 *
 * The simulator has guaranteed determinism since M-S1, but only for a fixed event
 * sequence — which nobody has, because the events come from a person. A recording
 * turns "the same inputs give the same run" into something you can actually use: a
 * bug you can reproduce, or a scenario you can re-run after editing the program.
 *
 * The instants come from the worker, never from here: the store's mirror lags a
 * frame, and a recording a frame out would not replay to the run it came from.
 */
import { useRef } from 'react';
import type { RecordedControl } from '@breadboard-studio/sim';
import { useStore } from '../../store';
import { useSimulatorStore } from '../simulatorStore';

const FILE_KIND = 'breadboard-studio/recording@1';

interface RecordingFile {
  kind: typeof FILE_KIND;
  designHash: string | null;
  entries: RecordedControl[];
}

/** Accepts only what this app wrote, and says which part it did not recognise. */
export function parseRecording(text: string): { ok: true; file: RecordingFile } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `不是合法的 JSON：${(e as Error).message}` };
  }
  // An array is `typeof 'object'` too, and telling the user its `kind` is wrong
  // would be a confusing way to say "this is the wrong shape entirely".
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '文件内容不是一个对象' };
  const file = raw as Partial<RecordingFile>;
  if (file.kind !== FILE_KIND) return { ok: false, error: `不是录制文件（kind 应为 ${FILE_KIND}）` };
  if (!Array.isArray(file.entries)) return { ok: false, error: '缺少 entries 数组' };
  for (const [i, entry] of file.entries.entries()) {
    if (typeof entry?.atUs !== 'number' || !Number.isFinite(entry.atUs)) return { ok: false, error: `第 ${i + 1} 条缺少 atUs` };
    if (!entry.event?.componentId || !entry.event?.controlId) return { ok: false, error: `第 ${i + 1} 条缺少 componentId / controlId` };
  }
  return { ok: true, file: { kind: FILE_KIND, designHash: file.designHash ?? null, entries: file.entries } };
}

export function RecordingPanel() {
  const recording = useSimulatorStore((s) => s.recording);
  const designHash = useSimulatorStore((s) => s.designHash);
  const status = useSimulatorStore((s) => s.status);
  const fileRef = useRef<HTMLInputElement>(null);

  const download = (): void => {
    const file: RecordingFile = { kind: FILE_KIND, designHash, entries: recording };
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recording.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const load = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const parsed = parseRecording(await file.text());
    if (!parsed.ok) {
      useStore.getState().toast('error', `录制文件无法读取：${parsed.error}`);
      return;
    }
    if (parsed.file.designHash && parsed.file.designHash !== designHash) {
      // Not refused: a recording against an edited design is exactly what you want
      // when checking whether the edit fixed the bug. It just cannot promise a match.
      useStore.getState().toast('info', '这份录制来自另一个版本的设计，回放结果可能与当时不同。');
    }
    await useSimulatorStore.getState().replay(parsed.file.entries);
  };

  return (
    <section className="sim-section" data-testid="sim-recording">
      <div className="sim-section-title">录制与回放</div>
      <p className="muted small">
        本次已记录 <b data-testid="sim-recording-count">{recording.length}</b> 次操作，每一次都带有它生效的虚拟时刻。回放会从头重跑并在同样的时刻送回这些操作。
      </p>
      <div className="row">
        <button onClick={() => void useSimulatorStore.getState().replay(recording)} disabled={!recording.length} data-testid="sim-replay">
          回放本次
        </button>
        <button onClick={download} disabled={!recording.length} data-testid="sim-recording-export">
          导出
        </button>
        <button onClick={() => fileRef.current?.click()} data-testid="sim-recording-import">
          导入并回放…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="sim-recording-file"
          onChange={(e) => {
            void load(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {status === 'idle' && recording.length > 0 && <p className="muted small">会话已结束，但录制还在，可以直接回放或导出。</p>}
    </section>
  );
}
