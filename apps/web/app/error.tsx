'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="panel empty">
      <h1>Something went wrong</h1>
      <p>{error.message}</p>
      <button className="button button-secondary" onClick={reset} type="button">
        Try again
      </button>
    </section>
  );
}
