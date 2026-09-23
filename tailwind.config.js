/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#fef7ee",
          100: "#fdedd3",
          200: "#fad7a5",
          300: "#f6bb6d",
          400: "#f19532",
          500: "#ee7a11",
          600: "#df5f07",
          700: "#b94609",
          800: "#93370f",
          900: "#772f10",
        },
      },
    },
  },
  plugins: [],
};
