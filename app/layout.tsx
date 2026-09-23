import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "んぽ Flight Tracker - ANA 東京⇔大连 最安値監視",
  description: "ANAの東京（TYO）→大连（DLC）往復最安値を自動検索 & メール通知",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
