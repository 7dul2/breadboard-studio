import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { installTestHooks } from './testHooks';
import { initTheme } from './theme';

installTestHooks();
// 与 index.html 的启动脚本等价（那里负责首帧）；这里是存储不可用等兜底路径。
initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
