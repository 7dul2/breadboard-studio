import type { JsonValue } from '@breadboard-studio/schema';
import type { DesignModel } from '@breadboard-studio/core';
import { useStore } from '../store';

export interface SelectionToolbarPosition {
  left: number;
  top: number;
}

interface SelectionToolbarProps {
  model: DesignModel;
  selectedIds: string[];
  position: SelectionToolbarPosition | null;
  onFlipBoard: (boardId: string) => void;
  onOpenAutoWire: () => void;
}

function schemaProps(schema: Record<string, JsonValue> | undefined): [string, Record<string, JsonValue>][] {
  const props = schema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  return Object.entries(props as Record<string, Record<string, JsonValue>>);
}

function optionLabel(value: JsonValue): string {
  if (value === 'inserted') return '已插卡';
  if (value === 'empty') return '空卡槽';
  if (value === 'white') return '白色';
  if (value === 'blue') return '蓝色';
  if (value === 60) return '0x3C';
  if (value === 61) return '0x3D';
  if (value === 'active_high') return '高有效';
  if (value === 'active_low') return '低有效';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function QuickConfig({
  id,
  config,
  schema,
  disabled
}: {
  id: string;
  config: Record<string, JsonValue>;
  schema: Record<string, JsonValue> | undefined;
  disabled: boolean;
}) {
  const st = useStore.getState();
  const quickProps = schemaProps(schema)
    .filter(([, prop]) => Array.isArray(prop.enum) || prop.type === 'boolean')
    .slice(0, 2);
  if (!quickProps.length) return null;

  return (
    <div className="selection-toolbar-config" data-testid="selection-toolbar-config">
      <span className="selection-toolbar-label">快速调节</span>
      {quickProps.map(([key, prop]) => {
        const label = typeof prop.title === 'string' ? prop.title : key;
        const hint = typeof prop.description === 'string' ? prop.description : undefined;
        if (prop.type === 'boolean') {
          return (
            <label key={key} className="selection-toolbar-toggle" title={hint}>
              <input
                type="checkbox"
                checked={config[key] === true}
                disabled={disabled}
                onChange={(e) => st.apply([{ op: 'update_property', id, path: `config.${key}`, value: e.target.checked }], '快速修改配置')}
              />
              {label}
            </label>
          );
        }
        const options = Array.isArray(prop.enum) ? prop.enum : [];
        const current = JSON.stringify(config[key]);
        return (
          <label key={key} className="selection-toolbar-field" title={hint}>
            <span>{label}</span>
            <select
              value={current}
              disabled={disabled}
              onChange={(e) => {
                const next = options.find((value) => JSON.stringify(value) === e.target.value);
                if (next !== undefined) st.apply([{ op: 'update_property', id, path: `config.${key}`, value: next }], '快速修改配置');
              }}
            >
              {options.map((value) => {
                const encoded = JSON.stringify(value);
                return <option key={encoded} value={encoded}>{optionLabel(value)}</option>;
              })}
            </select>
          </label>
        );
      })}
    </div>
  );
}

export function SelectionToolbar({ model, selectedIds, position, onFlipBoard, onOpenAutoWire }: SelectionToolbarProps) {
  if (!position || selectedIds.length === 0) return null;

  const st = useStore.getState();
  const selectedBoards = selectedIds.map((id) => model.boards.get(id)).filter(present);
  const selectedComponents = selectedIds.map((id) => model.components.get(id)).filter(present);
  const selectedWires = selectedIds.map((id) => model.wires.get(id)).filter(present);
  const objects = [...selectedBoards, ...selectedComponents, ...selectedWires];
  const allLocked = objects.length > 0 && objects.every((object) => Boolean(object.instance.locked));
  const anyLocked = objects.some((object) => Boolean(object.instance.locked));
  const singleBoard = selectedIds.length === 1 ? selectedBoards[0] : undefined;
  const singleComponent = selectedIds.length === 1 ? selectedComponents[0] : undefined;
  const singleWire = selectedIds.length === 1 ? selectedWires[0] : undefined;
  const boardIsPerfboard = singleBoard?.def.render.style === 'perfboard';

  return (
    <div
      className="selection-toolbar"
      style={{ left: position.left, top: position.top }}
      data-testid="selection-toolbar"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="selection-toolbar-caption">
        {selectedIds.length > 1 ? `已选 ${selectedIds.length} 个` : singleBoard ? '板件' : singleComponent ? '元件' : singleWire ? '导线' : '对象'}
      </span>
      {selectedIds.length > 1 && selectedComponents.length >= 2 && (
        <button onClick={onOpenAutoWire} title="打开自动排线设置" data-testid="selection-toolbar-auto-wire">自动排线…</button>
      )}
      {(singleBoard || singleComponent) && (
        <button onClick={st.rotateSelection} disabled={anyLocked} title="顺时针旋转 90°" data-testid="selection-toolbar-rotate">↻ 旋转</button>
      )}
      {boardIsPerfboard && singleBoard && (
        <button onClick={() => onFlipBoard(singleBoard.instance.id)} title="只翻转这块洞洞板的显示面" data-testid="selection-toolbar-flip">⇄ 翻面</button>
      )}
      {singleWire && (
        <label className="selection-toolbar-field" title="快速切换导线类型">
          <span>走线</span>
          <select
            value={singleWire.instance.route}
            disabled={Boolean(singleWire.instance.locked)}
            onChange={(e) => st.apply([{ op: 'update_property', id: singleWire.instance.id, path: 'route', value: e.target.value }], '快速修改走线')}
          >
            <option value="flat">硬质跳线</option>
            <option value="elevated">杜邦线</option>
          </select>
        </label>
      )}
      {singleComponent && (
        <QuickConfig id={singleComponent.instance.id} config={singleComponent.resolved.config} schema={singleComponent.def.config_schema} disabled={Boolean(singleComponent.instance.locked)} />
      )}
      <button onClick={st.toggleLockSelection} title={allLocked ? '解锁选中对象' : '锁定选中对象'} data-testid="selection-toolbar-lock">{allLocked ? '解锁' : '锁定'}</button>
      {(singleBoard || singleComponent) && <button onClick={st.duplicateSelection} disabled={anyLocked && Boolean(singleBoard)} title="复制选中对象" data-testid="selection-toolbar-duplicate">复制</button>}
      <button className="danger" onClick={st.deleteSelection} disabled={anyLocked} title="删除选中对象" data-testid="selection-toolbar-delete">删除</button>
    </div>
  );
}
