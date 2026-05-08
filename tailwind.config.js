/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: '#FF6B35',
        brandDeep: '#D9501E',
        aqua: '#2EC4B6',
        ink: '#212529',
        muted: '#6C757D',
        shell: '#F8F9FA',
        paper: '#FFFFFF',
        warn: '#FFC107',
        danger: '#F44336',
        ok: '#4CAF50',
      },
      boxShadow: {
        float: '0 20px 60px rgba(33, 37, 41, 0.12)',
      },
      borderRadius: {
        '4xl': '2rem',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"SFMono-Regular"', 'ui-monospace', 'monospace'],
      },
      backgroundImage: {
        mesh: 'radial-gradient(circle at top left, rgba(255, 107, 53, 0.22), transparent 30%), radial-gradient(circle at top right, rgba(46, 196, 182, 0.18), transparent 32%), linear-gradient(180deg, #fff7f2 0%, #f8f9fa 44%, #f5fcfb 100%)',
      },
    },
  },
  plugins: [],
};
