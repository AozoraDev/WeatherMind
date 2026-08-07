# 组件与样式

界面**优先复用 shadcn/ui**，不裸写 Tailwind 造轮子。

- 先查 `components/ui/`；没有用 `pnpm dlx shadcn@latest add <x>` 生成再裁剪
- 常规调整用 `variant`/`size`/`className`+`cn()`，不改组件源码
- 新变体优先加在组件内 `variant`
- 明暗模式走 CSS 变量（`:root`/`.dark`），不写死颜色值

**避免**：库里有却重复堆 Tailwind 类、页面长串内联样式。
