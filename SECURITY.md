# 安全政策

Breadboard Studio v0.1 是纯静态前端 + 本地 CLI：不联网、不上传设计、不存储账号；设计数据只保存在浏览器 localStorage 与你自己的文件里。

- 设计文件与元件定义都是纯数据（JSON Schema 校验，`additionalProperties: false`），不会被 eval 或执行。
- SVG/PNG 导出由本地生成，文本内容经过转义。
- 依赖锁定在 `pnpm-lock.yaml`。

发现漏洞（例如通过设计文件或定义 JSON 注入脚本、导出内容未转义等）请在 GitHub 提交 issue（标题以 `[security]` 开头），或使用仓库的私密漏洞报告功能（如已启用）。请勿在报告中附带真实的网络凭据或私人文件。
