import "./globals.css";

export const metadata = { title: "Админ панел · Избор на апартамент", robots: { index: false } };

export default function RootLayout({ children }) {
  return (
    <html lang="bg">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Sofia+Sans:wght@400;500;600;700&family=Sofia+Sans+Condensed:wght@600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
