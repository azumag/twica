import Link from "next/link";
import { getTranslations } from "next-intl/server";

export const PUBLIC_FOOTER_LINKS = [
  { href: "/guide", label: "guide" },
  { href: "/faq", label: "faq" },
  { href: "/tos", label: "tos" },
  { href: "/about", label: "about" },
  { href: "/privacy", label: "privacy" },
  { href: "/releases", label: "releaseNotes" },
] as const;

export default async function PublicFooter() {
  const tFooter = await getTranslations("footer");

  return (
    <footer className="border-t border-gray-800">
      <div className="container mx-auto px-4 py-6">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="text-sm text-gray-500">&copy; 2025 TwiCa</p>
          <div className="flex flex-wrap justify-center gap-6">
            {PUBLIC_FOOTER_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-gray-500 hover:text-gray-300"
              >
                {tFooter(link.label)}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
