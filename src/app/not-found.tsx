import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-purple-900 via-purple-800 to-indigo-900">
      <div className="text-center">
        <h1 className="mb-4 text-9xl font-bold text-white">404</h1>
        <h2 className="mb-8 text-3xl font-semibold text-white">
          ページが見つかりません
        </h2>
        <p className="mb-8 text-lg text-gray-300">
          お探しのページは存在しないか、移動された可能性があります。
        </p>
        <Link
          href="/"
          className="inline-block rounded-lg bg-purple-600 px-8 py-3 text-lg font-semibold text-white transition-colors hover:bg-purple-700"
        >
          ホームに戻る
        </Link>
      </div>
    </div>
  );
}
