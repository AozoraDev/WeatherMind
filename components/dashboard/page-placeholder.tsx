// 空页占位组件：功能开发中的页面统一居中展示标题与描述，后续换成真实内容
export function PagePlaceholder({
  title,
  desc,
}: {
  title: string
  desc: string
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-background px-4 text-center">
      <h1 className="text-3xl font-semibold text-foreground">{title}</h1>
      <p className="text-muted-foreground">{desc}</p>
    </div>
  )
}
