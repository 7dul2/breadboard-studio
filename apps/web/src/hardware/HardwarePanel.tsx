/**
 * 实机 — a cable to a real board (阶段 5 RFC §5.1).
 *
 * The panel's first job is to be honest about what it is. The RFC declined phase 5
 * because a browser cannot compile Xtensa and a real board cannot be paused, stepped
 * or replayed; this feature is the useful remainder of that investigation, and it is
 * deliberately not called simulation and not registered as a backend.
 */
import { useEffect, useRef } from 'react';
import { useHardwareStore } from './hardwareStore';
import { BAUD_RATES } from './serial-link';

export function HardwarePanel() {
  const status = useHardwareStore((s) => s.status);
  const lines = useHardwareStore((s) => s.lines);
  const error = useHardwareStore((s) => s.error);
  const baudRate = useHardwareStore((s) => s.baudRate);
  const support = useHardwareStore((s) => s.support);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Follow the tail, the way a serial monitor does.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const connected = status === 'connected';

  return (
    <div className="sim-panel hardware" data-testid="hardware-panel">
      <div className="panel-title">实机</div>
      <p className="muted small">
        用串口连接一块真板，看它打印什么。<b>这不是仿真</b>：真板的引脚接的是桌上的真元件，画布上模拟的 OLED 与传感器不在那个电路里，也无法暂停、单步或回放一颗真实 MCU。
      </p>

      {!support.supported && (
        <p className="hint" data-testid="hardware-unsupported">
          {support.message}
        </p>
      )}

      <section className="sim-section">
        <div className="row">
          <label>
            波特率
            <select
              value={baudRate}
              disabled={connected}
              onChange={(e) => useHardwareStore.getState().setBaudRate(Number(e.target.value))}
              data-testid="hardware-baud"
            >
              {BAUD_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}
                </option>
              ))}
            </select>
          </label>
          {connected ? (
            <button onClick={() => void useHardwareStore.getState().disconnect()} data-testid="hardware-disconnect">
              断开
            </button>
          ) : (
            <button
              className="primary"
              disabled={!support.supported || status === 'connecting'}
              onClick={() => void useHardwareStore.getState().connect()}
              data-testid="hardware-connect"
            >
              {status === 'connecting' ? '连接中…' : '连接串口…'}
            </button>
          )}
          <button disabled={!connected} onClick={() => void useHardwareStore.getState().pulseReset()} title="拉低 EN 约 100 ms。只有带自动复位电路的开发板会响应；走原生 USB 口时没有这条电路" data-testid="hardware-reset">
            复位
          </button>
          <button disabled={!lines.length} onClick={() => useHardwareStore.getState().clear()} data-testid="hardware-clear">
            清空
          </button>
        </div>
        {error && (
          <p className="error small" data-testid="hardware-error">
            {error}
          </p>
        )}
      </section>

      <section className="sim-section">
        <div className="sim-section-title">
          串口输出 <span className="muted">{lines.length ? `${lines.length} 行` : ''}</span>
        </div>
        <div className="sim-serial hardware-console" ref={logRef} data-testid="hardware-console">
          {lines.length === 0 ? (
            <p className="muted small">{connected ? '已连接，等待板子输出。' : '还没有连接。'}</p>
          ) : (
            lines.map((line, i) => (
              <div key={`${line.atMs}-${i}`}>
                <span className="muted">[{new Date(line.atMs).toLocaleTimeString()}]</span> {line.text}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
