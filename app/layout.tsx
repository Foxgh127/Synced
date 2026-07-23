import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3001";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "一起看｜一键分享，一起看电影",
    description:
      "选择电影窗口，自动请求共享画面与声音，生成一个朋友打开就能看的低延迟链接。",
    applicationName: "一起看",
    openGraph: {
      type: "website",
      locale: "zh_CN",
      title: "一起看｜一键分享，一起看电影",
      description: "选择窗口，生成链接，朋友打开即看。",
      url: origin,
      siteName: "一起看",
      images: [
        {
          url: `${origin}/og.png`,
          width: 1200,
          height: 630,
          alt: "一起看，一键分享，一起看电影",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "一起看｜一键分享，一起看电影",
      description: "选择窗口，生成链接，朋友打开即看。",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
