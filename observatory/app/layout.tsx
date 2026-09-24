import type { Metadata, Viewport } from "next";
import "./globals.css";

const metadataBase = new URL("https://ojeommwo-observatory.jumincho.chatgpt.site/");
const title = "오점뭐 메뉴 관측소";
const description = "추천 기록과 취향의 관계를 3D 메뉴 코스모스로 탐험하세요.";

export const metadata: Metadata = {
  metadataBase,
  title,
  description,
  applicationName: "ojeommwo-observatory",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
  robots: { index: false, follow: false, nocache: true },
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    url: "/",
    title,
    description,
    images: [{ url: "/og.png", width: 1680, height: 945, alt: "오점뭐 메뉴 관측소" }],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#020208",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
