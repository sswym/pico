---
description: Worker 实现，reviewer 审查，worker 应用反馈
---
使用 subagent 工具的 chain 参数执行此工作流：

1. 首先，使用 "worker" agent 实现：$@
2. 然后，使用 "reviewer" agent 审查上一步的实现（使用 {previous} 占位符）
3. 最后，使用 "worker" agent 应用审查的反馈（使用 {previous} 占位符）

以链式执行，通过 {previous} 在步骤之间传递输出。