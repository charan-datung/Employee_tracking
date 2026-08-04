import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { currentConsoleUser } from '../lib/supabase';
import './globals.css';

export const metadata: Metadata = {
  title: 'Datung Field Console',
  description: 'Field attendance and visit verification console',
};

const NAV = [
  { href: '/', label: 'Board', adminOnly: false },
  { href: '/flags', label: 'Flags', adminOnly: false },
  { href: '/devices', label: 'Devices', adminOnly: false },
  { href: '/clients', label: 'Clients', adminOnly: false },
  { href: '/pins', label: 'Pin review', adminOnly: false },
  { href: '/reports', label: 'Reports', adminOnly: false },
  { href: '/admin/agents', label: 'Agents', adminOnly: true },
  { href: '/admin/branches', label: 'Branches', adminOnly: true },
] as const;

// Route component — default export permitted per /CLAUDE.md CODE STYLE.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentConsoleUser();

  return (
    <html lang="en">
      <body className="min-h-dvh bg-gray-50 text-gray-900 antialiased">
        {user !== null && (
          <nav className="border-b border-gray-200 bg-white">
            <div className="mx-auto flex max-w-7xl items-center gap-1 px-6">
              <span className="mr-4 py-4 text-sm font-bold text-emerald-700">
                Datung Field
              </span>
              {NAV.filter((item) => !item.adminOnly || user.isAdmin).map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 hover:text-gray-900"
                >
                  {item.label}
                </Link>
              ))}
              <span className="ml-auto text-sm text-gray-500">
                {user.fullName} · {user.employeeNo}
                {user.isAdmin && (
                  <span className="ml-2 rounded bg-gray-900 px-1.5 py-0.5 text-xs font-semibold text-white">
                    admin
                  </span>
                )}
              </span>
            </div>
          </nav>
        )}
        {children}
      </body>
    </html>
  );
}
