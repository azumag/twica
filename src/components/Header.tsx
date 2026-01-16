import Link from "next/link";
import Image from "next/image";
import { getSession } from "@/lib/session";

interface HeaderProps {
  session: Awaited<ReturnType<typeof getSession>>;
}

export default function Header({ session }: HeaderProps) {
  if (!session) return null;

  const isStreamer = session.broadcasterType === "partner" || session.broadcasterType === "affiliate";

  return (
    <header className="border-b border-gray-800 bg-gray-900/95 backdrop-blur">
      <div className="container mx-auto flex items-center justify-between px-4 py-4">
        <Link href="/" className="text-2xl font-bold text-white">
          TwiCa
        </Link>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            {session.twitchProfileImageUrl && (
              <Image
                src={session.twitchProfileImageUrl}
                alt={session.twitchDisplayName}
                width={32}
                height={32}
                className="h-8 w-8 rounded-full"
              />
            )}
            <span className="text-white">{session.twitchDisplayName}</span>
            {isStreamer && (
              <span className="rounded bg-purple-600 px-2 py-0.5 text-xs text-white">
                {session.broadcasterType}
              </span>
            )}
          </div>
          <Link
            href="/api/auth/logout"
            className="rounded-lg border border-gray-700 px-4 py-2 text-gray-300 hover:bg-gray-800"
          >
            ログアウト
          </Link>
        </div>
      </div>
    </header>
  );
}