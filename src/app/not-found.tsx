import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-24 text-center">
      <p className="label">404</p>
      <h1 className="mt-3 font-display text-4xl text-bone-100">Nothing here</h1>
      <p className="mt-3 text-sm text-bone-400">
        That recording does not exist, or it was deleted.
      </p>
      <Link href="/" className="btn-primary mt-6">
        Back to the studio
      </Link>
    </div>
  );
}
