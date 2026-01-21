import { Rarity } from '../types/database'

interface RarityBadgeProps {
  rarity: Rarity
}

// Color mappings for each rarity level
// Uses Tailwind classes for consistent styling
const rarityStyles: Record<Rarity, string> = {
  common: 'bg-gray-100 text-gray-700 border-gray-300',
  rare: 'bg-blue-100 text-blue-700 border-blue-300',
  epic: 'bg-purple-100 text-purple-700 border-purple-300',
  legendary: 'bg-amber-100 text-amber-700 border-amber-300',
}

// Japanese labels for rarity display
const rarityLabels: Record<Rarity, string> = {
  common: 'Common',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
}

/**
 * Badge component for displaying card rarity
 * Automatically applies appropriate color styling based on rarity level
 */
export function RarityBadge({ rarity }: RarityBadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${rarityStyles[rarity]}`}
    >
      {rarityLabels[rarity]}
    </span>
  )
}
