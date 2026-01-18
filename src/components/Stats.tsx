import { UI_STRINGS } from "@/lib/constants";

interface StatsProps {
  stats: {
    total: number;
    unique: number;
    legendary: number;
    epic: number;
    rare: number;
    common: number;
  };
}

export default function Stats({ stats }: StatsProps) {
  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
      <div className="rounded-xl bg-gray-800 p-4 text-center">
        <div className="text-3xl font-bold text-white">{stats.total}</div>
        <div className="text-sm text-gray-400">{UI_STRINGS.STATS.TOTAL_CARDS}</div>
      </div>
      <div className="rounded-xl bg-gray-800 p-4 text-center">
        <div className="text-3xl font-bold text-white">{stats.unique}</div>
        <div className="text-sm text-gray-400">{UI_STRINGS.STATS.UNIQUE}</div>
      </div>
      <div className="rounded-xl bg-yellow-500/20 p-4 text-center">
        <div className="text-3xl font-bold text-yellow-400">
          {stats.legendary}
        </div>
        <div className="text-sm text-yellow-400/70">{UI_STRINGS.STATS.LEGENDARY}</div>
      </div>
      <div className="rounded-xl bg-purple-500/20 p-4 text-center">
        <div className="text-3xl font-bold text-purple-400">
          {stats.epic}
        </div>
        <div className="text-sm text-purple-400/70">{UI_STRINGS.STATS.EPIC}</div>
      </div>
      <div className="rounded-xl bg-blue-500/20 p-4 text-center">
        <div className="text-3xl font-bold text-blue-400">{stats.rare}</div>
        <div className="text-sm text-blue-400/70">{UI_STRINGS.STATS.RARE}</div>
      </div>
      <div className="rounded-xl bg-gray-500/20 p-4 text-center">
        <div className="text-3xl font-bold text-gray-400">
          {stats.common}
        </div>
        <div className="text-sm text-gray-400/70">{UI_STRINGS.STATS.COMMON}</div>
      </div>
    </div>
  );
}