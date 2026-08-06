import Image from "next/image"

import aozoraIcon from "@/assets/imgs/AozoraDev.png"
import weatherIcon from "@/assets/imgs/WeatherMind.png"

// 页脚：仅一行品牌署名，WeatherMind 用品牌主色突出，品牌名后跟各自图标
export function Footer() {
  return (
    <footer className="flex h-12 shrink-0 items-center justify-center border-t bg-background">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span className="font-semibold text-[#2563eb]">WeatherMind</span>
        <Image src={weatherIcon} alt="WeatherMind" className="size-3" />
        <span>- Powered by AozoraDev</span>
        <Image src={aozoraIcon} alt="AozoraDev" className="size-3" />
      </p>
    </footer>
  )
}
