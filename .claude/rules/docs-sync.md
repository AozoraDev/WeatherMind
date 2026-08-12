# 开发文档同步

`docs/developer-zh.md`/`developer-en.md` 是人读的模块开发文档（模块职责+文件内方法作用），`docs/quickstart-zh.md`/`quickstart-en.md` 是人读的核心链路与代码地图；**agent 勿读**、不作编码依据；但**每次代码变动必须同步更新四份**（中文简体/英文，条目一一对应）。

改以下任何源码/配置后同步：`app/`、`lib/`、`components/`、`hooks/`、`i18n/`、`supabase/`（含 migrations）、`scripts/`、`proxy.ts`、`next.config.ts`、`vitest.config.ts`、`stryker.config.json`、`.github/workflows/`

- 文件职责/方法作用/契约/数据流变化 → 改对应条目
- 新增/删除/改名函数、方法、导出、文件 → 增删对应条目
- 只记人读的稳定信息（模块职责、关键签名与作用、依赖/数据流）；不记行号、不抄实现、不提「本次改动」

不要：不读此文档作编码依据；不为它写测试、不加入 mutate 白名单；不改 `docs/` 下 developer、quickstart 之外的其他文件。
