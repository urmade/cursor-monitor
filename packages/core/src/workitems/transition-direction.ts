export type TransitionDirection = 'forward' | 'backward' | 'lateral' | 'initial';

export function computeTransitionDirection(
  fromPosition: number | null,
  toPosition: number,
): TransitionDirection {
  if (fromPosition === null) return 'initial';
  if (toPosition > fromPosition) return 'forward';
  if (toPosition < fromPosition) return 'backward';
  return 'lateral';
}
