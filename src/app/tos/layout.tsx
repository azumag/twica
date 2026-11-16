import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { pick, TOS_CLIENT_NAMESPACES } from "@/i18n/client-namespaces";

/**
 * /tos provider.
 *
 * The terms page itself is a server component, but `TosAcceptButton` is a client
 * component that reads `tosPage.accept` and `maintenance`. This segment had no
 * layout of its own, so it previously inherited the root provider's full
 * catalog; after the payload split the root only carries ROOT_CLIENT_NAMESPACES
 * and the nested provider replaces (does not merge) it.
 *
 * Deliberately provider-only: the page's `metadata` export stays in page.tsx and
 * wrapping children does not add routing or metadata behaviour. There are no
 * loading/error files in this segment that need wrapping.
 */
export default async function TosLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={pick(messages, TOS_CLIENT_NAMESPACES)}>
      {children}
    </NextIntlClientProvider>
  );
}
