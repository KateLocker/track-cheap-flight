import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "んぽ Flight Tracker - 往復航空券の価格チェック",
  description: "指定した路線と航空会社の往復航空券を定期検索し、低価格をメールでお知らせします。",
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
