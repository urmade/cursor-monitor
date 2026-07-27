'use client';

import { Moon, Sun } from 'lucide-react';
import { Button } from '../primitives/Button';
import { useTheme } from '../theme/ThemeProvider';

export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-label="Toggle theme"
    >
      {resolved === 'dark' ? (
        <Sun className="size-3.5" />
      ) : (
        <Moon className="size-3.5" />
      )}
    </Button>
  );
}
