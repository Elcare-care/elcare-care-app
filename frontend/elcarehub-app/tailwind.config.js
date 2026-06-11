/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── ElcareHub African Palette ──────────────────────────
        // Inspired by: Kente cloth, Maasai beadwork, Saharan
        // sunsets, Ndebele murals, and baobab bark.

        // Kente Gold — primary action & highlights
        brand: {
          50:  "#fffbeb",
          100: "#fef3c7",
          200: "#fde68a",
          300: "#fcd34d",
          400: "#fbbf24",
          500: "#D4A017", // deep Kente gold
          600: "#B8860B", // dark goldenrod
          700: "#92660A",
          800: "#6B4C08",
          900: "#3D2B04",
          950: "#1F1502",
        },

        // Adinkra Terracotta — secondary warm accent
        terracotta: {
          50:  "#fff1ec",
          100: "#ffe0d0",
          200: "#ffc0a0",
          300: "#ff9166",
          400: "#f96530",
          500: "#C1440E", // Benin bronze-red
          600: "#A33509",
          700: "#822907",
          800: "#611E05",
          900: "#3D1203",
          950: "#200900",
        },

        // Saharan Sunset — warm gradient partner
        sunset: {
          300: "#FFBB55",
          400: "#FF9933",
          500: "#E87722", // Sahara dusk orange
          600: "#C55D10",
          700: "#9C3F08",
        },

        // Baobab Earth — dark backgrounds
        midnight: {
          50:  "#F5F0E8",
          100: "#E8DFC8",
          200: "#C9B990",
          300: "#A8905A",
          400: "#7A6435",
          500: "#4E3D1A",
          700: "#2C200A",
          800: "#1C1506",
          900: "#120E04",
          950: "#0A0802",
        },

        // Nile Reed Green — success / nature tones
        mint: {
          50:  "#EDFAF2",
          100: "#D3F3E3",
          200: "#A7E7C7",
          300: "#6DD5A5",
          400: "#36BE81",
          500: "#1E9E63", // forest green
          600: "#157A4C",
          700: "#0F5A38",
          800: "#093D26",
          900: "#042014",
          950: "#021009",
        },

        // Indigo Night — cool accent (Tuareg robe indigo)
        indigo: {
          400: "#818CF8",
          500: "#4B4FCC",
          600: "#3730A3",
          700: "#2D2882",
        },

        // Neutral earth tones
        earth: {
          light: "#D4A96A",
          DEFAULT: "#8B5E2A",
          dark: "#4A2F0E",
        },

        // Warm canvas backgrounds
        canvas: {
          50:  "#FBF7F0",
          100: "#F5ECD8",
          200: "#EAD5B0",
          300: "#D9B87A",
          400: "#C49040",
        },
      },

      fontFamily: {
        sans:    ["Inter", "system-ui", "sans-serif"],
        display: ["'Playfair Display'", "Georgia", "serif"],
        mono:    ["'JetBrains Mono'", "'Fira Code'", "monospace"],
      },

      animation: {
        "fade-in":     "fadeIn 0.8s ease-out forwards",
        "fade-in-up":  "fadeInUp 0.8s ease-out forwards",
        "float":       "float 6s ease-in-out infinite",
        "shimmer":     "shimmer 3s linear infinite",
        "pulse-glow":  "pulseGlow 3s ease-in-out infinite",
        "slide-up":    "slideUp 0.5s ease-out forwards",
        "spin-slow":   "spin 12s linear infinite",
      },

      keyframes: {
        fadeIn:    { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        fadeInUp:  { "0%": { opacity: "0", transform: "translateY(30px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        float:     { "0%, 100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-14px)" } },
        shimmer:   { "0%": { backgroundPosition: "-200% 0" }, "100%": { backgroundPosition: "200% 0" } },
        pulseGlow: {
          "0%, 100%": { boxShadow: "0 0 20px rgba(212,160,23,0.25)" },
          "50%":       { boxShadow: "0 0 50px rgba(212,160,23,0.55)" },
        },
        slideUp: { "0%": { opacity: "0", transform: "translateY(20px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
      },

      backgroundImage: {
        // Rich Kente-inspired gradient
        "african-gradient":    "linear-gradient(135deg, #120E04 0%, #4E3D1A 30%, #8B5E2A 60%, #D4A017 100%)",
        // Hero overlay — deep warm darkness
        "hero-gradient":       "linear-gradient(180deg, rgba(18,14,4,0.88) 0%, rgba(18,14,4,0.60) 40%, rgba(18,14,4,0.82) 100%)",
        // Card overlay
        "card-gradient":       "linear-gradient(180deg, transparent 0%, rgba(18,14,4,0.92) 100%)",
        // CTA warm burst
        "warm-gradient":       "linear-gradient(135deg, #D4A017 0%, #E87722 50%, #C1440E 100%)",
        // Subtle stats card
        "glass-warm":          "linear-gradient(135deg, rgba(212,160,23,0.08) 0%, rgba(232,119,34,0.05) 100%)",
        // Section divider stripe
        "kente-stripe":        "repeating-linear-gradient(90deg, #D4A017 0px, #D4A017 14px, #C1440E 14px, #C1440E 28px, #1E9E63 28px, #1E9E63 42px, #E87722 42px, #E87722 56px, #4B4FCC 56px, #4B4FCC 70px)",
      },
    },
  },
  plugins: [],
};
