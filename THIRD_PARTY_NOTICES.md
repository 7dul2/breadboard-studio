# 第三方声明

## 代码依赖

运行时与开发依赖及其许可证以 `pnpm-lock.yaml` 为准（React、Vite、zustand、Ajv、commander、tsx、TypeScript、Vitest、Playwright 等均为 MIT 或兼容的宽松许可证）。可用 `pnpm licenses list` 查看。

## 元件与面包板数据

`packages/catalog/src/definitions/*.json` 中的所有绘图（`render`）均为本项目原创矢量，不包含 Tinkercad、Fritzing 或任何厂商的图片/SVG/元件库。尺寸、引脚名与电气参数取自各定义 `sources` 字段列出的公开资料（Seeed Studio Wiki、Espressif 文档、Sensirion / Bosch / Lite-On / Tontek 数据手册等），并按 `geometry_status` / `electrical_status` 标注核实程度。产品名称与商标归各自所有者所有，仅用于识别。

## 字体

界面与导出使用系统字体栈（system-ui / PingFang SC / Noto Sans CJK），不随仓库分发字体文件。
