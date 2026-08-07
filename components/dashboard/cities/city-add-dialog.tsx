"use client"

import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { type ComponentProps, useState } from "react"

import { ButtonBlue } from "@/components/ui-preset/button"
import { useToast } from "@/components/ui-preset/toast"
import { Button } from "@/components/ui/button"
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
import { useRouter } from "@/i18n/navigation"
import { createCitySchema, type CreateCityValues } from "@/lib/schemas/city"
import { createCityAction } from "@/lib/weather/city-actions"
import { CityError } from "@/lib/weather/errors"

// 城市表单字段：标签 + 输入框 + 内联错误（错误 message 即 form.errors 命名空间下的 i18n key）
function CityField({
  label,
  errors,
  inputProps,
}: {
  label: string
  errors: readonly unknown[]
  inputProps: ComponentProps<typeof Input>
}) {
  const t = useTranslations("dashboard.cities.form.errors")

  // TanStack Form 的 zod issue message 是 i18n key，逐条翻译展示；兼容 string 错误
  const messages = errors
    .map((e) =>
      typeof e === "string" ? e : (e as { message?: string }).message
    )
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

// 新增城市对话框：管理员点蓝色「新增城市」打开，TanStack Form 校验后调 createCityAction
export function CityAddDialog() {
  const t = useTranslations("dashboard.cities")
  const router = useRouter()
  const toast = useToast()

  const [addOpen, setAddOpen] = useState(false)

  const form = useForm({
    defaultValues: {
      nameJa: "",
      nameEn: "",
      latitude: "",
      longitude: "",
      timezone: "Asia/Tokyo",
    },
    validators: { onSubmit: createCitySchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  const mutation = useMutation({
    mutationFn: async (values: CreateCityValues) => {
      const res = await createCityAction(values)
      if (!res.ok) throw new CityError(res.error)
    },
    onSuccess: () => {
      toast.success(t("success.created"))
      form.reset() // 成功后清空，避免重开残留旧值
      setAddOpen(false)
      router.refresh() // 重拉服务端数据刷新城市列表
    },
    onError: (e) => {
      toast.error(
        e instanceof CityError ? t(`errors.${e.code}`) : t("errors.generic")
      )
    },
  })

  // 关闭对话框时重置表单（取消路径也要清掉未提交的输入与旧错误）
  const handleOpenChange = (open: boolean) => {
    setAddOpen(open)
    if (!open) form.reset()
  }

  return (
    <>
      <ButtonBlue size="sm" onClick={() => setAddOpen(true)}>
        <Plus aria-hidden="true" className="size-4" />
        {t("add")}
      </ButtonBlue>

      <Dialog open={addOpen} onOpenChange={handleOpenChange}>
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
            <form.Field name="nameJa">
              {(field) => (
                <CityField
                  label={t("form.nameJa")}
                  errors={field.state.meta.errors}
                  inputProps={{
                    id: field.name,
                    name: field.name,
                    value: field.state.value,
                    onChange: (e) => field.handleChange(e.target.value),
                    onBlur: field.handleBlur,
                  }}
                />
              )}
            </form.Field>

            <form.Field name="nameEn">
              {(field) => (
                <CityField
                  label={t("form.nameEn")}
                  errors={field.state.meta.errors}
                  inputProps={{
                    id: field.name,
                    name: field.name,
                    value: field.state.value,
                    onChange: (e) => field.handleChange(e.target.value),
                    onBlur: field.handleBlur,
                  }}
                />
              )}
            </form.Field>

            <form.Field name="latitude">
              {(field) => (
                <CityField
                  label={t("form.latitude")}
                  errors={field.state.meta.errors}
                  inputProps={{
                    id: field.name,
                    name: field.name,
                    type: "number",
                    step: "any",
                    inputMode: "decimal",
                    value: field.state.value,
                    onChange: (e) => field.handleChange(e.target.value),
                    onBlur: field.handleBlur,
                  }}
                />
              )}
            </form.Field>

            <form.Field name="longitude">
              {(field) => (
                <CityField
                  label={t("form.longitude")}
                  errors={field.state.meta.errors}
                  inputProps={{
                    id: field.name,
                    name: field.name,
                    type: "number",
                    step: "any",
                    inputMode: "decimal",
                    value: field.state.value,
                    onChange: (e) => field.handleChange(e.target.value),
                    onBlur: field.handleBlur,
                  }}
                />
              )}
            </form.Field>

            <form.Field name="timezone">
              {(field) => (
                <CityField
                  label={t("form.timezone")}
                  errors={field.state.meta.errors}
                  inputProps={{
                    id: field.name,
                    name: field.name,
                    value: field.state.value,
                    onChange: (e) => field.handleChange(e.target.value),
                    onBlur: field.handleBlur,
                  }}
                />
              )}
            </form.Field>

            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddOpen(false)}
              >
                {t("cancel")}
              </Button>
              <ButtonBlue type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? t("form.submitting") : t("form.submit")}
              </ButtonBlue>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
