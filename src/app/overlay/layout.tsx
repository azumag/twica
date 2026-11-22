import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { OVERLAY_CLIENT_NAMESPACES, pick } from "@/i18n/client-namespaces";

/**
 * /overlay/** provider boundary.
 *
 * The overlay page and every client module reachable from it contain no
 * `useTranslations` call, so this provider's list is intentionally empty: the
 * overlay must not inherit root chrome namespaces (auth / common / header /
 * languageSwitcher / maintenance) that it never uses.
 *
 * Honest limitation: the root layout still serialises ROOT_CLIENT_NAMESPACES on
 * every route, /overlay included, so this nested provider does not shrink the
 * root provider's bytes. Its value is isolation and a testable contract: if a
 * translated client component is ever added under /overlay, the static test
 * fails and forces an explicit entry in OVERLAY_CLIENT_NAMESPACES instead of
 * silently borrowing an unrelated root key.
 *
 * No metadata export here: /overlay/[streamerId]/page.tsx is a client page and
 * the segment has no loading/error files, so adding only a provider does not
 * change routing or metadata.
 */
export default async function OverlayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={pick(messages, OVERLAY_CLIENT_NAMESPACES)}>
      {children}
    </NextIntlClientProvider>
  );
}
