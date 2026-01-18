import * as Sentry from "@sentry/nextjs";
import { checkDebugAccess } from "@/lib/debug-access";

export const dynamic = "force-dynamic";

class SentryExampleAPIError extends Error {
  constructor(message: string | undefined) {
    super(message);
    this.name = "SentryExampleAPIError";
  }
}

export async function GET(request: Request) {
  const accessCheck = checkDebugAccess(request);
  if (accessCheck) return accessCheck;

  Sentry.logger.info("Sentry example API called");
  throw new SentryExampleAPIError(
    "This error is raised on the backend called by the example page.",
  );
}
