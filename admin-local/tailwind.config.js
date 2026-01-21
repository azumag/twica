/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Extend theme with custom colors if needed to match the main site
      colors: {
        // Rarity colors for cards
        common: '#9ca3af',     // gray-400
        rare: '#3b82f6',       // blue-500
        epic: '#a855f7',       // purple-500
        legendary: '#f59e0b',  // amber-500
      },
    },
  },
  plugins: [],
}
