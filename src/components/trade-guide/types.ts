import type { getTranslations } from "next-intl/server";

/**
 * Translator handed from the page (a server component) to the diagram components.
 *
 * The diagrams in this folder are plain presentational components: they own no data,
 * no state and no copy of their own. Every string comes from messages through this
 * translator, and numbers (limits, durations) are passed in by the page from the same
 * constants the server enforces, so a diagram can never drift from the rules.
 */
export type GuideT = Awaited<ReturnType<typeof getTranslations>>;
