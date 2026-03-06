import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Audio Clipper Studio",
  description: "Crea clips de audio desde un master con cuenta atrás y descarga final"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>): JSX.Element {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
