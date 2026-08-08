"use client"

import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { useState, type ComponentProps } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ButtonBlue, ButtonGreen } from "@/components/ui-preset/button"
import { useToast } from "@/components/ui-preset/toast"
import { useModelConfig } from "@/hooks/use-model-config"
import { connectionSchema, modelConfigSchema } from "@/lib/schemas/ai"
import {
  clearModelConfig,
  loadModels,
  saveModelConfig,
  ModelConfigError,
  type ModelConfig,
} from "@/lib/model-config"

// 文本字段渲染助手：Label + Input + 内联 i18n 错误（镜像 city-add-dialog 的 CityField）
function ConfigField({
  label,
  errors,
  inputProps,
}: {
  label: string
  errors: readonly unknown[]
  inputProps: ComponentProps<typeof Input>
}) {
  const t = useTranslations("dashboard.settings.modelConfig.errors")

  // TanStack Form 的 zod issue message 是 i18n key，逐条翻译展示；兼容 string 错误
  const messages = errors
    .map((e) => (typeof e === "string" ? e : (e as { message?: string }).message))
    .filter((m): m is string => Boolean(m))

  return (
    <div className="flex flex-col gap-1.5 text-left">
      <Label htmlFor={inputProps.id}>{label}</Label>
      <Input aria-invalid={errors.length > 0} {...inputProps} />
      {messages.length > 0 && (
        <p className="text-xs text-destructive">
          {messages.map((m) => t(m)).join("、")}
        </p>
      )}
    </div>
  )
}

// 顶部渐变条：镜像 history-charts 的 AccentBar，绿色呼应「配置模型」按钮
function AccentBar() {
  return (
    <div
      aria-hidden="true"
      className="-mx-(--card-spacing) -mt-(--card-spacing) h-1 bg-linear-to-r from-emerald-400 to-green-500"
    />
  )
}

// 模型配置卡片：右侧绿色按钮「配置模型/清除配置」，弹窗内测试连接后选模型并缓存
export function ModelConfigCard({ email }: { email: string }) {
  const t = useTranslations("dashboard.settings.modelConfig")
  const toast = useToast()

  // 已存配置：订阅 localStorage，驱动卡片展示与按钮切换（SSR 恒为 null，挂载后同步真实值）
  const config = useModelConfig(email)
  const [open, setOpen] = useState(false)

  // 清除配置：已配置态按钮即「清除配置」，直接删缓存并弹提示（订阅自动刷新卡片）
  const handleClear = () => {
    clearModelConfig(email)
    toast.success(t("success.cleared"))
  }

  // 测试链接：调 /models 拉模型列表；成功进 mutation.data，驱动下拉与「确定」
  const testMutation = useMutation({
    mutationFn: async ({ baseUrl, apiKey }: { baseUrl: string; apiKey: string }) => {
      const res = await loadModels(baseUrl, apiKey)
      if (!res.ok) throw new ModelConfigError(res.error)
      return res.models
    },
    onSuccess: () => toast.success(t("success.tested")),
    onError: (e) =>
      toast.error(
        e instanceof ModelConfigError ? t(`errors.${e.code}`) : t("errors.generic")
      ),
  })

  // 保存配置：连同本次测试到的模型列表一并写入 localStorage
  const saveMutation = useMutation({
    mutationFn: async (cfg: ModelConfig) => {
      saveModelConfig(email, cfg)
    },
    onSuccess: () => {
      toast.success(t("success.saved"))
      form.reset()
      testMutation.reset()
      setOpen(false)
    },
  })

  const form = useForm({
    defaultValues: { baseUrl: "", apiKey: "", model: "" },
    validators: { onSubmit: modelConfigSchema },
    onSubmit: async ({ value }) => {
      await saveMutation.mutateAsync({ ...value, models: testMutation.data ?? [] })
    },
  })

  // 关闭对话框时重置表单与测试结果，避免重开残留旧值
  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      form.reset()
      testMutation.reset()
    }
  }

  return (
    <Card className="max-w-2xl">
      <AccentBar />
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("desc")}</CardDescription>
        <CardAction>
          <ButtonGreen size="sm" onClick={config ? handleClear : () => setOpen(true)}>
            {config ? t("clear") : t("configure")}
          </ButtonGreen>
        </CardAction>
      </CardHeader>
      <CardContent>
        {config ? (
          <div className="flex flex-col gap-1 text-sm">
            <p className="truncate">
              <span className="text-muted-foreground">{t("baseUrl")}：</span>
              {config.baseUrl}
            </p>
            <p className="truncate">
              <span className="text-muted-foreground">{t("model")}：</span>
              {config.model}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("notConfigured")}</p>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <DialogDescription>{t("dialogDesc")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              form.handleSubmit()
            }}
          >
            {/* 订阅表单值：url+key 合法才可「测试链接」；测试成功且选中模型才可「确定」 */}
            <form.Subscribe selector={(s) => s.values}>
              {(values) => {
                const canTest = connectionSchema.safeParse(values).success
                const models = testMutation.data
                const canConfirm = Boolean(models && values.model)

                return (
                  <>
                    <form.Field name="baseUrl">
                      {(field) => (
                        <ConfigField
                          label={t("baseUrl")}
                          errors={field.state.meta.errors}
                          inputProps={{
                            id: field.name,
                            name: field.name,
                            type: "url",
                            placeholder: "https://api.example.com/v1",
                            value: field.state.value,
                            // 改地址即作废上次测试结果，强制重测
                            onChange: (e) => {
                              field.handleChange(e.target.value)
                              if (testMutation.isSuccess) testMutation.reset()
                            },
                            onBlur: field.handleBlur,
                          }}
                        />
                      )}
                    </form.Field>

                    <form.Field name="apiKey">
                      {(field) => (
                        <ConfigField
                          label={t("apiKey")}
                          errors={field.state.meta.errors}
                          inputProps={{
                            id: field.name,
                            name: field.name,
                            type: "password",
                            placeholder: "sk-…",
                            value: field.state.value,
                            onChange: (e) => {
                              field.handleChange(e.target.value)
                              if (testMutation.isSuccess) testMutation.reset()
                            },
                            onBlur: field.handleBlur,
                          }}
                        />
                      )}
                    </form.Field>

                    <div className="flex justify-end">
                      <ButtonBlue
                        type="button"
                        size="sm"
                        disabled={!canTest || testMutation.isPending}
                        onClick={() =>
                          testMutation.mutate({
                            baseUrl: values.baseUrl,
                            apiKey: values.apiKey,
                          })
                        }
                      >
                        {testMutation.isPending ? t("testing") : t("test")}
                      </ButtonBlue>
                    </div>

                    {models && (
                      <form.Field name="model">
                        {(field) => (
                          <div className="flex flex-col gap-1.5 text-left">
                            <Label htmlFor={field.name}>{t("model")}</Label>
                            <Select
                              value={field.state.value}
                              onValueChange={(v) => v && field.handleChange(String(v))}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder={t("selectPlaceholder")} />
                              </SelectTrigger>
                              <SelectContent>
                                {models.map((m) => (
                                  <SelectItem key={m} value={m}>
                                    {m}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {field.state.meta.errors.length > 0 && (
                              <p className="text-xs text-destructive">
                                {field.state.meta.errors
                                  .map((e) =>
                                    t(
                                      typeof e === "string"
                                        ? e
                                        : (e as { message: string }).message
                                    )
                                  )
                                  .join("、")}
                              </p>
                            )}
                          </div>
                        )}
                      </form.Field>
                    )}

                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setOpen(false)}
                      >
                        {t("cancel")}
                      </Button>
                      <ButtonGreen
                        type="submit"
                        disabled={!canConfirm || saveMutation.isPending}
                      >
                        {saveMutation.isPending ? t("saving") : t("confirm")}
                      </ButtonGreen>
                    </DialogFooter>
                  </>
                )
              }}
            </form.Subscribe>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
