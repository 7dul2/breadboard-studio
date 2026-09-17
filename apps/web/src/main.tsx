import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { installTestHooks } from './testHooks';
import { initTheme } from './theme';
import { initLayout } from './layout';

installTestHooks();
// 与 index.html 的启动脚本等价（那里负责首帧）；这里是存储不可用等兜底路径。
initTheme();
// 面板宽度同理：渲染前写好 --panel-*-width，避免首帧用默认宽度闪一下再跳到存下来的宽度。
initLayout();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
