# 组件与样式

界面样式**优先复用 shadcn/ui 组件**，不裸写 Tailwind 类造轮子。

- 按钮、输入框、卡片、对话框、下拉菜单等，先查 `components/ui/` 是否已有
- 没有的用 `pnpm dlx shadcn@latest add <component>` 生成，再按需裁剪
- 常规调整用 `variant` / `size` / `className`+`cn()`，不改组件源码
- 需要新变体时优先在组件内加 `variant`
- 明暗模式走 CSS 变量体系（补 `:root` / `.dark`），不写死颜色值

**避免**：组件库已有却重复堆 Tailwind 类、页面里写一长串内联样式。
