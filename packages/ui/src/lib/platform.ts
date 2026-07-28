'use client';

import * as React from 'react';

/** True when the primary modifier is Meta (macOS). */
export function useIsApplePlatform(): boolean {
  const [isApple, setIsApple] = React.useState(true);
  React.useEffect(() => {
    const ua = navigator.userAgent;
    const platform = navigator.platform ?? '';
    setIsApple(/Mac|iPhone|iPad|iPod/i.test(platform) || /Mac OS X/i.test(ua));
  }, []);
  return isApple;
}

export function CommandPaletteShortcut() {
  const isApple = useIsApplePlatform();
  if (isApple) {
    return React.createElement(
      React.Fragment,
      null,
      React.createElement('span', { className: 'sr-only' }, 'Open command palette'),
      React.createElement('span', { 'aria-hidden': true }, '⌘ K'),
    );
  }
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('span', { className: 'sr-only' }, 'Open command palette'),
    React.createElement('span', { 'aria-hidden': true }, 'Ctrl K'),
  );
}
