import type { Metadata } from 'next';
import { AppHeader } from '@/src/components/AppHeader';
import { currentAdmin } from '@/src/server/identity';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Cursor Monitor',
    template: '%s · Cursor Monitor',
  },
  description:
    'Standalone repository and conversation monitoring for Cursor teams.',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await currentAdmin();
  return (
    <html lang="en">
      <body>
        {admin ? (
          <>
            <AppHeader />
            <main className="shell">{children}</main>
          </>
        ) : (
          <main className="shell">
            <section className="panel empty">
              <h1>Passport sign-in required</h1>
              <p>
                Cursor Monitor contains internal repository and conversation
                telemetry. Open this deployment through the approved Passport
                access flow.
              </p>
            </section>
          </main>
        )}
      </body>
    </html>
  );
}
