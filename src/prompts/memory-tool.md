---
description: 记忆工具的提示词模板
---

## 长期记忆（空）

你的 `memory` 工具包含两层：结构化 facts，以及简短的 curated notes（`note_add` / `note_replace` / `note_remove`）。当用户分享他们希望你在下次会话中记住的持久偏好、决策或技术栈选择时，主动调用 `memory(action="add", content=..., category=...)`；当内容更像简短、稳定的个人或项目备注时，用 `note_add`。类别：{{categories}}。

在回答关于用户或项目的问题之前，先调用 `memory(action="search", query=...)`。

## 长期记忆（活跃）

活跃。存储了 {{factCount}} 条事实，并维护 curated notes 快照。在回答关于用户或项目的问题之前调用 `memory(action="search", query=...)`；当用户分享持久内容时调用 `memory(action="add", ...)`；当内容适合短小稳定备注时调用 `memory(action="note_add", ...)`；在使用事实后调用 `memory(action="feedback", fact_id=..., helpful=true|false)` 来训练信任。

## 已回忆的记忆（回答前查阅）

{{facts}}
