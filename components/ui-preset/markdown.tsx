import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"

// Markdown 渲染预设：react-markdown + remark-gfm（表格/任务列表），
// components 手动映射到 shadcn 风格元素（不引入 @tailwindcss/typography），
// 明暗色走 CSS 变量（text-foreground / text-muted-foreground / bg-muted 等）。
// 供预报 Agent 的流式 Markdown 正文（## 推理过程 / ## 预报）渲染。

type MarkdownProps = {
  className?: string
  children: string
}

export function Markdown({ className, children }: MarkdownProps) {
  return (
    <div className={cn("text-sm leading-6", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ className: c, ...p }) => (
            <h1
              className={cn(
                "mb-3 mt-4 text-xl font-semibold tracking-tight first:mt-0",
                c
              )}
              {...p}
            />
          ),
          h2: ({ className: c, ...p }) => (
            <h2
              className={cn(
                "mb-3 mt-5 flex items-center gap-2 border-b pb-1.5 text-base font-semibold tracking-tight first:mt-0",
                c
              )}
              {...p}
            />
          ),
          h3: ({ className: c, ...p }) => (
            <h3
              className={cn("mb-2 mt-4 text-sm font-semibold", c)}
              {...p}
            />
          ),
          p: ({ className: c, ...p }) => (
            <p className={cn("my-2", c)} {...p} />
          ),
          ul: ({ className: c, ...p }) => (
            <ul className={cn("my-2 list-disc space-y-1 pl-5", c)} {...p} />
          ),
          ol: ({ className: c, ...p }) => (
            <ol className={cn("my-2 list-decimal space-y-1 pl-5", c)} {...p} />
          ),
          li: ({ className: c, ...p }) => (
            <li className={cn("leading-6", c)} {...p} />
          ),
          strong: ({ className: c, ...p }) => (
            <strong className={cn("font-semibold", c)} {...p} />
          ),
          em: ({ className: c, ...p }) => (
            <em className={cn("italic", c)} {...p} />
          ),
          del: ({ className: c, ...p }) => (
            <del className={cn("text-muted-foreground", c)} {...p} />
          ),
          blockquote: ({ className: c, ...p }) => (
            <blockquote
              className={cn(
                "my-3 border-l-2 border-primary/40 bg-muted/40 px-3 py-1 text-muted-foreground",
                c
              )}
              {...p}
            />
          ),
          hr: ({ className: c, ...p }) => (
            <hr className={cn("my-4 border-t border-border", c)} {...p} />
          ),
          a: ({ className: c, ...p }) => (
            <a
              className={cn("text-primary underline underline-offset-2", c)}
              target="_blank"
              rel="noreferrer"
              {...p}
            />
          ),
          code: ({ className: c, ...p }) => {
            // 行内 code：inline 无 language 类；fenced 块由 pre>code 承载，这里只保留原样交给 pre 处理
            const inline = !c
            return inline ? (
              <code
                className={cn(
                  "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground",
                  c
                )}
                {...p}
              />
            ) : (
              <code className={cn(c)} {...p} />
            )
          },
          pre: ({ className: c, ...p }) => (
            <pre
              className={cn(
                "my-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-[0.85em] text-foreground",
                c
              )}
              {...p}
            />
          ),
          table: ({ className: c, ...p }) => (
            <div className="my-3 overflow-x-auto">
              <table
                className={cn(
                  "w-full border-collapse text-sm",
                  c
                )}
                {...p}
              />
            </div>
          ),
          thead: ({ className: c, ...p }) => (
            <thead className={cn("bg-muted/60", c)} {...p} />
          ),
          tbody: ({ className: c, ...p }) => (
            <tbody className={cn("", c)} {...p} />
          ),
          tr: ({ className: c, ...p }) => (
            <tr className={cn("border-b border-border/60", c)} {...p} />
          ),
          th: ({ className: c, ...p }) => (
            <th
              className={cn(
                "border px-3 py-1.5 text-left font-medium text-muted-foreground",
                c
              )}
              {...p}
            />
          ),
          td: ({ className: c, ...p }) => (
            <td className={cn("border px-3 py-1.5", c)} {...p} />
          ),
          input: (props) => (
            <input className="mr-1.5 align-middle accent-primary" {...props} />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
