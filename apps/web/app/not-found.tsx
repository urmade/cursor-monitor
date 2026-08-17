import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="panel empty">
      <h1>Project not found</h1>
      <p>No hook events currently resolve to this repository.</p>
      <Link className="button button-secondary" href="/">
        Back to repositories
      </Link>
    </section>
  );
}
