import { Body } from "@/components/notlogin/body"
import { Footer } from "@/components/notlogin/footer"
import { Navbar } from "@/components/notlogin/navbar"

// 未登录落地页：垂直布局依次为导航栏、主体内容、页脚
export default function HomePage() {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <Navbar />
      <Body />
      <Footer />
    </div>
  )
}
