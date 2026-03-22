/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        night: "#05060c",
        card: "rgba(255,255,255,0.04)",
        accent: "#4de8c4",
        accent2: "#44a6ff",
        border: "#1f2a43",
      },
      boxShadow: {
        glass: "0 20px 70px rgba(0,0,0,0.45)",
      },
    },
  },
  plugins: [],
};
