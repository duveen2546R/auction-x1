/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        night: "#020408",
        card: "rgba(255,255,255,0.03)",
        accent: "#00f5ff",
        accent2: "#7000ff",
        border: "rgba(255,255,255,0.08)",
        gold: "#ffb800",
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "premium-dark": "linear-gradient(180deg, rgba(10,15,30,0) 0%, rgba(2,4,8,1) 100%)",
      },
      boxShadow: {
        glass: "0 8px 32px 0 rgba(0, 0, 0, 0.8)",
        glow: "0 0 15px rgba(0, 245, 255, 0.3)",
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "slide-up": "slideUp 0.5s ease-out forwards",
      },
      keyframes: {
        slideUp: {
          "0%": { transform: "translateY(20px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};
