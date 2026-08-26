'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

type ActiveNavLinkProps = {
  href: string;
  children: ReactNode;
  className?: string;
  exact?: boolean;
};

export default function ActiveNavLink({ href, children, className = '', exact = false }: ActiveNavLinkProps) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  const classes = ['navLink', className, active ? 'active' : ''].filter(Boolean).join(' ');

  return (
    <a className={classes} href={href} aria-current={active ? 'page' : undefined}>
      {children}
    </a>
  );
}
