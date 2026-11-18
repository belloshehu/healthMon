import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "HealthOS IoT | Hospital Vital Signs & Telemetry Monitoring Platform",
  description:
    "Production-oriented IoT hospital health monitoring platform integrating ESP32-WROOM-32, MAX30102, and MLX90614 telemetry with Firebase and NDPA-compliant hospital isolation.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
