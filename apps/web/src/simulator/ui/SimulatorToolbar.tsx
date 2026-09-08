import { useMemo, useState } from 'react';
import { STATUS_LABELS, simulationBlockers, type SimCommand } from '@breadboard-studio/sim';
import { analysisOf, useStore } from '../../store';
import { useSimulatorStore } from '../simulatorStore';

/**
 * Debug-only override for the simulation pre-flight (docs/SIMULATOR_RUNTIME_PLAN.md §9.5).
 * It lives in localStorage and nowhere else: it must never reach the design document,
 * so a shared or exported project can never carry "start anyway" with it.
 */
export const SIM_FORCE_START_KEY = 'bbs.sim.force-start';

export function readForceStart(): boolean {
  try {
    return localStorage.getItem(SIM_FORCE_START_KEY) === '1';
  } catch {
    return false; // private mode / storage disabled: never force by accident
  }
}

function writeForceStart(value: boolean): void {
  try {
    if (value) localStorage.setItem(SIM_FORCE_START_KEY, '1');
    else localStorage.removeItem(SIM_FORCE_START_KEY);
  } catch {
    // storage is a convenience here; the in-memory state still drives this session
  }
}

/** Run / pause / step / reset / stop plus the status light (docs §11.1). Rendered inside the main toolbar. */
export function SimulatorToolbar() {
  const status = useSimulatorStore((s) => s.status);
  const allowed = useSimulatorStore((s) => s.allowed);
  const forceStarted = useSimulatorStore((s) => s.forceStarted);
  const design = useStore((s) => s.design);
  const [force, setForce] = useState(readForceStart);
  const can = (command: SimCommand) => allowed.includes(command);

  // The same two codes the controller pre-flight uses; `analysisOf` is memoised per document.
  const blockers = useMemo(() => simulationBlockers(analysisOf(design).results), [design]);
  const blockerCodes = [...new Set(blockers.map((b) => b.code))];

  const onRun = () => {
    const st = useStore.getState();
    // Running is a 仿真 activity: if anything ever triggers it from elsewhere, the
    // mode follows, so the frozen design and the transport arrive together.
    st.setMode('sim');
    // The store forwards this straight to `SimulatorController.run(design, opts)`.
    const run = useSimulatorStore.getState().run as (opts?: { forceStart?: boolean }) => Promise<void>;
    void run({ forceStart: force });
  };

  const onToggleForce = (next: boolean) => {
    setForce(next);
    writeForceStart(next);
  };

  return (
    <div className="tool-group sim-controls" role="group" aria-label="仿真">
      {/* Labels collapse to the icon on narrow toolbars (see .sim-label in styles.css) so the toolbar stays on one row. */}
      <button onClick={onRun} disabled={!can('run')} title="运行仿真" aria-label="运行" data-testid="sim-run">▶<span className="sim-label"> 运行</span></button>
      <button onClick={() => void sim().pause()} disabled={!can('pause')} title="暂停" aria-label="暂停" data-testid="sim-pause">⏸<span className="sim-label"> 暂停</span></button>
      <button onClick={() => void sim().step()} disabled={!can('step')} title="单步事件" aria-label="单步" data-testid="sim-step">⏭<span className="sim-label"> 单步</span></button>
      <button onClick={() => void sim().reset()} disabled={!can('reset')} title="复位：重新准备同一程序" aria-label="复位" data-testid="sim-reset">↻<span className="sim-label"> 复位</span></button>
      <button onClick={() => void sim().stop()} disabled={!can('stop')} title="停止并编辑：结束会话并允许编辑设计" aria-label="停止并编辑" data-testid="sim-stop">■<span className="sim-label"> 停止</span></button>
      <span className={`sim-status sim-status-${status}`} title={`仿真状态：${STATUS_LABELS[status]}`} data-testid="sim-status">{STATUS_LABELS[status]}</span>
      {(blockers.length > 0 || forceStarted) && (
        <>
          <span className="sim-blockers" title={blockers.map((b) => b.message).join('\n') || '设计已修好；取消勾选后下次运行将恢复正常检查。'} data-testid="sim-blockers">
            ⛔ {blockers.length} 项电气阻断{blockerCodes.length ? `（${blockerCodes.join('、')}）` : ''}
          </span>
          <label className="toggle sim-force-toggle" title="仅用于调试：跳过“电源对地短路 / 电压冲突”的启动前检查。该开关只保存在本机浏览器里，不会写进设计文件。">
            <input type="checkbox" checked={force} onChange={(e) => onToggleForce(e.target.checked)} data-testid="sim-force-start" />
            仅调试：强制启动
          </label>
        </>
      )}
      {forceStarted && (
        <div className="sim-force-banner" role="alert" data-testid="sim-force-banner">
          ⛔ 已强制启动仿真：设计存在电气错误（{blockerCodes.join('、') || 'power_ground_short / voltage_conflict'}），按此接线的真实电路可能损坏，仿真结果不可信。
        </div>
      )}
    </div>
  );
}

/** Fresh store snapshot: the command handlers must not close over a stale one. */
function sim() {
  return useSimulatorStore.getState();
}
