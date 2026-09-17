import { useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { clampPanelWidth, previewPanelWidth, setPanelWidth, togglePanel, useLayout, type PanelSide } from '../layout';

/** 横向移动超过这个像素数才算「拖」，否则就是一次点击（折叠/展开）。 */
const MOVE_THRESHOLD = 3;

/**
 * 面板内侧那条常驻轨道（issue #39）：拖它改宽度，点它折叠/展开。
 *
 * 两件事共用一个元素是有意的 —— 它是面板边缘唯一的东西，折叠后仍然在，所以
 * 「折叠过的面板打不开」不会发生。拖拽用 `setPointerCapture`（和仿真里的代码抽屉
 * `.code-handle` 同一写法）：指针移出这 10px 窄条后事件照样回到这里。
 *
 * 面板宽度只在这一层改：`previewPanelWidth` 每帧只写 CSS 变量，pointerup 才
 * `setPanelWidth` 落一次盘。两者都不碰设计数据，所以撤销栈和「未保存」状态不受影响。
 */
export function PanelRail({ side }: { side: PanelSide }) {
  const layout = useLayout();
  const collapsed = side === 'left' ? layout.leftCollapsed : layout.rightCollapsed;
  const width = side === 'left' ? layout.leftWidth : layout.rightWidth;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; last: number; moved: boolean } | null>(null);
  // 拖过一次之后浏览器仍会补一个 click；不拦掉就会在松手时顺带折叠面板。
  const justDragged = useRef(false);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    // 上一次拖动留下来的抑制标记到这里就作废：万一那次拖动没补出 click（浏览器行为、
    // 中途失焦等），下一次性交互不该被它吃掉。
    justDragged.current = false;
    // 折叠时只有「展开」一件事：从 0 宽度起算的拖动没有意义。
    if (collapsed || e.button !== 0) return;
    e.preventDefault(); // 拖把手时不要顺手选中面板里的文字
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width, last: width, moved: false };
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    // 右面板向左拖才是变宽，所以两个方向的符号相反。
    const outward = side === 'left' ? e.clientX - d.startX : d.startX - e.clientX;
    if (Math.abs(e.clientX - d.startX) > MOVE_THRESHOLD) d.moved = true;
    d.last = clampPanelWidth(d.startWidth + outward);
    previewPanelWidth(side, d.last);
  };

  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d || !d.moved) return; // 没动过就是一次点击，交给 onClick 去折叠
    justDragged.current = true;
    setPanelWidth(side, d.last);
  };

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    // 只拦指针点出来的 click（detail >= 1）：键盘 Enter/空格触发的 click 的 detail 是 0，
    // 它永远不该被拖动标记影响。
    if (e.detail > 0 && justDragged.current) {
      justDragged.current = false;
      return;
    }
    togglePanel(side);
  };

  const name = side === 'left' ? '左侧面板' : '右侧面板';
  const shortcut = side === 'left' ? '[' : ']';
  return (
    <button
      type="button"
      className={`panel-rail ${side} ${collapsed ? 'collapsed' : ''} ${dragging ? 'dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={onClick}
      aria-expanded={!collapsed}
      aria-controls={`panel-${side}`}
      aria-label={`${collapsed ? '展开' : '折叠'}${name}`}
      title={`${collapsed ? '展开' : '折叠'}${name}（${shortcut}）；拖动可调整宽度`}
      data-testid={`panel-rail-${side}`}
    >
      <span className="panel-rail-grip" aria-hidden="true" />
      <span className="panel-rail-chevron" aria-hidden="true">
        {side === 'left' ? (collapsed ? '›' : '‹') : collapsed ? '‹' : '›'}
      </span>
    </button>
  );
}