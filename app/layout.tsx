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
    title: "同频｜一键分享，同频观影",
    description:
      "选择电影窗口，自动请求共享画面与声音，生成一个朋友打开就能看的低延迟链接。",
    applicationName: "同频",
    openGraph: {
      type: "website",
      locale: "zh_CN",
      title: "同频｜一键分享，同频观影",
      description: "选择窗口，生成链接，朋友打开即看。",
      url: origin,
      siteName: "同频",
      images: [
        {
          url: `${origin}/og.png`,
          width: 1200,
          height: 630,
          alt: "同频，一键分享，同步观影",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "同频｜一键分享，同频观影",
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
