# 组件与样式

优先复用 shadcn/ui（`components/ui/`），不裸写 Tailwind 造轮子
- 没有的用 `pnpm dlx shadcn@latest add <x>` 生成再裁剪
- 常规调整用 `variant`/`size`/`className`+`cn()`，不改组件源码；新变体加在组件内 `variant`
- 明暗走 CSS 变量（`:root`/`.dark`），不写死颜色值

避免：库里有却重复堆 Tailwind、页面长串内联样式
