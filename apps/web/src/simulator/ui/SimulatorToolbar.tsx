import { STATUS_LABELS, type SimCommand } from '@breadboard-studio/sim';
import { useStore } from '../../store';
import { useSimulatorStore } from '../simulatorStore';

/** Run / pause / step / reset / stop plus the status light (docs §11.1). Rendered inside the main toolbar. */
export function SimulatorToolbar() {
  const status = useSimulatorStore((s) => s.status);
  const allowed = useSimulatorStore((s) => s.allowed);
  const sim = useSimulatorStore.getState();
  const can = (command: SimCommand) => allowed.includes(command);

  const onRun = () => {
    const st = useStore.getState();
    if (st.rightTab !== 'simulation') st.setRightTab('simulation');
    void sim.run();
  };

  return (
    <div className="tool-group sim-controls" role="group" aria-label="仿真">
      {/* Labels collapse to the icon on narrow toolbars (see .sim-label in styles.css) so the toolbar stays on one row. */}
      <button onClick={onRun} disabled={!can('run')} title="运行仿真" aria-label="运行" data-testid="sim-run">▶<span className="sim-label"> 运行</span></button>
      <button onClick={() => void sim.pause()} disabled={!can('pause')} title="暂停" aria-label="暂停" data-testid="sim-pause">⏸<span className="sim-label"> 暂停</span></button>
      <button onClick={() => void sim.step()} disabled={!can('step')} title="单步事件" aria-label="单步" data-testid="sim-step">⏭<span className="sim-label"> 单步</span></button>
      <button onClick={() => void sim.reset()} disabled={!can('reset')} title="复位：重新准备同一程序" aria-label="复位" data-testid="sim-reset">↻<span className="sim-label"> 复位</span></button>
      <button onClick={() => void sim.stop()} disabled={!can('stop')} title="停止会话并允许编辑设计" aria-label="停止" data-testid="sim-stop">■<span className="sim-label"> 停止</span></button>
      <span className={`sim-status sim-status-${status}`} title={`仿真状态：${STATUS_LABELS[status]}`} data-testid="sim-status">{STATUS_LABELS[status]}</span>
    </div>
  );
}
