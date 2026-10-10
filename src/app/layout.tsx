import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "电商研究台 · Qoder × Apify",
  description: "本地电商数据研究工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
