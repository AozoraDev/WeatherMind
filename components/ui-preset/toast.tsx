"use client"

import { Toast } from "@base-ui/react/toast"
import { CircleAlert, CircleCheck, Info, X } from "lucide-react"
import { type ReactNode } from "react"

import { cn } from "@/lib/utils"

// toast 类型：success（浅绿）/ error（浅红）/ default（中性），决定配色与图标
type ToastType = "success" | "error" | "default"

const toastStyles: Record<ToastType, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  error: "border-red-200 bg-red-50 text-red-600",
  default: "border-slate-200 bg-white text-slate-700",
}

const toastIcons: Record<ToastType, ReactNode> = {
  success: <CircleCheck className="size-5 shrink-0" />,
  error: <CircleAlert className="size-5 shrink-0" />,
  default: <Info className="size-5 shrink-0" />,
}

// Toast 预设：应用根部挂载一次，统一渲染顶部居中 toast 视口；
// 配合 useToast() 触发成功（浅绿）/失败（浅红）提示
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider limit={4}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed inset-x-0 top-6 z-50 mx-auto flex w-[calc(100vw-2rem)] flex-col gap-2 sm:w-96">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

// 渲染 toast 列表：按 type 取配色与图标；从顶部自上而下滑入，退出时向上收起
function ToastList() {
  const { toasts } = Toast.useToastManager()
  return toasts.map((toast) => {
    const type = (toast.type as ToastType) ?? "default"
    return (
      <Toast.Root
        key={toast.id}
        toast={toast}
        className={cn(
          "flex items-start gap-2.5 rounded-xl border p-3.5 shadow-lg shadow-slate-900/5",
          "transition-[transform,opacity] duration-300 ease-out",
          "data-starting-style:-translate-y-3 data-starting-style:opacity-0",
          "data-ending-style:-translate-y-3 data-ending-style:opacity-0",
          toastStyles[type]
        )}
      >
        {toastIcons[type]}
        <Toast.Description className="min-w-0 flex-1 text-sm leading-5" />
        <Toast.Close
          aria-label="Close"
          className="shrink-0 rounded-md p-1 opacity-60 transition-opacity hover:bg-black/5 hover:opacity-100"
        >
          <X className="size-4" />
        </Toast.Close>
      </Toast.Root>
    )
  })
}

// 触发 toast 的 hook：success 浅绿、error 浅红、info 中性，message 为展示文案
export function useToast() {
  const manager = Toast.useToastManager()
  return {
    success: (message: string) =>
      manager.add({ type: "success", description: message }),
    error: (message: string) =>
      manager.add({ type: "error", description: message }),
    info: (message: string) => manager.add({ description: message }),
  }
}
