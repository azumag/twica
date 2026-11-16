import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { LIVE_CLIENT_NAMESPACES, pick } from "@/i18n/client-namespaces";

/**
 * /live provider.
 *
 * `LiveDirectory` (public directory) and `DashboardNav` (logged-in visitors) are
 * client components that call useTranslations, but this segment had no layout of
 * its own. Before the payload split they inherited the root provider's full
 * catalog; now the root provider only carries ROOT_CLIENT_NAMESPACES, and a
 * nested provider REPLACES rather than merges the parent messages. This layout
 * therefore supplies exactly the namespaces reachable from /live.
 *
 * Deliberately provider-only: /live's `generateMetadata` lives in page.tsx and a
 * layout without a `metadata` export neither overrides it nor changes routing.
 * There are no loading/error files in this segment that need wrapping.
 */
export default async function LiveLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={pick(messages, LIVE_CLIENT_NAMESPACES)}>
      {children}
    </NextIntlClientProvider>
  );
}
