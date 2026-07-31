'use client';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@nexus/ui';

export function InfoHint({ label, text }: { label: string; text: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${label}: ${text}`}
            className="inline-flex size-3.5 items-center justify-center rounded-full text-fg-subtle transition-colors hover:text-fg focus-visible:outline-1 focus-visible:outline-border-focus"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="size-3.5"
              aria-hidden
            >
              <circle cx="8" cy="8" r="6.5" />
              <path d="M8 7.25v3.5" strokeLinecap="round" />
              <circle cx="8" cy="5" r="0.75" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 whitespace-normal">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
