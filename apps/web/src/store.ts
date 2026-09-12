import { create } from 'zustand';
import type { BoardInstance, ComponentInstance, DesignDocument, PointUm, WireEndpoint, WireRoute } from '@breadboard-studio/schema';
import { analyzeDesign, applyOps, buildModel, catalogForDesign, createEmptyDesign, loadDesign, serializeDesign, type Analysis, type ApplyResult, type Op, type RuleResult } from '@breadboard-studio/core';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { hasPrevious, loadClipboard, loadCurrent, loadPrevious, readCurrentText, readPreviousText, saveClipboard, saveCurrent, stashPrevious, type StorageStatus } from './storage';
import { describeDemoted, recoverByExplicitDowngrade } from './recover-embedded';
import { anchorPointUm, snapBoardPosition, snapPlacement } from './placement';
import { droppedDefinitions } from './dropped-definitions';
import deskExample from '../../../examples/desk_device.breadboard.json';
import envExample from '../../../examples/environment_node.breadboard.json';
import stressExample from '../../../examples/stress_test.breadboard.json';
import touchExample from '../../../examples/touch_display.breadboard.json';

export type Tool = 'select' | 'wire' | 'pan';
export type RightTab = 'properties' | 'dsl' | 'wiring' | 'simulation' | 'hardware';
/**
 * The two things this app does, and the line between them: `build` changes the
 * document (place, wire, edit, undo), `sim` only observes and drives a session.
 * Everything that would write the design is withdrawn in `sim` rather than
 * offered and then refused, so the toolbar always shows what is actually
 * possible. The one deliberate exception is the program editor, which stays
 * reachable in both because the write-run loop needs it; saving source ends the
 * session (stale snapshot) instead of pretending the run still matches the code.
 */
export type AppMode = 'build' | 'sim' | 'hardware';

/**
 * 实机 is a third thing, not a third simulator. It has a cable and a wall clock; it
 * has no virtual time, no determinism and no modelled devices, and the RFC that
 * declined phase 5 (docs/PHASE5_RFC.md) is explicit that it must never be dressed
 * up as a simulation backend. Keeping it out of 仿真 is how that stays true.
 */

/**
 * One copied object plus where it sat, in absolute µm. Positions travel with the
 * payload so a multi-object paste keeps the group's relative layout instead of
 * stacking everything on one hole.
 */
export interface ClipboardItem<T> {
  instance: T;
  posUm: PointUm;
}

export interface ClipboardPayload {
  components: ClipboardItem<ComponentInstance>[];
  boards: ClipboardItem<BoardInstance>[];
  /**
   * The point the paste puts under the cursor: the first component's anchor pin, so
   * a single module drops into the hole you are pointing at, exactly like a drag.
   */
  refUm: PointUm;
}

/** Where a paste goes when the pointer is not over the canvas: down-right, clear of the original. */
const PASTE_OFFSET_UM = 5080;

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  details?: string[];
}

export interface PlacingState {
  model: string;
  rotation: 0 | 90 | 180 | 270;
}

export interface WireDraft {
  from: WireEndpoint;
}

export const EXAMPLES: { key: string; name: string; doc: unknown }[] = [
  { key: 'desk_device', name: '桌面设备：ESP32-S3 + OLED + 触摸键', doc: deskExample },
  { key: 'environment_node', name: '双面包板环境节点：XIAO + 传感器 + SEN66', doc: envExample },
  { key: 'stress_test', name: '性能测试：4 板 / 20 模块 / 100 线', doc: stressExample },
  { key: 'touch_display', name: '触摸显示：N16R8 + TTP223 + SSD1315（含程序）', doc: touchExample }
];

/** Ops that only touch programs / launch configuration and never the electrical topology. */
const NON_TOPOLOGY_OPS = new Set<Op['op']>(['add_program', 'update_program', 'remove_program', 'set_simulation_config', 'set_metadata']);

/**
 * Installed by the simulator store: returns false while a simulation session is
 * prepared or executing, in which case topology edits are refused (docs §11.1).
 * Registered lazily so store.ts never imports the simulator module.
 */
let topologyGuard: (() => boolean) | null = null;
export function setTopologyGuard(fn: (() => boolean) | null): void {
  topologyGuard = fn;
}

const analysisCache = new WeakMap<DesignDocument, Analysis>();
export function analysisOf(design: DesignDocument): Analysis {
  let a = analysisCache.get(design);
  if (!a) {
    a = analyzeDesign(design, builtinCatalog());
    analysisCache.set(design, a);
  }
  return a;
}

interface State {
  design: DesignDocument;
  past: DesignDocument[];
  future: DesignDocument[];
  selectedIds: string[];
  selectedHole: string | null;
  tool: Tool;
  wireColor: string;
  wireRoute: WireRoute;
  placing: PlacingState | null;
  wireDraft: WireDraft | null;
  showHoleLabels: boolean;
  showPinLabels: boolean;
  connectivityHighlight: boolean;
  /** 选中元件/孔时，把无关的导线压暗，只留直连的那几根显眼。 */
  dimUnhighlighted: boolean;
  mode: AppMode;
  clipboard: ClipboardPayload | null;
  rightTab: RightTab;
  buildStep: number;
  dslText: string;
  dslDirty: boolean;
  dslErrors: string[];
  lastResults: RuleResult[];
  toasts: Toast[];
  storage: StorageStatus;
  canRestorePrevious: boolean;
  highlightEndpoints: string[];
  highlightObjects: string[];
  fitRequest: number;
  /** Incremented whenever the whole document is swapped (new/import/example/restore), never by an edit. */
  documentGeneration: number;
  requestFit: () => void;

  apply: (ops: Op[], label?: string) => ApplyResult;
  undo: () => void;
  redo: () => void;
  select: (ids: string[], additive?: boolean) => void;
  selectHole: (addr: string | null) => void;
  setTool: (t: Tool) => void;
  setWireColor: (c: string) => void;
  setWireRoute: (r: WireRoute) => void;
  startPlacing: (model: string) => void;
  rotatePlacing: () => void;
  cancelInteraction: () => void;
  setWireDraft: (d: WireDraft | null) => void;
  toggleHoleLabels: () => void;
  togglePinLabels: () => void;
  toggleConnectivityHighlight: () => void;
  toggleDimUnhighlighted: () => void;
  setRightTab: (t: RightTab) => void;
  setMode: (m: AppMode) => void;
  setBuildStep: (i: number) => void;
  toggleBuildDone: (wireId: string) => void;
  setDslText: (t: string) => void;
  validateDsl: () => boolean;
  applyDsl: () => void;
  reloadDsl: () => void;
  newProject: () => void;
  loadExample: (key: string) => void;
  importJson: (text: string) => { ok: boolean; errors: string[] };
  restorePrevious: () => void;
  replaceDesign: (d: DesignDocument, opts?: { keepHistory?: boolean }) => void;
  toast: (kind: Toast['kind'], text: string, details?: string[]) => void;
  dismissToast: (id: number) => void;
  setHighlight: (endpoints: string[], objects: string[]) => void;
  deleteSelection: () => void;
  rotateSelection: () => void;
  duplicateSelection: () => void;
  copySelection: () => void;
  cutSelection: () => void;
  /** `atUm` is the pointer position; omit it to paste at a fixed offset instead. */
  pasteClipboard: (atUm?: PointUm | null) => void;
  toggleLockSelection: () => void;
}

let toastId = 1;
let saveTimer: number | null = null;
let pendingSave: { design: DesignDocument; set: (p: Partial<State>) => void } | null = null;

function scheduleSave(design: DesignDocument, set: (p: Partial<State>) => void): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  pendingSave = { design, set };
  saveTimer = window.setTimeout(flushSave, 300);
}

/** Write any pending autosave immediately (also called when the page is hidden/unloaded). */
export function flushSave(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = null;
  const p = pendingSave;
  pendingSave = null;
  if (p) p.set({ storage: saveCurrent(p.design) });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('beforeunload', flushSave);
}

function nextIdFor(design: DesignDocument, prefix: string): string {
  const used = new Set([...design.boards, ...design.components, ...design.wires, ...design.net_intents, ...design.constraints].map((o) => o.id));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

interface InitialRestore {
  design: DesignDocument;
  notice: { text: string; details: string[] } | null;
}

/**
 * Loads the stored current project. When it no longer passes validation — e.g.
 * an embedded evidence-free `verified` definition under the evidence gate — the
 * explicit-downgrade recovery runs, its result is written back to the local slot
 * (so the user is told once, not every startup), and the caller shows the notice.
 * Without this, a refused load would look exactly like data loss.
 */
function restoreInitial(): InitialRestore {
  const stored = loadCurrent();
  if (stored) return { design: stored, notice: null };
  const text = readCurrentText();
  const rec = text ? recoverByExplicitDowngrade(text) : null;
  if (!rec) return { design: createEmptyDesign('未命名项目'), notice: null };
  saveCurrent(rec.design);
  return {
    design: rec.design,
    notice: {
      text: `本地项目 ${rec.design.metadata.name} 按新版校验无法载入：${rec.demoted.length} 处内嵌定义标着 verified 却没有证据记录。已显式降级为 approximate 并载入。`,
      details: [
        `降级的声明：${describeDemoted(rec.demoted)}；降级记录已写入 status_notes，并存回本地槽位以免每次启动重复提示。`,
        '原始导出文件（如有）未被改动；补齐 evidence 并复核后可以再升级（docs/VERIFICATION.md）。',
      ]
    }
  };
}

const initialRestore = restoreInitial();

const useStore = create<State>((set, get) => {
  const initial = initialRestore.design;
  return {
    design: initial,
    past: [],
    future: [],
    selectedIds: [],
    selectedHole: null,
    tool: 'select',
    wireColor: 'red',
    wireRoute: 'flat',
    placing: null,
    wireDraft: null,
    showHoleLabels: false,
    showPinLabels: true,
    connectivityHighlight: true,
  dimUnhighlighted: true,
    mode: 'build',
    clipboard: loadClipboard<ClipboardPayload>(),
    rightTab: 'properties',
    buildStep: 0,
    dslText: serializeDesign(initial),
    dslDirty: false,
    dslErrors: [],
    lastResults: [],
    toasts: [],
    storage: { state: 'idle' },
    canRestorePrevious: hasPrevious(),
    highlightEndpoints: [],
    highlightObjects: [],
    fitRequest: 0,
    documentGeneration: 0,
    requestFit() {
      set({ fitRequest: get().fitRequest + 1 });
    },

    apply(ops, label) {
      const { design, past } = get();
      if (topologyGuard && !topologyGuard() && ops.some((op) => !NON_TOPOLOGY_OPS.has(op.op))) {
        const message = '仿真会话进行中：先点“停止”再修改设计';
        get().toast('error', message);
        return { ok: false, error: { code: 'op_failed', message } };
      }
      const r = applyOps(design, ops, { catalog: builtinCatalog() });
      if (!r.ok) {
        const details = r.error.results?.map((x) => `${x.code}: ${x.message}`) ?? r.error.issues?.map((i) => `${i.path} ${i.message}`) ?? [];
        get().toast('error', `${label ?? '操作'}未应用：${r.error.message}`, details.slice(0, 6));
        return r;
      }
      const next = r.design;
      const patch: Partial<State> = { design: next, past: [...past.slice(-199), design], future: [], lastResults: r.results };
      if (!get().dslDirty) patch.dslText = serializeDesign(next);
      set(patch);
      scheduleSave(next, set);
      return r;
    },

    undo() {
      const { past, design, future } = get();
      const prev = past[past.length - 1];
      if (!prev) return;
      const patch: Partial<State> = { design: prev, past: past.slice(0, -1), future: [design, ...future] };
      if (!get().dslDirty) patch.dslText = serializeDesign(prev);
      set(patch);
      scheduleSave(prev, set);
    },

    redo() {
      const { past, design, future } = get();
      const next = future[0];
      if (!next) return;
      const patch: Partial<State> = { design: next, past: [...past, design], future: future.slice(1) };
      if (!get().dslDirty) patch.dslText = serializeDesign(next);
      set(patch);
      scheduleSave(next, set);
    },

    select(ids, additive) {
      const cur = get().selectedIds;
      let next: string[];
      if (additive) {
        next = [...cur];
        for (const id of ids) {
          const i = next.indexOf(id);
          if (i >= 0) next.splice(i, 1);
          else next.push(id);
        }
      } else next = ids;
      set({ selectedIds: next, selectedHole: null, highlightEndpoints: [], highlightObjects: [] });
    },

    selectHole(addr) {
      set({ selectedHole: addr, selectedIds: addr ? [] : get().selectedIds, highlightEndpoints: [], highlightObjects: [] });
    },

    setTool(t) {
      set({ tool: t, placing: null, wireDraft: null });
    },
    setWireColor(c) {
      set({ wireColor: c });
    },
    setWireRoute(r) {
      set({ wireRoute: r });
    },

    startPlacing(model) {
      const def = catalogForDesign(get().design, builtinCatalog()).getComponent(model);
      set({ placing: { model, rotation: def?.preferred_rotation_deg ?? 0 }, tool: 'select', wireDraft: null, selectedIds: [] });
    },
    rotatePlacing() {
      const p = get().placing;
      if (!p) return;
      set({ placing: { ...p, rotation: (((p.rotation + 90) % 360) as 0 | 90 | 180 | 270) } });
    },
    cancelInteraction() {
      set({ placing: null, wireDraft: null });
    },
    setWireDraft(d) {
      set({ wireDraft: d });
    },

    toggleHoleLabels() {
      set({ showHoleLabels: !get().showHoleLabels });
    },
    togglePinLabels() {
      set({ showPinLabels: !get().showPinLabels });
    },
    toggleConnectivityHighlight() {
      set({ connectivityHighlight: !get().connectivityHighlight });
    },
    toggleDimUnhighlighted() {
      set({ dimUnhighlighted: !get().dimUnhighlighted });
    },
    setRightTab(t) {
      set({ rightTab: t, ...(t === 'wiring' ? { buildStep: 0 } : {}) });
    },
    setMode(m) {
      if (get().mode === m) return;
      // A half-drawn wire or a component on the cursor must not survive into 仿真,
      // where no tool exists to finish it. The live session is stopped by the
      // simulator store, which subscribes to this field: the dependency only ever
      // points that way, so this module still knows nothing about the runtime.
      get().cancelInteraction();
      const tab = get().rightTab;
      const away: RightTab = tab === 'simulation' || tab === 'hardware' ? 'properties' : tab;
      const rightTab: RightTab = m === 'sim' ? 'simulation' : m === 'hardware' ? 'hardware' : away;
      set({ mode: m, rightTab, ...(m === 'build' ? {} : { tool: 'select' as Tool }) });
    },
    setBuildStep(i) {
      set({ buildStep: i });
    },
    toggleBuildDone(wireId) {
      const design = get().design;
      const done = new Set(design.view?.build_done ?? []);
      if (done.has(wireId)) done.delete(wireId);
      else done.add(wireId);
      // View-only change: no revision bump, no undo entry.
      const next: DesignDocument = { ...design, view: { ...(design.view ?? {}), build_done: [...done] } };
      set({ design: next });
      scheduleSave(next, set);
    },

    setDslText(t) {
      set({ dslText: t, dslDirty: t !== serializeDesign(get().design), dslErrors: [] });
    },
    validateDsl() {
      const r = loadDesign(get().dslText);
      if (!r.ok || !r.design) {
        set({ dslErrors: r.errors.map((e) => `${e.path}: ${e.message}`) });
        return false;
      }
      const a = analyzeDesign(r.design, builtinCatalog());
      const blocking = a.results.filter((x) => x.blocking);
      set({ dslErrors: blocking.map((x) => `${x.code}: ${x.message}`) });
      return blocking.length === 0;
    },
    applyDsl() {
      const r = loadDesign(get().dslText);
      if (!r.ok || !r.design) {
        set({ dslErrors: r.errors.map((e) => `${e.path}: ${e.message}`) });
        const rec = recoverByExplicitDowngrade(get().dslText);
        get().toast('error', 'DSL 草稿有格式错误，未应用；画布保持不变。', rec ? ['错误来自缺少证据记录的 verified 内嵌定义：把相应状态改为 approximate 即可通过；用“项目 → 导入”打开同一文件时会执行同样的显式降级。'] : undefined);
        return;
      }
      // A draft taken before an artwork save still parses and still applies — and
      // takes the custom drawing with it. Say so; the change is one ⌘Z away.
      const dropped = droppedDefinitions(get().design, r.design);
      const res = get().apply([{ op: 'replace_design', design: r.design }], '应用 DSL');
      if (res.ok) {
        set({ dslDirty: false, dslErrors: [], dslText: serializeDesign(res.design) });
        get().toast('success', `DSL 已应用（revision ${res.revision}）。`);
        if (dropped.length) {
          get().toast('error', `草稿里没有这些型号的自定义绘图，它们已退回元件库版本：${dropped.join('、')}。撤销（⌘Z）可以找回。`, ['自定义绘图只存在于项目文档里；要让它对所有项目生效，请在外观编辑器里用“写回元件库”。']);
        }
      } else {
        set({ dslErrors: res.error.results?.map((x) => `${x.code}: ${x.message}`) ?? [res.error.message] });
      }
    },
    reloadDsl() {
      set({ dslText: serializeDesign(get().design), dslDirty: false, dslErrors: [] });
    },

    replaceDesign(d, opts) {
      stashPrevious(get().design);
      set({
        design: d,
        past: opts?.keepHistory ? get().past : [],
        future: [],
        selectedIds: [],
        selectedHole: null,
        wireDraft: null,
        placing: null,
        dslText: serializeDesign(d),
        dslDirty: false,
        dslErrors: [],
        lastResults: [],
        canRestorePrevious: true,
        buildStep: 0,
        highlightEndpoints: [],
        highlightObjects: [],
        fitRequest: get().fitRequest + 1,
        documentGeneration: get().documentGeneration + 1
      });
      scheduleSave(d, set);
    },
    newProject() {
      get().replaceDesign(createEmptyDesign('未命名项目'));
      get().toast('info', '已新建空项目。旧项目可通过“项目 → 恢复上一个项目”找回。');
    },
    loadExample(key) {
      const ex = EXAMPLES.find((e) => e.key === key);
      if (!ex) return;
      const r = loadDesign(JSON.parse(JSON.stringify(ex.doc)));
      if (!r.ok || !r.design) {
        get().toast('error', '示例加载失败', r.errors.map((e) => e.message));
        return;
      }
      get().replaceDesign(r.design);
      get().toast('success', `已载入示例：${r.design.metadata.name}`);
    },
    importJson(text) {
      const r = loadDesign(text);
      if (!r.ok || !r.design) {
        const rec = recoverByExplicitDowngrade(text);
        if (rec) {
          get().replaceDesign(rec.design);
          const a = analysisOf(rec.design);
          get().toast(a.hasBlocking ? 'error' : 'info', `已导入 ${rec.design.metadata.name}：其中 ${rec.demoted.length} 处内嵌定义标着 verified 却没有证据记录，已显式降级为 approximate。`, [
            `降级的声明：${describeDemoted(rec.demoted)}；已写入 status_notes。原文件未被改动，这不是校验放行。`,
            '导入不可 ⌘Z（replaceDesign 会清历史），“项目 → 恢复上一个项目”可回到导入前的项目。',
          ]);
          return { ok: true, errors: [] };
        }
        const errors = r.errors.map((e) => `${e.path}: ${e.message}`);
        get().toast('error', '导入失败：文件格式不符合 .breadboard.json schema，当前项目未改变。', errors.slice(0, 8));
        return { ok: false, errors };
      }
      get().replaceDesign(r.design);
      const a = analysisOf(r.design);
      get().toast(a.hasBlocking ? 'error' : 'success', `已导入 ${r.design.metadata.name}（revision ${r.design.metadata.revision}）${a.hasBlocking ? '，但存在结构错误，请查看校验面板' : ''}`);
      return { ok: true, errors: [] };
    },
    restorePrevious() {
      const prev = loadPrevious();
      if (!prev) {
        const text = readPreviousText();
        const rec = text ? recoverByExplicitDowngrade(text) : null;
        if (rec) {
          get().replaceDesign(rec.design);
          get().toast('info', `已恢复 ${rec.design.metadata.name}：其中 ${rec.demoted.length} 处内嵌定义标着 verified 却没有证据记录，已显式降级为 approximate。`, [
            `降级的声明：${describeDemoted(rec.demoted)}；已写入 status_notes，原文件未被改动。`,
          ]);
          return;
        }
        get().toast('info', '没有可恢复的上一个项目。');
        return;
      }
      get().replaceDesign(prev);
      get().toast('success', `已恢复：${prev.metadata.name}`);
    },

    toast(kind, text, details) {
      const id = toastId++;
      set({ toasts: [...get().toasts, { id, kind, text, details }] });
      window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 12000 : 5000);
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
    setHighlight(endpoints, objects) {
      set({ highlightEndpoints: endpoints, highlightObjects: objects, selectedIds: objects.filter((o) => get().design.boards.some((b) => b.id === o) || get().design.components.some((c) => c.id === o) || get().design.wires.some((w) => w.id === o)), selectedHole: null });
    },

    deleteSelection() {
      const { selectedIds, design } = get();
      if (!selectedIds.length) return;
      const ops: Op[] = [];
      for (const id of selectedIds) {
        if (design.wires.some((w) => w.id === id)) ops.push({ op: 'remove_wire', id });
        else if (design.components.some((c) => c.id === id)) ops.push({ op: 'remove_component', id, cascade: true });
        else if (design.boards.some((b) => b.id === id)) ops.push({ op: 'remove_board', id, cascade: true });
      }
      const r = get().apply(ops, '删除');
      if (r.ok) set({ selectedIds: [] });
    },
    rotateSelection() {
      const { selectedIds, design } = get();
      const ops: Op[] = [];
      for (const id of selectedIds) {
        if (design.components.some((c) => c.id === id)) ops.push({ op: 'rotate_component', id, by_deg: 90 });
        else if (design.boards.some((b) => b.id === id)) ops.push({ op: 'rotate_board', id, by_deg: 90 });
      }
      if (ops.length) get().apply(ops, '旋转');
    },
    duplicateSelection() {
      const { selectedIds, design } = get();
      const ops: Op[] = [];
      const newIds: string[] = [];
      let draft = design;
      for (const id of selectedIds) {
        const c = draft.components.find((x) => x.id === id);
        if (c) {
          const nid = nextIdFor(draft, `${c.model.split('@')[0]}_`);
          const pl = c.placement.kind === 'off_board' ? { ...c.placement, position_um: [c.placement.position_um[0] + 20000, c.placement.position_um[1] + 20000] as [number, number] } : { kind: 'off_board' as const, position_um: [0, 0] as [number, number], rotation_deg: c.placement.rotation_deg };
          const copy = { ...JSON.parse(JSON.stringify(c)), id: nid, placement: pl, name: c.name ? `${c.name} 副本` : undefined };
          ops.push({ op: 'add_component', component: copy });
          draft = { ...draft, components: [...draft.components, copy] };
          newIds.push(nid);
          continue;
        }
        const b = draft.boards.find((x) => x.id === id);
        if (b) {
          const nid = nextIdFor(draft, 'bb_');
          ops.push({ op: 'add_board', board: { id: nid, model: b.model, name: b.name ? `${b.name} 副本` : undefined, attach_to: { board_id: b.id, side: 'bottom', gap_um: 5000, grid_align: true }, rotation_deg: b.rotation_deg } });
          draft = { ...draft, boards: [...draft.boards, { ...b, id: nid }] };
          newIds.push(nid);
        }
      }
      if (!ops.length) return;
      const r = get().apply(ops, '复制');
      if (r.ok) {
        set({ selectedIds: newIds });
        get().toast('info', '副本已创建（元件副本放在板外，拖到目标位置即可）。');
      }
    },
    copySelection() {
      const { selectedIds, design } = get();
      const model = analysisOf(design).model;
      const components: ClipboardItem<ComponentInstance>[] = [];
      const boards: ClipboardItem<BoardInstance>[] = [];
      for (const id of selectedIds) {
        const c = design.components.find((x) => x.id === id);
        const pc = model.components.get(id);
        if (c && pc) {
          components.push({ instance: JSON.parse(JSON.stringify(c)) as ComponentInstance, posUm: [...pc.transform.position] });
          continue;
        }
        const b = design.boards.find((x) => x.id === id);
        const pb = model.boards.get(id);
        if (b && pb) boards.push({ instance: JSON.parse(JSON.stringify(b)) as BoardInstance, posUm: [...pb.transform.position] });
      }
      if (!components.length && !boards.length) {
        // Wires are the common case here: they are addresses into a layout, not parts.
        get().toast('info', selectedIds.length ? '选中的对象不能复制（导线不能单独复制，请复制它两端的元件）。' : '先选中元件或面包板再复制。');
        return;
      }
      const first = components[0];
      const refUm: PointUm = first ? anchorPointUm(model, design, first.instance.id) ?? first.posUm : boards[0].posUm;
      const payload: ClipboardPayload = { components, boards, refUm };
      set({ clipboard: payload });
      saveClipboard(payload);
      const what = [components.length ? `${components.length} 个元件` : '', boards.length ? `${boards.length} 块面包板` : ''].filter(Boolean).join('、');
      get().toast('info', `已复制 ${what}。按 ⌘V 粘贴到指针所在的孔位（导线不随复制）。`);
    },
    cutSelection() {
      const before = get().clipboard;
      get().copySelection();
      // Only cut once something actually made it into the buffer, or the delete would
      // destroy an object with no copy of it anywhere.
      if (get().clipboard !== before) get().deleteSelection();
    },
    pasteClipboard(atUm) {
      const clip = get().clipboard;
      if (!clip) return;
      const design = get().design;
      const catalog = catalogForDesign(design, builtinCatalog());
      const missing = [
        ...new Set([...clip.components.map((c) => c.instance.model), ...clip.boards.map((b) => b.instance.model)])
      ].filter((ref) => !catalog.getComponent(ref) && !catalog.getBoard(ref));
      if (missing.length) {
        // Pasting into another project whose catalog lacks the model: say so rather
        // than dropping half the paste on the floor.
        get().toast('error', `粘贴失败：本项目的元件库里没有 ${missing.join('、')}。`);
        return;
      }

      const delta: PointUm = atUm ? [atUm[0] - clip.refUm[0], atUm[1] - clip.refUm[1]] : [PASTE_OFFSET_UM, PASTE_OFFSET_UM];
      const addOps: Op[] = [];
      const newComponentIds: string[] = [];
      const newBoardIds: string[] = [];
      let draft = design;
      for (const b of clip.boards) {
        const id = nextIdFor(draft, 'bb_');
        const board: BoardInstance = { ...b.instance, id, position_um: [b.posUm[0] + delta[0], b.posUm[1] + delta[1]] };
        delete (board as { attach_to?: unknown }).attach_to;
        addOps.push({ op: 'add_board', board });
        draft = { ...draft, boards: [...draft.boards, board] };
        newBoardIds.push(id);
      }
      for (const c of clip.components) {
        const id = nextIdFor(draft, `${c.instance.model.split('@')[0]}_`);
        // Everything lands loose first, keeping the group's shape; the snap pass below
        // decides which of them fall into holes.
        const component: ComponentInstance = {
          ...c.instance,
          id,
          placement: { kind: 'off_board', position_um: [c.posUm[0] + delta[0], c.posUm[1] + delta[1]], rotation_deg: c.instance.placement.rotation_deg }
        };
        addOps.push({ op: 'add_component', component });
        draft = { ...draft, components: [...draft.components, component] };
        newComponentIds.push(id);
      }

      const staged = applyOps(design, addOps, { catalog, allow_blocking: true });
      if (!staged.ok) {
        get().toast('error', `粘贴失败：${staged.error.message}`);
        return;
      }
      // Snap against the staged document, then commit adds and moves as ONE transaction,
      // so a paste is a single undo step rather than "appeared" plus "jumped".
      const model = buildModel(staged.design, catalog);
      const snapOps: Op[] = [];
      for (const id of newComponentIds) {
        const placement = snapPlacement(model, staged.design, id, [0, 0]);
        if (placement) snapOps.push({ op: 'move_component', id, placement });
      }
      if (newBoardIds.length === 1 && !newComponentIds.length) {
        snapOps.push({ op: 'move_board', id: newBoardIds[0], position_um: snapBoardPosition(model, newBoardIds[0], [0, 0]) });
      }

      const r = get().apply([...addOps, ...snapOps], '粘贴');
      if (!r.ok) return;
      const ids = [...newBoardIds, ...newComponentIds];
      set({ selectedIds: ids });
      const loose = newComponentIds.filter((id) => {
        const placed = r.design?.components.find((c) => c.id === id);
        return placed?.placement.kind !== 'board';
      });
      if (loose.length) get().toast('info', `已粘贴，其中 ${loose.length} 个元件没落到孔位上（板外），拖动即可插进去。`);
    },
    toggleLockSelection() {
      const { selectedIds, design } = get();
      const ops: Op[] = [];
      for (const id of selectedIds) {
        const obj = [...design.boards, ...design.components, ...design.wires].find((o) => o.id === id);
        if (obj) ops.push({ op: 'update_property', id, path: 'locked', value: !obj.locked });
      }
      if (ops.length) get().apply(ops, '锁定/解锁');
    }
  };
});

// The initial restore recovery runs before any React component exists, so the
// disclosure goes out through the store itself as soon as it can hold a toast.
if (initialRestore.notice) useStore.getState().toast('error', initialRestore.notice.text, initialRestore.notice.details);

export { useStore };

export function useAnalysis(): Analysis {
  const design = useStore((s) => s.design);
  return analysisOf(design);
}
