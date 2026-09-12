import { WIRE_COLORS } from '@breadboard-studio/render';

/**
 * 线色选择：一排色点直接点选，不用翻下拉框。
 *
 * 线色在数据里既可以是 `WIRE_COLORS` 里的名字（`red`），也可以是 `#rrggbb`
 * ——画布用 `wireColor()` 解析两者，所以自定义颜色不需要改 schema。
 */

/** 常用顺序：先信号色，再电源/地，最后是少用的。 */
export const WIRE_COLOR_ORDER = [
  'red', 'black', 'blue', 'yellow', 'green', 'white',
  'orange', 'purple', 'brown', 'gray', 'cyan', 'pink'
] as const;

export const WIRE_COLOR_LABELS: Record<string, string> = {
  red: '红', black: '黑', blue: '蓝', yellow: '黄', green: '绿', white: '白',
  orange: '橙', purple: '紫', brown: '棕', gray: '灰', grey: '灰', cyan: '青', pink: '粉'
};

/** 名字或 hex → 供 `<input type="color">` 用的 `#rrggbb`。 */
function toHex(color: string): string {
  if (color.startsWith('#')) return color.length === 7 ? color : '#dc2626';
  const hex = WIRE_COLORS[color];
  return hex && hex.startsWith('#') ? hex : '#dc2626';
}

export function wireColorLabel(color: string): string {
  return WIRE_COLOR_LABELS[color] ?? color;
}

export function WireColorPicker({
  value,
  onChange,
  testId
}: {
  value: string;
  onChange: (color: string) => void;
  testId?: string;
}) {
  const named = WIRE_COLOR_ORDER.filter((c) => WIRE_COLORS[c]);
  const isCustom = !named.includes(value as (typeof WIRE_COLOR_ORDER)[number]);

  return (
    <div className="wire-colors" data-testid={testId} role="group" aria-label="线色">
      {named.map((c) => (
        <button
          key={c}
          type="button"
          className={`wire-color-dot${value === c ? ' on' : ''}`}
          style={{ background: WIRE_COLORS[c] }}
          title={`${wireColorLabel(c)}（${c}）`}
          aria-label={`${wireColorLabel(c)}（${c}）`}
          aria-pressed={value === c}
          data-color={c}
          onClick={() => onChange(c)}
        />
      ))}
      <label
        className={`wire-color-custom${isCustom ? ' on' : ''}`}
        style={isCustom ? { background: toHex(value) } : undefined}
        title={`自定义颜色${isCustom ? `（${value}）` : ''}`}
      >
        <input
          type="color"
          value={toHex(value)}
          aria-label="自定义颜色"
          data-testid={testId ? `${testId}-custom` : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  );
}
