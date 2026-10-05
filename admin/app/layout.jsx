import "./globals.css";

export const metadata = { title: "Админ панел — избор на апартамент" };

export default function RootLayout({ children }) {
  return (
    <html lang="bg">
      <body>{children}</body>
    </html>
  );
}
