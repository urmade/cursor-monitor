import type { Metadata } from 'next';
import { AppHeader } from '@/src/components/AppHeader';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Cursor Monitor',
    template: '%s · Cursor Monitor',
  },
  description:
    'Standalone repository and conversation monitoring for Cursor teams.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppHeader />
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
