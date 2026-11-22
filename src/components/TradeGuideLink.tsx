import Link from "next/link";

export default function TradeGuideLink({ label }: { label: string }) {
  return (
    <Link
      href="/guide/trade"
      className="text-sm text-purple-300 transition-colors hover:text-purple-200 hover:underline"
    >
      {label}
    </Link>
  );
}
