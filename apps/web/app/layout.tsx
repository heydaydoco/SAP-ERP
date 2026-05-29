import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SAP-ERP',
  description: 'Full enterprise ERP — manufacturing / import-export B2B',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
